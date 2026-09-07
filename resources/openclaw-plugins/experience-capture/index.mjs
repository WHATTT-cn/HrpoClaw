/**
 * experience-capture 薄入口(A 路本地内建插件)。
 *
 * 职责边界:本文件仅做「接线」,业务逻辑全在 monorepo 打包产物 handler.bundle.mjs。
 *
 * 三处接线(方案A · 真弹窗):
 * 1. registerTool(record_po_experience):自定义工具,承载"记录一条 PO 线下经验"的意图。
 *    真正落库不在 execute,而在 before_tool_call 的 requireApproval.onResolution。
 *    execute 仅为兜底(正常流程会被 before_tool_call 拦下,走不到这里)。
 * 2. registerHook(before_prompt_build):注入系统指引,教模型识别线下经验时调上面的工具。
 * 3. registerHook(before_tool_call):拦截 record_po_experience,发 requireApproval 人审弹窗,
 *    用户确认(allow)后 onResolution 写入 ~/.openclaw/workspace-po/Experience.md。
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
  resolveExperiencePath,
  TARGET_TOOL_NAME,
  RECORD_EXPERIENCE_PARAMETERS,
} from "./handler.bundle.mjs";

const PLUGIN_ID = "experience-capture";

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

// record_po_experience 工具的入参 schema 由 monorepo 打包产物导出
// (RECORD_EXPERIENCE_PARAMETERS,纯 JSON Schema 字面量,单一来源、零裸模块依赖)。

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Experience Capture",
  description:
    "Capture offline PO experience into a knowledge base with human approval: model proposes, user confirms, code writes.",
  register(api) {
    const config = resolveConfig(api?.pluginConfig);
    const experiencePath = resolveExperiencePath(homedir());

    // 1) 注册自定义工具:承载"记录一条 PO 线下经验"的意图。
    api.registerTool({
      name: TARGET_TOOL_NAME,
      label: "记录 PO 线下经验",
      description:
        "把用户输入中出现的采购(PO)线下经验结构化记录到知识库。识别到线下经验时调用本工具;调用后会弹出人审确认框由用户决定是否入库。",
      parameters: RECORD_EXPERIENCE_PARAMETERS,
      async execute(_toolCallId, params) {
        // 兜底:正常流程会被 before_tool_call 拦截发审批,走不到这里。
        // 若某些运行时未经 before_tool_call 直接放行,则此处不落库、仅回执,
        // 避免绕过人审直接写库(fail-closed)。
        return {
          content: [
            {
              type: "text",
              text: "已收到经验记录请求,等待人工审批确认后写入知识库。",
            },
          ],
          details: { toolName: TARGET_TOOL_NAME, params },
        };
      },
    });

    // 2) before_prompt_build:注入系统指引,教模型识别线下经验并调用工具。
    api.registerHook("before_prompt_build", async () => {
      try {
        return buildPromptInjection();
      } catch (err) {
        // 注入失败不阻断对话,仅放弃本次注入。
        console.error(
          `[experience-capture] before_prompt_build 注入失败:${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      }
    });

    // 3) before_tool_call:拦截 record_po_experience,发 requireApproval 人审弹窗。
    api.registerHook("before_tool_call", async (event) => {
      try {
        const toolName = event?.toolName;
        // 快速短路:非目标工具直接放行,零开销。
        if (toolName !== TARGET_TOOL_NAME) {
          return undefined;
        }

        const result = handleBeforeToolCall({
          toolName,
          params: event?.params ?? {},
          config,
          deps: {
            fs: docFs,
            filePath: experiencePath,
            onPersisted: (entry, written) => {
              console.log(
                `[experience-capture] 经验已${written ? "写入" : "命中幂等未重复写入"}:${entry.subject}｜${entry.dimension}`,
              );
            },
            onError: (entry, e) => {
              console.error(
                `[experience-capture] 写入失败(${entry.subject}):${
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
        // fail-closed:目标工具接线异常一律拦截,绝不放行绕过人审。
        return {
          block: true,
          blockReason: `experience-capture 接线层异常,已拦截:${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    });
  },
});

export default pluginEntry;