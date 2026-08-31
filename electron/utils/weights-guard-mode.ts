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
 * 未显式配置时，沿用插件 manifest 的 enabledByDefault:true 语义——默认视为已启用。
 */

/** weights-guard 插件在 OpenClaw 配置中的唯一 id（与 openclaw.plugin.json 一致）。 */
export const WEIGHTS_GUARD_PLUGIN_ID = 'weights-guard';

/**
 * 读取 weights-guard 当前是否启用。
 *
 * 语义：
 * - 配置里没有对应 entry → 视为「默认启用」（enabledByDefault:true）。
 * - entry 存在且 enabled === false → 停用。
 * - 其余情况 → 启用。
 */
export async function getWeightsGuardEnabled(): Promise<boolean> {
  try {
    const snapshot = await readOpenClawConfigSnapshot();
    const config = snapshot.config as OpenClawConfig;
    const entry = config.plugins?.entries?.[WEIGHTS_GUARD_PLUGIN_ID];
    if (!entry) {
      // 未显式配置：遵循 manifest enabledByDefault:true。
      return true;
    }
    return entry.enabled !== false;
  } catch (error) {
    // 读失败不影响运行时安全（真正的拦截在插件内部 fail-closed 完成），
    // UI 侧回落到「默认启用」这一保守展示，避免误导用户以为守卫已关闭。
    logger.error('Failed to read weights-guard enabled state', error);
    return true;
  }
}

/**
 * 设置 weights-guard 启用状态，写入 OpenClaw 配置。
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
    if (!config.plugins.entries[WEIGHTS_GUARD_PLUGIN_ID]) {
      config.plugins.entries[WEIGHTS_GUARD_PLUGIN_ID] = {};
    }
    config.plugins.entries[WEIGHTS_GUARD_PLUGIN_ID].enabled = enabled;
  });
  logger.info(`Set weights-guard enabled: ${enabled}`);
}