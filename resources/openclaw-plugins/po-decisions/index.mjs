/**
 * po-decisions 薄入口(A 路本地内建插件)。
 *
 * 职责边界:本文件仅做「接线」,业务逻辑全在 handler.bundle.mjs。
 *
 * ⚠️ 已改造为「只读」形态(履约追踪改为 TS 真源同源派生管线):
 * 用工决策.json 由 ClawX 的 `src/data/supplier-decision-table.ts` 经 `pnpm gen:decisions`
 * 全量派生,是唯一人工维护真源。因此插件不再提供任何写入能力。
 *
 * 现行接线:
 * 1. registerTool(read_decision):只读查重工具,直接读 用工决策.json 回列表。【保留】
 * 2. registerHook(before_prompt_build):注入「看板只读 + 正确更新方式」指引。
 * 3. registerHook(before_tool_call):对历史会话残留的 record_decision 调用直接 block,
 *    提示改用 `pnpm gen:decisions`,不再发人审弹窗、不再落库。
 *
 * 已弃用(代码保留于 handler.bundle.mjs,无调用方):
 * - registerTool(record_decision) 写工具注册;
 * - requireApproval 人审弹窗 + onResolution 追加落库(persistEntry);
 * - buildGuidance() 的「排他强制」写入引导。
 *
 * 安全红线:接线层异常一律 fail-closed(拦截/不落库),绝不"出错就放行"。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";

import {
  buildReadOnlyPromptInjection,
  resolveDecisionPath,
  READ_TOOL_NAME,
  isRecordTool,
  READ_DECISION_PARAMETERS,
  readRecords,
  RECORD_TOOL_RETIRED_REASON,
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
    "Read-only access to the workforce-allocation decision board; records are generated from the TypeScript source of truth.",
  register(api) {
    const decisionPath = resolveDecisionPath(homedir());

    // ── 已弃用:写工具 record_decision 的注册(方案A 真弹窗) ────────────────
    // 履约追踪改为 TS 真源派生后看板只读,写链整体退役。以下注册块保留作历史存档,
    // 不再启用;handler.bundle.mjs 中的 persistEntry/buildRequireApproval 亦无调用方。
    //
    // api.registerTool({
    //   name: RECORD_TOOL_NAME,
    //   label: "登记用工决策",
    //   description: "把一次已确认的用工分单决策登记为决策记录;调用后弹人审确认框…",
    //   parameters: RECORD_DECISION_PARAMETERS,
    //   async execute(_toolCallId, params) {
    //     return {
    //       content: [{ type: "text", text: "已收到用工决策登记请求,等待人工审批确认后写入看板。" }],
    //       details: { toolName: RECORD_TOOL_NAME, params },
    //     };
    //   },
    // });

    // 1) 只读查重工具:读取已有全部用工决策(不拦截、不走人审)。
    api.registerTool({
      name: READ_TOOL_NAME,
      label: "读取用工决策",
      description: "读取已有全部用工决策记录,供模型查询与查重。",
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

    // 2) before_prompt_build:注入「看板只读 + 正确更新方式」指引。
    //    (旧的 buildPromptInjection() 写入引导已弃用,保留在 handler 中无调用方。)
    api.registerHook("before_prompt_build", async () => {
      try {
        return buildReadOnlyPromptInjection();
      } catch (err) {
        console.error(
          `[po-decisions] before_prompt_build 注入失败:${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      }
    });

    // 3) before_tool_call:历史会话/残留指引仍可能调 record_decision,一律阻断。
    //    不再发 requireApproval、不再 persistEntry,确保 TS 真源是唯一写入口。
    api.registerHook("before_tool_call", async (event) => {
      try {
        const toolName = event?.toolName;
        // 快速短路:非退役写工具直接放行(含 read_decision),零开销。
        if (!isRecordTool(toolName)) {
          return undefined;
        }
        return { block: true, blockReason: RECORD_TOOL_RETIRED_REASON };
      } catch (err) {
        // fail-closed:接线层异常一律拦截,绝不放行写入绕过真源。
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