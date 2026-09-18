/**
 * 区域健康看板
 *
 * 仅在 PO agent 对话窗口左半区渲染（见 Chat/index.tsx），位于「采购下单」「履约追踪」之前。
 *
 * 职责：以「洲际 / 片区 / 物流仓」三级多选筛选为入口，展示所选物流仓范围内的**整体**健康指标
 *（不下钻到单个供应商行，单行明细请看「采购下单」Tab）。
 *
 * 数据来源：`~/.openclaw/workspace-po/供应商画像.json`（与供应商画像看板同源，运行时 readTextFile 读取）。
 * 层级维度来源：`supplier-portrait-table.ts` 的 `仓库层级表`（真源 JSON 无洲际/片区字段）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ChevronDown, Globe2, Map as MapIcon, RefreshCw, Warehouse } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { readTextFile } from '@/lib/file-preview-client';
import type { 画像行, 多仓画像表 } from '@/data/supplier-portrait-table';
import { 仓库层级表, 未分区标签 } from '@/data/supplier-portrait-table';

/** 画像数据文件路径（与 agent-config 预置种子路径一致）。 */
const PORTRAIT_FILE_PATH = '~/.openclaw/workspace-po/供应商画像.json';

/** 基准兜底行的档级标记；这类行是全仓聚合，不能计入真实供应商统计。 */
const 基准档级 = '④基准';

/** 容错解析 JSON 文本为多仓画像表；结构不符时回退空表。 */
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

/** 层级筛选节点：一个物流仓 + 洲际/片区归属 + 对应真源仓数据（可能缺数据）。 */
interface 仓节点 {
  洲际: string;
  片区: string;
  /** 展示名。 */
  物流仓: string;
  /** 真源仓名（用于与画像 JSON 匹配）。 */
  真源物流仓: string;
  仓?: 多仓画像表['仓库'][number];
}

/** 去重且保序。 */
function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

/** 多选项切换：已选则移除，未选则追加。 */
function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** 空选 = 不筛选（视为全选）；否则取交集，避免上级变化后残留失效项。 */
function 生效选项(已选: string[], 可选: string[]): string[] {
  const hit = 已选.filter((v) => 可选.includes(v));
  return hit.length > 0 ? hit : 可选;
}

/** 数值格式化：null / undefined / 非数字统一显示为「—」。 */
function num(v: number | null | undefined, digits: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

/** 以样本人数为权重求加权均值；无有效样本时回退等权均值，全无数据时返回 null。 */
function 加权均值(行列: 画像行[], pick: (行: 画像行) => number | null | undefined): number | null {
  let 加权和 = 0;
  let 权重和 = 0;
  let 简单和 = 0;
  let 计数 = 0;
  for (const 行 of 行列) {
    const v = pick(行);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    简单和 += v;
    计数 += 1;
    const w = typeof 行.样本人数 === 'number' && Number.isFinite(行.样本人数) ? 行.样本人数 : 0;
    if (w > 0) {
      加权和 += v * w;
      权重和 += w;
    }
  }
  if (权重和 > 0) return 加权和 / 权重和;
  if (计数 > 0) return 简单和 / 计数;
  return null;
}

/** 单个层级的多选勾选下拉。 */
function LevelFilter({
  icon,
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  icon: ReactNode;
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const 有效已选 = selected.filter((v) => options.includes(v));
  const 摘要 =
    有效已选.length === 0
      ? `全部${label}`
      : 有效已选.length === 1
        ? 有效已选[0]
        : `${label} · ${有效已选.length} 项`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-black/10 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
        >
          {icon}
          <span className="truncate">{摘要}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel>{label}（可多选）</DropdownMenuLabel>
        {options.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无可选项</div>
        )}
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt}
            checked={有效已选.includes(opt)}
            onCheckedChange={() => onToggle(opt)}
          >
            {opt}
          </DropdownMenuCheckboxItem>
        ))}
        {options.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={false} onCheckedChange={onClear}>
              清空（= 全部）
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 大号总览指标卡。 */
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** 分布条：按占比展示某个维度的构成。 */
function DistBar({ items, total }: { items: { key: string; count: number }[]; total: number }) {
  if (total <= 0) return null;
  return (
    <div className="space-y-1.5">
      {items.map(({ key, count }) => (
        <div key={key} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-[11px] text-muted-foreground">{key}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-sky-500/60"
              style={{ width: `${Math.round((count / total) * 100)}%` }}
            />
          </div>
          <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {count}（{Math.round((count / total) * 100)}%）
          </span>
        </div>
      ))}
    </div>
  );
}

/** 统计某字段的取值分布（按出现次数降序）。 */
function 分布(行列: 画像行[], pick: (行: 画像行) => string): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const 行 of 行列) {
    const k = pick(行) || '未知';
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

export function RegionHealthDashboard() {
  const [画像表, set画像表] = useState<多仓画像表>({ 画像版本: '', 仓库: [] });
  // 三级筛选已选项；空数组表示「不筛选 = 全部」。
  const [选中洲际, set选中洲际] = useState<string[]>([]);
  const [选中片区, set选中片区] = useState<string[]>([]);
  const [选中物流仓, set选中物流仓] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await readTextFile(PORTRAIT_FILE_PATH);
      if (!res.ok) {
        if (res.error !== 'notFound') {
          setError(`读取失败：${res.error ?? '未知错误'}`);
        }
        set画像表({ 画像版本: '', 仓库: [] });
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

  /** 全量仓节点 = 层级表登记项 ∪ 数据里出现的仓（未登记的归入「未分区」，保证不丢数据）。 */
  const 全部仓节点 = useMemo<仓节点[]>(() => {
    const byName = new Map(仓库列表.map((w) => [w.物流仓, w] as const));
    const nodes: 仓节点[] = 仓库层级表.map((h) => ({
      洲际: h.洲际,
      片区: h.片区,
      物流仓: h.物流仓,
      真源物流仓: h.真源物流仓,
      仓: byName.get(h.真源物流仓),
    }));
    const 已登记 = new Set(仓库层级表.map((h) => h.真源物流仓));
    for (const w of 仓库列表) {
      if (已登记.has(w.物流仓)) continue;
      nodes.push({
        洲际: 未分区标签,
        片区: 未分区标签,
        物流仓: w.物流仓,
        真源物流仓: w.物流仓,
        仓: w,
      });
    }
    return nodes;
  }, [仓库列表]);

  // 逐级联动：下级可选项由上级生效选项裁剪。
  const 洲际选项 = useMemo(() => uniq(全部仓节点.map((n) => n.洲际)), [全部仓节点]);
  const 生效洲际 = useMemo(() => 生效选项(选中洲际, 洲际选项), [选中洲际, 洲际选项]);
  const 片区选项 = useMemo(
    () => uniq(全部仓节点.filter((n) => 生效洲际.includes(n.洲际)).map((n) => n.片区)),
    [全部仓节点, 生效洲际],
  );
  const 生效片区 = useMemo(() => 生效选项(选中片区, 片区选项), [选中片区, 片区选项]);
  const 物流仓选项 = useMemo(
    () =>
      uniq(
        全部仓节点
          .filter((n) => 生效洲际.includes(n.洲际) && 生效片区.includes(n.片区))
          .map((n) => n.物流仓),
      ),
    [全部仓节点, 生效洲际, 生效片区],
  );
  const 生效物流仓 = useMemo(() => 生效选项(选中物流仓, 物流仓选项), [选中物流仓, 物流仓选项]);

  /** 最终纳入统计的仓节点（必须有画像数据）。 */
  const 展示仓节点 = useMemo(
    () =>
      全部仓节点.filter(
        (n) =>
          !!n.仓 &&
          生效洲际.includes(n.洲际) &&
          生效片区.includes(n.片区) &&
          生效物流仓.includes(n.物流仓),
      ),
    [全部仓节点, 生效洲际, 生效片区, 生效物流仓],
  );

  /** 区域整体聚合：真实供应商行参与均值统计，基准兜底行仅计数不参与。 */
  const 汇总 = useMemo(() => {
    const 全部行 = 展示仓节点.flatMap((n) => n.仓?.行 ?? []);
    const 真实行 = 全部行.filter((行) => 行.档级 !== 基准档级);
    const 基准行数 = 全部行.length - 真实行.length;
    const 供应商集 = new Set(真实行.map((行) => 行.供应商));
    const 报价行 = 真实行.filter((行) => typeof 行.价格 === 'number' && Number.isFinite(行.价格));
    return {
      仓数: 展示仓节点.length,
      行数: 全部行.length,
      真实行数: 真实行.length,
      基准行数,
      供应商数: 供应商集.size,
      缺报价行数: 真实行.length - 报价行.length,
      样本人数: 真实行.reduce(
        (s, 行) => s + (typeof 行.样本人数 === 'number' ? 行.样本人数 : 0),
        0,
      ),
      供给能力: 真实行.reduce(
        (s, 行) => s + (typeof 行.历史最大供给量 === 'number' ? 行.历史最大供给量 : 0),
        0,
      ),
      均价: 加权均值(真实行, (行) => 行.价格),
      供给率: 加权均值(真实行, (行) => 行.供给率),
      到岗天数: 加权均值(真实行, (行) => 行.到岗天数),
      考勤率: 加权均值(真实行, (行) => 行.考勤率),
      离职率: 加权均值(真实行, (行) => 行.离职率),
      人效: 加权均值(真实行, (行) => 行.人效),
      置信度分布: 分布(真实行, (行) => 行.置信度),
      工种分布: 分布(真实行, (行) => 行.工种),
      班次分布: 分布(真实行, (行) => 行.班次),
      真实行列: 真实行,
    };
  }, [展示仓节点]);

  /** 每个仓的分仓概览（多选时逐仓对比）。 */
  const 分仓概览 = useMemo(
    () =>
      展示仓节点.map((节点) => {
        const 全部行 = 节点.仓?.行 ?? [];
        const 真实行 = 全部行.filter((行) => 行.档级 !== 基准档级);
        return {
          节点,
          供应商数: new Set(真实行.map((行) => 行.供应商)).size,
          行数: 全部行.length,
          均价: 加权均值(真实行, (行) => 行.价格),
          供给率: 加权均值(真实行, (行) => 行.供给率),
          考勤率: 加权均值(真实行, (行) => 行.考勤率),
          离职率: 加权均值(真实行, (行) => 行.离职率),
          人效: 加权均值(真实行, (行) => 行.人效),
          供给能力: 真实行.reduce(
            (s, 行) => s + (typeof 行.历史最大供给量 === 'number' ? 行.历史最大供给量 : 0),
            0,
          ),
        };
      }),
    [展示仓节点],
  );

  /** 低置信度占比（低 + 极低），用于健康提示。 */
  const 低置信度占比 = useMemo(() => {
    const 总 = 汇总.真实行数;
    if (总 <= 0) return 0;
    const 低 = 汇总.真实行列.filter((行) => 行.置信度 === '低' || 行.置信度 === '极低').length;
    return 低 / 总;
  }, [汇总]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：三级层级多选筛选 + 刷新 */}
      <div className="shrink-0 border-b border-black/5 px-4 py-3 dark:border-white/5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            区域健康看板
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
        <div className="flex flex-wrap items-center gap-2">
          <LevelFilter
            icon={<Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            label="洲际"
            options={洲际选项}
            selected={选中洲际}
            onToggle={(v) => set选中洲际((prev) => toggle(prev, v))}
            onClear={() => set选中洲际([])}
          />
          <LevelFilter
            icon={<MapIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            label="片区"
            options={片区选项}
            selected={选中片区}
            onToggle={(v) => set选中片区((prev) => toggle(prev, v))}
            onClear={() => set选中片区([])}
          />
          <LevelFilter
            icon={<Warehouse className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            label="物流仓"
            options={物流仓选项}
            selected={选中物流仓}
            onToggle={(v) => set选中物流仓((prev) => toggle(prev, v))}
            onClear={() => set选中物流仓([])}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          画像版本 {画像表.画像版本 || '—'} · 已选 {汇总.仓数}/{物流仓选项.length} 个物流仓 ·{' '}
          {汇总.行数} 行（含基准 {汇总.基准行数} 行）
        </p>
      </div>

      {/* 主体：区域整体指标 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && 汇总.仓数 === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
            <Activity className="h-8 w-8 opacity-40" />
            <p className="text-sm">
              {仓库列表.length === 0 ? '暂无供应商画像数据' : '当前筛选条件下无画像数据'}
            </p>
            <p className="text-[11px]">
              {仓库列表.length === 0
                ? '画像由 weights-guard 从 TS 真源定期刷新，刷新后点右上角刷新载入。'
                : '请调整上方洲际 / 片区 / 物流仓的勾选项。'}
            </p>
          </div>
        )}

        {汇总.仓数 > 0 && (
          <>
            {/* 规模概览 */}
            <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
              <h3 className="mb-2 px-1 text-sm font-semibold text-foreground">区域规模</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard label="物流仓" value={String(汇总.仓数)} hint="已选范围内" />
                <StatCard label="供应商" value={String(汇总.供应商数)} hint="不含全体基准" />
                <StatCard label="画像行" value={String(汇总.真实行数)} hint={`基准 ${汇总.基准行数} 行`} />
                <StatCard label="累计样本人数" value={String(汇总.样本人数)} />
              </div>
            </section>

            {/* 健康指标 */}
            <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
              <h3 className="mb-2 px-1 text-sm font-semibold text-foreground">
                整体健康指标
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  按样本人数加权
                </span>
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <StatCard
                  label="均价 $/(人·天)"
                  value={num(汇总.均价, 2)}
                  hint={汇总.缺报价行数 > 0 ? `${汇总.缺报价行数} 行无报价未计入` : undefined}
                />
                <StatCard label="供给率" value={num(汇总.供给率, 3)} />
                <StatCard label="到岗天数" value={num(汇总.到岗天数, 1)} />
                <StatCard label="考勤率" value={num(汇总.考勤率, 3)} />
                <StatCard label="离职率" value={num(汇总.离职率, 3)} />
                <StatCard label="人效 件/(人·天)" value={num(汇总.人效, 2)} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <StatCard
                  label="历史最大供给量合计"
                  value={String(汇总.供给能力)}
                  hint="区域供应能力上限参考"
                />
                <StatCard
                  label="低置信度占比"
                  value={`${Math.round(低置信度占比 * 100)}%`}
                  hint="置信度为低 / 极低的行"
                />
              </div>
              {低置信度占比 >= 0.3 && (
                <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  低置信度行占比偏高，区域指标仅作趋势参考，分单前建议回到采购下单核对具体行。
                </p>
              )}
            </section>

            {/* 结构分布 */}
            <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
              <h3 className="mb-2 px-1 text-sm font-semibold text-foreground">结构分布</h3>
              <div className="space-y-3">
                <div>
                  <div className="mb-1.5 px-1 text-[11px] text-muted-foreground">置信度</div>
                  <DistBar items={汇总.置信度分布} total={汇总.真实行数} />
                </div>
                <div>
                  <div className="mb-1.5 px-1 text-[11px] text-muted-foreground">工种</div>
                  <DistBar items={汇总.工种分布} total={汇总.真实行数} />
                </div>
                <div>
                  <div className="mb-1.5 px-1 text-[11px] text-muted-foreground">班次</div>
                  <DistBar items={汇总.班次分布} total={汇总.真实行数} />
                </div>
              </div>
            </section>

            {/* 分仓对比 */}
            <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
              <h3 className="mb-2 px-1 text-sm font-semibold text-foreground">分仓对比</h3>
              <div className="space-y-2">
                {分仓概览.map(({ 节点, ...m }) => (
                  <div
                    key={节点.真源物流仓}
                    className="rounded-xl border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <Warehouse className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{节点.物流仓}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {节点.洲际} · {节点.片区}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        · {m.供应商数} 家 / {m.行数} 行
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
                      <Mini label="均价" value={num(m.均价, 2)} />
                      <Mini label="供给率" value={num(m.供给率, 3)} />
                      <Mini label="考勤率" value={num(m.考勤率, 3)} />
                      <Mini label="离职率" value={num(m.离职率, 3)} />
                      <Mini label="人效" value={num(m.人效, 2)} />
                      <Mini label="供给上限" value={String(m.供给能力)} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** 分仓对比里的小指标。 */
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export default RegionHealthDashboard;