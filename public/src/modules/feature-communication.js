/* Host-side subscription and request adapter for Feature communication channels. */
(function () {
  'use strict';

  function targetQuery(target) {
    const params = new URLSearchParams();
    for (const key of ['agentId', 'sessionId', 'featureId', 'channelId']) {
      if (typeof target?.[key] !== 'string' || !target[key].trim()) throw new TypeError(`${key} is required`);
      params.set(key, target[key].trim());
    }
    return params.toString();
  }

  function subscribe(target, handlers = {}) {
    const source = new EventSource(`/protoclaw/feature-comms/stream?${targetQuery(target)}`);
    const receive = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const callback = handlers[event.type];
      if (event.type === 'event' && typeof handlers.eventType === 'function') handlers.eventType(data.type, data.data, data.eventId);
      if (typeof callback === 'function') callback(data.data ?? data, event.lastEventId);
    };
    for (const type of ['snapshot', 'resync', 'event']) source.addEventListener(type, receive);
    source.onerror = (error) => handlers.error?.(error);
    return () => source.close();
  }

  async function request(target, requestType, payload) {
    const response = await fetch('/protoclaw/feature-comms/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...target, requestType, payload }),
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) throw Object.assign(new Error(result?.error || result?.code || `HTTP ${response.status}`), { code: result?.code, status: response.status });
    return result.result;
  }

  window.ClawFeatureCommunication = { subscribe, request };
})();
