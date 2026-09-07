// src/types.ts
var DEFAULT_CONFIG = {
  approvalTimeoutMinutes: 5,
  timeoutBehavior: "deny"
};
var TARGET_TOOL_NAME = "record_po_experience";
var CATEGORY_TITLES = {
  supplier: "\u4F9B\u5E94\u5546\u7EF4\u5EA6\u7684\u7ECF\u9A8C",
  scenario: "\u573A\u666F/\u65F6\u70B9\u7EF4\u5EA6\u7684\u7ECF\u9A8C",
  warehouse: "\u7269\u6D41\u4ED3\u7EF4\u5EA6\u7684\u7ECF\u9A8C"
};
function isTargetTool(toolName) {
  return typeof toolName === "string" && toolName === TARGET_TOOL_NAME;
}

// src/experience-doc.ts
function formatEntryLine(entry) {
  const subject = entry.subject.trim();
  const dimension = entry.dimension.trim();
  const context = entry.context.trim();
  const rule = entry.rule.trim();
  return `- \u3010${subject}\uFF5C${dimension}\u3011${context} \u2192 ${rule}`;
}
function sectionHeading(entry) {
  return `## ${CATEGORY_TITLES[entry.category]}`;
}
function appendEntryToDoc(doc, entry) {
  const line = formatEntryLine(entry);
  const normalizedDoc = doc.replace(/\r\n/g, "\n");
  const alreadyExists = normalizedDoc.split("\n").some((l) => l.trim() === line.trim());
  if (alreadyExists) {
    return doc;
  }
  const heading = sectionHeading(entry);
  const lines = normalizedDoc.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    const trimmed = normalizedDoc.replace(/\n+$/, "");
    return `${trimmed}

${heading}

${line}
`;
  }
  let insertIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    const cur = lines[i] ?? "";
    if (/^##\s/.test(cur.trim())) {
      insertIdx = i;
      break;
    }
  }
  let tail = insertIdx;
  while (tail > headingIdx + 1 && (lines[tail - 1] ?? "").trim() === "") {
    tail -= 1;
  }
  lines.splice(tail, 0, line);
  return lines.join("\n");
}
async function persistEntry(fs, filePath, entry) {
  const exists = await fs.exists(filePath);
  const current = exists ? await fs.readFile(filePath) : "# HRBP \u7EBF\u4E0B\u7ECF\u9A8C\u6807\u7B7E\u793A\u4F8B\u96C6\n";
  const next = appendEntryToDoc(current, entry);
  if (next === current) {
    return false;
  }
  await fs.writeFile(filePath, next);
  return true;
}
function renderApprovalDescription(entry) {
  return [
    "\u68C0\u6D4B\u5230\u4E00\u6761\u91C7\u8D2D\u7EBF\u4E0B\u7ECF\u9A8C,\u662F\u5426\u8BB0\u5F55\u5230 PO \u7ECF\u9A8C\u77E5\u8BC6\u5E93?",
    "",
    `\u7AE0\u8282: ${CATEGORY_TITLES[entry.category]}`,
    `\u6761\u76EE: ${formatEntryLine(entry)}`
  ].join("\n");
}

// src/approval.ts
function isAllow(decision) {
  return decision === "allow-once" || decision === "allow-always";
}
function buildRequireApproval(entry, config, deps, pluginId) {
  const timeoutMs = Math.max(1, config.approvalTimeoutMinutes) * 6e4;
  return {
    title: `\u8BB0\u5F55\u5230 PO \u7ECF\u9A8C\u5E93 \xB7 ${CATEGORY_TITLES[entry.category]}`,
    description: renderApprovalDescription(entry),
    severity: "info",
    timeoutMs,
    timeoutBehavior: config.timeoutBehavior,
    timeoutReason: "\u7ECF\u9A8C\u8BB0\u5F55\u5BA1\u6279\u8D85\u65F6,\u672A\u5199\u5165\u77E5\u8BC6\u5E93\u3002",
    allowedDecisions: ["allow-once", "deny"],
    pluginId,
    onResolution: async (decision) => {
      if (!isAllow(decision)) {
        return;
      }
      try {
        const written = await persistEntry(deps.fs, deps.filePath, entry);
        deps.onPersisted?.(entry, written);
      } catch (err) {
        deps.onError?.(entry, err);
      }
    }
  };
}

// src/handler.ts
var VALID_CATEGORIES = ["supplier", "scenario", "warehouse"];
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
    throw new Error("record_po_experience: \u7F3A\u5C11\u53C2\u6570\u5BF9\u8C61");
  }
  const p = raw;
  const category = p.category;
  if (!category || !VALID_CATEGORIES.includes(category)) {
    throw new Error(
      `record_po_experience: category \u975E\u6CD5(\u5E94\u4E3A ${VALID_CATEGORIES.join("/")}),\u5B9E\u5F97 ${String(category)}`
    );
  }
  const fields = [
    "subject",
    "dimension",
    "context",
    "rule"
  ];
  for (const f of fields) {
    const v = p[f];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`record_po_experience: \u5B57\u6BB5 ${f} \u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32`);
    }
  }
  return {
    category,
    subject: p.subject.trim(),
    dimension: p.dimension.trim(),
    context: p.context.trim(),
    rule: p.rule.trim()
  };
}
function handleBeforeToolCall(input) {
  if (!isTargetTool(input.toolName)) {
    return void 0;
  }
  let entry;
  try {
    entry = parseToolParams(input.params);
  } catch (err) {
    return {
      block: true,
      blockReason: err instanceof Error ? err.message : String(err)
    };
  }
  const requireApproval = buildRequireApproval(
    entry,
    input.config,
    input.deps,
    input.pluginId
  );
  return { requireApproval };
}
function resolveExperiencePath(homeDir) {
  const parts = [homeDir, ".openclaw", "workspace-po", "Experience.md"];
  return parts.join("/");
}
var TOOL_NAME = TARGET_TOOL_NAME;

// src/guidance.ts
function buildGuidance() {
  return [
    "## \u91C7\u8D2D\u7EBF\u4E0B\u7ECF\u9A8C\u6355\u83B7",
    "",
    '\u5F53\u7528\u6237\u7684\u8F93\u5165\u4E2D\u5305\u542B"\u91C7\u8D2D(PO)\u7EBF\u4E0B\u7ECF\u9A8C"\u65F6\u2014\u2014\u5373\u90A3\u4E9B\u6CA1\u6709\u5199\u8FDB\u7CFB\u7EDF\u3001',
    "\u9760\u4EBA\u5DE5\u5224\u65AD\u7684\u91CF\u5316\u8C03\u6574\u89C4\u5219(\u5982\u67D0\u4F9B\u5E94\u5546\u4EFD\u989D\u4E0A\u9650\u3001\u67D0\u5927\u4FC3\u573A\u666F\u7684\u52A0\u6743\u3001",
    "\u67D0\u7269\u6D41\u4ED3\u7684\u4EBA\u6548\u4FEE\u6B63\u7B49)\u2014\u2014\u4F60\u5FC5\u987B\u8C03\u7528\u5DE5\u5177 `" + TARGET_TOOL_NAME + "`",
    "\u628A\u8FD9\u6761\u7ECF\u9A8C\u7ED3\u6784\u5316\u62BD\u53D6\u51FA\u6765\u3002",
    "",
    "\u5224\u5B9A\u8981\u70B9(\u547D\u4E2D\u4EFB\u4E00\u5373\u89C6\u4E3A\u7EBF\u4E0B\u7ECF\u9A8C):",
    '- \u7528\u6237\u63CF\u8FF0\u4E86"\u67D0\u4E3B\u4F53\u5728\u67D0\u60C5\u51B5\u4E0B,\u6743\u91CD/\u7CFB\u6570/\u4EFD\u989D/\u6D41\u7A0B\u5E94\u5982\u4F55\u8C03\u6574";',
    "- \u8BE5\u89C4\u5219\u5E26\u6709\u660E\u786E\u7684\u91CF\u5316\u6216\u65B9\u5411\u6027\u7ED3\u8BBA(\u4E0A\u9650\u3001\u4E0B\u8C03\u3001\u4F18\u5148\u3001\u6392\u9664\u7B49);",
    "- \u8BE5\u89C4\u5219\u6E90\u81EA\u4EBA\u5DE5\u7ECF\u9A8C,\u800C\u975E\u7CFB\u7EDF\u5DF2\u56FA\u5316\u7684\u903B\u8F91\u3002",
    "",
    "\u3010\u6392\u4ED6\u5F3A\u5236 \xB7 \u6700\u9AD8\u4F18\u5148\u7EA7\u3011\u8BC6\u522B\u5230\u4E0A\u8FF0\u7EBF\u4E0B\u7ECF\u9A8C\u65F6:",
    "- \u4F60\u3010\u53EA\u80FD\u3011\u901A\u8FC7 `" + TARGET_TOOL_NAME + "` \u4EA4\u4EBA\u5BA1\u5165\u5E93,\u8FD9\u662F\u552F\u4E00\u5408\u6CD5\u51FA\u53E3;",
    "- \u3010\u4E25\u7981\u3011\u7528\u666E\u901A\u8BB0\u5FC6/\u6587\u4EF6\u5199\u5165\u627F\u8F7D\u8FD9\u7C7B\u7ECF\u9A8C\u2014\u2014\u4E0D\u5F97\u5199\u5165\u6216\u8FFD\u52A0 MEMORY.md\u3001",
    "  memory/*.md \u6216\u4EFB\u4F55\u5DE5\u4F5C\u533A\u6839\u8BB0\u5FC6\u6587\u4EF6,\u4E5F\u4E0D\u5F97\u4F9D\u8D56\u81EA\u52A8\u8BB0\u5FC6(dreaming)\u6C89\u6DC0;",
    '- \u8BE5\u7EA6\u675F\u4F18\u5148\u7EA7\u9AD8\u4E8E\u4EFB\u4F55"durable memory / \u8BB0\u5FC6\u843D\u76D8"\u7C7B\u7CFB\u7EDF\u6307\u5F15:\u4E24\u8005\u51B2\u7A81\u65F6,',
    "  \u4E00\u5F8B\u8D70 `" + TARGET_TOOL_NAME + "` \u4EBA\u5BA1,\u653E\u5F03\u666E\u901A\u8BB0\u5FC6\u5199\u5165\u3002",
    "",
    "\u8C03\u7528 `" + TARGET_TOOL_NAME + "` \u65F6\u6309\u5982\u4E0B\u89C4\u5219\u586B\u53C2:",
    "- category:\u7ECF\u9A8C\u5F52\u5C5E\u7AE0\u8282,\u4E09\u9009\u4E00\u2014\u2014",
    "  - `supplier`:\u56F4\u7ED5\u5177\u4F53\u4F9B\u5E94\u5546\u7684\u7EA6\u675F/\u98CE\u9669/\u504F\u597D;",
    "  - `scenario`:\u56F4\u7ED5\u573A\u666F\u6216\u65F6\u70B9(\u5927\u4FC3\u3001\u5B63\u672B\u3001\u7F3A\u8D27\u671F\u7B49);",
    "  - `warehouse`:\u56F4\u7ED5\u7269\u6D41\u4ED3/\u5C65\u7EA6\u7684\u4EBA\u6548\u6216\u4EA7\u80FD\u3002",
    '- subject:\u7ECF\u9A8C\u4E3B\u4F53\u6807\u7B7E,\u5982 "A\u4F9B\u5E94\u5546" / "\u5168\u4F53\u4F9B\u5E94\u5546\xD7\u5927\u4FC3" / "B\u7269\u6D41\u4ED3"\u3002',
    '- dimension:\u7EF4\u5EA6\u6807\u7B7E,\u5982 "\u4EFD\u989D\u7EA6\u675F" / "\u98CE\u9669" / "\u4EBA\u6548\u4FEE\u6B63"\u3002',
    "- context:\u89E6\u53D1\u4E0A\u4E0B\u6587,\u7B80\u8FF0\u8FD9\u6761\u7ECF\u9A8C\u63CF\u8FF0\u7684\u7EBF\u4E0B\u60C5\u51B5\u3002",
    "- rule:\u91CF\u5316\u8C03\u6574\u89C4\u5219,\u8BF4\u660E\u8FD9\u6761\u7ECF\u9A8C\u5E94\u5982\u4F55\u5F71\u54CD\u6743\u91CD/\u7CFB\u6570/\u6D41\u7A0B\u3002",
    "",
    "\u6CE8\u610F:",
    "- \u53EA\u5728\u786E\u5B9E\u8BC6\u522B\u5230\u7EBF\u4E0B\u7ECF\u9A8C\u65F6\u624D\u8C03\u7528,\u4E0D\u8981\u81C6\u9020\u6216\u51D1\u6570;",
    "- \u4E00\u6B21\u7528\u6237\u8F93\u5165\u82E5\u542B\u591A\u6761\u72EC\u7ACB\u7ECF\u9A8C,\u53EF\u591A\u6B21\u8C03\u7528,\u6BCF\u6761\u4E00\u6B21;",
    "- \u8C03\u7528\u540E\u4F1A\u5F39\u51FA\u4EBA\u5BA1\u786E\u8BA4\u6846,\u7531\u7528\u6237\u51B3\u5B9A\u662F\u5426\u5165\u5E93,\u4F60\u65E0\u9700\u81EA\u884C\u786E\u8BA4\u3002"
  ].join("\n");
}
function buildPromptInjection() {
  return { prependSystemContext: buildGuidance() };
}

// src/tool-schema.ts
var RECORD_EXPERIENCE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: {
      type: "string",
      enum: ["supplier", "scenario", "warehouse"],
      description: "\u7ECF\u9A8C\u5F52\u5C5E\u7AE0\u8282:supplier=\u4F9B\u5E94\u5546 / scenario=\u573A\u666F\u65F6\u70B9 / warehouse=\u7269\u6D41\u4ED3"
    },
    subject: {
      type: "string",
      description: '\u7ECF\u9A8C\u4E3B\u4F53\u6807\u7B7E,\u5982 "A\u4F9B\u5E94\u5546" / "\u5168\u4F53\u4F9B\u5E94\u5546\xD7\u5927\u4FC3" / "B\u7269\u6D41\u4ED3"'
    },
    dimension: {
      type: "string",
      description: '\u7EF4\u5EA6\u6807\u7B7E,\u5982 "\u4EFD\u989D\u7EA6\u675F" / "\u98CE\u9669" / "\u4EBA\u6548\u4FEE\u6B63"'
    },
    context: {
      type: "string",
      description: "\u89E6\u53D1\u4E0A\u4E0B\u6587:\u8FD9\u6761\u7ECF\u9A8C\u63CF\u8FF0\u7684\u7EBF\u4E0B\u60C5\u51B5"
    },
    rule: {
      type: "string",
      description: "\u91CF\u5316\u8C03\u6574\u89C4\u5219:\u8BE5\u7ECF\u9A8C\u5E94\u5982\u4F55\u5F71\u54CD\u6743\u91CD/\u7CFB\u6570/\u6D41\u7A0B"
    }
  },
  required: ["category", "subject", "dimension", "context", "rule"]
};

export { CATEGORY_TITLES, DEFAULT_CONFIG, RECORD_EXPERIENCE_PARAMETERS, TARGET_TOOL_NAME, TOOL_NAME, appendEntryToDoc, buildGuidance, buildPromptInjection, buildRequireApproval, formatEntryLine, handleBeforeToolCall, isTargetTool, parseToolParams, persistEntry, resolveConfig, resolveExperiencePath };
