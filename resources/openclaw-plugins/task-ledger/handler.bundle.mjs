// src/ledger-doc.ts
function parseDoc(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r) => !!r && typeof r === "object" && typeof r.taskId === "string" && typeof r.stepNo === "number"
      );
    }
  } catch {
  }
  return [];
}
function stringifyDoc(doc) {
  return `${JSON.stringify(doc, null, 2)}
`;
}
function nowIso(now = /* @__PURE__ */ new Date()) {
  return now.toISOString();
}
function buildRecord(params, now = /* @__PURE__ */ new Date()) {
  const record = {
    taskId: params.taskId.trim(),
    stepNo: params.stepNo,
    action: params.action.trim(),
    targetApp: params.targetApp.trim(),
    verify: params.verify.trim(),
    status: params.status,
    riskLevel: params.riskLevel,
    timestamp: params.timestamp?.trim() || nowIso(now)
  };
  if (typeof params.instruction === "string" && params.instruction.trim() !== "") {
    record.instruction = params.instruction.trim();
  }
  if (typeof params.detail === "string" && params.detail.trim() !== "") {
    record.detail = params.detail.trim();
  }
  return record;
}
function appendRecord(doc, record) {
  const idx = doc.findIndex(
    (r) => r.taskId === record.taskId && r.stepNo === record.stepNo
  );
  if (idx >= 0) {
    const next = [...doc];
    next[idx] = record;
    return { doc: next, added: false };
  }
  return { doc: [...doc, record], added: true };
}
async function persistRecord(fs, filePath, params, now = /* @__PURE__ */ new Date()) {
  const exists = await fs.exists(filePath);
  const current = exists ? parseDoc(await fs.readFile(filePath)) : [];
  const record = buildRecord(params, now);
  const { doc: next, added } = appendRecord(current, record);
  await fs.writeFile(filePath, stringifyDoc(next));
  return { written: added, record };
}
async function readRecords(fs, filePath) {
  const exists = await fs.exists(filePath);
  if (!exists) {
    return [];
  }
  return parseDoc(await fs.readFile(filePath));
}
function renderApprovalDescription(record) {
  const lines = [
    "\u68C0\u6D4B\u5230\u4E00\u4E2A\u9AD8\u98CE\u9669\uFF08\u4E0D\u53EF\u9006\uFF09\u6B65\u9AA4\uFF0C\u662F\u5426\u6279\u51C6\u6267\u884C\u5E76\u767B\u8BB0?",
    "",
    `\u4EFB\u52A1: ${record.taskId}`,
    `\u6B65\u9AA4: \u7B2C ${record.stepNo} \u6B65`,
    `\u64CD\u4F5C: ${record.action}`,
    `\u76EE\u6807\u8F6F\u4EF6: ${record.targetApp}`,
    `\u9A8C\u6536\u6761\u4EF6: ${record.verify}`,
    `\u98CE\u9669\u7B49\u7EA7: ${record.riskLevel}`
  ];
  if (record.detail) {
    lines.push(`\u7EC6\u8282: ${record.detail}`);
  }
  return lines.join("\n");
}

// src/types.ts
var DEFAULT_CONFIG = {
  approvalTimeoutMinutes: 5,
  timeoutBehavior: "deny"
};
var RECORD_TOOL_NAME = "record_task_step";
var READ_TOOL_NAME = "read_task_ledger";
var VALID_STATUSES = [
  "success",
  "blocked",
  "failed",
  "rolled-back"
];
var VALID_RISK_LEVELS = ["normal", "high"];
function isRecordTool(toolName) {
  return typeof toolName === "string" && toolName === RECORD_TOOL_NAME;
}
function isReadTool(toolName) {
  return typeof toolName === "string" && toolName === READ_TOOL_NAME;
}

// src/approval.ts
function isAllow(decision) {
  return decision === "allow-once" || decision === "allow-always";
}
function buildRequireApproval(params, config, deps, pluginId) {
  const timeoutMs = Math.max(1, config.approvalTimeoutMinutes) * 6e4;
  const preview = buildRecord(params);
  return {
    title: "\u6279\u51C6\u9AD8\u98CE\u9669\u6B65\u9AA4",
    description: renderApprovalDescription(preview),
    severity: "warning",
    timeoutMs,
    timeoutBehavior: config.timeoutBehavior,
    timeoutReason: "\u9AD8\u98CE\u9669\u6B65\u9AA4\u5BA1\u6279\u8D85\u65F6\uFF0C\u672A\u6267\u884C\u3001\u672A\u5199\u5165\u53F0\u8D26\u3002",
    allowedDecisions: ["allow-once", "deny"],
    pluginId,
    onResolution: async (decision) => {
      if (!isAllow(decision)) {
        return;
      }
      try {
        const { written } = await persistRecord(deps.fs, deps.filePath, params);
        deps.onPersisted?.(params, written);
      } catch (err) {
        deps.onError?.(params, err);
      }
    }
  };
}

// src/handler.ts
function resolveConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object") {
    const r = raw;
    if (typeof r.approvalTimeoutMinutes === "number" && r.approvalTimeoutMinutes > 0) {
      cfg.approvalTimeoutMinutes = r.approvalTimeoutMinutes;
    }
    if (r.timeoutBehavior === "allow" || r.timeoutBehavior === "deny") {
      cfg.timeoutBehavior = r.timeoutBehavior;
    }
  }
  return cfg;
}
function parseToolParams(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("record_task_step: \u7F3A\u5C11\u53C2\u6570\u5BF9\u8C61");
  }
  const p = raw;
  const stringFields = [
    "taskId",
    "action",
    "targetApp",
    "verify"
  ];
  for (const f of stringFields) {
    const v = p[f];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`record_task_step: \u5B57\u6BB5 ${f} \u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32`);
    }
  }
  if (typeof p.stepNo !== "number" || !Number.isInteger(p.stepNo) || p.stepNo < 1) {
    throw new Error("record_task_step: \u5B57\u6BB5 stepNo \u5FC5\u987B\u4E3A\u6B63\u6574\u6570\uFF08\u4ECE 1 \u9012\u589E\uFF09");
  }
  if (typeof p.status !== "string" || !VALID_STATUSES.includes(p.status)) {
    throw new Error(
      `record_task_step: \u5B57\u6BB5 status \u5FC5\u987B\u4E3A ${VALID_STATUSES.join(" / ")} \u4E4B\u4E00`
    );
  }
  if (typeof p.riskLevel !== "string" || !VALID_RISK_LEVELS.includes(p.riskLevel)) {
    throw new Error(
      `record_task_step: \u5B57\u6BB5 riskLevel \u5FC5\u987B\u4E3A ${VALID_RISK_LEVELS.join(" / ")} \u4E4B\u4E00`
    );
  }
  const parsed = {
    taskId: p.taskId.trim(),
    stepNo: p.stepNo,
    action: p.action.trim(),
    targetApp: p.targetApp.trim(),
    verify: p.verify.trim(),
    status: p.status,
    riskLevel: p.riskLevel
  };
  if (typeof p.instruction === "string" && p.instruction.trim() !== "") {
    parsed.instruction = p.instruction.trim();
  }
  if (typeof p.timestamp === "string" && p.timestamp.trim() !== "") {
    parsed.timestamp = p.timestamp.trim();
  }
  if (typeof p.detail === "string" && p.detail.trim() !== "") {
    parsed.detail = p.detail.trim();
  }
  return parsed;
}
async function handleBeforeToolCall(input) {
  if (!isRecordTool(input.toolName)) {
    return void 0;
  }
  let params;
  try {
    params = parseToolParams(input.params);
  } catch (err) {
    return {
      block: true,
      blockReason: err instanceof Error ? err.message : String(err)
    };
  }
  if (params.riskLevel === "high") {
    const requireApproval = buildRequireApproval(
      params,
      input.config,
      input.deps,
      input.pluginId
    );
    return { requireApproval };
  }
  try {
    const { written } = await persistRecord(
      input.deps.fs,
      input.deps.filePath,
      params
    );
    input.deps.onPersisted?.(params, written);
    return { persisted: true, written };
  } catch (err) {
    input.deps.onError?.(params, err);
    return {
      block: true,
      blockReason: `record_task_step: \u6267\u884C\u8BB0\u5F55\u843D\u5E93\u5931\u8D25\uFF0C\u5DF2\u62E6\u622A\uFF1A${err instanceof Error ? err.message : String(err)}`
    };
  }
}
function resolveLedgerPath(homeDir) {
  const parts = [homeDir, ".openclaw", "workspace-assistant", "\u6267\u884C\u8BB0\u5F55.json"];
  return parts.join("/");
}
var TOOL_NAME = RECORD_TOOL_NAME;

// src/guidance.ts
function buildGuidance() {
  return [
    "## \u6267\u884C\u8BB0\u5F55\u53F0\u8D26",
    "",
    "\u4F60\u5728\u6267\u884C\u300C\u4E00\u53E5\u8BDD\u4EE3\u529E\u300D\u4EFB\u52A1\u65F6\uFF0C\u6BCF\u5B8C\u6210\u4E00\u6B65\u90FD\u8981\u628A\u8BE5\u6B65\u7ED3\u6784\u5316\u767B\u8BB0\u8FDB\u6267\u884C\u8BB0\u5F55",
    "\u53F0\u8D26\u3002\u767B\u8BB0\u4E0E\u9AD8\u98CE\u9669\u4EBA\u5BA1\u7531\u63D2\u4EF6\u5C42\u5F3A\u5236\u5B8C\u6210\uFF0C\u4F60\u53EA\u9700\u6309\u89C4\u5219\u8C03\u7528\u5DE5\u5177\u3002",
    "",
    "### \u6BCF\u6B65\u767B\u8BB0\uFF1A\u8C03\u7528 `" + RECORD_TOOL_NAME + "`",
    "\u6BCF\u6267\u884C\u5B8C\u4E00\u6B65\uFF08\u65E0\u8BBA\u6210\u529F\u6216\u5931\u8D25\uFF09\uFF0C\u7ACB\u5373\u8C03\u7528\u8BE5\u5DE5\u5177\u767B\u8BB0\uFF0C\u6309\u5982\u4E0B\u89C4\u5219\u586B\u53C2\uFF1A",
    '- taskId\uFF1A\u672C\u6B21\u4EFB\u52A1\u552F\u4E00\u6807\u8BC6\uFF0C\u5982 "task-20260909-001"\uFF0C\u540C\u4E00\u4EFB\u52A1\u5168\u7A0B\u590D\u7528\u3002',
    "- stepNo\uFF1A\u6B65\u9AA4\u5E8F\u53F7\uFF0C\u4ECE 1 \u9012\u589E\uFF08\u540C taskId+stepNo \u89C6\u4E3A\u540C\u4E00\u6B65\uFF0C\u53EF\u66F4\u65B0\u72B6\u6001\uFF09\u3002",
    "- action\uFF1A\u672C\u6B65\u62BD\u8C61\u64CD\u4F5C\u63CF\u8FF0\uFF08\u505A\u4E86\u4EC0\u4E48\uFF09\u3002",
    '- targetApp\uFF1A\u672C\u6B65\u64CD\u4F5C\u7684\u76EE\u6807\u8F6F\u4EF6\uFF08\u5982 "\u6587\u4EF6\u7BA1\u7406\u5668" / "\u90AE\u4EF6\u5BA2\u6237\u7AEF"\uFF09\u3002',
    "- verify\uFF1A\u672C\u6B65\u9A8C\u6536\u6761\u4EF6\uFF08\u673A\u5668\u53EF\u6821\u9A8C\u7684\u6807\u51C6\uFF09\u3002",
    "- status\uFF1Asuccess / blocked\uFF08\u4EBA\u5BA1\u9A73\u56DE\uFF09/ failed\uFF08\u6267\u884C\u5931\u8D25\uFF09/ rolled-back\uFF08\u56DE\u6EDA\uFF09\u3002",
    "- riskLevel\uFF1Anormal / high \u2014\u2014 \u89C1\u4E0B\u65B9\u98CE\u9669\u5206\u7EA7\u89C4\u5219\u3002",
    "- instruction / timestamp / detail\uFF1A\u53EF\u9009\u8865\u5145\uFF08\u539F\u59CB\u6307\u4EE4 / \u65F6\u95F4 / \u7EC6\u8282\uFF09\u3002",
    "",
    "### \u98CE\u9669\u5206\u7EA7\uFF08\u51B3\u5B9A\u662F\u5426\u5F39\u4EBA\u5BA1\uFF09",
    "- high\uFF1A\u4E0D\u53EF\u9006\u6216\u9AD8\u5F71\u54CD\u6B65\u9AA4\uFF08\u5220\u9664\u6587\u4EF6\u3001\u53D1\u9001\u90AE\u4EF6\u3001\u8986\u76D6\u5199\u5165\u3001\u7CFB\u7EDF\u7EA7\u53D8\u66F4\u7B49\uFF09\u3002",
    "  \u6807 high \u540E\uFF0C\u672C\u6B65\u5728\u6267\u884C\u524D\u4F1A\u5F39\u51FA\u4EBA\u5BA1\u786E\u8BA4\u6846\uFF0C\u7531\u7528\u6237\u653E\u884C\u624D\u843D\u5E93\u5E76\u7EE7\u7EED\u3002",
    "- normal\uFF1A\u53EF\u9006\u3001\u4F4E\u5F71\u54CD\u6B65\u9AA4\uFF08\u8BFB\u53D6\u3001\u6574\u7406\u3001\u6C47\u603B\u3001\u521B\u5EFA\u526F\u672C\u7B49\uFF09\u3002\u76F4\u63A5\u843D\u5E93\u5E76\u653E\u884C\uFF0C",
    "  \u4E0D\u6253\u6270\u7528\u6237\u3002",
    "- \u65E0\u6CD5\u5224\u5B9A\u98CE\u9669\u65F6\uFF0C\u4E00\u5F8B\u6309 high \u5904\u7406\uFF08fail-closed\uFF0C\u5B81\u53EF\u591A\u95EE\u4E00\u6B21\uFF09\u3002",
    "",
    "### \u6267\u884C\u524D\u67E5\u91CD\uFF1A\u8C03\u7528 `" + READ_TOOL_NAME + "`",
    "\u5F00\u59CB\u6267\u884C\u6216\u91CD\u8BD5\u524D\uFF0C\u5148\u8C03\u7528\u8BE5\u5DE5\u5177\u8BFB\u53D6\u53F0\u8D26\uFF0C\u786E\u8BA4\u8BE5\u6B65\u662F\u5426\u5DF2\u767B\u8BB0\u6210\u529F\uFF0C",
    "\u907F\u514D\u91CD\u590D\u6267\u884C\u540C\u4E00\u6B65\u3002\u8BE5\u5DE5\u5177\u65E0\u5165\u53C2\u3001\u4E0D\u5F39\u4EBA\u5BA1\uFF0C\u76F4\u63A5\u8FD4\u56DE\u5168\u90E8\u6267\u884C\u8BB0\u5F55\u3002",
    "",
    "\u6CE8\u610F\uFF1A",
    "- \u767B\u8BB0\u5FC5\u987B\u5982\u5B9E\u53CD\u6620\u771F\u5B9E\u6267\u884C\u7ED3\u679C\uFF0C\u4E0D\u5F97\u81C6\u9020\u6216\u63D0\u524D\u767B\u8BB0\u672A\u6267\u884C\u7684\u6B65\u9AA4\uFF1B",
    '- \u9AD8\u98CE\u9669\u6B65\u9AA4\u88AB\u4EBA\u5BA1\u9A73\u56DE\u65F6\uFF0C\u5E94\u4EE5 status:"blocked" \u767B\u8BB0\u5E76\u505C\u6B62\u540E\u7EED\u6B65\u9AA4\uFF1B',
    "- \u4E00\u6B21\u4EFB\u52A1\u53EF\u591A\u6B21\u8C03\u7528 `" + RECORD_TOOL_NAME + "`\uFF0C\u6BCF\u6B65\u4E00\u6B21\u3002"
  ].join("\n");
}
function buildPromptInjection() {
  return { prependSystemContext: buildGuidance() };
}

// src/tool-schema.ts
var RECORD_STEP_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: {
      type: "string",
      description: '\u4EFB\u52A1\u552F\u4E00\u6807\u8BC6\uFF0C\u5982 "task-20260909-001"\uFF0C\u540C\u4E00\u4EFB\u52A1\u5168\u7A0B\u590D\u7528\u3002'
    },
    stepNo: {
      type: "number",
      description: "\u6B65\u9AA4\u5E8F\u53F7\uFF0C\u4ECE 1 \u9012\u589E\u7684\u6B63\u6574\u6570\u3002"
    },
    action: {
      type: "string",
      description: '\u672C\u6B65\u62BD\u8C61\u64CD\u4F5C\u63CF\u8FF0\uFF0C\u5982"\u6309\u4F9B\u5E94\u5546/\u6708\u4EFD\u5F52\u6863\u53D1\u7968 PDF"\u3002'
    },
    targetApp: {
      type: "string",
      description: '\u672C\u6B65\u64CD\u4F5C\u7684\u76EE\u6807\u8F6F\u4EF6\uFF0C\u5982"\u6587\u4EF6\u7BA1\u7406\u5668"\u3002'
    },
    verify: {
      type: "string",
      description: "\u672C\u6B65\u9A8C\u6536\u6761\u4EF6\uFF08\u673A\u5668\u53EF\u6821\u9A8C\u7684\u6807\u51C6\uFF09\u3002"
    },
    status: {
      type: "string",
      enum: ["success", "blocked", "failed", "rolled-back"],
      description: "\u6267\u884C\u72B6\u6001\uFF1Asuccess/blocked(\u4EBA\u5BA1\u9A73\u56DE)/failed(\u6267\u884C\u5931\u8D25)/rolled-back(\u56DE\u6EDA)\u3002"
    },
    riskLevel: {
      type: "string",
      enum: ["normal", "high"],
      description: "\u98CE\u9669\u7B49\u7EA7\uFF1Anormal/high\u3002high \u6B65\u9AA4\u6267\u884C\u524D\u4F1A\u89E6\u53D1\u4EBA\u5BA1\u5F39\u7A97\u3002"
    },
    instruction: {
      type: "string",
      description: "\u539F\u59CB\u4E00\u53E5\u8BDD\u6307\u4EE4\uFF08\u53EF\u9009\uFF09\u3002"
    },
    timestamp: {
      type: "string",
      description: "\u8BB0\u5F55\u65F6\u95F4\u6233\uFF0CISO8601\uFF08\u53EF\u9009\uFF0C\u7701\u7565\u5219\u7531\u63D2\u4EF6\u8865\u5F53\u524D\u65F6\u523B\uFF09\u3002"
    },
    detail: {
      type: "string",
      description: "\u8865\u5145\u7EC6\u8282\uFF08\u53EF\u9009\uFF09\u3002"
    }
  },
  required: ["taskId", "stepNo", "action", "targetApp", "verify", "status", "riskLevel"]
};
var READ_LEDGER_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: []
};

export { DEFAULT_CONFIG, READ_LEDGER_PARAMETERS, READ_TOOL_NAME, RECORD_STEP_PARAMETERS, RECORD_TOOL_NAME, TOOL_NAME, VALID_RISK_LEVELS, VALID_STATUSES, appendRecord, buildGuidance, buildPromptInjection, buildRecord, buildRequireApproval, handleBeforeToolCall, isReadTool, isRecordTool, nowIso, parseDoc, parseToolParams, persistRecord, readRecords, renderApprovalDescription, resolveConfig, resolveLedgerPath, stringifyDoc };
