/**
 * V6 看板真源转发层
 *
 * 唯一真源数据：`ClawX/src/data/v6/*.json`（9 个产物，由 `scripts/v6/export_app_json.py` 离线生成）
 * 本文件只做「类型标注 + 转发 import + 前端聚合器」，不写业务数据。
 *
 * 刷新数据：`python3 scripts/v6/export_app_json.py` 重跑即可，本文件无需改动。
 *
 * ★ 事实表为三段式，每段内部 Σ 安全：
 *   - fact     月×仓×供应商×条件组 → 可加度量（工时/人次/异常人次）
 *   - wh       月×仓               → 仓月级度量（全体人日/异常处理进度分子分母）
 *   - turnover 月×仓×供应商        → 窗口内离职人数(可Σ) / 期末在职人数(不可Σ)
 *
 * ★ 人头类指标（供给人数/出勤人数/考勤异常人数）必须从人头附表按「周期档」取，
 *   禁止跨月或跨条件组求和（同一员工会被重复计数）。
 *
 * ★ 峰值（历史最大供给量）必须从 peak_supply 按「仓×供应商」取，
 *   禁止对条件组行 reduce 求和。
 */
import factRaw from './v6/fact_monthly.json';
import hcWhRaw from './v6/headcount_wh.json';
import hcWhSupRaw from './v6/headcount_wh_sup.json';
import hcCondRaw from './v6/headcount_cond.json';
import peakRaw from './v6/peak_supply.json';
import crossFixRaw from './v6/cross_wh_fix.json';
import board3Raw from './v6/board3_slices.json';
import board4Raw from './v6/board4_onboarding.json';
import metaRaw from './v6/meta.json';
import goldenRaw from './v6/golden_sample.json';

import type {
  FactMonthlyRow,
  WhMonthlyRow,
  TurnoverMonthlyRow,
  HeadcountRow,
  PeakSupplyRow,
  CrossWhFixRow,
  Board1RegionOverall,
  Board2RegionBySupplierRow,
  Board3PurchaseByConditionRow,
  Board4OnboardingMainRow,
  Board4OnboardingDetailRow,
  MetricDictRow,
  Warehouse,
} from './v6/schema';

/* ========================= 真源转发 ========================= */

/** 月桶事实表（三段式） */
export const 月桶事实表 = factRaw as unknown as {
  fact: FactMonthlyRow[];
  wh: WhMonthlyRow[];
  turnover: TurnoverMonthlyRow[];
};

/** 人头附表 L1：周期档 × 仓 */
export const 人头附表_仓 = hcWhRaw as unknown as HeadcountRow[];
/** 人头附表 L2：周期档 × 仓 × 供应商 */
export const 人头附表_仓供应商 = hcWhSupRaw as unknown as HeadcountRow[];
/** 人头附表 L3：周期档 × 仓 × 供应商 × 条件组 */
export const 人头附表_条件组 = hcCondRaw as unknown as HeadcountRow[];

/** 峰值附表：仓 × 供应商 */
export const 峰值附表 = peakRaw as unknown as PeakSupplyRow[];

/**
 * 稀疏跨仓修正表：仅含「同一周期档内跨 ≥2 仓」的用户行。
 * 多仓聚合时用于人头去重：精确 = Σ各仓 − Σ(命中仓数 − 1)。
 */
export const 跨仓修正表 = crossFixRaw as unknown as CrossWhFixRow[];

/** 板块三预生成切片矩阵（周期|仓 → rows + meta） */
export const 板块三切片 = board3Raw as unknown as {
  slices: Record<string, { rows: Board3PurchaseByConditionRow[]; meta: Record<string, unknown> }>;
  periods: string[];
  warehouses: Warehouse[];
};

/** 板块四入职台账（全量，不按周期过滤） */
export const 板块四台账 = board4Raw as unknown as {
  main: Board4OnboardingMainRow[];
  detail: Board4OnboardingDetailRow[];
};

/** 元信息：周期档 / 仓列表 / 口径字典 / 占位字段 */
export const V6元信息 = metaRaw as unknown as {
  periods: { name: string; start: string; end: string }[];
  warehouses: Warehouse[];
  metrics: MetricDictRow[];
  placeholders: string[];
  generated_at: string;
  version: string;
  口径说明: string;
  /** 签约主数据（仓 → 已归一供应商名）；合成源提供，真实源缺失时为空。供静默供应商派生。 */
  contracted?: Record<string, string[]>;
};

/** 黄金样本（P2 对账闸门用，6 组场景） */
export const 黄金样本 = goldenRaw as unknown as Record<
  string,
  { board1: Board1RegionOverall; board2: Board2RegionBySupplierRow[] }
>;

/* ========================= 仓库层级表 ========================= */

/** 物流仓行政层级项（洲际 → 片区 → 物流仓）。 */
export interface 仓库层级项 {
  洲际: string;
  片区: string;
  /** 看板展示名。 */
  物流仓: string;
  /** 真源 JSON 中的仓名；V6 已统一，故恒等于 `物流仓`（保留字段仅为兼容层级表接口）。 */
  真源物流仓: string;
}

/** 未登记层级的仓在筛选器里的归属标签。 */
export const 未分区标签 = '未分区';

/**
 * 供给满足率常量：业务方指定恒为 100%（非实算）。
 *
 * ★与 `scripts/v6/common.py::supply_rate_of()` 同源；计划需求台账接入后应改为实算，
 *   届时 Python 与本常量须同步下线，否则黄金样本对账会立即暴露差异。
 */
export const 供给满足率常量 = 1.0;

/**
 * 供给时效常量（天）：业务方指定。
 *
 * ★与 `scripts/v6/common.py::SUPPLY_LEAD_REGION_CONST / SUPPLY_LEAD_BY_BUCKET` 同源。
 *   板块一/二（区域健康）固定 14 天；板块三按需求量桶取值、板块四按入职总人数套用同一分桶。
 *   需求台账接入后应改为实算，届时 Python 与本常量须同步下线。
 */
export const 供给时效区域常量 = 14;
export const 供给时效单位 = '天';
export const 供给时效分桶: ReadonlyArray<readonly [number, number, number]> = [
  [0, 20, 7],
  [20, 100, 14],
  [100, 9999, 30],
];

/** 按数量（需求量上限 / 入职总人数）套用供给时效分桶，与 Python `supply_lead_of()` 同源。 */
export function 供给时效映射(n: number | null | undefined): number | null {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  for (const [, hi, days] of 供给时效分桶) {
    if (v <= hi) return days;
  }
  return 供给时效分桶[供给时效分桶.length - 1][2];
}

/**
 * 物流仓层级映射表（迪拜 6 仓全量）。
 *
 * ★ V6 的 `DUBAI_WAREHOUSES` 已是「阿联酋迪拜…」全名（与 v5 的「迪拜定制8号仓」不同），
 *   故 `真源物流仓 === 物流仓`。新增仓时在此追加一行；未登记的仓归入「未分区」，不丢数据。
 */
export const 仓库层级表: 仓库层级项[] = [
  { 洲际: '中东区', 片区: '阿联酋区', 物流仓: '阿联酋迪拜定制8号仓', 真源物流仓: '阿联酋迪拜定制8号仓' },
  { 洲际: '中东区', 片区: '阿联酋区', 物流仓: '阿联酋迪拜中小件5号仓', 真源物流仓: '阿联酋迪拜中小件5号仓' },
  { 洲际: '中东区', 片区: '阿联酋区', 物流仓: '阿联酋迪拜定制3号仓', 真源物流仓: '阿联酋迪拜定制3号仓' },
  { 洲际: '中东区', 片区: '阿联酋区', 物流仓: '阿联酋迪拜中小件2号仓', 真源物流仓: '阿联酋迪拜中小件2号仓' },
  { 洲际: '中东区', 片区: '阿联酋区', 物流仓: '阿联酋迪拜定制6号仓', 真源物流仓: '阿联酋迪拜定制6号仓' },
  { 洲际: '中东区', 片区: '阿联酋区', 物流仓: '阿联酋迪拜大件1号仓', 真源物流仓: '阿联酋迪拜大件1号仓' },
];

/* ========================= 可注入数据源 ========================= */

/**
 * 区域健康看板（板块一/二）所需的全部原子量。
 *
 * ★ 设计意图：聚合器不再闭包读模块级常量，而是接受数据源注入，使得
 *   - Node 侧（gen 脚本 / 对账脚本）缺省走 `默认区域原子量`（即 bundle 内的真源 JSON）；
 *   - 前端侧运行时 `readTextFile('~/.openclaw/workspace-po/区域健康原子量.json')` 后注入，
 *     从而支持「仓任意多选 × 任意月区间」的实时重算，且重跑 gen 即可刷新数据。
 */
export interface 区域原子量 {
  fact: FactMonthlyRow[];
  wh: WhMonthlyRow[];
  turnover: TurnoverMonthlyRow[];
  /** 人头附表 L1：周期档 × 仓 */
  hcWh: HeadcountRow[];
  /** 人头附表 L2：周期档 × 仓 × 供应商 */
  hcWhSup: HeadcountRow[];
  peak: PeakSupplyRow[];
  crossFix: CrossWhFixRow[];
  /** 签约主数据（仓 → 已归一供应商名）；供静默供应商派生。真实源缺失时为空对象。 */
  contracted: Record<string, string[]>;
}

/** 缺省数据源：直接取 bundle 内的真源转发常量（向后兼容 gen / 对账脚本）。 */
export const 默认区域原子量: 区域原子量 = {
  fact: 月桶事实表.fact,
  wh: 月桶事实表.wh,
  turnover: 月桶事实表.turnover,
  hcWh: 人头附表_仓,
  hcWhSup: 人头附表_仓供应商,
  peak: 峰值附表,
  crossFix: 跨仓修正表,
  contracted: V6元信息.contracted ?? {},
};

/* ========================= 聚合工具 ========================= */

/** 比率计算：分母为 0 或非法 → null（对齐 Python `safe_div` 口径）。 */
export function 比率(分子: number, 分母: number): number | null {
  if (!Number.isFinite(分子) || !Number.isFinite(分母) || 分母 === 0) return null;
  return 分子 / 分母;
}

/** 数值求和（跳过 null/NaN）。 */
function Σ(值: (number | null | undefined)[]): number {
  return 值.reduce<number>((s, v) => s + (Number.isFinite(v as number) ? (v as number) : 0), 0);
}

/** 月份是否落在 [起, 止] 闭区间内（YYYY-MM 字符串比较即可）。 */
function 月份在区间(月份: string, 起: string, 止: string): boolean {
  return 月份 >= 起 && 月份 <= 止;
}

/** 周期选择：预设档用 `周期档` 直查人头附表；自定义区间需标「近似值」。 */
export interface 周期选择 {
  /** 预设档名（'全周期' / '2026-08'）；自定义区间时为 null。 */
  周期档: string | null;
  /** 起始月 YYYY-MM。 */
  起: string;
  /** 结束月 YYYY-MM。 */
  止: string;
}

/** 聚合结果附带的数据品质标记。 */
export interface 聚合品质 {
  /** 人头类指标是否为近似值（自定义区间或跨仓合并时为 true）。 */
  人头近似: boolean;
  /** 峰值是否为上界近似（跨仓合并时为 true）。 */
  峰值近似: boolean;
}

/** 供应商份额明细项（所有活跃供应商，不论是否头部）。 */
export interface 供应商份额项 {
  供应商: string;
  供给人数: number;
  占比: number;
}

/** 板块一聚合结果（区域健康 - 全体维度）。 */
export interface 板块一聚合 extends 聚合品质 {
  考勤工时: number;
  /** Σ wh.全体考勤工时，含正式工/非三方；与「考勤工时」(三方口径) 对仗。 */
  全体考勤工时: number;
  加班工时: number;
  加班工时占比: number | null;
  计划出勤人次: number;
  出勤人次: number;
  出勤人数: number | null;
  出勤率: number | null;
  考勤异常人次: number;
  考勤异常人数: number | null;
  考勤异常率: number | null;
  异常明细: Record<string, number>;
  异常处理进度: number | null;
  异常已处理人日: number;
  异常待处理基数: number;
  离职率: number | null;
  窗口内离职人数: number;
  期末在职人数: number | null;
  供给人数: number | null;
  三方员工占比: number | null;
  全体出勤人数: number | null;
  活跃供应商数量: number;
  活跃供应商名单: string[];
  CR3集中度: number | null;
  最大单家供给占比: number | null;
  头部供应商数量: number;
  头部供应商名单: string[];
  头部供应商占比: number | null;
  头部供应商阈值: number;
  /** 全体活跃供应商的份额明细（降序）；Python 侧无此字段，对账跳过。 */
  供应商份额: 供应商份额项[];
  覆盖物流仓: string[];
  统计周期: string;
  数据状态: string;
  /** 业务方指定常量 100%（非实算），与 Python `supply_rate_of()` 同源。 */
  供给满足率: number | null;
  /** 业务方指定常量 14 天（非实算），与 Python `SUPPLY_LEAD_REGION_CONST` 同源。 */
  供给时效: number | null;
  静默供应商数量: number | null;
  静默供应商名单: string[];
}

/** 板块二聚合结果（区域健康 - by 供应商）。 */
export interface 板块二聚合行 {
  供应商: string;
  供给人数: number | null;
  供给占比: number | null;
  出勤人数: number | null;
  出勤率: number | null;
  计划出勤人次: number;
  出勤人次: number;
  考勤异常人次: number;
  考勤异常人数: number | null;
  考勤异常率: number | null;
  考勤工时: number;
  加班工时: number;
  加班工时占比: number | null;
  异常处理进度: number | null;
  异常已处理人日: number;
  异常待处理基数: number;
  离职率: number | null;
  窗口内离职人数: number;
  期末在职人数: number | null;
  历史最大供给量: number;
  是否头部: boolean;
  覆盖物流仓: string[];
  /** 业务方指定常量 100%（非实算），与 Python `supply_rate_of()` 同源。 */
  供给满足率: number | null;
  /** 业务方指定常量 14 天（非实算），与 Python `SUPPLY_LEAD_REGION_CONST` 同源。 */
  供给时效: number | null;
}

/** 头部供应商阈值（供给占比 ≥ 50%），与 `common.py HEAD_THRESHOLD` 一致。 */
export const 头部供应商阈值 = 0.5;

/** 按周期 + 仓筛选事实表三段。 */
function 筛选事实(
  周期: 周期选择,
  仓: string[],
  源: 区域原子量 = 默认区域原子量,
): {
  fact: FactMonthlyRow[];
  wh: WhMonthlyRow[];
  turnover: TurnoverMonthlyRow[];
  末月: string;
} {
  const 仓集 = new Set(仓);
  const 命中仓 = (行仓: string) => 仓.length === 0 || 仓集.has(行仓);
  const fact = 源.fact.filter(
    (r) => 月份在区间(r.月份, 周期.起, 周期.止) && 命中仓(r.物流仓),
  );
  const wh = 源.wh.filter(
    (r) => 月份在区间(r.月份, 周期.起, 周期.止) && 命中仓(r.物流仓),
  );
  const turnover = 源.turnover.filter(
    (r) => 月份在区间(r.月份, 周期.起, 周期.止) && 命中仓(r.物流仓),
  );
  // 期末在职人数只取末月（★不可跨月 Σ）
  const 末月 = turnover.reduce((m, r) => (r.月份 > m ? r.月份 : m), '');
  return { fact, wh, turnover, 末月 };
}

/**
 * 跨仓去重修正量：对选中周期档 + 选中仓集合，
 * 统计每个跨仓用户在选中仓内各指标命中次数 n，重复计数为 (n−1)。
 * 单仓或空选时无重复，返回全 0（快路径）。
 */
function 跨仓修正量(
  周期档: string,
  仓: string[],
  源: 区域原子量 = 默认区域原子量,
): {
  供给人数: number;
  出勤人数: number;
  考勤异常人数: number;
  全体出勤人数: number;
} {
  const 零 = { 供给人数: 0, 出勤人数: 0, 考勤异常人数: 0, 全体出勤人数: 0 };
  if (仓.length === 1) return 零; // 单仓天然无跨仓重复
  const 仓集 = new Set(仓);
  const 命中 = 源.crossFix.filter(
    (r) => r.周期档 === 周期档 && (仓.length === 0 || 仓集.has(r.物流仓)),
  );
  if (命中.length === 0) return 零;
  // 用户 → 各指标在选中仓内的命中次数
  const 计数 = new Map<string, [number, number, number, number]>();
  for (const r of 命中) {
    const c = 计数.get(r.用户编码) ?? [0, 0, 0, 0];
    c[0] += r.供给;
    c[1] += r.出勤;
    c[2] += r.异常;
    c[3] += r.全体出勤;
    计数.set(r.用户编码, c);
  }
  const 修正 = { ...零 };
  for (const c of 计数.values()) {
    修正.供给人数 += Math.max(0, c[0] - 1);
    修正.出勤人数 += Math.max(0, c[1] - 1);
    修正.考勤异常人数 += Math.max(0, c[2] - 1);
    修正.全体出勤人数 += Math.max(0, c[3] - 1);
  }
  return 修正;
}

/**
 * 跨仓去重修正量（按供应商拆分）：供板块二 L2 人头去重。
 * 同一用户若在两仓归属不同供应商，则各供应商各计 1 次、无重复，天然不修正。
 */
function 跨仓修正量_按供应商(
  周期档: string,
  仓: string[],
  源: 区域原子量 = 默认区域原子量,
): Map<
  string,
  { 供给: number; 出勤: number; 异常: number }
> {
  const 结果 = new Map<string, { 供给: number; 出勤: number; 异常: number }>();
  if (仓.length === 1) return 结果; // 单仓快路径
  const 仓集 = new Set(仓);
  const 计数 = new Map<string, [number, number, number]>();
  for (const r of 源.crossFix) {
    if (r.周期档 !== 周期档) continue;
    if (仓.length !== 0 && !仓集.has(r.物流仓)) continue;
    if (!r.供应商) continue; // 非三方不参与 L2
    const key = `${r.供应商}\u0000${r.用户编码}`;
    const c = 计数.get(key) ?? [0, 0, 0];
    c[0] += r.供给;
    c[1] += r.出勤;
    c[2] += r.异常;
    计数.set(key, c);
  }
  for (const [key, c] of 计数) {
    const sup = key.split('\u0000')[0];
    const cur = 结果.get(sup) ?? { 供给: 0, 出勤: 0, 异常: 0 };
    cur.供给 += Math.max(0, c[0] - 1);
    cur.出勤 += Math.max(0, c[1] - 1);
    cur.异常 += Math.max(0, c[2] - 1);
    结果.set(sup, cur);
  }
  return 结果;
}

/** 从人头附表按周期档取人头数；自定义区间返回 null（前端标「近似值」）。 */
function 取人头(
  周期: 周期选择,
  仓: string[],
  源: 区域原子量 = 默认区域原子量,
): {
  供给人数: number | null;
  出勤人数: number | null;
  考勤异常人数: number | null;
  全体出勤人数: number | null;
} {
  if (!周期.周期档) {
    return { 供给人数: null, 出勤人数: null, 考勤异常人数: null, 全体出勤人数: null };
  }
  const 仓集 = new Set(仓);
  const 命中 = 源.hcWh.filter(
    (r) => r.周期档 === 周期.周期档 && (仓.length === 0 || 仓集.has(r.物流仓)),
  );
  if (命中.length === 0) {
    return { 供给人数: 0, 出勤人数: 0, 考勤异常人数: 0, 全体出勤人数: 0 };
  }
  // 单仓 → 精确值；跨仓 → Σ各仓 − 跨仓修正（同一员工可能在多仓出现）
  const 修正 = 跨仓修正量(周期.周期档, 仓, 源);
  return {
    供给人数: Σ(命中.map((r) => r.供给人数)) - 修正.供给人数,
    出勤人数: Σ(命中.map((r) => r.出勤人数)) - 修正.出勤人数,
    考勤异常人数: Σ(命中.map((r) => r.考勤异常人数)) - 修正.考勤异常人数,
    全体出勤人数: Σ(命中.map((r) => r.全体出勤人数)) - 修正.全体出勤人数,
  };
}

/**
 * 聚合板块一（区域健康 - 全体维度）。
 *
 * 所有比率一律 `Σ分子 / Σ分母` 精确重算，禁止加权均值近似。
 */
export function 聚合板块一(
  周期: 周期选择,
  仓: string[],
  源: 区域原子量 = 默认区域原子量,
): 板块一聚合 {
  const { fact, wh, turnover, 末月 } = 筛选事实(周期, 仓, 源);
  const 人头 = 取人头(周期, 仓, 源);

  const 考勤工时 = Σ(fact.map((r) => r.考勤工时));
  const 全体考勤工时 = Σ(wh.map((r) => r.全体考勤工时));
  const 加班工时 = Σ(fact.map((r) => r.加班工时));
  const 计划出勤人次 = Σ(fact.map((r) => r.计划出勤人次));
  const 出勤人次 = Σ(fact.map((r) => r.出勤人次));
  const 考勤异常人次 = Σ(fact.map((r) => r.考勤异常人次));

  // 异常明细：动态列 异常明细_<类型> 汇总
  const 异常明细: Record<string, number> = {};
  for (const 行 of fact) {
    for (const [k, v] of Object.entries(行)) {
      if (k.startsWith('异常明细_') && typeof v === 'number') {
        const 类型 = k.slice('异常明细_'.length);
        异常明细[类型] = (异常明细[类型] ?? 0) + v;
      }
    }
  }

  const 异常已处理人日 = Σ(wh.map((r) => r.异常已处理人日));
  const 异常待处理基数 = Σ(wh.map((r) => r.异常待处理基数));

  // 离职率期末法：Σ离职 / (末月期末在职 + Σ离职)
  const 窗口内离职人数 = Σ(turnover.map((r) => r.窗口内离职人数));
  const 期末在职人数 = 末月
    ? Σ(turnover.filter((r) => r.月份 === 末月).map((r) => r.期末在职人数))
    : null;
  const 离职率 =
    期末在职人数 === null ? null : 比率(窗口内离职人数, 期末在职人数 + 窗口内离职人数);

  // 供应商结构：按供给人数排序算 CR3 / 头部
  const 供应商人头 = new Map<string, number>();
  if (周期.周期档) {
    const 仓集 = new Set(仓);
    for (const r of 源.hcWhSup) {
      if (r.周期档 !== 周期.周期档) continue;
      if (仓.length > 0 && !仓集.has(r.物流仓)) continue;
      const sup = r.供应商 ?? '';
      供应商人头.set(sup, (供应商人头.get(sup) ?? 0) + r.供给人数);
    }
    // 跨仓去重：同一员工在多仓同供应商下只应计 1 次（与 Python groupby(_sup).nunique() 对齐）
    for (const [sup, fix] of 跨仓修正量_按供应商(周期.周期档, 仓, 源)) {
      if (!供应商人头.has(sup)) continue;
      供应商人头.set(sup, 供应商人头.get(sup)! - fix.供给);
    }
  }
  const 总供给 = 人头.供给人数 ?? Σ([...供应商人头.values()]);
  const 排序供应商 = [...供应商人头.entries()].sort((a, b) => b[1] - a[1]);
  const 占比列表= 排序供应商.map(([sup, n]) => ({ sup, share: 总供给 > 0 ? n / 总供给 : 0 }));

  // ★静默供应商派生：签约主数据（覆盖仓签约名单并集）− 活跃名单（有供给者）。
  //   与 Python board1.py 同源：cover_whs = 仓 非空取仓，否则全部签约仓；无签约主数据源时回退 null。
  const 覆盖仓 = 仓.length > 0 ? 仓 : Object.keys(源.contracted ?? {});
  const 签约集 = new Set<string>();
  for (const w of 覆盖仓) for (const s of 源.contracted?.[w] ?? []) 签约集.add(s);
  const 活跃集 = new Set(排序供应商.map(([sup]) => sup));
  const 有签约 = 签约集.size > 0;
  const 静默名单 = 有签约 ? [...签约集].filter((s) => !活跃集.has(s)).sort() : [];
  const 静默数量 = 有签约 ? 静默名单.length : null;

  return {
    考勤工时: Number(考勤工时.toFixed(2)),
    全体考勤工时: Number(全体考勤工时.toFixed(2)),
    加班工时: Number(加班工时.toFixed(2)),
    加班工时占比: 比率(加班工时, 考勤工时),
    计划出勤人次,
    出勤人次,
    出勤人数: 人头.出勤人数,
    出勤率: 比率(出勤人次, 计划出勤人次),
    考勤异常人次,
    考勤异常人数: 人头.考勤异常人数,
    考勤异常率: 比率(考勤异常人次, 计划出勤人次),
    异常明细,
    异常处理进度: 比率(异常已处理人日, 异常待处理基数),
    异常已处理人日,
    异常待处理基数,
    离职率,
    窗口内离职人数,
    期末在职人数,
    供给人数: 人头.供给人数,
    三方员工占比:
      人头.出勤人数 !== null && 人头.全体出勤人数 !== null
        ? 比率(人头.出勤人数, 人头.全体出勤人数)
        : null,
    全体出勤人数: 人头.全体出勤人数,
    活跃供应商数量: 排序供应商.length,
    活跃供应商名单: 排序供应商.map(([sup]) => sup),
    CR3集中度: 占比列表.length ? Σ(占比列表.slice(0, 3).map((x) => x.share)) : null,
    最大单家供给占比: 占比列表.length ? 占比列表[0].share : null,
    头部供应商数量: 占比列表.filter((x) => x.share >= 头部供应商阈值).length,
    头部供应商名单: 占比列表.filter((x) => x.share >= 头部供应商阈值).map((x) => x.sup),
    头部供应商占比: 比率(
      占比列表.filter((x) => x.share >= 头部供应商阈值).length,
      排序供应商.length,
    ),
    头部供应商阈值,
    供应商份额: 排序供应商.map(([sup, n]) => ({
      供应商: sup,
      供给人数: n,
      占比: 总供给 > 0 ? n / 总供给 : 0,
    })),
    覆盖物流仓: [...new Set(fact.map((r) => r.物流仓))].sort(),
    统计周期: `${周期.起}~${周期.止}`,
    数据状态:
      有签约
        ? '供给满足率=业务方指定100%；供给时效=业务方指定14天；静默供应商=签约主数据派生'
        : '供给满足率=业务方指定100%；供给时效=业务方指定14天；静默供应商=无数据源（签约主数据未接入）',
    供给满足率: 供给满足率常量,
    供给时效: 供给时效区域常量,
    静默供应商数量: 静默数量,
    静默供应商名单: 静默名单,
    人头近似: !周期.周期档,
    峰值近似: 仓.length !== 1,
  };
}

/**
 * 聚合板块二（区域健康 - by 供应商），默认按供给人数降序。
 *
 * 峰值从 `峰值附表` 按「仓×供应商」取值再 Σ（跨仓时为上界近似）。
 */
export function 聚合板块二(
  周期: 周期选择,
  仓: string[],
  源: 区域原子量 = 默认区域原子量,
): 板块二聚合行[] {
  const { fact, turnover, 末月 } = 筛选事实(周期, 仓, 源);
  const 仓集 = new Set(仓);
  const 命中仓 = (行仓: string) => 仓.length === 0 || 仓集.has(行仓);

  // 供应商 → 事实度量
  const 度量 = new Map<string, { 考勤工时: number; 加班工时: number; 计划: number; 出勤: number; 异常: number }>();
  for (const r of fact) {
    const cur = 度量.get(r.供应商) ?? { 考勤工时: 0, 加班工时: 0, 计划: 0, 出勤: 0, 异常: 0 };
    cur.考勤工时 += r.考勤工时;
    cur.加班工时 += r.加班工时;
    cur.计划 += r.计划出勤人次;
    cur.出勤 += r.出勤人次;
    cur.异常 += r.考勤异常人次;
    度量.set(r.供应商, cur);
  }

  // 供应商 → 人头（按周期档取，自定义区间为 null）；跨仓时扣减重复计数
  const 人头 = new Map<string, { 供给: number; 出勤: number; 异常: number }>();
  if (周期.周期档) {
    for (const r of 源.hcWhSup) {
      if (r.周期档 !== 周期.周期档 || !命中仓(r.物流仓)) continue;
      const sup = r.供应商 ?? '';
      const cur = 人头.get(sup) ?? { 供给: 0, 出勤: 0, 异常: 0 };
      cur.供给 += r.供给人数;
      cur.出勤 += r.出勤人数;
      cur.异常 += r.考勤异常人数;
      人头.set(sup, cur);
    }
    const 修正 = 跨仓修正量_按供应商(周期.周期档, 仓, 源);
    for (const [sup, fix] of 修正) {
      const cur = 人头.get(sup);
      if (!cur) continue;
      cur.供给 -= fix.供给;
      cur.出勤 -= fix.出勤;
      cur.异常 -= fix.异常;
    }
  }

  // 供应商 → 峰值（仓×供应商 Σ）
  const 峰值 = new Map<string, number>();
  for (const r of 源.peak) {
    if (!命中仓(r.物流仓)) continue;
    峰值.set(r.供应商, (峰值.get(r.供应商) ?? 0) + r.历史最大供给量);
  }

  // 供应商 → 离职(期末法) + 异常处理进度分子分母
  const 离职 = new Map<string, { 离职: number; 期末: number; 已处理: number; 基数: number }>();
  for (const r of turnover) {
    const cur = 离职.get(r.供应商) ?? { 离职: 0, 期末: 0, 已处理: 0, 基数: 0 };
    cur.离职 += r.窗口内离职人数;
    if (r.月份 === 末月) cur.期末 += r.期末在职人数;
    cur.已处理 += r.异常已处理人日;
    cur.基数 += r.异常待处理基数;
    离职.set(r.供应商, cur);
  }

  // 供应商 → 覆盖物流仓
  const 覆盖仓 = new Map<string, Set<string>>();
  for (const r of fact) {
    if (!覆盖仓.has(r.供应商)) 覆盖仓.set(r.供应商, new Set());
    覆盖仓.get(r.供应商)!.add(r.物流仓);
  }

  const 总供给 = Σ([...人头.values()].map((v) => v.供给));
  const 行 = [...度量.entries()].map(([供应商, m]) => {
    const h = 人头.get(供应商);
    const t = 离职.get(供应商);
    const 供给人数 = h ? h.供给 : null;
    const 供给占比 = 供给人数 !== null && 总供给 > 0 ? 供给人数 / 总供给 : null;
    return {
      供应商,
      供给人数,
      供给占比,
      出勤人数: h ? h.出勤 : null,
      出勤率: 比率(m.出勤, m.计划),
      计划出勤人次: m.计划,
      出勤人次: m.出勤,
      考勤异常人次: m.异常,
      考勤异常人数: h ? h.异常 : null,
      考勤异常率: 比率(m.异常, m.计划),
      考勤工时: Number(m.考勤工时.toFixed(2)),
      加班工时: Number(m.加班工时.toFixed(2)),
      加班工时占比: 比率(m.加班工时, m.考勤工时),
      异常处理进度: t ? 比率(t.已处理, t.基数) : null,
      异常已处理人日: t ? t.已处理 : 0,
      异常待处理基数: t ? t.基数 : 0,
      离职率: t ? 比率(t.离职, t.期末 + t.离职) : null,
      窗口内离职人数: t ? t.离职 : 0,
      期末在职人数: t ? t.期末 : null,
      历史最大供给量: 峰值.get(供应商) ?? 0,
      是否头部: (供给占比 ?? 0) >= 头部供应商阈值,
      覆盖物流仓: [...(覆盖仓.get(供应商) ?? [])].sort(),
      供给满足率: 供给满足率常量,
      供给时效: 供给时效区域常量,
    };
  });

  return 行.sort((a, b) => (b.供给人数 ?? 0) - (a.供给人数 ?? 0));
}