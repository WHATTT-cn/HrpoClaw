import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { useGatewayStore } from './gateway';

/**
 * PO「看板分析」Tab 的会话控制器（阶段四）。
 *
 * 背景与约束：
 * - ACP 后端 loadSession 对已存在 key 是「追加」语义，且无清空/删除 transcript 的 API，
 *   因此「刷新后覆盖旧分析」只能靠每次触发时新建带时间戳的会话 key 来模拟：
 *   旧 key 成为不再展示的孤儿会话（并由 session-key-utils 的 isPoDashboardSessionKey 排除出侧栏）。
 * - 看板分析 Tab 与对话 Tab 共享全局单例 useAcpChatSessionStore，切 Tab 即切换 activeSessionKey。
 * - chat store 的 sessions 数组已被 shouldIncludeSessionInSidebarList 过滤掉看板分析会话，
 *   无法据此判断「有无历史」；故本 store 持久化 sessionKey 作为「是否有历史分析」的唯一依据：
 *   sessionKey === null 视为无历史（切 Tab 首次触发），非 null 视为有历史（切 Tab 仅加载不重跑）。
 *
 * 本 store 只负责一件事：
 * 记录并持久化「当前看板分析会话 key」（时间戳 key），供 Chat 页切 Tab 时加载 / 判断是否触发。
 * sessionKey === null 视为无历史（需用户显式点击「开始分析」触发）；非 null 视为有历史（切 Tab 仅加载复用不重跑）。
 *
 * 另外维护一个非持久化的 refreshSignal：画像看板点「刷新」时自增，
 * Chat 页监听该信号变化并重跑看板分析（新建时间戳会话覆盖旧分析）。
 * 「重跑分析」的权力收敛到画像看板的刷新按钮，看板分析 Tab 不再单独提供「重新分析」按钮。
 */

/** 看板分析会话 key 的前缀（不含时间戳）。用于 isPoDashboardSessionKey 识别与排除。 */
export const PO_DASHBOARD_SESSION_PREFIX = 'agent:po:dashboard-';

/** 判断某会话 key 是否为 PO 看板分析的专属会话。 */
export function isPoDashboardSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(PO_DASHBOARD_SESSION_PREFIX);
}

/** 生成一个新的看板分析会话 key（带时间戳，模拟“覆盖”旧分析）。 */
export function createPoDashboardSessionKey(): string {
  return `${PO_DASHBOARD_SESSION_PREFIX}${Date.now()}`;
}

type PoDashboardAnalysisState = {
  /** 当前看板分析会话 key；null 表示尚未触发过分析（无历史）。 */
  sessionKey: string | null;
  /** 画像看板点「刷新」自增的信号（非持久化）；Chat 页监听其变化以重跑看板分析。 */
  refreshSignal: number;
  /** 新建一个时间戳会话 key 并置为当前（返回新 key）。 */
  startNewSession: () => string;
  /** 请求重跑看板分析：仅自增 refreshSignal，由 Chat 页监听并触发新一轮分析。 */
  requestRefresh: () => void;
  /**
   * 从后端会话目录发现「最新一个看板分析会话」并同步到 sessionKey。
   * 直接调 gateway 的 sessions.list RPC（返回全部会话，含被侧栏过滤的 dashboard 会话），
   * 筛出所有 agent:po:dashboard-<ts> 会话，按时间戳降序取最新一个作为当前会话 key。
   * 返回发现到的最新 key；后端一个都没有则返回 null（视为无历史，应显示「开始分析」）。
   * 用途：切「看板分析」Tab 时统一以后端真实会话为准，避免前端持久化的单一 key
   * 与后端实际不同步（清缓存 / 多次分析）导致「有历史却显示空态」。
   */
  discoverLatestDashboardSessionKey: () => Promise<string | null>;
};

/** 从 agent:po:dashboard-<ts> 会话 key 解析末尾时间戳；非法则返回 0。 */
function parseDashboardSessionTimestamp(sessionKey: string): number {
  const ts = Number(sessionKey.slice(PO_DASHBOARD_SESSION_PREFIX.length));
  return Number.isFinite(ts) ? ts : 0;
}

export const usePoDashboardAnalysisStore = create<PoDashboardAnalysisState>()(
  persist(
    (set) => ({
      sessionKey: null,
      refreshSignal: 0,
      startNewSession: () => {
        const key = createPoDashboardSessionKey();
        set({ sessionKey: key });
        return key;
      },
      requestRefresh: () => set((state) => ({ refreshSignal: state.refreshSignal + 1 })),
      discoverLatestDashboardSessionKey: async () => {
        try {
          const data = await useGatewayStore
            .getState()
            .rpc<Record<string, unknown>>('sessions.list', {
              includeDerivedTitles: false,
              includeLastMessage: false,
            });
          const rawSessions = Array.isArray(data?.sessions) ? data.sessions : [];
          let latestKey: string | null = null;
          let latestTs = -1;
          for (const raw of rawSessions) {
            const key =
              raw && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string'
                ? (raw as { key: string }).key
                : '';
            if (!key || !isPoDashboardSessionKey(key)) continue;
            const ts = parseDashboardSessionTimestamp(key);
            if (ts > latestTs) {
              latestTs = ts;
              latestKey = key;
            }
          }
          set({ sessionKey: latestKey });
          return latestKey;
        } catch (error) {
          console.warn('discoverLatestDashboardSessionKey failed:', error);
          return null;
        }
      },
    }),
    {
      name: 'clawx.po-dashboard-analysis',
      version: 1,
      // 只持久化 sessionKey 以跨重启判断「有无历史」。
      partialize: (state) => ({ sessionKey: state.sessionKey }),
    },
  ),
);