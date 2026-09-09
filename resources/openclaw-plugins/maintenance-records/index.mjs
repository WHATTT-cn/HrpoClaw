/**
 * maintenance-records 薄入口（A 路本地内建插件）。
 *
 * 职责边界：本文件仅做「接线」，业务逻辑全在 monorepo 打包产物 handler.bundle.mjs。
 *
 * 双工具接线（方案A · 真弹窗 + 直接读取）：
 * 1. registerTool(record_maintenance)：承载「登记一条历史维修记录」的意图。
 *    不落库在 execute，而在 before_tool_call 的 requireApproval.onResolution。
 *    execute 仅为兜底（正常流程会被 before_tool_call 拦下，走不到这里）。
 * 2. registerTool(read_maintenance)：读取已有维修记录。无入参，直接读 JSON
 *    返回（不走人审，供模型知晓工单号与历史、查重防重复登记）。
 * 3. registerHook(before_prompt_build)：注入系统指引，教模型识别完整维修闭环并调用工具。
 * 4. registerHook(before_tool_call)：拦截 record_maintenance，发 requireApproval 人审弹窗，
 *    用户确认（allow）后 onResolution 写入 ~/.openclaw/workspace-fde/维修记录.json。
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
  resolveMaintenancePath,
  RECORD_TOOL_NAME,
  READ_TOOL_NAME,
  isRecordTool,
  RECORD_MAINTENANCE_PARAMETERS,
  READ_MAINTENANCE_PARAMETERS,
  readRecords,
} from "./handler.bundle.mjs";

const PLUGIN_ID = "maintenance-records";

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

// 两个工具的入参 schema 由 monorepo 打包产物导出
//（RECORD_MAINTENANCE_PARAMETERS / READ_MAINTENANCE_PARAMETERS，
//  纯 JSON Schema 字面量，单一来源、零裸模块依赖）。

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "Maintenance Records",
  description:
    "Register historical maintenance records with human approval: model proposes a repair loop, user confirms, code writes to workspace-fde/维修记录.json.",
  register(api) {
    const config = resolveConfig(api?.pluginConfig);
    const maintenancePath = resolveMaintenancePath(homedir());

    // 1) 注册写工具：承载「登记一条历史维修记录」的意图。
    api.registerTool({
      name: RECORD_TOOL_NAME,
      label: "登记历史维修记录",
      description:
        "把一次已确认的完整维修闭环（已确认原因/已执行维修/复机验证）登记为历史维修记录。识别到用户要求登记且三要素齐备时调用；调用后会弹出人审确认框由用户决定是否入库。",
      parameters: RECORD_MAINTENANCE_PARAMETERS,
      async execute(_toolCallId, params) {
        // 兜底：正常流程会被 before_tool_call 拦截发审批，走不到这里。
        // 若某些运行时未经 before_tool_call 直接放行，则此处不落库、仅回执，
        // 避免绕过人审直接写库（fail-closed）。
        return {
          content: [
            {
              type: "text",
              text: "已收到维修记录登记请求，等待人工审批确认后写入看板。",
            },
          ],
          details: { toolName: RECORD_TOOL_NAME, params },
        };
      },
    });

    // 2) 注册读工具：读取已有维修记录（不走人审，供模型查重）。
    api.registerTool({
      name: READ_TOOL_NAME,
      label: "读取历史维修记录",
      description:
        "读取已有的全部历史维修记录（工单号、日期、原因、维修、验证），供模型知晓历史、查重以决定是否登记新条目。",
      parameters: READ_MAINTENANCE_PARAMETERS,
      async execute() {
        try {
          const records = await readRecords(docFs, maintenancePath);
          const lines = records.map((r) =>
            [
              `工单号: ${r.workOrder}`,
              `日期: ${r.date}`,
              `已确认原因: ${r.confirmedCause}`,
              `已执行维修: ${r.repairAction}`,
              `复机验证: ${r.verification}`,
            ].join("\n"),
          );
          const text =
            lines.length > 0
              ? `当前共有 ${records.length} 条历史维修记录：\n\n${lines.join("\n\n")}`
              : "暂无历史维修记录。";
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `读取维修记录失败：${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      },
    });

    // 3) before_prompt_build：注入系统指引，教模型识别维修闭环并调用工具。
    api.registerHook("before_prompt_build", async () => {
      try {
        return buildPromptInjection();
      } catch (err) {
        // 注入失败不阻断对话，仅放弃本次注入。
        console.error(
          `[maintenance-records] before_prompt_build 注入失败：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      }
    });

    // 4) before_tool_call：拦截 record_maintenance，发 requireApproval 人审弹窗。
    api.registerHook("before_tool_call", async (event) => {
      try {
        const toolName = event?.toolName;
        // 快速短路：非写工具（含 read_maintenance）直接放行，零开销。
        if (!isRecordTool(toolName)) {
          return undefined;
        }

        const result = handleBeforeToolCall({
          toolName,
          params: event?.params ?? {},
          config,
          deps: {
            fs: docFs,
            filePath: maintenancePath,
            onPersisted: (params, written) => {
              console.log(
                `[maintenance-records] 维修记录已${written ? "写入" : "命中幂等未重复写入"}：${params.confirmedCause}`,
              );
            },
            onError: (params, e) => {
              console.error(
                `[maintenance-records] 写入失败（${params.confirmedCause}）：${
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
        // fail-closed：目标工具接线异常一律拦截，绝不放行绕过人审。
        return {
          block: true,
          blockReason: `maintenance-records 接线层异常，已拦截：${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    });
  },
});

export default pluginEntry;