/**
 * ACP agent 装配 — SDK handler 注册、自有 stderr logger（ticket 019）
 *
 * 方法集（设计 §1 v1 全集）：
 *   initialize      capability 按 §4.1；不触网（Q14：Claw server 未运行时握手
 *                   仍成功，连接类错误在首个触网方法报告）
 *   session/new     调 018 原子路由；mcpServers/additionalDirectories/sessionModes
 *                   非空一律 -32602
 *   session/list    线程视角会话发现（每活跃线程一条，head 视角）；可选 cwd 过滤
 *   session/resume  持久 sessionId 续接（不回放历史）；server 解析线程 head +
 *                   急切挂载 runtime；mcpServers/additionalDirectories 非空一律 -32602
 *   session/prompt  仅 text block；管线见 session-manager；受理后先回显
 *                   user_message_chunk（client 转录完整性）
 *   session/cancel  notification，与 ctx.signal 汇入同一取消状态机
 *   session/close   转发 Claw 归档 thread；断开不触发（dispose 只清内存）
 * 出站通知：session/update（event-mapper 产物）
 *
 * stdout 纪律：本模块不向 stdout 写任何内容；SDK 的 ndJsonStream 是唯一
 * 的 stdout 写入者（只写 JSON-RPC 帧）。日志全走 stderr。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';

import {
  validateNewSessionParams,
  validateResumeSessionParams,
  validateLoadSessionParams,
  mergePromptText,
  guardSessionModesMessage,
} from './protocol.js';

export const AGENT_NAME = 'agentdevclaw-coder-acp';
export const AGENT_TITLE = 'AgentDevClaw Coder';

/** 自有 stderr logger：等级 + 命名空间，不依赖框架 console 桥。 */
export function createStderrLogger(namespace = 'coder-acp') {
  const write = (level, message) => {
    process.stderr.write(`${new Date().toISOString()} [${level}] ${namespace}: ${message}\n`);
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}

/** Claw 版本号（agentInfo.version），读仓库 package.json，不依赖框架包。 */
export function readClawVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 组装 AgentApp（SDK handler 注册）。
 *
 * @param {object} options
 * @param {import('./session-manager.js').ReturnType<typeof import('./session-manager.js').createSessionManager>} options.sessionManager
 * @param {{ warn: Function, info: Function, error: Function }} options.log
 * @param {string} options.version
 */
export function createAcpAgent({ sessionManager, log, version, trace }) {
  const agent = acp.agent({ name: AGENT_NAME });

  // initialize 不触网（设计 §4.1）：不声明 fs / terminal / recentEvents /
  // MCP / sessionModes / authMethods。会话恢复三件套：load（历史回放）+
  // resume（不回放续接）+ list（发现），见 sessionCapabilities。
  agent.onRequest(acp.methods.agent.initialize, () => {
    trace?.record('acp.initialize.response', { method: 'initialize', protocolVersion: acp.PROTOCOL_VERSION });
    return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, embeddedContext: false },
      sessionCapabilities: {
        resume: {},
        list: {},
        close: {},
      },
      close: {},
    },
    agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version },
    };
  });

  agent.onRequest(acp.methods.agent.session.new, async (ctx) => {
    trace?.record('acp.session.new.validate', { method: 'session/new' });
    const { cwd } = validateNewSessionParams(ctx.params);
    const result = await sessionManager.createSession(cwd);
    trace?.record('acp.session.new.response', { method: 'session/new', acpSessionId: result.sessionId });
    return result;
  });

  agent.onRequest(acp.methods.agent.session.list, async (ctx) => {
    const cwd = typeof ctx.params?.cwd === 'string' && ctx.params.cwd.trim() ? ctx.params.cwd : undefined;
    trace?.record('acp.session.list.request', { method: 'session/list', cwd });
    const result = await sessionManager.listSessions({ cwd });
    trace?.record('acp.session.list.response', { method: 'session/list', count: result?.threads?.length });
    return {
      sessions: (Array.isArray(result?.threads) ? result.threads : []).map((thread) => ({
        sessionId: thread.sessionId,
        cwd: thread.cwd,
        ...(thread.title ? { title: thread.title } : {}),
        ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
        _meta: {
          claw: {
            // 线程锚点 ID：prompt 投递 / 归档 / 中断都以此为目标；不参与
            // ACP 协议寻址，仅供诊断与 Claw 侧关联查询。
            threadId: thread.threadId,
          },
        },
      })),
    };
  });

  agent.onRequest(acp.methods.agent.session.resume, async (ctx) => {
    const { sessionId, cwd } = validateResumeSessionParams(ctx.params);
    trace?.record('acp.session.resume.validate', { method: 'session/resume', requestedSessionId: sessionId, cwd });
    const result = await sessionManager.resumeSession(sessionId, { cwd });
    trace?.record('acp.session.resume.response', { method: 'session/resume', acpSessionId: result.sessionId });
    return result;
  });

  // session/load：resume（控制面）+ head 历史回放（数据面）。回放通知的
  // sessionId 即 head（协议 ID 策略与 resume 一致，client 据此续接 prompt）。
  agent.onRequest(acp.methods.agent.session.load, async (ctx) => {
    const { sessionId, cwd } = validateLoadSessionParams(ctx.params);
    trace?.record('acp.session.load.validate', { method: 'session/load', requestedSessionId: sessionId, cwd });
    const result = await sessionManager.loadSession(
      sessionId,
      { cwd },
      (notification) => {
        trace?.record('acp.session_update.outbound', {
          method: 'session/update',
          acpSessionId: notification.params.sessionId,
          updateType: notification.params.update?.sessionUpdate,
          replay: true,
        });
        return ctx.client.notify(acp.methods.client.session.update, notification.params);
      },
    );
    trace?.record('acp.session.load.response', { method: 'session/load', acpSessionId: result?._meta?.claw?.sessionId });
    return result;
  });

  agent.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params ?? {};
    const text = mergePromptText(prompt);
    trace?.record('acp.prompt.validate', { method: 'session/prompt', acpSessionId: sessionId, prompt });
    const result = await sessionManager.runPrompt(sessionId, text, {
      onUpdate: (update) => {
        trace?.record('acp.session_update.outbound', {
          method: 'session/update',
          acpSessionId: sessionId,
          updateType: update?.sessionUpdate,
        });
        return ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update,
        });
      },
      signal: ctx.signal,
    });
    trace?.record('acp.prompt.response', { method: 'session/prompt', acpSessionId: sessionId });
    return result;
  });

  agent.onNotification(acp.methods.agent.session.cancel, (ctx) => {
    trace?.record('acp.cancel.received', { method: 'session/cancel', acpSessionId: ctx.params?.sessionId });
    sessionManager.cancel(ctx.params?.sessionId);
  });

  agent.onRequest(acp.methods.agent.session.close, async (ctx) => {
    const { sessionId } = ctx.params ?? {};
    trace?.record('acp.session.close.request', { method: 'session/close', acpSessionId: sessionId });
    const result = await sessionManager.closeSession(sessionId);
    trace?.record('acp.session.close.response', { method: 'session/close', acpSessionId: sessionId });
    return result;
  });

  agent.onConnect((connection) => {
    log.info(`client connected (agent=${AGENT_NAME})`);
    void connection.closed.then(() => {
      // 连接关闭：只释放 adapter 内存映射（Q12），Claw 对象全部保留
      sessionManager.dispose();
      log.info('client disconnected; in-memory session map cleared');
    });
  });

  return agent;
}

/**
 * sessionModes 消息层拦截（见 protocol.js guardSessionModesMessage）：
 * 在事件进入 SDK 之前检查 session/new 请求，非空 sessionModes 直接以
 * -32602 应答并丢弃；其余消息原样放行。
 *
 * @param {ReturnType<typeof acp.ndJsonStream>} transport
 * @returns {typeof transport} guarded stream
 */
export function applySessionModesGuard(transport, trace) {
  // 所有出站帧——SDK 的响应 / 通知（经下方 writable）与拦截器的拒绝——都经
  // 同一 promise 队列串行写底层 transport.writable。WritableStream 锁不可
  // 重入：并行 getWriter 会竞争同一把锁，后到的写直接被拒且被静默吞掉，
  // 造成 JSON-RPC 请求-响应失配（client 永远等不到该 ID 的响应）。
  let writeQueue = Promise.resolve();
  const enqueueWrite = (chunk) => {
    const done = writeQueue.then(async () => {
      const writer = transport.writable.getWriter();
      try {
        await writer.write(chunk);
      } finally {
        writer.releaseLock();
      }
    });
    // 队列前项失败不应中断后续写出；write 自身失败无法恢复，继续排队下一个。
    writeQueue = done.catch(() => {});
    return done;
  };

  const writable = new WritableStream({
    write(chunk) {
      trace?.wire('outbound', chunk);
      return enqueueWrite(chunk);
    },
    close() {
      return transport.writable.close();
    },
    abort(reason) {
      return transport.writable.abort(reason);
    },
  });

  return {
    writable,
    readable: transport.readable.pipeThrough(new TransformStream({
      transform(message, controller) {
        trace?.wire('inbound', message);
        const rejection = guardSessionModesMessage(message);
        if (rejection) {
          trace?.wire('outbound', rejection);
          void enqueueWrite(rejection).catch(() => {});
          return;
        }
        controller.enqueue(message);
      },
    })),
  };
}
