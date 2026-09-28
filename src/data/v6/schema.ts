/**
 * V6 供应商条件绩效画像表 · TSchema（TypeBox）定义
 * =====================================================================
 * 本文件字段与 `scripts/v6/*.py` 实际产出严格一一对应（扁平行结构），
 * 与 `data/v6/out/json/*.json` 可直接互校。
 *
 *   板块一 board1_region_overall_{周期}_{范围}.json        → Board1RegionOverall
 *   板块二 board2_region_by_supplier_{周期}_{范围}.json     → Board2RegionBySupplierRow[]
 *   板块三 board3_purchase_by_condition_{周期}_{仓}.json    → Board3PurchaseByConditionRow[]
 *   板块四 board4_onboarding_log_main.json                 → Board4OnboardingMainRow[]
 *          board4_onboarding_log_detail.json               → Board4OnboardingDetailRow[]
 *   口径表 metric_dict.json                                → MetricDictRow[]
 *
 *铁律：所有数字必须能从原始数据复算；无数据源的指标一律 null 且
 *       在 `数据状态` / 口径表 `数据状态=无数据-占位` 中标注，前端禁止显示为 0。
 *
 * 本期数据源状态：
 *   - 价卡 D4（data/v6/价卡/GJ-*.xlsx）→ 价格：★保守口径，仅 8 号仓（仓码 C0080000051）
 *     有映射，其余仓一律 null；8 号仓内不在价卡的供应商为行级 null。
 *   - 件效：业务方按仓指定常量（5 号仓与「未知」仓未给值 → null）。V6 废弃「人效」指标。
 *   - 供给满足率：业务方指定恒为 1.0（100%），非实算。
 *   - 供给时效（天）：★业务方指定，非实算。板块一/二固定 14 天；板块三按需求量桶
 *     （0-20→7 / 20-100→14 / 100以上→30）；板块四按「入职总人数」套用同一分桶。
 *   - 计划需求台账（未接入）→ 需求量下限/上限（板块三仅为分桶标签）。
 *   - 签约供应商主数据（未接入）→ 静默供应商数量、静默供应商名单恒为 null。
 *   - 用工需求台账（未接入）→ 板块四履约达成率恒为 null。
 */
import { Type, Static } from '@sinclair/typebox';

/* ========================= 公共构件 ========================= */

/** 无数据源占位：前端须显示「暂无数据」而非 0 */
export const PlaceholderNumber = Type.Union([Type.Number(), Type.Null()], {
  description: '无数据源时为 null，前端需显示"暂无数据"而非 0',
});

export const PlaceholderInteger = Type.Union([Type.Integer(), Type.Null()], {
  description: '无数据源时为 null',
});

/** 比率型（0~1）；分母为 0 时按 safe_div 约定返回 null */
export const RatioOrNull = Type.Union([
  Type.Number({ minimum: 0, maximum: 1 }),
  Type.Null(),
]);

/** 统计周期字符串，形如 `2026-08-01~2026-08-31` */
export const StatPeriod = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}~\\d{4}-\\d{2}-\\d{2}$',
  description: '统计周期，闭区间，格式 YYYY-MM-DD~YYYY-MM-DD',
});

/** 生成时间：run_all.py 写入每个 Sheet / JSON 的产出时刻 */
export const GenTime = Type.String({
  description: '产出时刻，格式 YYYY-MM-DD HH:mm:ss',
});

/** 物流仓枚举（EXCLUDE：土耳其伊斯坦布尔定制1号仓；解析不到时为「未知」） */
export const WarehouseSchema = Type.Union(
  [
    Type.Literal('阿联酋迪拜定制8号仓'),
    Type.Literal('阿联酋迪拜中小件5号仓'),
    Type.Literal('阿联酋迪拜定制3号仓'),
    Type.Literal('阿联酋迪拜中小件2号仓'),
    Type.Literal('阿联酋迪拜定制6号仓'),
    Type.Literal('阿联酋迪拜大件1号仓'),
    Type.Literal('未知'),
  ],
  { description: '由 D1 考勤明细 K 列「人资机构(全称)」取最后一个以「仓」结尾的层级解析' },
);

/** 用工性质：仅保留三方两类，其余（全日制/日结/正式工）不进入统计 */
export const EmploymentNatureSchema = Type.Union([
  Type.Literal('海外日常临时工'),
  Type.Literal('综合排班临时工'),
]);

/** 班次分类；D3 无班次字段时由 D1 按用户编码回挂众数，无考勤记录为「未知」 */
export const ShiftSchema = Type.Union([
  Type.Literal('白班'),
  Type.Literal('跨夜'),
  Type.Literal('中班'),
  Type.Literal('小夜'),
  Type.Literal('晚班'),
  Type.Literal('未知'),
]);

/** 技能等级（D3 H 列）；缺失为「未知」 */
export const SkillLevelSchema = Type.Union([
  Type.Literal('高'),
  Type.Literal('中'),
  Type.Literal('低'),
  Type.Literal('未知'),
]);

/** 兜底档级：n≥200 ①细 / 30–199 ②粗 / 10–29 ②粗+EB / <10 ④基准 */
export const GradeSchema = Type.Union(
  [
    Type.Literal('①细'),
    Type.Literal('②粗'),
    Type.Literal('②粗+EB'),
    Type.Literal('④基准'),
  ],
  { description: '按切片供给人数划分；②粗+EB 档需做经验贝叶斯收缩（k=30）' },
);

/** 置信度：Wilson 95% 区间宽度 <5pp 高 / 5–8pp 中 / >8pp 低；④基准档直接判极低 */
export const ConfidenceSchema = Type.Union([
  Type.Literal('高'),
  Type.Literal('中'),
  Type.Literal('低'),
  Type.Literal('极低'),
]);

/** 看板筛选器 */
export const FilterSchema = Type.Object({
  周期起: Type.String({ format: 'date' }),
  周期止: Type.String({ format: 'date' }),
  物流仓: Type.Array(WarehouseSchema, {
    description: '板块一/二/四多选（空数组或省略=全部仓）；板块三必须为单元素数组',
  }),
});

/** 数组/字典型字段在 Excel 中被拼接为字符串，JSON 中保留原结构 */
export const NameListSchema = Type.Union([
  Type.Array(Type.String()),
  Type.String({ description: 'Excel 形态：以「、」连接' }),
]);

export const AbnormalDetailSchema = Type.Union([
  Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  Type.String({ description: 'Excel 形态：迟到:3411 / 缺勤:2640 …' }),
]);

/* ================= 板块一 · 区域健康看板 - 全体维度 ================= */

export const Board1RegionOverallSchema = Type.Object(
  {
    /* —— 工时 —— */
    考勤工时: Type.Number({ minimum: 0, description: 'Σ最终核算时长(D1 AG列)，单位小时' }),
    加班工时: Type.Number({ minimum: 0, description: 'Σ加班工时总时长(D1 AA列)' }),
    加班工时占比: RatioOrNull,

    /* —— 出勤 —— */
    计划出勤人次: Type.Integer({ minimum: 0, description: '排班总时长>0 的人日数' }),
    出勤人次: Type.Integer({ minimum: 0, description: '最终核算时长>0 的人日数' }),
    出勤人数: Type.Integer({ minimum: 0, description: '出勤人次去重后的人头' }),
    出勤率: RatioOrNull,

    /* —— 异常 —— */
    考勤异常人次: Type.Integer({ minimum: 0, description: '异常类型 ∉ {空,正常} 的人日数' }),
    考勤异常人数: Type.Integer({ minimum: 0 }),
    考勤异常率: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
      description: '考勤异常人次 / 计划出勤人次，可能 >1 不封顶',
    }),
    异常明细: AbnormalDetailSchema,
    异常处理进度: RatioOrNull,
    异常已处理人日: Type.Integer({
      minimum: 0,
      description: 'D2 工时校准中状态∈{审批通过,审批中} 且为异常的人日',
    }),
    异常待处理基数: Type.Integer({
      minimum: 0,
      description: '★V6 收紧：限定三方员工且用户编码∈D1三方集合，与考勤异常人次同源',
    }),

    /* —— 流动 —— */
    离职率: RatioOrNull,
    窗口内离职人数: Type.Integer({ minimum: 0 }),
    期末在职人数: Type.Integer({ minimum: 0, description: '离职率分母 = 期末在职 + 窗口内离职' }),

    /* —— 供给 —— */
    供给人数: Type.Integer({ minimum: 0, description: '窗口内有考勤记录的三方员工去重人头' }),
    供给满足率: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定常量 1.0（100%），非实算',
    }),
    供给时效: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定常量 14（天），非实算',
    }),
    三方员工占比: RatioOrNull,
    全体出勤人数: Type.Integer({ minimum: 0, description: '含正式工，三方员工占比的分母' }),

    /* —— 市场结构 —— */
    活跃供应商数量: Type.Integer({ minimum: 0 }),
    活跃供应商名单: NameListSchema,
    静默供应商数量: PlaceholderInteger,
    静默供应商名单: NameListSchema,
    头部供应商数量: Type.Integer({ minimum: 0 }),
    头部供应商占比: Type.Number({ minimum: 0, maximum: 1, description: '头部家数占活跃家数' }),
    头部供应商名单: NameListSchema,
    头部供应商阈值: Type.Number({
      default: 0.5,
      description: '★已人工裁决=50%；单家供给占比≥该阈值即判为头部',
    }),
    CR3集中度: Type.Number({ minimum: 0, maximum: 1, description: '供给占比 Top3 之和' }),
    最大单家供给占比: Type.Number({ minimum: 0, maximum: 1 }),

    /* —— 元信息 —— */
    覆盖物流仓: NameListSchema,
    统计周期: StatPeriod,
    数据状态: Type.String({ description: '如：部分占位（需求台账/签约主数据未接入）' }),
    生成时间: Type.Optional(GenTime),
  },
  { $id: 'Board1RegionOverall', description: '板块一：整个筛选范围输出 1 行，多仓合并重算' },
);

/* ================ 板块二 · 区域健康看板 - by供应商 ================ */

export const Board2RegionBySupplierRowSchema = Type.Object(
  {
    供应商: Type.String({ description: '以 D1 一级供应商为准，已做多写法归一' }),
    覆盖物流仓: NameListSchema,
    出勤人数: Type.Integer({ minimum: 0 }),
    出勤率: RatioOrNull,
    计划出勤人次: Type.Integer({ minimum: 0 }),
    出勤人次: Type.Integer({ minimum: 0 }),
    考勤异常人次: Type.Integer({ minimum: 0 }),
    考勤异常人数: Type.Integer({ minimum: 0 }),
    考勤异常率: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    异常处理进度: RatioOrNull,
    离职率: RatioOrNull,
    窗口内离职人数: Type.Integer({ minimum: 0 }),
    期末在职人数: Type.Integer({ minimum: 0 }),
    供给人数: Type.Integer({ minimum: 0 }),
    供给满足率: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定常量 1.0（100%），非实算',
    }),
    供给时效: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定常量 14（天），非实算',
    }),
    供给占比: Type.Number({ minimum: 0, maximum: 1, description: 'Σ各家 = 1（断言 A4）' }),
    历史最大供给量: Type.Integer({
      minimum: 0,
      description: '★全历史日在职峰值，不受统计周期限制；各家峰值不同日，故 Σ 可大于整仓峰值',
    }),
    考勤工时: Type.Number({ minimum: 0 }),
    加班工时: Type.Number({ minimum: 0 }),
    统计周期: StatPeriod,
    数据状态: Type.String(),
    生成时间: Type.Optional(GenTime),
  },
  { $id: 'Board2RegionBySupplierRow', description: '板块二：一个供应商一行，多仓选中时跨仓聚合后重算' },
);

export const Board2RegionBySupplierSchema = Type.Array(Board2RegionBySupplierRowSchema);

/* =============== 板块三 · 采购下单看板 - by条件维度 =============== */

export const Board3PurchaseByConditionRowSchema = Type.Object(
  {
    /* —— 切片键：条件组 × 供应商 × 需求量桶 —— */
    物流仓: WarehouseSchema,
    工种: Type.String(),
    班次: ShiftSchema,
    用工性质: EmploymentNatureSchema,
    技能等级: SkillLevelSchema,
    档级: GradeSchema,
    供应商: Type.String(),

    /* —— 绩效指标 —— */
    出勤率: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()], {
      description: '②粗+EB 档为收缩后值：(率×n + k×先验)/(n+k)，k=30；其余档=原始值',
    }),
    出勤率_原始: RatioOrNull,
    考勤异常率: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    离职率: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()], {
      description: '下沉粒度=供应商×用工性质×技能等级（不下沉到班次/工种，承 V5 口径）',
    }),
    供给满足率: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定常量 1.0（100%），非实算',
    }),
    供给时效: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定-按需求量桶取值（0-20→7 / 20-100→14 / 100以上→30，单位天），非实算',
    }),
    价格: Type.Union([Type.Number(), Type.Null()], {
      description:
        'D4 价卡按 (供应商, 工种) 取总报价金额；仅 8 号仓有仓码映射，其余仓恒 null；' +
        '8 号仓内不在价卡的供应商为行级 null（此时同行「数据状态」仍显示「价格=价卡实值」）',
    }),
    价格单位: Type.Union([Type.String(), Type.Null()], {
      description: '价格字段的计价单位，承 V5 口径固定为 AED/人·小时；价格为 null 时可为 null',
    }),
    件效: Type.Union([Type.Number(), Type.Null()], {
      description:
        '单位工时产出件数（V6 起替代原「人效」）；业务方按仓给定常量，' +
        '5 号仓与「未知」仓未给值 → null',
    }),

    /* —— 样本量与统计留痕 —— */
    样本人数: Type.Integer({ minimum: 0, description: '切片内三方员工去重人头，决定档级' }),
    计划出勤人次: Type.Integer({ minimum: 0 }),
    出勤人次: Type.Integer({ minimum: 0 }),
    考勤异常人次: Type.Integer({ minimum: 0 }),
    窗口内离职人数: Type.Integer({ minimum: 0 }),
    期末在职人数: Type.Integer({ minimum: 0 }),
    考勤工时: Type.Number({ minimum: 0 }),
    加班工时: Type.Number({ minimum: 0 }),
    区间宽度pp: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
      description: 'Wilson 95% 区间宽度（百分点）：d=1+z²/n; h=z√(p(1-p)/n+z²/4n²)/d; width=2h×100',
    }),
    置信度: ConfidenceSchema,

    /* —— 需求量分桶（占位：订单量未接入，仅作展示分桶标签） —— */
    需求量下限: Type.Integer({ minimum: 0, description: '分桶 [0,20) / [20,100) / [100,9999)' }),
    需求量上限: Type.Integer({ minimum: 0 }),

    /* —— 元信息 —— */
    统计周期: StatPeriod,
    数据状态: Type.String(),
    生成时间: Type.Optional(GenTime),
  },
  {
    $id: 'Board3PurchaseByConditionRow',
    description:
      '板块三：物流仓【单选】；统计完成后剔除「置信度=极低」记录，再按 3 个需求量桶复制行',
  },
);

/** 样本不足占位行：该仓该周期过滤后无可用记录时产出，替代空表 */
export const Board3EmptyPlaceholderRowSchema = Type.Object({
  物流仓: WarehouseSchema,
  说明: Type.String({ default: '该仓本周期样本量不足，全部切片置信度为极低，按规则过滤后无可用记录' }),
  原始切片数: Type.Integer({ minimum: 0 }),
  统计周期: Type.String(),
  数据状态: Type.Literal('样本不足-无可用记录'),
  生成时间: Type.Optional(GenTime),
});

export const Board3PurchaseByConditionSchema = Type.Array(
  Type.Union([Board3PurchaseByConditionRowSchema, Board3EmptyPlaceholderRowSchema]),
);

/** 板块三过滤留痕（board3_meta_summary.json） */
export const Board3MetaSchema = Type.Object({
  统计周期: Type.String(),
  物流仓: WarehouseSchema,
  原始切片数: Type.Integer({ minimum: 0 }),
  原始条件组数: Type.Integer({ minimum: 0 }),
  EB先验_全仓池化出勤率: Type.Union([Type.Number(), Type.Null()], {
    description: '两级回落：优先 供应商×用工性质 池化率，缺失时回落本值（= 板块一出勤率，断言 A5c）',
  }),
  过滤前Σ计划出勤人次: Type.Integer({ minimum: 0, description: '断言 A5b：= 板块一同名指标' }),
  过滤前Σ出勤人次: Type.Integer({ minimum: 0 }),
  过滤前Σ考勤异常人次: Type.Integer({ minimum: 0 }),
  板块一供给人数: Type.Integer({ minimum: 0 }),
  过滤后切片数: Type.Integer({ minimum: 0 }),
  过滤后条件组数: Type.Integer({ minimum: 0 }),
  最终行数: Type.Integer({ minimum: 0, description: '= 过滤后切片数 × 3 个需求量桶' }),
});

/* ============== 板块四 · 履约追踪看板 - 入职日期记录 ============== */

export const Board4OnboardingMainRowSchema = Type.Object(
  {
    入职日期: Type.String({ format: 'date' }),
    物流仓: WarehouseSchema,
    供应商: Type.String(),
    入职总人数: Type.Integer({ minimum: 1, description: 'Σ = Σ明细人数（断言 A6）' }),
    '30天留存人数': Type.Integer({ minimum: 0, description: '未离职 或 在职天数≥30' }),
    '90天留存人数': Type.Integer({ minimum: 0 }),
    '30天留存率': RatioOrNull,
    '90天留存率': RatioOrNull,
    明细: Type.String({ description: '内联串：工种×班次×性质×技能=人数 ; …' }),
    供给满足率: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定常量 1.0（100%），非实算',
    }),
    供给时效: Type.Union([Type.Number(), Type.Null()], {
      description: '业务方指定-按入职总人数套用需求量分桶（0-20→7 / 20-100→14 / 100以上→30，单位天）',
    }),
    统计周期: Type.String({ description: '默认全量台账（不按周期过滤），覆盖 D3 全部入职日期' }),
    数据状态: Type.String(),
    生成时间: Type.Optional(GenTime),
  },
  { $id: 'Board4OnboardingMainRow', description: '板块四主表：入职日期 × 物流仓 × 供应商' },
);

export const Board4OnboardingDetailRowSchema = Type.Object(
  {
    入职日期: Type.String({ format: 'date' }),
    物流仓: WarehouseSchema,
    供应商: Type.String(),
    工种: Type.String(),
    班次: ShiftSchema,
    用工性质: EmploymentNatureSchema,
    技能等级: SkillLevelSchema,
    人数: Type.Integer({ minimum: 1 }),
    统计周期: Type.String(),
    数据状态: Type.String(),
    生成时间: Type.Optional(GenTime),
  },
  {
    $id: 'Board4OnboardingDetailRow',
    description: '板块四明细：主表键 + 工种×班次×用工性质×技能等级',
  },
);

export const Board4OnboardingLogSchema = Type.Object({
  主表: Type.Array(Board4OnboardingMainRowSchema),
  明细: Type.Array(Board4OnboardingDetailRowSchema),
});

/* ==================== 指标口径与计算公式说明表 ==================== */

export const MetricDictRowSchema = Type.Object(
  {
    板块: Type.Union([
      Type.Literal('全局'),
      Type.Literal('板块一'),
      Type.Literal('板块二'),
      Type.Literal('板块三'),
      Type.Literal('板块四'),
    ]),
    指标名: Type.String(),
    中文定义: Type.String(),
    计算公式: Type.String(),
    数据源列位: Type.String({ description: 'D1=考勤明细(header=1) / D2=工时校准 / D3=入离职' }),
    数据状态: Type.Union([
      Type.Literal('已实算'),
      Type.Literal('中间量'),
      Type.Literal('无数据源-占位'),
    ]),
    备注: Type.String(),
  },
  {
    $id: 'MetricDictRow',
    description:
      '每个 Excel 工作簿附带的「指标口径与计算公式」Sheet 行结构；全量 81 条（全局6/一31/二11/三19/四14）',
  },
);

export const MetricDictSchema = Type.Array(MetricDictRowSchema);

/* ========================= 断言校验结果 ========================= */

export const AssertionRowSchema = Type.Object(
  {
    场景: Type.String({ description: '如 2026-08/阿联酋迪拜定制8号仓' }),
    断言: Type.String({ description: 'A1~A4b（板块二↔一）/ A5b、A5c（板块三↔一）/ A6（板块四内部）' }),
    结果: Type.Union([Type.Literal('PASS'), Type.Literal('FAIL')]),
    实际值: Type.Unknown(),
    期望值: Type.Unknown(),
  },
  { $id: 'AssertionRow' },
);

export const AssertionSheetSchema = Type.Array(AssertionRowSchema);

/* ============================ 顶层 ============================ */

export const V6BoardSetSchema = Type.Object({
  版本: Type.String({ default: 'V6' }),
  生成时间: GenTime,
  筛选器: FilterSchema,
  区域健康看板: Type.Object({
    板块一: Board1RegionOverallSchema,
    板块二: Board2RegionBySupplierSchema,
  }),
  采购下单看板: Type.Object({
    板块三: Board3PurchaseByConditionSchema,
    板块三留痕: Board3MetaSchema,
  }),
  履约追踪看板: Type.Object({
    板块四: Board4OnboardingLogSchema,
  }),
  指标口径与计算公式: MetricDictSchema,
  断言校验结果: AssertionSheetSchema,
});

/* ========================= Static 类型 ========================= */

export type Warehouse = Static<typeof WarehouseSchema>;
export type Grade = Static<typeof GradeSchema>;
export type Confidence = Static<typeof ConfidenceSchema>;
export type Board1RegionOverall = Static<typeof Board1RegionOverallSchema>;
export type Board2RegionBySupplierRow = Static<typeof Board2RegionBySupplierRowSchema>;
export type Board3PurchaseByConditionRow = Static<typeof Board3PurchaseByConditionRowSchema>;
export type Board3Meta = Static<typeof Board3MetaSchema>;
export type Board4OnboardingMainRow = Static<typeof Board4OnboardingMainRowSchema>;
export type Board4OnboardingDetailRow = Static<typeof Board4OnboardingDetailRowSchema>;
export type MetricDictRow = Static<typeof MetricDictRowSchema>;
export type AssertionRow = Static<typeof AssertionRowSchema>;
export type V6BoardSet = Static<typeof V6BoardSetSchema>;

/* ================= P0 新产物 Schema（事实表 + 人头附表 + 峰值附表） ================= */

/** 月桶事实表单行（段1: fact 粒度 = 月×仓×供应商×条件组） */
export const FactMonthlyRowSchema = Type.Object({
  月份: Type.String({ pattern: '^\\d{4}-\\d{2}$', description: '月桶 YYYY-MM' }),
  物流仓: WarehouseSchema,
  供应商: Type.String(),
  工种: Type.String(),
  班次: ShiftSchema,
  用工性质: EmploymentNatureSchema,
  技能等级: SkillLevelSchema,
  考勤工时: Type.Number({ minimum: 0 }),
  加班工时: Type.Number({ minimum: 0 }),
  计划出勤人次: Type.Integer({ minimum: 0 }),
  出勤人次: Type.Integer({ minimum: 0 }),
  考勤异常人次: Type.Integer({ minimum: 0 }),
  // 动态异常明细列：异常明细_迟到/缺勤/早退 等（运行时可能有任意多个）
}, { 
  additionalProperties: Type.Integer({ minimum: 0 }), 
  description: '段1可加度量，支持动态异常明细_<类型>列' 
});

/** 仓月级度量（段2: wh 粒度 = 月×仓，不可下沉到条件组） */
export const WhMonthlyRowSchema = Type.Object({
  月份: Type.String({ pattern: '^\\d{4}-\\d{2}$' }),
  物流仓: WarehouseSchema,
  全体人日: Type.Integer({ minimum: 0, description: 'dd_all 基数，含非三方' }),
  三方人日: Type.Integer({ minimum: 0, description: 'third 基数' }),
  全体考勤工时: Type.Number({ minimum: 0, description: 'Σ dd_all._ag 最终核算时长，含正式工/非三方' }),
  异常已处理人日: Type.Integer({ minimum: 0 }),
  异常待处理基数: Type.Integer({ minimum: 0 }),
});

/** 离职率专段（段3: turnover 粒度 = 月×仓×供应商，期末法不可 Σ） */
export const TurnoverMonthlyRowSchema = Type.Object({
  月份: Type.String({ pattern: '^\\d{4}-\\d{2}$' }),
  物流仓: WarehouseSchema,
  供应商: Type.String(),
  窗口内离职人数: Type.Integer({ minimum: 0, description: '可 Σ' }),
  期末在职人数: Type.Integer({ minimum: 0, description: '★不可 Σ，跨月取末月值' }),
  异常已处理人日: Type.Integer({ minimum: 0, description: '可 Σ，供板块二算异常处理进度' }),
  异常待处理基数: Type.Integer({ minimum: 0, description: '可 Σ，供板块二算异常处理进度' }),
  有考勤: Type.Integer({
    minimum: 0,
    maximum: 1,
    description: '1=该月该仓该供应商有考勤记录；0=仅有离职档案无考勤（覆盖修复引入）',
  }),
});

/** 人头附表行（周期档×维度，解决跨月去重） */
export const HeadcountRowSchema = Type.Object({
  周期档: Type.String({ description: '全周期 / 2026-08 / 自定义区间' }),
  物流仓: WarehouseSchema,
  供应商: Type.Optional(Type.String()),
  工种: Type.Optional(Type.String()),
  班次: Type.Optional(ShiftSchema),
  用工性质: Type.Optional(EmploymentNatureSchema),
  技能等级: Type.Optional(SkillLevelSchema),
  供给人数: Type.Integer({ minimum: 0 }),
  出勤人数: Type.Integer({ minimum: 0 }),
  考勤异常人数: Type.Integer({ minimum: 0 }),
  全体出勤人数: Type.Optional(Type.Integer({ minimum: 0, description: '仅 L1 级有，含非三方' })),
}, { description: 'L1/L2/L3 三级共用；有供应商=L2+；有条件组键=L3' });

/** 峰值附表行（仓×供应商，修正条件组求和缺陷） */
export const PeakSupplyRowSchema = Type.Object({
  物流仓: WarehouseSchema,
  供应商: Type.String(),
  历史最大供给量: Type.Integer({ minimum: 0, description: '全历史日峰值，供应能力上界' }),
});

/**
 * 稀疏跨仓修正表行（路线B）
 * 仅导出「同一周期档内出现在 ≥2 个仓」的用户，用于多仓聚合时人头去重：
 *   精确人头 = Σ各仓人头 − Σ(该用户出现仓数 − 1)
 * 全量基元 3312 行 / 305KB → 稀疏表 18 行 / 4.2KB（省 98%），数学等价。
 */
export const CrossWhFixRowSchema = Type.Object({
  周期档: Type.String({ description: '全周期 / 2026-08 / 自定义区间' }),
  物流仓: WarehouseSchema,
  用户编码: Type.String(),
  供应商: Type.Union([Type.String(), Type.Null()], { description: '非三方用户为 null' }),
  供给: Type.Integer({ minimum: 0, maximum: 1 }),
  出勤: Type.Integer({ minimum: 0, maximum: 1 }),
  异常: Type.Integer({ minimum: 0, maximum: 1 }),
  全体出勤: Type.Integer({ minimum: 0, maximum: 1, description: '含非三方' }),
});

/** V6 应用层顶层数据 Schema（10 个产物聚合，供 gen 脚本 Value.Check 校验） */
export const V6AppDataSchema = Type.Object({
  fact_monthly: Type.Object({
    fact: Type.Array(FactMonthlyRowSchema),
    wh: Type.Array(WhMonthlyRowSchema),
    turnover: Type.Array(TurnoverMonthlyRowSchema),
  }),
  headcount_wh: Type.Array(HeadcountRowSchema),
  headcount_wh_sup: Type.Array(HeadcountRowSchema),
  headcount_cond: Type.Array(HeadcountRowSchema),
  peak_supply: Type.Array(PeakSupplyRowSchema),
  cross_wh_fix: Type.Array(CrossWhFixRowSchema),
  board3_slices: Type.Object({
    slices: Type.Record(Type.String(), Type.Object({
      rows: Type.Array(Type.Any()), // Board3 行或空切片占位行
      meta: Type.Record(Type.String(), Type.Any()),
    })),
    periods: Type.Array(Type.String()),
    warehouses: Type.Array(WarehouseSchema),
  }),
  board4_onboarding: Type.Object({
    main: Type.Array(Type.Any()), // Board4OnboardingMainRow
    detail: Type.Array(Type.Any()), // Board4OnboardingDetailRow
  }),
  meta: Type.Object({
    periods: Type.Array(Type.Object({
      name: Type.String(),
      start: Type.String(),
      end: Type.String(),
    })),
    warehouses: Type.Array(WarehouseSchema),
    metrics: Type.Array(Type.Any()), // MetricDictRow
    placeholders: Type.Record(Type.String(), Type.String()), // { 指标名: 占位原因 }
    generated_at: Type.String(),
    version: Type.String(),
    口径说明: Type.String(),
  }),
  golden_sample: Type.Record(Type.String(), Type.Object({
    board1: Type.Any(), // Board1RegionOverall
    board2: Type.Array(Type.Any()), // Board2RegionBySupplierRow[]
  })),
});

/* ========================= P0 Static 类型导出 ========================= */

export type FactMonthlyRow = Static<typeof FactMonthlyRowSchema>;
export type WhMonthlyRow = Static<typeof WhMonthlyRowSchema>;
export type TurnoverMonthlyRow = Static<typeof TurnoverMonthlyRowSchema>;
export type HeadcountRow = Static<typeof HeadcountRowSchema>;
export type PeakSupplyRow = Static<typeof PeakSupplyRowSchema>;
export type CrossWhFixRow = Static<typeof CrossWhFixRowSchema>;
export type V6AppData = Static<typeof V6AppDataSchema>;