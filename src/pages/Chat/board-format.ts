/**
 * V6 看板共享格式化函数
 *
 * 与 `board-widgets.tsx` 分文件的唯一原因：eslint 规则 `react-refresh/only-export-components`
 * 要求「组件文件只导出组件」，纯函数必须独立成非组件模块，否则热更新失效。
 *
 * 约定：所有函数对 null / undefined / NaN 统一返回「—」，绝不抛错。
 */

/** 数值格式化：null / undefined / 非数字统一显示为「—」；digits=0 时圆整到两位小数。 */
export function num(v: number | null | undefined, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return digits > 0 ? v.toFixed(digits) : String(Math.round(v * 100) / 100);
}

/** 比率格式化为百分比：非有限数 → 「—」。 */
export function pct(v: number | null | undefined, digits = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * 柱状图调色板：按供应商在切片内的稳定序号取色，保证同一供应商在所有图表 / 图例中同色。
 * 取值为固定十六进制而非 tailwind 类名，因柱体高度与颜色需走内联 style（动态值无法被 tailwind 静态提取）。
 */
const BAR_PALETTE = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
  '#0d9488',
  '#b45309',
];

/** 取第 index 个柱色（超出调色板长度后循环复用）。 */
export function barColor(index: number): string {
  return BAR_PALETTE[index % BAR_PALETTE.length];
}