/**
 * task-ledger 薄入口（A 路本地内建插件）。
 *
 * 职责边界：本文件仅做「接线」，业务逻辑全在 monorepo 打包产物 handler.bundle.mjs。
 *
 * 双工具接线（方案A · riskLevel 分流）：
 * 1. registerTool(record_task_step)：承载「登记一步执行记录」的意图。
 *    - riskLevel:'high'   → before_tool_call 拦下发人审弹窗，onResolution 落库。
 *    - riskLevel:'normal' → before_tool_call 直接落库并放行（不打扰用户）。
 *    execute 仅兜底回执（正常流程会被 before_tool_call 拦下/放行，走不到这里）。
 * 2. registerTool(read_task_ledger)：读取执行记录台账。无入参，直接读 JSON
 *    返回（不走人审，供模型查重防重复执行）。
 * 3. registerHook(before_prompt_build)：注入四铁律运行纪律指引。
 * 4. registerHook(before_tool_call)：拦截 record_task_step，按 riskLevel 分流。
 *
 * 安全红线：接线层异常一律 fail-closed（拦截/不落库），绝不「出错就放行」。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";

import {
  handleBeforeToolCall,
  buildPromptInjection,
  resolveConfig,
  resolveLedgerPath,
  RECORD_TOOL_NAME,
  READ_TOOL_NAME,
  isRecordTool,
  RECORD_STEP_PARAMETERS,
  READ_LEDGER_PARAMETERS,
  readRecords,
} from "./handler.bundle.mjs";

const PLUGIN_ID = "task-ledger";

/** node:fs 适配为 handler 需要的 DocFs（读/写/存在性判断）。 */
const docFs = {
  async readFile(path) {
    return readFile(path, "utf8");
  },
  async writeFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Task Ledger",
  description:
    "Record desktop-assistant task steps with risk-based approval: normal steps are logged directly, high-risk steps require human approval before writing to workspace-assistant/执行记录.json.",
  register(api) {
    const config = resolveConfig(api?.pluginConfig);
    const ledgerPath = resolveLedgerPath(homedir());

    // 1) 注册写工具：承载「登记一步执行记录」的意图。
    api.registerTool({
      name: RECORD_TOOL_NAME,
      label: "登记执行记录",
      description:
        "把桌面助手执行的一步操作登记为执行记录。每执行一步都应调用。riskLevel:'high' 的高风险/不可逆步骤会在执行前弹出人审确认；riskLevel:'normal' 的步骤直接落库放行。",
      parameters: RECORD_STEP_PARAMETERS,
      async execute(_toolCallId, params) {
        // 兜底：正常流程会被 before_tool_call 拦下（high）或直接落库放行（normal），
        // 走不到这里。若某运行时未经 before_tool_call 直接放行，则此处不落库、仅回执，
        // 避免绕过人审/绕过统一落库（fail-closed）。
        return {
          content: [
            {
              type: "text",
              text: "已收到执行记录登记请求，等待前置处理（人审/落库）完成。",
            },
          ],
          details: { toolName: RECORD_TOOL_NAME, params },
        };
      },
    });

    // 2) 注册读工具：读取执行记录台账（不走人审，供模型查重）。
    api.registerTool({
      name: READ_TOOL_NAME,
      label: "读取执行记录台账",
      description:
        "读取已有的全部执行记录（taskId、步骤号、操作、目标软件、验收、状态、风险级别、时间），供模型知晓已执行步骤、查重以避免重复执行。",
      parameters: READ_LEDGER_PARAMETERS,
      async execute() {
        try {
          const records = await readRecords(docFs, ledgerPath);
          const lines = records.map((r) =>
            [
              `任务: ${r.taskId}  步骤: ${r.stepNo}`,
              `操作: ${r.action}`,
              `目标软件: ${r.targetApp}`,
              `验收: ${r.verify}`,
              `状态: ${r.status}  风险: ${r.riskLevel}`,
              `时间: ${r.timestamp ?? "-"}`,
            ].join("\n"),
          );
          const text =
            lines.length > 0
              ? `当前共有 ${records.length} 条执行记录：\n\n${lines.join("\n\n")}`
              : "暂无执行记录。";
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `读取执行记录失败：${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      },
    });

    // 3) before_prompt_build：注入四铁律运行纪律指引。
    api.registerHook("before_prompt_build", async () => {
      try {
        return buildPromptInjection();
      } catch (err) {
        // 注入失败不阻断对话，仅放弃本次注入。
        console.error(
          `[task-ledger] before_prompt_build 注入失败：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      }
    });

    // 4) before_tool_call：拦截 record_task_step，按 riskLevel 分流。
    api.registerHook("before_tool_call", async (event) => {
      try {
        const toolName = event?.toolName;
        // 快速短路：非写工具（含 read_task_ledger）直接放行，零开销。
        if (!isRecordTool(toolName)) {
          return undefined;
        }

        // 注意：handleBeforeToolCall 是 async，必须 await。
        const result = await handleBeforeToolCall({
          toolName,
          params: event?.params ?? {},
          config,
          deps: {
            fs: docFs,
            filePath: ledgerPath,
            onPersisted: (params, written) => {
              console.log(
                `[task-ledger] 执行记录已${written ? "写入" : "命中幂等未重复写入"}：${params.taskId} #${params.stepNo}`,
              );
            },
            onError: (params, e) => {
              console.error(
                `[task-ledger] 落库失败（${params.taskId} #${params.stepNo}）：${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            },
          },
          pluginId: PLUGIN_ID,
        });

        if (result?.block) {
          return { block: true, blockReason: result.blockReason };
        }
        if (result?.requireApproval) {
          return { requireApproval: result.requireApproval };
        }
        // result?.persisted（normal 已落库）或 undefined（非目标）→ 放行。
        return undefined;
      } catch (err) {
        // fail-closed：目标工具接线异常一律拦截，绝不放行绕过人审/落库。
        return {
          block: true,
          blockReason: `task-ledger 接线层异常，已拦截：${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    });
  },
});

export default pluginEntry;