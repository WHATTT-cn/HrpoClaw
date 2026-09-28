import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
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
import portraitSeed from '@shared/po-supplier-portrait.json';
import decisionSeed from '@shared/po-supplier-decisions.json';
import v6RegionSeed from '@shared/po-v6-region.json';
import v6RegionAtomsSeed from '@shared/po-v6-region-atoms.json';
import v6PurchaseSeed from '@shared/po-v6-purchase.json';
import v6FulfillmentSeed from '@shared/po-v6-fulfillment.json';

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
 * PO Agent workspace 预置的**硬性业务规则集**。
 *
 * 与 Experience.md（软性线下经验，可被系数调节）的定位区别：
 * Rule.md 是**不可违反的刚性约束**（份额上限、浮动区间等），看板分析必须逐条校验。
 * 仅在首次创建时写入 workspace 根目录（Rule.md）；已存在则跳过，避免覆盖用户改动。
 */
const PRESET_PO_RULE_FILE = 'Rule.md';
const PRESET_PO_RULE_CONTENT = `# PO 用工业务硬性规则集

> 本文件是**刚性约束**，与 Experience.md（软性经验、系数调节）不同：以下规则不可违反。
> 分析、建议、分单方案均须逐条校验；一旦触碰即为**违规**，必须显式提示并给出修正方案。

## 供应商分单任务

- 【份额上限】单个供应商在同一物流仓的承接份额**不得超过 40%**，超过即为违规，须拆分给其他供应商。
- 【最少供应商数】单仓分单**至少引入 2 家**供应商，避免单点依赖导致停供风险。
- 【新供应商限额】首次合作的供应商，单仓首轮承接**不超过 10 人**，通过磨合期后方可扩量。
- 【供给能力上限】分配给某供应商的人数**不得超过其画像表中的「历史最大供给量」**，超出部分视为不可交付。
- 【低置信度收紧】画像行「置信度」为**低或极低**时，该行对应供应商的承接份额**不得超过 25%**（数据不足，需压低暴露）。
- 【基准行不可分单】「全体基准」是全仓兜底聚合行，**不是真实供应商**，不得作为分单对象，也不计入份额与家数校验。
- 【无报价不比价】画像行价格为「—」（无报价数据）时，**不得据此做成本比价或成本最优结论**，须显式声明该供应商缺报价。

## 用工保障任务

- 【合理浮动区间】用工需求量的合理浮动为**理论计算结果的上下 20%**（即 [计算值×0.8, 计算值×1.2]）；超出此区间的用工建议必须给出额外理由。
- 【供给率红线】供给率**低于 0.85** 的供应商不得作为该仓主力承接方（份额不得居首）。
- 【离职率红线】离职率**高于 15%** 的供应商不得承接连续性要求高的岗位（如夜班、长周期驻场）。
- 【到岗时限】到岗天数**超过 5 天**的供应商不得用于爬坡期/大促等时效敏感场景。
- 【考勤门槛】假期与大促覆盖单，承接方考勤率须**≥ 95%**。

## 通用规则

- 【数据真实性】所有结论必须基于 Suppliers.md 表内真实数值，**禁止编造**；无数据时如实说明缺失。
- 【冲突优先级】Rule.md 与 Experience.md 冲突时，**以 Rule.md 为准**（硬性规则优先于软性经验）。
`;

/**
 * 幂等写入 PO workspace 的 Rule.md 预置文件。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-po/Rule.md`（由 createAgent 保证 workspace 已存在）。
 * - 文件已存在则跳过，避免覆盖用户改动。
 */
async function ensurePresetPoRuleFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const target = join(workspace, PRESET_PO_RULE_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_PO_RULE_CONTENT, 'utf8');
  logger.info('Provisioned preset PO rule file', { path: target });
}

/**
 * PO Agent workspace 预置的**履约缺口补救措施手册**。
 *
 * 与 Rule.md（硬性规则）、Experience.md（软性经验）的定位区别：
 * Trace.md 是**履约追踪专用的处置预案**——按「距离预期供给日的剩余天数」分档，
 * 给出该档位下可执行的补救动作清单，供 po-fulfillment-analysis skill 逐档引用。
 *
 * ⚠️ 口径说明（方案 A · 代理量法，与看板数据链路一致）：
 * V6 履约台账（板块四）只有「入职总人数」，没有真实下单需求人数与预期供给日期字段，
 * 因此需求基线用板块三同条件组的「需求量下限」桶下限**代理**，预期供给日 = 入职日期 + 供给时效。
 * 本文件在开头显式声明该代理关系，防止模型把代理量当作确定订单量输出。
 */
const PRESET_PO_TRACE_FILE = 'Trace.md';
const PRESET_PO_TRACE_CONTENT = `# PO 履约缺口补救措施手册

> 本文件是**履约追踪看板专用**的处置预案，按「距离预期供给日的剩余天数」分档给出补救动作。
> 与 Rule.md（不可违反的硬性规则）并行使用：本文件给的是**动作建议**，Rule.md 给的是**约束边界**；
> 任何补救动作都不得突破 Rule.md 的份额上限、供给能力上限与各项红线。

## 一、口径前提（必须在结论中如实标注）

当前 V6 履约台账（板块四 · 入职明细）**只记录实际入职人数**，不含真实下单需求人数与预期供给日期字段。
因此本手册与分析结论统一采用以下**代理口径**：

- **预期供给日** = 入职日期 + 供给时效（天）。供给时效按需求量桶取值：
  - 需求量桶 0~20 → **7 天**
  - 需求量桶 20~100 → **14 天**
  - 需求量桶 100~9999 → **30 天**
- **需求基线** = 该条件组在采购下单看板（板块三）所属需求量桶的**桶下限**（0 / 20 / 100）作为代理量。
- **缺口** = 需求基线（桶下限） − 实际入职总人数；结果 ≤ 0 视为无缺口。
- **剩余天数** = 预期供给日 − 今天。

> ⚠️ **强制标注**：输出中凡引用「需求量」「缺口」的数值，必须写明其为
> **「板块三需求量桶下限代理量，非真实订单量」**，不得表述为确定的订单需求数。
> 桶下限是保守下界，真实需求只会更高，故缺口为**下界估计**（实际缺口可能更大）。

## 二、缺口严重度分级

以「缺口 ÷ 需求基线」计算缺口率，配合绝对缺口人数定级：

| 级别 | 判定条件 | 含义 |
| --- | --- | --- |
| 轻微 | 缺口率 < 10% 且 缺口 < 5 人 | 正常波动，常规跟进即可 |
| 中等 | 缺口率 10% ~ 30% 或 缺口 5 ~ 15 人 | 需主动干预，追加供给 |
| 严重 | 缺口率 > 30% 或 缺口 > 15 人 | 存在停工/断供风险，须升级处理 |

## 三、按剩余天数分档的补救措施

### 档位 A：剩余 > 14 天（充裕期）

风险特征：时间窗口充足，缺口可通过常规补招消化；此时**成本优先**。

- 向**现有承接供应商**追加订单量，优先给供给率 ≥ 0.9 且离职率 < 10% 的供应商（仍受单仓 40% 份额上限约束）。
- 缺口为「中等」及以上时，**并行启动第二家供应商询价**，避免后期被单一供应商卡量。
- 复核该条件组的历史「供给满足率」：若该供应商历史满足率长期 < 0.85，直接按缺口 ×1.2 下单预留损耗。
- 记录一次跟进节点（建议 T-14 / T-7 两次复盘），不必立即升级。

### 档位 B：剩余 8 ~ 14 天（预警期）

风险特征：常规补招仍来得及，但供给时效为 7 天的桶已逼近交付极限；**时效优先于成本**。

- 立即向现有供应商下达**书面补量确认**，要求给出明确到岗日期，而非口头承诺。
- 引入**到岗天数 ≤ 5 天**的备选供应商分摊缺口（Rule.md 到岗时限条款）；新供应商首轮不超过 10 人。
- 缺口为「严重」时，同步启动**内部调配预案**：相邻物流仓富余人力临时支援、现有员工加班覆盖。
- 若该条件组置信度为 低 / 极低，按缺口 ×1.3 冗余下单，并在结论中标注该冗余系数的来源。

### 档位 C：剩余 3 ~ 7 天（紧急期）

风险特征：新招募几乎无法在窗口内到岗，只能靠**存量调配**与**结构调整**。

- 优先使用**已在册人力**：跨仓调配、跨班次调配、现有三方员工延长工时（须校验考勤率 ≥ 95%）。
- 联系**到岗天数 ≤ 3 天**的应急供应商（通常价格更高），明确按应急价结算，并在建议中标注成本上浮。
- 与业务方确认**需求可否分批交付**：把缺口部分顺延到下一批次，换取交付确定性。
- 缺口为「严重」时**必须升级**至用工负责人，同步给出「降低作业量 / 延长作业窗口」的业务侧兜底选项。

### 档位 D：剩余 0 ~ 2 天（临界期）

风险特征：供给侧已无腾挪空间，重点转为**止损与影响面控制**。

- 冻结新增招募动作，全部资源转向**当日可到岗人力**（本地临时工、加班覆盖、跨仓紧急借调）。
- 立即输出**影响面评估**：缺口人数 × 单人日均件效 = 预计产能缺口，供业务方决策是否削峰。
- 向业务方发出**正式风险通告**，明确告知无法足额交付的批次、缺口人数与预计影响。
- 同步启动**供应商履约追责**：记录该供应商本次未达量事实，作为后续份额调整依据。

### 档位 E：剩余 < 0 天（已逾期）

风险特征：预期供给日已过且仍有缺口，属**已发生的履约失败**。

- 停止继续按原计划补人，改为**重新评估当前真实需求**后下新单（避免补到不再需要的人）。
- 完成**事后复盘**：缺口成因归类（供应商能力不足 / 需求突增 / 招募周期误判 / 数据口径偏差）。
- 将该供应商本条件组的置信度下调，并在下一轮分单中压低其份额（参考 Rule.md 低置信度收紧条款）。
- 若同一供应商在同一仓连续两个批次逾期，建议启动**替换预案**（Rule.md 最少供应商家数保障切换可行性）。

## 四、输出约束

- 每条补救措施必须绑定到**具体批次**（物流仓 + 条件组 + 入职日期），不得给泛泛的通用建议。
- 同一批次只引用其**所属档位**的措施，不要罗列全部档位。
- 补救动作若涉及追加份额、跨仓调配、引入新供应商，必须先用 Rule.md 校验是否触线，触线须给修正方案。
- 无缺口批次不必逐条列出，汇总成一句说明即可。
`;

/**
 * 幂等写入 PO workspace 的 Trace.md 预置文件。
 *
 * - 目标路径固定为 `~/.openclaw/workspace-po/Trace.md`（由 createAgent 保证 workspace 已存在）。
 * - 文件已存在则跳过，避免覆盖用户改动（语义与 Rule.md 一致）。
 */
async function ensurePresetPoTraceFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const target = join(workspace, PRESET_PO_TRACE_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_PO_TRACE_CONTENT, 'utf8');
  logger.info('Provisioned preset PO trace file', { path: target });
}

/** PO 用工决策登记 skill 的 slug（写入 workspace 的 skills/<slug>/SKILL.md）。 */
const PRESET_PO_DECISION_SKILL_SLUG = 'po-decision-logging';

/**
 * @deprecated 已弃用：引导模型调用 `record_decision` 发起人审登记的旧模板。
 *
 * 履约追踪改为「TS 真源 → gen 脚本派生」后看板变为只读，登记链路整体退役。
 * 旧模板内容保留在下方注释中作历史存档，不再写入任何 workspace；请勿恢复使用。
 *
 * 旧流程：定案信号（定了/就这么定/按这个执行/确认分单）→ `read_decision` 查重
 * → `record_decision`（warehouse/supplier/headcount/basis/date）→ 人审弹窗确认
 * → 系统自动生成 decisionNo 并追加写入 用工决策.json。
 */
/* 旧模板存档（已注释弃用，请勿启用）：
const PRESET_PO_DECISION_SKILL_CONTENT_LEGACY = `---
name: po-decision-logging
description: 当用户确认了一条用工分单决策(某物流仓交给某供应商承接多少人)后,把该决策登记进可写决策看板。识别到"定了/就这么定/按这个执行/确认分单"等定案信号时使用。
---

# 用工决策登记

你负责把**已经确认定案**的用工分单决策登记进决策看板。

## 何时触发

当用户明确表示某条用工分单决策已定案时触发,典型信号:
- "就这么定" / "按这个执行" / "确认分单" / "定了"
- 用户复述了完整的分单结论(哪个仓、哪个供应商、承接多少人)

**不要**在只是讨论、比较、还未拍板时登记。

## 登记前先查重

登记前先调用 \`read_decision\` 读取已有决策,避免对同一仓/供应商/日期重复登记。

## 如何登记

调用 \`record_decision\` 工具,按如下字段传参:

- \`warehouse\`: 物流仓名称(如 "A物流仓")
- \`supplier\`: 供应商名称(如 "A供应商")
- \`headcount\`: 承接人数 / 档级(如 "60人 / 中批量档")
- \`basis\`: 决策依据(一句话说明为什么这样分)
- \`date\`: 决策日期(可选,YYYY-MM-DD;当天可不传,由系统补当天)

**决策单号(decisionNo)由系统自动生成,禁止自行编造或传入。**

调用后会弹出人工审批确认框,由用户最终确认是否写入看板。你只负责如实发起登记,不要替用户预设审批结果。
`;
旧模板存档结束 */

/** 现行模板：只读说明。更新履约追踪须改 TS 真源并重跑生成脚本。 */
const PRESET_PO_DECISION_SKILL_CONTENT = `---
name: po-decision-logging
description: 说明用工决策看板(履约追踪)为只读派生数据。当用户提出"登记决策/写入看板/更新履约追踪"时使用,告知正确的更新方式。
---

# 用工决策看板(只读)

用工决策看板的数据**不可通过对话写入**。看板展示的 \`用工决策.json\` 是派生产物,
唯一人工维护真源是 ClawX 仓库的 \`src/data/supplier-decision-table.ts\`。

## 查询

需要查看已有决策时调用 \`read_decision\` 读取当前记录,用于回答与查重。

## 不要做的事

- **不要**调用 \`record_decision\` 或任何写工具追加决策记录(该能力已停用)。
- **不要**直接编辑 \`用工决策.json\`;任何直接写入都会在下次重跑生成脚本时被全量覆盖。
- **不要**自行编造决策单号(decisionNo)。

## 正确的更新方式

当用户确认了一条新的用工分单决策,如实告知并引导:

1. 在 ClawX 仓库编辑 \`src/data/supplier-decision-table.ts\`,新增或修改记录
   (六个字段:decisionNo / date / warehouse / supplier / headcount / basis)。
2. 运行 \`pnpm gen:decisions\`,全量派生覆盖 \`用工决策.json\` 与 shared 预置快照。
3. 在看板点击刷新,重新读取最新数据。

同时把本次定案的完整结论(仓、供应商、人数/档级、依据)清晰复述给用户,便于其登记到真源。
`;

/**
 * 幂等写入 PO workspace 的用工决策 skill(SKILL.md)。
 *
 * 目标 `~/.openclaw/workspace-po/skills/po-decision-logging/SKILL.md`。
 * 迁移语义:老环境已落盘的旧模板会主动引导模型调用已停用的 `record_decision`,
 * 因此除「文件不存在」外,检测到残留旧写入引导时也覆盖为只读说明;
 * 用户自行改写过、且不含旧写入引导的内容保持不动。
 */
async function ensurePresetPoDecisionSkillFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const skillDir = join(workspace, 'skills', PRESET_PO_DECISION_SKILL_SLUG);
  const target = join(skillDir, 'SKILL.md');
  if (await fileExists(target)) {
    let existing: string;
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      // 读取失败时不做任何猜测性覆盖，保持既有文件原样。
      return;
    }
    if (existing === PRESET_PO_DECISION_SKILL_CONTENT) {
      return;
    }
    // 只识别旧模板的专属特征（写入引导标题 + 调用指令），避免误覆盖用户自行改写的只读说明。
    const isLegacyWriteTemplate = existing.includes('# 用工决策登记')
      && existing.includes('调用 `record_decision` 工具');
    if (!isLegacyWriteTemplate) {
      return;
    }
    await writeFile(target, PRESET_PO_DECISION_SKILL_CONTENT, 'utf8');
    logger.info('Migrated legacy PO decision skill to read-only', { path: target });
    return;
  }
  await ensureDir(skillDir);
  await writeFile(target, PRESET_PO_DECISION_SKILL_CONTENT, 'utf8');
  logger.info('Provisioned preset PO decision skill', { path: target });
}

/** 用工决策看板数据文件名(履约追踪看板运行时读取路径)。 */
const PRESET_PO_DECISION_FILE = '用工决策.json';

/**
 * @deprecated 已弃用:手写初始种子。
 *
 * 履约追踪已改为「TS 真源 -> gen 脚本派生」的同源管线(与供应商画像一致),
 * 唯一人工维护源是 `src/data/supplier-decision-table.ts`,预置内容改由
 * `@shared/po-supplier-decisions.json` 派生。此处保留旧种子仅作历史存档,
 * 不再有任何调用方;请勿恢复使用。
 */
// const PRESET_PO_DECISION_SEED_CONTENT_DEPRECATED = `${JSON.stringify(
//   {
//     records: [
//       {
//         decisionNo: 'PO-2026-001',
//         date: '2026-01-15',
//         warehouse: 'A物流仓',
//         supplier: 'A供应商',
//         headcount: '12人 / 中批量档',
//         basis: 'A供应商本地班组成熟,新仓爬坡期优先承接,首轮豁免新供应商 10 人限额',
//       },
//     ],
//   },
//   null,
//   2,
// )}\n`;

/**
 * 用工决策预置内容:来自 `@shared/po-supplier-decisions.json`,
 * 由 `pnpm gen:decisions` 从 TS 真源 `src/data/supplier-decision-table.ts` 全量派生。
 */
const PRESET_PO_DECISION_SEED_CONTENT = `${JSON.stringify(decisionSeed, null, 2)}\n`;

/**
 * 幂等写入 PO workspace 的用工决策看板数据(用工决策.json)。
 *
 * - 目标 `~/.openclaw/workspace-po/用工决策.json`;已存在则跳过。
 * - 种子来自 `@shared/po-supplier-decisions.json`,由 gen-decisions.mjs 从 TS 真源派生。
 * - 语义:预置仅兜底首次写入;「全量刷新」由重跑 `pnpm gen:decisions` 覆盖 workspace json
 *   (职责分离:预置=兜底,脚本=刷新,与供应商画像.json 幂等模式一致)。
 */
async function ensurePresetPoDecisionFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const target = join(workspace, PRESET_PO_DECISION_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_PO_DECISION_SEED_CONTENT, 'utf8');
  logger.info('Provisioned preset PO decision seed file', { path: target });
}

/** PO 日记看板数据文件名(与 PoDiaryCalendar 运行时读写路径一致)。 */
const PRESET_PO_DIARY_FILE = 'PO日记.json';
/** 空文档种子:日记是用户在界面上录入的数据,预置只负责把文件创建出来。 */
const PRESET_PO_DIARY_SEED_CONTENT = `${JSON.stringify({ entries: [] }, null, 2)}\n`;

/**
 * 幂等创建 PO workspace 的日记数据文件(PO日记.json)。
 *
 * - 目标 `~/.openclaw/workspace-po/PO日记.json`;已存在则跳过,绝不覆盖用户录入的条目。
 * - 与用工决策/供应商画像不同,该文件**没有 TS 真源也没有生成脚本**:它是看板上
 *   「+ 新增条目」表单经 host-api files.writeText 直接写入的可写运行时数据。
 * - 预置的必要性:files-api 的 writeText 对不存在的文件返回 notFound(不会自动创建),
 *   因此必须在启动阶段先把空文档落盘,否则首次新增会失败。
 */
async function ensurePresetPoDiaryFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const target = join(workspace, PRESET_PO_DIARY_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_PO_DIARY_SEED_CONTENT, 'utf8');
  logger.info('Provisioned preset PO diary file', { path: target });
}

/** 供应商画像看板数据文件名(与 SupplierPortraitDashboard 运行时读取路径一致)。 */
const PRESET_PO_PORTRAIT_FILE = '供应商画像.json';
const PRESET_PO_PORTRAIT_SEED_CONTENT = `${JSON.stringify(portraitSeed, null, 2)}\n`;

/**
 * 幂等写入 PO workspace 的供应商画像看板种子数据(供应商画像.json)。
 *
 * - 目标 `~/.openclaw/workspace-po/供应商画像.json`;已存在则跳过。
 * - 种子来自 `@shared/po-supplier-portrait.json`,由 gen-portrait-md.mjs 从 TS 真源派生。
 * - 语义:预置仅兜底首次写入;画像「定期全量刷新」由重跑 gen 脚本覆盖 workspace json 落地
 *   (职责分离:预置=兜底,脚本=刷新,与用工决策.json 幂等模式一致)。
 */
async function ensurePresetPoPortraitFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const target = join(workspace, PRESET_PO_PORTRAIT_FILE);
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(workspace);
  await writeFile(target, PRESET_PO_PORTRAIT_SEED_CONTENT, 'utf8');
  logger.info('Provisioned preset PO portrait seed file', { path: target });
}

/**
 * V6 看板数据文件清单(文件名与各看板组件运行时读取路径、gen-v6-boards.mjs 写入路径三方一致)。
 *
 * - `compact: true` 表示纯机读的原子量产物,与 gen 脚本一致采用紧凑 JSON(省约 40% 体积);
 *   其余产物保留 2 空格缩进,便于 Agent 直接读取与人工排查。
 * - 种子来自 `@shared/po-v6-*.json`,由 gen-v6-boards.mjs 从 TS 真源一次派生(同源双写)。
 */
const PRESET_PO_V6_FILES: ReadonlyArray<{ file: string; seed: unknown; compact: boolean }> = [
  { file: '区域健康.json', seed: v6RegionSeed, compact: false },
  { file: '区域健康原子量.json', seed: v6RegionAtomsSeed, compact: true },
  { file: '采购下单.json', seed: v6PurchaseSeed, compact: false },
  { file: '履约追踪.json', seed: v6FulfillmentSeed, compact: false },
];

/**
 * 幂等写入 PO workspace 的 V6 看板种子数据(区域健康 / 区域健康原子量 / 采购下单 / 履约追踪)。
 *
 * - 逐个文件判存,已存在则跳过,绝不覆盖用户现场数据。
 * - 语义与画像预置一致:预置=首次兜底,刷新=重跑 `pnpm gen:v6` 覆盖 workspace json。
 * - 序列化放在缺失分支内惰性执行,避免应用启动时无谓地把近 1MB 种子转成字符串。
 */
async function ensurePresetPoV6Files(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  for (const { file, seed, compact } of PRESET_PO_V6_FILES) {
    const target = join(workspace, file);
    if (await fileExists(target)) {
      continue;
    }
    await ensureDir(workspace);
    const content = compact ? `${JSON.stringify(seed)}\n` : `${JSON.stringify(seed, null, 2)}\n`;
    await writeFile(target, content, 'utf8');
    logger.info('Provisioned preset PO V6 board file', { path: target });
  }
}

/** PO 看板分析 skill 的 slug(写入 workspace 的 skills/<slug>/SKILL.md)。 */
const PRESET_PO_DASHBOARD_SKILL_SLUG = 'po-dashboard-analysis';
const PRESET_PO_DASHBOARD_SKILL_CONTENT = `---
name: po-dashboard-analysis
description: 通读 V6 采购下单看板数据(采购下单.json,板块三 by 条件维度)并结合 Rule.md 硬性业务规则,以「条件组」为单位横向比较各供应商的 8 个绩效维度,输出分单建议、规则校验结论与风险。采购下单看板分析触发/刷新时会以固定提示词调用本 skill。
---

# 采购下单看板分析(V6 · 条件组维度)

你负责通读 V6 采购下单看板的权威数据,以**条件组**(物流仓 × 工种 × 班次 × 用工性质 × 技能等级)为单位,横向比较组内各供应商表现,输出**分单建议**与**风险提示**。

## 数据来源

依次读取 workspace 根目录的两个文件(均用 read_file):

1. **采购下单.json**(板块三 · by 条件维度权威表):顶层为对象,含 \`版本\` / \`生成时间\` / \`周期档\`(如 ["全周期","2026-08"])/ \`物流仓\`(仓名数组)/ \`切片\`。
   \`切片\` 是一个**以 \`"周期档|物流仓"\` 为 key 的对象(不是数组)**,例如 \`切片["全周期|阿联酋迪拜定制8号仓"]\`;
   其值为 \`{ rows: [...], meta: {...} }\` —— \`rows\` 才是真正的数据行数组,\`meta\` 记录该切片的统计留痕
   (\`原始切片数\` / \`过滤后切片数\` / \`原始条件组数\` / \`过滤后条件组数\` / \`EB先验_全仓池化出勤率\` / \`价格命中切片数\` / \`件效常量\` / \`最终行数\` 等)。
   **必须按当前筛选的周期档与物流仓拼出 key 后再取 \`rows\`,不要遍历全部 key 后把所有仓混在一起比较。**
   **所有分析必须基于表内真实数值,不得编造;无对应数据时如实说明。**
2. **Rule.md**(用工业务硬性规则集):份额上限、浮动区间等刚性约束。**必须先读 Rule.md 再出结论。**

> 本 skill 只读 Rule.md,**不读 Experience.md**。Rule.md 是不可违反的硬性规则。

## 数据结构与口径(必须先理解再分析)

每一行的主键 = **物流仓 × 工种 × 班次 × 用工性质 × 技能等级 × 供应商 × 需求量桶**。
前五项构成一个**条件组**,同组内的多行即为**可比的候选供应商**;看板上每个条件组渲染为一个图表框。

### 分桶与行复制
统计完成后先**剔除「置信度 = 极低」的切片**,再按 3 个需求量桶复制行:
\`需求量下限/需求量上限\` = [0,20) / [20,100) / [100,9999)。
因此**同一供应商会出现 3 行、指标值相同**,只是适用的需求量区间不同——**不要当作 3 条独立记录重复计数**。
由于已剔除极低置信度,**不得声称覆盖了该仓全部切片**。

### 8 个绩效维度的口径与陷阱
- **出勤率**:已做 EB 收缩(k=30,先验为供应商×用工性质池化率,缺失回落全仓池化率);原始值另见 \`出勤率_原始\`。**小样本供应商的出勤率被拉向先验,不宜作为唯一排序依据。**
- **考勤异常率** = 考勤异常人次 / 计划出勤人次,**可能 > 1 不封顶**,高值代表管理质量风险。
- **离职率**:下沉粒度为 供应商 × 用工性质 × 技能等级,分母 = 期末在职人数 + 窗口内离职人数。
- **供给满足率**:业务方指定**常量 1.0,非实算**。⚠ **禁止据此下「履约良好 / 供给充足」结论**,只能说明该口径暂未接入。
- **供给时效**:业务方指定**按需求量桶取常量(0-20→7 /20-100→14 / 100 以上→30 天),非实算**。⚠ 只能用于推算预期到岗日,**不得解读为供应商响应速度差异**——同桶内所有供应商完全相同。
- **价格**:单位 AED/人·小时,**仅 8 号仓(C0080000051)有值,其余仓为 null**。⚠ 跨仓比价或对 null 仓比价一律禁止,须显式说明「该仓无报价数据」。
- **件效**:5 号仓与未知仓为 null(口径未接入),其余仓可用于理论用工数换算。
- **考勤工时 / 加班工时**:规模与负荷参考量,加班占比过高提示疲劳与成本风险。

### 样本与置信度
- \`样本人数\` 决定 \`档级\`;\`区间宽度pp\` 为 Wilson 95% 置信区间宽度(百分点),**宽度越大结论越不可靠**。
- \`置信度\` 为 低 时须压低建议份额并显式标注不确定性。
- 两家供应商出勤率差值**小于各自区间宽度**时,应判定为「差异不显著」,不得据此排名。

### 占位行
若某行 \`数据状态 = '样本不足-无可用记录'\`(含 \`说明\`/\`原始切片数\` 字段而无供应商),说明该仓本周期过滤后无可用记录。
此时**只输出空态说明**(该仓样本不足、原始切片数、建议扩大周期或等待数据积累),**不得编造任何分析结论**。

## 规则校验(强制)

给出每条建议前,必须用 Rule.md 逐条校验,重点包括:

- 单个供应商份额是否超过规则上限(如单仓不超过 40%)
- 是否满足最少供应商家数,是否超过供应商承接上限
- 用工数是否落在规则允许的合理浮动区间内(如理论计算结果的上下 20%)
- 是否触碰离职率 / 考勤率等红线
- 置信度为低的供应商是否已按规则压低份额

**一旦方案触碰某条规则,必须显式指出违反了 Rule.md 中的哪一条,并给出修正后的合规方案。** Rule.md 与软性经验冲突时以 Rule.md 为准。

## 分析步骤

1. 读取两个文件;若触发提示词给出了**当前看板筛选范围**(周期档 / 物流仓 / 需求量桶 / 指标维度),**只分析该范围内的行**,并在开头复述该范围。
2. 按条件组分组,组内按供应商横向比较;优先分析可见条件组中**差异最显著**或**风险最高**的若干组,不必穷举。
3. 若触发提示词限定了单一**指标维度**,则聚焦该维度展开,其余维度仅在解释风险时点到为止。

## 输出格式

按条件组分节(标题形如 \`物流仓 · 工种 · 班次 · 用工性质 · 技能等级\`),每组给出:

- **组内对比**:各供应商在关键维度上的差异(带真实数值),显著性判断须引用区间宽度/样本人数
- **分单建议**:一到两条可执行建议(建议份额须说明依据,并注明适用的需求量桶)
- **风险提示**:稳定性 / 异常率 / 成本 / 置信度 / 口径缺失等
- **规则校验**:对照 Rule.md 的结论——合规则说明已满足哪些关键约束;触线则指出违反的具体条目及修正方案

最后用 2-3 句给出跨条件组的总体结论。保持简洁,聚焦决策价值,不要整段回抄原始数据。
`;

/**
 * 幂等写入 PO workspace 的采购下单看板分析 skill(SKILL.md)。
 *
 * 目标 \`~/.openclaw/workspace-po/skills/po-dashboard-analysis/SKILL.md\`。
 * 迁移语义:老环境落盘的 V5 模板引导模型去读已下线的 \`Suppliers.md\` 并逐仓分析,
 * 与 V6 图表化后的「采购下单.json + 条件组 × 8 维度」数据不符,检测到旧版专属特征时覆盖;
 * 用户自行改写过、且不含旧版特征的内容保持不动。
 */
async function ensurePresetPoDashboardSkillFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const skillDir = join(workspace, 'skills', PRESET_PO_DASHBOARD_SKILL_SLUG);
  const target = join(skillDir, 'SKILL.md');
  if (await fileExists(target)) {
    let existing: string;
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      return;
    }
    if (existing === PRESET_PO_DASHBOARD_SKILL_CONTENT) {
      return;
    }
    // 只识别 V5 旧模板的专属特征（已下线数据源 + 旧标题），避免误覆盖用户自行改写的内容。
    const isLegacyV5Template = existing.includes('Suppliers.md')
      && existing.includes('# 供应商画像看板分析');
    if (!isLegacyV5Template) {
      return;
    }
    await writeFile(target, PRESET_PO_DASHBOARD_SKILL_CONTENT, 'utf8');
    logger.info('Migrated legacy PO dashboard skill to V6 schema', { path: target });
    return;
  }
  await ensureDir(skillDir);
  await writeFile(target, PRESET_PO_DASHBOARD_SKILL_CONTENT, 'utf8');
  logger.info('Provisioned preset PO dashboard skill', { path: target });
}

/** 区域健康看板分析 skill 的 slug。 */
const PRESET_PO_REGION_SKILL_SLUG = 'po-region-health-analysis';
const PRESET_PO_REGION_SKILL_CONTENT = `---
name: po-region-health-analysis
description: 通读 V6 区域健康看板数据(区域健康.json,板块一区域总体 + 板块二 by 供应商)并结合 Rule.md,分析当前选中区域与时间范围内的「供给结构」与「供给质量」风险,输出结论与建议。区域健康看板分析触发/刷新时会以固定提示词调用本 skill。
---

# 区域健康看板分析(V6 · 供给结构与供给质量)

你负责通读 V6 区域健康看板的权威数据,针对**当前选中的区域(物流仓范围)与时间范围**,诊断**供给结构风险**与**供给质量风险**,并给出可执行建议。

## 数据来源

依次读取 workspace 根目录的两个文件(均用 read_file):

1. **区域健康.json**(板块一/板块二权威快照):顶层为对象,含 \`版本\` / \`生成时间\` / \`口径说明\` / \`快照\`。
   \`快照\` 是数组,每项形如 \`{ 周期档, 范围, 板块一: {...}, 板块二: [...] }\`。
   **必须先按触发提示词给出的「周期档」与「范围」(\`全部仓\` 或具体仓名)定位到对应的那一项快照**,再取其 \`板块一\` / \`板块二\`;
   不要把多项快照混在一起比较,更不要把不同周期档的数值相加。
   **所有结论必须基于快照内真实数值,不得编造;字段缺失时如实说明。**
2. **Rule.md**(用工业务硬性规则集):份额上限、最少家数、红线等刚性约束。**必须先读 Rule.md 再出结论。**

> 本 skill 只读 Rule.md,**不读 Experience.md**。Rule.md 是不可违反的硬性规则。

## 数据结构与口径(必须先理解再分析)

### 板块一 · 区域总体(单个对象)
- **供给结构类**:\`供给人数\`(三方在册规模)、\`全体出勤人数\`(自有+三方)、\`三方员工占比\` = 供给人数 / 全体出勤人数、\`覆盖物流仓\`、
  \`活跃供应商数量\`/\`活跃供应商名单\`、\`头部供应商数量\`/\`名单\`/\`占比\`(阈值见 \`头部供应商阈值\`,人工裁决为 50%)、
  \`CR3集中度\`(供给占比 Top3 之和)、\`最大单家供给占比\`、\`供应商份额\`。
- **供给质量类**:\`出勤率\` = 出勤人次 / 计划出勤人次;\`考勤异常率\` = 考勤异常人次 / 计划出勤人次;
  \`异常明细\` / \`异常处理进度\` / \`异常已处理人日\` / \`异常待处理基数\`(★V6 收紧:仅统计三方员工);
  \`离职率\` = 窗口内离职人数 /(期末在职人数 + 窗口内离职人数);\`考勤工时\` / \`加班工时\` / \`加班工时占比\`。

### 板块二 · by 供应商(数组,每行一家供应商)
字段与板块一质量类同名同口径,另有:\`供给占比\`(组内 Σ = 1)、\`是否头部\`、\`历史最大供给量\`。

### 陷阱(禁止性结论,务必遵守)
- \`供给满足率\` 恒为 **1.0**、\`供给时效\` 恒为 **14**,均为业务方指定常量、**非实算**。⚠ 禁止据此下「履约良好 / 交付及时」结论,只能说明口径暂未接入。
- \`静默供应商数量\` / \`静默供应商名单\` 为**占位未接入**。⚠ 不得当作「静默供应商为 0」解读。
- \`人头近似\` / \`峰值近似\` 为 true 时,相关人数为近似值,**必须在结论中如实传导「该口径为近似值」**。
- \`考勤异常率\` **可能 > 1 且不封顶**(同一人次可多类异常),高值代表管理质量风险,不要误判为数据错误。
- \`考勤工时\`(三方口径)与 \`全体考勤工时\`(自有+三方)**不可混用或相减解读**。
- \`历史最大供给量\` = **全历史日在职峰值**,不受当前统计周期限制;各家峰值出现在不同日,**各家之和可大于整仓峰值,禁止相加当作区域峰值**。

## 分析任务

### 一、供给结构
规模与覆盖(供给人数 / 全体出勤人数 / 三方员工占比 / 覆盖物流仓)、集中度风险(CR3集中度 / 最大单家供给占比 / 头部供应商数量与占比)、
供应商冗余度(活跃家数、尾部小份额家数)、弹性空间(各家 \`历史最大供给量\` 与当前 \`供给人数\` 的差额 → 可追加空间)。

### 二、供给质量
出勤履约(出勤率、计划 vs 实际人次)、异常管理(考勤异常率、异常明细分布、异常处理进度与待处理基数)、
人员稳定性(离职率、窗口内离职人数、期末在职人数)、负荷与成本(考勤工时、加班工时、加班工时占比过高 → 疲劳与成本风险)。
板块二用于**定位是哪几家供应商拉低了区域指标**,须给出具体供应商名与数值。

## 规则校验(强制)
给出建议前用 Rule.md 逐条校验:份额上限(如单仓不超过 40%)、最少供应商家数、承接上限、离职率/考勤率红线。
**一旦现状或建议触碰某条规则,必须显式指出违反了 Rule.md 中的哪一条,并给出修正方案。**

## 分析步骤
1. 读取两个文件;按触发提示词的「周期档 + 范围」定位快照,**开头先复述本次分析的区域与时间范围**。
2. 先看板块一形成区域整体判断,再用板块二下钻到具体供应商定位问题来源。
3. 聚焦风险最高的 2-4 个点,不必穷举所有字段。

## 输出格式
分「供给结构」「供给质量」两节,每节包含:
- **现状**(带真实数值,注明口径与近似标志)
- **风险**(集中度 / 稳定性 / 异常 / 负荷,指明具体供应商)
- **建议**(可执行动作,并说明通过了 Rule.md 的哪些约束)

最后用 2-3 句给出区域健康总体结论。保持简洁,聚焦决策价值,不要整段回抄原始数据。
`;

/**
 * 幂等写入 PO workspace 的区域健康看板分析 skill(SKILL.md)。
 *
 * 目标 \`~/.openclaw/workspace-po/skills/po-region-health-analysis/SKILL.md\`。
 * 语义:内容一致跳过;文件已存在但内容不同,视为用户自行改写,保持不动。
 */
async function ensurePresetPoRegionSkillFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const skillDir = join(workspace, 'skills', PRESET_PO_REGION_SKILL_SLUG);
  const target = join(skillDir, 'SKILL.md');
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(skillDir);
  await writeFile(target, PRESET_PO_REGION_SKILL_CONTENT, 'utf8');
  logger.info('Provisioned preset PO region health skill', { path: target });
}

/** 履约追踪看板分析 skill 的 slug。 */
const PRESET_PO_FULFILLMENT_SKILL_SLUG = 'po-fulfillment-analysis';
const PRESET_PO_FULFILLMENT_SKILL_CONTENT = `---
name: po-fulfillment-analysis
description: 通读 V6 履约追踪看板数据(履约追踪.json 主表/明细)并结合 采购下单.json 的需求量桶下限与 Trace.md 补救措施手册,识别实际入职人数不足以满足下单需求的批次,按距预期供给日的剩余天数分档输出风险与补救建议。履约追踪看板分析触发/刷新时会以固定提示词调用本 skill。
---

# 履约追踪看板分析(V6 · 缺口与剩余天数分档)

你负责识别**实际入职人数无法满足下单需求**的批次,计算其**距预期供给日的剩余天数**,并按档位给出**风险判断与补救措施**。

## 数据来源

依次读取 workspace 根目录的三个文件(均用 read_file):

1. **履约追踪.json**(板块四 · 入职批次权威表):顶层为对象,含 \`版本\` / \`生成时间\` / \`主表\` / \`明细\`。
   - \`主表\`:数组,主键 = **入职日期 × 物流仓 × 供应商**,字段含 \`入职总人数\`、\`30天留存人数\`、\`90天留存人数\`、\`30天留存率\`、\`90天留存率\`、\`明细\`(内联摘要串)、\`供给满足率\`、\`供给时效\`、\`统计周期\`、\`数据状态\`。
   - \`明细\`:数组,在主表主键基础上再下沉 **工种 × 班次 × 用工性质 × 技能等级**,字段含 \`人数\`。主表 \`入职总人数\` = 对应明细 \`人数\` 之和。
2. **采购下单.json**(取需求基线):顶层 \`切片\` 是以 \`"周期档|物流仓"\` 为 key 的**对象(不是数组)**,值为 \`{ rows, meta }\`;
   行内 \`需求量下限\` / \`需求量上限\` 即需求量桶边界(\`[0,20)\` / \`[20,100)\` / \`[100,9999)\`)。
3. **Trace.md**(履约缺口补救措施手册):口径前提、缺口严重度分级、按剩余天数分档(A~E)的措施清单与输出约束。

## 核心算法(必须严格按此步骤执行,不得跳步或自行改口径)

1. **取批次**:从 \`主表\` 中取当前筛选范围内的入职批次(入职日期 / 物流仓 / 供应商)。
2. **定供给时效**:直接读该行 \`供给时效\`(它由 \`入职总人数\` 套需求量分桶得到:0-20→7 天 / 20-100→14 天 / 100 以上→30 天,**为业务常量非实算**)。
3. **算预期供给日与剩余天数**:预期供给日 = \`入职日期\` + \`供给时效\`(天);剩余天数 = 预期供给日 − 今天(可为负,表示已逾期)。
4. **定需求基线(代理量)**:取该批次所属条件组在 采购下单.json 中的**需求量桶下限**(0 / 20 / 100)作为需求基线代理量。
5. **算缺口**:缺口 = 需求基线 − \`入职总人数\`;**缺口 ≤ 0 视为无缺口**。
6. **定严重度**(按 Trace.md 第二章):轻微(<10% 且 <5 人)/ 中等(10~30% 或 5~15 人)/ 严重(>30% 或 >15 人)。
7. **匹配档位**(按 Trace.md 第三章,按剩余天数):A >14 天 / B 8~14 天 / C 3~7 天 / D 0~2 天 / E <0 天(已逾期)。
   **只引用该批次所属档位的措施,不要把全部档位抄一遍。**

## 口径陷阱(禁止性结论,务必遵守)

- ⚠ **需求基线为「板块三需求量桶下限」的代理量,不是真实下单量**。每条涉及缺口的结论**必须显式标注该代理口径**,并说明缺口为**下界估计**。
- ⚠ \`供给满足率\` 恒为 **1.0**,是业务方指定常量、非实算。**禁止据此下「履约达标 / 无缺口」结论**——缺口必须由步骤 5 实算得出。
- ⚠ \`供给时效\` 为**按人数分桶的常量**,同桶内所有批次完全相同,**不得解读为供应商响应速度差异**。
- ⚠ 主表 \`统计周期\` 默认为**全量台账**(不随周期档筛选变化),跨期对比时须说明这一点。
- ⚠ 留存率口径为「未离职或在职天数 ≥ 30/90 天」;入职不足 30/90 天的批次留存数据不可比,须如实说明。

## 分析任务

1. **缺口识别**:列出有缺口的批次(入职日期 / 物流仓 / 供应商 / 入职总人数 / 需求基线 / 缺口 / 剩余天数 / 严重度 / 档位)。
2. **风险研判**:结合 \`明细\`(工种 × 班次 × 用工性质 × 技能等级)指出缺口集中在哪些岗位结构;结合 \`30天留存率\` / \`90天留存率\` 评估**补进来的人是否留得住**——留存率低意味着即使补齐也会二次缺口。
3. **补救建议**:严格按所属档位引用 Trace.md 措施,落到具体批次(说明追加谁、追加多少、到岗期限),并遵守 Trace.md 第四章输出约束。
4. **无缺口时**:不要强行编造风险,用一句话汇总「当前范围内各批次入职人数均达到桶下限代理基线」,可补充留存率层面的观察。

## 分析步骤
1. 读取三个文件;若触发提示词给出了**当前看板筛选范围**(周期档 / 物流仓 / 供应商 / 时间范围),**只分析该范围内的批次**,并在开头复述该范围与「今天」的日期。
2. 按上述核心算法逐批次计算,**优先输出严重度高、剩余天数少的批次**,不必穷举全部批次。
3. 建议须先过 Rule.md 的硬性约束(若工作区存在 Rule.md,如份额上限 40%、最少家数),冲突时以 Rule.md 为准。

## 输出格式

- **缺口清单**:表格或分条,含 批次标识 / 入职总人数 / 需求基线(标注代理口径)/ 缺口 / 预期供给日 / 剩余天数 / 严重度 / 档位
- **按批次给建议**:每个高优批次一节,引用其所属档位的具体措施并落地到数字
- **风险提示**:岗位结构缺口、留存率隐患、逾期批次的追责与复盘

最后用 2-3 句给出整体履约风险结论。保持简洁,聚焦决策价值,不要整段回抄原始数据。
`;

/**
 * 幂等写入 PO workspace 的履约追踪看板分析 skill(SKILL.md)。
 *
 * 目标 \`~/.openclaw/workspace-po/skills/po-fulfillment-analysis/SKILL.md\`。
 * 语义:文件已存在即保持不动(视为用户自行改写),不存在则落盘预置内容。
 */
async function ensurePresetPoFulfillmentSkillFile(): Promise<void> {
  const workspace = expandPath(`~/.openclaw/workspace-${PRESET_PO_AGENT_ID}`);
  const skillDir = join(workspace, 'skills', PRESET_PO_FULFILLMENT_SKILL_SLUG);
  const target = join(skillDir, 'SKILL.md');
  if (await fileExists(target)) {
    return;
  }
  await ensureDir(skillDir);
  await writeFile(target, PRESET_PO_FULFILLMENT_SKILL_CONTENT, 'utf8');
  logger.info('Provisioned preset PO fulfillment skill', { path: target });
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
      // PO 已存在：仍幂等确保各预置文件存在（覆盖老环境升级场景）。
      await ensurePresetPoExperienceFile();
      await ensurePresetPoRuleFile();
      await ensurePresetPoTraceFile();
      await ensurePresetPoDecisionSkillFile();
      await ensurePresetPoDashboardSkillFile();
      await ensurePresetPoRegionSkillFile();
      await ensurePresetPoFulfillmentSkillFile();
      await ensurePresetPoDecisionFile();
      await ensurePresetPoPortraitFile();
      await ensurePresetPoV6Files();
      await ensurePresetPoDiaryFile();
      return { created: false };
    }
    await createAgent(PRESET_PO_AGENT_NAME, { inheritWorkspace: true });
    await ensurePresetPoExperienceFile();
    await ensurePresetPoRuleFile();
    await ensurePresetPoTraceFile();
    await ensurePresetPoDecisionSkillFile();
    await ensurePresetPoDashboardSkillFile();
    await ensurePresetPoRegionSkillFile();
    await ensurePresetPoFulfillmentSkillFile();
    await ensurePresetPoDecisionFile();
    await ensurePresetPoPortraitFile();
    await ensurePresetPoV6Files();
    await ensurePresetPoDiaryFile();
    logger.info('Provisioned preset PO agent', { agentId: PRESET_PO_AGENT_ID });
    return { created: true };
  } catch (error) {
    // 预置失败不应阻断应用启动：记录后静默返回，用户仍可手动创建 Agent。
    logger.error('Failed to ensure preset PO agent', error);
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
