/** Diagnostics contract tests for the external coder ACP adapter. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTraceLogger } from '../scripts/coder-acp/trace.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJsonl(file) {
  const text = await readFile(file, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('coder ACP trace logger', () => {
  it('is silent by default and never writes stdout', async () => {
    const stderr = [];
    const trace = createTraceLogger({ env: {}, stderr: (line) => stderr.push(line) });
    trace.record('not-enabled', { prompt: 'secret prompt' });
    await trace.flush();
    assert.deepEqual(stderr, []);
  });

  it('writes legal JSONL with wire request ids and correlation ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-acp-trace-'));
    tempDirs.push(dir);
    const file = join(dir, 'nested', 'trace.jsonl');
    const trace = createTraceLogger({ env: { CLAW_ACP_TRACE_FILE: file, CLAW_ACP_WIRE_TRACE: '1' } });
    trace.wire('inbound', { jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello' }] } });
    trace.wire('outbound', { jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } });
    await trace.flush();
    const records = await readJsonl(file);
    const inbound = records.find((record) => record.event === 'acp.inbound');
    const outbound = records.find((record) => record.event === 'acp.outbound');
    assert.equal(inbound.requestId, 7);
    assert.equal(outbound.requestId, 7);
    assert.equal(outbound.acpTraceId, inbound.acpTraceId);
    assert.equal(outbound.acpSessionId, 'acp-1');
    assert.equal(outbound.runtimeInstanceId !== undefined, true);
  });

  it('does not persist full content by default, and content mode redacts and limits it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-acp-trace-'));
    tempDirs.push(dir);
    const safeFile = join(dir, 'safe.jsonl');
    const safe = createTraceLogger({ env: { CLAW_ACP_TRACE_FILE: safeFile, CLAW_ACP_WIRE_TRACE: '1' } });
    safe.wire('inbound', {
      jsonrpc: '2.0', id: 1, method: 'session/prompt',
      params: { sessionId: 's', prompt: [{ type: 'text', text: 'TOP-SECRET-A' }], token: 'abc' },
    });
    await safe.flush();
    const safeText = await readFile(safeFile, 'utf8');
    assert.equal(safeText.includes('TOP-SECRET-A'), false);
    assert.equal(safeText.includes('abc'), false);

    const contentFile = join(dir, 'content.jsonl');
    const content = createTraceLogger({
      env: { CLAW_ACP_TRACE_FILE: contentFile, CLAW_ACP_WIRE_TRACE: '1', CLAW_ACP_TRACE_CONTENT: '1' },
      contentLimit: 12,
    });
    content.wire('inbound', {
      jsonrpc: '2.0', id: 2, method: 'session/prompt',
      params: { sessionId: 's', prompt: [{ type: 'text', text: 'TOP-SECRET-VERY-LONG' }], token: 'abc' },
    });
    await content.flush();
    const contentText = await readFile(contentFile, 'utf8');
    assert.match(contentText, /TOP-SECRET/);
    assert.equal(contentText.includes('TOP-SECRET-VERY-LONG'), false);
    assert.equal(contentText.includes('"token":"[REDACTED]"'), true);
  });

  it('rotates asynchronously without blocking record calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-acp-trace-'));
    tempDirs.push(dir);
    const file = join(dir, 'trace.jsonl');
    const trace = createTraceLogger({ env: { CLAW_ACP_TRACE_FILE: file }, maxBytes: 180 });
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) trace.record('large', { message: 'x'.repeat(80) });
    assert.ok(Date.now() - started < 100, 'trace recording must not wait for disk rotation');
    await trace.flush();
    const files = await readdir(dir);
    assert.ok(files.some((name) => name === 'trace.jsonl.1'));
    for (const name of files.filter((item) => item.startsWith('trace.jsonl'))) {
      await readJsonl(join(dir, name));
    }
  });
});
