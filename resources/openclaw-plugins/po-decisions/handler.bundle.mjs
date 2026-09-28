/**
 * po-decisions 运行时核心(内联业务逻辑,不经 monorepo tsup)。
 *
 * ⚠️ 写链已整体退役:履约追踪看板改为「TS 真源 `src/data/supplier-decision-table.ts`
 *    → `pnpm gen:decisions` 全量派生 用工决策.json」。本文件中所有与
 *    record_decision / 人审 / 追加落库相关的导出均已标注 @deprecated,仅作历史存档,
 *    **无调用方**;请勿在新代码中启用。
 *
 * 现行仍在使用的导出:
 *  - READ_TOOL_NAME / READ_DECISION_PARAMETERS / readRecords / resolveDecisionPath(只读查询);
 *  - RECORD_TOOL_NAME / isRecordTool / RECORD_TOOL_RETIRED_REASON(识别并阻断残留写调用);
 *  - buildReadOnlyGuidance / buildReadOnlyPromptInjection(只读语义的 prompt 注入)。
 *
 * 落库副作用(fs)全部通过参数注入,本文件保持纯逻辑可测。
 * 供薄入口 index.mjs 在 registerHook/registerTool 时调用。
 */

// ── 常量与默认配置 ───────────────────────────────────────────────────────────

/**
 * 已退役的写工具名。仍导出仅为:1) before_tool_call 识别历史会话残留调用并阻断;
 * 2) 保留旧实现可读性。插件不再注册该工具。
 */
export const RECORD_TOOL_NAME = 'record_decision';

/** 命中已退役写工具时反馈给模型的阻断原因。 */
export const RECORD_TOOL_RETIRED_REASON = [
  `\`${'record_decision'}\` 已停用:用工决策看板现为只读派生数据,禁止通过工具写入。`,
  '唯一人工维护真源是 ClawX 仓库的 `src/data/supplier-decision-table.ts`;',
  '更新方式:编辑该 TS 文件后运行 `pnpm gen:decisions` 全量覆盖 用工决策.json,再在看板刷新。',
  '请把本次定案结论(物流仓 / 供应商 / 承接人数或档级 / 决策依据)如实复述给用户,由其登记到真源。',
].join('\n');

/** 只读查重工具名。不拦截、不走人审。 */
export const READ_TOOL_NAME = 'read_decision';

/** 决策单号前缀年份基准(仅用于生成默认前缀)。 */
const DECISION_NO_PREFIX = 'PO';

/** 插件默认配置。 */
export const DEFAULT_CONFIG = {
  /** 人审弹窗等待超时(分钟)。默认 5。 */
  approvalTimeoutMinutes: 5,
  /** 超时行为:deny=不写入(默认) / allow=按允许处理。 */
  timeoutBehavior: 'deny',
};

/** 判断给定 toolName 是否为已退役的写工具(命中即阻断)。 */
export function isRecordTool(toolName) {
return typeof toolName === 'string' && toolName === RECORD_TOOL_NAME;
}

// ── 配置合并 ─────────────────────────────────────────────────────────────────

/** 浅合并用户配置到默认配置 + 基本校验。 */
export function resolveConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === 'object') {
    const r = raw;
    if (typeof r.approvalTimeoutMinutes === 'number' && r.approvalTimeoutMinutes > 0) {
      cfg.approvalTimeoutMinutes = r.approvalTimeoutMinutes;
    }
    if (r.timeoutBehavior === 'allow' || r.timeoutBehavior === 'deny') {
      cfg.timeoutBehavior = r.timeoutBehavior;
    }
  }
  return cfg;
}

/** 拼出 用工决策.json 绝对路径。home 由调用方注入(os.homedir())。 */
export function resolveDecisionPath(homeDir) {
  // ~/.openclaw/workspace-po/用工决策.json
return [homeDir, '.openclaw', 'workspace-po', '用工决策.json'].join('/');
}

// ── 入参 JSON Schema(纯字面量,单一来源) ─────────────────────────────────────

/**
 * @deprecated 已弃用:record_decision 入参 schema。写工具已停止注册,**已无调用方**。
 *
 * record_decision 入参 schema。
 * 注意:decisionNo 不在入参中——由插件按年递增生成,防止模型编造单号。
 */
export const RECORD_DECISION_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: {
      type: 'string',
      description: '决策日期,格式 YYYY-MM-DD;缺省时由插件填当天',
    },
    warehouse: {
      type: 'string',
      description: '物流仓名称,如 "A物流仓"',
    },
    supplier: {
      type: 'string',
      description: '承接供应商名称,如 "A供应商"',
  },
    headcount: {
      type: 'string',
      description: '承接人数 / 档级,如 "60人 / 中批量档"',
    },
    basis: {
 type: 'string',
      description: '决策依据:引用供应商画像事实 + 经验库规则,说明为何选此供应商此人数',
    },
  },
  required: ['warehouse', 'supplier', 'headcount', 'basis'],
};

/** read_decision 入参 schema(无入参)。 */
export const READ_DECISION_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

// ── JSON 文档读写核心 ────────────────────────────────────────────────────────

/** 空文档结构。 */
function emptyDoc() {
  return { records: [] };
}

/** 容错解析 JSON 文档为 records 数组(非法一律回退空)。 */
function parseDoc(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
   return emptyDoc();
    }
    return { records: parsed.records };
  } catch {
    return emptyDoc();
  }
}

/**
 * 读取全部已有决策记录(供 read_decision 与单号递增复用)。
 * 文件不存在或非法时回退空列表,绝不抛错。
 */
export async function readRecords(fs, filePath) {
  const exists = await fs.exists(filePath);
  if (!exists) {
    return [];
  }
  const raw = await fs.readFile(filePath);
  return parseDoc(raw).records;
}

/**
 * 按年递增生成下一个决策单号,如 PO-2026-001。
 * 扫描已有记录中同年前缀的最大序号 +1。
 */
export function nextDecisionNo(records, now) {
  const year = (now ?? new Date()).getFullYear();
  const prefix = `${DECISION_NO_PREFIX}-${year}-`;
  let max = 0;
  for (const r of records) {
    if (r && typeof r.decisionNo === 'string' && r.decisionNo.startsWith(prefix)) {
      const seq = Number.parseInt(r.decisionNo.slice(prefix.length), 10);
      if (Number.isFinite(seq) && seq > max) {
        max = seq;
      }
    }
  }
  const seq = String(max + 1).padStart(3, '0');
  return `${prefix}${seq}`;
}

/** 今天日期字符串 YYYY-MM-DD。 */
function todayStr(now) {
  const d = now ?? new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @deprecated 已弃用:写链专用的入参校验。**已无调用方**(仅 persistEntry/handleBeforeToolCall 曾使用)。
 *
 * 校验并规整工具入参为决策记录(缺 decisionNo/date,后续补)。非法则抛错(fail-closed)。
 */
export function parseToolParams(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('record_decision: 缺少参数对象');
  }
  const p = raw;
  const fields = ['warehouse', 'supplier', 'headcount', 'basis'];
  for (const f of fields) {
    const v = p[f];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`record_decision: 字段 ${f} 必须为非空字符串`);
  }
  }
  return {
    date: typeof p.date === 'string' && p.date.trim() ? p.date.trim() : '',
    warehouse: p.warehouse.trim(),
    supplier: p.supplier.trim(),
    headcount: p.headcount.trim(),
    basis: p.basis.trim(),
  };
}

/**
 * @deprecated 已弃用:人审通过后追加落库。
 *
 * 履约追踪改为「TS 真源 → `pnpm gen:decisions` 全量派生」后,用工决策.json 为只读产物,
 * 任何追加都会在下次重跑脚本时被覆盖,且会破坏唯一真源约束。
 * 本函数保留作历史存档,**已无调用方**(index.mjs 不再注册写工具、不再发人审)。
 *
 * 端到端落库:读取(或初始化)→ 生成单号/日期 → 追加 → 写回。
 * @returns 实际写入的完整记录(含 decisionNo)。
 */
export async function persistEntry(fs, filePath, entry, now) {
  const records = await readRecords(fs, filePath);
  const decisionNo = nextDecisionNo(records, now);
  const date = entry.date && entry.date.trim() ? entry.date.trim() : todayStr(now);
  const full = { decisionNo, date, ...entry };
  full.date = date;
  const next = { records: [...records, full] };
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return full;
}

/**
 * @deprecated 已弃用:人审弹窗文案。**已无调用方**。
 *
 * 人审弹窗展示用:把决策渲染成可读的确认文本。
 */
export function renderApprovalDescription(entry) {
  return [
    '检测到一条已确认的用工分单决策,是否登记到用工决策看板?',
    '',
    `物流仓: ${entry.warehouse}`,
    `供应商: ${entry.supplier}`,
    `承接人数/档级: ${entry.headcount}`,
    `决策依据: ${entry.basis}`,
    '',
    '(决策单号由系统自动生成,确认后写入 用工决策.json)',
  ].join('\n');
}

// ── 人审弹窗构造 ─────────────────────────────────────────────────────────────

/** 视为"允许写库"的决议集合。 */
function isAllow(decision) {
  return decision === 'allow-once' || decision === 'allow-always';
}

/**
 * @deprecated 已弃用:人审弹窗 + onResolution 写库。看板改为只读派生,写链整体退役。
 * 保留作历史存档,**已无调用方**。
 *
 * 为一条决策构造 before_tool_call 的 requireApproval 规格。
 * 用户确认(allow)后由 onResolution 写入 用工决策.json;拒绝/超时则丢弃。
 */
export function buildRequireApproval(entry, config, deps, pluginId) {
  const timeoutMs = Math.max(1, config.approvalTimeoutMinutes) * 60_000;

  return {
    title: '登记用工决策',
    description: renderApprovalDescription(entry),
    severity: 'info',
    timeoutMs,
    timeoutBehavior: config.timeoutBehavior,
    timeoutReason: '用工决策审批超时,未登记到看板。',
    allowedDecisions: ['allow-once', 'deny'],
    pluginId,
    onResolution: async (decision) => {
      if (!isAllow(decision)) {
        return;
      }
      try {
        await persistEntry(deps.fs, deps.filePath, entry);
        deps.onPersisted?.(entry);
      } catch (err) {
        deps.onError?.(entry, err);
      }
    },
  };
}

// ── before_tool_call 决策入口 ────────────────────────────────────────────────

/**
 * @deprecated 已弃用:「命中 record_decision → 发人审」的旧拦截入口。
 * 现行 index.mjs 直接对残留调用返回 { block, blockReason: RECORD_TOOL_RETIRED_REASON }。
 * 保留作历史存档,**已无调用方**。
 *
 * before_tool_call 拦截入口:仅处理 record_decision。
 *
 * @returns
 *  - 命中且参数合法 → { requireApproval }(拦下工具执行,发人审);
 *  - 命中但参数非法 → { block, blockReason }(阻断,反馈给模型重试);
 *  - 非目标工具 → undefined(放行,交由后续 hook/核心处理)。
 */
export function handleBeforeToolCall(input) {
  if (!isRecordTool(input.toolName)) {
    return undefined;
  }

  let entry;
  try {
    entry = parseToolParams(input.params);
  } catch (err) {
    return {
      block: true,
      blockReason: err instanceof Error ? err.message : String(err),
    };
  }

  const requireApproval = buildRequireApproval(
    entry,
    input.config,
    input.deps,
    input.pluginId,
  );
  return { requireApproval };
}

// ── before_prompt_build 指引注入 ─────────────────────────────────────────────

/**
 * @deprecated 已弃用:引导模型调用 `record_decision` 登记的旧注入文案。
 * 现行注入见 buildReadOnlyGuidance()。保留作历史存档,**已无调用方**。
 *
 * 生成注入的系统指引文本。
 */
export function buildGuidance() {
  return [
    '## 用工决策登记',
    '',
    '当用户要求确认一次「用工分单决策」定案时——即已敲定「哪个物流仓、哪个供应商、',
    '承接多少人/档级、依据是什么」——你必须调用工具 `' + RECORD_TOOL_NAME + '`',
    '把这条已确认的决策结构化登记,并先调用 `' + READ_TOOL_NAME + '` 查重。',
    '',
    '判定要点(命中即视为一次决策定案):',
    '- 用户明确给出物流仓 + 供应商 + 承接人数/档级 + 决策依据四要素;',
    '- 该决策已形成结论(而非仍在讨论);',
    '- 用户希望把它登记进用工决策看板。',
    '',
    '【排他强制 · 最高优先级】识别到上述决策定案时:',
    '- 你【只能】通过 `' + RECORD_TOOL_NAME + '` 交人审登记,这是唯一合法出口;',
    '- 【严禁】把决策普通地写进对话/记忆/文件,也不得自行确认入库;',
    '- 调用后会弹人审确认框,由用户决定是否入库,你无需也【不得】代为确认。',
    '',
    '调用 `' + RECORD_TOOL_NAME + '` 时按如下规则填参:',
    '- date:决策日期 YYYY-MM-DD;缺省时由系统填当天,可不传。',
    '- warehouse:物流仓名称,如 "A物流仓"。',
    '- supplier:承接供应商名称,如 "A供应商"。',
    '- headcount:承接人数/档级,如 "60人 / 中批量档"。',
    '- basis:决策依据,引用供应商画像事实 + 经验库规则,说明为何选此组合。',
    '',
    '注意:',
    '- 决策单号(如 PO-2026-001)由系统按年自动生成,你【不要】填、也不要编造;',
    '- 四要素任一未确认,不得调用 `' + RECORD_TOOL_NAME + '`;',
    '- 调用前先用 `' + READ_TOOL_NAME + '` 查询,避免重复登记同一决策;',
    '- 一次用户请求若含多条独立决策,可多次调用,每条一次。',
  ].join('\n');
}

/**
 * @deprecated 已弃用:写入引导的注入构造器。现行请用 buildReadOnlyPromptInjection()。
 * 保留作历史存档,**已无调用方**。
 */
export function buildPromptInjection() {
  return { prependSystemContext: buildGuidance() };
}

// ── 现行 before_prompt_build 注入(只读语义) ─────────────────────────────────

/**
 * 现行注入文案:声明用工决策看板为只读派生数据,并给出唯一正确的更新路径。
 * 取代已弃用的 buildGuidance()。
 */
export function buildReadOnlyGuidance() {
  return [
    '## 用工决策看板(只读)',
    '',
    '用工决策看板的数据**不可**通过对话或工具写入。`用工决策.json` 是派生产物,',
    '唯一人工维护真源是 ClawX 仓库的 `src/data/supplier-decision-table.ts`。',
    '',
    '- 查询已有决策:调用 `' + READ_TOOL_NAME + '`(唯一可用的决策工具)。',
    '- 【严禁】调用 `' + RECORD_TOOL_NAME + '`(已停用,调用会被直接阻断);',
    '- 【严禁】直接编辑 用工决策.json,或编造决策单号(decisionNo)。',
    '',
    '当用户敲定一次用工分单决策时,你应当:',
    '1. 如实复述定案结论(物流仓 / 供应商 / 承接人数或档级 / 决策依据);',
    '2. 告知其登记方式——编辑 `src/data/supplier-decision-table.ts` 后运行 `pnpm gen:decisions`,',
    '   该脚本会全量覆盖 用工决策.json,随后在看板点刷新即可看到。',
  ].join('\n');
}

/** 供 before_prompt_build hook 直接返回的结果构造器(只读语义)。 */
export function buildReadOnlyPromptInjection() {
  return { prependSystemContext: buildReadOnlyGuidance() };
}
