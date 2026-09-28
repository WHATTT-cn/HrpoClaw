import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { useGatewayStore } from './gateway';

/**
 * PO 三看板「分析会话」控制器。
 *
 * 背景与约束：
 * - ACP 后端 loadSession 对已存在 key 是「追加」语义，且无清空/删除 transcript 的 API，
 *   因此「刷新后覆盖旧分析」只能靠每次触发时新建带时间戳的会话 key 来模拟：
 *   旧 key 成为不再展示的孤儿会话（并由 session-key-utils 的 isPoDashboardSessionKey 排除出侧栏）。
 * - 三个看板（区域健康 / 采购下单 / 履约追踪）各自拥有独立的隐形会话 key 与独立的刷新信号，
 *   互不串味：切看板 Tab 即切会话，点某看板的刷新按钮只重跑该看板的 skill 分析。
 * - chat store 的 sessions 数组已被 shouldIncludeSessionInSidebarList 过滤掉看板分析会话，
 *   无法据此判断「有无历史」；故本 store 按 board 持久化 sessionKey 作为「是否有历史分析」的唯一依据。
 *
 * 另维护两份非持久化状态：
 * - refreshSignals：某看板点「刷新」时自增，Chat 页监听并重跑该看板的分析。
 * - boardContexts：看板把「当前筛选上下文」写进来（如区域健康的洲际/片区/仓/周期），
 *   Chat 页拼进触发提示词，让 skill 知道用户当前在看哪一段数据。
 */

/** 三个看板的标识（与 Chat 页 PoDashboardPanel 的 Tab key 一致）。 */
export type PoBoardKind = 'region' | 'portrait' | 'decision';

export const PO_BOARD_KINDS: PoBoardKind[] = ['region', 'portrait', 'decision'];

/** 看板分析会话 key 的公共前缀（不含 board 与时间戳）。用于 isPoDashboardSessionKey 识别与排除。 */
export const PO_DASHBOARD_SESSION_PREFIX = 'agent:po:dashboard-';

/** 判断某会话 key 是否为 PO 看板分析的专属会话（三看板通用）。 */
export function isPoDashboardSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(PO_DASHBOARD_SESSION_PREFIX);
}

/**
 * 解析看板分析会话 key → { board, timestamp }。
 * 新格式 `agent:po:dashboard-<board>-<ts>`；
 * 历史遗留格式 `agent:po:dashboard-<ts>`（无 board 段）一律归为 portrait（旧链路即画像看板分析）。
 */
export function parsePoDashboardSessionKey(
  sessionKey: string,
): { board: PoBoardKind; timestamp: number } | null {
  if (!isPoDashboardSessionKey(sessionKey)) return null;
  const rest = sessionKey.slice(PO_DASHBOARD_SESSION_PREFIX.length);
  const dashIndex = rest.indexOf('-');
  if (dashIndex > 0) {
    const board = rest.slice(0, dashIndex) as PoBoardKind;
    if (PO_BOARD_KINDS.includes(board)) {
      const ts = Number(rest.slice(dashIndex + 1));
      return { board, timestamp: Number.isFinite(ts) ? ts : 0 };
    }
  }
  const legacyTs = Number(rest);
  if (!Number.isFinite(legacyTs)) return null;
  return { board: 'portrait', timestamp: legacyTs };
}

/** 生成某看板的新分析会话 key（带时间戳，模拟“覆盖”旧分析）。 */
export function createPoDashboardSessionKey(board: PoBoardKind): string {
  return `${PO_DASHBOARD_SESSION_PREFIX}${board}-${Date.now()}`;
}

type BoardRecord<T> = Record<PoBoardKind, T>;

function emptyKeys(): BoardRecord<string | null> {
  return { region: null, portrait: null, decision: null };
}

function zeroSignals(): BoardRecord<number> {
  return { region: 0, portrait: 0, decision: 0 };
}

function emptyContexts(): BoardRecord<string | null> {
  return { region: null, portrait: null, decision: null };
}

type PoDashboardAnalysisState = {
  /** 各看板当前的分析会话 key；null 表示该看板尚未触发过分析（无历史）。 */
  sessionKeys: BoardRecord<string | null>;
  /** 各看板点「刷新」自增的信号（非持久化）；Chat 页监听其变化以重跑该看板的分析。 */
  refreshSignals: BoardRecord<number>;
  /** 各看板当前的筛选上下文摘要（非持久化）；Chat 页拼进触发提示词。 */
  boardContexts: BoardRecord<string | null>;
  /** 为某看板新建一个时间戳会话 key 并置为当前（返回新 key）。 */
  startNewSession: (board: PoBoardKind) => string;
  /** 请求重跑某看板分析：仅自增该看板的 refreshSignal，由 Chat 页监听并触发新一轮分析。 */
  requestRefresh: (board: PoBoardKind) => void;
  /** 看板上报当前筛选上下文摘要（同值不写，避免无谓 re-render）。 */
  setBoardContext: (board: PoBoardKind, context: string | null) => void;
  /**
   * 从后端会话目录发现某看板「最新一个分析会话」并同步到 sessionKeys[board]。
   * 直接调 gateway 的 sessions.list RPC（返回全部会话，含被侧栏过滤的 dashboard 会话），
   * 筛出该 board 的会话后按时间戳降序取最新一个。
   * 返回发现到的最新 key；后端一个都没有则返回 null（视为无历史，应显示「开始分析」）。
   */
  discoverLatestDashboardSessionKey: (board: PoBoardKind) => Promise<string | null>;
};

export const usePoDashboardAnalysisStore = create<PoDashboardAnalysisState>()(
  persist(
    (set) => ({
      sessionKeys: emptyKeys(),
      refreshSignals: zeroSignals(),
      boardContexts: emptyContexts(),
      startNewSession: (board) => {
        const key = createPoDashboardSessionKey(board);
        set((state) => ({ sessionKeys: { ...state.sessionKeys, [board]: key } }));
        return key;
      },
      requestRefresh: (board) =>
        set((state) => ({
          refreshSignals: { ...state.refreshSignals, [board]: state.refreshSignals[board] + 1 },
        })),
      setBoardContext: (board, context) =>
        set((state) =>
          state.boardContexts[board] === context
            ? state
            : { boardContexts: { ...state.boardContexts, [board]: context } },
        ),
      discoverLatestDashboardSessionKey: async (board) => {
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
            if (!key) continue;
            const parsed = parsePoDashboardSessionKey(key);
            if (!parsed || parsed.board !== board) continue;
            if (parsed.timestamp > latestTs) {
              latestTs = parsed.timestamp;
              latestKey = key;
            }
          }
          set((state) => ({ sessionKeys: { ...state.sessionKeys, [board]: latestKey } }));
          return latestKey;
        } catch (error) {
          console.warn('discoverLatestDashboardSessionKey failed:', error);
          return null;
        }
      },
    }),
    {
      name: 'clawx.po-dashboard-analysis',
      version: 2,
      // 只持久化 sessionKeys 以跨重启判断各看板「有无历史」。
      partialize: (state) => ({ sessionKeys: state.sessionKeys }),
      // v1 持久化的是单个 sessionKey（旧画像看板专属链路），迁移为 portrait 槽位，
      // 否则老用户重启后会把 string 当 Record 读出脏值导致三看板全部判定异常。
      migrate: (persistedState, version) => {
        if (version >= 2) return persistedState as { sessionKeys: BoardRecord<string | null> };
        const legacy = (persistedState ?? {}) as { sessionKey?: unknown };
        const legacyKey = typeof legacy.sessionKey === 'string' ? legacy.sessionKey : null;
        return { sessionKeys: { ...emptyKeys(), portrait: legacyKey } };
      },
    },
  ),
);