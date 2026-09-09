/**
 * equipment-guard 薄入口（A 路本地内建插件）。
 *
 * 职责边界：本文件仅做「接线」，不含业务逻辑。
 * 插件为纯提示词指引型（仿照重构后的 weights-guard）：
 * - 不注册工具、不拦截调用、不做人审。
 * - 唯一作用：为 FDE agent 系统上下文注入设备故障诊断强制流程指引，
 *   要求回答前读取《自动封装说明书.md》并按 8 字段结构原文回显证据、遵守安全红线。
 *
 * 指引正文由 monorepo 源码（openclaw-guard-suite/plugins/equipment-guard/src/guidance.ts）
 * 经 tsup 打包为 handler.bundle.mjs 后在此 import。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPromptInjection } from "./handler.bundle.mjs";

const PLUGIN_ID = "equipment-guard";

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Equipment Guard",
  description:
    "Inject APX-240 equipment fault-diagnosis guidance: read the authoritative manual and echo real evidence in the required 8-field structure before answering.",
  register(api) {
    // before_prompt_build 真身契约：返回 { prependSystemContext } 追加到系统上下文。
    // 静态规则文本、不含现场数据，可被 provider 缓存，零 per-turn 成本。
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