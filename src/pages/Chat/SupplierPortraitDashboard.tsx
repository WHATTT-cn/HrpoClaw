/**
 * 采购下单看板（V6 板块三）
 *
 * 仅在 PO agent 对话窗口左半区渲染（见 Chat/index.tsx），位于「区域健康」之后。
 *
 * 职责：以「物流仓【单选】× 周期档【单选】× 需求量桶【单选】× 指标维度【单选】」为入口，
 * 展示该切片下按「条件组 × 供应商」下沉的采购决策依据。
 *
 * ★形态（第四批改造）：每个条件组（工种·班次·用工性质·技能等级）= 一个图表框；
 * 框内每个指标维度一张柱状图，图内一个供应商一根柱（同组跨图同色），柱顶直接标注数值；
 * 框底一份共享图例（供应商 + 色块 + 样本人数，档级/置信度等留痕挂图例悬浮提示）。
 *
 * 数据来源：`~/.openclaw/workspace-po/采购下单.json`（运行时 readTextFile 读取，
 * 由 `pnpm gen:v6` 从 TS 真源派生；重跑 gen 即刷新）。读取失败回退 bundle 内 `po-v6-purchase.json`。
 *
 * ★关键口径（前端零聚合）：
 * - 切片以 `「周期档|物流仓」` 为 key 预生成，前端直取 `切片[key].rows`，不做任何二次聚合。
 * - 需求量桶在 Python 侧是**复制**而非分组统计：同一「条件组×供应商」被复制成 3 桶，
 *   桶内 29 字段值完全相同（需求台账未接入，桶目前仅是占位标签）。故此处用单选筛选器
 *   只渲染选中桶的行，既保留桶维度语义又避免 3 倍冗余展示。
 * - `出勤率` 在 `②粗+EB` 档为经验贝叶斯收缩后值，`出勤率_原始` 为收缩前值，两者并列展示。
 * - Python 侧已按「置信度=极低全删」过滤，产物中不存在 `④基准` 档与 `极低` 置信度；
 *   本组件对二者仍保留渲染分支，作为未来放宽过滤规则时的兜底。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Layers, Package, RefreshCw, Warehouse } from 'lucide-react';
import { readTextFile } from '@/lib/file-preview-client';
import { usePoDashboardAnalysisStore } from '@/stores/po-dashboard-analysis';
import { PickOne, StatCard } from './board-widgets';
import { barColor, num, pct } from './board-format';
import { MetricBarChart, SupplierLegend, type LegendItem } from './board-bar-chart';
import type { Board3Meta, Board3PurchaseByConditionRow } from '@/data/v6/schema';
import v6PurchaseSeed from '@shared/po-v6-purchase.json';

/** 采购下单数据文件路径（与 agent-config 预置种子、gen-v6-boards 写入路径一致）。 */
const PURCHASE_FILE_PATH = '~/.openclaw/workspace-po/采购下单.json';

/** 空态占位行：该仓该周期过滤后无可用记录时，Python 侧写入的唯一一行。 */
interface 空态占位行 {
  物流仓: string;
  说明: string;
  原始切片数: number;
  统计周期: string;
  数据状态: '样本不足-无可用记录';
}

/** 单个切片 = 行数组 + 留痕 meta。 */
interface 切片 {
  rows: (Board3PurchaseByConditionRow | 空态占位行)[];
  meta: Partial<Board3Meta>;
}

/** 运行时读取的采购下单文档。 */
interface 采购文档 {
  版本: string;
  生成时间: string;
  周期档: string[];
  物流仓: string[];
  /** key = `${周期档}|${物流仓}` */
  切片: Record<string, 切片>;
  /** true = 走 bundle 内兜底数据（workspace 文件缺失）。 */
  兜底: boolean;
}

/** 空文档：解析彻底失败时使用，保证组件不崩。 */
const 空文档: 采购文档 = {
  版本: '',
  生成时间: '',
  周期档: [],
  物流仓: [],
  切片: {},
  兜底: false,
};

/** 容错解析采购下单 JSON；结构不符时回退传入的兜底文档。 */
function parsePurchase(text: string, 兜底: 采购文档): 采购文档 {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (!doc || typeof doc.切片 !== 'object' || doc.切片 === null) return 兜底;
    return {
      版本: typeof doc.版本 === 'string' ? doc.版本 : '',
      生成时间: typeof doc.生成时间 === 'string' ? doc.生成时间 : '',
      周期档: Array.isArray(doc.周期档) ? (doc.周期档 as string[]) : [],
      物流仓: Array.isArray(doc.物流仓) ? (doc.物流仓 as string[]) : [],
      切片: doc.切片 as Record<string, 切片>,
      兜底: false,
    };
  } catch {
    return 兜底;
  }
}

/** bundle 兜底文档：workspace 文件不存在时使用，保证首屏不空。 */
const 兜底文档: 采购文档 = {
  ...parsePurchase(JSON.stringify(v6PurchaseSeed), 空文档),
  兜底: true,
};

/** 判定是否为空态占位行（正常行必带「供应商」字段）。 */
function 是占位行(r: Board3PurchaseByConditionRow | 空态占位行): r is 空态占位行 {
  return r.数据状态 === '样本不足-无可用记录';
}

/** 需求量桶：由行上的 `需求量下限~需求量上限` 派生，展示与筛选共用同一 key。 */
function 桶键(r: Board3PurchaseByConditionRow): string {
  return `${r.需求量下限}~${r.需求量上限}`;
}

/** 条件组 key = 工种/班次/用工性质/技能等级（供应商维度在其下）。 */
function 条件组键(r: Board3PurchaseByConditionRow): string {
  return `${r.工种} · ${r.班次} · ${r.用工性质} · 技能${r.技能等级}`;
}

/** 「所有维度」哨兵值：维度筛选器默认项，表示不过滤。 */
const 维度全选 = '所有维度';

/** 可绘图的指标维度定义：一个维度 = 一张柱状图，图内按供应商并排出柱。 */
interface 指标定义 {
  名: string;
  /** 单位（标在图标题右侧；比率型无单位，展示文本自带 %）。 */
  单位?: string;
  /** 口径说明，挂图表框悬浮提示。 */
  说明: string;
  /** 取原始值参与柱高归一化；null = 该供应商此指标无数据。 */
  取值: (r: Board3PurchaseByConditionRow) => number | null;
  /** 柱顶标注文本。 */
  展示: (r: Board3PurchaseByConditionRow) => string;
}

/**
 * 指标清单：顺序即图表渲染顺序，与维度下拉选项顺序一致。
 * 说明文案沿用原卡片形态的 title 口径，形态从卡片改图表但口径不丢。
 */
const 指标清单: 指标定义[] = [
  {
    名: '出勤率',
    说明: '出勤人次 / 计划出勤人次；②粗+EB 档为经验贝叶斯收缩后值（收缩前值见图例悬浮）',
    取值: (r) => r.出勤率 ?? null,
    展示: (r) => pct(r.出勤率),
  },
  {
    名: '考勤异常率',
    说明: '考勤异常人次 / 计划出勤人次',
    取值: (r) => r.考勤异常率 ?? null,
    展示: (r) => pct(r.考勤异常率),
  },
  {
    名: '离职率',
    说明: '窗口内离职人数 / 期末在职人数；下沉粒度＝供应商×用工性质×技能等级',
    取值: (r) => r.离职率 ?? null,
    展示: (r) => pct(r.离职率),
  },
  {
    名: '考勤工时',
    单位: 'h',
    说明: '原子量直取（含加班工时），不做派生比率（口径字典未定义加班占比）',
    取值: (r) => r.考勤工时 ?? null,
    展示: (r) => num(r.考勤工时),
  },
  {
    名: '供给满足率',
    说明: '业务方指定恒为 100%，非实算；各柱等高属预期',
    取值: (r) => r.供给满足率 ?? null,
    展示: (r) => pct(r.供给满足率),
  },
  {
    名: '供给时效',
    单位: '天',
    说明: '按需求量桶取值：0~20→7 / 20~100→14 / 100+→30，非实算；同桶内各柱等高属预期',
    取值: (r) => r.供给时效 ?? null,
    展示: (r) => num(r.供给时效),
  },
  {
    名: '价格',
    单位: 'AED/人·小时',
    说明: '仅 8 号仓有价卡，其余仓及价卡未覆盖的供应商无值（柱顶显示「—」）',
    取值: (r) => r.价格 ?? null,
    展示: (r) => num(r.价格, 2),
  },
  {
    名: '件效',
    单位: '件/人·小时',
    说明: '5 号仓与「未知」仓业务方未给值，故无值（柱顶显示「—」）',
    取值: (r) => r.件效 ?? null,
    展示: (r) => num(r.件效, 2),
  },
];

/**
 * 图例悬浮说明：承接卡片形态下线后无展示位的统计留痕
 * （档级 / 置信度 / Wilson 区间宽度 / 计划出勤人次 / EB 收缩前出勤率）。
 */
function 图例说明(行: Board3PurchaseByConditionRow): string {
  const EB收缩 = 行.档级 === '②粗+EB' && 行.出勤率 !== 行.出勤率_原始;
  return [
    `档级 ${行.档级 ?? '—'}`,
    `置信度 ${行.置信度 ?? '—'} ±${num(行.区间宽度pp, 2)}pp（Wilson 95%：<5pp 高 / 5–8pp 中 / >8pp 低）`,
    `计划出勤 ${num(行.计划出勤人次)} 人次 · 出勤 ${num(行.出勤人次)} 人次`,
    EB收缩 ? `出勤率收缩前 ${pct(行.出勤率_原始)}` : '',
    行.数据状态,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 条件组图表框：一个要求条目（工种·班次·用工性质·技能等级）一框。
 * 框内按指标维度铺柱状图，框底一份共享图例（供应商 + 颜色 + 样本人数）。
 * 颜色由「组内稳定序号」决定，保证同一供应商在本框所有图中同色并与图例对应。
 */
function 条件组图表框({
  组名,
  行组,
  维度,
}: {
  组名: string;
  行组: Board3PurchaseByConditionRow[];
  维度: string;
}) {
  const 生效指标 = 维度 === 维度全选 ? 指标清单 : 指标清单.filter((m) => m.名 === 维度);
  const 图例: LegendItem[] = 行组.map((行, i) => ({
    供应商: 行.供应商,
    样本人数: 行.样本人数 ?? 0,
    序号: i,
    说明: 图例说明(行),
  }));

  return (
    <section className="rounded-2xl border border-black/5 bg-surface-modal/40 p-3 dark:border-white/5">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h3 className="text-sm font-semibold text-foreground">{组名}</h3>
        <span className="shrink-0 text-[11px] text-muted-foreground">{行组.length} 家供应商</span>
      </div>

      <div
        className={`grid gap-2 ${
          生效指标.length === 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4'
        }`}
      >
        {生效指标.map((m) => (
          <MetricBarChart
            key={m.名}
            指标={m.名}
            单位={m.单位}
            说明={m.说明}
            bars={行组.map((行, i) => ({
              名称: 行.供应商,
              值: m.取值(行),
              展示: m.展示(行),
              颜色: barColor(i),
            }))}
          />
        ))}
      </div>

      <SupplierLegend items={图例} />
    </section>
  );
}

/**
 * 空态卡：该仓该周期全部切片置信度为极低、按规则过滤后无可用记录。
 * 不是「没数据」，而是「有原始数据但样本量不足以支撑采购决策」，故把 meta 原始量一并摊开。
 */
function EmptySliceCard({ 行, meta }: { 行: 空态占位行; meta: Partial<Board3Meta> }) {
  return (
    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="mb-1 flex items-center gap-2">
        <Package className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <h3 className="text-sm font-semibold text-foreground">样本不足 · 无可用记录</h3>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {行.说明}（统计周期 {行.统计周期}）
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="原始切片数" value={num(meta.原始切片数 ?? 行.原始切片数)} />
        <StatCard label="原始条件组数" value={num(meta.原始条件组数)} />
        <StatCard label="板块一供给人数" value={num(meta.板块一供给人数)} hint="人" />
        <StatCard
          label="过滤前Σ计划出勤"
          value={num(meta.过滤前Σ计划出勤人次)}
          hint="人次"
          title="断言 A5b：应等于板块一同名指标"
        />
      </div>
    </div>
  );
}

/** meta 留痕折叠区：口径可追溯，默认收起。 */
function MetaTrace({ meta }: { meta: Partial<Board3Meta> }) {
  const 项 = [
    ['原始切片数', num(meta.原始切片数)],
    ['原始条件组数', num(meta.原始条件组数)],
    ['过滤后切片数', num(meta.过滤后切片数)],
    ['过滤后条件组数', num(meta.过滤后条件组数)],
    ['最终行数', num(meta.最终行数)],
    ['EB先验（全仓池化出勤率）', pct(meta.EB先验_全仓池化出勤率, 2)],
    ['过滤前Σ计划出勤人次', num(meta.过滤前Σ计划出勤人次)],
    ['过滤前Σ出勤人次', num(meta.过滤前Σ出勤人次)],
    ['过滤前Σ考勤异常人次', num(meta.过滤前Σ考勤异常人次)],
    ['板块一供给人数', num(meta.板块一供给人数)],
  ];
  return (
    <details className="rounded-xl border border-black/5 bg-black/[0.02] px-3 py-2 dark:border-white/5 dark:bg-white/[0.02]">
      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
        口径留痕（过滤前后对账 · {项.length} 项）
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {项.map(([名, 值]) => (
          <div key={名} className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{名}</span>
            <span className="text-[11px] font-medium tabular-nums text-foreground">{值}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        最终行数 = 过滤后切片数 × 3 个需求量桶；桶为复制而非分组统计，故本页按桶单选只渲染其一。
        统计完成后已剔除「置信度=极低」记录（含 ④基准档）。
      </p>
    </details>
  );
}

export function SupplierPortraitDashboard() {
  const [doc, setDoc] = useState<采购文档>(兜底文档);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [仓, set仓] = useState('');
  const [周期, set周期] = useState('');
  const [桶, set桶] = useState('');
  // 指标维度筛选：默认「所有维度」铺全部 8 张图，选单一维度时每个条件组只出该维度一张图。
  const [维度, set维度] = useState(维度全选);
  // 刷新按钮除重读 JSON 外，还请求重跑看板分析（重跑权收敛到此按钮）。
  const requestPoDashboardRefresh = usePoDashboardAnalysisStore((s) => s.requestRefresh);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await readTextFile(PURCHASE_FILE_PATH);
      if (!res.ok) {
        // 文件不存在 = 尚未预置/未跑 gen，用 bundle 兜底，不作为错误展示。
        if (res.error !== 'notFound') setError(`读取失败：${res.error ?? '未知错误'}`);
        setDoc(兜底文档);
        return;
      }
      setDoc(parsePurchase(res.content ?? '', 兜底文档));
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

  /* ---------- 筛选项（缺省回落到首项，避免空选） ---------- */

  const 周期选项 = doc.周期档;
  const 生效周期 = 周期选项.includes(周期) ? 周期 : (周期选项[0] ?? '');
  const 仓选项 = doc.物流仓;
  const 生效仓 = 仓选项.includes(仓) ? 仓 : (仓选项[0] ?? '');

  /** 切片直取：前端不做任何二次聚合。 */
  const 当前切片 = useMemo<切片 | undefined>(
    () => doc.切片[`${生效周期}|${生效仓}`],
    [doc, 生效周期, 生效仓],
  );

  const 正常行 = useMemo(
    () =>
      (当前切片?.rows ?? []).filter(
        (r): r is Board3PurchaseByConditionRow => !是占位行(r),
      ),
    [当前切片],
  );

  const 占位行 = useMemo(
    () => (当前切片?.rows ?? []).find((r): r is 空态占位行 => 是占位行(r)),
    [当前切片],
  );

  // 桶选项按下限升序，保证「0~20 / 20~100 / 100~9999」稳定顺序。
  const 桶选项 = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of 正常行) m.set(桶键(r), r.需求量下限 ?? 0);
    return Array.from(m.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
  }, [正常行]);

  // 默认桶 = 20~100（口径主桶）；该桶缺失时回落首项。
  const 生效桶 = 桶选项.includes(桶) ? 桶 : (桶选项.find((k) => k === '20~100') ?? 桶选项[0] ?? '');

  /** 按条件组分组渲染；组内按样本人数降序，采购优先看高置信记录。 */
  const 条件组列表 = useMemo(() => {
    const map = new Map<string, Board3PurchaseByConditionRow[]>();
    for (const r of 正常行) {
      if (桶键(r) !== 生效桶) continue;
      const k = 条件组键(r);
      const list = map.get(k) ?? [];
      list.push(r);
      map.set(k, list);
    }
    return Array.from(map.entries()).map(([组名, 行组]) => ({
      组名,
      行组: [...行组].sort((a, b) => (b.样本人数 ?? 0) - (a.样本人数 ?? 0)),
    }));
  }, [正常行, 生效桶]);

  const 可见行数 = 条件组列表.reduce((s, g) => s + g.行组.length, 0);

  /* ---------- 筛选上下文上报（供 agent 分析会话拼提示词） ---------- */

  const setBoardContext = usePoDashboardAnalysisStore((s) => s.setBoardContext);

  const 看板上下文 = useMemo(
    () =>
      [
        `周期档：${生效周期 || '无'}`,
        `物流仓：${生效仓 || '无'}`,
        `需求量桶：${生效桶 || '无'}`,
        `指标维度：${维度 === 维度全选 ? '所有维度' : 维度}`,
        `可见条件组：${条件组列表.length} 组 / ${可见行数} 条供应商记录`,
      ].join('；'),
    [生效周期, 生效仓, 生效桶, 维度, 条件组列表.length, 可见行数],
  );

  // mount 后立即上报一次：boardContexts 非持久化，刷新页面后为 null。
  useEffect(() => {
    setBoardContext('portrait', 看板上下文);
  }, [看板上下文, setBoardContext]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部：三个单选筛选器 + 刷新 */}
      <div className="shrink-0 border-b border-black/5 px-4 py-3 dark:border-white/5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            采购下单看板
          </h2>
          <button
            type="button"
            onClick={() => {
              requestPoDashboardRefresh('portrait');
              void load();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PickOne
            icon={<Warehouse className="h-3.5 w-3.5 text-muted-foreground" />}
            label="物流仓"
            options={仓选项.map((w) => ({ value: w, text: w }))}
            value={生效仓}
            onPick={set仓}
          />
          <PickOne
            icon={<Layers className="h-3.5 w-3.5 text-muted-foreground" />}
            label="周期档"
            options={周期选项.map((p) => ({ value: p, text: p }))}
            value={生效周期}
            onPick={set周期}
          />
          <PickOne
            icon={<Package className="h-3.5 w-3.5 text-muted-foreground" />}
            label="需求量桶"
            options={桶选项.map((k) => ({ value: k, text: `需求量 ${k}` }))}
            value={生效桶}
            onPick={set桶}
          />
          <PickOne
            icon={<BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />}
            label="指标维度"
            options={[
              { value: 维度全选, text: 维度全选 },
              ...指标清单.map((m) => ({ value: m.名, text: m.名 })),
            ]}
            value={维度}
            onPick={set维度}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {doc.版本 && `${doc.版本} · `}
          {条件组列表.length} 个条件组 · {可见行数} 条供应商记录
          {doc.兜底 && ' · 内置兜底数据'}
        </p>
      </div>

      {/* 主体 */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {!当前切片 && !error && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
            <Warehouse className="h-8 w-8 opacity-40" />
            <p className="text-sm">暂无该周期 / 物流仓的切片数据</p>
            <p className="text-[11px]">切片由 `pnpm gen:v6` 从 TS 真源派生，重跑后点右上角刷新载入。</p>
          </div>
        )}

        {占位行 && <EmptySliceCard 行={占位行} meta={当前切片?.meta ?? {}} />}

        {条件组列表.map(({ 组名, 行组 }) => (
          <条件组图表框 key={组名} 组名={组名} 行组={行组} 维度={维度} />
        ))}

        {当前切片 && <MetaTrace meta={当前切片.meta ?? {}} />}
      </div>
    </div>
  );
}

export default SupplierPortraitDashboard;