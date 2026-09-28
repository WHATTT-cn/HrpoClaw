/**
 * V6 看板共享展示组件
 *
 * 区域健康（板块一/二）与采购下单（板块三）两个看板共用的原子展示件与格式化函数。
 * 抽取动机：避免两处各自复制一份实现导致样式与口径漂移。
 *
 * 约定：
 * - 组件保持无状态纯展示，不感知任何业务数据结构。
 * - 纯格式化函数（num / pct）另置于 `board-format.ts`，以满足 eslint 的
 *   `react-refresh/only-export-components`（组件文件只导出组件）。
 */
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** 单选下拉（周期档 / 物流仓 / 起止月 / 需求量桶共用）。 */
export function PickOne({
  icon,
  label,
  options,
  value,
  onPick,
}: {
  icon?: ReactNode;
  label: string;
  options: { value: string; text: string }[];
  value: string;
  onPick: (value: string) => void;
}) {
  const 当前 = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-black/10 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
        >
          {icon}
          <span className="truncate">{当前?.text ?? label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无可选项</div>
        )}
        {options.map((opt) => (
          <DropdownMenuItem key={opt.value} onSelect={() => onPick(opt.value)}>
            {opt.text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 指标卡；`hint` 仅承载单位（如「人」「小时」「人次」），口径/公式/派生说明一律走 `title` 悬浮提示，
 * `muted` 用于占位字段灰显。
 */
export function StatCard({
  label,
  value,
  hint,
  muted,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={`rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02] ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{hint}</div>}
    </div>
  );
}