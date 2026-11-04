import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMinimalWindow } from './helpers/memo-plugin-loader.js';

const PLUGIN_FILE = path.resolve(
  import.meta.dirname, '..', 'public', 'src', 'plugins', 'coder', 'index.js',
);

async function loadPlugin(host) {
  const url = `${pathToFileURL(PLUGIN_FILE).href}?case=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const descriptor = mod.default;
  if (typeof descriptor.mount === 'function') descriptor.mount(host);
  return { descriptor, mod };
}

function makeHost() {
  return {
    env: {
      language: 'zh',
      isZh: () => true,
      escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      newIdempotencyKey: () => 'test-key',
    },
    workspace: {
      currentAgent: () => ({ id: 'coder' }),
      agentById: (id) => (id === 'coder' ? { id: 'coder' } : null),
      rerender: () => {},
    },
  };
}

// 动态 import 是测试隔离需要（模块级 viewState 每用例需新实例），但每次
// import 都是新模块图编译。全量并行下这个启动 burst 会挤压真实子进程
// 测试（ph-* runtime 6s 启动预算）的 CPU 余量，因此按需控制次数：纯函数
// 用例（archiveResultText / deleteConfirmText）共享一次装载，只有需要
// mount + window 注入的用例才独立装载。
let sharedTextMod = null;
async function loadSharedTextModule() {
  if (!sharedTextMod) sharedTextMod = (await loadPlugin(makeHost())).mod;
  return sharedTextMod;
}

describe('T006 coder 插件: 归档取消结果与删除确认文案', () => {
  it('opening a thread targets its current head through the unified conversation entry', async () => {
    const restore = installMinimalWindow();
    try {
      let openedTarget = null;
      globalThis.window.ClawThreads = { byId: { 'wt-1': {
        threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'head-1',
      } } };
      globalThis.window.getThreadById = (id) => globalThis.window.ClawThreads.byId[id];
      globalThis.window.openConversationTarget = async (target) => { openedTarget = target; };
      const { descriptor } = await loadPlugin(makeHost());
      await descriptor.actions['coderThreads.openHead']({ dataset: { threadId: 'wt-1' } });
      assert.equal(openedTarget?.agentId, 'programming-helper');
      assert.equal(openedTarget?.threadId, 'wt-1');
    } finally { restore(); }
  });

  it('归档文案以 cleanup 事实为准，明确「取消归档不重发已取消消息」', async () => {
    const mod = await loadSharedTextModule();
    const text = mod.archiveResultText({
      status: 'complete',
      commandsCancelled: 2,
      handoffConverged: true,
      inflightDrain: { count: 1 },
    }, true);
    assert.ok(text.includes('2 条排队中的消息已取消'));
    assert.ok(text.includes('归档后不再接收新消息'));
    assert.ok(text.includes('1 项进行中的任务正在收尾'));
    assert.ok(text.includes('取消归档后这些消息不会自动重新发送'));
  });

  it('无取消事实时文案如实省略，不虚构也不制造无来由提醒', async () => {
    const mod = await loadSharedTextModule();
    const text = mod.archiveResultText({
      status: 'complete',
      commandsCancelled: 0,
      handoffConverged: false,
      inflightDrain: { count: 0 },
    }, true);
    assert.ok(!text.includes('条排队中的消息已取消'));
    assert.ok(!text.includes('项进行中的任务正在收尾'));
    // 提醒只在真的取消了消息时出现：空闲归档不提「已取消的消息」
    assert.ok(!text.includes('不会自动重新发送'));
    assert.ok(!text.includes('指令'), '文案不得残留「指令」这类内部术语');
  });

  it('删除确认展示级联影响范围（成员会话数 + 待投递指令数）', async () => {
    const mod = await loadSharedTextModule();
    const zh = mod.deleteConfirmText({
      sessionChain: [{ sessionId: 's-1' }, { sessionId: 's-2' }],
      headSessionId: 's-3',
      rootSessionId: 's-1',
      commands: [{ status: 'pending' }, { status: 'in_flight' }, { status: 'delivered' }],
    }, true);
    assert.ok(zh.includes('3 个会话'));
    assert.ok(zh.includes('2 条待投递/运行中指令会被取消'));
    assert.ok(zh.includes('不可撤销'));
  });

  it('删除确认无待投递指令时不提示取消（不虚构）', async () => {
    const mod = await loadSharedTextModule();
    const zh = mod.deleteConfirmText({
      sessionChain: [{ sessionId: 's-1' }],
      headSessionId: 's-1',
      commands: [{ status: 'delivered' }],
    }, true);
    assert.ok(!zh.includes('待投递/运行中指令会被取消'));
  });
});
