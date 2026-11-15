/**
 * session-menu-decls.js 的模块契约（ADR-0049）：
 *   - sessionOpsAllowed：sessionOps 产品事实的单一来源——本地读 agent 记录
 *     声明；远程内层 id 查本地镜像记录 + 握手能力位门控（旧远程降级）。
 *   - getDeclaredSessionMenuItems：APP 声明项的谓词过滤与渲染形状；
 *     v1 远程叶子不呈现自定义项。
 *
 * 夹具镜像 /api/agents 的 agent 记录（metadata ... 展开形态）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// 沙箱内创建的对象/数组是跨 realm 原型，strict deepEqual 会因原型不同失败；
// 统一经 JSON 归一到本地 realm 再比较。
function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadDecls({ agents, language = 'zh', remote } = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: language,
    allAgents: agents,
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
  });
  if (remote) ctx.window.RemoteConnections = remote;
  ctx.loadSource('public/src/modules/session-menu-decls.js');
  return ctx;
}

describe('session-menu-decls: sessionOpsAllowed（事实解析）', () => {
  const DECLARED = [{ id: 'programming-helper', sessionOps: true }];
  const UNDECLARED = [{ id: 'memo', threadHost: true }];

  it('本地声明 sessionOps 的 APP → true；未声明的 APP → false', () => {
    const ctx = loadDecls({ agents: [...DECLARED, ...UNDECLARED] });
    assert.equal(ctx.run(`sessionOpsAllowed('programming-helper')`), true);
    assert.equal(ctx.run(`sessionOpsAllowed('memo')`), false);
  });

  it('本地无记录的 id → false；空输入 → false', () => {
    const ctx = loadDecls({ agents: DECLARED });
    assert.equal(ctx.run(`sessionOpsAllowed('ghost-app')`), false);
    assert.equal(ctx.run(`sessionOpsAllowed('')`), false);
  });

  it('远程叶子：镜像记录声明 + 能力位 true → true', () => {
    const ctx = loadDecls({
      agents: DECLARED,
      remote: { capabilityFor: () => true },
    });
    assert.equal(ctx.run(`sessionOpsAllowed('remote:lab-b:programming-helper')`), true);
  });

  it('远程叶子：能力位缺失（旧远程）→ 降级 false', () => {
    const ctx = loadDecls({
      agents: DECLARED,
      remote: { capabilityFor: () => false },
    });
    assert.equal(ctx.run(`sessionOpsAllowed('remote:lab-b:programming-helper')`), false);
  });

  it('远程叶子：内层 APP 未声明 sessionOps → 即使能力位 true 也 false', () => {
    const ctx = loadDecls({
      agents: UNDECLARED,
      remote: { capabilityFor: () => true },
    });
    assert.equal(ctx.run(`sessionOpsAllowed('remote:lab-b:memo')`), false);
  });

  it('RemoteConnections 不可用（目录未就绪）→ 远程事实回退镜像记录判定', () => {
    const ctx = loadDecls({ agents: DECLARED });
    assert.equal(ctx.run(`sessionOpsAllowed('remote:lab-b:programming-helper')`), true);
  });
});

describe('session-menu-decls: getDeclaredSessionMenuItems（声明项）', () => {
  function agentWithItems(items) {
    return [{ id: 'app-x', sessionOps: true, ui: { sessionMenu: { items } } }];
  }

  it('声明项渲染为 {label, action, danger}，label 按当前语言解析', () => {
    const ctx = loadDecls({
      agents: agentWithItems([
        { id: 'a.move', label: { zh: '移动到…', en: 'Move to…' }, action: 'claw:move-session' },
        { id: 'a.wipe', label: { zh: '清除', en: 'Wipe' }, action: 'claw:wipe', danger: true },
      ]),
    });
    const items = toPlain(ctx.run(`getDeclaredSessionMenuItems('app-x', {})`));
    assert.deepEqual(items, [
      { label: '移动到…', action: 'claw:move-session', danger: false },
      { label: '清除', action: 'claw:wipe', danger: true },
    ]);
  });

  it('当前语言缺失时回退另一语言（en 视图 + 仅 zh 文案）', () => {
    const ctx = loadDecls({
      language: 'en',
      agents: agentWithItems([{ id: 'a.zh-only', label: { zh: '仅中文' }, action: 'claw:x' }]),
    });
    assert.equal(ctx.run(`getDeclaredSessionMenuItems('app-x', {})`)[0].label, '仅中文');
  });

  it('not-archived 谓词：归档会话滤除、未归档保留', () => {
    const ctx = loadDecls({
      agents: agentWithItems([{ id: 'a.m', label: { zh: '移动' }, action: 'claw:move-session', when: ['not-archived'] }]),
    });
    assert.equal(ctx.run(`getDeclaredSessionMenuItems('app-x', { archived: true })`).length, 0);
    assert.equal(ctx.run(`getDeclaredSessionMenuItems('app-x', { archived: false })`).length, 1);
  });

  it('has-thread / thread-busy 谓词按 facts 求值', () => {
    const ctx = loadDecls({
      agents: agentWithItems([
        { id: 'a.h', label: { zh: '有线程' }, action: 'claw:h', when: ['has-thread'] },
        { id: 'a.b', label: { zh: '忙' }, action: 'claw:b', when: ['thread-busy'] },
      ]),
    });
    assert.deepEqual(
      toPlain(ctx.run(`getDeclaredSessionMenuItems('app-x', { hasThread: true, threadBusy: false })`).map((i) => i.action)),
      ['claw:h'],
    );
    assert.deepEqual(
      toPlain(ctx.run(`getDeclaredSessionMenuItems('app-x', { hasThread: false, threadBusy: true })`).map((i) => i.action)),
      ['claw:b'],
    );
  });

  it('未知谓词按声明错误处理：项跳过并告警，不静默通过', () => {
    const warnings = [];
    const ctx = loadDecls({
      agents: agentWithItems([
        { id: 'a.bad', label: { zh: '坏' }, action: 'claw:bad', when: ['is-cool'] },
        { id: 'a.ok', label: { zh: '好' }, action: 'claw:ok' },
      ]),
    });
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const items = toPlain(ctx.run(`getDeclaredSessionMenuItems('app-x', {})`));
      assert.deepEqual(items.map((i) => i.action), ['claw:ok']);
      assert.ok(warnings.some((w) => w.includes('is-cool')), '未知谓词必须告警');
    } finally {
      console.warn = origWarn;
    }
  });

  it('远程叶子：自定义项 v1 隐藏（声明存在也返回空）', () => {
    const ctx = loadDecls({
      agents: agentWithItems([{ id: 'a.m', label: { zh: '移动' }, action: 'claw:move-session' }]),
      remote: { capabilityFor: () => true },
    });
    assert.deepEqual(toPlain(ctx.run(`getDeclaredSessionMenuItems('remote:lab-b:app-x', {})`)), []);
  });

  it('无声明或非法条目 → 空/跳过', () => {
    const noDecl = loadDecls({ agents: [{ id: 'app-y', sessionOps: true }] });
    assert.deepEqual(toPlain(noDecl.run(`getDeclaredSessionMenuItems('app-y', {})`)), []);
    const badEntries = loadDecls({
      agents: agentWithItems([
        null,
        { id: 'a.nolabel', action: 'claw:x' },
        { id: 'a.noaction', label: { zh: '缺动作' } },
      ]),
    });
    assert.deepEqual(toPlain(badEntries.run(`getDeclaredSessionMenuItems('app-x', {})`)), []);
  });
});
