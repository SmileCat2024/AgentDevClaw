import { createClawLogger } from '../shared/claw-logger.js';
import { LOCAL_OPERATION_ERROR_CODES } from '../shared/operation-contract.js';
import { REMOTE_HANDSHAKE_TIMEOUT_MS } from '../shared/constants.js';
import { REMOTE_NAMESPACE_PREFIX } from '../shared/request-target.js';
import { originFor } from './tunnel-manager.js';

// R1-05：远程工作空间目录聚合（ADR-0008 第 4、8 条）。
// 对每条 enabled 连接：
//   - 健康状态非 connected（disconnected/degraded/configured/...）→ 保留连接身份与
//     状态、workspaces 为空、不发起任何拉取——不删除分组、不伪装正常；"最后已知
//     身份"由前端渲染层持有（本地零业务状态镜像，ADR-0008 第 2 条）。
//   - connected → 经其 origin 并行拉取远程现有目录端点组合：get_connected_agents、
//     get_prebuilt_agents、/api/agents，以远程实际返回为准组合（部分端点失败时用
//     其余返回继续组合，全部失败才降级）。prebuilt_sessions 的会话明细已内嵌于前
//     两者响应的 workspace_sessions，按 agent 逐个拉取属于会话详情面，不进入目录
//     轮询路径（聚合节奏对齐 sidebar 轮询量级）。
// 远程返回的 agent/session ID 一律加 remote:<connId>: 前缀（复用
// REMOTE_NAMESPACE_PREFIX）后再返回，前端只处理不透明 ID。不缓存：每次聚合都透传
// 拉取远程真值。每连接独立超时，一条连接挂起不阻塞整体响应（该连接降级返回）。

const CONNECTED_AGENTS_PATH = '/protoclaw/get_connected_agents';
const PREBUILT_AGENTS_PATH = '/protoclaw/get_prebuilt_agents';
const VIEWER_AGENTS_PATH = '/api/agents';

class CatalogTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogTimeoutError';
  }
}

class CatalogRequestError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CatalogRequestError';
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正整数毫秒值`);
  }
}

function namespaceId(connectionId, id) {
  return `${REMOTE_NAMESPACE_PREFIX}${connectionId}:${id}`;
}

// 与前端 project-data.js 的 getPathLeaf 同语义：取目录路径最后一段作为项目名。
function directoryLeaf(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : text;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function classifyCatalogFailure(error, timeoutMs) {
  if (error instanceof CatalogTimeoutError) {
    return {
      code: LOCAL_OPERATION_ERROR_CODES.REQUEST_TIMEOUT,
      retryable: true,
      message: `远程目录聚合超过 ${timeoutMs}ms 未响应`,
    };
  }
  return {
    code: LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED,
    retryable: false,
    message: error?.message || String(error),
  };
}

// 以 agent 为单位归并目录源：prebuilt 提供元数据（icon/ui/launchMode...），
// connected 覆盖运行态字段（status/workspace_sessions）。两者都不可用时才以
// ViewerWorker runtime 目录成组（降级组合，无目录信息）。
function collectAgents({ connected, prebuilt, viewer }) {
  const agents = new Map();
  const upsert = (id, record) => {
    const agentId = cleanText(id);
    if (!agentId) return;
    const previous = agents.get(agentId) || {};
    // 会话列表取非空者：某端点返回缺字段时不把另一来源的会话清空。
    const sessions = record.sessions.length > 0 ? record.sessions : (previous.sessions || []);
    agents.set(agentId, { ...previous, ...record, sessions });
  };

  // 运行时身份贯通：connected 源的 child 条目携带宿主→viewer 运行时映射
  // （parent_id → runtime_session_id）。Phase 1 只读视图据此寻址远程 runtime
  // 数据端点——远程 viewer 只认运行时 ID，不认逻辑 ID。同宿主多运行时
  // （main/coder）优先 main。
  const runtimeByParent = new Map();
  for (const raw of connected || []) {
    if (!raw || typeof raw !== 'object' || raw.source !== 'child') continue;
    const parentId = cleanText(raw.parent_id) || cleanText(raw.parentId);
    const childRuntimeId = cleanText(raw.runtime_session_id) || cleanText(raw.id);
    if (!parentId || !childRuntimeId) continue;
    const previous = runtimeByParent.get(parentId);
    if (!previous || cleanText(raw.sessionType) === 'main') {
      runtimeByParent.set(parentId, childRuntimeId);
    }
  }

  for (const raw of prebuilt || []) {
    if (!raw || typeof raw !== 'object') continue;
    upsert(raw.id, {
      id: cleanText(raw.id),
      name: cleanText(raw.name),
      description: cleanText(raw.description),
      icon: cleanText(raw.icon) || null,
      launchMode: cleanText(raw.launchMode) || null,
      status: null,
      sessions: Array.isArray(raw.workspace_sessions?.sessions) ? raw.workspace_sessions.sessions : [],
    });
  }
  for (const raw of connected || []) {
    // child/external/投影条目是运行态投影而非工作空间宿主，会话身份已由宿主的
    // workspace_sessions 覆盖，不重复成条目（其运行时身份已在上面并入宿主）。
    if (!raw || typeof raw !== 'object' || (raw.source && raw.source !== 'prebuilt')) continue;
    upsert(raw.id, {
      id: cleanText(raw.id),
      name: cleanText(raw.name),
      status: raw.status === 'running' ? 'running' : 'stopped',
      sessions: Array.isArray(raw.workspace_sessions?.sessions) ? raw.workspace_sessions.sessions : [],
    });
  }
  for (const [parentId, childRuntimeId] of runtimeByParent) {
    const host = agents.get(parentId);
    if (host && !host.runtimeId) host.runtimeId = childRuntimeId;
  }
  if (agents.size === 0 && viewer && Array.isArray(viewer.agents)) {
    for (const raw of viewer.agents) {
      if (!raw || typeof raw !== 'object') continue;
      upsert(raw.id, {
        id: cleanText(raw.id),
        name: cleanText(raw.name),
        status: raw.connected === true ? 'running' : 'stopped',
        sessions: [],
      });
    }
  }
  return agents;
}

function buildAgentEntry(connectionId, agent) {
  const namespaced = namespaceId(connectionId, agent.id);
  return {
    id: namespaced,
    agentId: namespaced,
    kind: 'agent',
    name: agent.name || agent.id,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.icon ? { icon: agent.icon } : {}),
    ...(agent.launchMode ? { launchMode: agent.launchMode } : {}),
    ...(agent.status ? { status: agent.status } : {}),
    // 命名空间化的运行时引用：前端以逻辑 ID 定位条目，运行时数据请求改用此值。
    ...(agent.runtimeId ? { runtimeId: namespaceId(connectionId, agent.runtimeId) } : {}),
  };
}

function buildSessionEntry(connectionId, agentId, session) {
  const sessionId = cleanText(session?.id);
  if (!sessionId) return null;
  const title = cleanText(session.title);
  return {
    id: namespaceId(connectionId, sessionId),
    agentId: namespaceId(connectionId, agentId),
    kind: 'session',
    name: title || sessionId,
    sessionType: cleanText(session.sessionType) || 'main',
    ...(title ? { title } : {}),
    ...(cleanText(session.updatedAt) ? { updatedAt: cleanText(session.updatedAt) } : {}),
    ...(typeof session.archived === 'boolean' ? { archived: session.archived } : {}),
    ...(typeof session.messageCount === 'number' ? { messageCount: session.messageCount } : {}),
  };
}

// 分组规则：目录会话按 openDirectory 叶段分组；宿主 agent 条目归入其每个目录组。
// 没有目录会话的 agent（qqbot/work-group 等）自身即工作空间，以 agentId 为分组名
// 回退——与本地"工作空间通常代表一个 Agent"的心智一致。
function composeWorkspaces(connectionId, connectionName, sources) {
  const agents = collectAgents(sources);
  const groups = new Map();
  const groupOf = (projectName) => {
    let group = groups.get(projectName);
    if (!group) {
      group = { projectName, entries: new Map() };
      groups.set(projectName, group);
    }
    return group;
  };

  for (const agent of agents.values()) {
    const sessionsById = new Map();
    for (const session of agent.sessions || []) {
      const sessionId = cleanText(session?.id);
      if (sessionId) sessionsById.set(sessionId, session);
    }

    const agentEntry = buildAgentEntry(connectionId, agent);
    const directoryGroups = new Set();
    for (const session of sessionsById.values()) {
      const leaf = directoryLeaf(session.openDirectory);
      if (!leaf) continue;
      const entry = buildSessionEntry(connectionId, agent.id, session);
      if (entry) groupOf(leaf).entries.set(entry.id, entry);
      directoryGroups.add(leaf);
    }

    if (directoryGroups.size === 0) {
      const fallback = groupOf(agent.id);
      fallback.entries.set(agentEntry.id, agentEntry);
      for (const session of sessionsById.values()) {
        if (directoryLeaf(session.openDirectory)) continue;
        const entry = buildSessionEntry(connectionId, agent.id, session);
        if (entry) fallback.entries.set(entry.id, entry);
      }
    } else {
      for (const leaf of directoryGroups) {
        groupOf(leaf).entries.set(agentEntry.id, agentEntry);
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      groupKey: namespaceId(connectionId, group.projectName),
      displayName: `${connectionName}：${group.projectName}`,
      projectName: group.projectName,
      entries: [...group.entries.values()].sort(compareEntries),
    }))
    .sort((left, right) => left.projectName.localeCompare(right.projectName));
}

// 排序确定性：agent 条目在前，会话按更新时间倒序（对齐本地 recency 心智），
// 平局以 id 兜底，保证跨轮询顺序稳定。
function compareEntries(left, right) {
  if (left.kind !== right.kind) return left.kind === 'agent' ? -1 : 1;
  if (left.kind === 'session') {
    const updatedDiff = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    if (updatedDiff !== 0) return updatedDiff;
  }
  return String(left.id).localeCompare(String(right.id));
}

export class CatalogAggregator {
  constructor({
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    listConnections = null,
    getStatus = null,
    timeoutMs = REMOTE_HANDSHAKE_TIMEOUT_MS,
    logger = createClawLogger('remote-catalog'),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('CatalogAggregator 需要可用的 fetch 实现');
    }
    if (typeof listConnections !== 'function') {
      throw new TypeError('CatalogAggregator 需要注入连接列表函数 listConnections');
    }
    if (typeof getStatus !== 'function') {
      throw new TypeError('CatalogAggregator 需要注入健康状态函数 getStatus');
    }
    assertPositiveInt(timeoutMs, 'timeoutMs');
    this.fetch = fetchImpl;
    this.listConnections = listConnections;
    this.getStatus = getStatus;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
  }

  // 每次调用都透传拉取远程真值，不缓存任何目录数据。
  async aggregate() {
    const connections = (await this.listConnections()) || [];
    const enabled = (Array.isArray(connections) ? connections : [])
      .filter((connection) => connection?.id && connection.enabled === true);
    const sections = await Promise.all(enabled.map((connection) => this.buildConnectionSection(connection)));
    return { connections: sections };
  }

  async buildConnectionSection(connection) {
    const section = {
      connectionId: connection.id,
      name: connection.name,
      status: 'configured',
      workspaces: [],
    };
    const health = this.getStatus(connection.id);
    const state = cleanText(health?.state) || 'configured';
    section.status = state;
    if (state !== 'connected') {
      // 断开/降级：保留连接身份与状态，不拉取、不伪造数据；分组身份由前端持有。
      if (health?.error && typeof health.error === 'object') {
        section.error = { ...health.error };
      }
      return section;
    }

    let sources;
    try {
      sources = await this.fetchConnectionSources(connection);
    } catch (error) {
      // 整体超时/失败：该连接降级返回，不阻塞其他连接。
      this.logger.warn(`远程连接 ${connection.id} 目录聚合失败`, {
        message: error?.message,
      });
      return {
        ...section,
        status: 'degraded',
        error: classifyCatalogFailure(error, this.timeoutMs),
      };
    }

    const usable = {
      connected: Array.isArray(sources.connected) ? sources.connected : null,
      prebuilt: Array.isArray(sources.prebuilt) ? sources.prebuilt : null,
      viewer: sources.viewer && Array.isArray(sources.viewer.agents) ? sources.viewer : null,
    };
    const failed = sources.errors.map((error) => error.message).join('；');
    if (!usable.connected && !usable.prebuilt && !usable.viewer) {
      this.logger.warn(`远程连接 ${connection.id} 目录端点均未返回可用数据`, { failed });
      return {
        ...section,
        status: 'degraded',
        error: {
          code: LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED,
          retryable: false,
          message: `远程目录端点均未返回可用数据：${failed}`,
        },
      };
    }
    if (failed) {
      // 部分端点失败：以远程实际返回继续组合，不降级整条连接。
      this.logger.debug(`远程连接 ${connection.id} 部分目录端点失败，按其余返回组合`, { failed });
    }
    return {
      ...section,
      workspaces: composeWorkspaces(connection.id, connection.name, usable),
    };
  }

  // 每连接独立超时：三个端点共享一个 AbortController，超时即整体放弃该连接的
  // 本轮目录拉取（Promise.all 随首个超时拒绝立即返回，不等待其余挂起请求）。
  async fetchConnectionSources(connection) {
    const controller = new AbortController();
    const timer = this.setTimeout(() => controller.abort(), this.timeoutMs);
    const errors = [];

    const read = async (pathname) => {
      try {
        const response = await this.fetch(`${originFor(connection)}${pathname}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response?.ok) {
          throw new CatalogRequestError(`远程 ${pathname} 返回 HTTP ${response?.status}`);
        }
        try {
          return await response.json();
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw new CatalogRequestError(`远程 ${pathname} 返回了无法解析的响应体`, { cause: error });
        }
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof CatalogRequestError)) {
          throw new CatalogTimeoutError(`远程 ${pathname} 超过 ${this.timeoutMs}ms 未响应`);
        }
        if (error instanceof CatalogRequestError || error instanceof CatalogTimeoutError) throw error;
        throw new CatalogRequestError(`远程 ${pathname} 请求失败：${error?.message || String(error)}`);
      }
    };

    const readTolerant = async (pathname) => {
      try {
        return await read(pathname);
      } catch (error) {
        if (error instanceof CatalogTimeoutError) throw error;
        errors.push(error);
        return null;
      }
    };

    try {
      const [connected, prebuilt, viewer] = await Promise.all([
        readTolerant(CONNECTED_AGENTS_PATH),
        readTolerant(PREBUILT_AGENTS_PATH),
        readTolerant(VIEWER_AGENTS_PATH),
      ]);
      return { connected, prebuilt, viewer, errors };
    } finally {
      this.clearTimeout(timer);
    }
  }
}

export function createCatalogAggregator(options = {}) {
  return new CatalogAggregator(options);
}
