/**
 * 履约追踪看板（V6 板块四）
 *
 * 仅在 PO agent 对话窗口渲染（见 Chat/index.tsx），与 SupplierPortraitDashboard 并列为一个 Tab。
 * 数据来源：`~/.openclaw/workspace-po/履约追踪.json`（运行时 readTextFile 读取，
 * 缺失时回退 bundle 内的 `@shared/po-v6-fulfillment.json` 预置快照，保证首屏不空）。
 *
 * ⚠️ 该 JSON 是**派生产物**，唯一人工维护真源在 `src/data/v6/` + `scripts/gen-v6-boards.mjs`；
 *    修改真源后运行 `pnpm gen:v6` 全量覆盖 JSON 与 shared 预置快照，再在此点刷新。
 *    本看板不提供任何编辑/追加入口。
 *
 * ★形态裁决（A 方案·纯日历派生）：
 * 板块四主表不再单独渲染成台账列表 —— 259 行横跨 21 个月，列表化必然要么截断、
 * 要么引入跨行聚合（违反「前端零聚合」纪律）。因此主表被整体转成**日历上的只读入职事件**，
 * 用户按月翻页浏览，点某天在明细区看当天入职卡片（仓/供应商/人数/留存率/追踪中）。
 *
 * ★读写隔离：入职事件只经 `externalEvents` props 流入日历做渲染，
 * 绝不进入日历的 `entries` 状态，也绝不经 `persist()` 回写，
 * 因此用户新增/删除 PO 日记条目不会覆盖或丢失入职事件（方案 §9.5.3）。
 *
 * 结构：
 * - 顶部标题 + 刷新按钮：手动重新读取 JSON 文件。
 * - 主体：PoDiaryCalendar（上半可写日记 + 只读入职事件融合）。
 * - 底部留痕：数据来源、事件条数、Σ入职人数，便于与主表对账。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { readTextFile } from '@/lib/file-preview-client';
import {
  PO_FULFILLMENT_FILE_PATH,
  parseOnboardingEvents,
  type OnboardingEvent,
} from '@/data/po-diary';
import { PoDiaryCalendar } from './PoDiaryCalendar';
import v6FulfillmentSeed from '@shared/po-v6-fulfillment.json';

export function SupplierDecisionDashboard() {
  const [events, setEvents] = useState<OnboardingEvent[]>([]);
  /** true = 当前展示的是 bundle 内置快照（workspace 文件缺失）。 */
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // today 在每次加载时取一次，作为「窗口是否未满」的判定基准，注入纯函数保证可复现。
    const today = new Date();
    /**
     * workspace 文件不可用时的统一降级路径。
     * ⚠️ 不可命名为 useXxx：eslint 的 react-hooks/rules-of-hooks 会把 use 前缀的函数
     *    误判为 Hook，从而禁止它在回调内被调用。
     */
    const fallbackToSeed = () => {
      setEvents(parseOnboardingEvents(JSON.stringify(v6FulfillmentSeed), today));
      setFallback(true);
    };
    try {
      const res = await readTextFile(PO_FULFILLMENT_FILE_PATH);
      if (!res.ok) {
        // 文件不存在 = 尚未预置/未跑 gen，用 bundle 兜底，不作为错误展示。
        if (res.error !== 'notFound') setError(`读取失败：${res.error ?? '未知错误'}`);
        fallbackToSeed();
        return;
      }
      const parsed = parseOnboardingEvents(res.content ?? '', today);
      // 解析结果为空说明文件损坏或结构不符，回退快照而不是给用户一张空日历。
      if (parsed.length === 0) {
        fallbackToSeed();
        return;
      }
      setEvents(parsed);
      setFallback(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      fallbackToSeed();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 留痕用：Σ入职人数应与板块四主表 Σ入职总人数 完全相等（P4 验收项）。 */
  const 总入职人数 = useMemo(
    () => events.reduce((sum, e) => sum + e.入职总人数, 0),
    [events],
  );

  return (
    <div data-testid="supplier-decision-dashboard" className="flex h-full min-h-0 flex-col">
      {/* 顶部：标题 + 刷新 */}
      <div className="flex shrink-0 items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/5">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          履约追踪看板
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </button>
      </div>

      {/* 主体：PO 日记日历（可写条目 + 只读入职事件） */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {fallback && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
            当前入职事件为内置快照数据（未找到工作区履约追踪文件，跑 pnpm gen:v6 后刷新）
          </div>
        )}
        {/* PO 日记：可写运行时数据，独立读写 ~/.openclaw/workspace-po/PO日记.json；
            externalEvents 为只读派生事件，不参与写链路 */}
        <PoDiaryCalendar externalEvents={events} />

        {/* 底部留痕：仅保留计数与数据源，口径说明收进悬浮提示 */}
        <div
          data-testid="supplier-decision-footnote"
          className="rounded-lg border border-black/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground dark:border-white/5"
          title="事件按入职日期落在日历对应格上，翻月可查看历史批次；留存率直取主表值，前端不重算、不跨行加权；入职日 +30/+90 天未到今天的批次显示「追踪中」而非百分比。"
        >
          <p>
            入职事件共 <span className="tabular-nums">{events.length}</span> 条 · Σ入职人数{' '}
            <span className="tabular-nums">{总入职人数}</span> 人 · 数据源{' '}
            {fallback ? '内置快照' : '履约追踪.json'}
          </p>
        </div>
      </div>
    </div>
  );
}