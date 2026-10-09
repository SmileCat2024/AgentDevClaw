/**
 * desktop-open.js（Windows 右键菜单唤起请求）单测。
 * 沙箱加载模块，stub 壳/前端入口函数，验证：
 *   - URL query 解析（percent 解码、trim、无效值忽略）
 *   - 两个动作的分发（open → phOpenProjectDirectory；new-chat → create_session）
 *   - 无效请求与串行排队语义
 *   - boot 消费：命中 query 后清理 URL 再执行
 * 传参一律经 JSON.stringify 组装进 vm 代码，避免多层手写转义。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const consume = (ctx, request) => ctx.run(`window.__clawConsumeOpenRequest(${JSON.stringify(request)})`);

// 沙箱数组与 Node 主 realm 的 Array.prototype 不同源，deepEqual 会因原型
// 不同失败；统一 JSON 往返后断言。
function callsOf(ctx) {
  return JSON.parse(ctx.run('JSON.stringify(window.__calls)'));
}

function loadModule() {
  const ctx = createFrontendSandbox({ URLSearchParams });
  ctx.run(`
    window.__calls = [];
    window.handlePrebuiltAgentClick = async (id) => { window.__calls.push(['switch', id]); };
    window.phOpenProjectDirectory = async (dir) => { window.__calls.push(['open', dir]); };
    window.runWorkspaceAction = async (raw) => { window.__calls.push(['create', raw]); };
  `);
  ctx.loadSource('public/src/modules/desktop-open.js');
  return ctx;
}

describe('desktop-open 右键唤起请求', () => {
  it('parseOpenRequestFromSearch：解码 query、trim、无效值返回 null', () => {
    const ctx = loadModule();
    const parseRaw = ctx.run('window.ClawDesktopOpen.parseOpenRequestFromSearch');
    const parse = (search) => JSON.parse(JSON.stringify(parseRaw(search)));
    assert.deepEqual(parse('?claw-open=D%3A%5Ccode%5Cmy%20project'), { action: 'open', cwd: 'D:\\code\\my project' });
    assert.deepEqual(parse('?claw-new-chat=D%3A%5Cdev'), { action: 'new-chat', cwd: 'D:\\dev' });
    assert.equal(parse(''), null);
    assert.equal(parse('?other=1'), null);
    assert.equal(parse('?claw-open=%20%20'), null); // 空白目录视为无请求
  });

  it('open 动作：先切编程小助手工作空间，再以目录定位项目', async () => {
    const ctx = loadModule();
    await consume(ctx, { action: 'open', cwd: 'D:\\proj' });
    assert.deepEqual(callsOf(ctx), [
      ['switch', 'programming-helper'],
      ['open', 'D:\\proj'],
    ]);
  });

  it('new-chat 动作：切工作空间后以目录新建会话', async () => {
    const ctx = loadModule();
    await consume(ctx, { action: 'new-chat', cwd: 'D:\\proj' });
    const calls = callsOf(ctx);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['switch', 'programming-helper']);
    assert.equal(calls[1][0], 'create');
    const action = JSON.parse(calls[1][1]);
    assert.deepEqual({ type: action.type, openDirectory: action.openDirectory },
      { type: 'create_session', openDirectory: 'D:\\proj' });
  });

  it('无效请求（未知动作 / 空目录）不产生任何调用', async () => {
    const ctx = loadModule();
    await consume(ctx, { action: 'bogus', cwd: 'D:\\x' });
    await consume(ctx, { action: 'open', cwd: '' });
    await ctx.run('window.__clawConsumeOpenRequest(null)');
    assert.deepEqual(callsOf(ctx), []);
  });

  it('进行中的请求串行排队：后到请求在前一个完成后执行', async () => {
    const ctx = loadModule();
    // 第一笔请求卡在 switch，手工放行
    ctx.run(`
      window.__release = null;
      window.handlePrebuiltAgentClick = async (id) => {
        window.__calls.push(['switch', id]);
        if (!window.__release) await new Promise((resolve) => { window.__release = resolve; });
      };
    `);
    const first = consume(ctx, { action: 'open', cwd: 'D:\\one' });
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让第一笔进入 switch
    const second = consume(ctx, { action: 'open', cwd: 'D:\\two' });
    await ctx.run('window.__release()');
    await Promise.all([first, second]);
    const calls = callsOf(ctx);
    assert.deepEqual(calls.map((c) => c[0]), ['switch', 'open', 'switch', 'open']);
    assert.deepEqual(calls[1], ['open', 'D:\\one']);
    assert.deepEqual(calls[3], ['open', 'D:\\two']);
  });

  it('boot 消费：命中 query 先清 URL 再执行动作；无 query 不动', async () => {
    const ctx = loadModule();
    ctx.run(`
      history = { replaceState: (s, t, url) => { window.__replacedUrl = url; } };
      location.search = '?claw-new-chat=D%3Aboot';
      location.pathname = '/';
    `);
    await ctx.run('window.ClawDesktopOpen.consumeBootOpenRequest()');
    assert.equal(ctx.run('window.__replacedUrl'), '/');
    assert.equal(callsOf(ctx).length, 2);
    assert.deepEqual(callsOf(ctx)[0], ['switch', 'programming-helper']);

    const ctx2 = loadModule();
    ctx2.run(`
      history = { replaceState: () => { throw new Error('should not run'); } };
      location.search = '';
    `);
    await ctx2.run('window.ClawDesktopOpen.consumeBootOpenRequest()');
    assert.deepEqual(callsOf(ctx2), []);
  });
});
