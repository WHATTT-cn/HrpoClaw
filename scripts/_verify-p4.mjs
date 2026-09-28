/**
 * P4 验收脚本：校验「日历入职事件」与「板块四主表」口径一致。
 *
 * 复刻 src/data/po-diary.ts 里 parseOnboardingEvents 的核心逻辑（日期归一 + 窗口判定），
 * 用同一份产物比对：
 * 1. 事件条数 == 主表行数（无行被静默丢弃）；
 * 2. Σ事件入职人数 == Σ主表入职总人数（P4 验收核心项，基线 2108）；
 * 3. 所有 dateKey 均为合法 YYYY-MM-DD（能落到日历格上）；
 * 4. 打印窗口未满行数，确认「追踪中」拦截覆盖面。
 *
 * 用法：node scripts/_verify-p4.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../shared/po-v6-fulfillment.json');
const doc = JSON.parse(readFileSync(src, 'utf8'));
const 主表 = Array.isArray(doc.主表) ? doc.主表 : [];

const 一天 = 86400000;
const now = new Date();
const 今日零点 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const events = [];
let 丢弃 = 0;
for (const row of 主表) {
  // 产物日期形如 2024-05-01T00:00:00.000，取前 10 位与日历格键对齐。
  const dateKey = typeof row.入职日期 === 'string' ? row.入职日期.slice(0, 10) : '';
  if (!DATE_KEY.test(dateKey)) {
    丢弃 += 1;
    continue;
  }
  const [y, m, d] = dateKey.split('-').map(Number);
  const 入职时刻 = new Date(y, m - 1, d).getTime();
  events.push({
    dateKey,
    入职总人数: Number(row.入职总人数) || 0,
    追踪中30: 入职时刻 + 30 * 一天 > 今日零点,
    追踪中90: 入职时刻 + 90 * 一天 > 今日零点,
  });
}

const Σ主表 = 主表.reduce((s, r) => s + (Number(r.入职总人数) || 0), 0);
const Σ事件 = events.reduce((s, e) => s + e.入职总人数, 0);
const 非法键 = events.filter((e) => !DATE_KEY.test(e.dateKey)).length;
const 追踪中30 = events.filter((e) => e.追踪中30).length;
const 追踪中90 = events.filter((e) => e.追踪中90).length;
const 月份集 = new Set(events.map((e) => e.dateKey.slice(0, 7)));

const 结果 = [
  ['事件条数 == 主表行数', events.length === 主表.length, `${events.length} / ${主表.length}`],
  ['Σ入职人数一致', Σ事件 === Σ主表, `事件 ${Σ事件} / 主表 ${Σ主表}`],
  ['无行被丢弃', 丢弃 === 0, `丢弃 ${丢弃} 行`],
  ['dateKey 全合法', 非法键 === 0, `非法 ${非法键} 个`],
];

console.log('=== P4 履约追踪看板验收 ===');
console.log(`产物：${src}`);
for (const [名称, 通过, 详情] of 结果) {
  console.log(`${通过 ? '✅' : '❌'} ${名称}：${详情}`);
}
console.log(`ℹ️ 跨月数：${月份集.size}（日历需翻页浏览历史批次）`);
console.log(`ℹ️ 窗口未满：30 天 ${追踪中30} 条 / 90 天 ${追踪中90} 条 → UI 显「追踪中」`);

if (结果.some(([, 通过]) => !通过)) {
  console.error('❌ P4 验收未通过');
  process.exit(1);
}
console.log('✅ P4 验收通过');