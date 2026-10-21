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

function harness({ listChannels } = {}) {
  const requests = [];
  const pending = [];
  const clicks = [];
  class TestElement {
    constructor(action, id) { this.action = action; this.id = id; }
    closest(selector) { return selector === `.bgp-${this.action}-btn` ? this : null; }
    getAttribute() { return this.id; }
  }
  const root = { querySelectorAll: () => [], querySelector: () => null, cloneNode: () => ({ innerHTML: '', querySelectorAll: () => [] }), replaceWith() {} };
  const badge = { textContent: '', classList: { add() {}, remove() {} } };
  const ctx = createFrontendSandbox({
    EventSource: MockEventSource,
    Element: TestElement,
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
  ctx.document.addEventListener = (type, callback) => { if (type === 'click') clicks.push(callback); };
  // 能力发现桩（7a63bbd 起 refreshBadge / 面板订阅先查 channels 列表再发
  // RPC）：声明 shell-bg 通道，让徽标与面板路径走到真实的 count/list 请求。
  ctx.window.ClawFeatureCommunication = {
    listChannels: listChannels ?? (async () => [{ featureId: 'shell', channelId: 'shell-bg', presentation: { panel: 'background', protocol: 'claw.background.process', version: 1 } }]),
  };
  const timers = new Set();
  ctx.setInterval = (callback, delay) => { const id = { callback, delay }; timers.add(id); return id; };
  ctx.clearInterval = id => timers.delete(id);
  ctx.CSS = ctx.window.CSS = { escape: value => value };
  const source = fs.readFileSync(new URL('../public/src/modules/bg-panel.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace('window.BgPanel = {', 'window.BgPanel = { __testStreams: () => [...channels.values()].map(channel => channel.stream).filter(Boolean), __testSource: () => source, __testTasks: () => tasks,'), ctx);
  const stream = () => ctx.window.BgPanel.__testSource();
  const ids = () => [...ctx.window.BgPanel.__testTasks().values()].map(task => task.taskId);
  const task = id => [...ctx.window.BgPanel.__testTasks().values()].find(task => task.taskId === id);
  return { ctx, requests, pending, source: stream, ids, task, timers, badge,
    click: (action, id) => clicks.forEach(callback => callback({ target: new TestElement(action, id) })) };
}

const output = (id, status, tail) => ({ type: 'output', data: { id, status, startedAt: 1, command: 'bash', outputTail: tail } });

describe('background task panel', () => {
  it('aggregates same-ID process sources and read-only agents by declared protocol', async () => {
    const h = harness({ listChannels: async () => [
      { featureId: 'bash-other', channelId: 'jobs', presentation: { panel: 'background', protocol: 'claw.background.process', version: 1 } },
      { featureId: 'pwsh', channelId: 'jobs', presentation: { panel: 'background', protocol: 'claw.background.process', version: 1 } },
      { featureId: 'dispatch', channelId: 'runs', presentation: { panel: 'background', protocol: 'claw.background.agent', version: 1 } },
      { featureId: 'future', channelId: 'jobs', presentation: { panel: 'background', protocol: 'unknown', version: 9 } },
    ] });
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    const streams = h.ctx.window.BgPanel.__testStreams();
    assert.equal(streams.length, 3);
    streams.forEach(stream => stream.emit('open'));
    h.pending.shift()({ ok: true, tasks: [{ id: 'same', status: 'running', command: 'bash' }] });
    h.pending.shift()({ ok: true, tasks: [{ id: 'same', status: 'running', command: 'pwsh' }] });
    h.pending.shift()({ ok: true, tasks: [{ id: 'same', status: 'suspended', title: 'Agent work', threadId: 'wt', commandId: 'cmd', summary: 'Waiting' }] });
    await new Promise(resolve => setImmediate(resolve));
    const html = h.ctx.window.BgPanel.getHtml();
    assert.equal((html.match(/data-bgp-task=/g) || []).length, 3);
    assert.equal((html.match(/data-bgp-kill=/g) || []).length, 2);
    assert.match(html, /Agent work/);
    assert.match(html, /不支持|Unsupported/);
    assert.equal(h.badge.textContent, '3');
    const keys = [...h.ctx.window.BgPanel.__testTasks().keys()];
    h.click('kill', keys[1]);
    assert.equal(h.requests.at(-1).featureId, 'pwsh');
    assert.equal(h.requests.at(-1).channelId, 'jobs');
    assert.equal(h.requests.at(-1).payload.taskId, 'same');
    h.pending.shift()({ ok: true });
    h.click('report', keys[0]);
    assert.equal(h.requests.at(-1).featureId, 'bash-other');
    h.pending.shift()({ ok: false });
    const before = h.requests.length;
    h.click('kill', keys[2]);
    h.click('report', keys[2]);
    assert.equal(h.requests.length, before);
    await new Promise(resolve => setImmediate(resolve));
    h.ctx.window.BgPanel.onClose();
  });
  it('handles unknown versions, empty/error discovery, disconnect and late badge baselines', async () => {
    const version = harness({ listChannels: async () => [{ featureId: 'future', channelId: 'jobs',
      presentation: { panel: 'background', protocol: 'claw.background.process', version: 2 } }] });
    version.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(version.ctx.window.BgPanel.__testStreams().length, 0);
    assert.match(version.ctx.window.BgPanel.getHtml(), /process@2/);
    const empty = harness({ listChannels: async () => [] });
    empty.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(empty.source(), null);
    const error = harness({ listChannels: async () => { throw new Error('offline'); } });
    error.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(error.ctx.window.BgPanel.getHtml(), /发现失败/);
    const h = harness();
    h.ctx.window.BgPanel.refreshBadge();
    await new Promise(resolve => setImmediate(resolve));
    const stream = h.source();
    stream.emit('open');
    stream.emit('event', output('bg', 'done', 'new'));
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg', status: 'running', outputTail: 'old' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.task('bg').status, 'done');
    assert.equal(h.badge.textContent, '');
    stream.emit('error');
    assert.equal(stream.closed, false);
    assert.match(h.ctx.window.BgPanel.getHtml(), /disconnected/);
    stream.emit('open');
    h.pending.shift()({ ok: false, code: 'temporary' });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(h.ctx.window.BgPanel.getHtml(), /temporary/);
    h.ctx.getRuntimeWorkspaceSessionId = () => 'session-b';
    h.ctx.currentRuntimeAgentId = 'runtime-b';
    h.ctx.window.BgPanel.refreshBadge();
    stream.emit('event', output('stale', 'running', 'wrong session'));
    assert.deepEqual(h.ids(), []);
    assert.equal(h.badge.textContent, '');
  });

  it('does not roll a newer agent list back with a delayed publication', async () => {
    const h = harness({ listChannels: async () => [{ featureId: 'dispatch', channelId: 'runs',
      presentation: { panel: 'background', protocol: 'claw.background.agent', version: 1 } }] });
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'run', revision: 3, startedAt: 1, status: 'completed', summary: 'done' }] });
    await new Promise(resolve => setImmediate(resolve));
    h.source().emit('event', { type: 'updated', data: { id: 'run', revision: 2, startedAt: 1, status: 'executing' } });
    assert.equal(h.task('run').status, 'completed');
    assert.equal(h.badge.textContent, '');
  });

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
    assert.equal(stream.closed, false); // the same stream now feeds the badge/cache
    assert.equal(h.timers.size, 2); // discovery + session guard; elapsed rendering stopped
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

  it('drives the closed-panel badge from the event stream (list baseline + live deltas)', async () => {
    const h = harness();
    h.ctx.window.BgPanel.refreshBadge();
    // 通道发现（channels）先落定，随后建立徽标专用订阅。
    await new Promise(resolve => setImmediate(resolve));
    const badgeStream = h.ctx.window.BgPanel.__testBadgeStream();
    assert.ok(badgeStream);
    assert.ok(badgeStream.url.includes('latest=1'));
    badgeStream.emit('open');
    assert.equal(h.requests[0].requestType, 'list');
    h.pending.shift()({ ok: true, tasks: [
      { id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' },
      { id: 'bg-2', status: 'running', startedAt: 2, command: 'bash' },
    ] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.badge.textContent, '2');
    // 事件帧即时增减：任务终结减一，新任务开始加一。
    badgeStream.emit('event', output('bg-1', 'done', 'finished'));
    assert.equal(h.badge.textContent, '1');
    badgeStream.emit('event', { type: 'started', data: { id: 'bg-3', status: 'running', startedAt: 3, command: 'bash' } });
    assert.equal(h.badge.textContent, '2');
    // 事件随手镜像进任务缓存：面板重开即最新状态，无需等 list 返回。
    assert.deepEqual(h.ids(), ['bg-1', 'bg-2', 'bg-3']);
    assert.equal(h.task('bg-1').status, 'done');
    // resync 对账：以 list 全量重建基线（缓存成员同步对账）。
    badgeStream.emit('resync');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-3', status: 'running', startedAt: 3, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.badge.textContent, '1');
    assert.deepEqual(h.ids(), ['bg-3']);
    // 通道关闭：拆除订阅并归零，任务缓存随之作废（不留陈旧卡片）。
    badgeStream.emit('closed');
    assert.equal(h.badge.textContent, '');
    assert.equal(h.ctx.window.BgPanel.__testBadgeStream(), null);
    assert.deepEqual(h.ids(), []);
  });

  it('panel open takes over the badge and tears down its stream', async () => {
    const h = harness();
    h.ctx.window.BgPanel.refreshBadge();
    await new Promise(resolve => setImmediate(resolve));
    const badgeStream = h.ctx.window.BgPanel.__testBadgeStream();
    assert.ok(badgeStream);
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(badgeStream.closed, true);
    assert.equal(h.ctx.window.BgPanel.__testBadgeStream(), null);
    h.ctx.window.BgPanel.onClose();
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

  it('reopens with the retained snapshot, then reconciles membership from list', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['bg-1']);
    h.ctx.window.BgPanel.onClose();
    // 同一会话重开：不经任何网络往返，缓存先上屏（getHtml 即宿主 render 的数据源）。
    h.ctx.window.BgPanel.onOpen();
    assert.ok(h.ctx.window.BgPanel.getHtml().includes('bg-1'));
    await new Promise(resolve => setImmediate(resolve)); // 发现（channels）先落定
    assert.deepEqual(h.ids(), ['bg-1']);
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), []); // 权威 list 对账：任务已被淘汰则移除
    h.ctx.window.BgPanel.onClose();
  });

  it('drops the retained snapshot when the focused session changes', async () => {
    const h = harness();
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['bg-1']);
    h.ctx.window.BgPanel.onClose();
    await new Promise(resolve => setImmediate(resolve)); // 关闭态徽标发现落定
    h.ctx.getRuntimeWorkspaceSessionId = () => 'session-b';
    h.ctx.window.BgPanel.onOpen();
    assert.deepEqual(h.ids(), []); // 跨会话缓存不得串台
    h.ctx.window.BgPanel.onClose();
  });

  it('invalidates the cache when discovery finds no channel', async () => {
    let declared = true;
    const h = harness({ listChannels: async () => (declared ? [{ featureId: 'shell', channelId: 'shell-bg', presentation: { panel: 'background', protocol: 'claw.background.process', version: 1 } }] : []) });
    h.ctx.window.BgPanel.onOpen();
    await new Promise(resolve => setImmediate(resolve)); // 能力发现（channels）先落定
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['bg-1']);
    h.ctx.window.BgPanel.onClose();
    await new Promise(resolve => setImmediate(resolve)); // 关闭态徽标发现落定（通道仍声明）
    declared = false;
    // 下一轮徽标发现轮询确证无通道：拆订阅 + 缓存作废。
    const badgePoll = [...h.timers].find(timer => timer.delay === 30_000);
    badgePoll.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), []);
    assert.equal(h.ctx.window.BgPanel.__testBadgeStream(), null);
  });

  it('serves the badge-fed snapshot instantly on the first panel open', async () => {
    const h = harness();
    h.ctx.window.BgPanel.refreshBadge();
    await new Promise(resolve => setImmediate(resolve)); // 通道发现落定，建立徽标订阅
    const badgeStream = h.ctx.window.BgPanel.__testBadgeStream();
    badgeStream.emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['bg-1']);
    // 首次打开面板：徽标流已把缓存喂热，不经 list 返回即渲染。
    h.ctx.window.BgPanel.onOpen();
    assert.ok(h.ctx.window.BgPanel.getHtml().includes('bg-1'));
    await new Promise(resolve => setImmediate(resolve)); // 发现（channels）先落定
    h.source().emit('open');
    h.pending.shift()({ ok: true, tasks: [{ id: 'bg-1', status: 'running', startedAt: 1, command: 'bash' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.ids(), ['bg-1']);
    h.ctx.window.BgPanel.onClose();
  });
});
