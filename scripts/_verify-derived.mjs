#!/usr/bin/env node
/**
 * 派生产物一致性闸门（防「脚本全绿但 UI 空值」复发）。
 *
 * 背景：V6 数据是三段式链路
 *   Python 产物 src/data/v6/*.json → TS 真源 v6-board-table.ts → `pnpm gen:v6`
 *   → shared/po-v6-*.json（bundle 种子） + ~/.openclaw/workspace-po/*.json（前端运行时读取）
 * 只跑 Python 侧脚本不会刷新后两处，历史上曾导致看板字段全空。
 *
 * 本闸门检查三件事：
 *   1) 新鲜度：派生产物 mtime 不早于 src/data/v6 下最新的 Python 产物
 *   2) 双写一致：shared 与 workspace-po 两侧同名产物内容逐字节一致
 *   3) 关键字段：采购下单切片中 8 号仓的 价格/价格单位/件效/供给满足率/供给时效 非空，
 *      且供给时效与需求量桶一致；区域健康两板块供给时效恒为业务常量 14 天
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pyDir = join(root, 'src/data/v6');
const sharedRoot = join(root, 'shared');
const wsRoot = join(homedir(), '.openclaw/workspace-po');

const PAIRS = [
    ['po-v6-region.json', '区域健康.json'],
    ['po-v6-region-atoms.json', '区域健康原子量.json'],
    ['po-v6-purchase.json', '采购下单.json'],
    ['po-v6-fulfillment.json', '履约追踪.json'],
];

const errors = [];
const fmt = (t) => new Date(t).toLocaleString('zh-CN');

// ---- 1) 新鲜度 ----
const pyFiles = readdirSync(pyDir).filter((f) => f.endsWith('.json'));
let newestPy = { name: '', mtime: 0 };
for (const f of pyFiles) {
    const m = statSync(join(pyDir, f)).mtimeMs;
    if (m > newestPy.mtime) newestPy = { name: f, mtime: m };
}
console.log(`基准：src/data/v6 最新产物 ${newestPy.name} @ ${fmt(newestPy.mtime)}`);

for (const [sharedName, wsName] of PAIRS) {
    for (const p of [join(sharedRoot, sharedName), join(wsRoot, wsName)]) {
        if (!existsSync(p)) {
            errors.push(`缺失派生产物：${p}`);
            continue;
        }
        const m = statSync(p).mtimeMs;
        if (m < newestPy.mtime) {
            errors.push(`派生产物过期：${p} @ ${fmt(m)} 早于 ${newestPy.name} @ ${fmt(newestPy.mtime)}，请重跑 pnpm gen:v6`);
        }
    }
}
if (!errors.length) console.log('✅ 新鲜度：8 个派生产物均不早于 Python 产物');

// ---- 2) 双写一致 ----
for (const [sharedName, wsName] of PAIRS) {
    const a = join(sharedRoot, sharedName);
    const b = join(wsRoot, wsName);
    if (!existsSync(a) || !existsSync(b)) continue;
    if (readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) {
        errors.push(`双写不一致：${sharedName} ≠ ${wsName}，请重跑 pnpm gen:v6`);
    }
}
if (!errors.some((e) => e.startsWith('双写'))) console.log('✅ 双写一致：shared 与 workspace-po 逐字节相同');

// ---- 3) 关键字段 ----
// 8 号仓是唯一有价卡映射的仓（A 保守口径），其 价格单位/件效/供给满足率 必须全非空；
// 价格允许少量 null —— 无价卡编码的供应商（如 Ogram FZ-LLC）按业务方要求忽略，故只卡非空率下限。
const PRICE_NONNULL_MIN = 0.95;
// ★P6″ 供给时效分桶（与 scripts/v6/common.py::SUPPLY_LEAD_BY_BUCKET / v6-board-table.ts::供给时效分桶 同源）
const LEAD_BY_BUCKET = new Map([
    ['0~20', 7],
    ['20~100', 14],
    ['100~9999', 30],
]);
const LEAD_REGION_CONST = 14;
const rowsOf = (slice) => slice?.rows ?? slice?.行 ?? (Array.isArray(slice) ? slice : []);
const purchasePath = join(sharedRoot, 'po-v6-purchase.json');
if (existsSync(purchasePath)) {
    const purchase = JSON.parse(readFileSync(purchasePath, 'utf8'));
    const slices = purchase.切片 ?? {};
    let hit = 0;
    let priceOk = 0;
    let bad = 0;
    let leadBad = 0;
    const noPriceSuppliers = new Set();
    for (const key of Object.keys(slices)) {
        for (const r of rowsOf(slices[key])) {
            if (!String(r.物流仓 ?? '').includes('8')) continue;
            hit++;
            if (r.价格 == null) noPriceSuppliers.add(String(r.供应商 ?? '?'));
            else priceOk++;
            const miss = ['价格单位', '件效', '供给满足率', '供给时效'].filter((k) => r[k] == null);
            if (miss.length) {
                bad++;
                if (bad <= 3) errors.push(`8 号仓行字段为空：${key} → 缺 ${miss.join('/')}`);
            }
            // 供给时效必须与所在需求量桶一致（防 Python/TS 双侧分桶漂移）
            const bk = `${r.需求量下限}~${r.需求量上限}`;
            const want = LEAD_BY_BUCKET.get(bk);
            if (want !== undefined && r.供给时效 !== want) {
                leadBad++;
                if (leadBad <= 3)
                    errors.push(`供给时效与需求量桶不符：${key} 桶 ${bk} 期望 ${want} 实得 ${r.供给时效}`);
            }
        }
    }
    if (!hit) {
        errors.push('未在采购下单切片中找到 8 号仓行，字段断言无法执行');
    } else {
        const rate = priceOk / hit;
        if (rate < PRICE_NONNULL_MIN) {
            errors.push(
                `8 号仓价格非空率 ${(rate * 100).toFixed(1)}% 低于下限 ${PRICE_NONNULL_MIN * 100}%（${priceOk}/${hit}），疑似价卡映射退化`,
            );
        }
        if (!bad) {
            console.log(`✅ 关键字段：8 号仓 ${hit} 行的 价格单位/件效/供给满足率/供给时效 全部非空`);
            console.log(
                `✅ 价格非空率 ${(rate * 100).toFixed(1)}%（${priceOk}/${hit}）；无价卡供应商：${[...noPriceSuppliers].join('、') || '无'}`,
            );
        }
        if (!leadBad) console.log(`✅ 供给时效分桶一致：8 号仓 ${hit} 行均匹配 0-20:7 / 20-100:14 / 100+:30`);
    }
}

// ---- 3b) 区域健康供给时效常量 ----
const regionPath = join(sharedRoot, 'po-v6-region.json');
if (existsSync(regionPath)) {
    const region = JSON.parse(readFileSync(regionPath, 'utf8'));
    const snaps = Object.values(region.快照 ?? {});
    let n = 0;
    let bad = 0;
    for (const s of snaps) {
        for (const v of [s?.板块一?.供给时效, ...(s?.板块二 ?? []).map((r) => r.供给时效)]) {
            n++;
            if (v !== LEAD_REGION_CONST) bad++;
        }
    }
    if (!n) errors.push('区域健康快照为空，供给时效常量断言无法执行');
    else if (bad) errors.push(`区域健康供给时效 ${bad}/${n} 处不等于常量 ${LEAD_REGION_CONST}`);
    else console.log(`✅ 区域健康供给时效：${n} 处全部为业务常量 ${LEAD_REGION_CONST} 天`);
}

if (errors.length) {
    console.error('\n❌ 派生产物校验失败：');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}
console.log('\n✅ 派生产物校验通过');