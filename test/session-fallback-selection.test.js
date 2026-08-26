/**
 * Behavioral tests for PH fallback-session selection after archive/delete.
 *
 * selectFallbackSession picks the successor that archive/delete routes hand
 * to startManagedAgent. For PH-style workspaces the successor must be a
 * still-running session in the same project directory: picking a stopped
 * session would silently restart a runtime the user closed, and picking one
 * from another directory would hijack the view. Runtime liveness comes from
 * the managedAgents registry in agent-access.js, seeded here with fake
 * child-process entries (no real subprocesses involved).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { selectFallbackSession } from '../server/routes/session-helpers.js';
import { managedAgents, getManagedRuntimeKey } from '../server/shared/agent-access.js';

const PH_AGENT = 'programming-helper';
const OTHER_AGENT = 'agent-studio';
const DIR_A = 'D:\\code\\project-a';
const DIR_B = 'D:\\code\\project-b';

const seededRuntimeKeys = [];

function seedRuntime(agentId, sessionId, running) {
  const key = getManagedRuntimeKey(agentId, sessionId);
  managedAgents.set(key, {
    agentId,
    selectedSessionId: sessionId,
    process: { exitCode: running ? null : 0 },
    stopped: !running,
    stopping: false,
  });
  seededRuntimeKeys.push(key);
}

after(() => {
  for (const key of seededRuntimeKeys) {
    managedAgents.delete(key);
  }
});

describe('selectFallbackSession (PH workspace)', () => {
  it('prefers the newest still-running session in the same directory', () => {
    seedRuntime(PH_AGENT, 'a-old-running', true);
    seedRuntime(PH_AGENT, 'a-new-running', true);
    seedRuntime(PH_AGENT, 'a-archived-newest', true);
    const sessions = [
      { id: 'a-old-running', openDirectory: DIR_A, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'a-new-running', openDirectory: DIR_A, updatedAt: '2026-02-01T00:00:00Z' },
      { id: 'a-archived-newest', openDirectory: DIR_A, archived: true, updatedAt: '2026-03-01T00:00:00Z' },
    ];
    const fallback = selectFallbackSession(PH_AGENT, sessions, { openDirectory: DIR_A });
    assert.equal(fallback?.id, 'a-new-running');
  });

  it('returns null instead of resurrecting a stopped session when it is the only sibling', () => {
    seedRuntime(PH_AGENT, 'a-stopped-newest', false);
    seedRuntime(PH_AGENT, 'a-old-running', true);
    const sessions = [
      { id: 'a-stopped-newest', openDirectory: DIR_A, updatedAt: '2026-03-01T00:00:00Z' },
      { id: 'a-old-running', openDirectory: DIR_A, updatedAt: '2026-01-01T00:00:00Z' },
    ];
    const fallback = selectFallbackSession(PH_AGENT, sessions, { openDirectory: DIR_A });
    assert.equal(fallback?.id, 'a-old-running');
  });

  it('returns null when every remaining session in the directory is stopped', () => {
    seedRuntime(PH_AGENT, 'a-stopped', false);
    seedRuntime(PH_AGENT, 'b-running', true);
    const sessions = [
      { id: 'a-stopped', openDirectory: DIR_A, updatedAt: '2026-03-01T00:00:00Z' },
      { id: 'b-running', openDirectory: DIR_B, updatedAt: '2026-02-01T00:00:00Z' },
    ];
    const fallback = selectFallbackSession(PH_AGENT, sessions, { openDirectory: DIR_A });
    assert.equal(fallback, null);
  });

  it('returns null when no candidate has a runtime at all (server restart wiped runtimes)', () => {
    const sessions = [
      { id: 'a-no-runtime', openDirectory: DIR_A, updatedAt: '2026-01-01T00:00:00Z' },
    ];
    const fallback = selectFallbackSession(PH_AGENT, sessions, { openDirectory: DIR_A });
    assert.equal(fallback, null);
  });
});

describe('selectFallbackSession (non-PH workspace)', () => {
  it('keeps newest non-archived semantics regardless of runtime state', () => {
    const sessions = [
      { id: 's-old', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 's-new', updatedAt: '2026-02-01T00:00:00Z' },
      { id: 's-archived', archived: true, updatedAt: '2026-03-01T00:00:00Z' },
    ];
    const fallback = selectFallbackSession(OTHER_AGENT, sessions, {});
    assert.equal(fallback?.id, 's-new');
  });
});
