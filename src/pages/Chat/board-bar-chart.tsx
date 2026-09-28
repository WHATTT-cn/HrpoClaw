/**
 * V6 看板柱状图组件（采购下单板块三专用，可被其他看板复用）
 *
 * 设计取舍：不引入图表库（chart.js 仅在 devDependencies 且渲染进程从未使用），
 * 用 flex + 内联高度实现纯 DOM 柱状图，避免为 8 个静态小图增加数百 KB 包体与 canvas 生命周期管理。
 *
 * 约定：
 * - 一张图 = 一个指标 × 该条件组下的全部供应商；柱色由调用方按供应商稳定序号传入，保证跨图同色。
 * - 柱顶直接标注数值（用户要求「在图上标注数据」），故不画 y 轴刻度。
 * - null 值不画柱，仅在该列位置显示「暂无数据」，保持列位与图例一一对应。
 */
import { barColor } from './board-format';

/** 单根柱。 */
export interface BarItem {
  /** 供应商名（仅用于 aria/title，不在柱下重复渲染，避免与图下方图例重复）。 */
  名称: string;
  /** 参与高度计算的原始值；null 表示该供应商此指标无数据。 */
  值: number | null;
  /** 柱顶标注文本（已格式化，含百分号等）。 */
  展示: string;
  /** 柱色（十六进制）。 */
  颜色: string;
}

/** 绘图区高度（px）：柱体最大高度，柱顶数值标注在其上方。 */
const PLOT_H = 96;

/** 单柱最小宽度（px）：供应商多时柱体过窄会让柱顶数值互相挤压，低于此宽度则整图横向滚动。 */
const BAR_MIN_W = 26;

/**
 * 单指标柱状图。
 * 高度按「该图内最大值」归一化（各指标量纲不同，不做跨图统一基准）。
 */
export function MetricBarChart({
  指标,
  单位,
  说明,
  bars,
}: {
  指标: string;
  单位?: string;
  说明?: string;
  bars: BarItem[];
}) {
  const 有效值 = bars.map((b) => b.值).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const 最大值 = 有效值.length > 0 ? Math.max(...有效值) : 0;
  const 全空 = 有效值.length === 0;

  return (
    <div
      className="rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]"
      title={说明}
    >
      <div className="mb-2 flex items-baseline gap-1.5">
        <span className="text-[11px] font-semibold text-foreground">{指标}</span>
        {单位 && <span className="text-[10px] text-muted-foreground">{单位}</span>}
      </div>

      {全空 ? (
        <div className="flex h-[96px] items-center justify-center text-[11px] text-muted-foreground">
          暂无数据
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex items-end gap-1.5" style={{ height: PLOT_H + 18 }}>
            {bars.map((b, i) => {
              const 有值 = typeof b.值 === 'number' && Number.isFinite(b.值);
              // 最大值为 0 时（如全为 0 的比率）给一个可见的最小柱高，避免整排消失。
              const h =
                有值 && 最大值 > 0 ? Math.max((b.值 as number) / 最大值, 0.02) * PLOT_H : 有值 ? 2 : 0;
              return (
                <div
                  key={`${b.名称}-${i}`}
                  className="flex flex-1 flex-col items-center justify-end"
                  style={{ minWidth: BAR_MIN_W }}
                  title={`${b.名称} · ${指标} ${b.展示}${单位 ? ` ${单位}` : ''}`}
                >
                  <span className="mb-0.5 text-[10px] font-medium tabular-nums text-foreground">
                    {有值 ? b.展示 : '—'}
                  </span>
                  <div
                    className="w-full rounded-t-sm"
                    style={{ height: `${h}px`, backgroundColor: 有值 ? b.颜色 : 'transparent' }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 图例项：供应商 + 颜色 + 样本人数。 */
export interface LegendItem {
  供应商: string;
  样本人数: number;
  /** 供应商在本条件组内的稳定序号，用于取色。 */
  序号: number;
  /** 悬浮说明（档级 / 置信度等统计留痕，卡片形态下线后由此承载）。 */
  说明?: string;
}

/** 图表框底部共享图例（供应商名称 + 色块 + 样本人数）。 */
export function SupplierLegend({ items }: { items: LegendItem[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
      {items.map((it) => (
        <span key={it.供应商} className="inline-flex items-center gap-1.5" title={it.说明}>
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: barColor(it.序号) }}
          />
          <span className="text-[11px] text-foreground">{it.供应商}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            样本 {it.样本人数} 人
          </span>
        </span>
      ))}
    </div>
  );
}