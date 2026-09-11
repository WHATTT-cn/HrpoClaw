import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
 * 本 store 只负责两件事：
 * 1) 记录并持久化「当前看板分析会话 key」（时间戳 key），供 Chat 页切 Tab 时加载 / 判断是否触发。
 * 2) 提供 refreshSignal 计数器，让左半区「供应商画像刷新按钮」跨组件通知右半区看板分析 Tab 重跑分析。
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
  /** 递增计数器：每次「刷新按钮/二次触发」自增，供右半区订阅后重跑分析。 */
  refreshSignal: number;
  /** 新建一个时间戳会话 key 并置为当前（返回新 key）。 */
  startNewSession: () => string;
  /** 触发一次重跑请求（画像刷新按钮点击时调用）。 */
  requestRefresh: () => void;
};

export const usePoDashboardAnalysisStore = create<PoDashboardAnalysisState>()(
  persist(
    (set, get) => ({
      sessionKey: null,
      refreshSignal: 0,
      startNewSession: () => {
        const key = createPoDashboardSessionKey();
        set({ sessionKey: key });
        return key;
      },
      requestRefresh: () => {
        set({ refreshSignal: get().refreshSignal + 1 });
      },
    }),
    {
      name: 'clawx.po-dashboard-analysis',
      version: 1,
      // refreshSignal 是会话内瞬时信号，不持久化；只持久化 sessionKey 以跨重启判断「有无历史」。
      partialize: (state) => ({ sessionKey: state.sessionKey }),
    },
  ),
);