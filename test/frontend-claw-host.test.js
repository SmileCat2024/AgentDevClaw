import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * ClawHost 契约（public/src/modules/claw-host.js）：
 * 系统提供基础组件、APP 在其上自定义。两者寿命不同——基础组件常驻且插件
 * 不可覆盖，插件块随卸载移除。卸载只清 plugin 层，不得误伤基础组件。
 */

function makeHost(overrides = {}) {
  const ctx = createFrontendSandbox(overrides);
  ctx.loadSource('public/src/modules/claw-host.js');
  return ctx.window.ClawHost;
}

describe('ClawHost blocks', () => {
  it('基础组件注册后可渲染，且被标记为 primitive', () => {
    const host = makeHost();
    host.blocks.registerPrimitive('hero', () => '<hero/>');
    assert.equal(host.blocks.render({}, { type: 'hero' }), '<hero/>');
    assert.equal(host.blocks.isPrimitive('hero'), true);
    assert.equal(host.blocks.isPrimitive('memo-notes'), false);
  });

  it('插件块正常渲染，但不被标记为 primitive', () => {
    const host = makeHost();
    host.blocks.register('memo-notes', () => '<notes/>', 'memo');
    assert.equal(host.blocks.render({}, { type: 'memo-notes' }), '<notes/>');
    assert.equal(host.blocks.isPrimitive('memo-notes'), false);
  });

  it('插件不得覆盖宿主基础组件（拒绝注册并保留原实现）', () => {
    const host = makeHost();
    host.blocks.registerPrimitive('hero', () => '<host-hero/>');
    assert.throws(
      () => host.blocks.register('hero', () => '<evil/>', 'rogue'),
      /基础组件/,
    );
    assert.equal(host.blocks.render({}, { type: 'hero' }), '<host-hero/>');
  });

  it('基础组件不得占用已注册的插件 type（反向保护）', () => {
    const host = makeHost();
    host.blocks.register('memo-notes', () => '<notes/>', 'memo');
    assert.throws(() => host.blocks.registerPrimitive('memo-notes', () => '<dup/>'), /已被插件注册/);
  });

  it('同名插件块重复注册被拒绝', () => {
    const host = makeHost();
    host.blocks.register('memo-notes', () => '<a/>', 'memo');
    assert.throws(() => host.blocks.register('memo-notes', () => '<b/>', 'other'), /已被插件/);
    assert.equal(host.blocks.render({}, { type: 'memo-notes' }), '<a/>');
  });

  it('未注册类型给出显式错误态，不是静默空串', () => {
    const host = makeHost();
    const html = host.blocks.render({}, { type: 'ghost' });
    assert.match(html, /workspace-block-error/);
    assert.match(html, /ghost/);
    assert.notEqual(html, '');
  });

  it('按 owner 摘除插件块，基础组件与其它插件的块不受影响', () => {
    const host = makeHost();
    host.blocks.registerPrimitive('hero', () => '<hero/>');
    host.blocks.register('memo-notes', () => '<notes/>', 'memo');
    host.blocks.register('memo-overview', () => '<ov/>', 'memo');
    host.blocks.register('coder-threads', () => '<coder/>', 'coder');

    assert.equal(host.blocks.unregisterOwner('memo'), 2);
    assert.equal(host.blocks.has('memo-notes'), false);
    assert.equal(host.blocks.has('memo-overview'), false);
    assert.equal(host.blocks.has('coder-threads'), true);
    assert.equal(host.blocks.has('hero'), true);
    assert.equal(host.blocks.render({}, { type: 'hero' }), '<hero/>');
  });

  it('renderer 返回空/undefined 时归一为空串而不是报错', () => {
    const host = makeHost();
    host.blocks.register('empty', () => undefined, 'p');
    assert.equal(host.blocks.render({}, { type: 'empty' }), '');
  });

  it('非法注册参数被拒绝', () => {
    const host = makeHost();
    assert.throws(() => host.blocks.register('', () => ''), /type is required/);
    assert.throws(() => host.blocks.register('x', 'not-a-function'), /render function/);
    assert.throws(() => host.blocks.registerPrimitive('', () => ''), /type is required/);
  });
});

describe('ClawHost panels', () => {
  it('注册后按 agentIds 与 surfaces 双维过滤', () => {
    const host = makeHost();
    host.panels.register('bg', { when: { agentIds: ['programming-helper'], surfaces: ['chat'] }, render: () => '' });
    host.panels.register('global', { render: () => '' });

    assert.deepEqual(
      host.panels.getAvailable({ agentId: 'programming-helper', surface: 'chat' }).map((p) => p.id),
      ['bg', 'global'],
    );
    assert.deepEqual(
      host.panels.getAvailable({ agentId: 'memo', surface: 'chat' }).map((p) => p.id),
      ['global'],
    );
    assert.deepEqual(
      host.panels.getAvailable({ agentId: 'programming-helper', surface: 'workspace' }).map((p) => p.id),
      ['global'],
    );
  });

  it('缺少 render 或重复 ID 被拒绝', () => {
    const host = makeHost();
    assert.throws(() => host.panels.register('x', {}), /must provide a render function/);
    assert.throws(() => host.panels.register('', { render: () => '' }), /Panel ID is required/);
    host.panels.register('x', { render: () => '' });
    assert.throws(() => host.panels.register('x', { render: () => '' }), /already registered/);
  });

  it('ClawPanels 旧入口委托到同一份注册表（不并存两套）', () => {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/claw-host.js');
    ctx.loadSource('public/src/modules/right-panel-registry.js');
    ctx.run("window.ClawPanels.register('legacy', { render: () => 'x' });");
    assert.equal(ctx.window.ClawHost.panels.has('legacy'), true);
    assert.equal(ctx.window.ClawPanels.getAll().length, 1);
  });
});

describe('ClawHost slots', () => {
  it('签名不变时不重建 DOM（避免打断正在输入的输入框）', () => {
    const host = makeHost({ document: { getElementById: () => ({ innerHTML: '' }) } });
    const first = host.slots.mount('slot-a', 'sig-1', () => '<input/>');
    const second = host.slots.mount('slot-a', 'sig-1', () => '<input/>');
    const third = host.slots.mount('slot-a', 'sig-2', () => '<input v2/>');
    assert.equal(first, true, '首次挂载应写入');
    assert.equal(second, false, '签名相同应跳过');
    assert.equal(third, true, '签名变化应重建');
  });

  it('槽位元素不存在时返回 false 并留下可诊断日志', () => {
    const errors = [];
    const host = makeHost({
      document: { getElementById: () => null },
      console: { ...console, error: (...a) => errors.push(a) },
    });
    assert.equal(host.slots.mount('missing', 's', () => '<x/>'), false);
    assert.ok(errors.length > 0);
  });
});

describe('ClawHost 插件装载', () => {
  it('装载失败的模块让 Promise 拒绝，不吞异常', async () => {
    const host = makeHost();
    await assert.rejects(() => host.loadPlugin('broken', 'data:text/javascript,throw new Error("boom")'));
  });
});

/**
 * 卸载契约：插件注册的一切（block / refresher / action）随卸载消失，
 * 宿主基础组件不受影响。这是「随时挂上、卸载」的机器可验证承诺——
 * 插件自身忘记清理也不能留下悬空注册项。
 *
 * 说明：vm 沙箱不支持动态 import，这里用 loadPlugin 的等价路径——先由插件
 * 模块对象完成注册（模拟模块已装入），再走真实 unloadPlugin 验证摘除。
 */
describe('ClawHost 卸载契约', () => {
  function pluginFixture(overrides = {}) {
    return {
      id: 'demo',
      blocks: { 'demo-a': () => '<a/>', 'demo-b': () => '<b/>' },
      refreshers: { 'demo-a': () => {} },
      actions: { 'demo.go': () => {}, 'demo.stop': () => {} },
      mount() {},
      unmount() {},
      ...overrides,
    };
  }

  /** 走与 loadPlugin 相同的注册路径（activatePlugin），只是不经过动态 import。 */
  async function registerAsLoadPlugin(host, mod) {
    return host.activatePlugin(mod.id, mod);
  }

  function makeCtx() {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/claw-host.js');
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    return ctx;
  }

  it('卸载后 block / refresher 全部消失，宿主基础组件保留', async () => {
    const ctx = makeCtx();
    const host = ctx.window.ClawHost;
    host.blocks.registerPrimitive('hero', () => '<hero/>');

    await registerAsLoadPlugin(host, pluginFixture());
    assert.equal(host.blocks.has('demo-a'), true, '装载后插件块应可见');
    assert.equal(host.blocks.render({}, { type: 'demo-a' }), '<a/>');
    assert.equal(host.blocks.refresh('demo-a'), true, '装载后 refresher 应可调用');

    assert.equal(await host.unloadPlugin('demo'), true);

    assert.equal(host.blocks.has('demo-a'), false, '卸载后插件块必须消失');
    assert.equal(host.blocks.has('demo-b'), false, '卸载后插件块必须消失');
    assert.equal(host.blocks.refresh('demo-a'), false, '卸载后 refresher 必须消失');
    assert.equal(host.isPluginLoaded('demo'), false);
    assert.equal(host.blocks.render({}, { type: 'hero' }), '<hero/>', '宿主基础组件不得被卸载波及');
  });

  it('卸载后插件的 action 不再被分发器持有', async () => {
    const ctx = makeCtx();
    const host = ctx.window.ClawHost;

    await registerAsLoadPlugin(host, pluginFixture({
      blocks: {},
      refreshers: {},
      actions: { 'demo.ping': () => { ctx.run('globalThis.__ping = (globalThis.__ping || 0) + 1'); } },
    }));

    // 沙箱的 elementStub 是空实现（setAttribute/getAttribute 无效），
    // 这里用一个真实记录属性的元素对象，让分发器能走完整解析路径。
    const attrs = { 'data-action': 'demo.ping' };
    const el = {
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      parentNode: null,
    };
    ctx.window.ClawFW.actions.dispatch({ type: 'click', target: el, preventDefault() {} });
    assert.equal(ctx.run('globalThis.__ping || 0'), 1, '装载后 action 应可分发');

    await host.unloadPlugin('demo');
    const errors = [];
    ctx.window.console.error = (...a) => errors.push(a.join(' '));
    ctx.window.ClawFW.actions.dispatch({ type: 'click', target: el, preventDefault() {} });
    assert.equal(ctx.run('globalThis.__ping || 0'), 1, '卸载后 action 不应再执行');
    assert.ok(errors.some((line) => line.includes('未注册的 action')), '应留下可诊断的未注册日志');
  });
});

/**
 * 插件清单解析（public/src/modules/plugin-manifest.js）：
 * 决定「哪个 APP 的界面在哪个模块」——解析错了整套插件装载失效，
 * 且必须对未登记 APP 明确返回 null（不能回退成某个默认模块）。
 */
describe('ClawPluginManifest 解析', () => {
  function loadManifest() {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/plugin-manifest.js');
    return ctx;
  }

  it('已登记 APP 返回 id 与模块 URL', () => {
    const ctx = loadManifest();
    const entry = ctx.window.resolveAgentPlugin('memo');
    assert.equal(entry.id, 'memo');
    assert.equal(entry.url, '/src/plugins/memo/index.js');
    assert.ok(entry.url.startsWith('/'), 'URL 必须相对站点根，不随调用点漂移');
  });

  it('未登记 APP 返回 null，不回退到任何默认模块', () => {
    const ctx = loadManifest();
    assert.equal(ctx.window.resolveAgentPlugin('programming-helper'), null);
    assert.equal(ctx.window.resolveAgentPlugin(''), null);
    assert.equal(ctx.window.resolveAgentPlugin(undefined), null);
  });
});
