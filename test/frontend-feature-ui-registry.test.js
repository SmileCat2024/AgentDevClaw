/**
 * 动态插件面板声明装载（ADR-0045 P1）行为钉子。
 *
 * 钉什么：feature-ui-registry 把 server 声明 API 的下发结果转成
 * ClawHost.panels 懒 stub；声明退场（卸载/禁用后 server 停发）时按钮
 * 占位一并移除；同面板换版（url 变化）替换 stub；API 失败不清空现有
 * 声明；stop() 清理轮询定时器。
 *
 * 观察点：ClawHost.panels 注册表（stub 的存在性、stub.url、title 语言
 * 函数），不经过私有中间对象。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createRegistrySandbox(respondWith) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    fetch: async () => ({
      ok: true,
      json: async () => respondWith(),
    }),
  });
  ctx.loadSource('public/src/modules/claw-host.js');
  ctx.loadSource('public/src/modules/feature-ui-registry.js');
  return ctx;
}

const decl = (panelId, url, extraMeta = {}) => ({
  panelId,
  pluginId: panelId,
  package: 'demo-plugin',
  version: '1.0.0',
  url,
  meta: {
    label: { zh: '演示', en: 'Demo' },
    order: 50,
    when: {},
    ...extraMeta,
  },
});

describe('feature-ui-registry', () => {
  let ctx;
  let pending;

  beforeEach(() => {
    pending = [
      { ok: true, declarations: [decl('demo-panel', '/protoclaw/feature-assets/demo-plugin/1.0.0/index.js')] },
    ];
    ctx = createRegistrySandbox(() => pending[pending.length - 1]);
  });

  afterEach(() => {
    ctx.window.ClawFW.featureUi.stop();
  });

  it('声明下发后注册为懒 stub，meta 纯数据补齐 title 语言函数', async () => {
    await ctx.window.ClawFW.featureUi.refresh();
    const panel = ctx.window.ClawHost.panels.get('demo-panel');
    assert.ok(panel, 'stub 应已注册');
    assert.equal(panel.stub.url, '/protoclaw/feature-assets/demo-plugin/1.0.0/index.js');
    assert.equal(panel.title(), '演示');
    assert.equal(panel.order, 50);
  });

  it('声明退场（server 停发）时 stub 一并移除', async () => {
    await ctx.window.ClawFW.featureUi.refresh();
    assert.ok(ctx.window.ClawHost.panels.get('demo-panel'));
    pending.push({ ok: true, declarations: [] });
    await ctx.window.ClawFW.featureUi.refresh();
    assert.equal(ctx.window.ClawHost.panels.get('demo-panel'), undefined);
  });

  it('url 未变化的重复声明幂等（不重复 declare 不误退场）', async () => {
    await ctx.window.ClawFW.featureUi.refresh();
    pending.push({ ok: true, declarations: [decl('demo-panel', '/protoclaw/feature-assets/demo-plugin/1.0.0/index.js')] });
    await ctx.window.ClawFW.featureUi.refresh();
    const panel = ctx.window.ClawHost.panels.get('demo-panel');
    assert.ok(panel, '同 url 刷新不应退场');
    assert.equal(panel.stub.url, '/protoclaw/feature-assets/demo-plugin/1.0.0/index.js');
  });

  it('同面板换版（url 变化）替换为新 stub', async () => {
    await ctx.window.ClawFW.featureUi.refresh();
    pending.push({ ok: true, declarations: [decl('demo-panel', '/protoclaw/feature-assets/demo-plugin/1.1.0/index.js')] });
    await ctx.window.ClawFW.featureUi.refresh();
    const panel = ctx.window.ClawHost.panels.get('demo-panel');
    assert.ok(panel);
    assert.equal(panel.stub.url, '/protoclaw/feature-assets/demo-plugin/1.1.0/index.js');
  });

  it('API 失败不清空已生效的声明', async () => {
    await ctx.window.ClawFW.featureUi.refresh();
    pending.push({ ok: false, error: 'boom' });
    await ctx.window.ClawFW.featureUi.refresh();
    assert.ok(ctx.window.ClawHost.panels.get('demo-panel'), '失败刷新应保留现有声明');
  });

  it('stop() 清理轮询定时器（无 Timeout 句柄残留）', async () => {
    await ctx.window.ClawFW.featureUi.refresh();
    ctx.window.ClawFW.featureUi.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const timers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
    assert.equal(timers.length, 0);
  });
});

describe('ClawHost.panels.undeclare（声明退场入口）', () => {
  it('移除懒声明的 stub 与注册项，不再被 restore 复活', () => {
    const ctx = createFrontendSandbox({});
    ctx.loadSource('public/src/modules/claw-host.js');
    const host = ctx.window.ClawHost;
    host.panels.declare('p1', { label: { zh: '一', en: 'One' } }, { pluginId: 'p1', url: '/x.js' });
    assert.ok(host.panels.get('p1'));
    assert.equal(host.panels.undeclare('p1'), true);
    assert.equal(host.panels.get('p1'), undefined);
    // real 注册后再 undeclare，同样整体退场（不恢复 stub）
    host.panels.declare('p2', { label: { zh: '二', en: 'Two' } }, { pluginId: 'p2', url: '/y.js' });
    host.panels.register('p2', { render() { return ''; } }, 'p2');
    host.panels.undeclare('p2');
    assert.equal(host.panels.get('p2'), undefined);
    // 未声明的 id 是无害 no-op
    assert.equal(host.panels.undeclare('ghost'), false);
  });
});
