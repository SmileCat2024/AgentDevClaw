import { createClawLogger } from '../shared/claw-logger.js';
import { LOCAL_OPERATION_ERROR_CODES } from '../shared/operation-contract.js';
import { REMOTE_HANDSHAKE_TIMEOUT_MS } from '../shared/constants.js';
import { REMOTE_NAMESPACE_PREFIX } from '../shared/request-target.js';
import { originFor } from './tunnel-manager.js';

// R1-05：远程工作空间目录聚合（ADR-0008 第 4、8 条）。
// 对象模型对齐本地"左侧叶子条目 = 运行中会话"的既有心智：
//   - 叶子条目 = 远程 Claw 中每个存活 child runtime（get_connected_agents 的
//     source==='child' 且 status==='running' 条目）。该条目自带运行中会话的完整
//     身份：open_directory（会话工作目录）、active_workspace_session_id（会话 ID）、
//     sessionType、显示名——不再拉取 prebuilt / workspace_sessions 历史索引，避免
//     把"全部历史会话"伪装成可进入的条目。
//   - 分组 = 工作空间目录：按 open_directory 完整路径分组（groupKey 含完整目录，
//     防同名叶目录跨分组串组；displayName 仍为叶名）。无目录的 runtime 不生成
//     项目组标题，直接作为对应 workspace 下的会话叶子，不暴露宿主 agent id。
//   - Agent 只是叶子条目的归属元数据（agentId 字段），不作为可点击条目渲染。
//   - 寻址：叶子条目的 id / runtimeId 即命名空间化的 viewer runtime ID，点击直接
//     以它寻址远程 viewer（远程只认 runtime ID，不认逻辑 ID）。
// 对每条 enabled 连接：
//   - 健康状态非 connected（disconnected/degraded/configured/...）→ 保留连接身份与
//     状态、workspaces 为空、不发起任何拉取——不删除分组、不伪装正常；"最后已知
//     身份"由前端渲染层持有（本地零业务状态镜像，ADR-0008 第 2 条）。
//   - connected → 经其 origin 拉取 get_connected_agents（主源）；该端点不可用时以
//     /api/agents 的在线 runtime 兜底（无目录信息 → 直属会话）。
// 远程返回的 ID 一律加 remote:<connId>: 前缀（复用 REMOTE_NAMESPACE_PREFIX）后再
// 返回，前端只处理不透明 ID。不缓存：每次聚合都透传拉取远程真值。每连接独立超时，
// 一条连接挂起不阻塞整体响应（该连接降级返回）。

const CONNECTED_AGENTS_PATH = '/protoclaw/get_connected_agents';
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
// 同时匹配正斜杠与反斜杠——远程 Windows 盘符路径（D:\code\project）同样适用。
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

// 归并目录源：connected（get_connected_agents）提供运行中会话条目（主源）；
// viewer（/api/agents 在线 runtime）在 connected 不可用时兜底（无目录信息）。
// 两者都不提供可用的运行中 runtime 时返回空——不伪造条目。prebuilt 历史会话索引
// 不进入目录（叶子必须是当前可进入的运行中会话）。
function resolveSidebarEntryId(raw, parentId, sessionType) {
  const explicit = cleanText(raw?.sidebar_entry_id) || cleanText(raw?.sidebarEntryId);
  if (explicit) return explicit;
  const owner = cleanText(parentId);
  if (!owner) return '';
  return sessionType === 'main' ? owner : `${owner}:${sessionType}`;
}

function collectRuntimes({ connected, viewer }) {
  const runtimes = new Map();

  const upsert = (id, record) => {
    const runtimeId = cleanText(id);
    if (!runtimeId) return;
    const previous = runtimes.get(runtimeId) || {};
    runtimes.set(runtimeId, { ...previous, ...record });
  };

  for (const raw of connected || []) {
    if (!raw || typeof raw !== 'object' || raw.source !== 'child') continue;
    // 只取存活 runtime：死掉的 child（status 非 running / connected=false）不应以
    // "运行中会话"的身份占住侧栏条目。
    const alive = raw.status === 'running' || raw.connected === true;
    if (!alive) continue;
    const parentId = cleanText(raw.parent_id) || cleanText(raw.parentId);
    const sessionType = cleanText(raw.sessionType) || 'main';
    upsert(raw.runtime_session_id || raw.id, {
      id: cleanText(raw.runtime_session_id) || cleanText(raw.id),
      agentId: parentId,
      sidebarEntryId: resolveSidebarEntryId(raw, parentId, sessionType),
      sidebarEntryName: cleanText(raw.sidebar_entry_name) || cleanText(raw.sidebarEntryName),
      sidebarEntryGroup: cleanText(raw.sidebar_entry_group) || cleanText(raw.sidebarEntryGroup),
      name: cleanText(raw.name) || cleanText(raw.active_workspace_session_title)
        || cleanText(raw.active_workspace_display_name) || cleanText(raw.id),
      workspaceName: cleanText(raw.active_workspace_display_name)
        || cleanText(raw.active_workspace_agent_name) || cleanText(raw.name),
      sessionType,
      openDirectory: cleanText(raw.open_directory) || cleanText(raw.openDirectory) || '',
      sessionId: cleanText(raw.active_workspace_session_id) || cleanText(raw.activeWorkspaceSessionId) || '',
      sessionTitle: cleanText(raw.active_workspace_session_title) || '',
      updatedAt: cleanText(raw.updated_at) || cleanText(raw.updatedAt) || '',
      messageCount: Number.isFinite(raw.message_count) ? raw.message_count : null,
      connected: raw.connected !== false,
    });
  }

  if (viewer && Array.isArray(viewer.agents)) {
    for (const raw of viewer.agents) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.connected !== true) continue;
      const runtimeId = cleanText(raw.id);
      if (!runtimeId || runtimes.has(runtimeId)) continue;
      const parentId = cleanText(raw.parentAgentId);
      const sessionType = cleanText(raw.sessionType) || 'main';
      upsert(runtimeId, {
        id: runtimeId,
        agentId: parentId,
        name: cleanText(raw.name),
        workspaceName: cleanText(raw.name),
        sessionType,
        openDirectory: '',
        sessionId: '',
        sessionTitle: '',
        updatedAt: '',
        messageCount: null,
        connected: true,
        sidebarEntryId: resolveSidebarEntryId(raw, parentId, sessionType),
      });
    }
  }

  return runtimes;
}

function buildRuntimeEntry(connectionId, runtime) {
  const namespacedRuntimeId = namespaceId(connectionId, runtime.id);
  return {
    id: namespacedRuntimeId,
    agentId: runtime.agentId ? namespaceId(connectionId, runtime.agentId) : undefined,
    kind: 'runtime',
    name: runtime.name || runtime.id,
    sessionType: runtime.sessionType,
    runtimeId: namespacedRuntimeId,
    openDirectory: runtime.openDirectory,
    ...(runtime.sessionId ? { sessionId: namespaceId(connectionId, runtime.sessionId) } : {}),
    ...(runtime.sessionTitle ? { sessionTitle: runtime.sessionTitle } : {}),
    ...(runtime.updatedAt ? { updatedAt: runtime.updatedAt } : {}),
    ...(runtime.messageCount !== null ? { messageCount: runtime.messageCount } : {}),
    ...(runtime.sidebarEntryId ? { sidebarEntryId: runtime.sidebarEntryId } : {}),
    ...(runtime.sidebarEntryName ? { sidebarEntryName: runtime.sidebarEntryName } : {}),
    ...(runtime.sidebarEntryGroup ? { sidebarEntryGroup: runtime.sidebarEntryGroup } : {}),
    ...(runtime.sidebarEntryIcon ? { sidebarEntryIcon: runtime.sidebarEntryIcon } : {}),
    ...(runtime.workspaceName ? { workspaceName: runtime.workspaceName } : {}),
  };
}

// 分组规则：叶子（运行中会话 runtime）按 openDirectory 完整路径分组；displayName
// 取叶段。无目录的 runtime 保持为直属会话，不生成伪项目组。
// groupKey 用完整目录身份（remote:<connId>:<agentId>:<encoded-dir>）防同名叶目录
// 跨 agent / 跨连接串组；目录名本身不参与路由寻址，仅作分组键。
function composeWorkspaces(connectionId, connectionName, sources) {
  const runtimes = collectRuntimes(sources);
  const groups = new Map();

  const groupOf = (identity, displayName, projectDir = '') => {
    let group = groups.get(identity);
    if (!group) {
      group = { identity, displayName, projectDir, entries: new Map() };
      groups.set(identity, group);
    }
    return group;
  };
  const encodeDirKey = (dir) => {
    try { return encodeURIComponent(dir); } catch { return 'dir'; }
  };

  for (const runtime of runtimes.values()) {
    const entry = buildRuntimeEntry(connectionId, runtime);
    const dir = runtime.openDirectory;
    if (dir) {
      const identity = namespaceId(connectionId, `${runtime.agentId || runtime.id}:${encodeDirKey(dir)}`);
      groupOf(identity, directoryLeaf(dir), dir).entries.set(entry.id, entry);
    } else {
      const fallbackName = runtime.workspaceName || runtime.name || '未命名工作空间';
      const identity = namespaceId(connectionId, `no-dir:${encodeDirKey(runtime.agentId || runtime.id)}:${encodeDirKey(fallbackName)}`);
      groupOf(identity, fallbackName, '').entries.set(entry.id, entry);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      groupKey: group.identity,
      // 连接是传输元数据，不是用户可见的侧栏层级；主机名保留在
      // 远程目录项目组标签中，用于区分同名目录，但不单独占一层。
      displayName: group.projectDir ? `${connectionName}：${group.displayName}` : '',
      // 无目录 runtime 没有项目层，直接作为 workspace 下的会话叶子。
      projectName: group.projectDir ? `${connectionName}：${group.displayName}` : '',
      projectDir: group.projectDir || '',
      entries: [...group.entries.values()].sort(compareEntries),
    }))
    .sort((left, right) => left.projectName.localeCompare(right.projectName));
}

// 排序确定性：会话按更新时间倒序（对齐本地 recency 心智），平局以 id 兜底，
// 保证跨轮询顺序稳定。
function compareEntries(left, right) {
  const updatedDiff = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  if (updatedDiff !== 0) return updatedDiff;
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
      viewer: sources.viewer && Array.isArray(sources.viewer.agents) ? sources.viewer : null,
    };
    const failed = sources.errors.map((error) => error.message).join('；');
    if (!usable.connected && !usable.viewer) {
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

  // 每连接独立超时：两个端点共享一个 AbortController，超时即整体放弃该连接的
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
      const [connected, viewer] = await Promise.all([
        readTolerant(CONNECTED_AGENTS_PATH),
        readTolerant(VIEWER_AGENTS_PATH),
      ]);
      return { connected, viewer, errors };
    } finally {
      this.clearTimeout(timer);
    }
  }
}

export function createCatalogAggregator(options = {}) {
  return new CatalogAggregator(options);
}
