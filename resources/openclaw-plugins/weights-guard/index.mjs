/**
 * weights-guard 薄入口（A 路本地内建插件）。
 *
 * 职责边界（Q6）：本文件仅做「接线」，不含任何业务逻辑。
 * 五道闸门核心逻辑全部在 monorepo（openclaw-guard-suite/plugins/weights-guard），
 * 经 tsup 打包成自包含的 handler.bundle.mjs（零运行时依赖）由此处 import。
 *
 * 接线要点：
 * 1. definePluginEntry 定义插件入口；register(api) 内注册 before_tool_call hook。
 * 2. 上游 hook 真身契约（记忆 project_openclaw_hook_contract 实测固化）：
 *    - return(void)               → 放行
 *    - return {block, blockReason} → 拦截
 *    - return {params:{...}}       → 改写入参后放行
 * 3. 插件配置从 api.pluginConfig（可选 Record）浅合并进 DEFAULT_CONFIG。
 * 4. 安全红线（全局规则 5）：任何异常一律 fail-closed（拦截），绝不「出错就放行」。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  handleBeforeToolCall,
  DEFAULT_CONFIG,
} from "./handler.bundle.mjs";

const PLUGIN_ID = "weights-guard";

/** 把 api.pluginConfig 里的已知数值/布尔项浅合并进默认配置，未知项忽略。 */
function resolveConfig(pluginConfig) {
  const cfg = { ...DEFAULT_CONFIG };
  if (pluginConfig && typeof pluginConfig === "object") {
    const { amplitudeRange, evidenceTolerance, approvalTimeoutMinutes, fallbackToAlgorithm } =
      pluginConfig;
    if (typeof amplitudeRange === "number") cfg.amplitudeRange = amplitudeRange;
    if (typeof evidenceTolerance === "number") cfg.evidenceTolerance = evidenceTolerance;
    if (typeof approvalTimeoutMinutes === "number") cfg.approvalTimeoutMinutes = approvalTimeoutMinutes;
    if (typeof fallbackToAlgorithm === "boolean") cfg.fallbackToAlgorithm = fallbackToAlgorithm;
  }
  return cfg;
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Weights Guard",
  description:
    "Fail-closed safety gates for compliance weight adjustments: LLM proposes, code is law.",
  register(api) {
    const config = resolveConfig(api?.pluginConfig);

    api.registerHook("before_tool_call", async (event) => {
          try {
        // 上游事件真身：{ toolName, params, ... }。
        // toolName 守卫（Q-A 白名单式）由 handleBeforeToolCall 内部执行：
        // 仅 submit_proposal 进五闸，其余工具及 toolName 缺失一律放行（返回 undefined）。
        const params = event?.params ?? {};
        const result = handleBeforeToolCall(params, config, event?.toolName);

        // 中性 HookResult → 上游真身：
        if (result?.block) {
          return { block: true, blockReason: result.blockReason };
        }
        if (result?.params) {
          return { params: result.params };
        }
        // 无改写、无拦截 → 放行。
        return undefined;
      } catch (err) {
        // fail-closed：接线层任何异常一律拦截，绝不放行。
        return {
          block: true,
          blockReason: `weights-guard 接线层异常，已 fail-closed 拦截：${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    });
  },
});

export default pluginEntry;