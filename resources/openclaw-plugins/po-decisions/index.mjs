/**
 * po-decisions 薄入口(A 路本地内建插件)。
 *
 * 职责边界:本文件仅做「接线」,业务逻辑全在 handler.bundle.mjs。
 *
 * 三处接线(方案A · 真弹窗,与 experience-capture 同构):
 * 1. registerTool(record_decision):写工具,承载"登记一条用工决策"的意图。
 *    真正落库不在 execute,而在 before_tool_call 的 requireApproval.onResolution。
 *    execute 仅为兜底(正常流程会被 before_tool_call 拦下,走不到这里)。
 * 2. registerTool(read_decision):只读查重工具,直接读 用工决策.json 回列表。
 * 3. registerHook(before_prompt_build):注入系统指引,教模型识别决策定案并调工具。
 * 4. registerHook(before_tool_call):拦截 record_decision,发 requireApproval 人审弹窗,
 *    用户确认(allow)后 onResolution 写入 ~/.openclaw/workspace-po/用工决策.json。
 *
 * 安全红线:接线层异常一律 fail-closed(拦截/不落库),绝不"出错就放行"。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";

import {
  handleBeforeToolCall,
  buildPromptInjection,
  resolveConfig,
  resolveDecisionPath,
  RECORD_TOOL_NAME,
  READ_TOOL_NAME,
  isRecordTool,
  RECORD_DECISION_PARAMETERS,
  READ_DECISION_PARAMETERS,
  readRecords,
} from "./handler.bundle.mjs";

const PLUGIN_ID = "po-decisions";

/** node:fs 适配为 handler 需要的 DocFs(读/写/存在性判断)。 */
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
  name: "PO Decisions",
  description:
    "Register workforce-allocation decisions into a structured board with human approval: model proposes, user confirms, code writes.",
register(api) {
    const config = resolveConfig(api?.pluginConfig);
    const decisionPath = resolveDecisionPath(homedir());

    // 1) 写工具:承载"登记一条用工决策"的意图。落库在 before_tool_call,execute 仅兜底。
    api.registerTool({
      name: RECORD_TOOL_NAME,
      label: "登记用工决策",
      description:
  "把一次已确认的用工分单决策登记为决策记录;调用后弹人审确认框由用户决定是否入库。决策单号由系统自动生成,勿自行填写。",
      parameters: RECORD_DECISION_PARAMETERS,
      async execute(_toolCallId, params) {
        // 兜底:正常流程会被 before_tool_call 拦截发审批,走不到这里。
        return {
          content: [
  {
      type: "text",
      text: "已收到用工决策登记请求,等待人工审批确认后写入看板。",
      },
       ],
        details: { toolName: RECORD_TOOL_NAME, params },
        };
      },
    });

    // 2) 只读查重工具:读取已有全部用工决策(不拦截、不走人审)。
    api.registerTool({
      name: READ_TOOL_NAME,
      label: "读取用工决策",
      description: "读取已有全部用工决策记录,供模型查重,避免重复登记。",
      parameters: READ_DECISION_PARAMETERS,
      async execute() {
try {
          const records = await readRecords(docFs, decisionPath);
          const text = records.length
     ? `当前共有 ${records.length} 条用工决策:\n\n` +
              records
     .map(
     (r) =>
         `决策单号: ${r.decisionNo}\n日期: ${r.date}\n物流仓: ${r.warehouse}\n供应商: ${r.supplier}\n承接: ${r.headcount}\n依据: ${r.basis}`,
                )
                .join("\n\n")
    : "暂无用工决策记录。";
    return { content: [{ type: "text", text }] };
        } catch (err) {
      return {
            content: [
        {
                type: "text",
          text: `读取失败:${err instanceof Error ? err.message : String(err)}`,
        },
            ],
    };
        }
  },
    });

  // 3) before_prompt_build:注入系统指引,教模型识别决策定案并调用工具。
    api.registerHook("before_prompt_build", async () => {
      try {
     return buildPromptInjection();
      } catch (err) {
        console.error(
        `[po-decisions] before_prompt_build 注入失败:${
        err instanceof Error ? err.message : String(err)
  }`,
  );
        return undefined;
      }
    });

    // 4) before_tool_call:拦截 record_decision,发 requireApproval 人审弹窗。
    api.registerHook("before_tool_call", async (event) => {
      try {
        const toolName = event?.toolName;
        // 快速短路:非写工具直接放行(含 read_decision),零开销。
        if (!isRecordTool(toolName)) {
        return undefined;
        }

        const result = handleBeforeToolCall({
    toolName,
          params: event?.params ?? {},
          config,
          deps: {
         fs: docFs,
     filePath: decisionPath,
            onPersisted: (entry) => {
      console.log(
                `[po-decisions] 决策已写入:${entry.warehouse}｜${entry.supplier}`,
           );
     },
  onError: (entry, e) => {
              console.error(
          `[po-decisions] 写入失败(${entry.supplier}):${
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
        return undefined;
 } catch (err) {
        // fail-closed:写工具接线异常一律拦截,绝不放行绕过人审。
        return {
          block: true,
 blockReason: `po-decisions 接线层异常,已拦截:${
            err instanceof Error ? err.message : String(err)
     }`,
        };
      }
    });
  },
});

export default pluginEntry;