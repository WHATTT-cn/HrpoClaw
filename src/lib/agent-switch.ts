import { hostApi } from '@/lib/host-api';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useAcpChatSessionStore } from '@/stores/acp-chat-session';
import type { AgentSummary } from '@/types/agent';

/**
 * Programmatically switch the active chat to a given agent, mirroring the
 * "@ mention" selection path in Chat/index.tsx's onSend — but WITHOUT sending
 * a prompt. This selects the agent's main session, resolves its workspace
 * context, and loads the ACP session so the chat surface is ready.
 *
 * Idempotent: if the target agent is already active, it resolves immediately.
 *
 * @returns true when the switch (or no-op) succeeded, false otherwise.
 */
export async function switchToAgent(agentId: string): Promise<boolean> {
  if (!agentId) return false;

  const agentsStore = useAgentsStore.getState();
  let target: AgentSummary | undefined = agentsStore.agents.find((a) => a.id === agentId);

  // The preset agent may not be in the renderer snapshot yet on first launch;
  // refresh once before giving up.
  if (!target) {
    await agentsStore.fetchAgents().catch(() => undefined);
    target = useAgentsStore.getState().agents.find((a) => a.id === agentId);
  }
  if (!target) return false;

  const sessionKey = target.mainSessionKey || `agent:${target.id}:main`;
  const promptCwd = target.workspace;
  if (!promptCwd) return false;

  const chatStore = useChatStore.getState();
  const acpStore = useAcpChatSessionStore.getState();

  // Already on this agent's session with a matching workspace → nothing to do.
  if (
    chatStore.currentSessionKey === sessionKey
    && acpStore.activeSessionKey === sessionKey
    && acpStore.workspaceRoot === promptCwd
    && acpStore.cwd === promptCwd
  ) {
    return true;
  }

  const existingSession = chatStore.sessions.find((s) => s.key === sessionKey);

  // Point the catalog/composer at the target session.
  chatStore.selectAcpSession(sessionKey, promptCwd);

  // Ensure the target workspace context is registered on the host side.
  const workspaceOk = await hostApi.files
    .resolveWorkspaceContext({ workspaceRoot: promptCwd, executionCwd: promptCwd })
    .then((r) => r.ok)
    .catch(() => false);
  if (!workspaceOk) return false;

  const createIfMissing = !existingSession || !!existingSession.createdLocally;
  const loaded = await acpStore.loadSession({
    sessionKey,
    workspaceRoot: promptCwd,
    cwd: promptCwd,
    ...(createIfMissing ? { createIfMissing: true } : {}),
  });
  if (!loaded) return false;

  if (createIfMissing) {
    chatStore.acknowledgeAcpSessionCreated(sessionKey, promptCwd, '');
  }
  return true;
}