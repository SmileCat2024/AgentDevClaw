/**
 * plugin-host-child.js — 插件数据面子进程宿主（ADR-0055）
 *
 * 本文件是 plugin-host 子进程的入口与适配层：插件包的 server 面代码在本进程
 * 内执行，与 server.js 主进程隔离（崩溃 / 阻塞 / 泄漏不再拖垮宿主服务）。
 *
 * 契约（ADR-0055 决策 3）：插件源码零改动——本层构造与进程内挂载器同款的
 * 受控 router（get/post/put/delete、相对子路径校验）与 context
 * （getConfig(req) 返回随请求下发的配置快照，快照由宿主侧合成，本进程不
 * 接触配置文件）。能力面（本进程 → 宿主）白名单为空：只有 log。
 *
 * IPC 消息协议（两侧同款白名单校验，未知类型丢弃并记日志）：
 *   宿主 → 子：init / http-request / cancel / shutdown
 *   子 → 宿主：ready / http-response / chunk / log
 *
 * 通道纪律（ADR-0055 决策 4）：仅 Node 父子 IPC（process.send），本进程
 * 禁止监听任何 TCP / Unix 端口。零 Claw server 依赖——只 import node 内置
 * 模块，宿主模块演进不牵连本进程。
 *
 * 请求生命周期：http-request → 按 (packageName, method, routePath) 查路由
 * 表 → 构造 mock req / res（res 是真 Writable 流，pipe 可用；首个
 * write/end 触发 http-response 下发头，随后 chunk 逐块传输，流式与缓冲
 * 响应共用同一协议）→ handler 异常按既有包级熔断语义计数（连续 5 次未
 * 捕获异常 → 该包全部路由 503 circuit-open，进程重启后重置）。
 */

import { Writable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';

const CIRCUIT_BREAK_THRESHOLD = 5;

const HOST_MESSAGES = new Set(['init', 'http-request', 'cancel', 'shutdown']);
const CHILD_MESSAGES = new Set(['ready', 'http-response', 'chunk', 'log']);

/** 请求作用域：handler 调用链内 getConfig() 无参调用回退到当前请求快照。 */
const requestScope = new AsyncLocalStorage();

/** 包级熔断状态：packageName → { consecutiveFailures, broken } */
const circuit = new Map();
/** 路由表：`packageName\nMETHOD\nroutePath` → handler */
const routeTable = new Map();
/** 在途请求：requestId → mock res（cancel / shutdown 时销毁用） */
const inFlight = new Map();

let readySent = false;
let shuttingDown = false;
let shutdownTimer = null;

// ── 消息出口（白名单强制） ─────────────────────────────────────────

function send(message) {
  if (!process.connected) return;
  if (!CHILD_MESSAGES.has(message.type)) return;
  process.send(message);
}

function childLog(level, text) {
  send({ type: 'log', level, text: String(text) });
}

// ── 受控 router（与进程内挂载器同款校验） ─────────────────────────

function makeRouter(packageName, registrations) {
  const route = (method) => (routePath, handler) => {
    const rel = String(routePath || '');
    if (!rel.startsWith('/') || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
      throw new Error(`插件 ${packageName} 注册了非法路由路径：${method} ${rel}（必须是以 / 开头的相对子路径）`);
    }
    registrations.push({ method, routePath: rel, handler });
  };
  return { get: route('get'), post: route('post'), put: route('put'), delete: route('delete') };
}

// ── mock req / res（插件契约的执行载体） ───────────────────────────

const SETTINGS = Symbol('pluginSettings');

function buildUrl(routePath, params, query) {
  let url = String(routePath || '/');
  for (const [key, value] of Object.entries(params || {})) {
    url = url.replaceAll(`:${key}`, encodeURIComponent(String(value)));
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else if (value !== undefined && value !== null) search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

function createMockRequest(message) {
  const req = {
    method: message.method,
    url: buildUrl(message.routePath, message.params, message.query),
    params: message.params || {},
    query: message.query || {},
    headers: message.headers || {},
    body: decodeRequestBody(message),
    get(name) {
      if (typeof name !== 'string') return undefined;
      const hit = Object.keys(req.headers).find((key) => key.toLowerCase() === name.toLowerCase());
      return hit === undefined ? undefined : req.headers[hit];
    },
  };
  req[SETTINGS] = message.settings;
  return req;
}

/**
 * 请求体解码：宿主下发原始 Buffer。application/json 解析为对象（对齐
 * Express body-parser 语义；进程内时代插件路由未挂 body 解析器，JSON 解码
 * 属向前兼容的增强，存量插件无 body 消费者）。
 */
function decodeRequestBody(message) {
  const raw = message.body;
  if (!raw || !raw.length) return undefined;
  const contentType = Object.entries(message.headers || {})
    .find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (typeof contentType === 'string' && contentType.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      // 解析失败保留原始 Buffer，与 body-parser strict 宽容度对齐
    }
  }
  return raw;
}

/**
 * mock res：真 Writable 流（支持 createReadStream().pipe(res)）。
 * 头在首个 write / end 时经 http-response 下发（对齐 Express 语义）；
 * 此后数据经 chunk 逐块传输，流式与一次性响应共用同一协议。
 * removeHeader 记入 removedHeaders 随头下发——宿主安全头（如
 * X-Frame-Options DENY）由宿主中间件预设，插件按契约可摘除。
 */
function createMockResponse(requestId) {
  const headers = {};
  const removedHeaders = new Set();
  let statusCode = 200;
  let headSent = false;

  const sendHead = () => {
    if (headSent) return;
    headSent = true;
    send({
      type: 'http-response',
      requestId,
      status: statusCode,
      headers: { ...headers },
      removedHeaders: [...removedHeaders],
    });
  };

  const hasHeader = (name) => Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

  const res = new Writable({
    write(chunk, _enc, cb) {
      sendHead();
      send({ type: 'chunk', requestId, data: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk) });
      cb();
    },
    final(cb) {
      sendHead();
      send({ type: 'chunk', requestId, end: true });
      cb();
    },
    destroy(_err, cb) {
      send({ type: 'chunk', requestId, destroyed: true });
      cb();
    },
  });
  // 适配层自身销毁不冒泡 error 事件（无监听器会变 uncaughtException）
  res.on('error', () => {});

  const status = (code) => {
    if (!headSent && Number.isInteger(code)) statusCode = code;
    return res;
  };
  const set = (name, value) => {
    if (!headSent && typeof name === 'string') headers[name] = value;
    return res;
  };

  res.status = status;
  res.setHeader = set;
  res.set = set;
  res.header = set;
  res.type = (value) => set('Content-Type', value);
  res.get = (name) => (typeof name === 'string' && hasHeader(name)
    ? headers[Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())]
    : undefined);
  res.removeHeader = (name) => {
    if (headSent || typeof name !== 'string') return;
    const hit = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (hit !== undefined) delete headers[hit];
    removedHeaders.add(name);
  };
  res.json = (obj) => {
    if (!hasHeader('Content-Type')) headers['Content-Type'] = 'application/json';
    res.end(Buffer.from(JSON.stringify(obj ?? null)));
  };
  res.sendStatus = (code) => {
    status(code);
    if (!hasHeader('Content-Type')) headers['Content-Type'] = 'text/plain; charset=utf-8';
    res.end(Buffer.from(String(code)));
  };
  Object.defineProperty(res, 'headersSent', { get: () => headSent, configurable: false });
  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (value) => { if (!headSent) statusCode = value; },
  });
  return res;
}

// ── init：装载 mounts 清单 ─────────────────────────────────────────

async function handleInit(message) {
  const routes = [];
  const warnings = [];
  for (const mount of message.mounts || []) {
    const { packageName, version, entryPath } = mount;
    try {
      const mod = await import(pathToFileURL(entryPath).href);
      const registerRoutes = mod?.default?.registerRoutes || mod?.registerRoutes;
      if (typeof registerRoutes !== 'function') {
        warnings.push(`插件 ${packageName}@${version} server 面未导出 registerRoutes(router, context)：跳过挂载`);
        continue;
      }
      const registrations = [];
      const router = makeRouter(packageName, registrations);
      const context = {
        // 配置快照由宿主按请求合成下发（ADR-0055 决策 2：合成不离开主进程）。
        // getConfig(req) 用该请求快照；存量包契约的无参 getConfig() 回退到
        // 当前请求作用域的快照（宿主每请求现读合成，与挂载器时代"配置修改
        // 无需重启"等价）。构造期无请求调用返回空对象——防御性兜底。
        getConfig(req) {
          const source = req && typeof req === 'object' && SETTINGS in req
            ? req[SETTINGS]
            : requestScope.getStore()?.settings;
          return structuredClone(source ?? {});
        },
        package: { name: packageName, version },
      };
      registerRoutes(router, context);
      for (const { method, routePath, handler } of registrations) {
        routeTable.set(`${packageName}\n${method.toUpperCase()}\n${routePath}`, handler);
        routes.push({ packageName, method: method.toUpperCase(), routePath });
      }
    } catch (err) {
      warnings.push(`插件 ${packageName}@${version} server 面加载失败（${err?.message || err}）：跳过挂载`);
    }
  }
  readySent = true;
  send({ type: 'ready', routes, warnings });
}

// ── http-request：请求循环 ─────────────────────────────────────────

function circuitEntry(packageName) {
  let entry = circuit.get(packageName);
  if (!entry) {
    entry = { consecutiveFailures: 0, broken: false };
    circuit.set(packageName, entry);
  }
  return entry;
}

async function handleRequest(message) {
  const { requestId, packageName, method, routePath } = message;

  if (!readySent) {
    const res = createMockResponse(requestId);
    res.status(503).json({ ok: false, error: { code: 'plugin-host-not-ready', message: '插件宿主尚未就绪' } });
    return;
  }

  const entry = circuitEntry(packageName);
  if (entry.broken) {
    const res = createMockResponse(requestId);
    res.status(503).json({
      ok: false,
      error: {
        code: 'plugin-server-circuit-open',
        message: `插件 ${packageName} 数据面已因连续异常被摘除`,
      },
    });
    return;
  }

  // HEAD 回落 GET：宿主侧 app.get() 挂载的代理路由由 Express 自动响应 HEAD
  // （进程内时代的同款语义）；子进程按精确 method 匹配，需显式回落才不 404。
  const methodKey = String(method).toUpperCase();
  const handler = routeTable.get(
    `${packageName}\n${methodKey === 'HEAD' ? 'GET' : methodKey}\n${routePath}`,
  );
  if (typeof handler !== 'function') {
    const res = createMockResponse(requestId);
    res.status(404).json({ ok: false, error: { code: 'plugin-route-missing', message: `插件路由不存在：${method} ${routePath}` } });
    return;
  }

  const req = createMockRequest(message);
  const res = createMockResponse(requestId);
  inFlight.set(requestId, res);
  const cleanup = () => inFlight.delete(requestId);
  res.on('finish', cleanup);
  res.on('close', cleanup);

  try {
    await requestScope.run(message, () => handler(req, res));
  } catch (err) {
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
      entry.broken = true;
      childLog('warn', `插件 ${packageName} 数据面连续 ${entry.consecutiveFailures} 次异常，已熔断摘除（最后错误：${err?.message || err}）`);
    }
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: { code: 'plugin-server-error', message: String(err?.message || err) } });
    } else {
      res.destroy();
    }
  }
}

// ── cancel / shutdown ──────────────────────────────────────────────

function handleCancel(message) {
  const res = inFlight.get(message.requestId);
  if (res) res.destroy();
}

function handleShutdown(message) {
  shuttingDown = true;
  const graceMs = Number.isFinite(message?.graceMs) ? message.graceMs : 3000;
  if (inFlight.size === 0) {
    process.exit(0);
    return;
  }
  if (shutdownTimer) return;
  const deadline = Date.now() + graceMs;
  shutdownTimer = setInterval(() => {
    if (inFlight.size === 0 || Date.now() >= deadline) process.exit(0);
  }, 50);
  shutdownTimer.unref?.();
}

// ── 主循环 ─────────────────────────────────────────────────────────

process.on('message', (message) => {
  if (!message || typeof message !== 'object' || !HOST_MESSAGES.has(message.type)) {
    childLog('warn', `plugin-host 收到未知消息类型（已丢弃）：${message?.type ?? '(none)'}`);
    return;
  }
  if (shuttingDown && message.type === 'http-request') {
    const res = createMockResponse(message.requestId);
    res.status(503).json({ ok: false, error: { code: 'plugin-host-shutting-down', message: '插件宿主正在关闭' } });
    return;
  }
  try {
    if (message.type === 'init') {
      handleInit(message).catch((err) => {
        childLog('error', `plugin-host init 失败：${err?.stack || err}`);
        process.exit(1);
      });
    } else if (message.type === 'http-request') {
      handleRequest(message).catch((err) => {
        childLog('error', `plugin-host 请求处理失败（requestId=${message.requestId}）：${err?.stack || err}`);
      });
    } else if (message.type === 'cancel') {
      handleCancel(message);
    } else if (message.type === 'shutdown') {
      handleShutdown(message);
    }
  } catch (err) {
    childLog('error', `plugin-host 消息处理异常（${message.type}）：${err?.stack || err}`);
  }
});

process.on('disconnect', () => process.exit(0));

// 崩溃语义（ADR-0055 决策 5）：未捕获异常让本进程死掉，宿主侧指数退避重启
// ——插件故障的爆炸半径收敛在 plugin-host 内，这正是隔离目标。
process.on('uncaughtException', (err) => {
  childLog('error', `plugin-host uncaughtException：${err?.stack || err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  childLog('error', `plugin-host unhandledRejection：${reason?.stack || reason}`);
  process.exit(1);
});
