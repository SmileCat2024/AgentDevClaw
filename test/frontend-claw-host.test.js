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
    assert.throws(() => host.panels.register('x', {}), /must provide a render or mountBody function/);
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

  it('mount 抛错时回滚本轮注册项，不留半激活插件', async () => {
    const ctx = makeCtx();
    const host = ctx.window.ClawHost;

    await assert.rejects(
      () => registerAsLoadPlugin(host, pluginFixture({
        mount() { throw new Error('mount boom'); },
      })),
      /mount boom/,
    );
    assert.equal(host.blocks.has('demo-a'), false, '回滚后插件块不得残留');
    assert.equal(host.blocks.has('demo-b'), false, '回滚后插件块不得残留');
    assert.equal(host.blocks.refresh('demo-a'), false, '回滚后 refresher 不得残留');
    assert.equal(host.isPluginLoaded('demo'), false, '失败插件不得进入 loaded 表');

    // 回滚干净后同 owner 可重新装载（注册无冲突）
    await registerAsLoadPlugin(host, pluginFixture());
    assert.equal(host.blocks.has('demo-a'), true, '回滚后应可重新装载');
  });

  it('unmount 抛错时摘除仍必达，插件不僵尸化', async () => {
    const ctx = makeCtx();
    const host = ctx.window.ClawHost;

    await registerAsLoadPlugin(host, pluginFixture({
      unmount() { throw new Error('unmount boom'); },
    }));
    assert.equal(await host.unloadPlugin('demo'), true, 'unmount 抛错不影响卸载返回值');
    assert.equal(host.blocks.has('demo-a'), false, 'unmount 抛错不得跳过摘除');
    assert.equal(host.blocks.refresh('demo-a'), false, 'unmount 抛错不得跳过 refresher 摘除');
    assert.equal(host.isPluginLoaded('demo'), false, 'loaded 表必须清理');

    // 摘除干净后同 owner 可重新装载（否则僵尸插件会挡住重装）
    await registerAsLoadPlugin(host, pluginFixture());
    assert.equal(host.blocks.has('demo-a'), true, '僵尸化不得阻止重新装载');
  });

  it('只注册 refresher（无同名 block）的项也随卸载摘除', async () => {
    const ctx = makeCtx();
    const host = ctx.window.ClawHost;

    await registerAsLoadPlugin(host, pluginFixture({
      blocks: {},
      refreshers: { 'solo-refresh': () => {} },
    }));
    assert.equal(host.blocks.refresh('solo-refresh'), true, '装载后 refresher 应可调用');

    await host.unloadPlugin('demo');
    assert.equal(host.blocks.refresh('solo-refresh'), false, '无同名 block 的 refresher 不得残留');
  });
});

/**
 * 归属与 effect 面（ADR-0044 决策 3）：
 * 插件经绑定 api（mount 参数）注册的一切与登记的副作用清理，都归属该插件
 * 生命周期；卸载与激活失败回滚时宿主统一撤销，不依赖插件自觉。
 */
describe('ClawHost 归属与 effect 面', () => {
  /** 每个 slotId 独立的元素 stub（innerHTML 可回读，验证卸载清空 DOM）。
   *  document 覆盖须保留默认 stub 的方法面（action-dispatcher 顶层绑事件
   *  依赖 addEventListener），仅 getElementById 换为按 id 缓存的独立元素。 */
  function makeSlotCtx() {
    const elements = new Map();
    const ctx = createFrontendSandbox({
      document: {
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, { innerHTML: '' });
          return elements.get(id);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return null; },
        createTextNode(text) { return { textContent: text }; },
        addEventListener() {},
        body: {},
        head: {},
        documentElement: {},
        readyState: 'complete',
      },
    });
    ctx.loadSource('public/src/modules/claw-host.js');
    ctx.loadSource('public/src/modules/action-dispatcher.js');
    return { ctx, elements };
  }

  it('mount 内动态注册（block/panel/slot/refresher）与 effect 登记随卸载零残留', async () => {
    const { ctx, elements } = makeSlotCtx();
    const host = ctx.window.ClawHost;
    const disposed = [];

    await host.activatePlugin('dyn', {
      id: 'dyn',
      mount(h) {
        h.blocks.register('dyn-a', () => '<a/>');
        h.blocks.registerRefresher('dyn-r', () => {});
        h.panels.register('dyn-panel', { render: () => '<p/>' });
        h.slots.mount('dyn-slot', 's1', () => '<slot/>');
        h.effect(() => { disposed.push(1); });
        h.effect(() => { disposed.push(2); });
      },
    });

    assert.equal(host.blocks.has('dyn-a'), true, '装载后动态注册 block 应可见');
    assert.equal(host.panels.has('dyn-panel'), true, '装载后动态注册 panel 应可见');
    assert.equal(elements.get('dyn-slot').innerHTML, '<slot/>', '装载后 slot DOM 应写入');

    assert.equal(await host.unloadPlugin('dyn'), true);
    assert.equal(host.blocks.has('dyn-a'), false, '卸载后动态注册 block 必须消失');
    assert.equal(host.blocks.refresh('dyn-r'), false, '卸载后动态注册 refresher 必须消失');
    assert.equal(host.panels.has('dyn-panel'), false, '卸载后动态注册 panel 必须消失');
    assert.equal(elements.get('dyn-slot').innerHTML, '', '卸载后 slot DOM 必须清空');
    assert.deepEqual(disposed, [1, 2], 'effect 清单必须全部执行');
    assert.equal(host.isPluginLoaded('dyn'), false);
  });

  it('声明式 panels 字段随卸载摘除，并经 teardown 钩子通知编排层', async () => {
    const { ctx } = makeSlotCtx();
    const host = ctx.window.ClawHost;
    const tornDown = [];
    host.setPanelTeardownHook((panelId) => tornDown.push(panelId));

    await host.activatePlugin('pnl', {
      id: 'pnl',
      panels: { 'pnl-main': { render: () => '' }, 'pnl-side': { render: () => '' } },
    });
    assert.equal(host.panels.has('pnl-main'), true);

    await host.unloadPlugin('pnl');
    assert.equal(host.panels.has('pnl-main'), false, '声明式面板必须随卸载摘除');
    assert.equal(host.panels.has('pnl-side'), false);
    assert.deepEqual(tornDown.sort(), ['pnl-main', 'pnl-side'], '每个被摘面板都要通知编排层');
  });

  it('无主面板（宿主静态注册）不受插件卸载波及', async () => {
    const { ctx } = makeSlotCtx();
    const host = ctx.window.ClawHost;
    host.panels.register('host-panel', { render: () => '' }); // 无 owner：宿主静态注册形态

    await host.activatePlugin('p2', { id: 'p2', panels: { 'p2-x': { render: () => '' } } });
    await host.unloadPlugin('p2');

    assert.equal(host.panels.has('p2-x'), false);
    assert.equal(host.panels.has('host-panel'), true, '无主面板不得被插件卸载摘除');
  });

  it('mount 抛错时回滚覆盖动态注册与 effect 清单', async () => {
    const { ctx, elements } = makeSlotCtx();
    const host = ctx.window.ClawHost;
    const disposed = [];

    await assert.rejects(
      () => host.activatePlugin('bad', {
        id: 'bad',
        mount(h) {
          h.blocks.register('bad-a', () => '<a/>');
          h.panels.register('bad-panel', { render: () => '' });
          h.slots.mount('bad-slot', 's', () => '<x/>');
          h.effect(() => { disposed.push('ran'); });
          throw new Error('boom');
        },
      }),
      /boom/,
    );

    assert.equal(host.blocks.has('bad-a'), false, '回滚后动态注册 block 不得残留');
    assert.equal(host.panels.has('bad-panel'), false, '回滚后动态注册 panel 不得残留');
    assert.equal(elements.get('bad-slot').innerHTML, '', '回滚后 slot DOM 不得残留');
    assert.deepEqual(disposed, ['ran'], '回滚也要执行 mount 半途登记的 effect');
  });

  it('disposer 抛错不阻断其余 effect 清理与卸载', async () => {
    const { ctx } = makeSlotCtx();
    const host = ctx.window.ClawHost;
    const errors = [];
    ctx.window.console.error = (...a) => errors.push(a.join(' '));
    const ran = [];

    await host.activatePlugin('fx', {
      id: 'fx',
      mount(h) {
        h.effect(() => { throw new Error('dispose boom'); });
        h.effect(() => { ran.push('second'); });
      },
    });

    assert.equal(await host.unloadPlugin('fx'), true, 'disposer 抛错不影响卸载结果');
    assert.deepEqual(ran, ['second'], '其余 disposer 必须照常执行');
    assert.ok(errors.some((line) => line.includes('effect 清理异常')), '应留下可诊断日志');
  });

  it('teardown 钩子自身抛错不阻断面板摘除', async () => {
    const { ctx } = makeSlotCtx();
    const host = ctx.window.ClawHost;
    host.setPanelTeardownHook(() => { throw new Error('hook boom'); });

    await host.activatePlugin('p3', { id: 'p3', panels: { 'p3-x': { render: () => '' } } });
    assert.equal(await host.unloadPlugin('p3'), true, '钩子异常不影响卸载结果');
    assert.equal(host.panels.has('p3-x'), false, '面板必须照样摘除');
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
