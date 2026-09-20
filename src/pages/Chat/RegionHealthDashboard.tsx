/**
 * 区域健康看板（V6）
 *
 * 仅在 PO agent 对话窗口左半区渲染（见 Chat/index.tsx），位于「采购下单」「履约追踪」之前。
 *
 * 职责：以「周期（自定义起止月区间）× 洲际 / 片区 / 物流仓三级多选」为入口，
 * 展示所选范围内的**整体**健康指标（板块一 35 字段五分区）与**分供应商**明细（板块二 23 字段）。
 *
 * 数据来源：`~/.openclaw/workspace-po/区域健康原子量.json`（运行时 readTextFile 读取，
 * 由 `pnpm gen:v6` 从 TS 真源派生；重跑 gen 即刷新）。读取失败时回退 bundle 内 `默认区域原子量`。
 *
 * 聚合口径：一律调用 `v6-board-table.ts` 的 `聚合板块一 / 聚合板块二`（与对账闸门同一条代码路径），
 * 本组件不自行做任何加权近似。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  CalendarRange,
  ChevronDown,
  Globe2,
  Map as MapIcon,
  RefreshCw,
  Warehouse,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { readTextFile } from '@/lib/file-preview-client';
import { PickOne, StatCard } from './board-widgets';
import { num, pct } from './board-format';
import type { 区域原子量, 周期选择, 板块一聚合, 板块二聚合行 } from '@/data/v6-board-table';
import {
  仓库层级表,
  未分区标签,
  默认区域原子量,
  V6元信息,
  聚合板块一,
  聚合板块二,
} from '@/data/v6-board-table';

/** 原子量数据文件路径（与 agent-config 预置种子、gen-v6-boards 写入路径一致）。 */
const ATOMS_FILE_PATH = '~/.openclaw/workspace-po/区域健康原子量.json';

/** 预设周期档。 */
interface 周期档项 {
  name: string;
  start: string;
  end: string;
}

/** 运行时读取的原子量文档 = 原子量 + 元信息。 */
interface 原子量文档 {
  版本: string;
  生成时间: string;
  periods: 周期档项[];
  warehouses: string[];
  /** 占位字段 → 无数据源原因说明。 */
  placeholders: Record<string, string>;
  源: 区域原子量;
  /** true = 走 bundle 内兜底数据（workspace 文件缺失）。 */
  兜底: boolean;
}

/** bundle 兜底文档：workspace 文件不存在时使用，保证首屏不空。 */
const 兜底文档: 原子量文档 = {
  版本: V6元信息.version,
  生成时间: V6元信息.generated_at,
  periods: V6元信息.periods,
  warehouses: V6元信息.warehouses as unknown as string[],
  placeholders: V6元信息.placeholders as unknown as Record<string, string>,
  源: 默认区域原子量,
  兜底: true,
};

/** 容错解析原子量 JSON；结构不符时回退 bundle 兜底文档。 */
function parseAtoms(text: string): 原子量文档 {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    const 必备 = ['fact', 'wh', 'turnover', 'hcWh', 'hcWhSup', 'peak', 'crossFix'] as const;
    if (!doc || 必备.some((k) => !Array.isArray(doc[k]))) return 兜底文档;
    const periods = Array.isArray(doc.periods)
      ? (doc.periods as 周期档项[]).filter((p) => p && typeof p.name === 'string')
      : 兜底文档.periods;
    return {
      版本: typeof doc.版本 === 'string' ? doc.版本 : '',
      生成时间: typeof doc.生成时间 === 'string' ? doc.生成时间 : '',
      periods: periods.length > 0 ? periods : 兜底文档.periods,
      warehouses: Array.isArray(doc.warehouses) ? (doc.warehouses as string[]) : [],
      placeholders:
        doc.placeholders && typeof doc.placeholders === 'object'
          ? (doc.placeholders as Record<string, string>)
          : {},
      源: {
        fact: doc.fact,
        wh: doc.wh,
        turnover: doc.turnover,
        hcWh: doc.hcWh,
        hcWhSup: doc.hcWhSup,
        peak: doc.peak,
        crossFix: doc.crossFix,
      } as unknown as 区域原子量,
      兜底: false,
    };
  } catch {
    return 兜底文档;
  }
}

/** 层级筛选节点：一个物流仓 + 洲际/片区归属。 */
interface 仓节点 {
  洲际: string;
  片区: string;
  物流仓: string;
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

/** 枚举 [起, 止] 之间的全部 YYYY-MM（闭区间）。 */
function 枚举月份(起: string, 止: string): string[] {
  const out: string[] = [];
  const [y0, m0] = 起.split('-').map(Number);
  const [y1, m1] = 止.split('-').map(Number);
  if (!y0 || !m0 || !y1 || !m1) return out;
  let y = y0;
  let m = m0;
  while (y < y1 || (y === y1 && m <= m1) ) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break; // 安全阀
  }
  return out;
}

/* ========================= 展示组件 ========================= */

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

/** 悬浮说明拼接：过滤空值后用 · 连接，全空返回 undefined（不渲染 title）。 */
const tip = (...parts: (string | undefined)[]) => {
  const s = parts.filter(Boolean).join(' · ');
  return s || undefined;
};

/** KPI 分区容器。 */
function KpiSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
      <h3 className="mb-2 px-1 text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 指标卡 + 下拉明细（通用）。
 *
 * 主界面只占一张 StatCard 的位置，明细一律收进下拉，避免平铺挤占版面。
 * - `value` 省略时主值取 `items.length`（名单型：活跃供应商 / 覆盖物流仓）；
 * - `value` 传入时主值即该比率/数值（比率型：考勤异常率 / 异常处理进度 / 头部供应商占比）。
 */
function StatCardDetail({
  label,
  items,
  value,
  title,
}: {
  label: string;
  items: { 名称: string; 数值?: string }[];
  value?: string;
  title?: string;
}) {
  const 显示 = items.map((it) => ({ ...it, 名称: it.名称 || '（非三方/未知）' }));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={title}
          className="rounded-xl border border-black/5 bg-black/[0.02] p-3 text-left transition-colors hover:bg-black/5 dark:border-white/5 dark:bg-white/[0.02] dark:hover:bg-white/[0.06]"
        >
          <div className="flex items-center justify-between gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>{label}</span>
            <ChevronDown className="h-3 w-3" />
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
            {value ?? num(items.length)}
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px]">
          {label} 明细（{items.length}）
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {显示.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">—</div>
        ) : (
          <div className="flex flex-col gap-0.5 p-2">
            {显示.map((it) => (
              <div
                key={it.名称}
                className="flex items-baseline justify-between gap-3 rounded-md px-1.5 py-1 text-[11px] text-foreground odd:bg-black/[0.03] dark:odd:bg-white/[0.05]"
              >
                <span className="truncate">{it.名称}</span>
                {it.数值 !== undefined && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{it.数值}</span>
                )}
             </div>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ========================= 主组件 ========================= */

export function RegionHealthDashboard() {
  const [doc, setDoc] = useState<原子量文档>(兜底文档);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 层级筛选（空数组 = 全选）
  const [选中洲际, set选中洲际] = useState<string[]>([]);
  const [选中片区, set选中片区] = useState<string[]>([]);
  const [选中仓, set选中仓] = useState<string[]>([]);

  // 周期筛选：仅保留自定义起止月区间（预设档不再作为可选项暴露，
  // 但区间与某预设档完全重合时仍回落到该档，以拿到精确去重人头，见 `周期` memo）
  const [自定义起, set自定义起] = useState<string>('');
  const [自定义止, set自定义止] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await readTextFile(ATOMS_FILE_PATH);
      if (!res.ok) {
        // 文件不存在 = 尚未预置/未跑 gen，用 bundle 兜底，不作为错误展示。
        if (res.error !== 'notFound') setError(`读取失败：${res.error ?? '未知错误'}`);
        setDoc(兜底文档);
        return;
      }
      setDoc(parseAtoms(res.content ?? ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDoc(兜底文档);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------- 层级选项 ---------- */

  // 仓全集 = 层级表登记仓 ∪ 数据中出现的仓（未登记者归「未分区」，不丢数据）。
  const 仓节点表 = useMemo<仓节点[]>(() => {
    const 映射 = new Map(仓库层级表.map((r) => [r.物流仓, r]));
    const 数据仓 = doc.warehouses.length > 0 ? doc.warehouses : uniq(doc.源.fact.map((r) => r.物流仓));
    const 全集 = uniq([...仓库层级表.map((r) => r.物流仓), ...数据仓]);
    return 全集.map((w) => {
      const hit = 映射.get(w);
      return {
        洲际: hit?.洲际 ?? 未分区标签,
        片区: hit?.片区 ?? 未分区标签,
        物流仓: w,
      };
    });
  }, [doc]);

  const 洲际选项 = useMemo(() => uniq(仓节点表.map((n) => n.洲际)), [仓节点表]);
  const 生效洲际 = useMemo(() => 生效选项(选中洲际, 洲际选项), [选中洲际, 洲际选项]);

  const 片区选项 = useMemo(
    () => uniq(仓节点表.filter((n) => 生效洲际.includes(n.洲际)).map((n) => n.片区)),
    [仓节点表, 生效洲际],
  );
  const 生效片区 = useMemo(() => 生效选项(选中片区, 片区选项), [选中片区, 片区选项]);

  const 仓选项 = useMemo(
    () =>
      uniq(
        仓节点表
          .filter((n) => 生效洲际.includes(n.洲际) && 生效片区.includes(n.片区))
          .map((n) => n.物流仓),
      ),
    [仓节点表, 生效洲际, 生效片区],
  );
  const 生效仓 = useMemo(() => 生效选项(选中仓, 仓选项), [选中仓, 仓选项]);

  /**
   * 传给聚合器的仓集合：全选时传 `[]`（= 不筛选，聚合器内部走「全部仓」快路径，
   * 与 gen 快照的 `{名称:'全部仓',仓:[]}` 完全同构）。
   */
  const 聚合仓 = useMemo(
    () => (生效仓.length === 仓节点表.length ? [] : 生效仓),
    [生效仓, 仓节点表],
  );

  /* ---------- 周期选项 ---------- */

  // 全量可选月：以预设档的最早/最晚为边界，防止自定义区间越界得全 0。
  const 月份全集 = useMemo(() => {
    const 起 = doc.periods.reduce<string>(
      (m, p) => (!m || p.start < m ? p.start : m),
      '',
    );
    const 止 = doc.periods.reduce<string>((m, p) => (p.end > m ? p.end : m), '');
    if (!起 || !止) return [];
    return 枚举月份(起.slice(0, 7), 止.slice(0, 7));
  }, [doc.periods]);

  // 默认区间 = 全量可选月的首尾（等价于原「全周期」预设档）。
  useEffect(() => {
    if (月份全集.length === 0) return;
    if (!自定义起) set自定义起(月份全集[0]);
    if (!自定义止) set自定义止(月份全集[月份全集.length - 1]);
  }, [月份全集, 自定义起, 自定义止]);

  const 周期 = useMemo<周期选择>(() => {
    const 起 = 自定义起 || 月份全集[0] || '';
    const 止0 = 自定义止 || 月份全集[月份全集.length - 1] || 起;
    const [下, 上] = 起 <= 止0 ? [起, 止0] : [止0, 起];
    // ★ 区间与某预设档完全重合时回落到该档：人头附表按档预聚合，
    //   命中档才有精确去重人头；否则 周期档= null，聚合器标「人头近似」。
    //   构造范式与 gen-v6-boards.mjs buildRegion 一致（YYYY-MM-DD → YYYY-MM）。
    const 档 = doc.periods.find(
      (p) => p.start.slice(0, 7) === 下 && p.end.slice(0, 7) === 上,
    );
    return { 周期档: 档 ? 档.name : null, 起: 下, 止: 上 };
  }, [doc.periods, 自定义起, 自定义止, 月份全集]);

  /* ---------- 聚合（唯一口径出口） ---------- */

  const 板块一 = useMemo<板块一聚合>(
    () => 聚合板块一(周期, 聚合仓, doc.源),
    [周期, 聚合仓, doc.源],
  );
  const 板块二 = useMemo<板块二聚合行[]>(
    () => 聚合板块二(周期, 聚合仓, doc.源),
    [周期, 聚合仓, doc.源],
  );

  const 人头近似 = 板块一.人头近似;
  const 人头提示 = 人头近似 ? '自定义月区间无法跨月精确去重，人头类指标按 Σ 上界近似' : undefined;
  const 峰值提示 = 板块一.峰值近似 ? '多仓合并时历史最大供给量为 Σ 上界（≤ 真值）' : undefined;
  const ph = (key: string) => doc.placeholders[key] ?? '无数据源-占位';

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      {/* 头部：标题 + 刷新 + 起止月 + 三级筛选（版式与采购下单看板一致） */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
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

        <div className="flex flex-wrap items-center gap-1.5">
          <PickOne
            icon={<CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />}
            label="起始月"
            value={周期.起}
            options={月份全集.map((m) => ({ value: m, text: m }))}
            onPick={set自定义起}
          />
          <span className="text-xs text-muted-foreground">→</span>
          <PickOne
            icon={<CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />}
            label="结束月"
            value={周期.止}
            options={月份全集.map((m) => ({ value: m, text: m }))}
            onPick={set自定义止}
          />
          <LevelFilter
            icon={<Globe2 className="h-3.5 w-3.5 text-muted-foreground" />}
            label="洲际"
            options={洲际选项}
            selected={选中洲际}
            onToggle={(v) => set选中洲际((s) => toggle(s, v))}
            onClear={() => set选中洲际([])}
          />
          <LevelFilter
            icon={<MapIcon className="h-3.5 w-3.5 text-muted-foreground" />}
            label="片区"
            options={片区选项}
            selected={选中片区}
            onToggle={(v) => set选中片区((s) => toggle(s, v))}
            onClear={() => set选中片区([])}
          />
          <LevelFilter
            icon={<Warehouse className="h-3.5 w-3.5 text-muted-foreground" />}
            label="物流仓"
            options={仓选项}
            selected={选中仓}
            onToggle={(v) => set选中仓((s) => toggle(s, v))}
            onClear={() => set选中仓([])}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          {板块一.统计周期} · {板块一.数据状态}
        </p>

        {(error || doc.兜底) && (
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            {error && <span className="text-red-500">{error}</span>}
            {doc.兜底 && <span>当前为内置快照数据（未找到工作区原子量文件，跑 pnpm gen:v6 后刷新）</span>}
          </div>
        )}
      </header>

      {/* 分区①：供给规模 —— 人力体量（全体 vs 三方 双维度对仗） */}
      <KpiSection title="供给规模">
        {/* 3 列 × 2 行：第一行仓与工时口径，第二行人头与占比（全体 vs 三方 上下对仗） */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCardDetail
            label="覆盖物流仓"
            items={板块一.覆盖物流仓.map((w) => ({ 名称: w }))}
          />
          <StatCard
            label="全体考勤工时"
            value={num(板块一.全体考勤工时, 1)}
            hint="小时"
            title="含自有员工"
          />
          <StatCard label="三方员工考勤工时" value={num(板块一.考勤工时, 1)} hint="小时" />
          <StatCard
            label="全体人数"
            value={num(板块一.全体出勤人数)}
            hint="人"
            title={tip('含自有员工', 人头近似 ? '近似值' : '去重人头', 人头提示)}
          />
          <StatCard
            label="三方员工人数"
            value={num(板块一.供给人数)}
            hint="人"
            title={tip(人头近似 ? '近似值' : '去重人头', 人头提示)}
          />
          <StatCard
            label="三方员工占比"
            value={pct(板块一.三方员工占比)}
            title={tip('三方员工人数 / 全体人数', 人头提示)}
          />
        </div>
      </KpiSection>

      {/* 分区②：供给结构 —— 供应商侧的活跃度与集中度 */}
      <KpiSection title="供给结构">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCardDetail label="活跃供应商" items={板块一.活跃供应商名单.map((s) => ({ 名称: s }))} />
          <StatCard label="静默供应商" value="—" muted title={ph('静默供应商数量')} />
          <StatCardDetail
            label="头部供应商占比"
            value={pct(板块一.头部供应商占比)}
            items={板块一.供应商份额.map((x) => ({
              名称: x.供应商,
              数值: `${num(x.供给人数)} · ${pct(x.占比)}`,
            }))}
            title={tip(`头部阈值 ≥ ${pct(板块一.头部供应商阈值, 0)}`, 人头提示)}
          />
        </div>
      </KpiSection>

      {/* 分区③：供给质量 —— 履约、异常、稳定性与业务常量 */}
      <KpiSection title="供给质量">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <StatCard label="计划出勤人次" value={num(板块一.计划出勤人次)} hint="人次" />
          <StatCard label="出勤人次" value={num(板块一.出勤人次)} hint="人次" />
          <StatCard
            label="出勤人数"
            value={num(板块一.出勤人数)}
            hint="人"
            title={tip(人头近似 ? '近似值' : '去重人头', 人头提示)}
          />
          <StatCard label="出勤率" value={pct(板块一.出勤率)} title="出勤人次 / 计划出勤人次" />
          <StatCard
            label="加班工时占比"
            value={pct(板块一.加班工时占比)}
            title="加班工时 / 三方员工考勤工时"
          />
          <StatCardDetail
            label="考勤异常率"
            value={pct(板块一.考勤异常率)}
            items={Object.entries(板块一.异常明细)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => ({ 名称: k || '未分类', 数值: `${num(v)} 人次` }))}
            title="异常人次 / 计划出勤人次"
          />
          <StatCardDetail
            label="异常处理进度"
            value={pct(板块一.异常处理进度)}
            items={[
              { 名称: '异常已处理人日', 数值: num(板块一.异常已处理人日, 1) },
              { 名称: '异常待处理基数', 数值: num(板块一.异常待处理基数, 1) },
            ]}
            title="已处理人日 / 待处理基数"
          />
          <StatCard
            label="离职率"
            value={pct(板块一.离职率)}
            title="Σ离职 / (末月期末在职 + Σ离职)"
          />
          <StatCard
            label="供给满足率"
            value={pct(板块一.供给满足率)}
            title="业务方指定恒为 100%，非实算；计划需求台账接入后改为实算"
          />
          <StatCard
            label="供给时效"
            value={板块一.供给时效 === null || 板块一.供给时效 === undefined ? '—' : `${板块一.供给时效} 天`}
            muted={板块一.供给时效 === null || 板块一.供给时效 === undefined}
            title="业务方指定恒为 14 天，非实算；计划需求台账接入后改为实算"
          />
        </div>
      </KpiSection>

      {/* 板块二：分供应商明细（23 字段） */}
      <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
        <h3 className="mb-2 flex flex-wrap items-baseline gap-2 px-1 text-sm font-semibold text-foreground">
          供应商明细
          <span className="text-[11px] font-normal text-muted-foreground">
            {板块二.length} 家 · 按供给人数降序
          </span>
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1400px] text-xs">
            <thead>
              <tr className="border-b border-black/10 text-left text-muted-foreground dark:border-white/10">
                {[
                  '供应商',
                  '供给人数',
                  '供给占比',
                  '出勤人数',
                  '出勤率',
                  '计划出勤人次',
                  '出勤人次',
                  '考勤异常人次',
                  '考勤异常人数',
                  '考勤异常率',
                  '考勤工时',
                  '加班工时',
                  '加班占比',
                  '异常处理进度',
                  '已处理人日',
                  '待处理基数',
                  '离职率',
                  '离职人数',
                  '期末在职',
                  '历史最大供给量',
                  '覆盖仓',
                  '供给满足率',
                  '供给时效',
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {板块二.length === 0 && (
                <tr>
                  <td colSpan={23} className="px-2 py-6 text-center text-muted-foreground">
                    当前筛选范围内无供应商数据
                  </td>
                </tr>
              )}
              {板块二.map((r) => (
                <tr
                  key={r.供应商 || '（非三方/未知）'}
                  className="border-b border-black/5 last:border-0 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/[0.04]"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium text-foreground">
                    {r.供应商 || '（非三方/未知）'}
                    {r.是否头部 && (
                      <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                        头部
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums" title={人头提示}>
                    {num(r.供给人数)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{pct(r.供给占比)}</td>
                  <td className="px-2 py-1.5 tabular-nums" title={人头提示}>
                    {num(r.出勤人数)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{pct(r.出勤率)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.计划出勤人次)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.出勤人次)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.考勤异常人次)}</td>
                  <td className="px-2 py-1.5 tabular-nums" title={人头提示}>
                    {num(r.考勤异常人数)}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{pct(r.考勤异常率)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.考勤工时, 1)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.加班工时, 1)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{pct(r.加班工时占比)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{pct(r.异常处理进度)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.异常已处理人日, 1)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.异常待处理基数, 1)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{pct(r.离职率)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.窗口内离职人数)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{num(r.期末在职人数)}</td>
                  <td className="px-2 py-1.5 tabular-nums" title={峰值提示}>
                    {板块一.峰值近似 ? `≤ ${num(r.历史最大供给量)}` : num(r.历史最大供给量)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5" title={r.覆盖物流仓.join('、')}>
                    {r.覆盖物流仓.length}
                  </td>
                  <td
                    className="px-2 py-1.5 tabular-nums"
                    title="业务方指定恒为 100%，非实算"
                  >
                    {pct(r.供给满足率)}
                  </td>
                  <td
                    className="px-2 py-1.5 tabular-nums"
                    title="业务方指定恒为 14 天，非实算"
                  >
                    {r.供给时效 === null || r.供给时效 === undefined ? '—' : `${r.供给时效} 天`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-1.5 px-1 text-[10px] text-muted-foreground">
          数据版本 {doc.版本 || '—'} · 生成于 {doc.生成时间 || '—'}
          {doc.兜底 && ' · 内置快照'}
        </div>
      </section>
    </div>
  );
}