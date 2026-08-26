import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  APP_PORT,
  VIEWER_PORT,
  REMOTE_CONNECTION_PORT_RANGE,
  REMOTE_CONNECTIONS_CONFIG_PATH,
} from '../shared/constants.js';

const CONFIG_SCHEMA_VERSION = 1;
const CONNECTION_KEYS = new Set(['id', 'name', 'enabled', 'mode', 'localPort', 'ssh', 'remote']);
const SSH_KEYS = new Set(['host', 'user', 'port', 'hostAlias']);
const REMOTE_KEYS = new Set(['appPort']);
const MODES = new Set(['manual', 'managed']);
const SECRET_KEY_PATTERN = /password|private[-_]?key|passphrase/i;

export class ConnectionConfigError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConnectionConfigError';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoSecrets(value, location = '配置') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ConnectionConfigError(`禁止在远程连接配置中存储机密字段：${location}.${key}`);
    }
    assertNoSecrets(child, `${location}.${key}`);
  }
}

function assertKnownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConnectionConfigError(`远程连接配置包含未知字段：${location}.${key}`);
    }
  }
}

function assertNonBlankString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConnectionConfigError(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function assertOptionalString(value, field) {
  if (value === undefined || value === null) return null;
  return assertNonBlankString(value, field);
}

function assertPort(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConnectionConfigError(`${field} 必须是 1-65535 范围内的整数端口`);
  }
  return value;
}

function normalizeId(value) {
  const id = assertNonBlankString(value, '连接 id');
  // Keep IDs URL-safe and namespace-safe. The explicit character class also
  // rejects whitespace and Unicode punctuation that would make addressing
  // ambiguous even though they are not RFC reserved characters.
  if (id !== value || !/^[A-Za-z0-9._~-]+$/.test(id)) {
    throw new ConnectionConfigError(`连接 id 不得包含冒号或 URL 保留字符：${id}`);
  }
  return id;
}

function normalizeSsh(value, mode) {
  if (value === undefined) {
    if (mode === 'managed') {
      throw new ConnectionConfigError('managed 模式必须提供 ssh.host');
    }
    return null;
  }
  if (!isPlainObject(value)) {
    throw new ConnectionConfigError('ssh 必须是对象');
  }
  assertKnownKeys(value, SSH_KEYS, 'ssh');
  const host = value.host === undefined ? null : assertOptionalString(value.host, 'ssh.host');
  if (mode === 'managed' && !host) {
    throw new ConnectionConfigError('managed 模式必须提供 ssh.host');
  }
  const user = assertOptionalString(value.user, 'ssh.user');
  const port = value.port === undefined ? 22 : assertPort(value.port, 'ssh.port');
  const hostAlias = assertOptionalString(value.hostAlias, 'ssh.hostAlias');
  return { host, ...(user ? { user } : {}), port, hostAlias };
}

function normalizeRemote(value) {
  if (value === undefined) return { appPort: 1420 };
  if (!isPlainObject(value)) {
    throw new ConnectionConfigError('remote 必须是对象');
  }
  assertKnownKeys(value, REMOTE_KEYS, 'remote');
  const appPort = value.appPort === undefined ? 1420 : assertPort(value.appPort, 'remote.appPort');
  return { appPort };
}

function normalizeConnection(value) {
  if (!isPlainObject(value)) {
    throw new ConnectionConfigError('每条远程连接必须是对象');
  }
  assertNoSecrets(value, 'connection');
  assertKnownKeys(value, CONNECTION_KEYS, 'connection');

  const id = normalizeId(value.id);
  const name = value.name === undefined ? id : assertNonBlankString(value.name, `连接 ${id} 的 name`);
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== 'boolean') {
    throw new ConnectionConfigError(`连接 ${id} 的 enabled 必须是布尔值`);
  }
  const mode = value.mode;
  if (!MODES.has(mode)) {
    throw new ConnectionConfigError(`连接 ${id} 的 mode 只能是 manual 或 managed`);
  }
  const localPort = value.localPort;
  if (!Number.isInteger(localPort)) {
    throw new ConnectionConfigError(`连接 ${id} 的 localPort 必须是整数端口`);
  }
  const ssh = normalizeSsh(value.ssh, mode);
  const remote = normalizeRemote(value.remote);
  return { id, name, enabled, mode, localPort, ssh, remote };
}

function freezeConnection(connection) {
  if (connection.ssh) Object.freeze(connection.ssh);
  Object.freeze(connection.remote);
  return Object.freeze(connection);
}

function freezeList(connections) {
  return Object.freeze(connections.map((connection) => freezeConnection(connection)));
}

function configCorrupt(filePath, cause) {
  return new ConnectionConfigError(`远程连接配置损坏：${filePath}`, { cause });
}

export class ConnectionStore {
  constructor({
    configPath = REMOTE_CONNECTIONS_CONFIG_PATH,
    appPort = APP_PORT,
    viewerPort = VIEWER_PORT,
  } = {}) {
    this.configPath = path.resolve(configPath);
    this.appPort = assertPort(appPort, 'APP_PORT');
    this.viewerPort = assertPort(viewerPort, 'VIEWER_PORT');
    this.connections = new Map();
    this.allocatedPorts = new Set();
    this.loaded = false;
  }

  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.configPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.connections.clear();
        this.allocatedPorts.clear();
        this.loaded = true;
        return this.listConnections();
      }
      throw new ConnectionConfigError(`无法读取远程连接配置：${this.configPath}`, { cause: error });
    }

    if (raw.trim() === '') {
      this.connections.clear();
      this.allocatedPorts.clear();
      this.loaded = true;
      return this.listConnections();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw configCorrupt(this.configPath, error);
    }

    try {
      assertNoSecrets(parsed, 'config');
      if (!isPlainObject(parsed)) {
        throw new ConnectionConfigError('远程连接配置顶层必须是对象');
      }
      assertKnownKeys(parsed, new Set(['schemaVersion', 'connections']), 'config');
      if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
        throw new ConnectionConfigError(`不支持的远程连接配置 schemaVersion：${parsed.schemaVersion}`);
      }
      if (!Array.isArray(parsed.connections)) {
        throw new ConnectionConfigError('远程连接配置的 connections 必须是数组');
      }

      const next = new Map();
      for (const rawConnection of parsed.connections) {
        const connection = normalizeConnection(rawConnection);
        if (next.has(connection.id)) {
          throw new ConnectionConfigError(`远程连接 id 重复：${connection.id}`);
        }
        next.set(connection.id, connection);
      }
      this.assertPortConflicts(next);
      this.connections = next;
      this.allocatedPorts.clear();
      this.loaded = true;
      return this.listConnections();
    } catch (error) {
      if (error instanceof ConnectionConfigError) throw error;
      throw configCorrupt(this.configPath, error);
    }
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
  }

  listConnections() {
    return freezeList([...this.connections.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((connection) => ({
        ...connection,
        ssh: connection.ssh ? { ...connection.ssh } : null,
        remote: { ...connection.remote },
      })));
  }

  getConnection(id) {
    const connection = this.connections.get(id);
    if (!connection) return null;
    return freezeConnection({
      ...connection,
      ssh: connection.ssh ? { ...connection.ssh } : null,
      remote: { ...connection.remote },
    });
  }

  async upsertConnection(value) {
    await this.ensureLoaded();
    const connection = normalizeConnection(value);
    const next = new Map(this.connections);
    next.set(connection.id, connection);
    this.assertPortConflicts(next);
    await this.persistConnections(next);
    this.connections = next;
    return this.getConnection(connection.id);
  }

  async deleteConnection(id) {
    await this.ensureLoaded();
    const connection = this.connections.get(id);
    if (!connection) throw new ConnectionConfigError(`未找到远程连接：${id}`);
    const next = new Map(this.connections);
    next.delete(id);
    await this.persistConnections(next);
    this.connections = next;
    return this.getConnectionSnapshot(connection);
  }

  allocateLocalPort(id = null) {
    if (id !== null) {
      const existing = this.connections.get(id);
      if (existing) return existing.localPort;
    }
    const used = new Set([
      ...this.connections.values(),
    ].map((connection) => connection.localPort));
    for (let port = REMOTE_CONNECTION_PORT_RANGE.min; port <= REMOTE_CONNECTION_PORT_RANGE.max; port += 1) {
      if (port !== this.appPort && port !== this.viewerPort && !used.has(port) && !this.allocatedPorts.has(port)) {
        this.allocatedPorts.add(port);
        return port;
      }
    }
    throw new ConnectionConfigError('远程连接本地端口区间已耗尽');
  }

  getConnectionSnapshot(connection) {
    return freezeConnection({
      ...connection,
      ssh: connection.ssh ? { ...connection.ssh } : null,
      remote: { ...connection.remote },
    });
  }

  assertPortConflicts(connections) {
    const ports = new Map();
    for (const connection of connections.values()) {
      const { localPort } = connection;
      if (localPort < REMOTE_CONNECTION_PORT_RANGE.min || localPort > REMOTE_CONNECTION_PORT_RANGE.max) {
        throw new ConnectionConfigError(
          `连接 ${connection.id} 的 localPort 必须在 ${REMOTE_CONNECTION_PORT_RANGE.min}-${REMOTE_CONNECTION_PORT_RANGE.max} 范围内`,
        );
      }
      if (localPort === this.appPort) {
        throw new ConnectionConfigError(`连接 ${connection.id} 的 localPort 不得与 APP_PORT 冲突：${localPort}`);
      }
      if (localPort === this.viewerPort) {
        throw new ConnectionConfigError(`连接 ${connection.id} 的 localPort 不得与 VIEWER_PORT 冲突：${localPort}`);
      }
      const previous = ports.get(localPort);
      if (previous) {
        throw new ConnectionConfigError(`远程连接本地端口冲突：${previous} 与 ${connection.id} 都使用 ${localPort}`);
      }
      ports.set(localPort, connection.id);
    }
  }

  async persist() {
    return this.persistConnections(this.connections);
  }

  async persistConnections(connections) {
    const payload = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      connections: [...connections.values()]
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, this.configPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw new ConnectionConfigError(`无法写入远程连接配置：${this.configPath}`, { cause: error });
    }
  }
}

export function createConnectionStore(options = {}) {
  return new ConnectionStore(options);
}

export { REMOTE_CONNECTION_PORT_RANGE };
