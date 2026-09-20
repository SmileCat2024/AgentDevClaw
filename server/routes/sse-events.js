/**
 * SSE 推送通道：ViewerWorker 会话事件 → 浏览器。
 *
 * 设计依据 docs/sse-migration-bcd-preparation.md §4：
 * - 事件经全局合并窗口（默认 250ms）去抖后组装快照 payload（与 GET 端点
 *   同构），同一 (kind, agentId) 窗口内只发最后一帧；快照在 flush 时组装，
 *   被合并掉的中间事件不浪费组装开销
 * - eid 单调递增 + 环形缓冲（默认 512 帧）支持 Last-Event-ID 重放；缓冲
 *   超界或 eid 大于当前值（服务端重启归零）发 resync 信号，客户端回退
 *   一次全量拉取
 * - 连接时序（无丢帧无重复）：注册连接（live=false，publish 只进环形缓冲
 *   不直写）→ 同步重放 → hello → live=true；publish 与重放同线程同步执行，
 *   天然互斥
 * - 心跳为 SSE 注释帧（不触发客户端事件、不动 lastEventId），写失败即清理
 * - 兼容性：X-Accel-Buffering: no 禁用 Nginx 代理缓冲；compression 需配合
 *   createSseCompressionFilter 排除 text/event-stream（见 server.js 挂载点）
 * - 启动探测：worker 无 onSessionEvent（旧框架）时端点返回 501，前端推送
 *   特性整体关闭、保持轮询
 */

export const SSE_DEFAULTS = {
  coalesceMs: 250,
  heartbeatMs: 15000,
  ringSize: 512,
  maxClients: 64,
};

/**
 * compression 过滤器：SSE 响应绝不压缩（压缩会滞留事件帧），其余交给
 * compression 自带的默认 filter。
 */
export function createSseCompressionFilter(baseFilter) {
  return (req, res) => {
    const type = res.getHeader('Content-Type');
    if (typeof type === 'string' && type.startsWith('text/event-stream')) return false;
    return baseFilter(req, res);
  };
}

export function createSseEventsModule(deps = {}) {
  const {
    viewerWorker,
    coalesceMs = SSE_DEFAULTS.coalesceMs,
    heartbeatMs = SSE_DEFAULTS.heartbeatMs,
    ringSize = SSE_DEFAULTS.ringSize,
    maxClients = SSE_DEFAULTS.maxClients,
  } = deps;

  const supported = !!viewerWorker && typeof viewerWorker.onSessionEvent === 'function';

  // ── 全局发布管线（所有连接共享）──
  let eidSeq = 0;
  const ring = []; // [{ eid, frame }]，frame 为已序列化 SSE 文本
  const pendingByAgent = new Map(); // `${kind}:${agentId}` -> 合并窗口条目
  const clients = new Set();

  function formatFrame(eid, eventName, data) {
    return `id: ${eid}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** 组装单点：与 GET 端点同构的快照（worker 内部 GET 走同一实现）。 */
  function snapshotPayload(kind, agentId) {
    switch (kind) {
      case 'notification': return viewerWorker.getNotificationSnapshot(agentId);
      case 'overview': return viewerWorker.getOverviewSnapshot(agentId);
      case 'todo': return viewerWorker.getTodoSnapshot(agentId);
      case 'input-requests': return viewerWorker.getInputRequestsSnapshot(agentId);
      case 'queued-inputs': return viewerWorker.getQueuedInputsSnapshot(agentId);
      default: return null;
    }
  }

  function publish(eventName, data) {
    const eid = ++eidSeq;
    const frame = formatFrame(eid, eventName, data);
    ring.push({ eid, frame });
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    for (const conn of clients) {
      if (conn.live) writeConn(conn, frame);
    }
    return eid;
  }

  function flushPending(entry) {
    pendingByAgent.delete(entry.key);
    try {
      if (entry.kind === 'connection') {
        publish('connection', {
          kind: 'connection', agentId: entry.agentId,
          connected: entry.connected, reconnected: entry.reconnected,
        });
        return;
      }
      if (entry.kind === 'messages') {
        publish('messages', { kind: 'messages', agentId: entry.agentId, probe: entry.probe });
        return;
      }
      const snapshot = snapshotPayload(entry.kind, entry.agentId);
      if (snapshot == null) return; // agent 已不存在：connection 事件已覆盖清理
      publish(entry.kind, { kind: entry.kind, agentId: entry.agentId, data: snapshot });
    } catch (err) {
      // 组装失败只丢这一帧：快照方法不应抛错，真抛了也不该断掉整条管线
      console.warn(`[sse-events] flush ${entry.kind}:${entry.agentId} failed:`, err?.message || err);
    }
  }

  function onWorkerEvent(event) {
    if (!event || typeof event.kind !== 'string') return;
    const key = `${event.kind}:${event.agentId}`;
    const existing = pendingByAgent.get(key);
    if (existing) {
      // 窗口内后到事件覆盖先到：中间态不值得逐帧送达
      if (event.kind === 'messages') existing.probe = event.probe;
      if (event.kind === 'connection') {
        existing.connected = event.connected;
        existing.reconnected = existing.reconnected || !!event.reconnected;
      }
      return;
    }
    const entry = {
      key, kind: event.kind, agentId: event.agentId,
      probe: event.probe, connected: event.connected,
      reconnected: !!event.reconnected,
    };
    entry.timer = setTimeout(() => flushPending(entry), coalesceMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    pendingByAgent.set(key, entry);
  }

  /** bell 双入口之一：首连快照扫描当前挂起的 choice 请求（另一入口为后续事件）。 */
  function scanChoiceAlerts() {
    const alerts = [];
    let agents;
    try { agents = viewerWorker.listAgentStates() || []; } catch { return alerts; }
    for (const agent of agents) {
      if (!agent || agent.connected === false) continue;
      try {
        const leases = viewerWorker.getInputRequestsSnapshot(agent.id);
        if (!Array.isArray(leases)) continue;
        for (const lease of leases) {
          const isChoice = lease && lease.mode === 'choices'
            && Array.isArray(lease.questions) && lease.questions.length > 0
            && typeof lease.requestId === 'string';
          if (isChoice) {
            alerts.push({
              requestId: lease.requestId,
              agentId: agent.id,
              agentName: agent.name || agent.id,
            });
          }
        }
      } catch { /* skip individual agent errors */ }
    }
    return alerts;
  }

  function agentSummaries() {
    try {
      return viewerWorker.listAgentStates() || [];
    } catch { return []; }
  }

  function writeConn(conn, text) {
    if (conn.closed || conn.res.writableEnded || conn.res.destroyed) return false;
    if (conn.res.socket && conn.res.socket.destroyed) return false;
    try { return conn.res.write(text); } catch { return false; }
  }

  function closeConn(conn) {
    if (conn.closed) return;
    conn.closed = true;
    conn.live = false;
    if (conn.hbTimer) clearInterval(conn.hbTimer);
    clients.delete(conn);
    if (!conn.res.writableEnded) { try { conn.res.end(); } catch { /* already gone */ } }
  }

  function handleEvents(req, res) {
    if (!supported) {
      res.status(501).json({ error: 'sse-unsupported' });
      return;
    }
    if (clients.size >= maxClients) {
      res.status(503).json({ error: 'sse_unavailable', maxClients });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n');

    const conn = { req, res, live: false, closed: false, hbTimer: null };
    clients.add(conn);

    // 重放决策。与 publish 同线程同步执行：注册后到 live 放行之间，任何
    // publish 只会进环形缓冲（live=false 不直写），由下方重放统一补齐。
    let replay = [];
    let resync = false;
    const rawHeader = req.headers['last-event-id'];
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : (rawHeader ?? req.query?.lastEventId);
    const lastEventId = Number(raw);
    if (Number.isInteger(lastEventId)) {
      if (lastEventId !== eidSeq) {
        // 需要的帧是 (lastEventId, eidSeq]，缓冲起始 eid <= lastEventId+1 才完整
        if (lastEventId < 0 || lastEventId > eidSeq
          || ring.length === 0 || ring[0].eid > lastEventId + 1) {
          resync = true;
        } else {
          replay = ring.filter((f) => f.eid > lastEventId);
        }
      }
    }
    if (resync) {
      res.write(formatFrame(eidSeq, 'resync', {
        reason: lastEventId > eidSeq ? 'eid-from-newer-server' : 'ring-overflow',
      }));
    }
    for (const f of replay) res.write(f.frame);

    // hello 收尾：id 取当前 eidSeq，客户端断线重连带该值即可从此处续传
    res.write(formatFrame(eidSeq, 'hello', {
      hello: true,
      resynced: resync,
      resumed: replay.length > 0,
      heartbeatMs,
      coalesceMs,
      choiceAlerts: scanChoiceAlerts(),
      agents: agentSummaries(),
    }));

    conn.hbTimer = setInterval(() => {
      if (!writeConn(conn, ': hb\n\n')) closeConn(conn);
    }, heartbeatMs);
    if (typeof conn.hbTimer.unref === 'function') conn.hbTimer.unref();
    conn.live = true;
    req.on('close', () => closeConn(conn));
    res.on('error', () => closeConn(conn));
  }

  const unsubscribe = supported ? viewerWorker.onSessionEvent(onWorkerEvent) : null;

  return {
    setupRoutes(app) {
      app.get('/protoclaw/events', handleEvents);
    },
    /** 收口：清合并窗口、通知客户端 shutdown、结束全部连接。 */
    closeAll() {
      for (const entry of pendingByAgent.values()) clearTimeout(entry.timer);
      pendingByAgent.clear();
      for (const conn of [...clients]) {
        if (!conn.res.writableEnded) writeConn(conn, formatFrame(eidSeq, 'shutdown', {}));
        closeConn(conn);
      }
      if (typeof unsubscribe === 'function') unsubscribe();
    },
    stats() {
      return {
        supported, eidSeq,
        ringFrames: ring.length,
        clients: clients.size,
        pending: pendingByAgent.size,
        coalesceMs, heartbeatMs,
      };
    },
  };
}
