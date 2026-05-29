/**
 * Runtime CallEnvelope & RuntimeInbox foundation
 *
 * This module provides the unified data model for "a call request entering a
 * runtime" regardless of source (dispatch, viewer-input, IM, system).
 *
 * Intended lifecycle:
 *   1. A source creates a CallEnvelope via `createCallEnvelope()`.
 *   2. The envelope is enqueued into the target runtime's inbox via
 *      `enqueueRuntimeEnvelope()`.
 *   3. A CallArbiter (future — guide #3) dequeues via `dequeueRuntimeEnvelope()`
 *      and drives `agent.onCall()`.
 *   4. The envelope status is updated to `completed` or `failed`.
 *
 * This module does NOT replace the existing `dispatchQueue` in this iteration.
 * It coexists as a parallel track that a later arbiter migration can switch to.
 */

import { randomUUID } from 'crypto';

// ── CallEnvelope status constants ──────────────────────────────

export const EnvelopeStatus = Object.freeze({
  PENDING:   'pending',
  QUEUED:    'queued',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
});

// ── Source type constants ──────────────────────────────────────

export const EnvelopeSource = Object.freeze({
  DISPATCH:     'dispatch',
  VIEWER_INPUT: 'viewer-input',
  QUEUED_INPUT: 'queued-input',
  QQ:           'qq',
  WEIXIN:       'weixin',
  SYSTEM:       'system',
});

// ── Delivery mode constants ────────────────────────────────────

export const DeliveryMode = Object.freeze({
  POLL:    'poll',     // long-poll by runtime
  DIRECT:  'direct',   // immediate onCall
  DEFERRED: 'deferred', // queued until arbiter picks up
});

// ── Reply policy constants ─────────────────────────────────────

export const ReplyPolicy = Object.freeze({
  NONE:         'none',
  ORIGIN_ONLY:  'origin-only',
  ALL_CHANNELS: 'all-channels',
  CALLBACK:     'callback',
});

// ── CallEnvelope factory ───────────────────────────────────────

/**
 * Create a new CallEnvelope with normalised fields.
 *
 * @param {object} params
 * @param {string} params.runtimeKey  - `agentId::sessionId` key
 * @param {string} [params.agentId]   - agent identifier
 * @param {string} [params.sessionId] - session identifier
 * @param {string} params.source      - one of EnvelopeSource
 * @param {string} [params.sourceRef] - opaque ref from the source (e.g. scheduleId)
 * @param {string} params.text        - the message / prompt text
 * @param {string} [params.deliveryMode] - default 'poll'
 * @param {string} [params.replyPolicy]  - default 'none'
 * @returns {object} CallEnvelope
 */
export function createCallEnvelope(params = {}) {
  const now = Date.now();

  const envelope = {
    id: `env-${randomUUID()}`,
    runtimeKey: params.runtimeKey || '',
    agentId: params.agentId || '',
    sessionId: params.sessionId || '',
    source: params.source || EnvelopeSource.SYSTEM,
    sourceRef: params.sourceRef || '',
    text: typeof params.text === 'string' ? params.text : '',
    createdAt: now,
    status: EnvelopeStatus.PENDING,
    deliveryMode: params.deliveryMode || DeliveryMode.POLL,
    replyPolicy: params.replyPolicy || ReplyPolicy.NONE,
    result: null,
    error: null,
  };
  envelopeRegistry.set(envelope.id, envelope);
  return envelope;
}

// ── RuntimeInbox registry ──────────────────────────────────────

/**
 * In-memory map: runtimeKey → { queue, activeEnvelopeId, updatedAt }
 *
 * `queue` is an array of CallEnvelope objects awaiting processing.
 * `activeEnvelopeId` is the id of the envelope currently being processed
 *   (null when the runtime is idle).
 * `updatedAt` is the timestamp of the last queue mutation.
 */
const runtimeInboxes = new Map();
const envelopeRegistry = new Map();
const TERMINAL_ENVELOPE_STATUSES = new Set([
  EnvelopeStatus.COMPLETED,
  EnvelopeStatus.FAILED,
  EnvelopeStatus.CANCELLED,
]);

/**
 * Ensure an inbox exists for the given runtimeKey.
 *
 * @param {string} runtimeKey
 * @returns {object} The inbox structure
 */
export function ensureRuntimeInbox(runtimeKey) {
  let inbox = runtimeInboxes.get(runtimeKey);
  if (!inbox) {
    inbox = { queue: [], activeEnvelopeId: null, updatedAt: Date.now() };
    runtimeInboxes.set(runtimeKey, inbox);
  }
  return inbox;
}

/**
 * Enqueue a CallEnvelope into its target runtime's inbox.
 *
 * @param {object} envelope - A CallEnvelope created by createCallEnvelope()
 * @returns {object} The envelope (mutated: status set to 'queued')
 */
export function enqueueRuntimeEnvelope(envelope) {
  const inbox = ensureRuntimeInbox(envelope.runtimeKey);
  envelope.status = EnvelopeStatus.QUEUED;
  inbox.queue.push(envelope);
  inbox.updatedAt = Date.now();
  return envelope;
}

/**
 * Peek at the front of a runtime's inbox without removing it.
 *
 * @param {string} runtimeKey
 * @returns {object|null} The front envelope, or null if empty / no inbox
 */
export function peekRuntimeEnvelope(runtimeKey) {
  const inbox = runtimeInboxes.get(runtimeKey);
  if (!inbox || inbox.queue.length === 0) return null;
  return inbox.queue[0];
}

/**
 * Dequeue the front envelope from a runtime's inbox.
 *
 * The caller (future arbiter) is responsible for setting
 * `inbox.activeEnvelopeId` to the dequeued envelope's id and updating
 * the envelope status to `delivered`.
 *
 * @param {string} runtimeKey
 * @returns {object|null} The dequeued envelope, or null if empty / no inbox
 */
export function dequeueRuntimeEnvelope(runtimeKey) {
  const inbox = runtimeInboxes.get(runtimeKey);
  if (!inbox || inbox.queue.length === 0) return null;
  const envelope = inbox.queue.shift();
  inbox.activeEnvelopeId = envelope.id;
  inbox.updatedAt = Date.now();
  return envelope;
}

/**
 * Get a serialisable snapshot of a runtime's inbox state.
 *
 * @param {string} runtimeKey
 * @returns {object} Snapshot with queueLength, activeEnvelopeId, envelopes, updatedAt
 */
export function getRuntimeInboxSnapshot(runtimeKey) {
  const inbox = runtimeInboxes.get(runtimeKey);
  if (!inbox) {
    return {
      runtimeKey,
      queueLength: 0,
      activeEnvelopeId: null,
      envelopes: [],
      updatedAt: null,
    };
  }

  return {
    runtimeKey,
    queueLength: inbox.queue.length,
    activeEnvelopeId: inbox.activeEnvelopeId,
    envelopes: inbox.queue.map((e) => ({
      id: e.id,
      source: e.source,
      sourceRef: e.sourceRef,
      text: e.text ? (e.text.length > 80 ? e.text.slice(0, 80) + '...' : e.text) : '',
      status: e.status,
      createdAt: e.createdAt,
    })),
    updatedAt: inbox.updatedAt,
  };
}

/**
 * Update the status/result of an envelope across all inboxes.
 *
 * This scans for the envelope by id. In the common case the caller already
 * knows which runtimeKey owns it, so a direct inbox lookup would be faster.
 * This convenience helper is provided for cross-cutting status updates
 * (e.g. dispatch respond endpoint).
 *
 * @param {string} envelopeId
 * @param {object} update - { status?, result?, error? }
 * @returns {object|null} The updated envelope, or null if not found
 */
export function updateEnvelopeStatus(envelopeId, update = {}) {
  const registered = envelopeRegistry.get(envelopeId) || null;
  if (registered) {
    if (update.status) registered.status = update.status;
    if (update.result !== undefined) registered.result = update.result;
    if (update.error !== undefined) registered.error = update.error;
  }

  for (const [, inbox] of runtimeInboxes) {
    // Check active envelope
    if (inbox.activeEnvelopeId === envelopeId) {
      if (update.status && TERMINAL_ENVELOPE_STATUSES.has(update.status)) {
        inbox.activeEnvelopeId = null;
      }
      inbox.updatedAt = Date.now();
      return registered || { id: envelopeId, status: update.status || EnvelopeStatus.COMPLETED, updatedAt: Date.now() };
    }
    // Check queue
    for (let i = 0; i < inbox.queue.length; i++) {
      const env = inbox.queue[i];
      if (env.id === envelopeId) {
        if (update.status) env.status = update.status;
        if (update.result !== undefined) env.result = update.result;
        if (update.error !== undefined) env.error = update.error;
        if (update.status && TERMINAL_ENVELOPE_STATUSES.has(update.status)) {
          inbox.queue.splice(i, 1);
        }
        inbox.updatedAt = Date.now();
        return env;
      }
    }
  }
  return registered;
}

// ── Runtime execution state (lightweight, for future arbiter) ──

/**
 * Per-runtime lightweight state container that tracks whether the runtime
 * is currently processing a call, how many envelopes are queued, and when
 * the last state change happened.
 */
const runtimeExecutionStates = new Map();

/**
 * Get or create the execution state for a runtime.
 *
 * @param {string} runtimeKey
 * @returns {object} { status, activeEnvelopeId, queueLength, lastActiveAt, updatedAt }
 */
export function getRuntimeExecutionState(runtimeKey) {
  let state = runtimeExecutionStates.get(runtimeKey);
  if (!state) {
    state = {
      runtimeKey,
      status: 'idle',           // idle | queued | running
      activeEnvelopeId: null,
      queueLength: 0,
      lastActiveAt: null,
      updatedAt: Date.now(),
    };
    runtimeExecutionStates.set(runtimeKey, state);
  }
  return state;
}

/**
 * Refresh the execution state from the inbox snapshot.
 *
 * Call this after enqueue / dequeue / status changes so the execution
 * state stays in sync with the inbox.
 *
 * @param {string} runtimeKey
 * @returns {object} Updated state
 */
export function refreshRuntimeExecutionState(runtimeKey) {
  const state = getRuntimeExecutionState(runtimeKey);
  const snapshot = getRuntimeInboxSnapshot(runtimeKey);

  state.queueLength = snapshot.queueLength;
  state.activeEnvelopeId = snapshot.activeEnvelopeId;

  if (state.activeEnvelopeId) {
    state.status = 'running';
    state.lastActiveAt = Date.now();
  } else if (state.queueLength > 0) {
    state.status = 'queued';
  } else {
    state.status = 'idle';
  }
  state.updatedAt = Date.now();

  return state;
}

/**
 * Get all runtime execution states as a flat array.
 *
 * @returns {Array<object>}
 */
export function listRuntimeExecutionStates() {
  return Array.from(runtimeExecutionStates.values());
}

// ── Lookup helpers ─────────────────────────────────────────────

/**
 * Find an envelope by id across all inboxes.
 *
 * @param {string} envelopeId
 * @returns {object|null} The envelope or null
 */
export function findEnvelopeById(envelopeId) {
  return envelopeRegistry.get(envelopeId) || null;
}

/**
 * Find all envelopes for a given sourceRef (e.g. a scheduleId).
 *
 * @param {string} sourceRef
 * @returns {Array<object>}
 */
export function findEnvelopesBySourceRef(sourceRef) {
  return Array.from(envelopeRegistry.values()).filter((env) => env.sourceRef === sourceRef);
}

/**
 * Clear all inbox state (for testing / reset).
 */
export function resetAllInboxes() {
  runtimeInboxes.clear();
  runtimeExecutionStates.clear();
  envelopeRegistry.clear();
}
