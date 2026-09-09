import { copyFile, lstat, mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join, normalize } from 'path';
import { isDeepStrictEqual } from 'node:util';
import { mutateOpenClawConfig } from '../gateway/config-delivery';
import { deleteAgentChannelAccounts, listConfiguredChannelsFromConfig, readOpenClawConfig } from './channel-config';
import type { OpenClawConfig } from './channel-config';
import { expandPath, getOpenClawConfigDir } from './paths';
import * as logger from './logger';
import { toUiChannelType } from './channel-alias';
import { ensureClawXIdentityFile } from './openclaw-workspace';
import {
  applyModelAwareCompactionReserveTokensFloor,
  resolveModelContextWindow,
} from './openclaw-compaction';

const MAIN_AGENT_ID = 'main';
const MAIN_AGENT_NAME = 'Main Agent';
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_WORKSPACE_PATH = '~/.openclaw/workspace';
const AGENT_BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'IDENTITY.md',
  'HEARTBEAT.md',
  'BOOT.md',
];
const AGENT_RUNTIME_FILES = [
  'auth-profiles.json',
  'models.json',
];

interface AgentModelConfig {
  primary?: string;
  [key: string]: unknown;
}

interface AgentDefaultsConfig {
  workspace?: string;
  model?: string | AgentModelConfig;
  [key: string]: unknown;
}

interface AgentListEntry extends Record<string, unknown> {
  id: string;
  name?: string;
  default?: boolean;
  workspace?: string;
  agentDir?: string;
  model?: string | AgentModelConfig;
}

interface AgentsConfig extends Record<string, unknown> {
  defaults?: AgentDefaultsConfig;
  list?: AgentListEntry[];
}

interface BindingMatch extends Record<string, unknown> {
  channel?: string;
  accountId?: string;
}

interface BindingConfig extends Record<string, unknown> {
  agentId?: string;
  match?: BindingMatch;
}

interface ChannelBindingConfig extends BindingConfig {
  agentId: string;
  match: BindingMatch & { channel: string };
}

interface ChannelSectionConfig extends Record<string, unknown> {
  accounts?: Record<string, Record<string, unknown>>;
  defaultAccount?: string;
  enabled?: boolean;
}

interface AgentConfigDocument extends Record<string, unknown> {
  agents?: AgentsConfig;
  bindings?: BindingConfig[];
  channels?: Record<string, ChannelSectionConfig>;
  session?: {
    mainKey?: string;
    [key: string]: unknown;
  };
}

export interface AgentSummary {
  id: string;
  name: string;
  isDefault: boolean;
  modelDisplay: string;
  modelRef: string | null;
  overrideModelRef: string | null;
  contextWindow?: number;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
}

function resolveModelRef(model: unknown): string | null {
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }

  if (model && typeof model === 'object') {
    const primary = (model as AgentModelConfig).primary;
    if (typeof primary === 'string' && primary.trim()) {
      return primary.trim();
    }
  }

  return null;
}

function formatModelLabel(model: unknown): string | null {
  const modelRef = resolveModelRef(model);
  if (modelRef) {
    const trimmed = modelRef;
    const parts = trimmed.split('/');
    return parts[parts.length - 1] || trimmed;
  }

  return null;
}

function normalizeAgentName(name: string): string {
  return name.trim() || 'Agent';
}

function slugifyAgentId(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized || /^\d+$/.test(normalized)) return 'agent';
  if (normalized === MAIN_AGENT_ID) return 'agent';
  return normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    await mkdir(path, { recursive: true });
  }
}

function getDefaultWorkspacePath(config: AgentConfigDocument): string {
  const defaults = (config.agents && typeof config.agents === 'object'
    ? (config.agents as AgentsConfig).defaults
    : undefined);
  return typeof defaults?.workspace === 'string' && defaults.workspace.trim()
    ? defaults.workspace
    : DEFAULT_WORKSPACE_PATH;
}

function getDefaultAgentDirPath(agentId: string): string {
  return `~/.openclaw/agents/${agentId}/agent`;
}

function createImplicitMainEntry(config: AgentConfigDocument): AgentListEntry {
  return {
    id: MAIN_AGENT_ID,
    name: MAIN_AGENT_NAME,
    default: true,
    workspace: getDefaultWorkspacePath(config),
    agentDir: getDefaultAgentDirPath(MAIN_AGENT_ID),
  };
}

function normalizeAgentsConfig(config: AgentConfigDocument): {
  agentsConfig: AgentsConfig;
  entries: AgentListEntry[];
  defaultAgentId: string;
  syntheticMain: boolean;
} {
  const agentsConfig = (config.agents && typeof config.agents === 'object'
    ? { ...(config.agents as AgentsConfig) }
    : {}) as AgentsConfig;
  const rawEntries = Array.isArray(agentsConfig.list)
    ? agentsConfig.list.filter((entry): entry is AgentListEntry => (
      Boolean(entry) && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim().length > 0
    ))
    : [];

  if (rawEntries.length === 0) {
    const main = createImplicitMainEntry(config);
    return {
      agentsConfig,
      entries: [main],
      defaultAgentId: MAIN_AGENT_ID,
      syntheticMain: true,
    };
  }

  const defaultEntry = rawEntries.find((entry) => entry.default) ?? rawEntries[0];
  return {
    agentsConfig,
    entries: rawEntries.map((entry) => ({ ...entry })),
    defaultAgentId: defaultEntry.id,
    syntheticMain: false,
  };
}

function isChannelBinding(binding: unknown): binding is ChannelBindingConfig {
  if (!binding || typeof binding !== 'object') return false;
  const candidate = binding as BindingConfig;
  if (typeof candidate.agentId !== 'string' || !candidate.agentId) return false;
  if (!candidate.match || typeof candidate.match !== 'object' || Array.isArray(candidate.match)) return false;
  if (typeof candidate.match.channel !== 'string' || !candidate.match.channel) return false;
  const keys = Object.keys(candidate.match);
  // Accept bindings with just {channel} or {channel, accountId}
  if (keys.length === 1 && keys[0] === 'channel') return true;
  if (keys.length === 2 && keys.includes('channel') && keys.includes('accountId')) return true;
  return false;
}

/** Normalize agent ID for consistent comparison (bindings vs entries). */
function normalizeAgentIdForBinding(id: string): string {
  return (id ?? '').trim().toLowerCase() || '';
}

function normalizeMainKey(value: unknown): string {
  if (typeof value !== 'string') return 'main';
  const trimmed = value.trim().toLowerCase();
  return trimmed || 'main';
}

function buildAgentMainSessionKey(config: AgentConfigDocument, agentId: string): string {
  return `agent:${normalizeAgentIdForBinding(agentId) || MAIN_AGENT_ID}:${normalizeMainKey(config.session?.mainKey)}`;
}

/**
 * Returns a map of channelType -> agentId from bindings.
 * Account-scoped bindings are preferred; channel-wide bindings serve as fallback.
 * Multiple agents can own the same channel type (different accounts).
 */
function getChannelBindingMap(bindings: unknown): {
  channelToAgent: Map<string, string>;
  accountToAgent: Map<string, string>;
} {
  const channelToAgent = new Map<string, string>();
  const accountToAgent = new Map<string, string>();
  if (!Array.isArray(bindings)) return { channelToAgent, accountToAgent };

  for (const binding of bindings) {
    if (!isChannelBinding(binding)) continue;
    const agentId = normalizeAgentIdForBinding(binding.agentId!);
    const channel = binding.match?.channel;
    if (!agentId || !channel) continue;

    const accountId = binding.match?.accountId;
    if (accountId) {
      accountToAgent.set(`${channel}:${accountId}`, agentId);
    } else {
      channelToAgent.set(channel, agentId);
    }
  }

  return { channelToAgent, accountToAgent };
}

function upsertBindingsForChannel(
  bindings: unknown,
  channelType: string,
  agentId: string | null,
  accountId?: string,
): BindingConfig[] | undefined {
  const normalizedAccountId = accountId?.trim() || '';
  const nextBindings = Array.isArray(bindings)
    ? [...bindings as BindingConfig[]].filter((binding) => {
      if (!isChannelBinding(binding)) return true;
      if (binding.match?.channel !== channelType) return true;

      const bindingAccountId = typeof binding.match?.accountId === 'string'
        ? binding.match.accountId.trim()
        : '';

      // Account-scoped updates must only replace the exact account owner.
      // Otherwise rebinding one Feishu/Lark account can silently drop a
      // sibling account binding on the same agent, which looks like routing
      // or model config "drift" in multi-account setups.
      if (normalizedAccountId) {
        return bindingAccountId !== normalizedAccountId;
      }

      // No accountId: remove channel-wide binding (legacy)
      return Boolean(bindingAccountId);
    })
    : [];

  if (agentId) {
    const match: BindingMatch = { channel: channelType };
    if (normalizedAccountId) {
      match.accountId = normalizedAccountId;
    }
    nextBindings.push({ agentId, match });
  }

  return nextBindings.length > 0 ? nextBindings : undefined;
}

async function listExistingAgentIdsOnDisk(): Promise<Set<string>> {
  const ids = new Set<string>();
  const agentsDir = join(getOpenClawConfigDir(), 'agents');

  try {
    if (!(await fileExists(agentsDir))) return ids;
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  } catch {
    // ignore discovery failures
  }

  return ids;
}

async function removeAgentRuntimeDirectory(agentId: string): Promise<void> {
  const runtimeDir = join(getOpenClawConfigDir(), 'agents', agentId);
  try {
    await rm(runtimeDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to remove agent runtime directory', {
      agentId,
      runtimeDir,
      error: String(error),
    });
  }
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function getManagedWorkspaceDirectory(agent: AgentListEntry): string | null {
  if (agent.id === MAIN_AGENT_ID) return null;

  const configuredWorkspace = expandPath(agent.workspace || `~/.openclaw/workspace-${agent.id}`);
  const managedWorkspace = join(getOpenClawConfigDir(), `workspace-${agent.id}`);
  const normalizedConfigured = trimTrailingSeparators(normalize(configuredWorkspace));
  const normalizedManaged = trimTrailingSeparators(normalize(managedWorkspace));

  return normalizedConfigured === normalizedManaged ? configuredWorkspace : null;
}

export async function removeAgentWorkspaceDirectory(agent: { id: string; workspace?: string }): Promise<void> {
  const workspaceDir = getManagedWorkspaceDirectory(agent as AgentListEntry);
  if (!workspaceDir) {
    logger.warn('Skipping agent workspace deletion for unmanaged path', {
      agentId: agent.id,
      workspace: agent.workspace,
    });
    return;
  }

  try {
    await rm(workspaceDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to remove agent workspace directory', {
      agentId: agent.id,
      workspaceDir,
      error: String(error),
    });
  }
}

async function copyBootstrapFiles(sourceWorkspace: string, targetWorkspace: string): Promise<void> {
  await ensureDir(targetWorkspace);

  for (const fileName of AGENT_BOOTSTRAP_FILES) {
    const source = join(sourceWorkspace, fileName);
    const target = join(targetWorkspace, fileName);
    if (!(await fileExists(source)) || (await fileExists(target))) continue;
    await copyFile(source, target);
  }
}

async function copyRuntimeFiles(sourceAgentDir: string, targetAgentDir: string): Promise<void> {
  await ensureDir(targetAgentDir);

  for (const fileName of AGENT_RUNTIME_FILES) {
    const source = join(sourceAgentDir, fileName);
    const target = join(targetAgentDir, fileName);
    if (!(await fileExists(source)) || (await fileExists(target))) continue;
    await copyFile(source, target);
  }
}

async function provisionAgentFilesystem(
  config: AgentConfigDocument,
  agent: AgentListEntry,
  options?: { inheritWorkspace?: boolean },
): Promise<void> {
  const { entries } = normalizeAgentsConfig(config);
  const mainEntry = entries.find((entry) => entry.id === MAIN_AGENT_ID) ?? createImplicitMainEntry(config);
  const sourceWorkspace = expandPath(mainEntry.workspace || getDefaultWorkspacePath(config));
  const targetWorkspace = expandPath(agent.workspace || `~/.openclaw/workspace-${agent.id}`);
  const sourceAgentDir = expandPath(mainEntry.agentDir || getDefaultAgentDirPath(MAIN_AGENT_ID));
  const targetAgentDir = expandPath(agent.agentDir || getDefaultAgentDirPath(agent.id));
  const targetSessionsDir = join(getOpenClawConfigDir(), 'agents', agent.id, 'sessions');

  await ensureDir(targetWorkspace);
  await ensureDir(targetAgentDir);
  await ensureDir(targetSessionsDir);

  // When inheritWorkspace is true, copy the main agent's workspace bootstrap
  // files (SOUL.md, AGENTS.md, etc.) so the new agent inherits the same
  // personality / instructions. Otherwise OpenClaw will seed the missing files
  // on first use, but ClawX still pre-seeds IDENTITY.md so desktop workspaces
  // skip the chat-first bootstrap flow.
  if (options?.inheritWorkspace && targetWorkspace !== sourceWorkspace) {
    await copyBootstrapFiles(sourceWorkspace, targetWorkspace);
  }
  await ensureClawXIdentityFile(targetWorkspace, { createDir: true });
  if (targetAgentDir !== sourceAgentDir) {
    await copyRuntimeFiles(sourceAgentDir, targetAgentDir);
  }
}

export function resolveAccountIdForAgent(agentId: string): string {
  return agentId === MAIN_AGENT_ID ? DEFAULT_ACCOUNT_ID : agentId;
}

function listConfiguredAccountIdsForChannel(config: AgentConfigDocument, channelType: string): string[] {
  const channelSection = config.channels?.[channelType];
  if (!channelSection || channelSection.enabled === false) {
    return [];
  }

  const accounts = channelSection.accounts;
  if (!accounts || typeof accounts !== 'object' || Object.keys(accounts).length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return Object.keys(accounts)
    .filter(Boolean)
    .sort((a, b) => {
      if (a === DEFAULT_ACCOUNT_ID) return -1;
      if (b === DEFAULT_ACCOUNT_ID) return 1;
      return a.localeCompare(b);
    });
}

async function buildSnapshotFromConfig(config: AgentConfigDocument, preloadedChannels?: string[]): Promise<AgentsSnapshot> {
  const { entries, defaultAgentId } = normalizeAgentsConfig(config);
  const configuredChannels = preloadedChannels
    ?? await listConfiguredChannelsFromConfig(config as OpenClawConfig);
  const { channelToAgent, accountToAgent } = getChannelBindingMap(config.bindings);
  const defaultAgentIdNorm = normalizeAgentIdForBinding(defaultAgentId);
  const channelOwners: Record<string, string> = {};
  const channelAccountOwners: Record<string, string> = {};

  // Build per-agent channel lists from account-scoped bindings
  const agentChannelSets = new Map<string, Set<string>>();

  for (const channelType of configuredChannels) {
    const accountIds = listConfiguredAccountIdsForChannel(config, channelType);
    let primaryOwner: string | undefined;
    for (const accountId of accountIds) {
      const owner =
        accountToAgent.get(`${channelType}:${accountId}`)
        || (
          accountId === DEFAULT_ACCOUNT_ID
            ? channelToAgent.get(channelType)
            : undefined
        );

      if (!owner) {
        continue;
      }

      channelAccountOwners[`${channelType}:${accountId}`] = owner;
      primaryOwner ??= owner;
      const existing = agentChannelSets.get(owner) ?? new Set();
      existing.add(channelType);
      agentChannelSets.set(owner, existing);
    }

    if (!primaryOwner) {
      primaryOwner = channelToAgent.get(channelType) || defaultAgentIdNorm;
      const existing = agentChannelSets.get(primaryOwner) ?? new Set();
      existing.add(channelType);
      agentChannelSets.set(primaryOwner, existing);
    }

    channelOwners[channelType] = primaryOwner;
  }

  const defaultModelConfig = (config.agents as AgentsConfig | undefined)?.defaults?.model;
  const defaultModelLabel = formatModelLabel(defaultModelConfig);
  const defaultModelRef = resolveModelRef(defaultModelConfig);
  const agents: AgentSummary[] = entries.map((entry) => {
    const explicitModelRef = resolveModelRef(entry.model);
    const effectiveModelRef = explicitModelRef || defaultModelRef || null;
    const modelLabel = formatModelLabel(entry.model) || defaultModelLabel || 'Not configured';
    const inheritedModel = !explicitModelRef && Boolean(defaultModelLabel);
    const entryIdNorm = normalizeAgentIdForBinding(entry.id);
    const ownedChannels = agentChannelSets.get(entryIdNorm) ?? new Set<string>();
    return {
      id: entry.id,
      name: entry.name || (entry.id === MAIN_AGENT_ID ? MAIN_AGENT_NAME : entry.id),
      isDefault: entry.id === defaultAgentId,
      modelDisplay: modelLabel,
      modelRef: effectiveModelRef,
      overrideModelRef: explicitModelRef,
      contextWindow: resolveModelContextWindow(config, effectiveModelRef),
      inheritedModel,
      workspace: entry.workspace || (entry.id === MAIN_AGENT_ID ? getDefaultWorkspacePath(config) : `~/.openclaw/workspace-${entry.id}`),
      agentDir: entry.agentDir || getDefaultAgentDirPath(entry.id),
      mainSessionKey: buildAgentMainSessionKey(config, entry.id),
      channelTypes: configuredChannels
        .filter((ct) => ownedChannels.has(ct))
        .map((channelType) => toUiChannelType(channelType)),
    };
  });

  return {
    agents,
    defaultAgentId,
    defaultModelRef,
    configuredChannelTypes: configuredChannels.map((channelType) => toUiChannelType(channelType)),
    channelOwners,
    channelAccountOwners,
  };
}

export async function listAgentsSnapshot(): Promise<AgentsSnapshot> {
  let snapshot: AgentsSnapshot | undefined;
  let prunedRuntimeModelRefs = false;
  const {
    getActiveAuthProfileProviders,
    pruneStaleRuntimeAgentModelRefs,
  } = await import('./openclaw-auth');
  const authProfileProviders = await getActiveAuthProfileProviders();
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    prunedRuntimeModelRefs = await pruneStaleRuntimeAgentModelRefs(
      config as unknown as Record<string, unknown>,
      authProfileProviders,
    );
    snapshot = await buildSnapshotFromConfig(config);
  });
  if (prunedRuntimeModelRefs) {
    logger.info('Pruned stale runtime agent model refs from openclaw.json');
  }
  return snapshot!;
}

export async function listAgentsSnapshotFromConfig(config: OpenClawConfig, configuredChannels?: string[]): Promise<AgentsSnapshot> {
  return buildSnapshotFromConfig(config as AgentConfigDocument, configuredChannels);
}

export async function listConfiguredAgentIds(): Promise<string[]> {
  const config = await readOpenClawConfig() as AgentConfigDocument;
  const { entries } = normalizeAgentsConfig(config);
  const ids = [...new Set(entries.map((entry) => entry.id.trim()).filter(Boolean))];
  return ids.length > 0 ? ids : [MAIN_AGENT_ID];
}

/**
 * Resolve agentId from channel and accountId using bindings.
 * Returns the agentId if found, or null if no binding exists.
 */
export async function resolveAgentIdFromChannel(channel: string, accountId?: string): Promise<string | null> {
  const config = await readOpenClawConfig() as AgentConfigDocument;
  const { channelToAgent, accountToAgent } = getChannelBindingMap(config.bindings);

  // First try account-specific binding
  if (accountId) {
    const agentId = accountToAgent.get(`${channel}:${accountId}`);
    if (agentId) return agentId;
  }

  // Fallback to channel-only binding
  const agentId = channelToAgent.get(channel);
  return agentId ?? null;
}

export async function createAgent(
  name: string,
  options?: { inheritWorkspace?: boolean },
): Promise<AgentsSnapshot> {
  let snapshot: AgentsSnapshot | undefined;
  let createdAgentId = '';
  let agentToProvision: AgentListEntry | undefined;
  let provisioningConfig: AgentConfigDocument | undefined;
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { agentsConfig, entries, syntheticMain } = normalizeAgentsConfig(config);
    const normalizedName = normalizeAgentName(name);
    const existingIds = new Set(entries.map((entry) => entry.id));
    const diskIds = await listExistingAgentIdsOnDisk();
    let nextId = slugifyAgentId(normalizedName);
    let suffix = 2;

    while (existingIds.has(nextId) || diskIds.has(nextId)) {
      nextId = `${slugifyAgentId(normalizedName)}-${suffix}`;
      suffix += 1;
    }

    const nextEntries = syntheticMain ? [createImplicitMainEntry(config), ...entries.filter((_, index) => index > 0)] : [...entries];
    const newAgent: AgentListEntry = {
      id: nextId,
      name: normalizedName,
      workspace: `~/.openclaw/workspace-${nextId}`,
      agentDir: getDefaultAgentDirPath(nextId),
    };

    if (!nextEntries.some((entry) => entry.id === MAIN_AGENT_ID) && syntheticMain) {
      nextEntries.unshift(createImplicitMainEntry(config));
    }
    nextEntries.push(newAgent);

    config.agents = {
      ...agentsConfig,
      list: nextEntries,
    };

    createdAgentId = nextId;
    agentToProvision = newAgent;
    provisioningConfig = structuredClone(config);
    snapshot = await buildSnapshotFromConfig(config);
  });
  const createdAgent = agentToProvision!;
  const workspaceExisted = await fileExists(expandPath(createdAgent.workspace!));
  const runtimeDirectory = join(getOpenClawConfigDir(), 'agents', createdAgent.id);
  const runtimeDirectoryExisted = await fileExists(runtimeDirectory);
  try {
    await provisionAgentFilesystem(provisioningConfig!, createdAgent, { inheritWorkspace: options?.inheritWorkspace });
  } catch (provisioningError) {
    let rollbackError: unknown;
    try {
      await mutateOpenClawConfig((configSnapshot) => {
        const config = configSnapshot as AgentConfigDocument;
        const { agentsConfig, entries } = normalizeAgentsConfig(config);
        const createdIndex = entries.findIndex((entry) => (
          entry.id === createdAgent.id && isDeepStrictEqual(entry, createdAgent)
        ));
        if (createdIndex === -1) return;
        config.agents = {
          ...agentsConfig,
          list: entries.filter((_, index) => index !== createdIndex),
        };
      });
    } catch (error) {
      rollbackError = error;
    }

    if (!workspaceExisted) {
      await removeAgentWorkspaceDirectory(createdAgent);
    }
    if (!runtimeDirectoryExisted) {
      await removeAgentRuntimeDirectory(createdAgent.id);
    }
    if (rollbackError) {
      throw new AggregateError(
        [provisioningError, rollbackError],
        `Failed to provision agent "${createdAgent.id}" and roll back its config entry`,
        { cause: provisioningError },
      );
    }
    throw provisioningError;
  }
  logger.info('Created agent config entry', { agentId: createdAgentId, inheritWorkspace: !!options?.inheritWorkspace });
  return snapshot!;
}

/** 预置 PO 子 Agent 的展示名与其 slug 后的 id（"PO" → "po"）。 */
export const PRESET_PO_AGENT_NAME = 'PO';
export const PRESET_PO_AGENT_ID = 'po';

/**
 * PO Agent workspace 预置的 HRBP 线下经验标签示例集。
 *
 * 仅在 PO 首次创建时写入其 workspace 根目录（Experience.md）；若文件已存在则跳过，
 * 避免覆盖用户手工修改过的经验条目。
 */
const PRESET_PO_EXPERIENCE_FILE = 'Experience.md';
const PRESET_PO_EXPERIENCE_CONTENT = `# HRBP 线下经验标签示例集

## 供应商维度的经验

- 【A供应商｜份额约束】沟通风格强硬，谈判中倾向以停供施压 → 份额系数软上限压至 25%（低于全局上限 35%），触及即降权
- 【B供应商｜风险】过去发生 3 起员工劳资矛盾且处置不当，有仲裁记录 → 经验系数 ×0.90，禁止承接"高员工密度+夜班"组合单
- 【C供应商｜能力加成】具备驻场支持能力（可派 2 名驻场管理员）→ 大批量单（>80人）绩效分 ×1.05 加成，优先承接新仓爬坡期订单
- 【A供应商｜地域加成】总部位于 A 物流仓所在城市 → 单仓视角：A 仓的 fill rate 预期上调 8 个百分点、time to fill 预期缩短 1 天；全体视角：系数不变（仅对 A 仓生效，防止地域优势被误摊到全网）
- 【C供应商｜合规风险】为行业头部大供应商，法务团队强势，历史合作中存在灰色用工操作（社保洼地挂靠） → 合规敏感订单经验系数 ×0.85，且触发法务必审流程

## 场景/时点维度的经验

- 【全体供应商×法定节假日｜用工性质指引】假期前后员工生产积极性低、出勤波动大 → 假期覆盖单优先派给"考勤率≥95% 且支持月结"的临时工资质供应商，考勤率子权重 ×1.3
- 【全体供应商×大促｜用工性质指引】大促峰值需要大量日结临时工 → 大促单限定具备日结结算能力的供应商池，供给速度子权重 ×1.2

## 物流仓维度的经验

- 【B物流仓｜人效修正】该仓自动化水平高（自动分拣线覆盖率 80%）→ 人效基准上调至 1.4 倍，理论需求人数相应下降；同时用工结构偏向"设备看护岗"，技能要求标签自动附加
- 【A物流仓×A供应商｜组合经验】A 供应商本地团队在 A 仓有成熟班组 → 该组合下新单磨合期豁免（首轮不启用"新供应商 10 人限额"）
`;

/**
 * 幂等写入 PO workspace 的 Experience.md 预置文件。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-po/Experience.md`（由 createAgent 保证 workspace 已存在）。
 * - 文件已存在则跳过，避免覆盖用户改动。
 */
async function ensurePresetPoExperienceFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const target = join(workspace, PRESET_PO_EXPERIENCE_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_PO_EXPERIENCE_CONTENT, 'utf8');
  logger.info('Provisioned preset PO experience file', { path: target });
}

/**
 * 幂等预置 PO 子 Agent。
 *
 * 语义：
 * - 若配置中已存在 id 为 `po` 的 Agent（无论是本函数早先创建，还是用户手工创建的同名 Agent），
 *   直接跳过，不重复创建、不覆盖其 workspace。
 * - 否则调用 createAgent('PO', { inheritWorkspace: true })，使 PO 的 workspace 引导文件
 *   （AGENTS.md / SOUL.md 等）复制自 main Agent —— 满足「workspace 内容暂时与 main 一致」。
 *
 * 设计意图：供应用启动 bootstrap 调用，确保 PO 作为常驻可切换的业务 Agent 始终存在。
 * 返回是否发生了实际创建，便于调用方决定是否需要刷新前端 Agent 列表。
 */
export async function ensurePresetPoAgent(): Promise<{ created: boolean }> {
  try {
    const existingIds = await listConfiguredAgentIds();
    if (existingIds.includes(PRESET_PO_AGENT_ID)) {
      // PO 已存在：仍幂等确保 Experience.md 存在（覆盖老环境升级场景）。
      await ensurePresetPoExperienceFile();
      return { created: false };
    }
    await createAgent(PRESET_PO_AGENT_NAME, { inheritWorkspace: true });
    await ensurePresetPoExperienceFile();
    logger.info('Provisioned preset PO agent', { agentId: PRESET_PO_AGENT_ID });
    return { created: true };
  } catch (error) {
    // 预置失败不应阻断应用启动：记录后静默返回，用户仍可手动创建 Agent。
    logger.error('Failed to ensure preset PO agent', error);
    return { created: false };
  }
}

/** 预置 FDE(现场故障诊断)子 Agent 的展示名与其 slug 后的 id（"FDE" → "fde"）。 */
export const PRESET_FDE_AGENT_NAME = 'FDE';
export const PRESET_FDE_AGENT_ID = 'fde';

/**
 * FDE Agent workspace 预置的权威设备说明书（APX-240 自动封装设备）。
 *
 * 仅在 FDE 首次创建时写入其 workspace 根目录（自动封装说明书.md）；若文件已存在则跳过，
 * 避免覆盖用户手工修改过的内容。equipment-guard 指引强制 agent 回答前读取本文件并原文回显证据。
 */
const PRESET_FDE_MANUAL_FILE = '自动封装说明书.md';
const PRESET_FDE_MANUAL_CONTENT = `# APX-240 自动封装设备说明书

候选人发放版｜设备说明书、报警码说明、历史故障案例与维修记录

## 适用范围

本手册描述虚构的 APX-240 袋装产品自动封装设备，用于 FDE 实习生 Agent 应用开发考试。内容用于检索、证据引用和安全决策演示，不构成真实设备的维修指导。

**重要安全提示**：出现烟雾、焦味、异常高温、剧烈振动、金属摩擦或部件松脱时，立即停机并升级专家。禁止短接安全门、绕过报警或带电拆线。

## 1. 设备概述与正常参数

APX-240 用于袋装产品的输送、定位、热封和成品输出。设备主要由进料输送、定位检测、热封温控、气动执行、安全联锁和控制系统构成。

| 模块 | 作用 |
| --- | --- |
| P1 入口光电传感器 | 检测物料是否到达入口位置。 |
| S1 主伺服 | 驱动主输送和定位。 |
| H1/H2 热封加热器 | 提供热封温度。 |
| T1/T2 温度传感器 | 采集热封温度。 |
| 气源过滤调压组件 | 向执行部件提供稳定气压。 |
| G1 安全门联锁 | 确保防护门关闭后才允许设备运行。 |
| 控制器与操作面板 | 处理控制逻辑、状态显示和报警信息。 |

**正常参数**

| 项目 | 正常范围/要求 |
| --- | --- |
| 热封设定温度 | 165°C |
| 热封稳定范围 | 160–170°C |
| 设备入口气压 | 0.55 MPa（约 0.5–0.6 MPa） |
| 安全门状态 | 设备运行时必须关闭 |
| 输送区域 | 不得存在异物或卡料 |

## 2. 安全红线

| ID | 要求 |
| --- | --- |
| SAFE-01 | 出现烟雾、焦味、异常高温、剧烈振动、金属摩擦声或部件松脱时，立即停机并升级专家。 |
| SAFE-02 | 打开防护罩、清除夹料、检查线路或接触加热组件前，必须断电、锁定、挂牌，并确认残余能量释放。 |
| SAFE-03 | 禁止短接安全门、绕过报警、带电插拔线路或徒手触碰加热部件。 |
| SAFE-04 | 仅授权电气/机械维修人员可执行拆线、绝缘测试、伺服或加热回路维修。 |
| SAFE-05 | 知识库无覆盖、证据矛盾或风险无法判断时，停止进一步操作并升级专家。 |

**Agent 的安全职责**：Agent 只能基于现场描述、报警码、历史案例和维修记录提出有证据的排查建议。它必须区分"已知事实""可能原因"和"需要授权人员执行的操作"，不得给出绕过联锁、带电拆线或继续危险运行的建议。

## 3. 报警码说明

| 报警码 | 含义 | 常见原因 | 安全排查顺序 |
| --- | --- | --- | --- |
| A101 | P1 进料检测超时 | 无物料；P1 被遮挡/偏移；输送带打滑；P1 线路故障 | 确认物料 → 观察 P1 指示灯 → 停机清洁/校准 → 授权人员查线路 |
| A203 | 热封温度低 | 未预热；设定错误；加热器开路；继电器/线路故障；T1 偏差 | 核对设定与预热 → 读实际温度和加热电流 → 停机锁定 → 授权电气人员检查 |
| A205 | 热封温度高 | 控制继电器粘连；T1 松脱；控制回路故障 | 立即停机 → 隔离电源 → 等待冷却 → 专家检查，禁止继续试运行 |
| A310 | 气压低 | 上游供气低；过滤器堵塞；调压器异常；下游管路泄漏 | 比较上游/设备压力 → 听漏气 → 停机泄压 → 授权人员检查 |
| A401 | 安全门未闭合 | 门未关；联锁位置偏移；联锁线路故障 | 确认门体无异物并重新关闭 → 仍报警则停机 → 授权人员检查 |
| A520 | S1 伺服过载 | 机械卡阻；负载过大；传动件损坏；伺服参数异常 | 停机 → 锁定挂牌 → 检查可见卡阻/传动 → 机械或电气专家处理 |
| A900 | 控制器通信中断 | 网络线松动；交换模块故障；控制器掉电 | 记录受影响模块 → 检查面板状态 → 停机后检查外部连接 → 控制专家处理 |

## 4. 历史故障案例

以下案例用于帮助 Agent 进行检索与证据引用。历史案例不是当前故障的结论；现场读数或安全风险不一致时，必须以当前证据和报警码顺序为准。

| 案例 | 现象与证据 | 根因 | 处置 |
| --- | --- | --- | --- |
| H01 | 换产后 A101，物料已到位但 P1 灯不亮 | P1 支架被碰偏 | 停机后重新校准并锁紧支架 |
| H02 | A203，设定 165°C，实际 128°C，加热电流 0 A | H1 加热回路开路 | 锁定挂牌，由电气维修更换损坏部件 |
| H03 | A310，上游 0.64 MPa、设备端 0.41 MPa，有持续漏气声 | 下游接头松动 | 停机泄压后由授权人员重接并检漏 |
| H04 | A401 间歇出现，门已关严 | 联锁安装位置松动 | 停机后校准联锁；未绕过保护 |
| H05 | A520 且输送段有周期性摩擦声 | 传动轴承损坏 | 立即停机并由机械专家更换 |

## 5. 维修记录

维修记录只代表设备在当时的已确认状态，不能替代当前诊断。相同报警出现时，Agent 必须说明当前证据与历史记录的相同点和差异。

| 日期 | 工单号 | 已确认原因 | 已执行维修 | 复机验证 |
| --- | --- | --- | --- | --- |
| 2026-03-08 | WO-240-031 | P1 支架松动并有粉尘遮挡 | 清洁 P1、校准位置、紧固支架 | 连续运行 500 袋无报警 |
| 2026-04-16 | WO-240-042 | H1 加热回路开路 | 锁定挂牌后由电气维修更换 H1 加热组件 | 165°C 稳定 30 分钟后试产合格 |
| 2026-05-03 | WO-240-051 | 气源过滤器滤芯堵塞 | 停机泄压后更换滤芯、检查调压器 | 设备端压力稳定在 0.62 MPa |
| 2026-05-27 | WO-240-063 | G1 联锁位置偏移 | 停机校准联锁位置并锁紧固定件 | 连续开关门 20 次，报警未复现 |
| 2026-06-19 | WO-240-077 | 主传动轴承磨损 | 锁定挂牌后由机械专家更换轴承、检查传动对中 | 空载 15 分钟及试产 300 袋正常 |

**使用约束**：涉及线路、加热回路、伺服、气路拆装或安全联锁时，必须遵守授权边界。

## 6. Agent 输出要求

针对每个故障输入，Agent 应按以下顺序输出：

| 字段 | 要求 |
| --- | --- |
| 故障现象 | 复述报警、现场读数、时间点和可见异常。 |
| 已知事实 | 只能引用输入、手册、报警码、案例或维修记录中明确存在的信息。 |
| 可能原因 | 按证据强弱排序，并明确"可能"而非"已确认"。 |
| 证据来源 | 引用具体报警码、历史案例编号或维修工单。 |
| 安全前置条件 | 列出停机、锁定挂牌、冷却或授权人员介入条件。 |
| 排查顺序 | 遵循报警码给出的安全顺序；禁止带电、带压或绕过保护。 |
| 需要补充的信息 | 指出缺失的传感器状态、读数、声音、时间或维修历史。 |
| 停止条件/升级 | 明确何时不能继续排查，以及是否需升级专家。 |

**考试边界**：本题考察 Agent 在知识库约束下的检索、证据引用、追问和安全升级能力。候选人应使用市售模型构建应用层 Agent，不涉及模型训练或微调。
`;

/**
 * FDE Agent workspace 预置的工作流程 skill（现场故障诊断）。
 *
 * 该 skill 定义 FDE 处理现场故障描述的标准作业流程：强制先读 `自动封装说明书.md`，
 * 按 6 字段输出诊断，并强制回显说明书中与现场故障相关的命中原文（报警码行/历史案例/
 * 维修记录原文），做到证据可溯源。skill 目录被 OpenClaw 扫描为 workspace 级技能
 * （source: openclaw-workspace），路径 `~/.openclaw/workspace-fde/skills/<slug>/SKILL.md`。
 */
const PRESET_FDE_SKILL_SLUG = 'apx240-fault-diagnosis';
const PRESET_FDE_SKILL_CONTENT = `---
name: APX-240 现场故障诊断
description: 现场工程师提供 APX-240 设备故障描述时，按标准流程强制查阅《自动封装说明书.md》，输出故障现象/可能原因/证据来源/排查顺序/需要补充的信息/是否升级专家，并强制回显说明书中命中的相关原文。
version: 1.0.0
metadata:
  openclaw:
    skillKey: apx240-fault-diagnosis
    emoji: 🛠️
---

# APX-240 现场故障诊断流程

当现场工程师给出 APX-240 自动封装设备的故障描述、报警码或异常读数时，你必须严格执行本流程。本 skill 是 FDE 处理设备故障的标准作业程序（SOP），不得跳过或简化。

## 铁律（不可违背）

1. **强制查阅说明书**：回答前必须先用 read 工具读取本 workspace 根目录的 \`自动封装说明书.md\` 的当前内容，禁止凭记忆或经验作答。
2. **强制原文回显**：必须在「证据来源」中**逐字摘录**说明书里与本次故障描述相关的命中原文——包括命中的报警码表格行、历史故障案例（H01–H05）、维修记录工单（WO-240-xxx）的原文。禁止改写、总结或转述原文；改写等同于没有证据。
3. **区分事实与推测**：严格区分「已知事实」（输入或说明书中明确存在）、「可能原因」（按证据强弱排序的推断）、「需授权人员执行的操作」。
4. **安全优先，fail-closed**：遵守说明书第 2 节安全红线 SAFE-01~05。出现烟雾/焦味/异常高温/剧烈振动/金属摩擦/部件松脱，或说明书无覆盖、证据矛盾、风险无法判断时，立即建议停机并升级专家（SAFE-05）。禁止给出绕过联锁、带电拆线、带压拆装或继续危险运行的建议。

## 作业步骤

1. 读取 \`自动封装说明书.md\` 全文。
2. 从故障描述中提取关键信号：报警码、现场读数（温度/气压/电流）、可见/可闻异常、时间点。
3. 在说明书中检索命中项：报警码说明表（第 3 节）、历史故障案例（第 4 节）、维修记录（第 5 节）。
4. 摘录命中原文，逐字保留，用于「证据来源」字段。
5. 若信息不足以定位，先在「需要补充的信息」中列出待补读数/状态，必要时向工程师追问，不要臆断。
6. 按下述 6 字段结构输出诊断。

## 输出结构（严格按此 6 字段，缺一不可）

**1. 故障现象**
复述报警码、现场读数、时间点与可见/可闻异常。

**2. 可能原因**
按证据强弱排序列出，明确标注「可能」而非「已确认」。

**3. 证据来源**
逐字回显说明书中命中的相关原文，标注出处（例如「报警码表 A203 行原文：……」「历史案例 H02 原文：……」「维修记录 WO-240-042 原文：……」）。这是本 skill 的核心要求，原文必须与说明书完全一致。

**4. 排查顺序**
遵循说明书对应报警码给出的安全排查顺序；禁止带电、带压或绕过保护的步骤，并标注每步的安全前置条件（停机/锁定挂牌/冷却/授权人员介入）。

**5. 需要补充的信息**
指出缺失的传感器状态、读数、声音、时间或维修历史。

**6. 是否升级专家**
明确给出是否需升级专家的结论及依据。命中 SAFE-01/SAFE-05 情形、说明书无覆盖或证据矛盾时，必须升级并说明停止条件。

## 边界

- 仅在用户输入涉及 APX-240 设备故障/报警/异常时启用本流程；一般对话无需套用。
- 每次都读文件当前内容，说明书可能已被更新。
- 你只做基于证据的排查建议，实际拆装维修由授权电气/机械人员执行（SAFE-04）。
`;

/**
 * 幂等写入 FDE workspace 的说明书预置文件。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-fde/自动封装说明书.md`（由 createAgent 保证 workspace 已存在）。
 * - 文件已存在则跳过，避免覆盖用户改动。
 */
async function ensurePresetFdeManualFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_FDE_AGENT_ID}`);
  const target = join(workspace, PRESET_FDE_MANUAL_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_FDE_MANUAL_CONTENT, 'utf8');
  logger.info('Provisioned preset FDE manual file', { path: target });
}

/**
 * 幂等写入 FDE workspace 的工作流程 skill。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-fde/skills/apx240-fault-diagnosis/SKILL.md`
 *   （由 createAgent 保证 workspace 已存在），被 OpenClaw 扫描为 workspace 级技能。
 * - SKILL.md 已存在则跳过，避免覆盖用户改动。
 */
async function ensurePresetFdeSkillFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_FDE_AGENT_ID}`);
  const skillDir = join(workspace, 'skills', PRESET_FDE_SKILL_SLUG);
  const target = join(skillDir, 'SKILL.md');
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(skillDir);
  await writeFile(target, PRESET_FDE_SKILL_CONTENT, 'utf8');
  logger.info('Provisioned preset FDE skill file', { path: target });
}

/**
 * FDE Agent workspace 预置的「历史维修记录登记」skill。
 *
 * 定义 FDE 在一次诊断闭环（已确认原因 / 已执行维修 / 复机验证 三要素齐备）完成后，
 * 当用户明确要求登记时，如何调用 maintenance-records 插件的 record_maintenance 工具
 * 触发人审弹窗、经用户确认后写入 `~/.openclaw/workspace-fde/维修记录.json`。
 *
 * 与 apx240-fault-diagnosis（诊断 SOP）互补：诊断产出闭环，本 skill 负责闭环入库。
 */
const PRESET_FDE_MAINTENANCE_SKILL_SLUG = 'maintenance-record-logging';
const PRESET_FDE_MAINTENANCE_SKILL_CONTENT = `---
name: APX-240 历史维修记录登记
description: 当一次维修闭环（已确认原因、已执行维修、复机验证 三要素齐备）完成且用户明确要求登记为历史维修记录时，先用 read_maintenance 查重，再调用 record_maintenance 工具触发人审弹窗，经用户确认后写入维修记录看板。
version: 1.0.0
metadata:
  openclaw:
    skillKey: maintenance-record-logging
    emoji: 📝
---

# APX-240 历史维修记录登记流程

当一次设备维修的完整闭环已经确认，且现场工程师**明确要求**把它登记为新的历史维修记录时，你必须严格执行本流程，把记录写入维修记录看板。本 skill 与《APX-240 现场故障诊断》互补：诊断流程负责产出闭环，本 skill 负责把闭环入库。

## 触发条件（三者必须同时满足）

1. **三要素齐备**：本次交互中已经明确确认了以下三项，缺一不可：
   - **已确认原因（confirmedCause）**：不是"可能原因"，而是已经定位、确认的根因。
   - **已执行维修（repairAction）**：实际已完成的维修动作（含授权人员执行的拆装、更换等）。
   - **复机验证（verification）**：维修后复机的验证结果（如连续运行 N 袋无报警、温度稳定 N 分钟）。
2. **用户明确要求登记**：用户用自然语言表达了"登记 / 记一条维修记录 / 存入维修记录 / 加到看板"等意图。用户没有明确要求时，不得擅自登记。
3. **未重复登记**：调用登记前，先用 \`read_maintenance\` 工具读取现有全部记录，确认本次三要素与历史记录不重复。若已存在等价记录，告知用户已有该记录、无需重复登记。

## 作业步骤

1. **查重**：调用 \`read_maintenance\` 工具，读取现有全部历史维修记录，比对三要素是否已存在。
2. **组织字段**：从对话中提炼出准确的 confirmedCause / repairAction / verification 文本；如用户提供了维修日期则填 date（格式 YYYY-MM-DD），未提供则省略 date（插件默认取当天）。**不要**自行编造工单号——工单号由插件自动递增分配（WO-240-xxx）。
3. **调用登记工具**：调用 \`record_maintenance\` 工具，传入 confirmedCause / repairAction / verification（及可选 date）。
4. **等待人审**：调用后系统会弹出人审确认框，由用户决定是否入库。你**不能**代替用户点确认，也不能声称"已写入"——只有用户在弹窗中确认后记录才真正写入。
5. **回执**：登记工具调用完成后，告知用户"已发起维修记录登记，请在弹窗中确认后写入看板"。多条记录需分别多次调用。

## 铁律（不可违背）

1. **三要素未确认不得登记**：只要"已确认原因/已执行维修/复机验证"任一项仍是推测或缺失，禁止调用 \`record_maintenance\`；应先补齐或向工程师追问。
2. **不得绕过人审**：登记必须经 \`record_maintenance\` 工具走人审弹窗，禁止用其他方式直接写文件；也不得在用户确认前宣称已入库。
3. **不编造工单号与内容**：工单号由插件分配；三要素文本必须来自本次交互中已确认的事实，不得杜撰。
4. **与诊断分离**：诊断阶段（《APX-240 现场故障诊断》）只输出"可能原因"，不触发登记；只有维修闭环确认且用户要求时才走本流程。

## 边界

- 仅在维修闭环确认且用户要求登记时启用；日常诊断/问答不套用本流程。
- 登记的是"当时已确认的状态"，不替代未来的当前诊断。
`;

/** FDE workspace 预置的历史维修记录 JSON 文件名。 */
const PRESET_FDE_MAINTENANCE_FILE = '维修记录.json';

/**
 * 初始历史维修记录种子数据（源自《自动封装说明书.md》第 5 节维修记录表）。
 *
 * 与 maintenance-records 插件的 MaintenanceRecordsDoc 根结构 `{ records: [...] }` 对齐，
 * 字段名 workOrder/date/confirmedCause/repairAction/verification 完全一致，供前端看板与
 * nextWorkOrder 工单号递增读取。先写入 5 条（WO-240-031/042/051/063/077），后续登记在插件侧追加。
 */
const PRESET_FDE_MAINTENANCE_CONTENT = JSON.stringify(
  {
    records: [
      {
        workOrder: 'WO-240-031',
        date: '2026-03-08',
        confirmedCause: 'P1 支架松动并有粉尘遮挡',
        repairAction: '清洁 P1、校准位置、紧固支架',
        verification: '连续运行 500 袋无报警',
      },
      {
        workOrder: 'WO-240-042',
        date: '2026-04-16',
        confirmedCause: 'H1 加热回路开路',
        repairAction: '锁定挂牌后由电气维修更换 H1 加热组件',
        verification: '165°C 稳定 30 分钟后试产合格',
      },
      {
        workOrder: 'WO-240-051',
        date: '2026-05-03',
        confirmedCause: '气源过滤器滤芯堵塞',
        repairAction: '停机泄压后更换滤芯、检查调压器',
        verification: '设备端压力稳定在 0.62 MPa',
      },
      {
        workOrder: 'WO-240-063',
        date: '2026-05-27',
        confirmedCause: 'G1 联锁位置偏移',
        repairAction: '停机校准联锁位置并锁紧固定件',
        verification: '连续开关门 20 次，报警未复现',
     },
      {
        workOrder: 'WO-240-077',
        date: '2026-06-19',
        confirmedCause: '主传动轴承磨损',
        repairAction: '锁定挂牌后由机械专家更换轴承、检查传动对中',
        verification: '空载 15 分钟及试产 300 袋正常',
      },
    ],
  },
  null,
  2,
);

/**
 * 幂等写入 FDE workspace 的初始历史维修记录。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-fde/维修记录.json`（由 createAgent 保证 workspace 已存在）。
 * - 文件已存在则跳过，避免覆盖插件后续登记追加的记录。
 */
async function ensurePresetFdeMaintenanceFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_FDE_AGENT_ID}`);
  const target = join(workspace, PRESET_FDE_MAINTENANCE_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_FDE_MAINTENANCE_CONTENT, 'utf8');
  logger.info('Provisioned preset FDE maintenance file', { path: target });
}

/**
 * 幂等写入 FDE workspace 的「历史维修记录登记」skill。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-fde/skills/maintenance-record-logging/SKILL.md`
 *   （由 createAgent 保证 workspace 已存在），被 OpenClaw 扫描为 workspace 级技能。
 * - SKILL.md 已存在则跳过，避免覆盖用户改动。
 */
async function ensurePresetFdeMaintenanceSkillFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_FDE_AGENT_ID}`);
  const skillDir = join(workspace, 'skills', PRESET_FDE_MAINTENANCE_SKILL_SLUG);
  const target = join(skillDir, 'SKILL.md');
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(skillDir);
  await writeFile(target, PRESET_FDE_MAINTENANCE_SKILL_CONTENT, 'utf8');
  logger.info('Provisioned preset FDE maintenance skill file', { path: target });
}

/**
 * 幂等预置 FDE(现场故障诊断)子 Agent。
 *
 * 语义：
 * - 若配置中已存在 id 为 `fde` 的 Agent（本函数早先创建或用户手工创建的同名 Agent），
 *   直接跳过，不重复创建、不覆盖其 workspace；仍幂等确保说明书与诊断 skill 存在（覆盖老环境升级）。
 * - 否则调用 createAgent('FDE', { inheritWorkspace: true })，使 FDE 的 workspace 引导文件
 *   （AGENTS.md / SOUL.md 等）复制自 main Agent，随后写入权威说明书与诊断流程 skill。
 *
 * 设计意图：供应用启动 bootstrap 调用，确保 FDE 作为常驻可切换的设备诊断 Agent 始终存在，
 * 且其 workspace 预置了 equipment-guard 指引所要求读取的权威说明书，以及定义标准作业流程的
 * apx240-fault-diagnosis skill。
 */
export async function ensurePresetFdeAgent(): Promise<{ created: boolean }> {
  try {
    const existingIds = await listConfiguredAgentIds();
    if (existingIds.includes(PRESET_FDE_AGENT_ID)) {
      await ensurePresetFdeManualFile();
      await ensurePresetFdeSkillFile();
      await ensurePresetFdeMaintenanceFile();
      await ensurePresetFdeMaintenanceSkillFile();
      return { created: false };
    }
    await createAgent(PRESET_FDE_AGENT_NAME, { inheritWorkspace: true });
    await ensurePresetFdeManualFile();
    await ensurePresetFdeSkillFile();
    await ensurePresetFdeMaintenanceFile();
    await ensurePresetFdeMaintenanceSkillFile();
    logger.info('Provisioned preset FDE agent', { agentId: PRESET_FDE_AGENT_ID });
    return { created: true };
  } catch (error) {
    // 预置失败不应阻断应用启动：记录后静默返回，用户仍可手动创建 Agent。
    logger.error('Failed to ensure preset FDE agent', error);
    return { created: false };
  }
}

export async function updateAgentName(agentId: string, name: string): Promise<AgentsSnapshot> {
  let snapshot: AgentsSnapshot | undefined;
  const normalizedName = normalizeAgentName(name);
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const index = entries.findIndex((entry) => entry.id === agentId);
    if (index === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    entries[index] = {
      ...entries[index],
      name: normalizedName,
    };

    config.agents = {
      ...agentsConfig,
      list: entries,
    };

    snapshot = await buildSnapshotFromConfig(config);
  });
  logger.info('Updated agent name', { agentId, name: normalizedName });
  return snapshot!;
}

function isValidModelRef(modelRef: string): boolean {
  const firstSlash = modelRef.indexOf('/');
  return firstSlash > 0 && firstSlash < modelRef.length - 1;
}

export async function updateAgentModel(agentId: string, modelRef: string | null): Promise<AgentsSnapshot> {
  const normalizedModelRef = typeof modelRef === 'string' ? modelRef.trim() : '';
  let snapshot: AgentsSnapshot | undefined;
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const index = entries.findIndex((entry) => entry.id === agentId);
    if (index === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const nextEntry: AgentListEntry = { ...entries[index] };

    if (!normalizedModelRef) {
      delete nextEntry.model;
    } else {
      if (!isValidModelRef(normalizedModelRef)) {
        throw new Error('modelRef must be in "provider/model" format');
      }
      // Merge into the existing model block: replacing it wholesale discards
      // hand-configured fields such as `fallbacks`.
      const existingModel = entries[index].model;
      const nextModel: AgentModelConfig = existingModel && typeof existingModel === 'object'
        ? { ...existingModel, primary: normalizedModelRef }
        : { primary: normalizedModelRef };
      // The OpenClaw runtime treats a per-agent model block without a
      // `fallbacks` key as an EMPTY fallback override, which suppresses
      // agents.defaults.model.fallbacks entirely. Inherit the defaults chain
      // so switching models never silently disables failover.
      if (!Array.isArray(nextModel.fallbacks)) {
        const defaultsModel = agentsConfig.defaults?.model;
        const defaultFallbacks = defaultsModel && typeof defaultsModel === 'object'
          ? (defaultsModel as AgentModelConfig).fallbacks
          : undefined;
        if (Array.isArray(defaultFallbacks)) {
          const inherited = defaultFallbacks.filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0);
          if (inherited.length > 0) {
            nextModel.fallbacks = inherited;
          }
        }
      }
      nextEntry.model = nextModel;
    }

    entries[index] = nextEntry;
    config.agents = {
      ...agentsConfig,
      list: entries,
    };
    applyModelAwareCompactionReserveTokensFloor(
      config,
      resolveModelRef(nextEntry.model) ?? resolveModelRef(agentsConfig.defaults?.model),
    );

    snapshot = await buildSnapshotFromConfig(config);
  });
  logger.info('Updated agent model', { agentId, modelRef: normalizedModelRef || null });
  return snapshot!;
}

export async function deleteAgentConfig(agentId: string): Promise<{ snapshot: AgentsSnapshot; removedEntry: AgentListEntry }> {
  if (agentId === MAIN_AGENT_ID) {
    throw new Error('The main agent cannot be deleted');
  }

  let result: { snapshot: AgentsSnapshot; removedEntry: AgentListEntry } | undefined;
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { agentsConfig, entries, defaultAgentId } = normalizeAgentsConfig(config);
    const bindingsBeforeDeletion = Array.isArray(config.bindings)
      ? config.bindings.filter(isChannelBinding)
      : [];
    const removedEntry = entries.find((entry) => entry.id === agentId);
    const nextEntries = entries.filter((entry) => entry.id !== agentId);
    if (!removedEntry || nextEntries.length === entries.length) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    config.agents = {
      ...agentsConfig,
      list: nextEntries,
    };
    config.bindings = Array.isArray(config.bindings)
      ? config.bindings.filter((binding) => !(isChannelBinding(binding) && binding.agentId === agentId))
      : undefined;

    if (defaultAgentId === agentId && nextEntries.length > 0) {
      nextEntries[0] = {
        ...nextEntries[0],
        default: true,
      };
    }

    const normalizedAgentId = normalizeAgentIdForBinding(agentId);
    const legacyAccountId = resolveAccountIdForAgent(agentId);
    const { channelToAgent, accountToAgent } = getChannelBindingMap(bindingsBeforeDeletion);
    const boundChannelTypes = new Set(bindingsBeforeDeletion.map((binding) => binding.match.channel));
    const ownedLegacyAccounts = new Set(
      [...boundChannelTypes]
        .filter((channelType) => {
          const accountOwner = accountToAgent.get(`${channelType}:${legacyAccountId}`);
          const effectiveOwner = accountOwner
            ?? (legacyAccountId === DEFAULT_ACCOUNT_ID ? channelToAgent.get(channelType) : undefined);
          return effectiveOwner === normalizedAgentId;
        })
        .map((channelType) => `${channelType}:${legacyAccountId}`),
    );

    await deleteAgentChannelAccounts(agentId, ownedLegacyAccounts);
    result = { snapshot: await buildSnapshotFromConfig(config), removedEntry };
  });
  await removeAgentRuntimeDirectory(agentId);
  // The caller removes the workspace only after the coordinator commit above.
  logger.info('Deleted agent config entry', { agentId });
  return result!;
}

export async function assignChannelToAgent(agentId: string, channelType: string): Promise<AgentsSnapshot> {
  let snapshot: AgentsSnapshot | undefined;
  const accountId = resolveAccountIdForAgent(agentId);
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { entries } = normalizeAgentsConfig(config);
    if (!entries.some((entry) => entry.id === agentId)) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    config.bindings = upsertBindingsForChannel(config.bindings, channelType, agentId, accountId);
    snapshot = await buildSnapshotFromConfig(config);
  });
  logger.info('Assigned channel to agent', { agentId, channelType, accountId });
  return snapshot!;
}

export async function assignChannelAccountToAgent(
  agentId: string,
  channelType: string,
  accountId: string,
  options?: { migrateLegacy?: boolean },
): Promise<AgentsSnapshot> {
  const trimmedAccountId = accountId.trim();
  if (!trimmedAccountId) {
    throw new Error('accountId is required');
  }
  let snapshot: AgentsSnapshot | undefined;
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { entries } = normalizeAgentsConfig(config);
    if (!entries.some((entry) => entry.id === agentId)) {
      throw new Error(`Agent "${agentId}" not found`);
    }
    if (options?.migrateLegacy) {
      const validAgentIds = new Set(entries.map((entry) => normalizeAgentIdForBinding(entry.id)));
      migrateLegacyChannelBindingInConfig(config, channelType, validAgentIds);
    }
    config.bindings = upsertBindingsForChannel(config.bindings, channelType, agentId, trimmedAccountId);
    snapshot = await buildSnapshotFromConfig(config);
  });
  logger.info('Assigned channel account to agent', { agentId, channelType, accountId: trimmedAccountId });
  return snapshot!;
}

export async function clearChannelBinding(channelType: string, accountId?: string): Promise<AgentsSnapshot> {
  let snapshot: AgentsSnapshot | undefined;
  await mutateOpenClawConfig(async (configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    config.bindings = upsertBindingsForChannel(config.bindings, channelType, null, accountId);
    snapshot = await buildSnapshotFromConfig(config);
  });
  logger.info('Cleared channel binding', { channelType, accountId });
  return snapshot!;
}

export async function clearAllBindingsForChannel(channelType: string): Promise<void> {
  await mutateOpenClawConfig((configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    if (!Array.isArray(config.bindings)) return;

    const nextBindings = config.bindings.filter((binding) => {
      if (!isChannelBinding(binding)) return true;
      return binding.match?.channel !== channelType;
    });

    config.bindings = nextBindings.length > 0 ? nextBindings : undefined;
  });
  logger.info('Cleared all bindings for channel', { channelType });
}

function migrateLegacyChannelBindingInConfig(
  config: AgentConfigDocument,
  channelType: string,
  validAgentIds: Set<string>,
): void {
  const { channelToAgent, accountToAgent } = getChannelBindingMap(config.bindings);
  const legacyOwner = channelToAgent.get(channelType);
  if (!legacyOwner) return;

  const explicitDefaultOwner = accountToAgent.get(`${channelType}:${DEFAULT_ACCOUNT_ID}`);
  const defaultOwner = explicitDefaultOwner && validAgentIds.has(explicitDefaultOwner)
    ? explicitDefaultOwner
    : (validAgentIds.has(legacyOwner) ? legacyOwner : null);
  if (defaultOwner) {
    config.bindings = upsertBindingsForChannel(
      config.bindings,
      channelType,
      defaultOwner,
      DEFAULT_ACCOUNT_ID,
    );
  }
  config.bindings = upsertBindingsForChannel(config.bindings, channelType, null);
}

export async function migrateLegacyChannelWideBinding(channelType: string): Promise<void> {
  await mutateOpenClawConfig((configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { entries } = normalizeAgentsConfig(config);
    const validAgentIds = new Set(entries.map((entry) => normalizeAgentIdForBinding(entry.id)));
    migrateLegacyChannelBindingInConfig(config, channelType, validAgentIds);
  });
  logger.info('Migrated legacy channel-wide binding', { channelType });
}

export async function ensureScopedChannelBinding(channelType: string, accountId?: string): Promise<void> {
  const normalizedAccountId = accountId?.trim();
  if (!normalizedAccountId) return;

  await mutateOpenClawConfig((configSnapshot) => {
    const config = configSnapshot as AgentConfigDocument;
    const { entries } = normalizeAgentsConfig(config);
    if (entries.length === 0) return;
    const validAgentIds = new Set(entries.map((entry) => normalizeAgentIdForBinding(entry.id)));

    if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
      const mainAgent = entries.find((entry) => entry.id === MAIN_AGENT_ID);
      if (mainAgent) {
        config.bindings = upsertBindingsForChannel(
          config.bindings,
          channelType,
          mainAgent.id,
          DEFAULT_ACCOUNT_ID,
        );
      }
      return;
    }

    migrateLegacyChannelBindingInConfig(config, channelType, validAgentIds);
    const accountAgent = entries.find((entry) => entry.id === normalizedAccountId);
    if (accountAgent) {
      config.bindings = upsertBindingsForChannel(
        config.bindings,
        channelType,
        accountAgent.id,
        normalizedAccountId,
      );
    }
  });
  logger.info('Ensured scoped channel binding', { channelType, accountId: normalizedAccountId });
}
