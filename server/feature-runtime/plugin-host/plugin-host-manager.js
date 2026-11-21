/**
 * plugin-host-manager.js — 插件数据面子进程管理器与请求代理（ADR-0055）
 *
 * 宿主侧职责（ADR-0055 决策 2：收口点即安全点）：
 *   - digest 校验与配置四层合成留在 server.js 主进程，随请求以快照下发；
 *     子进程拿不到配置文件路径与配置树读取能力。
 *   - 路由匹配在宿主侧完成（Express 路径模式），子进程只按
 *     (packageName, method, routePath) 精确分发，无法构造对其他插件路由
 *     或宿主接口的请求。
 *
 * 进程模型（决策 1 + 5）：全进程树唯一的 plugin-host 子进程（fork 父子 IPC，
 * 无网络监听面，因此无握手 / token 协议）。remount = 预启新进程 → ready 后
 * 原子切换 Express 路由 → 旧进程 shutdown + 宽限期回收（在途请求由旧进程
 * 在宽限期内完成）。崩溃走指数退避自动重启；重启窗口内请求回 503。
 *
 * 本模块与 plugin-server.js 的分工：plugin-server 计算 mounts 清单（catalog /
 * 装配事实 / 解出自愈）并把代理路由挂进 Express；本模块持有进程与 IPC 协议，
 * 对 Express 形态零依赖（req/res 接口由调用方适配）——便于测试与未来复用。
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createClawLogger } from '../../shared/claw-logger.js';

const log = createClawLogger('plugin-host');

const CHILD_PATH = fileURLToPath(new URL('./plugin-host-child.js', import.meta.url));
// 宿主 → 子的消息类型由发送点固定：init / http-request / cancel / shutdown
const CHILD_MESSAGES = new Set(['ready', 'http-response', 'chunk', 'log']);

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const CRASH_BACKOFF_BASE_MS = 250;
const CRASH_BACKOFF_CAP_MS = 5_000;
const SLOW_REQUEST_MS = 5_000;

/** 模块级单例：当前活跃 plugin-host（全部 app 共用，与全局唯一进程对齐）。 */
let activeHost = null;
/** 串行化宿主生命周期操作（ensure / replace / terminate 不并发）。 */
let lifecycleChain = Promise.resolve();

// ── 工具 ───────────────────────────────────────────────────────────

function mountsKey(mounts) {
  return JSON.stringify((mounts || []).map((mount) => ({
    packageName: mount.packageName,
    version: mount.version,
    prefix: mount.prefix,
    entryPath: mount.entryPath,
    ...(mount.settingsDigest ? { settingsDigest: mount.settingsDigest } : {}),
  })));
}

function notifyResponseError(res, statusCode, code, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(statusCode).json({ ok: false, error: { code, message } });
}

/**
 * 读取请求原始 body（Buffer）。插件路由在进程内时代未挂 body 解析器，
 * 这里按原始流读取经 IPC 下发（上限防止通道爆内存）；流错误回 null。
 */
export function readRawBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

// ── host（一个 plugin-host 子进程的宿主侧投影） ─────────────────────

function spawnPluginHostProcess(mounts) {
  const child = fork(CHILD_PATH, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
    // v8 structured clone：消息里的 Buffer（请求 body / 响应 chunk）原生
    // 传输——默认 JSON 序列化会把 Buffer 变成 {type:'Buffer',data:[...]}
    serialization: 'advanced',
  });
  child.stdout?.on('data', (chunk) => log.info(`[plugin-host stdout] ${String(chunk).trimEnd()}`));
  child.stderr?.on('data', (chunk) => log.warn(`[plugin-host stderr] ${String(chunk).trimEnd()}`));

  // init 只下发子进程装载所需字段：digest 校验与配置合成都在宿主收口
  child.send({
    type: 'init',
    mounts: (mounts || []).map(({ packageName, version, entryPath }) => ({ packageName, version, entryPath })),
  });
  return child;
}

/**
 * 建立一个 plugin-host 并等待 ready。
 * resolve 的 host：{ key, routes, warnings, request(), dispose(), stats }。
 */
function launchPluginHost(key, mounts, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPluginHostProcess(mounts);
    const pending = new Map(); // requestId → { res, headWritten, timer, startedAt }
    let nextRequestId = 1;
    let disposed = false;
    const stats = { dispatched: 0, responses: 0, chunks: 0, cancels: 0, timeouts: 0, crashes: 0 };

    const readyTimer = setTimeout(() => {
      finishLaunch(new Error(`plugin-host ${READY_TIMEOUT_MS}ms 内未就绪`));
    }, READY_TIMEOUT_MS);

    let routes = [];
    let warnings = [];
    let launchSettled = false;

    function finishLaunch(error) {
      if (launchSettled) return;
      launchSettled = true;
      clearTimeout(readyTimer);
      if (error) {
        disposed = true;
        try { child.kill(); } catch { /* 已退出 */ }
        reject(error);
      } else {
        resolve(host);
      }
    }

    function clearPendingEntry(requestId, entry) {
      if (pending.get(requestId) !== entry) return;
      clearTimeout(entry.timer);
      pending.delete(requestId);
    }

    function failAllPending(code, message) {
      for (const [requestId, entry] of [...pending.entries()]) {
        clearPendingEntry(requestId, entry);
        notifyResponseError(entry.res, 503, code, message);
      }
    }

    const host = {
      key,
      routes,
      warnings,
      stats,
      get disposed() { return disposed; },
      request(message, res) {
        const requestId = nextRequestId++;
        const entry = { res, headWritten: false, timer: null, startedAt: Date.now() };
        entry.timer = setTimeout(() => {
          if (pending.get(requestId) !== entry) return;
          stats.timeouts += 1;
          clearPendingEntry(requestId, entry);
          notifyResponseError(res, 504, 'plugin-host-timeout', `插件数据面请求超时（${requestTimeoutMs}ms）`);
          if (!disposed) child.send({ type: 'cancel', requestId });
        }, requestTimeoutMs);
        pending.set(requestId, entry);
        stats.dispatched += 1;
        const sent = child.send({ type: 'http-request', requestId, ...message });
        if (!sent) {
          clearPendingEntry(requestId, entry);
          notifyResponseError(res, 503, 'plugin-host-backpressure', '插件宿主 IPC 通道拥塞');
        }
      },
      dispose({ graceful = true, graceMs = SHUTDOWN_GRACE_MS } = {}) {
        if (disposed) return;
        disposed = true;
        if (!graceful) {
          try { child.kill(); } catch { /* 已退出 */ }
          failAllPending('plugin-host-terminated', '插件宿主已终止');
          return;
        }
        // 优雅退出：在途请求由旧进程在宽限期内完成；超时强杀后残留请求回 503
        try {
          child.send({ type: 'shutdown', graceMs });
        } catch { /* 子进程已退出：宽限计时兜底清理 pending */ }
        const killTimer = setTimeout(() => {
          try { child.kill(); } catch { /* 已退出 */ }
          const residual = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
          }, KILL_GRACE_MS);
          residual.unref?.();
        }, graceMs);
        killTimer.unref?.();
        child.once('exit', () => {
          clearTimeout(killTimer);
          failAllPending('plugin-host-shutdown', '插件宿主已关闭（在途请求未在宽限期内完成）');
        });
      },
    };

    child.on('message', (message) => {
      if (!message || typeof message !== 'object' || !CHILD_MESSAGES.has(message.type)) {
        log.warn(`收到未知子进程消息类型（已丢弃）：${message?.type ?? '(none)'}`);
        return;
      }
      if (message.type === 'ready') {
        routes = (message.routes || []).map((route) => ({ ...route, method: String(route.method).toLowerCase() }));
        warnings = (message.warnings || []).map(String);
        host.routes = routes;
        host.warnings = warnings;
        finishLaunch(null);
        return;
      }
      if (message.type === 'log') {
        const text = String(message.text || '');
        const level = String(message.level || 'info');
        if (level === 'error') log.error(text);
        else if (level === 'warn') log.warn(text);
        else log.info(text);
        return;
      }
      const entry = pending.get(message.requestId);
      if (!entry) return; // 已超时 / 已取消的迟到消息：丢弃
      if (message.type === 'http-response') {
        stats.responses += 1;
        entry.headWritten = true;
        entry.res.statusCode = Number.isInteger(message.status) ? message.status : 200;
        for (const name of message.removedHeaders || []) entry.res.removeHeader(name);
        for (const [name, value] of Object.entries(message.headers || {})) {
          if (value !== undefined && value !== null) entry.res.setHeader(name, value);
        }
        return;
      }
      if (message.type === 'chunk') {
        if (message.destroyed) {
          clearPendingEntry(message.requestId, entry);
          entry.res.destroy();
          return;
        }
        if (message.end) {
          clearPendingEntry(message.requestId, entry);
          const elapsed = Date.now() - entry.startedAt;
          if (elapsed >= SLOW_REQUEST_MS) log.info(`慢请求 ${elapsed}ms（requestId=${message.requestId}）`);
          entry.res.end();
          return;
        }
        stats.chunks += 1;
        if (message.data) entry.res.write(Buffer.from(message.data));
      }
    });

    child.on('exit', (code, signal) => {
      if (!launchSettled) {
        finishLaunch(new Error(`plugin-host 启动阶段退出（code=${code} signal=${signal}）`));
        return;
      }
      if (disposed) {
        failAllPending('plugin-host-shutdown', '插件宿主已关闭');
        return;
      }
      // 非预期退出（崩溃）：在途请求立即 503，由 manager 层安排退避重启
      disposed = true;
      stats.crashes += 1;
      log.warn(`plugin-host 异常退出（code=${code} signal=${signal}），在途请求回 503`);
      failAllPending('plugin-host-crashed', '插件宿主进程崩溃');
      host.onCrash?.();
    });

    child.on('error', (error) => {
      log.error(`plugin-host 进程错误：${error?.message || error}`);
    });
  });
}

// ── 生命周期（模块级单例管理） ──────────────────────────────────────

/**
 * 活跃 host 与重启账本。crashBackoff 次数只在非预期退出时累积，
 * 一次成功 ready 后重置。
 */
let lastMounts = null;
let lastHostOptions = {};
let crashAttempts = 0;
let restartTimer = null;

function scheduleCrashRestart() {
  if (restartTimer || !lastMounts) return;
  const delay = Math.min(CRASH_BACKOFF_BASE_MS * 2 ** crashAttempts, CRASH_BACKOFF_CAP_MS);
  crashAttempts += 1;
  log.warn(`plugin-host 将在 ${delay}ms 后自动重启（第 ${crashAttempts} 次退避）`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!lastMounts) return;
    // 重启体入锁：与 remount 等生命周期操作互斥；锁内复查活跃 host——
    // 若等待期间 remount 已完成切换（或手动重建），跳过本次重启，避免覆盖。
    enqueueLifecycle(async () => {
      if (!lastMounts) return;
      if (activeHost && !activeHost.disposed) return;
      try {
        const host = await launchPluginHost(mountsKey(lastMounts), lastMounts, lastHostOptions);
        crashAttempts = 0;
        installActiveHost(host);
        log.info(`plugin-host 崩溃后重启完成：${host.routes.length} 条路由恢复`);
      } catch (error) {
        log.error(`plugin-host 重启失败：${error?.message || error}`);
        scheduleCrashRestart();
      }
    }).catch(() => { /* launch 失败已在锁内记账并调度退避 */ });
  }, delay);
  restartTimer.unref?.();
}

function installActiveHost(host) {
  activeHost = host;
  host.onCrash = () => {
    if (activeHost === host) {
      activeHost = null;
      scheduleCrashRestart();
    }
  };
}

/**
 * 宿主生命周期锁：把「host 切换 + Express 路由安装」等复合操作做成原子段，
 * 避免并发的 mount / remount 在安装路由时互相覆盖（后完成者赢的窗口）。
 * 锁内只能调用 *Locked 版本——自带排队的入口会在锁上等待自身，死锁。
 */
export function runPluginHostLifecycle(operation) {
  return enqueueLifecycle(operation);
}

/**
 * 锁内版本（须在 runPluginHostLifecycle 回调内调用）：确保存在匹配 mounts
 * 的活跃 plugin-host。指纹一致直接复用（配置合成在宿主每请求现读，
 * resolvers 变化不需要换进程）；不一致则预启新进程、ready 后原子切换并
 * 回收旧进程。
 */
export async function ensurePluginHostLocked(mounts, options = {}) {
  const key = mountsKey(mounts);
  if (activeHost && !activeHost.disposed && activeHost.key === key) {
    return activeHost;
  }
  return replacePluginHostLocked(mounts, options);
}

/**
 * 锁内版本（须在 runPluginHostLifecycle 回调内调用）：强制换新 plugin-host
 * （remount 语义，ADR-0055 决策 5）：预启新进程 → ready → 切换 → 旧进程
 * 优雅回收。换进程天然规避 ESM import 缓存导致的子进程内换版不生效。
 */
export function replacePluginHostLocked(mounts, options = {}) {
  return replaceUnderLock(mounts, options);
}

async function replaceUnderLock(mounts, options) {
  const previous = activeHost;
  const hostOptions = { requestTimeoutMs: options.requestTimeoutMs };
  const host = await launchPluginHost(mountsKey(mounts), mounts, hostOptions);
  crashAttempts = 0;
  installActiveHost(host);
  lastMounts = mounts;
  lastHostOptions = hostOptions;
  if (previous && !previous.disposed) {
    previous.onCrash = null; // 预期内的回收不算崩溃
    previous.dispose({ graceful: true });
  }
  return host;
}

/** 终止活跃 plugin-host（数据面整体下线：unmount 清空挂载表时调用）。 */
export function terminatePluginHost() {
  return enqueueLifecycle(() => {
    const previous = activeHost;
    activeHost = null;
    lastMounts = null;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (previous && !previous.disposed) {
      previous.onCrash = null;
      previous.dispose({ graceful: false });
    }
  });
}

/** 当前活跃 host（崩溃窗口 / 未启动时为 null）。 */
export function getActivePluginHost() {
  return activeHost;
}

/** 可观测性（ADR：IPC 侧消息计数）。 */
export function getPluginHostStats() {
  return activeHost ? { ...activeHost.stats, alive: !activeHost.disposed } : { alive: false };
}

function enqueueLifecycle(operation) {
  const run = lifecycleChain.then(operation, operation);
  lifecycleChain = run.catch(() => {});
  return run;
}
