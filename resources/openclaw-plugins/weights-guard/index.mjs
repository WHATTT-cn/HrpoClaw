/**
 * weights-guard 薄入口（A 路本地内建插件，重构后）。
 *
 * 职责边界：本文件仅做「接线」，不含业务逻辑。
 * 插件已从「before_tool_call 五闸拦截」重构为「before_prompt_build 纯提示词指引」：
 * - 不注册工具、不拦截调用、不做人审。
 * - 唯一作用： PO agent 系统上下文注入用工决策强制流程指引，
 *   要求回答前读取《供应商画像.md》与《Experience.md》并原文回显真实事实。
 *
 * 指引正文由 monorepo 源码（openclaw-guard-suite/plugins/weights-guard/src/guidance.ts）
 * 经 tsup 打包为 handler.bundle.mjs 后在此 import。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPromptInjection } from "./handler.bundle.mjs";

const PLUGIN_ID = "weights-guard";

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Weights Guard",
  description:
    "Inject PO workforce-decision guidance: read authoritative portrait/experience docs and echo real facts before answering.",
  register(api) {
    // before_prompt_build 真身契约：返回 { prependSystemContext } 追加到系统上下文。
    // 静态规则文本、不含用户数据，可被 provider 缓存，零 per-turn 成本。
    api.registerHook("before_prompt_build", async () => {
      try {
        return buildPromptInjection();
      } catch {
        // 指引注入失败不应阻断对话：静默降级不注入。
        return undefined;
      }
    });
  },
});

export default pluginEntry;