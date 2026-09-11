/**
 * Chat Page
 * ACP-native runtime rendering through the ordered inline timeline.
 */
import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { AlertTriangle, ArrowDownToLine, FolderOpen, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DEFAULT_SESSION_KEY } from '@shared/chat/types';
import { Button } from '@/components/ui/button';
import { useAgentsStore } from '@/stores/agents';
import { useArtifactPanel } from '@/stores/artifact-panel';
import { useChatStore } from '@/stores/chat';
import { useComposerDraftStore } from '@/stores/composer-drafts';
import { useSessionAttentionStore } from '@/stores/session-attention';
import { useSettingsStore } from '@/stores/settings';
import { ensureAcpChatSubscriptions, useAcpChatSessionStore } from '@/stores/acp-chat-session';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import {
  getWorkspaceDisplayLabel,
  isDefaultWorkspacePath,
  normalizeWorkspacePath,
  resolveEffectiveWorkspace,
} from '@/lib/workspace-context';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { getAcpUserMessageAnchorId } from '@/lib/acp/timeline-anchors';
import type { MessageSegmentItem, RenderPart } from '@/lib/acp/timeline-types';
import { createEmptyAcpTimeline } from '@/lib/acp/reducer';
import { projectOpenClawFileActivities, type AcpFileActivityProjection } from '@/lib/acp/openclaw-file-activities';
import { hostApi } from '@/lib/host-api';
import { getSessionDisplayTitle } from '@shared/chat/session-title';
import { ChatInput, type ChatWorkspaceOption, type FileAttachment } from './ChatInput';
import { ChatToolbar } from './ChatToolbar';
import { AcpTimeline } from './AcpTimeline';
import { AcpErrorBanner } from './AcpErrorBanner';
import { SupplierPortraitDashboard } from './SupplierPortraitDashboard';
import { SupplierDecisionDashboard } from './SupplierDecisionDashboard';
import { isPoDashboardSessionKey, usePoDashboardAnalysisStore } from '@/stores/po-dashboard-analysis';

const PRESET_PO_AGENT_ID = 'po';

/** PO 看板分析 Tab 的固定触发提示词（对用户隐藏，切 Tab/刷新时自动发送以触发 po-dashboard-analysis skill）。 */
const PO_DASHBOARD_ANALYSIS_PROMPT = [
  '请调用 po-dashboard-analysis 技能，阅读工作区根目录下的 Suppliers.md，',
  '以单个物流仓为维度（按「## X物流仓」分节）逐仓分析，',
  '针对「用工保障」和「供应商分单」两项任务，分别给出建议与风险提示。',
  '不要回抄原始表格数据。',
].join('');

/** PO agent 右半区对话列的两种视图。 */
type PoRightTab = 'chat' | 'dashboard';

type PoDashboardTab = 'portrait' | 'decision';

/**
 * PO agent 左侧看板面板：画像看板（只读）/ 决策看板（可写）双 Tab 切换（方案 A）。
 * 两个看板互不替换，用户可自由在两者间切换。
 */
function PoDashboardPanel() {
  const [tab, setTab] = useState<PoDashboardTab>('portrait');
  const tabs: { key: PoDashboardTab; label: string }[] = [
    { key: 'portrait', label: '供应商画像' },
    { key: 'decision', label: '履约追踪' },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-black/5 px-3 pt-3 dark:border-white/10">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              'rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors',
              tab === item.key
                ? 'bg-black/5 text-foreground dark:bg-white/10'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'portrait' ? <SupplierPortraitDashboard /> : <SupplierDecisionDashboard />}
      </div>
    </div>
  );
}

const ArtifactPanelLazy = lazy(() =>
  import('@/components/file-preview/ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })),
);
const PanelResizeDividerLazy = lazy(() =>
  import('@/components/file-preview/PanelResizeDivider').then((m) => ({ default: m.PanelResizeDivider })),
);

const EMPTY_FILE_ACTIVITY: AcpFileActivityProjection = {
  activities: [],
  turnSummariesByTurnId: {},
  fileGroups: [],
  uniqueFileCount: 0,
};

type QuestionDirectoryItem = {
  itemId: string;
  anchorId: string;
  title: string;
};

const QUESTION_DIRECTORY_RENDER_LIMIT = 300;

type WorkspaceContextCheck = {
  key: string;
  available: boolean;
};

function buildQuestionDirectoryTitle(item: MessageSegmentItem, fallback: string): string {
  const markdown = item.parts.find(
    (part): part is Extract<RenderPart, { kind: 'markdown' }> => part.kind === 'markdown' && part.text.trim().length > 0,
  );
  const normalized = markdown?.text.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized),
    ({ segment }) => segment,
  );
  return graphemes.length > 64 ? `${graphemes.slice(0, 61).join('')}...` : normalized;
}

function isRecoverableInitialAcpLoadError(message: string | null): boolean {
  return !!message && message.includes("reply was never sent");
}

function QuestionDirectory({ items }: { items: QuestionDirectoryItem[] }) {
  const { t } = useTranslation('chat');
  const navRef = useRef<HTMLElement | null>(null);
  const visibleItems = items.slice(-QUESTION_DIRECTORY_RENDER_LIMIT);
  const hiddenCount = items.length - visibleItems.length;

  useEffect(() => {
    const nav = navRef.current;
    if (nav) nav.scrollTop = nav.scrollHeight;
  }, [items.length]);

  return (
    <aside
      id="chat-question-directory"
      data-testid="chat-question-directory"
      aria-label={t('questionDirectory.title')}
      className="absolute right-0 top-0 z-30 flex max-h-[min(32rem,calc(100%-1rem))] w-[min(18rem,calc(100%-1rem))] flex-col overflow-hidden rounded-2xl border border-black/10 bg-surface-modal/95 p-3 shadow-xl shadow-black/10 backdrop-blur-xl dark:border-white/10 dark:shadow-black/30"
    >
      <h2 className="px-1 pb-2 text-sm font-medium text-foreground">{t('questionDirectory.title')}</h2>
      <nav
        ref={navRef}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto"
        aria-label={t('questionDirectory.title')}
      >
        {visibleItems.map((item) => (
          <button
            key={item.itemId}
            type="button"
            data-testid={`chat-question-directory-item-${item.itemId}`}
            title={item.title}
            onClick={() => document.getElementById(item.anchorId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-foreground/80 transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:hover:bg-white/10"
          >
            <span className="block truncate">{item.title}</span>
          </button>
        ))}
      </nav>
      {hiddenCount > 0 && (
        <p className="px-1 pt-2 text-xs text-muted-foreground">
          {t('questionDirectory.moreHint', { count: hiddenCount })}
        </p>
      )}
    </aside>
  );
}

function AcpEmptyState() {
  const { t } = useTranslation('chat');
  return (
    <div data-testid="acp-chat-empty-state" className="flex h-[60vh] flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-serif font-normal tracking-tight text-foreground/80 md:text-5xl">
        {t('welcome.subtitle')}
      </h1>
    </div>
  );
}

/**
 * 看板分析 Tab 专属的空态提示。因为固定提示词对用户隐藏、user 段被过滤，
 * timeline 为空时不能沿用通用「我能为你做些什么」空态，否则会误导用户以为未触发。
 * 按当前运行状态区分：分析中 / 失败可重试 / 空闲无输出。
 */
function PoDashboardAnalysisState({
  status,
  errorMessage,
  onRetry,
}: {
  status: 'running' | 'error' | 'idle';
  errorMessage?: string | null;
  onRetry: () => void;
}) {
  if (status === 'running') {
    return (
      <div
        data-testid="po-dashboard-analysis-running"
        className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center"
      >
        <LoadingSpinner size="md" />
        <p className="text-sm text-muted-foreground">正在分析供应商画像数据，请稍候…</p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div
        data-testid="po-dashboard-analysis-error"
        className="flex h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <p className="text-sm font-medium text-foreground">看板分析未能完成</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {errorMessage || '大模型请求超时或失败，未返回分析结果。'}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          可点击左侧画像看板的「刷新」按钮重跑分析。
        </p>
      </div>
    );
  }
  return (
    <div
      data-testid="po-dashboard-analysis-idle"
      className="flex h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <p className="text-sm text-muted-foreground">尚无分析结果。</p>
      <button
        type="button"
        onClick={onRetry}
        data-testid="po-dashboard-analysis-start"
        className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span>开始分析</span>
      </button>
    </div>
  );
}

function WorkspaceUnavailableBanner({
  path,
  readOnly,
  onChooseWorkspace,
}: {
  path: string;
  readOnly: boolean;
  onChooseWorkspace?: () => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <div
      data-testid="workspace-unavailable-banner"
      className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-surface-modal px-4 py-3 text-amber-700 shadow-sm dark:text-amber-400"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('workspace.unavailable.title')}</p>
        <p className="mt-1 break-words text-sm opacity-80">
          {t(readOnly ? 'workspace.unavailable.boundDescription' : 'workspace.unavailable.description', { path })}
        </p>
        {!readOnly && onChooseWorkspace && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 border-amber-500/30 bg-transparent text-amber-700 hover:bg-black/5 dark:text-amber-400 dark:hover:bg-white/10"
            onClick={onChooseWorkspace}
          >
            <FolderOpen className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('workspace.unavailable.chooseAction')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function Chat() {
  ensureAcpChatSubscriptions();

  const { t } = useTranslation('chat');

  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const composerDraft = useComposerDraftStore((s) => s.drafts[currentSessionKey] ?? '');
  const setComposerDraft = useComposerDraftStore((s) => s.setDraft);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectAcpSession = useChatStore((s) => s.selectAcpSession);
  const acknowledgeAcpSessionCreated = useChatStore((s) => s.acknowledgeAcpSessionCreated);
  const setVisibleSession = useSessionAttentionStore((s) => s.setVisibleSession);
  const chatWorkspacePath = useSettingsStore((s) => s.chatWorkspacePath);
  const recentWorkspacePaths = useSettingsStore((s) => s.recentWorkspacePaths ?? []);
  const workspaceLabels = useSettingsStore((s) => s.workspaceLabels);
  const setChatWorkspacePath = useSettingsStore((s) => s.setChatWorkspacePath);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const agents = useAgentsStore((s) => s.agents);
  const [sessionDiscoveryAttempted, setSessionDiscoveryAttempted] = useState(false);
  const [lastPromptAttemptSessionKey, setLastPromptAttemptSessionKey] = useState<string | null>(null);
  const [questionDirectoryOpenSessionKey, setQuestionDirectoryOpenSessionKey] = useState<string | null>(null);
  const [resolvedWorkspaceContext, setResolvedWorkspaceContext] = useState<{
    key: string;
    sessionKey: string;
    workspaceRoot: string;
    executionCwd: string;
  } | null>(null);
  const [workspaceContextCheck, setWorkspaceContextCheck] = useState<WorkspaceContextCheck | null>(null);
  const currentSession = useMemo(
    () => sessions.find((session) => session.key === currentSessionKey) ?? null,
    [currentSessionKey, sessions],
  );
  const currentAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const currentSessionTitle = currentSession
    ? getSessionDisplayTitle(currentSession, sessionLabels)
    : currentSessionKey;
  const effectiveWorkspace = useMemo(
    () => resolveEffectiveWorkspace({
      session: currentSession,
      globalWorkspace: chatWorkspacePath,
      defaultWorkspace: currentSessionKey === DEFAULT_SESSION_KEY
        ? currentAgent?.workspace
        : undefined,
    }),
    [chatWorkspacePath, currentAgent?.workspace, currentSession, currentSessionKey],
  );
  const cwd = effectiveWorkspace.cwd;
  const allWorkspacePaths = useMemo(() => {
    const seen = new Set<string>();
    const paths: string[] = [];
    const candidatePaths = [
      ...recentWorkspacePaths,
      chatWorkspacePath,
      ...sessions.map((session) => session.workspacePath).filter((path): path is string => !!path),
    ];
    for (const path of candidatePaths) {
      const normalized = normalizeWorkspacePath(path);
      if (!normalized || isDefaultWorkspacePath(normalized)) continue;
      const slashedPath = normalized.replace(/\\/g, '/');
      const identity = /^[A-Za-z]:\//.test(slashedPath) ? slashedPath.toLowerCase() : slashedPath;
      if (seen.has(identity)) continue;
      seen.add(identity);
      paths.push(normalized);
    }
    return paths;
  }, [chatWorkspacePath, recentWorkspacePaths, sessions]);
  const workspaceLabel = getWorkspaceDisplayLabel(
    cwd,
    t('workspace.defaultLabel'),
    workspaceLabels,
    allWorkspacePaths,
  );
  const workspaceOptions = useMemo<ChatWorkspaceOption[]>(() => {
    return allWorkspacePaths.map((normalized) => ({
      path: normalized,
      label: getWorkspaceDisplayLabel(
        normalized,
        t('workspace.defaultLabel'),
        workspaceLabels,
        allWorkspacePaths,
      ),
    }));
  }, [allWorkspacePaths, t, workspaceLabels]);
  const acpTimeline = useAcpChatSessionStore((s) => s.timeline);
  const acpActiveSessionKey = useAcpChatSessionStore((s) => s.activeSessionKey);
  const renderedAcpTimeline = useDeferredValue(acpTimeline);
  const emptyCurrentTimeline = useMemo(
    () => createEmptyAcpTimeline(currentSessionKey ?? '', 0),
    [currentSessionKey],
  );
  const visibleAcpTimeline = acpActiveSessionKey === currentSessionKey
    ? renderedAcpTimeline
    : acpTimeline.sessionId === currentSessionKey
      ? acpTimeline
      : emptyCurrentTimeline;
  const acpTurnTimings = useAcpChatSessionStore((s) => s.turnTimingsByUserMessageId);
  const acpLoading = useAcpChatSessionStore((s) => s.loading);
  const acpSending = useAcpChatSessionStore((s) => s.sending);
  const imageGenerationPending = useAcpChatSessionStore(
    (s) => Boolean(s.pendingImageGenerationTaskIds?.length),
  );
  const acpCancelling = useAcpChatSessionStore((s) => s.cancelling);
  const acpError = useAcpChatSessionStore((s) => s.error);
  const acpWorkspaceRoot = useAcpChatSessionStore((s) => s.workspaceRoot);
  const acpCwd = useAcpChatSessionStore((s) => s.cwd);
  const prepareLocalAcpSession = useAcpChatSessionStore((s) => s.prepareLocalSession);
  const loadAcpSession = useAcpChatSessionStore((s) => s.loadSession);
  const sendAcpPrompt = useAcpChatSessionStore((s) => s.sendPrompt);
  const cancelAcp = useAcpChatSessionStore((s) => s.cancel);
  const respondAcpPermission = useAcpChatSessionStore((s) => s.respondPermission);
  const clearAcpError = useAcpChatSessionStore((s) => s.clearError);

  const panelOpen = useArtifactPanel((s) => s.open);
  const panelWidthPct = useArtifactPanel((s) => s.widthPct);
  const closeArtifactPanel = useArtifactPanel((s) => s.close);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const acpLoadInFlightKeyRef = useRef<string | null>(null);
  const { contentRef, scrollRef, scrollToBottom, isAtBottom } = useStickToBottomInstant(
    currentSessionKey,
    acpSending || acpCancelling,
  );

  useEffect(() => {
    setVisibleSession(currentSessionKey);
    return () => setVisibleSession(null);
  }, [currentSessionKey, setVisibleSession]);

  useEffect(() => {
    void fetchAgents().catch(() => undefined);
  }, [fetchAgents]);

  useEffect(() => {
    closeArtifactPanel();
  }, [currentSessionKey, closeArtifactPanel]);

  const projectionExecutionCwd = acpActiveSessionKey === currentSessionKey && acpCwd ? acpCwd : cwd;
  const workspaceContextKey = currentSessionKey && cwd && projectionExecutionCwd
    ? `${currentSessionKey}\0${cwd}\0${projectionExecutionCwd}`
    : null;

  useEffect(() => {
    if (!workspaceContextKey || !currentSessionKey || !cwd || !projectionExecutionCwd) return;
    let stale = false;
    setWorkspaceContextCheck(null);
    void hostApi.files.resolveWorkspaceContext({
      workspaceRoot: cwd,
      executionCwd: projectionExecutionCwd,
    }).then((result) => {
      if (stale) return;
      if (!result.ok || !result.workspaceRoot || !result.executionCwd) {
        setResolvedWorkspaceContext(null);
        setWorkspaceContextCheck({ key: workspaceContextKey, available: false });
        return;
      }
      setResolvedWorkspaceContext({
        key: workspaceContextKey,
        sessionKey: currentSessionKey,
        workspaceRoot: result.workspaceRoot,
        executionCwd: result.executionCwd,
      });
      setWorkspaceContextCheck({ key: workspaceContextKey, available: true });
    }).catch(() => {
      if (stale) return;
      setResolvedWorkspaceContext(null);
      setWorkspaceContextCheck({ key: workspaceContextKey, available: false });
    });
    return () => {
      stale = true;
    };
  }, [currentSessionKey, cwd, projectionExecutionCwd, workspaceContextKey]);

  const workspaceContextAvailable = !!workspaceContextKey
    && workspaceContextCheck?.key === workspaceContextKey
    && workspaceContextCheck.available;
  const workspaceUnavailable = !!workspaceContextKey
    && workspaceContextCheck?.key === workspaceContextKey
    && !workspaceContextCheck.available;

  useEffect(() => {
    if (currentSessionKey !== DEFAULT_SESSION_KEY || sessions.length > 0 || sessionDiscoveryAttempted) return;
    let cancelled = false;
    void loadSessions()
      .finally(() => {
        if (!cancelled) setSessionDiscoveryAttempted(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentSessionKey, loadSessions, sessionDiscoveryAttempted, sessions.length]);

  // PO 看板分析历史会话 key（持久化，null=无历史）。提前到所有引用它的 effect 之前声明，
  // 以便下方 effect 的依赖数组能安全引用它，避免暂时性死区（TDZ）。
  const poDashboardSessionKey = usePoDashboardAnalysisStore((s) => s.sessionKey);

  useEffect(() => {
    if (!currentSessionKey || !cwd || !currentSession?.createdLocally) return;
    // 第三道拦截豁免：已持久化的 dashboard 历史会话不能在此调 prepareLocalSession，
    // 否则会抢占 acpActiveSessionKey 并清空 timeline，使下方加载 effect 的 activeSessionKey
    // 守卫命中而跳过 loadSession，导致「有历史却显示空态」。放行给加载 effect 走 loadSession 回放。
    const isPersistedDashboardHistory =
      isPoDashboardSessionKey(currentSessionKey) && currentSessionKey === poDashboardSessionKey;
    if (isPersistedDashboardHistory) return;
    acpLoadInFlightKeyRef.current = null;
    const hasStaleTimeline = acpTimeline.sessionId !== currentSessionKey || acpTimeline.itemOrder.length > 0;
    if (acpActiveSessionKey === currentSessionKey && acpWorkspaceRoot === cwd && acpCwd === cwd && !hasStaleTimeline) return;
    prepareLocalAcpSession({ sessionKey: currentSessionKey, workspaceRoot: cwd, cwd });
  }, [acpActiveSessionKey, acpCwd, acpTimeline.itemOrder.length, acpTimeline.sessionId, acpWorkspaceRoot, currentSession, currentSessionKey, cwd, poDashboardSessionKey, prepareLocalAcpSession]);

  useEffect(() => {
    if (!currentSessionKey || !cwd || !workspaceContextAvailable) return;
    if (currentSessionKey === DEFAULT_SESSION_KEY && sessions.length === 0 && acpActiveSessionKey == null && !sessionDiscoveryAttempted) return;
    if (acpActiveSessionKey === currentSessionKey && acpWorkspaceRoot === cwd && acpCwd === cwd) return;
    const acpLoadKey = `${currentSessionKey}\0${cwd}`;
    if (acpLoadInFlightKeyRef.current === acpLoadKey) return;
    const currentSession = sessions.find((session) => session.key === currentSessionKey);
    // PO 看板分析历史会话经 selectAcpSession 会被标记 createdLocally 塞进 sessions
    //（隐形会话不进后端侧栏列表，ensureSessionEntry 对新 key 恒打 createdLocally），
    // 但它本质是后端已持久化的会话，必须放行去 loadSession 回放历史 transcript；
    // 否则会因下方 createdLocally 提前 return，导致「有历史却显示尚无分析结果」。
    const isPersistedDashboardHistory =
      isPoDashboardSessionKey(currentSessionKey) && currentSessionKey === poDashboardSessionKey;
    if (currentSession?.createdLocally && !isPersistedDashboardHistory) return;
    // 命中已持久化的 dashboard key 时 createIfMissing=false 走 loadSession 回放历史 transcript，
    // 否则默认 !currentSession 恒为 true 会走 newSession 新建空会话，历史永远显示不出来。
    const createIfMissing = !currentSession && !isPersistedDashboardHistory;
    acpLoadInFlightKeyRef.current = acpLoadKey;
    if (createIfMissing) selectAcpSession(currentSessionKey, cwd);
    void loadAcpSession({
      sessionKey: currentSessionKey,
      workspaceRoot: cwd,
      cwd,
      ...(createIfMissing ? { createIfMissing: true } : {}),
    }).then((loaded) => {
      if (loaded && createIfMissing) {
        acknowledgeAcpSessionCreated(currentSessionKey, cwd);
      }
    }).finally(() => {
      if (acpLoadInFlightKeyRef.current === acpLoadKey) {
        acpLoadInFlightKeyRef.current = null;
      }
    });
  }, [acknowledgeAcpSessionCreated, acpActiveSessionKey, acpCwd, acpWorkspaceRoot, currentSessionKey, cwd, loadAcpSession, poDashboardSessionKey, selectAcpSession, sessionDiscoveryAttempted, sessions, workspaceContextAvailable]);

  const platform = window.electron?.platform;
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  const composerBusy = acpSending || acpCancelling;
  const showScrollToLatest = visibleAcpTimeline.itemOrder.length > 0 && !isAtBottom;
  const hasAttemptedAcpPromptForCurrentSession = lastPromptAttemptSessionKey === currentSessionKey;
  const visibleAcpError = !workspaceUnavailable && acpError
    && !(acpTimeline.itemOrder.length === 0 && !hasAttemptedAcpPromptForCurrentSession && isRecoverableInitialAcpLoadError(acpError))
    ? acpError
    : null;
  const chooseReplacementWorkspace = async () => {
    try {
      const result = await hostApi.dialog.open({
        title: t('composer.workspacePickerTitle'),
        buttonLabel: t('composer.workspacePickerButton'),
        properties: ['openDirectory', 'createDirectory'],
      });
      const selected = result.filePaths[0]?.trim();
      if (!result.canceled && selected) setChatWorkspacePath(selected);
    } catch {
      toast.error(t('composer.workspacePickerFailed'));
    }
  };
  const fileActivity = useMemo(() => {
    if (
      !workspaceContextKey
      || resolvedWorkspaceContext?.key !== workspaceContextKey
      || resolvedWorkspaceContext.sessionKey !== currentSessionKey
      || acpActiveSessionKey !== currentSessionKey
      || visibleAcpTimeline.sessionId !== currentSessionKey
    ) return EMPTY_FILE_ACTIVITY;
    return projectOpenClawFileActivities({
      timeline: visibleAcpTimeline,
      workspaceRoot: resolvedWorkspaceContext.workspaceRoot,
      executionCwd: resolvedWorkspaceContext.executionCwd,
    });
  }, [acpActiveSessionKey, currentSessionKey, resolvedWorkspaceContext, visibleAcpTimeline, workspaceContextKey]);
  const questionDirectoryItems = useMemo(() => {
    const userItems = visibleAcpTimeline.itemOrder
      .map((itemId) => visibleAcpTimeline.itemsById[itemId])
      .filter((item): item is MessageSegmentItem => item?.kind === 'message-segment' && item.role === 'user');
    return userItems.map((item, index) => ({
      itemId: item.id,
      anchorId: getAcpUserMessageAnchorId(item.id),
      title: buildQuestionDirectoryTitle(item, t('questionDirectory.fallback', { number: index + 1 })),
    }));
  }, [t, visibleAcpTimeline]);
  const questionDirectoryVisible = questionDirectoryOpenSessionKey === currentSessionKey
    && questionDirectoryItems.length > 1;
  const composerContextUsage = visibleAcpTimeline.metadata.usage;
  const handleComposerDraftChange = useCallback((update: SetStateAction<string>) => {
    setComposerDraft(currentSessionKey, update);
  }, [currentSessionKey, setComposerDraft]);

  // 提取「加载会话并发送 prompt」的共享逻辑，供普通 onSend 与看板分析隐藏触发复用。
  const runAcpPrompt = useCallback((params: {
    sessionKey: string;
    promptCwd: string;
    text: string;
    media?: Parameters<typeof sendAcpPrompt>[0]['media'];
    createIfMissing: boolean;
  }) => {
    const { sessionKey, promptCwd, text, media, createIfMissing } = params;
    setLastPromptAttemptSessionKey(sessionKey);
    void (async () => {
      if (promptCwd !== cwd) {
        const promptWorkspace = await hostApi.files.resolveWorkspaceContext({
          workspaceRoot: promptCwd,
          executionCwd: promptCwd,
        }).catch(() => ({ ok: false }));
        if (!promptWorkspace.ok) return;
      }
      if (
        createIfMissing
        || acpActiveSessionKey !== sessionKey
        || acpWorkspaceRoot !== promptCwd
        || acpCwd !== promptCwd
      ) {
        const acpLoadKey = `${sessionKey}\0${promptCwd}`;
        acpLoadInFlightKeyRef.current = acpLoadKey;
        const loaded = await (async () => {
          try {
            return await loadAcpSession({
              sessionKey,
              workspaceRoot: promptCwd,
              cwd: promptCwd,
              ...(createIfMissing ? { createIfMissing: true } : {}),
            });
          } finally {
            if (acpLoadInFlightKeyRef.current === acpLoadKey) {
              acpLoadInFlightKeyRef.current = null;
            }
          }
        })();
        if (loaded && createIfMissing) {
          acknowledgeAcpSessionCreated(sessionKey, promptCwd, text);
        }
        if (!loaded) return;
      }
      const sendPromise = sendAcpPrompt({
        sessionKey,
        cwd: promptCwd,
        message: text,
        media,
      });
      requestAnimationFrame(() => {
        void scrollToBottom({ animation: 'instant', ignoreEscapes: true });
      });
      await sendPromise;
    })();
  }, [acpActiveSessionKey, acpCwd, acpWorkspaceRoot, acknowledgeAcpSessionCreated, cwd, loadAcpSession, scrollToBottom, sendAcpPrompt]);

  // ── PO 看板分析 Tab（阶段四）──────────────────────────────────────────
  const isPoAgent = currentAgentId === PRESET_PO_AGENT_ID;
  const startPoDashboardSession = usePoDashboardAnalysisStore((s) => s.startNewSession);
  const discoverLatestPoDashboardSessionKey = usePoDashboardAnalysisStore(
    (s) => s.discoverLatestDashboardSessionKey,
  );
  // 右半区 Tab 由当前会话 key 派生：命中 dashboard key 即处于「看板分析」视图。
  // 这样即便用户从侧栏切走其它会话，视图也能与全局会话天然保持一致。
  const poRightTab: PoRightTab = isPoDashboardSessionKey(currentSessionKey) ? 'dashboard' : 'chat';
  // 记住最后一次「对话」会话 key，供从看板分析 Tab 切回时恢复。
  const lastChatSessionKeyRef = useRef<string>(DEFAULT_SESSION_KEY);
  useEffect(() => {
    if (!isPoDashboardSessionKey(currentSessionKey)) {
      lastChatSessionKeyRef.current = currentSessionKey;
    }
  }, [currentSessionKey]);

  // 统一入口：新建看板分析会话（时间戳 key，模拟覆盖旧记录）并隐藏触发一次分析。
  const triggerPoDashboardAnalysis = useCallback(() => {
    const newKey = startPoDashboardSession();
    // 同步占用 in-flight 锁，避免加载 effect 抢先对这个尚未在后端创建的新 key
    // 误走 createIfMissing=false 的 loadSession 分支（新 key 会被识别为「已持久化历史」）。
    acpLoadInFlightKeyRef.current = `${newKey}\0${cwd}`;
    selectAcpSession(newKey, cwd);
    runAcpPrompt({
      sessionKey: newKey,
      promptCwd: cwd,
      text: PO_DASHBOARD_ANALYSIS_PROMPT,
      createIfMissing: true,
    });
  }, [cwd, runAcpPrompt, selectAcpSession, startPoDashboardSession]);

  const handleSelectPoRightTab = useCallback((nextTab: PoRightTab) => {
    if (nextTab === poRightTab) return;
    if (nextTab === 'chat') {
      selectAcpSession(lastChatSessionKeyRef.current);
      return;
}
    // 切到看板分析：统一以后端真实会话为准，发现「最新一个 dashboard 会话」并加载其历史；
    // 后端确实一个都没有（首次使用）才新建会话并隐藏触发一次分析。
    // 先用前端持久化 key 立即加载兜底（避免等待 RPC 的空窗），再用后端发现结果校正。
    if (poDashboardSessionKey) {
      selectAcpSession(poDashboardSessionKey, cwd);
    }
 void (async () => {
 const latestKey = await discoverLatestPoDashboardSessionKey();
      if (latestKey) {
        // 后端存在会话：加载最新一个的历史（若与兜底 key 相同则为幂等切换）。
     selectAcpSession(latestKey, cwd);
        return;
      }
      // 后端一个都没有：仅当前端也无兜底 key 时才触发首次分析，避免重复触发。
      if (!poDashboardSessionKey) {
        triggerPoDashboardAnalysis();
      }
    })();
  }, [
  cwd,
    discoverLatestPoDashboardSessionKey,
    poDashboardSessionKey,
    poRightTab,
    selectAcpSession,
    triggerPoDashboardAnalysis,
  ]);

  const showPoRightTabs = isPoAgent;
  const isPoDashboardView = showPoRightTabs && poRightTab === 'dashboard';

  // 画像看板点「刷新」→ store.requestRefresh 自增 refreshSignal → 此处监听并重跑看板分析。
  // 「重跑分析」的权力收敛到画像刷新按钮：看板分析 Tab 不再单独提供「重新分析」按钮。
  const poDashboardRefreshSignal = usePoDashboardAnalysisStore((s) => s.refreshSignal);
  const prevPoDashboardRefreshSignalRef = useRef(poDashboardRefreshSignal);
  useEffect(() => {
    if (poDashboardRefreshSignal === prevPoDashboardRefreshSignalRef.current) return;
    prevPoDashboardRefreshSignalRef.current = poDashboardRefreshSignal;
    if (!isPoAgent) return;
    // 新建时间戳会话覆盖旧分析（模拟「刷新即重跑」）。
    triggerPoDashboardAnalysis();
  }, [poDashboardRefreshSignal, isPoAgent, triggerPoDashboardAnalysis]);

  // 看板分析视图下 timeline 为空时的状态：分析中 / 失败 / 空闲。
  const poDashboardAnalysisStatus: 'running' | 'error' | 'idle' =
    acpSending || acpCancelling || acpLoading
      ? 'running'
      : visibleAcpError
        ? 'error'
        : 'idle';

  // 看板分析视图下的可见项数：user 段被隐藏，需排除后判断是否真的有可见输出。
  const poDashboardVisibleItemCount = useMemo(() => {
    let count = 0;
    for (const itemId of visibleAcpTimeline.itemOrder) {
      const item = visibleAcpTimeline.itemsById[itemId];
      if (item?.kind === 'message-segment' && item.role === 'user') continue;
      count += 1;
    }
    return count;
  }, [visibleAcpTimeline]);

  // 看板分析视图下，若可见输出为空（仅隐藏的 user 段），则用状态提示替代 timeline。
  const showPoDashboardState = isPoDashboardView && poDashboardVisibleItemCount === 0;

  return (
    <div
      ref={splitContainerRef}
      data-testid="chat-page"
      className={cn(
        'relative flex min-h-0 -m-6 overflow-hidden transition-colors duration-500',
        'bg-background',
        isMac && 'z-20 rounded-tl-2xl shadow-[inset_1px_1px_0_hsl(var(--border)/0.55)]',
        isWindows && 'rounded-tl-2xl',
      )}
      style={{ height: isMac ? 'calc(100vh - 1px)' : 'calc(100vh - 2.5rem)' }}
    >
      {currentAgentId === PRESET_PO_AGENT_ID && (
        <aside className="hidden w-1/2 shrink-0 border-r border-black/5 dark:border-white/10 lg:flex lg:flex-col">
          <PoDashboardPanel />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={cn(
          'relative flex shrink-0 items-center px-4 py-2',
          isWindows ? 'gap-4' : 'justify-end',
        )}>
          <div data-testid="chat-toolbar-drag-region" className="drag-region absolute inset-0 z-0" aria-hidden="true" />
          {isWindows && (
            <div className="drag-region relative z-10 min-w-0 flex-1">
              <h1
                data-testid="chat-session-title"
                title={currentSessionTitle}
                className="truncate text-sm font-medium text-foreground"
              >
                {currentSessionTitle}
              </h1>
            </div>
          )}
          <div data-testid="chat-toolbar-actions" className="no-drag relative z-10">
            <ChatToolbar
              questionDirectoryOpen={questionDirectoryVisible}
              questionDirectoryCount={questionDirectoryItems.length}
              onToggleQuestionDirectory={() => setQuestionDirectoryOpenSessionKey((openSessionKey) => (
                openSessionKey === currentSessionKey ? null : currentSessionKey
              ))}
              workspaceAvailable={!!cwd}
            />
          </div>
        </div>

        {showPoRightTabs && (
          <div className="flex shrink-0 gap-1 border-b border-black/5 px-4 pb-0 pt-1 dark:border-white/10">
            {([
              { key: 'chat', label: '对话' },
              { key: 'dashboard', label: '看板分析' },
            ] as { key: PoRightTab; label: string }[]).map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`po-right-tab-${item.key}`}
                onClick={() => handleSelectPoRightTab(item.key)}
                className={cn(
                  'rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  poRightTab === item.key
                    ? 'bg-black/5 text-foreground dark:bg-white/10'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden px-4 py-4">
          <div className="relative mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col">
            <div data-testid="chat-scroll-column" className="relative min-h-0 min-w-0 flex-1">
              <div ref={scrollRef} className="h-full min-h-0 min-w-0 overflow-y-auto" data-testid="chat-scroll-container">
                <div ref={contentRef} className="mx-auto max-w-4xl space-y-4">
                  {workspaceUnavailable && (
                    <WorkspaceUnavailableBanner
                      path={cwd}
                      readOnly={effectiveWorkspace.readOnly}
                      onChooseWorkspace={effectiveWorkspace.readOnly ? undefined : () => void chooseReplacementWorkspace()}
                    />
                  )}
                  {visibleAcpError && <AcpErrorBanner message={visibleAcpError} onDismiss={clearAcpError} />}
                  {acpLoading ? (
                    <div className="flex min-h-[40vh] items-center justify-center" data-testid="acp-chat-loading">
                      <LoadingSpinner size="md" />
                    </div>
                  ) : showPoDashboardState ? (
                    <PoDashboardAnalysisState
                      status={poDashboardAnalysisStatus}
                      errorMessage={visibleAcpError}
                      onRetry={triggerPoDashboardAnalysis}
                    />
                  ) : visibleAcpTimeline.itemOrder.length === 0 ? (
                    <AcpEmptyState />
                  ) : (
                    <AcpTimeline
                      snapshot={visibleAcpTimeline}
                      isStreaming={acpSending || acpCancelling}
                      turnTimingsByUserMessageId={acpTurnTimings}
                      fileActivity={fileActivity}
                      hideUserSegments={isPoDashboardView}
                      workspaceRoot={resolvedWorkspaceContext?.key === workspaceContextKey
                        ? resolvedWorkspaceContext.workspaceRoot
                        : undefined}
                      onPermissionSelect={(requestId, optionId) => {
                        void respondAcpPermission(requestId, optionId);
                      }}
                    />
                  )}
                </div>
              </div>

              {showScrollToLatest && (
                <button
                  type="button"
                  onClick={() => void scrollToBottom({ animation: 'smooth', ignoreEscapes: true })}
                  className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:hover:bg-white/10 dark:shadow-black/30"
                  aria-label={t('scrollToLatest')}
                  title={t('scrollToLatest')}
                  data-testid="chat-scroll-to-latest"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  <span>{t('scrollToLatest')}</span>
                </button>
              )}
            </div>

            {questionDirectoryVisible && <QuestionDirectory items={questionDirectoryItems} />}
          </div>
        </div>

        {!isPoDashboardView && (
          <ChatInput
            draft={composerDraft}
            onDraftChange={handleComposerDraftChange}
            onSend={(text: string, attachments?: FileAttachment[], targetAgentId?: string | null) => {
              if (!currentSessionKey || !cwd || !workspaceContextAvailable) return;
              const targetAgent = targetAgentId
                ? agents.find((agent) => agent.id === targetAgentId) ?? null
                : null;
              const sessionKey = targetAgent
                ? targetAgent.mainSessionKey || `agent:${targetAgent.id}:main`
                : currentSessionKey;
              const existingSession = sessions.find((session) => session.key === sessionKey);
              const promptCwd = targetAgent?.workspace || cwd;
              const media = attachments
                ?.filter((file) => file.status === 'ready')
                .map((file) => ({
                  filePath: file.stagedPath,
                  stagingId: file.id,
                  fileName: file.fileName,
                  mimeType: file.mimeType,
                }));
              if (targetAgent || !existingSession) {
                selectAcpSession(sessionKey, promptCwd);
              }
              const createIfMissing = !existingSession || !!existingSession.createdLocally;
              runAcpPrompt({ sessionKey, promptCwd, text, media, createIfMissing });
            }}
            onStop={() => void cancelAcp()}
            disabled={acpLoading || acpCancelling || !cwd || !workspaceContextAvailable}
            sending={composerBusy}
            imageGenerating={imageGenerationPending}
            workspaceLabel={workspaceLabel}
            workspacePath={cwd}
            workspaceOptions={workspaceOptions}
            workspaceReadOnly={effectiveWorkspace.readOnly}
            onSelectWorkspace={setChatWorkspacePath}
            contextUsage={composerContextUsage}
          />
        )}
      </div>

      {panelOpen && (
        <>
          <Suspense fallback={null}>
            <PanelResizeDividerLazy containerRef={splitContainerRef} />
          </Suspense>
          <aside
            data-testid="artifact-panel-aside"
            className={cn(
              'relative z-20 hidden shrink-0 border-l border-black/5 dark:border-white/10 lg:flex lg:flex-col',
              isMac && 'no-drag',
            )}
            style={{ width: `${panelWidthPct}%` }}
          >
            <Suspense
              fallback={(
                <div className="flex h-full items-center justify-center">
                  <LoadingSpinner size="md" />
                </div>
              )}
            >
              <ArtifactPanelLazy
                fileGroups={fileActivity.fileGroups}
                uniqueFileCount={fileActivity.uniqueFileCount}
                agent={currentAgent}
                workspacePath={cwd}
                workspaceLabel={workspaceLabel}
                runStartedAt={null}
              />
            </Suspense>
          </aside>
        </>
      )}
    </div>
  );
}

export default Chat;
