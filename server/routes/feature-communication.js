import { randomUUID } from 'node:crypto';
import { getAgentRuntime } from '../shared/agent-access.js';
import { isAuthEnabled, resolveRequestAuth } from '../auth.js';
import { FeatureCommunicationStore, normalizeFeatureCommunicationTarget } from '../feature-communication-store.js';

export const featureCommunicationStore = new FeatureCommunicationStore();
const MAX_PAYLOAD_BYTES = 256 * 1024;

function badRequest(res, message) {
  return res.status(400).json({ ok: false, code: 'invalid_request', error: message });
}

function notDeclared(res) {
  return res.status(404).json({ ok: false, code: 'channel_not_declared', error: 'Channel is not declared by its feature' });
}

// Declaration is the host-managed authorization record: a channel only becomes
// readable (and publishable) after its feature declared it on a live runtime.
function requireDeclaredTarget(store, target, res) {
  if (!store.isDeclared(target)) { notDeclared(res); return false; }
  return true;
}

export function setupFeatureCommunicationRoutes(app, express, { communicationStore = featureCommunicationStore, requestTimeoutMs } = {}) {
  app.post('/protoclaw/feature-comms/declare', express.json({ limit: '16kb' }), async (req, res) => {
    // Internal auth is verified from the request itself (resolveRequestAuth), so
    // runtime calls keep working when host auth is disabled and the global
    // middleware never populates req.auth.
    if (resolveRequestAuth(req)?.kind !== 'internal') return res.status(403).json({ ok: false, code: 'internal_only' });
    const body = req.body || {};
    let target;
    try {
      const sessionId = String(body.sessionId || '').trim();
      const runtime = getAgentRuntime(String(body.agentId || '').trim(), sessionId);
      if (!runtime || !runtime.process || runtime.stopped) return res.status(404).json({ ok: false, code: 'runtime_not_found' });
      target = normalizeFeatureCommunicationTarget({ agentId: runtime.agentId || runtime.id, sessionId, featureId: body.featureId, channelId: body.channelId });
    } catch (error) { return badRequest(res, error.message); }
    const declaration = communicationStore.declareChannel(target, {
      title: typeof body.title === 'string' ? body.title.slice(0, 200) : '',
      description: typeof body.description === 'string' ? body.description.slice(0, 500) : '',
    });
    return res.json({ ok: true, declaration });
  });

  app.get('/protoclaw/feature-comms/channels', (req, res) => {
    if (isAuthEnabled() && resolveRequestAuth(req)?.kind !== 'session') return res.status(401).end();
    const agentId = String(req.query?.agentId || '').trim();
    const sessionId = String(req.query?.sessionId || '').trim();
    if (!agentId || !sessionId) return badRequest(res, 'agentId and sessionId are required');
    return res.json({ ok: true, channels: communicationStore.listChannels(agentId, sessionId) });
  });

  app.post('/protoclaw/feature-comms/publish', express.json({ limit: '256kb' }), async (req, res) => {
    if (resolveRequestAuth(req)?.kind !== 'internal') return res.status(403).json({ ok: false, code: 'internal_only' });
    const body = req.body || {};
    let target;
    try {
      const sessionId = String(body.sessionId || '').trim();
      const runtime = getAgentRuntime(String(body.agentId || '').trim(), sessionId);
      if (!runtime || !runtime.process || runtime.stopped) return res.status(404).json({ ok: false, code: 'runtime_not_found' });
      target = normalizeFeatureCommunicationTarget({ agentId: runtime.agentId || runtime.id, sessionId, featureId: body.featureId, channelId: body.channelId });
    } catch (error) { return badRequest(res, error.message); }
    if (!communicationStore.isDeclared(target)) return notDeclared(res);
    const bytes = Buffer.byteLength(JSON.stringify(body.data ?? null), 'utf8');
    if (bytes > MAX_PAYLOAD_BYTES) return res.status(413).json({ ok: false, code: 'payload_too_large' });
    let result;
    try {
      if (body.kind === 'snapshot') result = communicationStore.publishSnapshot(target, body.data ?? null);
      else if (body.kind === 'event') result = communicationStore.publishEvent(target, body.eventType, body.data ?? null);
      else return badRequest(res, 'kind must be snapshot or event');
    } catch (error) {
      if (error?.message === 'channel_not_declared') return notDeclared(res);
      return badRequest(res, error.message);
    }
    return res.json({ ok: true, ...result });
  });

  app.get('/protoclaw/feature-comms/stream', (req, res) => {
    // Session requirement applies only when host auth is enabled; with auth
    // disabled the middleware never sets req.auth and every browser session is
    // trusted (same posture as the rest of the protected surface).
    if (isAuthEnabled() && resolveRequestAuth(req)?.kind !== 'session') return res.status(401).end();
    let target;
    try { target = normalizeFeatureCommunicationTarget(req.query || {}); }
    catch (error) { return badRequest(res, error.message); }
    if (!requireDeclaredTarget(communicationStore, target, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders?.();
    const frame = (event) => `id: ${event.eventId}\nevent: ${event.type === 'snapshot' ? 'snapshot' : 'event'}\ndata: ${JSON.stringify(event)}\n\n`;
    const cursor = Number(req.headers['last-event-id'] ?? req.query?.afterEventId ?? 0);
    const snapshot = communicationStore.getSnapshot(target);
    const replay = communicationStore.readEvents(target, cursor);
    if (snapshot && replay.resync) res.write(`event: resync\ndata: ${JSON.stringify(snapshot)}\n\n`);
    else for (const event of replay.events) res.write(frame(event));
    let closed = false;
    const unsubscribe = communicationStore.subscribe(target, (event) => {
      if (closed) return;
      if (event.type === 'closed') {
        closed = true;
        res.write(`event: closed\ndata: {}\n\n`);
        res.end();
        return;
      }
      res.write(frame(event));
    });
    let heartbeat;
    const cleanup = () => { if (heartbeat) clearInterval(heartbeat); unsubscribe(); };
    heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { cleanup(); } }, 15_000);
    heartbeat.unref?.();
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.get('/protoclaw/feature-comms/snapshot', (req, res) => {
    let target;
    try { target = normalizeFeatureCommunicationTarget(req.query || {}); }
    catch (error) { return badRequest(res, error.message); }
    if (!requireDeclaredTarget(communicationStore, target, res)) return;
    return res.json({ ok: true, snapshot: communicationStore.getSnapshot(target) });
  });

  app.get('/protoclaw/feature-comms/events', (req, res) => {
    let target;
    try { target = normalizeFeatureCommunicationTarget(req.query || {}); }
    catch (error) { return badRequest(res, error.message); }
    if (!requireDeclaredTarget(communicationStore, target, res)) return;
    return res.json({ ok: true, ...communicationStore.readEvents(target, req.query?.afterEventId ?? 0) });
  });

  app.post('/protoclaw/feature-comms/request', express.json({ limit: '128kb' }), async (req, res) => {
    if (isAuthEnabled() && resolveRequestAuth(req)?.kind !== 'session') return res.status(403).json({ ok: false, code: 'user_session_required' });
    const body = req.body || {};
    if (typeof body.requestType !== 'string' || !body.requestType.trim()) return badRequest(res, 'requestType is required');
    let target;
    try { target = normalizeFeatureCommunicationTarget(body); }
    catch (error) { return badRequest(res, error.message); }
    if (!communicationStore.isDeclared(target)) return notDeclared(res);
    const runtime = getAgentRuntime(target.agentId, target.sessionId);
    if (!runtime || runtime.stopped || !runtime.process || runtime.process.exitCode !== null) return res.status(503).json({ ok: false, code: 'runtime_not_connected' });
    const requestId = randomUUID();
    const pending = communicationStore.beginRequest(target, requestId, { timeoutMs: requestTimeoutMs });
    const message = { type: 'feature-comms-request', requestId, featureId: target.featureId, channelId: target.channelId, requestType: body.requestType, payload: body.payload ?? null, __targetSessionId: target.sessionId };
    const onMessage = (reply) => {
      if (reply?.type !== 'feature-comms-result' || reply.requestId !== requestId || reply.sessionId !== target.sessionId) return;
      communicationStore.resolveRequest(target, requestId, reply.result ?? { ok: reply.ok === true, error: reply.error });
    };
    runtime.process.on('message', onMessage);
    const cleanup = () => runtime.process.removeListener('message', onMessage);
    try {
      if (runtime.process.send(message) === false) communicationStore.resolveRequest(target, requestId, { ok: false, code: 'delivery_failed' });
      const result = await pending;
      cleanup();
      return res.status(result?.ok === false ? 502 : 200).json({ ok: result?.ok !== false, result });
    } catch (error) { cleanup(); throw error; }
  });

  return communicationStore;
}
