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

export class FeatureCommunicationStore {
  constructor({ eventLimit = DEFAULT_EVENT_LIMIT, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.eventLimit = Math.max(1, Math.floor(eventLimit));
    this.requestTimeoutMs = requestTimeoutMs;
    this.channels = new Map();
    this.pendingRequests = new Map();
    this.listeners = new Map();
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
        this.channels.delete(key);
        this.listeners.delete(key);
      }
    }
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
