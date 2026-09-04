import { mutateOpenClawConfig, readOpenClawConfigSnapshot } from '../gateway/config-delivery';
import type { OpenClawConfig } from './channel-config';
import { logger } from './logger';

/**
 * weights-guard 模式启停（ClawX 外壳侧读写工具）。
 *
 * 职责边界：本模块只负责读写 OpenClaw 配置中 weights-guard 插件的 enabled 开关，
 * 不修改上游源码，符合全局规则 1（所有改造以外壳/插件形式实现）。
 *
 * 配置落点：plugins.entries['weights-guard'].enabled（与渠道插件启停一致的结构）。
 * 未显式配置时，默认关闭——需用户在模式页手动开启后才启用（manifest enabledByDefault:false）。
 */

/** weights-guard 插件在 OpenClaw 配置中的唯一 id（与 openclaw.plugin.json 一致）。 */
export const WEIGHTS_GUARD_PLUGIN_ID = 'weights-guard';

/**
 * experience-capture 插件 id（与 openclaw.plugin.json 一致）。
 *
 * 产品约定：模式页同一个 UI 开关同时控制 weights-guard 与 experience-capture 两个插件，
 * 二者随该开关同开同关。故本模块在写入 weights-guard entry 的同一事务里同步写此插件，
 * 保证原子性、避免出现两者启停状态不一致的中间态。
 */
export const EXPERIENCE_CAPTURE_PLUGIN_ID = 'experience-capture';

/**
 * 读取 weights-guard 当前是否启用。
 *
 * 语义：
 * - 配置里没有对应 entry → 视为「默认关闭」（enabledByDefault:false）。
 * - entry 存在且 enabled === false → 停用。
 * - 其余情况 → 启用。
 */
export async function getWeightsGuardEnabled(): Promise<boolean> {
  try {
    const snapshot = await readOpenClawConfigSnapshot();
    const config = snapshot.config as OpenClawConfig;
    const entry = config.plugins?.entries?.[WEIGHTS_GUARD_PLUGIN_ID];
    if (!entry) {
      // 未显式配置：默认关闭，需用户在模式页手动开启后才启用。
      return false;
    }
    return entry.enabled !== false;
  } catch (error) {
    // 读失败时保守回落到「关闭」，与默认关闭语义保持一致，
    // 避免在配置不可读时误将守卫展示为已启用。
    logger.error('Failed to read weights-guard enabled state', error);
    return false;
  }
}

/**
 * 设置 weights-guard 启用状态，写入 OpenClaw 配置。
 *
 * 产品约定：模式页同一个 UI 开关同时控制 weights-guard 与 experience-capture，
 * 故本函数在同一个 mutateOpenClawConfig 事务里同步写两个插件的 enabled，
 * 保证同开同关、避免出现两者状态不一致的中间态。
 *
 * 使用 mutateOpenClawConfig 事务原语，确保与其它配置写入串行、互不覆盖。
 */
export async function setWeightsGuardEnabled(enabled: boolean): Promise<void> {
  await mutateOpenClawConfig((snapshot) => {
    const config = snapshot as OpenClawConfig;
    if (!config.plugins) {
      config.plugins = {};
    }
    if (!config.plugins.entries) {
      config.plugins.entries = {};
    }
    for (const pluginId of [WEIGHTS_GUARD_PLUGIN_ID, EXPERIENCE_CAPTURE_PLUGIN_ID]) {
      if (!config.plugins.entries[pluginId]) {
        config.plugins.entries[pluginId] = {};
      }
      config.plugins.entries[pluginId].enabled = enabled;
    }
  });
  logger.info(`Set weights-guard & experience-capture enabled: ${enabled}`);
}