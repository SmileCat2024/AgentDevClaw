import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 事件委托分发器契约（public/src/modules/action-dispatcher.js）：
 * 模板以 data-action 声明行为，处理函数经 window.ClawFW.actions 注册按名分发，
 * 处理器得以收进模块局部作用域（替代内联 onclick 的全局函数依赖）。
 */

function makeSandbox() {
  const boundTypes = [];
  const consoleErrors = [];
  const documentSpy = {
    addEventListener(type) { boundTypes.push(type); },
    removeEventListener() {},
  };
  const ctx = createFrontendSandbox({
    document: documentSpy,
    console: { ...console, error: (...a) => consoleErrors.push(a) },
  });
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  return { ctx, boundTypes, consoleErrors };
}

/** 构造伪元素链：attrs → 属性表，parent → 父元素。 */
function makeEl(ctx, name, attrs = {}, parent = null) {
  const el = {
    _attrs: attrs,
    parentNode: parent,
    getAttribute(key) { return key in this._attrs ? this._attrs[key] : null; },
  };
  ctx[name] = el;
  return el;
}

function makeEvent(ctx, target, name) {
  let prevented = 0;
  const event = {
    target,
    preventDefault() { prevented += 1; },
  };
  ctx[name] = event;
  return { event, wasPrevented: () => prevented };
}

describe('action-dispatcher 加载与默认绑定', () => {
  it('挂载 window.ClawFW.actions 并默认绑定 click/change/input/dblclick/keydown/focusout', () => {
    const { ctx, boundTypes } = makeSandbox();
    assert.ok(ctx.window.ClawFW?.actions?.register);
    // focusout 是失焦提交的委托载体（blur 不冒泡），协议守卫确保只服务
    // 显式声明 data-event 的元素（app-ui 批补绑，修复批 7 的死声明）。
    assert.deepEqual(boundTypes.sort(), ['change', 'click', 'dblclick', 'focusout', 'input', 'keydown']);
  });
});

describe('action-dispatcher 分发协议', () => {
  it('命中 data-action：handler 收到 (el, event, ...data-args)', () => {
    const { ctx } = makeSandbox();
    ctx.run(`
      globalThis.__captured = null;
      window.ClawFW.actions.register('wg.send', (el, ev, a, b) => {
        globalThis.__captured = { elName: el._attrs.name, sum: a + b, isEvent: !!ev.preventDefault };
      });
    `);
    const el = makeEl(ctx, '__el', { 'data-action': 'wg.send', 'data-args': '[2, 3]', name: 'btn' });
    makeEvent(ctx, el,'__ev');
    assert.equal(ctx.run('window.ClawFW.actions.dispatch(__ev)'), true);
    // 沙箱 realm 的对象与主 realm 字面量不做 deepEqual（原型不同），逐字段断言
    assert.equal(ctx.__captured.elName, 'btn');
    assert.equal(ctx.__captured.sum, 5);
    assert.equal(ctx.__captured.isEvent, true);
  });

  it('无 data-args 时 handler 无尾参（空数组展开）', () => {
    const { ctx } = makeSandbox();
    ctx.run(`
      globalThis.__args = 'not-called';
      window.ClawFW.actions.register('plain.tick', (el, ev, ...rest) => { globalThis.__args = rest; });
    `);
    const el = makeEl(ctx, '__el', { 'data-action': 'plain.tick' });
    makeEvent(ctx, el,'__ev');
    ctx.run('window.ClawFW.actions.dispatch(__ev)');
    assert.ok(Array.isArray(ctx.__args));
    assert.equal(ctx.__args.length, 0);
  });

  it('target 自身无声明时沿 parentNode 冒泡至祖先的 data-action', () => {
    const { ctx } = makeSandbox();
    ctx.run(`
      globalThis.__hit = null;
      window.ClawFW.actions.register('row.open', (el) => { globalThis.__hit = el._attrs.name; });
    `);
    const row = makeEl(ctx, '__row', { 'data-action': 'row.open', name: 'row' });
    const inner = makeEl(ctx, '__inner', { name: 'inner' }, row);
    makeEvent(ctx, inner, '__ev');
    ctx.run('window.ClawFW.actions.dispatch(__ev)');
    assert.equal(ctx.__hit, 'row');
  });

  it('handler 返回 false 时 preventDefault 被调用；正常返回不调用（观察点对照）', () => {
    const { ctx } = makeSandbox();
    ctx.run(`
      window.ClawFW.actions.register('a.no', () => false);
      window.ClawFW.actions.register('a.ok', () => {});
    `);
    const noEl = makeEl(ctx, '__no', { 'data-action': 'a.no' });
    const okEl = makeEl(ctx, '__ok', { 'data-action': 'a.ok' });
    const no = makeEvent(ctx, noEl, '__evNo');
    const ok = makeEvent(ctx, okEl, '__evOk');
    ctx.run('window.ClawFW.actions.dispatch(__evNo)');
    ctx.run('window.ClawFW.actions.dispatch(__evOk)');
    assert.equal(no.wasPrevented(), 1, 'return false 必须 preventDefault');
    assert.equal(ok.wasPrevented(), 0, '正常返回不得 preventDefault');
  });

  it('data-args 坏 JSON：放弃分发，不误传参', () => {
    const { ctx, consoleErrors } = makeSandbox();
    ctx.run(`
      globalThis.__called = false;
      window.ClawFW.actions.register('bad.args', () => { globalThis.__called = true; });
    `);
    const el = makeEl(ctx, '__el', { 'data-action': 'bad.args', 'data-args': '[1, ' });
    makeEvent(ctx, el,'__ev');
    assert.doesNotThrow(() => ctx.run('window.ClawFW.actions.dispatch(__ev)'));
    assert.equal(ctx.__called, false);
    assert.ok(consoleErrors.length > 0, '坏参数应有可诊断的错误日志');
  });

  it('未注册的 action 名：不抛异常、不调用任何 handler', () => {
    const { ctx, consoleErrors } = makeSandbox();
    ctx.run(`
      globalThis.__called = false;
      window.ClawFW.actions.register('real.one', () => { globalThis.__called = true; });
    `);
    const el = makeEl(ctx, '__el', { 'data-action': 'ghost.none' });
    makeEvent(ctx, el,'__ev');
    assert.doesNotThrow(() => ctx.run('window.ClawFW.actions.dispatch(__ev)'));
    assert.equal(ctx.__called, false);
    assert.ok(consoleErrors.length > 0, '未注册名应有错误日志提示');
  });

  it('同名重复注册被拒绝：首次注册的 handler 仍生效', () => {
    const { ctx, consoleErrors } = makeSandbox();
    ctx.run(`
      globalThis.__who = null;
      window.ClawFW.actions.register('dup.key', () => { globalThis.__who = 'first'; });
      window.ClawFW.actions.register('dup.key', () => { globalThis.__who = 'second'; });
    `);
    const el = makeEl(ctx, '__el', { 'data-action': 'dup.key' });
    makeEvent(ctx, el,'__ev');
    ctx.run('window.ClawFW.actions.dispatch(__ev)');
    assert.equal(ctx.__who, 'first');
    assert.ok(consoleErrors.length > 0, '重复注册应有错误日志提示');
  });
});
