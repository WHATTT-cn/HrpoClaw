// V6 TS 真源 -> Agent 工作区 JSON + shared 预置快照；全量替换，禁止合并旧记录。
// pnpm gen:v6 [workspaceDir] [sharedDir]
//
// 五步范式（对齐 gen-decisions.mjs）：
//   1. esbuild bundle `src/data/v6-board-table.ts`（内联 10 个 JSON，规避 data-URL 无法解析相对路径）
//   2. TypeBox `Value.Check(V6AppDataSchema, ...)` 反向校验真源产物
//   3. 派生产物（区域健康快照 / 区域健康原子量 / 采购下单 / 履约追踪 / 指标口径.md / [P5] Suppliers.md）
//   4. `.{pid}.tmp` + rename 原子写入每个目标
//   5. 打印各产物行数 / 字节数统计
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const tableSourcePath = resolve(root, 'src/data/v6-board-table.ts');
export const schemaSourcePath = resolve(root, 'src/data/v6/schema.ts');

/* ============ 步骤 1：bundle TS 真源（含 JSON 内联） ============ */

/**
 * 用 esbuild 打包 TS 入口为单文件 ESM 并动态 import。
 *
 * 不用 `ts.transpileModule` + data-URL：本真源 import 了 10 个相对路径 JSON，
 * data-URL 模块没有 base path，相对说明符会解析失败。
 */
async function loadModule(entry) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    loader: { '.json': 'json' },
  });
  if (result.errors.length > 0) {
    throw new Error(`esbuild 失败：${result.errors.map((e) => e.text).join('; ')}`);
  }
  // 写临时文件再 import：产物约 1.5MB，data-URL 体积过大且不利于调试
  const temporary = join(tmpdir(), `v6-gen-${process.pid}-${Date.now()}.mjs`);
  await writeFile(temporary, result.outputFiles[0].text, 'utf8');
  try {
    return await import(pathToFileURL(temporary).href);
  } finally {
    await rm(temporary, { force: true });
  }
}

/* ============ 步骤 2：TypeBox 反向校验 ============ */

/** 校验 10 个真源产物符合 `V6AppDataSchema`；失败时打印首条错误路径后抛出。 */
async function checkAppData(table, schemaMod, Value) {
  const appData = {
    fact_monthly: table.月桶事实表,
    headcount_wh: table.人头附表_仓,
    headcount_wh_sup: table.人头附表_仓供应商,
    headcount_cond: table.人头附表_条件组,
    peak_supply: table.峰值附表,
    cross_wh_fix: table.跨仓修正表,
    board3_slices: table.板块三切片,
    board4_onboarding: table.板块四台账,
    meta: table.V6元信息,
    golden_sample: table.黄金样本,
  };
  if (Value.Check(schemaMod.V6AppDataSchema, appData)) return appData;

  const errors = [...Value.Errors(schemaMod.V6AppDataSchema, appData)];
  const first = errors[0];
  console.error(`✗ TypeBox 校验失败（共 ${errors.length} 处），首条：`);
  console.error(`  path: ${first?.path}`);
  console.error(`  message: ${first?.message}`);
  console.error(`  value: ${JSON.stringify(first?.value)?.slice(0, 200)}`);
  throw new Error('V6AppDataSchema 校验未通过');
}

/* ============ 步骤 3：派生 5 份产物 ============ */

/** 区域健康：2 周期档 × (全部仓 + 各单仓) 预聚合板块一 + 板块二快照。 */
export function buildRegion(table) {
  const periods = table.V6元信息.periods;
  const warehouses = table.V6元信息.warehouses;
  const scopes = [{ 名称: '全部仓', 仓: [] }, ...warehouses.map((w) => ({ 名称: w, 仓: [w] }))];

  const snapshots = [];
  for (const p of periods) {
    const 周期 = { 周期档: p.name, 起: p.start.slice(0, 7), 止: p.end.slice(0, 7) };
    for (const s of scopes) {
      const 板块一 = table.聚合板块一(周期, s.仓);
      const 板块二 = table.聚合板块二(周期, s.仓);
      if (板块二.length === 0) continue; // 该周期该仓无三方用工，不产出空快照
      snapshots.push({ 周期档: p.name, 范围: s.名称, 板块一, 板块二 });
    }
  }
  return {
    版本: table.V6元信息.version,
    生成时间: new Date().toISOString(),
    口径说明: table.V6元信息.口径说明,
    快照: snapshots,
  };
}

/**
 * 跨仓修正表脱敏：`用户编码`（AE010767 等真实工号）→ 稳定序号 `u0/u1/...`。
 *
 * 该列在聚合器中仅作「分组去重键」使用，序号映射是双射，去重语义完全等价；
 * 脱敏后可安全下发到工作区与应用安装包。
 */
function 脱敏跨仓修正(rows) {
  const 映射 = new Map();
  return rows.map((r) => {
    let id = 映射.get(r.用户编码);
    if (id === undefined) {
      id = `u${映射.size}`;
      映射.set(r.用户编码, id);
    }
    return { ...r, 用户编码: id };
  });
}

/**
 * 区域健康原子量：下发板块一/二所需的全部最细粒度事实 + 人头附表 + 峰值 + 跨仓修正。
 *
 * ★ 与 `buildRegion` 的预聚合快照互补：快照供 Agent 读（2 周期 × 7 范围），
 *   原子量供前端看板实时重算（仓任意多选 × 任意月区间），二者同源于 TS 真源。
 *   不下发 `人头附表_条件组`（L3 仅板块三用）。
 */
export function buildRegionAtoms(table) {
  return {
    版本: table.V6元信息.version,
    生成时间: new Date().toISOString(),
    口径说明: table.V6元信息.口径说明,
    periods: table.V6元信息.periods,
    warehouses: table.V6元信息.warehouses,
    placeholders: table.V6元信息.placeholders,
    fact: table.月桶事实表.fact,
    wh: table.月桶事实表.wh,
    turnover: table.月桶事实表.turnover,
    hcWh: table.人头附表_仓,
    hcWhSup: table.人头附表_仓供应商,
    peak: table.峰值附表,
    crossFix: 脱敏跨仓修正(table.跨仓修正表),
    contracted: table.V6元信息.contracted ?? {},
  };
}

/**
 * 原子量注入自检：对每个「周期档 × (全部仓 + 各单仓)」比对
 * 「注入原子量数据源」与「bundle 内默认数据源」的板块一/二聚合结果是否逐字节一致。
 *
 * 这是 C 方案的回归护栏——保证前端运行时读 JSON 的聚合路径与对账通过的路径等价。
 */
function 自检原子量(table, atoms) {
  const 源 = {
    fact: atoms.fact,
    wh: atoms.wh,
    turnover: atoms.turnover,
    hcWh: atoms.hcWh,
    hcWhSup: atoms.hcWhSup,
    peak: atoms.peak,
    crossFix: atoms.crossFix,
    contracted: atoms.contracted ?? {},
  };
  const scopes = [[], ...table.V6元信息.warehouses.map((w) => [w])];
  let 比对数 = 0;
  for (const p of table.V6元信息.periods) {
    const 周期 = { 周期档: p.name, 起: p.start.slice(0, 7), 止: p.end.slice(0, 7) };
    for (const 仓 of scopes) {
      const 范围 = 仓.length === 0 ? '全部仓' : 仓[0];
      for (const [名, fn] of [['板块一', table.聚合板块一], ['板块二', table.聚合板块二]]) {
        const 默认 = JSON.stringify(fn(周期, 仓));
        const 注入 = JSON.stringify(fn(周期, 仓, 源));
        if (默认 !== 注入) {
          throw new Error(`原子量注入自检失败：[${p.name}|${范围}] ${名} 与默认数据源结果不一致`);
        }
        比对数 += 1;
      }
    }
  }
  return 比对数;
}

/** 采购下单：直接转发板块三切片矩阵（周期 × 单仓，含档级/置信度 meta）。 */
export function buildPurchase(table) {
  return {
    版本: table.V6元信息.version,
    生成时间: new Date().toISOString(),
    周期档: table.板块三切片.periods,
    物流仓: table.板块三切片.warehouses,
    切片: table.板块三切片.slices,
  };
}

/** 履约追踪：板块四入职台账全量（主表 + 明细，不按周期过滤）。 */
export function buildFulfillment(table) {
  return {
    版本: table.V6元信息.version,
    生成时间: new Date().toISOString(),
    主表: table.板块四台账.main,
    明细: table.板块四台账.detail,
  };
}

/** 指标口径.md：由 meta.metrics 渲染，供 Agent 只读。 */
export function buildMetricDoc(table) {
  const rows = table.V6元信息.metrics;
  const 分组 = new Map();
  for (const r of rows) {
    const k = r.板块 ?? '未分组';
    if (!分组.has(k)) 分组.set(k, []);
    分组.get(k).push(r);
  }
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const parts = [
    '# V6 指标口径字典',
    '',
    `> 自动生成，请勿手改。真源：\`src/data/v6/meta.json\` ← \`scripts/v6/metric_dict.py\``,
    `> 版本 ${table.V6元信息.version} · 生成时间 ${new Date().toISOString()}`,
    '',
  ];
  for (const [板块, list] of 分组) {
    parts.push(`## ${板块}`, '', '| 指标 | 含义 | 计算式 | 数据源 | 数据状态 | 备注 |', '|---|---|---|---|---|---|');
    for (const r of list) {
      parts.push(
        `| ${esc(r.指标名)} | ${esc(r.中文定义)} | ${esc(r.计算公式)} | ${esc(r.数据源列位)} | ${esc(r.数据状态)} | ${esc(r.备注)} |`,
      );
    }
    parts.push('');
  }
  return `${parts.join('\n')}\n`;
}

/* ============ 步骤 4：原子写入（.{pid}.tmp + rename） ============ */

/** 原子写入单文件：先写临时副本，再 rename 覆盖目标（避免 Agent 读到半成品）。 */
async function safeWrite(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

/* ============ 步骤 5：统计打印 ============ */

function printStats(label, content) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n').length;
  console.log(`  ✓ ${label}  ${lines} 行 / ${(bytes / 1024).toFixed(1)} KB`);
}

function printJSONStats(label, obj) {
  printStats(label, JSON.stringify(obj, null, 2));
}

/* ============ main ============ */

async function generate(workspaceDir = null, sharedDir = null) {
  const wsRoot = workspaceDir ?? join(homedir(), '.openclaw', 'workspace-po');
  const sharedRoot = sharedDir ?? resolve(root, 'shared');

  console.log('V6 TS 真源 → 派生产物...');

  // 步骤 1：加载 TS 真源
  console.log('\n[1/5] 加载真源模块');
  const tableMod = await loadModule(tableSourcePath);
  const schemaMod = await loadModule(schemaSourcePath);
  const { Value } = await import('@sinclair/typebox/value');

  // 步骤 2：TypeBox 反向校验
  console.log('\n[2/5] TypeBox 校验');
  await checkAppData(tableMod, schemaMod, Value);
  console.log('  ✓ V6AppDataSchema 校验通过');

  // 步骤 3：派生 5 份产物
  console.log('\n[3/5] 派生产物');
  const region = buildRegion(tableMod);
  const regionAtoms = buildRegionAtoms(tableMod);
  const purchase = buildPurchase(tableMod);
  const fulfillment = buildFulfillment(tableMod);
  const metricDoc = buildMetricDoc(tableMod);

  console.log(`  ✓ 区域健康 ${region.快照.length} 个快照`);
  console.log(
    `  ✓ 区域健康原子量 fact ${regionAtoms.fact.length} / wh ${regionAtoms.wh.length} / turnover ${regionAtoms.turnover.length} / crossFix ${regionAtoms.crossFix.length}（用户编码已脱敏）`,
  );
  const 自检数 = 自检原子量(tableMod, regionAtoms);
  console.log(`  ✓ 原子量注入自检通过（${自检数} 组聚合结果与默认数据源逐字段一致）`);
  console.log(`  ✓ 采购下单 ${Object.keys(purchase.切片).length} 个切片`);
  console.log(`  ✓ 履约追踪 ${fulfillment.主表.length} 主表 + ${fulfillment.明细.length} 明细`);
  console.log(`  ✓ 指标口径.md ${tableMod.V6元信息.metrics.length} 条`);

  // 步骤 4：原子写入目标
  console.log('\n[4/5] 写入目标');
  const regionJSON = JSON.stringify(region, null, 2);
  // 原子量体积大且纯机读，不做缩进以节省约 40% 体积
  const regionAtomsJSON = JSON.stringify(regionAtoms);
  const purchaseJSON = JSON.stringify(purchase, null, 2);
  const fulfillmentJSON = JSON.stringify(fulfillment, null, 2);

  await safeWrite(join(wsRoot, '区域健康.json'), regionJSON);
  await safeWrite(join(wsRoot, '区域健康原子量.json'), regionAtomsJSON);
  await safeWrite(join(wsRoot, '采购下单.json'), purchaseJSON);
  await safeWrite(join(wsRoot, '履约追踪.json'), fulfillmentJSON);
  await safeWrite(join(wsRoot, '指标口径.md'), metricDoc);
  console.log(`  ✓ Agent 工作区 → ${wsRoot}`);

  await safeWrite(join(sharedRoot, 'po-v6-region.json'), regionJSON);
  await safeWrite(join(sharedRoot, 'po-v6-region-atoms.json'), regionAtomsJSON);
  await safeWrite(join(sharedRoot, 'po-v6-purchase.json'), purchaseJSON);
  await safeWrite(join(sharedRoot, 'po-v6-fulfillment.json'), fulfillmentJSON);
  console.log(`  ✓ shared 预置快照 → ${sharedRoot}`);

  // 步骤 5：统计打印
  console.log('\n[5/5] 产物统计');
  printJSONStats('区域健康', region);
  printStats('区域健康原子量', regionAtomsJSON);
  printJSONStats('采购下单', purchase);
  printJSONStats('履约追踪', fulfillment);
  printStats('指标口径.md', metricDoc);

  console.log('\n✅ 全部完成');
}

// CLI 入口
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generate(process.argv[2], process.argv[3]).catch((err) => {
    console.error('✗ 生成失败:', err.message);
    process.exit(1);
  });
}