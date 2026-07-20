import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  SIDEBAR_DIAGNOSTIC_FILE,
  createSidebarDiagnosticWriter,
  sanitizeSidebarDiagnosticEvent,
} from '../server/shared/sidebar-diagnostics.js';
import { setupSidebarDiagnosticsRoutes } from '../server/routes/sidebar-diagnostics.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidebar-diagnostics-'));
  tempDirs.push(dir);
  return dir;
}

describe('sidebar diagnostic event sanitization', () => {
  it('keeps only bounded diagnostic fields and drops content/path/secrets', () => {
    const now = Date.parse('2026-07-19T14:00:00.000Z');
    const event = sanitizeSidebarDiagnosticEvent({
      timestamp: now,
      source: 'forged',
      kind: 'operation_phase',
      operationId: ' summary:test /unsafe ',
      operation: 'summary session',
      phase: 'target ready',
      agentId: 'programming-helper',
      sourceSessionId: 'session-1',
      targetSessionId: 'session-2',
      elapsedMs: 123.4567,
      sessionCount: Number.MAX_SAFE_INTEGER,
      title: 'private title',
      projectDir: 'D:\\private\\project',
      message: 'private conversation body',
      authorization: 'Bearer secret',
      errorMessage: 'C:\\private\\stack',
    }, { source: 'client', now: () => now });

    assert.equal(event.source, 'client');
    assert.equal(event.operationId, 'summary:testunsafe');
    assert.equal(event.operation, 'summarysession');
    assert.equal(event.phase, 'targetready');
    assert.equal(event.elapsedMs, 123.457);
    assert.equal(event.sessionCount, 10_000_000);
    for (const forbidden of ['title', 'projectDir', 'message', 'authorization', 'errorMessage']) {
      assert.equal(Object.hasOwn(event, forbidden), false);
    }
  });

  it('rejects records without a stable operation and phase', () => {
    assert.equal(sanitizeSidebarDiagnosticEvent({ operation: '', phase: 'started' }), null);
    assert.equal(sanitizeSidebarDiagnosticEvent({ operation: 'summary', phase: '' }), null);
  });
});

describe('sidebar diagnostic JSONL writer', () => {
  it('persists sanitized JSONL and rotates within bounded file counts', async () => {
    const rootDir = await createTempDir();
    let now = Date.parse('2026-07-19T14:00:00.000Z');
    const writer = createSidebarDiagnosticWriter({
      rootDir,
      maxFileBytes: 1024,
      maxArchivedFiles: 2,
      retentionDays: 7,
      now: () => now++,
    });

    for (let index = 0; index < 40; index += 1) {
      await writer.append({
        kind: 'operation_phase',
        operationId: `summary:${index}`,
        operation: 'summary',
        phase: 'target_runtime_ready',
        elapsedMs: index * 10,
        message: 'must not persist',
      }, { source: 'server' });
    }
    await writer.flush();

    const names = await fs.readdir(rootDir);
    const archived = names.filter((name) => name !== SIDEBAR_DIAGNOSTIC_FILE);
    assert.ok(names.includes(SIDEBAR_DIAGNOSTIC_FILE));
    assert.ok(archived.length <= 2);

    const activeLines = (await fs.readFile(path.join(rootDir, SIDEBAR_DIAGNOSTIC_FILE), 'utf8'))
      .trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(activeLines.length > 0);
    assert.equal(activeLines.every((event) => event.operation === 'summary'), true);
    assert.equal(activeLines.every((event) => !Object.hasOwn(event, 'message')), true);
    assert.ok((await fs.stat(path.join(rootDir, SIDEBAR_DIAGNOSTIC_FILE))).size <= 1024);
  });
});

describe('sidebar diagnostics routes', () => {
  it('accepts a bounded client batch and exposes non-sensitive status', async () => {
    const routes = new Map();
    const received = [];
    const writer = {
      append: async (events, defaults) => {
        received.push({ events, defaults });
        return events.length;
      },
      status: () => ({
        enabled: true,
        schemaVersion: 1,
        directory: 'C:\\private',
        activeFile: 'C:\\private\\sidebar-events.jsonl',
        maxFileBytes: 1024,
        retentionDays: 7,
        maxArchivedFiles: 2,
      }),
    };
    const app = {
      post(pathname, ...handlers) { routes.set(`POST ${pathname}`, handlers.at(-1)); },
      get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    };
    const express = { json: () => (_req, _res, next) => next() };
    setupSidebarDiagnosticsRoutes(app, express, { writer });

    let postResult = null;
    await routes.get('POST /protoclaw/sidebar_diagnostics/events')(
      { body: { events: [{ operation: 'summary', phase: 'requested' }] } },
      { json(value) { postResult = value; } },
      (error) => { throw error; },
    );
    assert.deepEqual(postResult, { ok: true, accepted: 1, rejected: 0 });
    assert.equal(received[0].defaults.source, 'client');

    let statusResult = null;
    routes.get('GET /protoclaw/sidebar_diagnostics/status')({}, {
      json(value) { statusResult = value; },
    });
    assert.equal(statusResult.location, '.agentdev/AgentDevClaw/diagnostics/sidebar');
    assert.equal(JSON.stringify(statusResult).includes('C:\\private'), false);
  });
});
