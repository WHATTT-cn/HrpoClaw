/** 履约追踪唯一人工维护真源。修改后在 ClawX 运行 pnpm gen:decisions。
 * 派生工作区 JSON 和 shared JSON 均全量覆盖；前端只导入类型。
 */
export interface DecisionRecord {
  decisionNo: string;
  date: string;
  warehouse: string;
  supplier: string;
  headcount: string;
  basis: string;
}

export interface DecisionsDoc {
  records: DecisionRecord[];
}

export const supplierDecisions: DecisionsDoc = {
  records: [
    {
      decisionNo: 'PO-2026-001',
      date: '2026-01-15',
      warehouse: 'A物流仓',
      supplier: 'A供应商',
      headcount: '12人 / 中批量档',
      basis: 'A供应商本地班组成熟,新仓爬坡期优先承接,首轮豁免新供应商 10 人限额',
    },
    {
      decisionNo: 'PO-2026-002',
      date: '2026-09-10',
      warehouse: 'B物流仓',
      supplier: 'A供应商',
      headcount: '14人 / 日结临时工',
      basis: '到岗最快(3.6天)、供给率最高(0.918)，份额压至25%软上限内，避免停供施压谈判',
    },
    {
      decisionNo: 'PO-2026-003',
      date: '2026-09-10',
      warehouse: 'B物流仓',
      supplier: 'C供应商',
      headcount: '48人 / 日结临时工',
      basis: '刚好4天到岗、支持日结、承担主力份额；超额下单以0.888供给率抵消缺口，确保实际到岗≥55人',
    },
  ],
};