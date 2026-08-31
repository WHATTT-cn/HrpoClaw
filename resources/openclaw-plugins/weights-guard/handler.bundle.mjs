// ../../shared/src/index.ts
function allow(params) {
  return params ? { kind: "allow", params } : { kind: "allow" };
}
function block(reason) {
  return { kind: "block", reason };
}
function failClosed(label, run) {
  try {
    const decision = run();
    if (decision.kind !== "allow" && decision.kind !== "block") {
      return block(`${label}: \u975E\u6CD5\u51B3\u7B56\uFF0C\u5DF2 fail-closed`);
    }
    return decision;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return block(`${label}: \u95F8\u95E8\u5F02\u5E38\u5DF2 fail-closed\uFF08${detail}\uFF09`);
  }
}

// src/gates/injection.ts
var DEFAULT_INJECTION_PATTERNS = [
  // ① 指令劫持
  /ignore\s+(?:the\s+)?(?:previous|above|prior|preceding)\s+instructions?/i,
  /disregard\s+(?:the\s+)?(?:previous|above)/i,
  /忽略(?:以上|上面|前面|之前)(?:的)?(?:所有)?指令/,
  // ② 角色重置
  /you\s+are\s+now\b/i,
  /from\s+now\s+on[,\s]+you\s+are\b/i,
  /现在(?:起)?你(?:现在)?是/,
  /重新设定(?:你的)?(?:角色|身份|设定)/,
  // ③ 系统伪装
  /(?:^|\n)\s*system\s*[:：]/i,
  /[\[<]\s*system\s*[\]>]/i,
  /(?:^|\n)\s*assistant\s*[:：]/i,
  // ④ 越权动作
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\brun\s+command\b/i,
  /\bexecute\s+(?:the\s+)?(?:command|shell|code)\b/i
];
function collectFreeTexts(adj) {
  const texts = [];
  const quote = adj?.case_evidence?.\u539F\u6587\u5F15\u7528;
  if (typeof quote === "string") texts.push(quote);
  const pe = adj?.profile_evidence;
  if (pe) {
    if (typeof pe.\u4F9B\u5E94\u5546 === "string") texts.push(pe.\u4F9B\u5E94\u5546);
    if (typeof pe.\u6307\u6807 === "string") texts.push(pe.\u6307\u6807);
  }
  if (typeof adj?.dimension === "string") texts.push(adj.dimension);
  return texts;
}
function injectionGate(adjustments, patterns = DEFAULT_INJECTION_PATTERNS) {
  return failClosed("injection", () => {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return block("injection: \u6CE8\u5165\u6A21\u5F0F\u96C6\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u8FC7\u6EE4\uFF08fail-closed\uFF09");
    }
    if (!Array.isArray(adjustments)) {
      return block("injection: adjustments \u975E\u6570\u7EC4");
    }
    for (const adj of adjustments) {
      for (const text of collectFreeTexts(adj)) {
        for (const re of patterns) {
          if (re.test(text)) {
            return block(
              `injection: \u7EF4\u5EA6\u300C${String(adj?.dimension)}\u300D\u6587\u672C\u547D\u4E2D\u6CE8\u5165\u7279\u5F81 ${re}`
            );
          }
        }
      }
    }
    return allow();
  });
}

// src/gates/whitelist.ts
function whitelistGate(adjustments, allowedDimensions) {
  return failClosed("whitelist", () => {
    if (!Array.isArray(allowedDimensions) || allowedDimensions.length === 0) {
      return block("whitelist: \u7EF4\u5EA6\u767D\u540D\u5355\u4E3A\u7A7A/\u975E\u6CD5\uFF0C\u62D2\u7EDD\u4E00\u5207\u8C03\u6574");
    }
    if (!Array.isArray(adjustments)) {
      return block("whitelist: adjustments \u975E\u6570\u7EC4");
    }
    const allowed = new Set(
      allowedDimensions.filter((d) => typeof d === "string" && d.length > 0)
    );
    if (allowed.size === 0) {
      return block("whitelist: \u767D\u540D\u5355\u65E0\u6709\u6548\u7EF4\u5EA6");
    }
    for (const adj of adjustments) {
      const dim = adj?.dimension;
      if (typeof dim !== "string" || dim.length === 0) {
        return block(`whitelist: \u975E\u6CD5\u7EF4\u5EA6\u540D\uFF08${String(dim)}\uFF09`);
      }
      if (!allowed.has(dim)) {
        return block(`whitelist: \u7EF4\u5EA6\u300C${dim}\u300D\u4E0D\u5728\u5141\u8BB8\u767D\u540D\u5355\u5185`);
      }
    }
    return allow();
  });
}

// src/gates/amplitude.ts
function amplitudeGate(adjustments, amplitudeRange) {
  return failClosed("amplitude", () => {
    if (!Number.isFinite(amplitudeRange) || amplitudeRange <= 0) {
      return block(`amplitude: \u975E\u6CD5\u5E45\u5EA6\u4E0A\u9650 amplitudeRange=${amplitudeRange}`);
    }
    if (!Array.isArray(adjustments)) {
      return block("amplitude: adjustments \u975E\u6570\u7EC4");
    }
    for (const adj of adjustments) {
      const delta = adj?.delta;
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        return block(
          `amplitude: \u7EF4\u5EA6 ${String(adj?.dimension)} \u7684 delta \u975E\u6709\u9650\u6570\uFF08${String(delta)}\uFF09`
        );
      }
      if (Math.abs(delta) > amplitudeRange) {
        return block(
          `amplitude: \u7EF4\u5EA6 ${adj.dimension} \u8C03\u6574\u5E45\u5EA6 ${delta} \u8D85\u8FC7\u4E0A\u9650 \xB1${amplitudeRange}`
        );
      }
    }
    return allow();
  });
}

// src/gates/evidence.ts
function evidenceGate(adjustments, ctx) {
  return failClosed("evidence", () => {
    if (!ctx || typeof ctx.caseRawText !== "string") {
      return block("evidence: \u7F3A\u5C11\u6848\u5377\u539F\u6587\u4E0A\u4E0B\u6587");
    }
    if (!Number.isFinite(ctx.tolerance) || ctx.tolerance < 0) {
      return block(`evidence: \u975E\u6CD5\u5BB9\u5DEE tolerance=${String(ctx?.tolerance)}`);
    }
    if (!ctx.profileCache || typeof ctx.profileCache !== "object") {
      return block("evidence: \u7F3A\u5C11\u753B\u50CF\u7F13\u5B58\u4E0A\u4E0B\u6587");
    }
    if (!Array.isArray(adjustments)) {
      return block("evidence: adjustments \u975E\u6570\u7EC4");
    }
    for (const adj of adjustments) {
      const dim = String(adj?.dimension);
      const quote = adj?.case_evidence?.\u539F\u6587\u5F15\u7528;
      if (typeof quote !== "string" || quote.length === 0) {
        return block(`evidence: \u7EF4\u5EA6\u300C${dim}\u300D\u7F3A case_evidence.\u539F\u6587\u5F15\u7528`);
      }
      if (!ctx.caseRawText.includes(quote)) {
        return block(`evidence: \u7EF4\u5EA6\u300C${dim}\u300D\u7684\u539F\u6587\u5F15\u7528\u4E0D\u5728\u6848\u5377\u539F\u6587\u4E2D\uFF08\u7591\u4F3C\u7F16\u9020\uFF09`);
      }
      const pe = adj?.profile_evidence;
      if (!pe || typeof pe.\u4F9B\u5E94\u5546 !== "string" || typeof pe.\u6307\u6807 !== "string") {
        return block(`evidence: \u7EF4\u5EA6\u300C${dim}\u300D\u7F3A profile_evidence\uFF08\u4F9B\u5E94\u5546/\u6307\u6807\uFF09`);
      }
      if (typeof pe.\u6570\u503C !== "number" || !Number.isFinite(pe.\u6570\u503C)) {
        return block(`evidence: \u7EF4\u5EA6\u300C${dim}\u300Dprofile_evidence.\u6570\u503C \u975E\u6709\u9650\u6570`);
      }
      const truth = ctx.profileCache[pe.\u4F9B\u5E94\u5546]?.[pe.\u6307\u6807];
      if (typeof truth !== "number" || !Number.isFinite(truth)) {
        return block(`evidence: \u753B\u50CF\u5E93\u65E0\u300C${pe.\u4F9B\u5E94\u5546}.${pe.\u6307\u6807}\u300D\uFF08\u7591\u4F3C\u7F16\u9020\uFF09`);
      }
      if (Math.abs(pe.\u6570\u503C - truth) > ctx.tolerance) {
        return block(
          `evidence: \u300C${pe.\u4F9B\u5E94\u5546}.${pe.\u6307\u6807}\u300D\u6570\u503C ${pe.\u6570\u503C} \u4E0E\u753B\u50CF\u5E93 ${truth} \u8D85\u5BB9\u5DEE ${ctx.tolerance}`
        );
      }
    }
    return allow();
  });
}

// src/gates/normalize.ts
function normalizeGate(base, deltas) {
  return failClosed("normalize", () => {
    if (!Array.isArray(base) || !Array.isArray(deltas)) {
      return block("normalize: base/deltas \u975E\u6570\u7EC4");
    }
    if (base.length !== deltas.length) {
      return block(`normalize: base(${base.length})/deltas(${deltas.length}) \u957F\u5EA6\u4E0D\u7B49`);
    }
    if (base.length === 0) {
      return block("normalize: \u7A7A\u6743\u91CD\u5411\u91CF");
    }
    const w = new Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const b = base[i];
      const d = deltas[i];
      if (typeof b !== "number" || !Number.isFinite(b)) {
        return block(`normalize: base[${i}] \u975E\u6709\u9650\u6570\uFF08${String(b)}\uFF09`);
      }
      if (typeof d !== "number" || !Number.isFinite(d)) {
        return block(`normalize: deltas[${i}] \u975E\u6709\u9650\u6570\uFF08${String(d)}\uFF09`);
      }
      w[i] = b + d;
    }
    const sum = w.reduce((a, x) => a + x, 0);
    if (!Number.isFinite(sum) || sum <= 0) {
      return block(`normalize: \u6743\u91CD\u548C\u975E\u6B63\uFF08sum=${sum}\uFF09\uFF0C\u65E0\u6CD5\u5F52\u4E00\u5316`);
    }
    const weights = w.map((x) => {
      const n = x / sum;
      return Math.min(1, Math.max(0, n));
    });
    return allow({ weights });
  });
}

// src/pipeline.ts
function toDeltaVector(adjustments, length) {
  const deltas = new Array(length).fill(0);
  adjustments.forEach((adj, i) => {
    if (i < length && typeof adj?.delta === "number") deltas[i] = adj.delta;
  });
  return deltas;
}
function runAllGates(input) {
  return failClosed("pipeline", () => {
    if (!input || typeof input !== "object") {
      return block("pipeline: \u8F93\u5165\u975E\u6CD5");
    }
    const {
      adjustments,
      baseWeights,
      allowedDimensions,
      context,
      amplitudeRange,
      injectionPatterns = DEFAULT_INJECTION_PATTERNS
    } = input;
    const g5 = injectionGate(adjustments, injectionPatterns);
    if (g5.kind === "block") return g5;
    const g3 = whitelistGate(adjustments, allowedDimensions);
    if (g3.kind === "block") return g3;
    const g1 = amplitudeGate(adjustments, amplitudeRange);
    if (g1.kind === "block") return g1;
    const g4 = evidenceGate(adjustments, context);
    if (g4.kind === "block") return g4;
    if (!Array.isArray(baseWeights)) {
      return block("pipeline: baseWeights \u975E\u6570\u7EC4");
    }
    if (Array.isArray(adjustments) && adjustments.length > baseWeights.length) {
      return block(
        `pipeline: \u63D0\u6848\u6570(${adjustments.length}) \u8D85\u8FC7\u57FA\u51C6\u7EF4\u5EA6\u6570(${baseWeights.length})\uFF0C\u62D2\u7EDD\uFF08fail-closed\uFF09`
      );
    }
    const deltas = toDeltaVector(adjustments, baseWeights.length);
    const g2 = normalizeGate(baseWeights, deltas);
    if (g2.kind === "block") return g2;
    const weights = g2.params?.["weights"];
    if (!Array.isArray(weights)) {
      return block("pipeline: normalize \u672A\u4EA7\u51FA\u5408\u6CD5 weights\uFF08fail-closed\uFF09");
    }
    return allow({ weights });
  });
}

// src/handler.ts
var DEFAULT_CONFIG = {
  amplitudeRange: 0.1,
  evidenceTolerance: 1e-3,
  approvalTimeoutMinutes: 30,
  fallbackToAlgorithm: true
};
function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
}
function buildInput(params, config) {
  const adjustments = Array.isArray(params["adjustments"]) ? params["adjustments"] : [];
  const baseWeights = Array.isArray(params["baseWeights"]) ? params["baseWeights"] : [];
  const allowedDimensions = Array.isArray(params["allowedDimensions"]) ? params["allowedDimensions"] : [];
  const caseRawText = typeof params["caseRawText"] === "string" ? params["caseRawText"] : "";
  const profileCache = asRecord(params["profileCache"]) ?? {};
  const context = {
    caseRawText,
    profileCache,
    tolerance: config.evidenceTolerance
  };
  return {
    adjustments,
    baseWeights,
    allowedDimensions,
    context,
    amplitudeRange: config.amplitudeRange
  };
}
function decideFromParams(params, config = DEFAULT_CONFIG) {
  return failClosed("handler", () => {
    const rec = asRecord(params);
    if (!rec) return block("handler: \u5DE5\u5177\u5165\u53C2\u975E\u6CD5\uFF08fail-closed\uFF09");
    return runAllGates(buildInput(rec, config));
  });
}
function toHookResult(decision, originalParams) {
  if (decision.kind === "block") {
    return { block: true, blockReason: decision.reason };
  }
  const weights = decision.params?.["weights"];
  if (Array.isArray(weights)) {
    return { params: { ...originalParams, weights } };
  }
  return void 0;
}
function handleBeforeToolCall(params, config = DEFAULT_CONFIG) {
  const original = asRecord(params) ?? {};
  const decision = decideFromParams(params, config);
  return toHookResult(decision, original);
}

export { DEFAULT_CONFIG, handleBeforeToolCall };
