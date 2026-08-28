import { spawn as defaultSpawn } from 'node:child_process';

import {
  PROCESS_EXIT_WAIT_MS,
  TUNNEL_RECONNECT_INITIAL_MS,
  TUNNEL_RECONNECT_MAX_MS,
  TUNNEL_STDERR_TAIL_LINES,
} from '../shared/constants.js';

const TUNNEL_STATES = new Set(['up', 'down', 'starting', 'stopped']);

function originFor(connection) {
  if (connection.mode === 'url') return connection.baseUrl;
  return `http://127.0.0.1:${connection.localPort}`;
}

function sshTarget(ssh) {
  return ssh.hostAlias || (ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host);
}

function buildSshArgs(connection, batchMode) {
  const { localPort } = connection;
  const ssh = connection.ssh;
  const args = [
    '-N',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${connection.remote?.appPort ?? 1420}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (batchMode) args.push('-o', 'BatchMode=yes');
  if (ssh.port !== 22) args.push('-p', String(ssh.port));
  args.push(sshTarget(ssh));
  return args;
}

function isRunning(child) {
  return child?.exitCode === null && !child?.signalCode;
}

function appendStderr(runtime, chunk, maxLines, flush = false) {
  runtime.stderrBuffer += String(chunk);
  const parts = runtime.stderrBuffer.split(/\r?\n/);
  runtime.stderrBuffer = flush ? '' : (parts.pop() || '');
  const lines = parts.map((line) => line.trim()).filter(Boolean);
  runtime.stderrTail.push(...lines);
  if (runtime.stderrTail.length > maxLines) {
    runtime.stderrTail.splice(0, runtime.stderrTail.length - maxLines);
  }
}

function statusOf(runtime) {
  if (!runtime) return null;
  return {
    id: runtime.connection.id,
    tunnel: runtime.tunnel,
    origin: originFor(runtime.connection),
    pid: isRunning(runtime.child) ? runtime.child.pid ?? null : null,
    startedAt: runtime.startedAt,
    exitCode: runtime.exitCode,
    signalCode: runtime.signalCode,
    stderrTail: [...runtime.stderrTail],
    reconnectDelayMs: runtime.reconnectDelayMs,
  };
}

export class TunnelManager {
  constructor({
    spawn = defaultSpawn,
    batchMode = false,
    exitWaitMs = PROCESS_EXIT_WAIT_MS,
    reconnectInitialMs = TUNNEL_RECONNECT_INITIAL_MS,
    reconnectMaxMs = TUNNEL_RECONNECT_MAX_MS,
    stderrTailLines = TUNNEL_STDERR_TAIL_LINES,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    this.spawn = spawn;
    this.batchMode = batchMode;
    this.exitWaitMs = exitWaitMs;
    this.reconnectInitialMs = reconnectInitialMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.stderrTailLines = stderrTailLines;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.runtimes = new Map();
  }

  async startConnection(connection) {
    await this.stopConnection(connection.id, { remove: true });
    const runtime = {
      connection,
      child: null,
      tunnel: 'starting',
      stopped: false,
      startedAt: null,
      exitCode: null,
      signalCode: null,
      stderrTail: [],
      stderrBuffer: '',
      reconnectAttempt: 0,
      reconnectTimer: null,
      reconnectDelayMs: null,
    };
    this.runtimes.set(connection.id, runtime);
    if (connection.enabled !== true) {
      runtime.tunnel = 'stopped';
      runtime.stopped = true;
      return statusOf(runtime);
    }
    if (connection.mode === 'manual') {
      runtime.tunnel = 'down';
      return statusOf(runtime);
    }
    if (connection.mode === 'url') {
      // url 直连没有隧道进程：可达性由 ConnectionHealth 对远程地址的
      // 周期握手判定，这里恒定视为已就绪。
      runtime.tunnel = 'up';
      runtime.startedAt = new Date().toISOString();
      return statusOf(runtime);
    }
    this.startManaged(runtime);
    return statusOf(runtime);
  }

  async syncConnections(connections) {
    const next = new Map(connections.map((connection) => [connection.id, connection]));
    for (const [id, runtime] of this.runtimes) {
      const connection = next.get(id);
      if (!connection || connection.enabled !== true || connection.mode !== runtime.connection.mode) {
        await this.stopConnection(id, { remove: !connection });
      }
    }
    for (const connection of connections) {
      if (connection.enabled !== true) continue;
      const current = this.runtimes.get(connection.id);
      const changed = !current
        || current.stopped
        || current.connection.mode !== connection.mode
        || current.connection.localPort !== connection.localPort
        || current.connection.baseUrl !== connection.baseUrl
        || JSON.stringify(current.connection.ssh) !== JSON.stringify(connection.ssh)
        || JSON.stringify(current.connection.remote) !== JSON.stringify(connection.remote);
      if (changed) await this.startConnection(connection);
      else current.connection = connection;
    }
    return this.listStatuses();
  }

  getOrigin(id) {
    return this.runtimes.get(id)?.connection
      ? originFor(this.runtimes.get(id).connection)
      : null;
  }

  getStatus(id) {
    return statusOf(this.runtimes.get(id));
  }

  listStatuses() {
    return [...this.runtimes.values()].map(statusOf);
  }

  async stopConnection(id, { remove = false } = {}) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return null;
    runtime.stopped = true;
    if (runtime.reconnectTimer) {
      this.clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
    runtime.reconnectDelayMs = null;
    if (runtime.child && isRunning(runtime.child)) {
      const child = runtime.child;
      const exited = new Promise((resolve) => {
        const timer = this.setTimeout(() => resolve(false), this.exitWaitMs);
        child.once('exit', () => {
          this.clearTimeout(timer);
          resolve(true);
        });
      });
      child.kill('SIGTERM');
      await exited;
    }
    runtime.tunnel = 'stopped';
    runtime.child = null;
    if (remove) this.runtimes.delete(id);
    return statusOf(runtime);
  }

  async stopAll() {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stopConnection(id)));
  }

  startManaged(runtime) {
    if (runtime.stopped) return;
    runtime.tunnel = 'starting';
    runtime.startedAt = new Date().toISOString();
    runtime.reconnectDelayMs = null;
    const child = this.spawn('ssh', buildSshArgs(runtime.connection, this.batchMode), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    runtime.child = child;
    child.stderr?.on('data', (chunk) => appendStderr(runtime, chunk, this.stderrTailLines));
    child.on('error', (error) => {
      appendStderr(runtime, error.message, this.stderrTailLines, true);
      if (runtime.child === child) this.handleExit(runtime, 1, null);
    });
    child.on('exit', (code, signal) => {
      if (runtime.child === child) this.handleExit(runtime, code, signal);
    });
    runtime.tunnel = 'up';
  }

  handleExit(runtime, code, signal) {
    appendStderr(runtime, '', this.stderrTailLines, true);
    if (runtime.child?.exitCode === null) runtime.child.exitCode = code;
    runtime.exitCode = code;
    runtime.signalCode = signal || runtime.child?.signalCode || null;
    runtime.child = null;
    if (runtime.stopped) {
      runtime.tunnel = 'stopped';
      return;
    }
    runtime.tunnel = 'down';
    const exponent = runtime.reconnectAttempt;
    runtime.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectInitialMs * (2 ** exponent), this.reconnectMaxMs);
    runtime.reconnectDelayMs = delay;
    runtime.reconnectTimer = this.setTimeout(() => {
      runtime.reconnectTimer = null;
      if (!runtime.stopped) this.startManaged(runtime);
    }, delay);
    runtime.reconnectTimer.unref?.();
  }
}

export function createTunnelManager(options = {}) {
  return new TunnelManager(options);
}

export { buildSshArgs, originFor, TUNNEL_STATES };
