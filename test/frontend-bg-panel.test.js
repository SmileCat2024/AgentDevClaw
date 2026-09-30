import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

function harness() {
  const requests = [];
  const pending = [];
  const root = { querySelectorAll: () => [], querySelector: () => null, cloneNode: () => ({ innerHTML: '', querySelectorAll: () => [] }), replaceWith() {} };
  const badge = { textContent: '', classList: { add() {}, remove() {} } };
  const ctx = createFrontendSandbox({
    EventSource: MockEventSource,
    URLSearchParams,
    activeFeaturePanel: 'bg',
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'runtime-1',
    getRuntimeWorkspaceSessionId: () => 'session-a',
    getActiveWorkspaceSessionId: () => 'session-a',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return new Promise(resolve => pending.push(value => resolve({ ok: true, json: async () => ({ result: value }) })));
    },
  });
  ctx.document.getElementById = id => id === 'bg-panel-root' ? root : badge;
  // 能力发现桩（7a63bbd 起 refreshBadge / 面板订阅先查 channels 列表再发
  // RPC）：声明 shell-bg 通道，让徽标与面板路径走到真实的 count/list 请求。
  ctx.window.ClawFeatureCommunication = {
    listChannels: async () => [{ featureId: 'shell', channelId: 'shell-bg' }],
  };
  const timers = new Set();
  ctx.setInterval = (callback, delay) => { const id = { callback, delay }; timers.add(id); return id; };
  ctx.clearInterval = id => timers.delete(id);
  ctx.CSS = ctx.window.CSS = { escape: value => value };
  const source = fs.readFileSync(new URL('../public/src/modules/bg-panel.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace('window.BgPanel = {', 'window.BgPanel = { __testSource: () => source, __testTasks: () => tasks,'), ctx);
  const stream = () => ctx.window.BgPanel.__testSource();
  const ids = () => [...ctx.window.BgPanel.__testTasks().keys()];
  const task = id => ctx.window.BgPanel.__testTasks().get(id);
  return { ctx, requests, pending, source: stream, ids, task, timers };
}

const output = (id, status, tail) => ({ type: 'output', data: { id, status, startedAt: 1, command: 'bash', outputTail: tail } });

describe('background task panel', () => {
  it('opens live-only, merges a delayed list without rolling back newer events', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    const stream = h.source();
    assert.ok(stream.url.includes('latest=1'));
    stream.emit('open');
    assert.equal(h.requests[0].requestType, 'list');
    stream.emit('event', output('bg-1', 'done', 'latest'));
    h.pending.shift()({ ok: true, tasks: [
      { id: 'bg-1', status: 'running', startedAt: 1, command: 'bash', outputTail: 'old' },
      { id: 'bg-2', status: 'running', startedAt: 2, command: 'bash', outputTail: 'other' },
    ] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.task('bg-1').status, 'done');
    assert.equal(h.task('bg-1').outputTail, 'latest');
    assert.equal(h.task('bg-2').outputTail, 'other');
    h.ctx.window.BgPanel.onClose();
    assert.equal(stream.closed, true);
    assert.equal(h.timers.size, 1); // only the closed-panel badge timer survives
  });

  it('reconciles a resync list without discarding events received while it is pending', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    const stream = h.source();
    stream.emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    stream.emit('resync');
    stream.emit('event', output('bg-1', 'done', 'new tail'));
    stream.emit('event', output('bg-2', 'running', 'just started'));
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.task('bg-1').status, 'done');
    assert.equal(h.task('bg-2').outputTail, 'just started');
    h.ctx.window.BgPanel.onClose();
  });

  it('ignores an older list that returns after a newer finalized-task reconciliation', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    const stream = h.source();
    stream.emit('open');
    stream.emit('event', { type: 'finalized', data: { id: 'new', status: 'done', startedAt: 2, command: 'bash' } });
    h.pending[1]({ ok: true, tasks: [{ id: 'new', status: 'done', startedAt: 2, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    h.pending[0]({ ok: true, tasks: [{ id: 'stale', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['new']);
    h.ctx.window.BgPanel.onClose();
  });

  it('prunes retired terminal tasks after the registry trims its list', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    const stream = h.source();
    stream.emit('open');
    h.pending.shift()({ ok: true, tasks: [
      { id: 'old', status: 'done', startedAt: 1, command: 'bash' },
      { id: 'active', status: 'running', startedAt: 2, command: 'bash' },
    ] });
    await new Promise(resolve => setImmediate(resolve));
    stream.emit('event', { type: 'finalized', data: { id: 'active', status: 'done', startedAt: 2, command: 'bash' } });
    assert.equal(h.requests.at(-1).requestType, 'list');
    h.pending.shift()({ ok: true, tasks: [{ id: 'active', status: 'done', startedAt: 2, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['active']);
    h.ctx.window.BgPanel.onClose();
  });

  it('updates elapsed time without rebuilding cards on every second', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    const elapsedTimer = [...h.timers].find(timer => timer.delay === 1_000);
    assert.ok(elapsedTimer);
    let rebuilds = 0;
    h.ctx.document.getElementById = id => id === 'bg-panel-root'
      ? { querySelector: () => null, cloneNode: () => ({ innerHTML: '', querySelectorAll: () => [] }), querySelectorAll: () => [], replaceWith: () => { rebuilds++; } }
      : { textContent: '', classList: { add() {}, remove() {} } };
    elapsedTimer.callback();
    assert.equal(rebuilds, 0);
    h.ctx.window.BgPanel.onClose();
  });

  it('polls only a count for the closed-panel badge', async () => {
    const h = harness();
    h.ctx.window.BgPanel.refreshBadge();
    // count 前置了 channels 能力发现（异步），让发现先落定。
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests[0].requestType, 'count');
    h.pending.shift()({ ok: true, running: 3 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), []);
  });

  it('discards a list response from a previous channel after switching sessions', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    h.source().emit('open');
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    const stream = h.source();
    stream.emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'old', status: 'running' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), []);
    h.pending.shift()({ ok: true, tasks: [{ id: 'new', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['new']);
    h.ctx.window.BgPanel.onClose();
  });
});
