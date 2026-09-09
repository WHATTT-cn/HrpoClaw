// src/types.ts
var DEFAULT_CONFIG = {
  approvalTimeoutMinutes: 5,
  timeoutBehavior: "deny"
};
var RECORD_TOOL_NAME = "record_maintenance";
var READ_TOOL_NAME = "read_maintenance";
function isRecordTool(toolName) {
  return typeof toolName === "string" && toolName === RECORD_TOOL_NAME;
}

// src/maintenance-doc.ts
var WORK_ORDER_PREFIX = "WO-240-";
function parseDoc(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.records)) {
      const records = parsed.records.filter(
        (r) => !!r && typeof r === "object" && typeof r.workOrder === "string"
      );
      return { records };
    }
  } catch {
  }
  return { records: [] };
}
function stringifyDoc(doc) {
  return `${JSON.stringify(doc, null, 2)}
`;
}
function nextWorkOrder(doc) {
  let max = 0;
  for (const r of doc.records) {
    const m = /^WO-240-(\d+)$/.exec(r.workOrder ?? "");
    if (m) {
      const n = Number.parseInt(m[1] ?? "0", 10);
      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
  }
  const next = max + 1;
  return `${WORK_ORDER_PREFIX}${String(next).padStart(3, "0")}`;
}
function todayIso(now = /* @__PURE__ */ new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function buildRecord(doc, params, now = /* @__PURE__ */ new Date()) {
  return {
    workOrder: nextWorkOrder(doc),
    date: params.date?.trim() || todayIso(now),
    confirmedCause: params.confirmedCause.trim(),
    repairAction: params.repairAction.trim(),
    verification: params.verification.trim()
  };
}
function appendRecord(doc, record) {
  const dup = doc.records.some(
    (r) => r.confirmedCause.trim() === record.confirmedCause.trim() && r.repairAction.trim() === record.repairAction.trim() && r.verification.trim() === record.verification.trim()
  );
  if (dup) {
    return { doc, added: false };
  }
  return { doc: { records: [...doc.records, record] }, added: true };
}
async function persistRecord(fs, filePath, params, now = /* @__PURE__ */ new Date()) {
  const exists = await fs.exists(filePath);
  const current = exists ? parseDoc(await fs.readFile(filePath)) : { records: [] };
  const record = buildRecord(current, params, now);
  const { doc: next, added } = appendRecord(current, record);
  if (!added) {
    return { written: false, record };
  }
  await fs.writeFile(filePath, stringifyDoc(next));
  return { written: true, record };
}
async function readRecords(fs, filePath) {
  const exists = await fs.exists(filePath);
  if (!exists) {
    return [];
  }
  return parseDoc(await fs.readFile(filePath)).records;
}
function renderApprovalDescription(record) {
  return [
    "\u68C0\u6D4B\u5230\u4E00\u6761\u5B8C\u6574\u7684\u7EF4\u4FEE\u95ED\u73AF\uFF0C\u662F\u5426\u65B0\u589E\u5230\u5386\u53F2\u7EF4\u4FEE\u8BB0\u5F55\u770B\u677F?",
    "",
    `\u5DE5\u5355\u53F7: ${record.workOrder}`,
    `\u65E5\u671F: ${record.date}`,
    `\u5DF2\u786E\u8BA4\u539F\u56E0: ${record.confirmedCause}`,
    `\u5DF2\u6267\u884C\u7EF4\u4FEE: ${record.repairAction}`,
    `\u590D\u673A\u9A8C\u8BC1: ${record.verification}`
  ].join("\n");
}

// src/approval.ts
function isAllow(decision) {
  return decision === "allow-once" || decision === "allow-always";
}
function buildRequireApproval(params, config, deps, pluginId) {
  const timeoutMs = Math.max(1, config.approvalTimeoutMinutes) * 6e4;
  const preview = {
    workOrder: "WO-240-\u65B0",
    date: params.date?.trim() || "\u5F85\u5B9A",
    confirmedCause: params.confirmedCause.trim(),
    repairAction: params.repairAction.trim(),
    verification: params.verification.trim()
  };
  return {
    title: "\u65B0\u589E\u5386\u53F2\u7EF4\u4FEE\u8BB0\u5F55",
    description: renderApprovalDescription(preview),
    severity: "info",
    timeoutMs,
    timeoutBehavior: config.timeoutBehavior,
    timeoutReason: "\u7EF4\u4FEE\u8BB0\u5F55\u5BA1\u6279\u8D85\u65F6\uFF0C\u672A\u5199\u5165\u770B\u677F\u3002",
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
    throw new Error("record_maintenance: \u7F3A\u5C11\u53C2\u6570\u5BF9\u8C61");
  }
  const p = raw;
  const fields = [
    "confirmedCause",
    "repairAction",
    "verification"
  ];
  for (const f of fields) {
    const v = p[f];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`record_maintenance: \u5B57\u6BB5 ${f} \u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32`);
    }
  }
  const parsed = {
    confirmedCause: p.confirmedCause.trim(),
    repairAction: p.repairAction.trim(),
    verification: p.verification.trim()
  };
  if (typeof p.date === "string" && p.date.trim() !== "") {
    parsed.date = p.date.trim();
  }
  return parsed;
}
function handleBeforeToolCall(input) {
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
  const requireApproval = buildRequireApproval(
    params,
    input.config,
    input.deps,
    input.pluginId
  );
  return { requireApproval };
}
function resolveMaintenancePath(homeDir) {
  const parts = [homeDir, ".openclaw", "workspace-fde", "\u7EF4\u4FEE\u8BB0\u5F55.json"];
  return parts.join("/");
}
var TOOL_NAME = RECORD_TOOL_NAME;

// src/guidance.ts
function buildGuidance() {
  return [
    "## \u5386\u53F2\u7EF4\u4FEE\u8BB0\u5F55\u767B\u8BB0",
    "",
    "\u4F60\u662F\u8BBE\u5907\u8BCA\u65AD FDE\uFF0C\u4F1A\u966A\u7528\u6237\u8D70\u5B8C\u4E00\u6B21\u6392\u969C\u95ED\u73AF\u3002\u5F53\u4E00\u6B21\u5BF9\u8BDD\u91CC\u5DF2\u7ECF\u51D1\u9F50",
    '\u4EE5\u4E0B\u4E09\u8981\u7D20\uFF0C\u4E14\u7528\u6237\u660E\u786E\u8981\u6C42"\u8BB0\u4E00\u6761 / \u767B\u8BB0 / \u5B58\u5165\u5386\u53F2\u7EF4\u4FEE\u8BB0\u5F55"\u65F6\uFF0C',
    "\u4F60\u5FC5\u987B\u8C03\u7528\u5DE5\u5177 `" + RECORD_TOOL_NAME + "` \u628A\u8FD9\u6761\u95ED\u73AF\u7ED3\u6784\u5316\u62BD\u53D6\u51FA\u6765\uFF1A",
    "",
    "\u4E09\u8981\u7D20\uFF08\u7F3A\u4E00\u4E0D\u53EF\uFF09\uFF1A",
    "- \u5DF2\u786E\u8BA4\u539F\u56E0\uFF1A\u672C\u6B21\u6545\u969C\u6700\u7EC8\u5B9A\u4F4D\u5230\u7684\u6839\u56E0\uFF08\u975E\u731C\u6D4B\uFF0C\u662F\u5DF2\u786E\u8BA4\u7684\u7ED3\u8BBA\uFF09\uFF1B",
    "- \u5DF2\u6267\u884C\u7EF4\u4FEE\uFF1A\u4E3A\u6D88\u9664\u8BE5\u6839\u56E0\u5B9E\u9645\u505A\u4E86\u54EA\u4E9B\u5904\u7F6E\u52A8\u4F5C\uFF1B",
    "- \u590D\u673A\u9A8C\u8BC1\uFF1A\u7EF4\u4FEE\u540E\u5982\u4F55\u9A8C\u8BC1\u8BBE\u5907\u6062\u590D\u6B63\u5E38\uFF08\u8BD5\u4EA7\u3001\u8FDE\u7EED\u8FD0\u884C\u3001\u53C2\u6570\u8FBE\u6807\u7B49\uFF09\u3002",
    "",
    "\u3010\u8C03\u7528\u524D\u5148\u67E5\u91CD\u3011\u767B\u8BB0\u524D\u5E94\u5148\u8C03\u7528 `" + READ_TOOL_NAME + "` \u8BFB\u53D6\u5DF2\u6709\u8BB0\u5F55\uFF0C",
    "\u907F\u514D\u628A\u5DF2\u7ECF\u5728\u518C\u7684\u7EF4\u4FEE\u91CD\u590D\u767B\u8BB0\uFF1B\u5DE5\u5355\u53F7\u65E0\u9700\u4F60\u751F\u6210\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u5206\u914D\u3002",
    "",
    "\u8C03\u7528 `" + RECORD_TOOL_NAME + "` \u65F6\u6309\u5982\u4E0B\u89C4\u5219\u586B\u53C2\uFF1A",
    "- confirmedCause\uFF1A\u5DF2\u786E\u8BA4\u539F\u56E0\uFF0C\u7B80\u660E\u627C\u8981\u4E00\u53E5\u8BDD\u3002",
    "- repairAction\uFF1A\u5DF2\u6267\u884C\u7EF4\u4FEE\uFF0C\u8BF4\u660E\u5B9E\u9645\u5904\u7F6E\u52A8\u4F5C\u3002",
    "- verification\uFF1A\u590D\u673A\u9A8C\u8BC1\uFF0C\u8BF4\u660E\u9A8C\u8BC1\u65B9\u5F0F\u4E0E\u7ED3\u679C\u3002",
    "- date\uFF1A\u8BB0\u5F55\u65E5\u671F\uFF0C\u683C\u5F0F YYYY-MM-DD\uFF1B\u4E0D\u786E\u5B9A\u5C31\u7701\u7565\uFF0C\u63D2\u4EF6\u9ED8\u8BA4\u53D6\u5F53\u5929\u3002",
    "",
    "\u6CE8\u610F\uFF1A",
    "- \u53EA\u5728\u4E09\u8981\u7D20\u9F50\u5907\u4E14\u7528\u6237\u660E\u786E\u8981\u6C42\u767B\u8BB0\u65F6\u624D\u8C03\u7528\uFF0C\u4E0D\u8981\u81C6\u9020\u6216\u51D1\u6570\uFF1B",
    "- \u4E09\u8981\u7D20\u5C1A\u672A\u786E\u8BA4\uFF08\u5982\u539F\u56E0\u4ECD\u662F\u5F85\u6392\u67E5\u7684\u731C\u6D4B\uFF09\u65F6\uFF0C\u4E0D\u5F97\u767B\u8BB0\uFF1B",
    "- \u8C03\u7528\u540E\u4F1A\u5F39\u51FA\u4EBA\u5BA1\u786E\u8BA4\u6846\uFF0C\u7531\u7528\u6237\u51B3\u5B9A\u662F\u5426\u5165\u5E93\uFF0C\u4F60\u65E0\u9700\u81EA\u884C\u786E\u8BA4\uFF1B",
    "- \u4E00\u6B21\u5BF9\u8BDD\u82E5\u786E\u8BA4\u4E86\u591A\u6761\u72EC\u7ACB\u7EF4\u4FEE\u95ED\u73AF\uFF0C\u53EF\u591A\u6B21\u8C03\u7528\uFF0C\u6BCF\u6761\u4E00\u6B21\u3002"
  ].join("\n");
}
function buildPromptInjection() {
  return { prependSystemContext: buildGuidance() };
}

// src/tool-schema.ts
var RECORD_MAINTENANCE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    confirmedCause: {
      type: "string",
      description: "\u5DF2\u786E\u8BA4\u539F\u56E0\uFF1A\u672C\u6B21\u6545\u969C\u7ECF\u6392\u67E5\u786E\u8BA4\u7684\u6839\u672C\u539F\u56E0\uFF08\u987B\u4E3A\u5DF2\u786E\u8BA4\u4E8B\u5B9E\uFF0C\u975E\u63A8\u6D4B\uFF09"
    },
    repairAction: {
      type: "string",
      description: "\u5DF2\u6267\u884C\u7EF4\u4FEE\uFF1A\u6388\u6743\u4EBA\u5458\u5B9E\u9645\u5B8C\u6210\u7684\u7EF4\u4FEE\u52A8\u4F5C"
    },
    verification: {
      type: "string",
      description: "\u590D\u673A\u9A8C\u8BC1\uFF1A\u7EF4\u4FEE\u540E\u590D\u673A\u8FD0\u884C\u7684\u9A8C\u8BC1\u7ED3\u679C\u4E0E\u5224\u5B9A\u4F9D\u636E"
    },
    date: {
      type: "string",
      description: "\u8BB0\u5F55\u65E5\u671F\uFF0C\u683C\u5F0F YYYY-MM-DD\u3002\u7701\u7565\u65F6\u9ED8\u8BA4\u53D6\u5F53\u5929\u3002"
    }
  },
  required: ["confirmedCause", "repairAction", "verification"]
};
var READ_MAINTENANCE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: []
};

export { DEFAULT_CONFIG, READ_MAINTENANCE_PARAMETERS, READ_TOOL_NAME, RECORD_MAINTENANCE_PARAMETERS, RECORD_TOOL_NAME, TOOL_NAME, appendRecord, buildGuidance, buildPromptInjection, buildRecord, buildRequireApproval, handleBeforeToolCall, isRecordTool, nextWorkOrder, parseDoc, parseToolParams, persistRecord, readRecords, renderApprovalDescription, resolveConfig, resolveMaintenancePath, stringifyDoc };
