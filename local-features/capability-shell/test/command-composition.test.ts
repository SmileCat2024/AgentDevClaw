import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCapabilityShellPipeline } from '../src/tool-factory.js';
import { checkStructure } from '../src/structure.js';
import { createCoderShellPolicy } from '../src/coder-policy.js';
import { createThreadsAdapters } from '../src/coder-shell.js';
import type { CapabilityShellPolicy } from '../src/types.js';
import type { AdapterMap } from '../src/dispatch.js';

const policy: CapabilityShellPolicy = { name: 'test_shell', description: 'test', verbs: Object.fromEntries(
  ['send', 'fail', 'copy', 'watch', 'abort'].map((verb) => [verb, {
    description: verb, params: [{ name: 'text', kind: 'literal', required: false }], adapter: { key: verb },
  }]),
) };
function run(command: string, adapters: AdapterMap, extra: any = {}) {
  return runCapabilityShellPipeline(policy, command, { adapters, bashPath: null, ...extra });
}

it('sequences execute all commands and retain every receipt; && skips failure until next sequence', async () => {
  const calls: string[] = [];
  const adapters: AdapterMap = {
    send: async (args) => { calls.push(args[0]); return `receipt ${args[0]}`; },
    fail: async () => ({ ok: false, output: 'explicit domain failure' }),
  };
  const result = await run('send A; fail && send B && send C\nsend D', adapters);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['A', 'D']);
  assert.match(result.output, /receipt A/);
  assert.match(result.output, /receipt D/);
  assert.match(result.output, /skipped/);
});

it('two real coder submissions keep both receipts without waiting for either execution', async () => {
  const submissions: string[] = [];
  const adapters = createThreadsAdapters({ serverOrigin: 'http://test', fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    submissions.push(body.idempotencyKey);
    return { ok: true, status: 201, json: async () => ({ ok: true, command: { commandId: `c${submissions.length}` } }) };
  } });
  const result = await runCapabilityShellPipeline(createCoderShellPolicy(),
    "send wt1 k1 'A' --dispatch-only && send wt2 k2 'B' --dispatch-only", { adapters, bashPath: null });
  assert.equal(result.ok, true);
  assert.deepEqual(submissions, ['k1', 'k2']);
  assert.match(result.output, /sent c1/);
  assert.match(result.output, /sent c2/);
});

it('conditional success follows result contract, not words in text', async () => {
  let count = 0;
  const result = await run('send && send', { send: async () => { count++; return 'failed timeout are literal words'; } });
  assert.equal(result.ok, true);
  assert.equal(count, 2);
});

it('all syntax/verb/argument checks occur before any side effect', async () => {
  let calls = 0;
  for (const command of ['send A; unknown', 'send A; send B C', 'send A; copy > ../escape']) {
    assert.equal((await run(command, { send: async () => { calls++; return 'receipt'; } })).ok, false);
  }
  assert.equal(calls, 0);
});

it('standby does not interrupt remaining commands; abort preserves receipts and marks remaining actions', async () => {
  const calls: string[] = [];
  const ac = new AbortController();
  const result = await run('send A; watch; send B; abort; send C', {
    send: async (args) => { calls.push(args[0]); return `receipt ${args[0]}`; },
    watch: async () => 'standby requested',
    abort: async () => { ac.abort(); return 'operation already applied'; },
  }, { signal: ac.signal });
  assert.deepEqual(calls, ['A', 'B']);
  assert.match(result.output, /receipt A/);
  assert.match(result.output, /operation already applied/);
  assert.match(result.output, /not-executed/);
});

it('redirects implement write/append/read and do not leak filenames into argv', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'domain-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapters: AdapterMap = { send: async (args) => args[0], copy: async (_args, ctx) => ctx.stdin };
  const result = await run('send A > out.txt; send B >> out.txt; copy < out.txt', adapters, { workdir: root });
  assert.equal(result.ok, true, result.output);
  assert.equal(await readFile(join(root, 'out.txt'), 'utf8'), 'AB');
  assert.match(result.output, /AB/);
  assert.equal((await run('send >', adapters, { workdir: root })).ok, false);
});

it('redirect symlinks outside workspace are rejected before adapter execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'domain-shell-'));
  const outside = await mkdtemp(join(tmpdir(), 'domain-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, join(root, 'external'), 'dir');
  let called = false;
  const result = await run('send > external/out.txt', { send: async () => { called = true; return 'data'; } }, { workdir: root });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

it('quoted newlines/operators stay literal; malformed connectors and redirects are rejected without bash', () => {
  const parsed = checkStructure("send 'A\nB; C && D';\ncopy");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.segments[0].args[0], 'A\nB; C && D');
  assert.equal(parsed.segments[1].connector, ';');
  for (const command of ['send &&', 'send |', 'send && ; copy', "send 'unterminated", 'send > > out', 'send || copy']) {
    assert.equal(checkStructure(command).ok, false, command);
  }
});
