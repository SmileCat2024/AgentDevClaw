/**
 * 门户线路运行时 — 多线路并发连接、按线路入站分发、按线路出站（ADR-0042 决策 2/3/4）
 *
 * 门户 runtime 是全部线路渠道 gateway 的唯一持有者。本模块把「配置里的线路」
 * 变成「运行中的连接」，并承担消息的两端：
 *
 * - 入站（决策 3）：平台消息 → 查该 carrier 的线路 → 按 boundTarget 分发。
 *   目标是接线员线程（agentId === 门户自身）时交回门户 CallArbiter，结果
 *   作为入站回调的返回值同步回给平台（与历史单渠道模式一致）；目标是外部
 *   线程时投递到线程 Inbox（POST /protoclaw/threads/:threadId/input），由
 *   线程域负责串行、暂存与补投，结果稍后经出站事件面送回。
 * - 出站（决策 4）：订阅服务端线程轮次事件（SSE ?threads=*），命中本门户
 *   绑定的「外部线程」时把结果经该线路的平台连接发回。截断与错误文案沿用
 *   原 IM_REPLY_POLICY（从 runtime-im-bridge 迁入）。接线员线程不走出站——
 *   它的结果已在入站的同步返回值里回过，再发一次是重复。
 *
 * 状态全部按线路记账，不再有单值 _activeIMChannel / _lastIMTarget：多条线路
 * 各自记住自己的最近对端，互不覆盖。
 *
 * 与旧载体挂载（scripts/runtime-im-bridge.js 的 mountCarrierFeature）的分工：
 * 旧机制把 carrier feature 动态挂进「目标会话 runtime」，线程换头即失效；
 * 本模块在门户内一次性持有全部连接，跨换头稳定。两者不共存——旧机制随
 * 切片 E 退役。
 */

import { getIMChannel, getIMChannelIds } from '../../../server/shared/im-channels.js';
import { internalAuthHeaders } from '../../../server/shared/internal-auth.js';

/** 结果文本截断与错误文案上限（原 runtime-im-bridge 的 IM_REPLY_POLICY）。 */
export const PORTAL_REPLY_POLICY = Object.freeze({
  MAX_RESULT_LENGTH: 1500,
  MAX_ERROR_LENGTH: 500,
});

/** 未配置 resultText 时的占位回复。 */
const EMPTY_RESULT_TEXT = '处理完成';

/** 消息已进 Inbox、结果稍后异步送达时的即时确认。 */
const QUEUED_ACK_TEXT = '已收到，处理中…';

function truncateForIM(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n...(结果已截断，完整内容请查看调试面板)';
}

/** 轮次终态 → 出站文本（失败带错误摘要；成功空结果给占位，与历史行为一致）。 */
export function buildOutboundText({ status, resultText, error }) {
  if (status === 'failed') {
    const detail = error?.message || error || '未知错误';
    return `⚠ 处理失败: ${truncateForIM(String(detail), PORTAL_REPLY_POLICY.MAX_ERROR_LENGTH)}`;
  }
  const text = typeof resultText === 'string' ? resultText : '';
  if (!text) return EMPTY_RESULT_TEXT;
  return truncateForIM(text, PORTAL_REPLY_POLICY.MAX_RESULT_LENGTH);
}

/**
 * 门户线路运行时。
 *
 * @param {object} options
 * @param {object} options.agent 门户 agent 实例（提供 features 与 _callArbiter）
 * @param {string} options.serverOrigin 服务端 origin
 * @param {string} options.portalAgentId 门户自身的 agentId（识别「目标是接线员」）
 * @param {(message: string, level?: string) => void} [options.logger]
 */
export function createPortalLines({
  agent,
  serverOrigin,
  portalAgentId,
  logger = () => {},
} = {}) {
  /** carrier → 已连接线路条目 */
  const connections = new Map();
  /** 外部线程 threadId → 最近一次入站的对端（出站回发目标） */
  const peerByThread = new Map();
  /** 正在建立的 carrier，防并发重复连接 */
  const connecting = new Map();
  let sseAbort = null;
  let started = false;
  /** 重连等待的唤醒器：close() 立即放行，避免收尾时白等一个重连周期。 */
  let reconnectWake = null;

  const log = (message, level = 'info') => {
    try { logger(message, level); } catch { /* 日志永不打断连接 */ }
  };

  /** 取某 carrier 对应的平台 feature（agent 装配时已 use 的那一个）。 */
  function featureOf(carrier) {
    const ch = getIMChannel(carrier);
    if (!ch) return null;
    return agent?.features?.get?.(ch.featureName) || null;
  }

  /** 从渠道 feature 的当前 turn 上下文取最近对端（各渠道字段名不同）。 */
  function peerFromFeature(feature) {
    const ctx = feature?._currentTurnCtx;
    if (!ctx) return null;
    return {
      userId: ctx.accountId || ctx.receiveId || ctx.chatId || '',
      contextToken: '',
      receiveIdType: ctx.receiveIdType || '',
    };
  }

  /**
   * 消息级唯一标识（用作线程 Inbox 的幂等键）。
   *
   * 为什么不能用 senderId：框架 appendCommand 的幂等语义是「命中 pending 或
   * delivered 的同键指令即判重复」，同一对端连发两条不同内容的消息会被静默
   * 吞掉第二条。各渠道的 turn metadata 都带消息 ID（QQ/飞书 messageId、微信
   * msg_id），取它；缺失时退回「发送者+时间戳+文本摘要」的合成键，仍保证
   * 同一对端的连续消息互不碰撞。
   */
  function messageRefOf(carrier, metadata, text) {
    const payload = metadata?.[getIMChannel(carrier)?.featureName || carrier] || {};
    const explicit = String(payload.messageId || payload.msg_id || payload.msgId || '').trim();
    if (explicit) return explicit;
    const sender = String(payload.senderId || '').trim();
    const digest = String(text || '').slice(0, 32);
    return `${sender || 'unknown'}:${Date.now()}:${digest}`;
  }

  function normaliseTarget(target) {
    if (!target || typeof target !== 'object') return null;
    const agentId = String(target.agentId || '').trim();
    const threadId = String(target.threadId || '').trim();
    if (!agentId || !threadId) return null;
    return { agentId, threadId };
  }

  // ── 连接管理 ──────────────────────────────────────────────────────

  /**
   * 令一条线路开始接消息。同一 carrier 已有连接时按幂等处理（配置改动后
   * 重新绑定会先断旧连接再连新的）。
   */
  async function connectLine(line) {
    const carrier = String(line?.carrier || '').trim();
    const lineId = String(line?.id || '').trim();
    if (!carrier || !lineId) return { ok: false, reason: 'invalid_line' };

    const existing = connections.get(carrier);
    if (existing && existing.lineId === lineId) {
      return { ok: true, reused: true };
    }
    // carrier 独占：同一渠道改绑线路时，旧连接按新线路重置
    if (existing) await disconnectCarrier(carrier);
    if (connecting.has(carrier)) return { ok: false, reason: 'connecting' };

    connecting.set(carrier, true);
    try {
      const feature = featureOf(carrier);
      if (!feature) {
        log(`线路 ${lineId} 的渠道 ${carrier} 未装配 feature，跳过`, 'warn');
        return { ok: false, reason: 'feature_missing' };
      }
      // 先登记再启动：入站回调需要读到本线路的绑定目标
      connections.set(carrier, {
        lineId,
        carrier,
        feature,
        connectedAt: Date.now(),
        boundTarget: normaliseTarget(line.boundTarget),
      });
      await installInboundHandler({ carrier, lineId, feature });
      await feature.startGateway(agent);
      log(`线路 ${lineId} [${carrier}] 已连接`);
      return { ok: true };
    } catch (error) {
      log(`线路 ${lineId} [${carrier}] 连接失败: ${error?.message || error}`, 'error');
      connections.delete(carrier);
      return { ok: false, reason: 'connect_failed', error };
    } finally {
      connecting.delete(carrier);
    }
  }

  /** 停掉某 carrier 的 gateway（没有连接时不做事）。 */
  async function disconnectCarrier(carrier) {
    const conn = connections.get(carrier);
    if (!conn) return false;
    connections.delete(carrier);
    try {
      if (typeof conn.feature?.stopGateway === 'function') {
        await conn.feature.stopGateway(agent);
      } else if (typeof conn.feature?.onDestroy === 'function') {
        await conn.feature.onDestroy({ agent });
      }
    } catch (error) {
      log(`停止 ${carrier} gateway 失败: ${error?.message || error}`, 'warn');
    }
    log(`线路 ${conn.lineId} [${carrier}] 已断开`);
    return true;
  }

  /**
   * 按配置对账：连上新增/变更的线路，断开已移除的线路。配置变更后调用，
   * 使「配置即事实」——门户启动与运行期改配置走同一条路。
   */
  async function syncLines(lines) {
    const wanted = new Map();
    for (const line of Array.isArray(lines) ? lines : []) {
      const carrier = String(line?.carrier || '').trim();
      const lineId = String(line?.id || '').trim();
      if (!carrier || !lineId) continue;
      wanted.set(carrier, line);
    }

    // 断掉配置里已不存在的 carrier，或同一 carrier 换了线路
    for (const [carrier, conn] of [...connections]) {
      const next = wanted.get(carrier);
      if (!next || String(next.id).trim() !== conn.lineId) {
        await disconnectCarrier(carrier);
      }
    }

    for (const line of wanted.values()) {
      const conn = connections.get(line.carrier);
      if (conn && conn.lineId === String(line.id).trim()) {
        // 已连：只更新绑定目标（改绑不需要重连平台连接）
        conn.boundTarget = normaliseTarget(line.boundTarget);
        continue;
      }
      await connectLine(line);
    }
    return {
      connected: [...connections.values()].map((c) => ({ carrier: c.carrier, lineId: c.lineId })),
    };
  }

  // ── 入站 ──────────────────────────────────────────────────────────

  /**
   * 给渠道 feature 装入站处理器。各渠道的上游回调形态不同（onCall 返回值
   * 被 adapter 发送 / handleMessage 自管发送），这里按渠道注册表统一适配，
   * 分发逻辑只有一份。
   */
  async function installInboundHandler({ carrier, lineId, feature }) {
    const ch = getIMChannel(carrier);
    if (!ch) return;

    if (ch.messageMode === 'handleMessage') {
      // 微信：覆盖 handleMessage（上游用自家 API client 拉消息），自行发送回复
      const mod = await import(ch.packageName);
      const WeixinApiClient = mod.WeixinApiClient;
      feature.handleMessage = async (msg) => {
        if (!msg || msg.message_type !== 1) return;
        const text = WeixinApiClient.extractText(msg);
        if (!text) return;
        feature._pendingMedia = [];
        try {
          const metadata = typeof feature.buildTurnMetadata === 'function'
            ? feature.buildTurnMetadata(msg)
            : undefined;
          const replyText = await dispatchInbound({
            carrier,
            lineId,
            text,
            sourceRef: msg.from_user_id || '',
            metadata,
          });
          if (replyText) {
            await feature.apiClient.sendTextMessage(
              msg.from_user_id,
              replyText,
              msg.context_token || '',
            );
          }
          await feature.flushPendingMedia?.();
        } finally {
          feature._pendingMedia = [];
        }
      };
      return;
    }

    // 其余渠道：agentRef.onCall 的返回值由 feature 的 adapter 负责发送。
    // 签名与框架 Agent.onCall(input, images, activations, metadata) 对齐——
    // feature 侧以第 4 参传 turn metadata，宿主闭包以第 4 形参接收。
    feature.agentRef = {
      onCall: async (text, _images, _activations, metadata) => dispatchInbound({
        carrier,
        lineId,
        text,
        sourceRef: metadata?.[ch.featureName]?.senderId || '',
        metadata,
      }),
    };
  }

  /**
   * 入站分发：按本线路的 boundTarget 决定交门户还是投线程，返回要同步
   * 回给平台的文本（空串表示不回）。
   */
  async function dispatchInbound({ carrier, lineId, text, sourceRef, metadata }) {
    const conn = connections.get(carrier);
    const target = conn?.boundTarget || null;
    const feature = featureOf(carrier);

    // 未绑定，或绑定目标是接线员线程：门户自己处理
    if (!target || target.agentId === portalAgentId) {
      return dispatchToPortal({ carrier, lineId, text, sourceRef, metadata, feature, target });
    }
    // 线程 Inbox 的幂等键要消息级唯一，不能用对端 ID（见 messageRefOf 说明）
    return dispatchToThread({
      carrier, lineId, text, metadata, feature, target,
      sourceRef: messageRefOf(carrier, metadata, text),
    });
  }

  /** 目标 = 门户自身：交门户 CallArbiter，结果作为返回值同步回给平台。 */
  async function dispatchToPortal({ carrier, lineId, text, sourceRef, metadata, feature, target }) {
    const arbiter = agent?._callArbiter;
    if (!arbiter) {
      log(`线路 ${lineId} 收到消息但门户 CallArbiter 未就绪`, 'warn');
      return '⚠ 门户尚未就绪，请稍后重试。';
    }
    // 对端按线程记：出站路径对「本线程该发到哪」与外部线程同构，但接线员
    // 线程的出站被 handleTurnFact 的 portalAgentId 守卫拦下（结果已在本次
    // 同步返回里回过，再发一次就是重复）。未绑定线路按线路记。
    const peer = peerFromFeature(feature);
    if (peer?.userId) {
      peerByThread.set(target?.threadId || `line:${lineId}`, peer);
    }

    const entry = arbiter.enqueue({
      source: carrier,
      sourceRef: sourceRef || '',
      text,
      ...(metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0
        ? { metadata }
        : {}),
    });
    const finished = await arbiter.waitForCompletion(entry.id);
    if (finished.status === 'failed') {
      return buildOutboundText({ status: 'failed', error: finished.error });
    }
    return buildOutboundText({ status: 'completed', resultText: finished.result });
  }

  /**
   * 目标 = 外部线程：投递线程 Inbox。服务端负责接受性判定、暂存与补投；
   * 结果由出站事件面异步送回，这里只回一句即时确认。
   */
  async function dispatchToThread({ carrier, lineId, text, sourceRef, metadata, feature, target }) {
    const peer = peerFromFeature(feature);
    if (peer?.userId) peerByThread.set(target.threadId, peer);

    try {
      const resp = await fetch(
        `${serverOrigin}/protoclaw/threads/${encodeURIComponent(target.threadId)}/input`,
        {
          method: 'POST',
          headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            text,
            source: carrier,
            sourceRef: sourceRef || '',
            ...(metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0
              ? { metadata }
              : {}),
          }),
        },
      );
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        log(`线路 ${lineId} 投递线程 ${target.threadId} 失败 (${resp.status}): ${detail.slice(0, 200)}`, 'error');
        return `⚠ 目标对话当前无法接收消息（${resp.status}），请稍后重试。`;
      }
      log(`线路 ${lineId} 已投递到线程 ${target.threadId}`);
      return QUEUED_ACK_TEXT;
    } catch (error) {
      log(`线路 ${lineId} 投递线程失败: ${error?.message || error}`, 'error');
      return '⚠ 消息投递失败，请稍后重试。';
    }
  }

  // ── 出站 ──────────────────────────────────────────────────────────

  /**
   * 订阅服务端线程轮次事件，把外部线程的结果发回对应线路。接线员线程
   * 不走这条路径（结果已在入站同步返回）。
   */
  function startOutboundListener() {
    if (started) return;
    started = true;
    void runOutboundLoop();
  }

  async function runOutboundLoop() {
    let lastEventId = null;
    while (started) {
      const controller = new AbortController();
      sseAbort = controller;
      try {
        const url = `${serverOrigin}/protoclaw/events?threads=*`;
        const headers = { Accept: 'text/event-stream', ...internalAuthHeaders() };
        if (lastEventId != null) headers['Last-Event-ID'] = String(lastEventId);
        const resp = await fetch(url, { headers, signal: controller.signal });
        if (!resp.ok || !resp.body) throw new Error(`events endpoint ${resp.status}`);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const parsed = parseSseFrame(frame);
            if (!parsed) continue;
            if (parsed.id != null) lastEventId = parsed.id;
            if (!parsed.event?.startsWith('thread.turn-')) continue;
            try {
              await handleTurnFact(parsed.event, parsed.data);
            } catch (error) {
              log(`出站处理轮次事件失败: ${error?.message || error}`, 'error');
            }
          }
        }
      } catch (error) {
        if (!started) return;
        log(`线程事件订阅中断，2s 后重连: ${error?.message || error}`, 'warn');
      } finally {
        sseAbort = null;
      }
      if (!started) return;
      await new Promise((resolve) => {
        reconnectWake = resolve;
        const timer = setTimeout(() => { reconnectWake = null; resolve(); }, 2000);
        if (typeof timer.unref === 'function') timer.unref();
      });
      reconnectWake = null;
    }
  }

  /** 解析一帧 SSE 文本（id / event / data）。 */
  function parseSseFrame(frame) {
    const lines = String(frame || '').split('\n');
    let id = null;
    let event = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const raw = line.slice(3).trim();
        id = Number.isFinite(Number(raw)) ? Number(raw) : null;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (!event) return null;
    let data = {};
    if (dataLines.length) {
      try { data = JSON.parse(dataLines.join('\n')); } catch { return null; }
    }
    return { id, event, data };
  }

  /** 轮次终态 → 找到绑定该线程的线路 → 出站。 */
  async function handleTurnFact(event, data) {
    // 只处理完成与失败；cancelled 是用户自己打断，不出站
    if (event !== 'thread.turn-completed' && event !== 'thread.turn-failed') return;
    const threadId = String(data?.threadId || '').trim();
    if (!threadId) return;

    const conn = findConnectionByThread(threadId);
    // 接线员线程的结果已由入站同步返回，出站只服务外部线程
    if (!conn || conn.boundTarget?.agentId === portalAgentId) return;

    const text = buildOutboundText({
      status: event === 'thread.turn-failed' ? 'failed' : 'completed',
      resultText: data?.resultText,
      error: data?.error,
    });
    await sendOutboundText(conn, threadId, text);
  }

  function findConnectionByThread(threadId) {
    for (const conn of connections.values()) {
      if (conn.boundTarget?.threadId === threadId) return conn;
    }
    return null;
  }

  async function sendOutboundText(conn, threadId, text) {
    const peer = peerByThread.get(threadId);
    if (!peer?.userId) {
      log(`线程 ${threadId} 的轮次结果无对端记录，跳过出站`, 'warn');
      return;
    }
    try {
      await sendViaFeature(conn.feature, conn.carrier, peer, text);
    } catch (error) {
      log(`线程 ${threadId} 结果出站失败: ${error?.message || error}`, 'error');
    }
  }

  /** 按渠道送出文本。QQ 的发送走 adapter 之外的 API client（若有）。 */
  async function sendViaFeature(feature, carrier, peer, text) {
    if (!feature) return;
    if (carrier === 'weixin') {
      await feature.apiClient?.sendTextMessage?.(peer.userId, text, peer.contextToken || '');
      return;
    }
    if (carrier === 'feishu') {
      await feature.sendTextMessage?.(peer.userId, peer.receiveIdType || 'open_id', text);
      return;
    }
    if (carrier === 'wecom') {
      await feature.sendTextMessage?.(peer.userId, text);
      return;
    }
    if (carrier === 'rokid') {
      await feature.sendTextMessage?.(peer.userId, text);
      return;
    }
    if (typeof feature.sendTextMessage === 'function') {
      await feature.sendTextMessage(peer.userId, text);
      return;
    }
    log(`渠道 ${carrier} 无可用发送入口`, 'warn');
  }

  /** 关闭全部连接与订阅（进程退出 / 测试收尾）。 */
  function close() {
    started = false;
    try { sseAbort?.abort(); } catch { /* 已断开 */ }
    sseAbort = null;
    // 放行重连等待，收尾不吊着一个定时器
    if (typeof reconnectWake === 'function') {
      const wake = reconnectWake;
      reconnectWake = null;
      wake();
    }
    for (const carrier of [...connections.keys()]) {
      void disconnectCarrier(carrier);
    }
  }

  return {
    connectLine,
    disconnectCarrier,
    syncLines,
    startOutboundListener,
    close,
    /** 线路快照（供接线员工具与调试）。 */
    snapshot: () => [...connections.values()].map((c) => ({
      lineId: c.lineId,
      carrier: c.carrier,
      boundTarget: c.boundTarget,
      connectedAt: c.connectedAt,
    })),
    supportedCarriers: () => getIMChannelIds(),
  };
}
