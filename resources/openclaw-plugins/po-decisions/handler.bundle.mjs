/**
 * po-decisions 运行时核心(内联业务逻辑,不经 monorepo tsup)。
 *
 * 与 experience-capture 同构,差异:
 *  - 数据载体为结构化 JSON(用工决策.json,根 { records: [...] }),而非 Markdown 追加。
 *  - 提供 record_decision(人审写)+ read_decision(只读查重)两个工具。
 *  - 决策单号由插件按年递增生成(PO-2026-001),模型不得编造。
 *
 * 落库副作用(fs)全部通过参数注入,本文件保持纯逻辑可测。
 * 供薄入口 index.mjs 在 registerHook/registerTool 时调用。
 */

// ── 常量与默认配置 ───────────────────────────────────────────────────────────

/** 承载"登记一条用工决策"意图的写工具名。before_tool_call 仅拦截此工具。 */
export const RECORD_TOOL_NAME = 'record_decision';

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

/** 判断给定 toolName 是否为本插件的写工具(需人审)。 */
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

/** 校验并规整工具入参为决策记录(缺 decisionNo/date,后续补)。非法则抛错(fail-closed)。 */
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

/** 人审弹窗展示用:把决策渲染成可读的确认文本。 */
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

/** 生成注入的系统指引文本。 */
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

/** 供 before_prompt_build hook 直接返回的结果构造器。 */
export function buildPromptInjection() {
  return { prependSystemContext: buildGuidance() };
}
