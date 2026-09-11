/**
 * 供应商画像看板
 *
 * 仅在 PO agent 对话窗口左半区渲染（见 Chat/index.tsx）。
 * 数据来源：`~/.openclaw/workspace-po/供应商画像.json`（由 gen-portrait-md.mjs 从 TS 真源
 * supplier-portrait-table.ts 派生，并在运行时读取 —— 否则构建期快照会被「定期全量刷新」冻结）。
 *
 * 结构：
 * - 顶部下拉按钮 + 刷新按钮：切换物流仓 / 手动重读 JSON。
 * - 每个物流仓的画像表按「供应商」聚合为条目，条目名即供应商名。
 * - 每个供应商条目内，把该供应商的每一行数据用统一圆角矩形卡片分块展示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Warehouse } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { readTextFile } from '@/lib/file-preview-client';
import { usePoDashboardAnalysisStore } from '@/stores/po-dashboard-analysis';
import type { 画像行, 多仓画像表 } from '@/data/supplier-portrait-table';

/** 画像看板数据文件路径（与 agent-config 预置种子路径一致）。 */
const PORTRAIT_FILE_PATH = '~/.openclaw/workspace-po/供应商画像.json';

/**
 * 容错解析 JSON 文本为多仓画像表。
 * 结构不符或异常时回退空表，绝不让解析失败导致看板崩溃。
 */
function parsePortrait(text: string): 多仓画像表 {
  try {
    const doc = JSON.parse(text) as 多仓画像表;
    if (!doc || !Array.isArray(doc.仓库)) {
      return { 画像版本: '', 仓库: [] };
    }
    return {
      画像版本: typeof doc.画像版本 === 'string' ? doc.画像版本 : '',
      仓库: doc.仓库.filter(
        (w): w is NonNullable<typeof w> =>
          !!w && typeof w.物流仓 === 'string' && Array.isArray(w.行),
      ),
    };
  } catch {
    return { 画像版本: '', 仓库: [] };
  }
}

/** 单条指标（label + 值），统一渲染样式。 */
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/** 单行数据块：统一圆角矩形风格。 */
function RowCard({ 行 }: { 行: 画像行 }) {
  const 是基准 = 行.档级 === '④基准';
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        是基准
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-black/5 bg-black/[0.02] dark:border-white/5 dark:bg-white/[0.02]',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-black/5 px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 dark:bg-white/10">
          {行.档级}
        </span>
        <span className="text-xs text-muted-foreground">
          需求量 {行.需求量下限}–{行.需求量上限}
        </span>
        <span className="text-xs text-muted-foreground">· {行.工种}</span>
        <span className="text-xs text-muted-foreground">· {行.班次}</span>
        <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          {行.用工性质}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2">
        <Metric label="价格 $/(人·天)" value={行.价格.toFixed(1)} />
        <Metric label="供给率" value={行.供给率.toFixed(3)} />
        <Metric label="到岗天数" value={行.到岗天数.toFixed(1)} />
        <Metric label="考勤率" value={行.考勤率.toFixed(3)} />
        <Metric label="离职率" value={行.离职率.toFixed(3)} />
        <Metric label="人效" value={行.人效} />
        <Metric label="区间宽度pp" value={行.区间宽度pp.toFixed(1)} />
        <Metric label="样本人数" value={行.样本人数} />
        <Metric label="临界量" value={行.临界量 ?? '—'} />
      </div>
    </div>
  );
}

export function SupplierPortraitDashboard() {
  const [画像表, set画像表] = useState<多仓画像表>({ 画像版本: '', 仓库: [] });
  const [当前仓名, set当前仓名] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestPoDashboardRefresh = usePoDashboardAnalysisStore((s) => s.requestRefresh);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await readTextFile(PORTRAIT_FILE_PATH);
      if (!res.ok) {
        // 文件不存在等同空看板，不作为错误展示。
        if (res.error === 'notFound') {
          set画像表({ 画像版本: '', 仓库: [] });
        } else {
          setError(`读取失败：${res.error ?? '未知错误'}`);
          set画像表({ 画像版本: '', 仓库: [] });
        }
        return;
      }
      set画像表(parsePortrait(res.content ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      set画像表({ 画像版本: '', 仓库: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const 仓库列表 = 画像表.仓库;
  const 当前仓 = useMemo(
    () => 仓库列表.find((w) => w.物流仓 === 当前仓名) ?? 仓库列表[0],
    [仓库列表, 当前仓名],
  );

  // 按供应商聚合成条目（保持数据表中出现顺序）。
  const 供应商分组 = useMemo(() => {
    const map = new Map<string, 画像行[]>();
    for (const 行 of 当前仓?.行 ?? []) {
      const list = map.get(行.供应商) ?? [];
      list.push(行);
      map.set(行.供应商, list);
    }
    return Array.from(map.entries()).map(([供应商, 行组]) => ({ 供应商, 行组 }));
  }, [当前仓]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：下拉切换物流仓 + 刷新 */}
      <div className="shrink-0 border-b border-black/5 px-4 py-3 dark:border-white/5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            供应商画像看板
          </h2>
          <button
            type="button"
            onClick={() => {
              void load();
              requestPoDashboardRefresh();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-black/10 bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
            >
              <Warehouse className="h-4 w-4 text-muted-foreground" />
              <span>{当前仓?.物流仓 ?? '选择物流仓'}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {仓库列表.map((w) => (
              <DropdownMenuItem
                key={w.物流仓}
                onSelect={() => set当前仓名(w.物流仓)}
                className={cn(当前仓名 === w.物流仓 && 'bg-black/5 dark:bg-white/10')}
              >
                {w.物流仓}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {当前仓 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            画像版本 {画像表.画像版本} · 覆盖范围 {当前仓.覆盖范围[0]}–{当前仓.覆盖范围[1]}
          </p>
        )}
      </div>

      {/* 主体：按供应商聚合的条目 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && 仓库列表.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
            <Warehouse className="h-8 w-8 opacity-40" />
            <p className="text-sm">暂无供应商画像数据</p>
            <p className="text-[11px]">画像由 weights-guard 从 TS 真源定期刷新，刷新后手动点右上角刷新载入。</p>
          </div>
        )}
        {供应商分组.map(({ 供应商, 行组 }) => (
          <section
            key={供应商}
            className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold text-foreground">{供应商}</h3>
              <span className="text-[11px] text-muted-foreground">{行组.length} 档</span>
            </div>
            <div className="space-y-2">
              {行组.map((行, idx) => (
                <RowCard key={`${供应商}-${idx}`} 行={行} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default SupplierPortraitDashboard;