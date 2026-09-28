// 临时闸门脚本：TS 聚合器 vs Python golden_sample 逐字段对账（阈值 1e-6）
// 用法：node scripts/_verify-golden.mjs
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EPS = 1e-6;

async function loadModule(entry) {
  const r = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm',
    platform: 'node', target: 'node20', logLevel: 'silent', loader: { '.json': 'json' },
  });
  const tmp = join(tmpdir(), `v-${process.pid}-${Date.now()}.mjs`);
  await writeFile(tmp, r.outputFiles[0].text, 'utf8');
  try { return await import(pathToFileURL(tmp).href); } finally { await rm(tmp, { force: true }); }
}

/** 数值近似比较：null/undefined 需两侧同为空 */
function near(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a !== 'number' || typeof b !== 'number') return JSON.stringify(a) === JSON.stringify(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom < EPS;
}

/** 名单类：忽略顺序，按集合比 */
function sameList(a, b) {
  const norm = (v) => {
    if (v === null || v === undefined) return null;
    const arr = Array.isArray(v) ? v : String(v).split('、');
    return [...arr].map(String).sort().join('|');
  };
  return norm(a) === norm(b);
}

/** 异常明细：Record 逐 key 比，忽略 key 顺序 */
function sameDetail(a, b) {
  const na = a ?? {};
  const nb = b ?? {};
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  for (const k of keys) if ((na[k] ?? 0) !== (nb[k] ?? 0)) return false;
  return true;
}

const 名单字段 = new Set(['活跃供应商名单', '头部供应商名单', '静默供应商名单']);
const 跳过字段 = new Set(['生成时间', '统计周期', '数据状态', '覆盖物流仓', '人头近似', '峰值近似']);
/**
 * 峰值豁免字段：跨仓（含「全部仓」）场景下 TS 侧只能拿到 Σ各仓日峰值的上界，
 * 与 Python 全域日峰值不等价（路线B 裁决：峰值保留 Σ 上界 + 峰值近似=true 标记）。
 * 单仓场景不豁免，必须严格相等。
 */
const 峰值豁免字段 = new Set(['历史最大供给量']);

function 仓名映射(短名, 全部仓) {
  if (短名 === '全部仓') return [];
  return 短名.split('+').map((s) => {
    const hit = 全部仓.find((w) => w.endsWith(s));
    if (!hit) throw new Error(`无法映射仓名：${s}`);
    return hit;
  });
}

async function main() {
  const t = await loadModule(resolve(root, 'src/data/v6-board-table.ts'));
  const golden = t.黄金样本;
  const periods = t.V6元信息.periods;
  const 全部仓 = t.V6元信息.warehouses.filter((w) => w !== '未知');

  let total = 0;
  let fail = 0;
  let exempt = 0;
  const 豁免明细 = [];
  for (const [key, g] of Object.entries(golden)) {
    const [周期名, 范围] = key.split('|');
    const p = periods.find((x) => x.name === 周期名);
    const 周期 = { 周期档: p.name, 起: p.start.slice(0, 7), 止: p.end.slice(0, 7) };
    const 仓 = 仓名映射(范围, 全部仓);
    const 跨仓 = 仓.length !== 1; // 空数组=全部仓，同样算跨仓

    // ---- 板块一 ----
   const b1 = t.聚合板块一(周期, 仓);
    for (const [f, expect] of Object.entries(g.board1)) {
      if (跳过字段.has(f)) continue;
      if (跨仓 && 峰值豁免字段.has(f)) {
        exempt++;
        豁免明细.push(`[${key}] 板块一.${f} py=${JSON.stringify(expect)} ts=${JSON.stringify(b1[f])}`);
        continue;
      }
      total++;
      const actual = b1[f];
      const ok = 名单字段.has(f) ? sameList(actual, expect)
        : f === '异常明细' ? sameDetail(actual, expect)
        : near(actual, expect);
      if (!ok) {
        fail++;
        console.log(`✗ [${key}] 板块一.${f}`);
        console.log(`    py=${JSON.stringify(expect)?.slice(0, 120)}`);
        console.log(`    ts=${JSON.stringify(actual)?.slice(0, 120)}`);
      }
    }

    // ---- 板块二 ----
    const b2 = t.聚合板块二(周期, 仓);
    const b2Map = new Map(b2.map((r) => [r.供应商, r]));
    for (const row of g.board2) {
      const got = b2Map.get(row.供应商);
      if (!got) { fail++; total++; console.log(`✗ [${key}] 板块二缺供应商：${row.供应商}`); continue; }
      for (const [f, expect] of Object.entries(row)) {
        if (跳过字段.has(f) || f === '供应商') continue;
        if (跨仓 && 峰值豁免字段.has(f)) {
          exempt++;
          豁免明细.push(`[${key}] 板块二[${row.供应商}].${f} py=${JSON.stringify(expect)} ts=${JSON.stringify(got[f])}`);
          continue;
        }
        total++;
        if (!near(got[f], expect)) {
          fail++;
          console.log(`✗ [${key}] 板块二[${row.供应商}].${f}  py=${JSON.stringify(expect)} ts=${JSON.stringify(got[f])}`);
        }
      }
    }
    if (b2.length !== g.board2.length) {
      console.log(`⚠ [${key}] 板块二行数 py=${g.board2.length} ts=${b2.length}`);
    }
  }

  console.log(`\n对账场景 ${Object.keys(golden).length} 组 · 字段 ${total} 项 · 失败 ${fail} 项 · 峰值豁免 ${exempt} 项`);
  if (exempt > 0) {
    console.log(`\n峰值豁免明细（跨仓场景 TS 侧只能算 Σ各仓日峰值上界）：`);
    for (const line of 豁免明细) console.log(`  ${line}`);
  }
  if (fail > 0) { console.log('\n❌ 黄金样本对账未通过'); process.exit(1); }
  console.log('\n✅ 黄金样本对账通过（阈值 1e-6）');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });