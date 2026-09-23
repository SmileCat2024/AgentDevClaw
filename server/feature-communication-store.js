const DEFAULT_EVENT_LIMIT = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function normalizeTarget(target = {}) {
  const values = ['agentId', 'sessionId', 'featureId', 'channelId'];
  const normalized = {};
  for (const key of values) {
    if (typeof target[key] !== 'string' || !target[key].trim()) {
      throw new TypeError(`${key} is required`);
    }
    normalized[key] = target[key].trim();
  }
  return normalized;
}

function targetKey(target) {
  const value = normalizeTarget(target);
  return JSON.stringify([value.agentId, value.sessionId, value.featureId, value.channelId]);
}

function sessionKey(agentId, sessionId) {
  return JSON.stringify([String(agentId || '').trim(), String(sessionId || '').trim()]);
}

export class FeatureCommunicationStore {
  constructor({ eventLimit = DEFAULT_EVENT_LIMIT, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.eventLimit = Math.max(1, Math.floor(eventLimit));
    this.requestTimeoutMs = requestTimeoutMs;
    this.channels = new Map();
    this.declarations = new Map();
    this.pendingRequests = new Map();
    this.listeners = new Map();
  }

  // A channel must be declared by its feature before any publish or subscribe;
  // the declaration is the host-managed authorization record for the channel.
  declareChannel(target, meta = {}) {
    const normalized = normalizeTarget(target);
    const key = targetKey(normalized);
    const declaration = {
      featureId: normalized.featureId,
      channelId: normalized.channelId,
      title: typeof meta.title === 'string' ? meta.title.trim() : '',
      description: typeof meta.description === 'string' ? meta.description.trim() : '',
      declaredAt: new Date().toISOString(),
    };
    const session = this.declarations.get(sessionKey(normalized.agentId, normalized.sessionId));
    if (session) session.set(key, declaration);
    else this.declarations.set(sessionKey(normalized.agentId, normalized.sessionId), new Map([[key, declaration]]));
    return { ...declaration };
  }

  isDeclared(target) {
    const session = this.declarations.get(sessionKey(target?.agentId, target?.sessionId));
    return session?.has(targetKey(target)) === true;
  }

  listChannels(agentId, sessionId) {
    const session = this.declarations.get(sessionKey(agentId, sessionId));
    if (!session) return [];
    const channels = [];
    for (const [key, declaration] of session) {
      const channel = this.channels.get(key);
      channels.push({
        featureId: declaration.featureId,
        channelId: declaration.channelId,
        title: declaration.title,
        description: declaration.description,
        declaredAt: declaration.declaredAt,
        hasSnapshot: Boolean(channel?.snapshot),
        lastEventId: channel?.eventId ?? 0,
      });
    }
    return channels;
  }

  _requireDeclared(target) {
    if (!this.isDeclared(target)) throw new Error('channel_not_declared');
  }

  _channel(target) {
    const key = targetKey(target);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { target: normalizeTarget(target), revision: 0, snapshot: null, eventId: 0, events: [] };
      this.channels.set(key, channel);
    }
    return channel;
  }

  publishSnapshot(target, data) {
    this._requireDeclared(target);
    const channel = this._channel(target);
    channel.revision += 1;
    channel.snapshot = { revision: channel.revision, data };
    const snapshot = { revision: channel.revision, data };
    const event = { eventId: ++channel.eventId, type: 'snapshot', data: snapshot };
    channel.events.push(event);
    if (channel.events.length > this.eventLimit) channel.events.splice(0, channel.events.length - this.eventLimit);
    this._notify(channel, event);
    return { ...snapshot };
  }

  getSnapshot(target) {
    const channel = this.channels.get(targetKey(target));
    return channel?.snapshot ? { ...channel.snapshot } : null;
  }

  publishEvent(target, type, data) {
    this._requireDeclared(target);
    if (typeof type !== 'string' || !type.trim()) throw new TypeError('event type is required');
    const channel = this._channel(target);
    const event = { eventId: ++channel.eventId, type: type.trim(), data };
    channel.events.push(event);
    if (channel.events.length > this.eventLimit) channel.events.splice(0, channel.events.length - this.eventLimit);
    this._notify(channel, event);
    return { ...event };
  }

  readEvents(target, afterEventId = 0) {
    const channel = this.channels.get(targetKey(target));
    if (!channel) return { resync: false, events: [] };
    const cursor = Number(afterEventId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > channel.eventId) {
      return { resync: true, events: [] };
    }
    const first = channel.events[0]?.eventId;
    if (first !== undefined && cursor < first - 1) return { resync: true, events: [] };
    return { resync: false, events: channel.events.filter((event) => event.eventId > cursor).map((event) => ({ ...event })) };
  }

  subscribe(target, listener) {
    const key = targetKey(target);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    const listeners = this.listeners.get(key);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  _notify(channel, event) {
    const listeners = this.listeners.get(targetKey(channel.target));
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener({ ...event }); } catch { /* a disconnected subscriber must not break publishers */ }
    }
  }

  beginRequest(target, requestId, { timeoutMs = this.requestTimeoutMs } = {}) {
    this._requireDeclared(target);
    const key = JSON.stringify([targetKey(target), requestId]);
    if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId is required');
    if (this.pendingRequests.has(key)) throw new Error('requestId is already pending');
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const timer = setTimeout(() => {
      this.pendingRequests.delete(key);
      settle({ ok: false, code: 'request_timeout', error: 'Feature request timed out' });
    }, timeoutMs);
    timer.unref?.();
    this.pendingRequests.set(key, { settle, timer });
    return promise;
  }

  resolveRequest(target, requestId, result) {
    const key = JSON.stringify([targetKey(target), requestId]);
    const pending = this.pendingRequests.get(key);
    if (!pending) return false;
    this.pendingRequests.delete(key);
    clearTimeout(pending.timer);
    pending.settle(result);
    return true;
  }

  closeSession(agentId, sessionId, error = 'Session runtime stopped') {
    for (const [key, channel] of this.channels) {
      if (channel.target.agentId === agentId && channel.target.sessionId === sessionId) {
        // Terminal notification first: connected SSE subscribers learn that the
        // channel (and its runtime) is gone instead of silent heartbeats.
        this._notify(channel, { eventId: channel.eventId, type: 'closed', data: null });
        this.channels.delete(key);
        this.listeners.delete(key);
      }
    }
    this.declarations.delete(sessionKey(agentId, sessionId));
    this.rejectRequestsForSession(agentId, sessionId, error);
  }

  rejectRequestsForSession(agentId, sessionId, error = 'Session runtime stopped') {
    for (const [key, pending] of this.pendingRequests) {
      const [serializedTarget] = JSON.parse(key);
      const [targetAgentId, targetSessionId] = JSON.parse(serializedTarget);
      if (targetAgentId !== agentId || targetSessionId !== sessionId) continue;
      this.pendingRequests.delete(key);
      clearTimeout(pending.timer);
      pending.settle({ ok: false, code: 'runtime_stopped', error });
    }
  }
}

export { normalizeTarget as normalizeFeatureCommunicationTarget };
