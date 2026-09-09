/**
 * todo-guard 薄入口（A 路本地内建插件，纯指引型）。
 *
 * 职责边界：本文件仅做「接线」，不含业务逻辑。
 * 纯 before_prompt_build 提示词指引：
 * - 不注册工具、不拦截调用、不做人审。
 * - 唯一作用：向 assistant agent 系统上下文注入「桌面助手一句话代办」四铁律
 *   （边界 / 流程 / 记录 / 异常），教模型识别边界、先计划后执行、每步落执行记录、
 *   异常即停，并触发 task-ledger 的 record_task_step / read_task_ledger 工具。
 *
 * 指引正文由 monorepo 源码（openclaw-guard-suite/plugins/todo-guard/src/guidance.ts）
 * 经 tsup 打包为 handler.bundle.mjs 后在此 import。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPromptInjection } from "./handler.bundle.mjs";

const PLUGIN_ID = "todo-guard";

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Todo Guard",
  description:
    "Inject desktop-assistant operating discipline (boundary / plan-first / per-step ledger / fail-stop) into the assistant agent system context.",
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