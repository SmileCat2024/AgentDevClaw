import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createClawLogger } from '../shared/claw-logger.js';
import { LOCAL_OPERATION_ERROR_CODES } from '../shared/operation-contract.js';
import {
  PROJECT_ROOT,
  REMOTE_HANDSHAKE_INTERVAL_MS,
  REMOTE_HANDSHAKE_TIMEOUT_MS,
} from '../shared/constants.js';
import { originFor } from './tunnel-manager.js';

// R1-03：连接握手与健康状态机（ADR-0008 第 6、7 条）。
// 握手三步全部复用远程现有端点（远程零改动）：
//   1. GET /protoclaw/health   → 存活（隧道通但失败 = 远程 Claw 未运行）
//   2. GET /protoclaw/app_info → 版本身份（claw version + framework.version）
//   3. GET /api/agents         → Runtime 目录探测
// 连接状态由握手推导，与 tunnel 状态解耦（manual 模式同样周期握手）。

const HEALTH_PATH = '/protoclaw/health';
const APP_INFO_PATH = '/protoclaw/app_info';
const AGENTS_PATH = '/api/agents';

export const CONNECTION_HEALTH_STATES = Object.freeze([
  'configured', 'connecting', 'connected', 'disconnected', 'reconnecting', 'degraded',
]);

class HandshakeProtocolError extends Error {
  constructor(message, { step, status = null } = {}) {
    super(message);
    this.name = 'HandshakeProtocolError';
    this.step = step;
    this.status = status;
  }
}

class HandshakeTimeoutError extends Error {
  constructor(message, { step } = {}) {
    super(message);
    this.name = 'HandshakeTimeoutError';
    this.step = step;
  }
}

// 包装 fetch 抛出的外部错误，补上 step 与网络错误码，供失败分类使用。
class HandshakeRequestError extends Error {
  constructor(original, step) {
    super(`远程请求失败：${original?.message || String(original)}`, { cause: original });
    this.name = 'HandshakeRequestError';
    this.step = step;
    this.networkCode = original?.cause?.code || original?.code || null;
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正整数毫秒值`);
  }
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseVersionParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

// 版本门槛从简：仅主/次版本不一致才警告；补丁差异、缺版本均放行。
export function versionMismatch(local, remote) {
  const localParts = parseVersionParts(local);
  const remoteParts = parseVersionParts(remote);
  if (!localParts || !remoteParts) return null;
  if (localParts[0] === remoteParts[0] && localParts[1] === remoteParts[1]) return null;
  return { local: String(local), remote: String(remote) };
}

// 失败三分类（映射 Phase 0 错误契约，server/shared/operation-contract.js）：
// - 隧道/网络不可达        → transport_unavailable（retryable）→ disconnected
// - 隧道通但远程不可用     → target_not_found（远程 Claw 未启动）→ degraded
// - 握手超时               → request_timeout（retryable）→ degraded
// - health 之外的协议异常  → operation_rejected → degraded
function classifyFailure(error, { tunnelUp, timeoutMs }) {
  if (error instanceof HandshakeTimeoutError) {
    return {
      code: LOCAL_OPERATION_ERROR_CODES.REQUEST_TIMEOUT,
      retryable: true,
      state: 'degraded',
      message: `远程 ${error.step} 超过 ${timeoutMs}ms 未响应`,
      step: error.step,
    };
  }
  const networkCode = error?.networkCode || error?.cause?.code || error?.code || null;
  if (networkCode === 'ECONNREFUSED') {
    // 本地端口无人监听 = 隧道未建立（manual 模式即用户隧道未就绪）。
    return {
      code: LOCAL_OPERATION_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      retryable: true,
      state: 'disconnected',
      message: `隧道/网络不可达（${networkCode}）`,
      step: error?.step ?? null,
    };
  }
  if (networkCode) {
    return tunnelUp
      ? {
        code: LOCAL_OPERATION_ERROR_CODES.TARGET_NOT_FOUND,
        retryable: false,
        state: 'degraded',
        message: `隧道已通但远程 Claw 未启动或不可达（${networkCode}）`,
        step: error?.step ?? null,
      }
      : {
        code: LOCAL_OPERATION_ERROR_CODES.TRANSPORT_UNAVAILABLE,
        retryable: true,
        state: 'disconnected',
        message: `隧道/网络不可达（${networkCode}）`,
        step: error?.step ?? null,
      };
  }
  if (error instanceof HandshakeProtocolError) {
    return {
      code: error.step === 'health'
        ? LOCAL_OPERATION_ERROR_CODES.TARGET_NOT_FOUND
        : LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED,
      retryable: false,
      state: 'degraded',
      message: error.message,
      step: error.step,
    };
  }
  return {
    code: LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED,
    retryable: false,
    state: 'degraded',
    message: error?.message || String(error),
    step: typeof error?.step === 'string' ? error.step : null,
  };
}

function createEntry(connection) {
  return {
    connection,
    state: 'configured',
    error: null,
    appInfo: null,
    versionWarning: null,
    lastHandshakeAt: null,
    lastConnectedAt: null,
    lastFailureKey: null,
    timer: null,
    inFlight: false,
    stopped: false,
  };
}

function resetEntry(entry) {
  entry.state = 'configured';
  entry.error = null;
  entry.appInfo = null;
  entry.versionWarning = null;
  entry.lastHandshakeAt = null;
  entry.lastConnectedAt = null;
  entry.lastFailureKey = null;
}

function materiallyChanged(entry, connection) {
  const previous = entry.connection;
  return previous.mode !== connection.mode
    || previous.localPort !== connection.localPort
    || previous.baseUrl !== connection.baseUrl
    || JSON.stringify(previous.remote) !== JSON.stringify(connection.remote);
}

function statusOf(entry) {
  if (!entry) return null;
  const { id, name, mode, localPort } = entry.connection;
  return {
    id,
    name,
    mode,
    localPort,
    origin: originFor(entry.connection),
    state: entry.state,
    error: entry.error ? { ...entry.error } : null,
    // appInfo 是连接元数据（版本/名称），不是远程业务状态镜像。
    appInfo: entry.appInfo ? { ...entry.appInfo } : null,
    versionWarning: entry.versionWarning ? { ...entry.versionWarning } : null,
    lastHandshakeAt: entry.lastHandshakeAt,
    lastConnectedAt: entry.lastConnectedAt,
  };
}

export class ConnectionHealth {
  constructor({
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    tunnelManager = null,
    localAppInfo = undefined,
    intervalMs = REMOTE_HANDSHAKE_INTERVAL_MS,
    timeoutMs = REMOTE_HANDSHAKE_TIMEOUT_MS,
    logger = createClawLogger('connection-health'),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('ConnectionHealth 需要可用的 fetch 实现');
    }
    assertPositiveInt(intervalMs, 'intervalMs');
    assertPositiveInt(timeoutMs, 'timeoutMs');
    this.fetch = fetchImpl;
    this.tunnelManager = tunnelManager;
    // undefined = 惰性读本端 package.json；显式传 null 关闭版本比较。
    this.localAppInfo = localAppInfo;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.entries = new Map();
    this.started = false;
    this.localAppInfoPromise = null;
  }

  // 与 ConnectionStore 的连接列表对齐：只跟踪 enabled 连接；
  // 移除/禁用即停探测；寻址参数变化则丢弃旧状态重走完整握手。
  syncConnections(connections) {
    const next = new Map();
    for (const connection of connections || []) {
      if (!connection?.id || connection.enabled !== true) continue;
      next.set(connection.id, connection);
    }
    for (const [id, entry] of this.entries) {
      if (!next.has(id)) {
        this.clearEntryTimer(entry);
        entry.stopped = true;
        this.entries.delete(id);
      }
    }
    for (const [id, connection] of next) {
      const entry = this.entries.get(id);
      if (!entry) {
        const fresh = createEntry(connection);
        this.entries.set(id, fresh);
        this.scheduleProbe(fresh, 0);
        continue;
      }
      const changed = materiallyChanged(entry, connection);
      entry.connection = connection;
      if (changed) {
        this.clearEntryTimer(entry);
        resetEntry(entry);
        this.scheduleProbe(entry, 0);
      }
    }
    return this.listStatuses();
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const entry of this.entries.values()) {
      entry.stopped = false;
      this.scheduleProbe(entry, 0);
    }
  }

  stop() {
    this.started = false;
    for (const entry of this.entries.values()) {
      this.clearEntryTimer(entry);
    }
  }

  getStatus(id) {
    return statusOf(this.entries.get(id));
  }

  listStatuses() {
    return [...this.entries.values()].map(statusOf);
  }

  // 立即执行一次完整三步握手（周期循环与手动触发共用）；
  // 恢复路径不信任旧结果，disconnected/degraded 一律重走三步。
  async runHandshake(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.inFlight) return this.getStatus(id);
    await this.probeEntry(entry);
    return this.getStatus(id);
  }

  scheduleProbe(entry, delayMs) {
    if (entry.stopped || !this.started || entry.timer) return;
    entry.timer = this.setTimeout(() => {
      entry.timer = null;
      this.probeLoop(entry);
    }, delayMs);
    entry.timer.unref?.();
  }

  clearEntryTimer(entry) {
    if (entry.timer) {
      this.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  async probeLoop(entry) {
    if (entry.stopped || !this.started) return;
    if (entry.inFlight) {
      this.scheduleProbe(entry, this.intervalMs);
      return;
    }
    await this.probeEntry(entry);
    if (!entry.stopped && this.started) this.scheduleProbe(entry, this.intervalMs);
  }

  async probeEntry(entry) {
    entry.inFlight = true;
    try {
      await this.performHandshake(entry);
    } catch (error) {
      const failure = classifyFailure(error, {
        tunnelUp: this.isTunnelUp(entry),
        timeoutMs: this.timeoutMs,
      });
      entry.error = {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        ...(failure.step ? { step: failure.step } : {}),
      };
      entry.lastHandshakeAt = new Date().toISOString();
      this.transition(entry, failure.state);
    } finally {
      entry.inFlight = false;
    }
  }

  async performHandshake(entry) {
    const previous = entry.state;
    if (previous === 'configured') this.transition(entry, 'connecting');
    else if (previous === 'disconnected') this.transition(entry, 'reconnecting');

    const health = await this.requestJson(entry, HEALTH_PATH, 'health');
    if (health?.ok !== true) {
      throw new HandshakeProtocolError('远程 health 未确认存活', { step: 'health' });
    }
    // 传输已证实可用：reconnecting → connecting，继续完成剩余握手。
    if (entry.state === 'reconnecting') this.transition(entry, 'connecting');

    const appInfo = await this.requestJson(entry, APP_INFO_PATH, 'app_info');
    if (appInfo?.ok !== true) {
      throw new HandshakeProtocolError('远程 app_info 响应异常', { step: 'app_info' });
    }

    const agents = await this.requestJson(entry, AGENTS_PATH, 'agents');
    if (!Array.isArray(agents?.agents)) {
      throw new HandshakeProtocolError('远程 agents 目录响应异常', { step: 'agents' });
    }

    const checkedAt = new Date().toISOString();
    const remoteAppInfo = {
      name: typeof appInfo.name === 'string' ? appInfo.name : null,
      clawVersion: typeof appInfo.version === 'string' ? appInfo.version : null,
      frameworkVersion: typeof appInfo.framework?.version === 'string' ? appInfo.framework.version : null,
      // 写能力门控（ADR-0011）：旧远程无 capabilities 字段视为不可写；
      // 每次握手重算，断线重连后随握手刷新。
      capabilities: { write: appInfo?.capabilities?.write === true },
      checkedAt,
    };

    const local = await this.ensureLocalAppInfo();
    const clawMismatch = versionMismatch(local?.clawVersion, remoteAppInfo.clawVersion);
    const frameworkMismatch = versionMismatch(local?.frameworkVersion, remoteAppInfo.frameworkVersion);
    const previousWarning = entry.versionWarning ? JSON.stringify(entry.versionWarning) : null;
    const versionWarning = (clawMismatch || frameworkMismatch)
      ? {
        message: '远程 Claw 与本地主/次版本不一致（连接保持可用）',
        ...(clawMismatch ? { claw: clawMismatch } : {}),
        ...(frameworkMismatch ? { framework: frameworkMismatch } : {}),
      }
      : null;

    entry.appInfo = remoteAppInfo;
    entry.versionWarning = versionWarning;
    entry.error = null;
    entry.lastFailureKey = null;
    entry.lastHandshakeAt = checkedAt;
    entry.lastConnectedAt = checkedAt;
    this.transition(entry, 'connected');
    if (versionWarning && JSON.stringify(versionWarning) !== previousWarning) {
      this.logger.warn(`远程连接 ${entry.connection.id} 版本警告：${versionWarning.message}`, {
        claw: versionMismatchDetail(versionWarning.claw),
        framework: versionMismatchDetail(versionWarning.framework),
      });
    }
  }

  async requestJson(entry, pathname, step) {
    const url = `${originFor(entry.connection)}${pathname}`;
    const controller = new AbortController();
    const timer = this.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response?.ok) {
        throw new HandshakeProtocolError(`远程 ${step} 返回 HTTP ${response?.status}`, {
          step,
          status: response?.status ?? null,
        });
      }
      try {
        return await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new HandshakeProtocolError(`远程 ${step} 返回了无法解析的响应体`, { step });
      }
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof HandshakeProtocolError)) {
        throw new HandshakeTimeoutError(`远程 ${step} 超过 ${this.timeoutMs}ms 未响应`, { step });
      }
      if (error instanceof HandshakeProtocolError) throw error;
      throw new HandshakeRequestError(error, step);
    } finally {
      this.clearTimeout(timer);
    }
  }

  // 状态由握手推导；tunnel 状态只用于细分“传输不通”与“对端未启动”。
  // manual 模式隧道用户自备，非 ECONNREFUSED 的网络错误视为“端口有应答”；
  // url 直连没有本地端口，任何网络错误都意味着远程地址本身不可达。
  isTunnelUp(entry) {
    if (entry.connection.mode === 'url') return false;
    if (entry.connection.mode !== 'managed') return true;
    const status = this.tunnelManager?.getStatus?.(entry.connection.id);
    return status ? status.tunnel === 'up' : true;
  }

  async ensureLocalAppInfo() {
    if (this.localAppInfo !== undefined) return this.localAppInfo;
    if (!this.localAppInfoPromise) {
      this.localAppInfoPromise = (async () => {
        const [clawPkg, corePkg] = await Promise.all([
          readJsonFile(path.join(PROJECT_ROOT, 'package.json')),
          readJsonFile(path.join(PROJECT_ROOT, 'node_modules', '@agentdevjs', 'core', 'package.json')),
        ]);
        return {
          clawVersion: typeof clawPkg?.version === 'string' ? clawPkg.version : null,
          frameworkVersion: typeof corePkg?.version === 'string' ? corePkg.version : null,
        };
      })();
    }
    return this.localAppInfoPromise;
  }

  transition(entry, next) {
    const previous = entry.state;
    if (previous === next) return;
    entry.state = next;
    const id = entry.connection.id;
    if (next === 'connected') {
      this.logger.info(`远程连接 ${id} 已连接`, { from: previous });
      return;
    }
    if (next === 'connecting' || next === 'reconnecting') {
      this.logger.debug(`远程连接 ${id} 进入 ${next === 'connecting' ? '握手' : '重连握手'}`, { from: previous });
      return;
    }
    // disconnected / degraded：同一失败反复出现时降为 debug，避免周期性刷屏。
    const failureKey = `${next}:${entry.error?.code ?? 'unknown'}`;
    if (entry.lastFailureKey === failureKey) {
      this.logger.debug(`远程连接 ${id} 保持 ${next}`, { code: entry.error?.code });
    } else {
      this.logger.warn(`远程连接 ${id} ${next === 'disconnected' ? '已断开' : '降级'}`, {
        from: previous,
        code: entry.error?.code,
        message: entry.error?.message,
      });
      entry.lastFailureKey = failureKey;
    }
  }
}

function versionMismatchDetail(mismatch) {
  return mismatch ? `${mismatch.local} ↔ ${mismatch.remote}` : null;
}

export function createConnectionHealth(options = {}) {
  return new ConnectionHealth(options);
}
