import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationStartup } from '../public/src/modules/application-startup.js';

function fixture(overrides = {}) {
  const calls = [];
  const host = {
    waitViewer: async () => calls.push('viewer'), loadTemplates: async () => { calls.push('templates'); return false; },
    loadAgents: async () => calls.push('agents'), consumeDesktopOpen: async () => calls.push('desktop'),
    reloadTemplates: async () => calls.push('reload'), loadMcp: async force => calls.push(['mcp', force]),
    poll: () => calls.push('poll'), log() {}, ...overrides,
  };
  return { ...createApplicationStartup(host), calls };
}

test('startup restores focus before desktop intent, retries missing templates and starts poll after MCP', async () => {
  const f = fixture();
  await f.startApplication();
  assert.deepEqual(f.calls, ['viewer', 'templates', 'agents', 'desktop', 'reload', ['mcp', false], 'poll']);
});

test('loaded templates are not retried and viewer readiness false does not block the established startup policy', async () => {
  const f = fixture({ waitViewer: async () => false, loadTemplates: async () => true });
  await f.startApplication();
  assert.deepEqual(f.calls, ['agents', 'desktop', ['mcp', false], 'poll']);
});

test('desktop intent must settle before MCP and poll start', async () => {
  let release;
  const desktop = new Promise(resolve => { release = resolve; });
  const f = fixture({ consumeDesktopOpen: () => desktop });
  const started = f.startApplication();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.includes('poll'), false);
  release();
  await started;
  assert.deepEqual(f.calls.slice(-2), [['mcp', false], 'poll']);
});

test('startup failure propagates without starting a partial polling loop', async () => {
  const f = fixture({ loadAgents: async () => { throw new Error('agents failed'); } });
  await assert.rejects(f.startApplication(), /agents failed/);
  assert.deepEqual(f.calls, ['viewer', 'templates']);
});
