/**
 * thread-stream 前端纯函数（frontend 沙箱）
 *
 * 以服务端真实投影输出驱动往返（计划 §4 测试策略）：先在 Node 侧用
 * 真实 reader（5 棒链 fixture）跑出流接口响应，再喂给沙箱内加载的
 * public/src/modules/thread-stream.js，验证：
 *   1. buildStreamModel + mergeHeadMessages：单流基线 = predecessor 可见
 *      消息 + head 边界后新增段，seed 段零重复；
 *   2. shouldRewrite：headSessionId / contentHash 双触发；
 *   3. createRebindDebouncer：窗口内合并为一次 rewrite；
 *   4. 视图状态对话键控（草稿跨换头保持、键间隔离）；
 *   5. threadStreamStatusLine：rotation_failed / thread_queued 呈现；
 *   6. submitThreadStreamInput：POST 目标线程入口、thread_queued 占位事实；
 *   7. attachThreadStream：SSE 订阅 + 初始快照、detach 收尾。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { buildThreadStreamFixture } from './helpers/thread-stream-fixture.js';

let base = null;
let fixture = null;
let incompleteFixture = null;
let headEnriched = [];

before(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), 'claw-thread-stream-fe-'));
  fixture = await buildThreadStreamFixture(path.join(base, 'fx'));
  incompleteFixture = await buildThreadStreamFixture(path.join(base, 'fx-inc'), { dropSeedBoundarySeam: 1 });
  // head 棒的 probe 通道全量数组（count 制，含 seed 段）——从落盘快照读
  const headSnapshot = JSON.parse(await fsp.readFile(
    path.join(fixture.paths.sessionsDir, 's4.json'), 'utf8'));
  headEnriched = headSnapshot.runtime.context.enrichedMessages;
});
after(async () => { if (base) await fsp.rm(base, { recursive: true, force: true }); });

function loadModule(overrides = {}) {
  const ctx = createFrontendSandbox(overrides);
  ctx.loadSource('public/src/modules/thread-stream.js');
  return ctx;
}

async function realSnapshot(fx = fixture) {
  const result = await fx.reader.readThreadStream(fx.threadId);
  return { ok: true, ...result };
}

describe('thread-stream frontend: single-flow baseline from real projection', () => {
  test('merges predecessor visible messages with post-boundary head additions, no seed duplicates', async () => {
    const ctx = loadModule();
    const snapshot = await realSnapshot();
    ctx.run(`window.__model = window.ThreadStream.buildStreamModel(${JSON.stringify(snapshot)})`);
    const model = ctx.run('window.__model');

    assert.equal(model.threadId, fixture.threadId);
    assert.equal(model.headSessionId, 's4');
    assert.equal(model.predecessor.length, 4);
    assert.equal(model.head.visibleStartIndex, 59);
    assert.equal(model.head.baselineCount, 74);
    assert.equal(model.hasIncomplete, false);

    // head probe 全量数组（含 seed 段）→ 仅边界后新增段并入
    const m = ctx.run(
      `window.ThreadStream.mergeHeadMessages(window.__model, ${JSON.stringify(headEnriched)})`,
    );

    assert.equal(m.rewound, false);
    assert.equal(m.headCount, 74);
    // 130 + 40 + 30 + 20 + (74 - 59)
    assert.equal(m.messages.length, 130 + 40 + 30 + 20 + 15);
    // 消息稳定标识保留（enriched id / sequence 透传）
    assert.equal(m.messages[0].id, `msg-s0-0000`);
    assert.ok(m.messages.every((msg) => typeof msg.id === 'string' && Number.isInteger(msg.sequence)));
    // seed 段零重复呈现（fixture 的 seed content 均以 seed[ 开头）
    assert.equal(m.messages.filter((msg) => /^seed\[/.test(String(msg.content))).length, 0);
    // head 段第一条 = seed 边界后的自有消息
    const tail = m.messages.slice(-15);
    assert.equal(tail[0].content, 'own[s4][0]');
    assert.equal(tail[14].content, 'own[s4][14]');
  });

  test('flags rewound when the head array shrinks past the boundary (baseline invalid → rewrite)', async () => {
    const ctx = loadModule();
    const snapshot = await realSnapshot();
    ctx.run(`window.__model = window.ThreadStream.buildStreamModel(${JSON.stringify(snapshot)})`);
    const shortArray = headEnriched.slice(0, 30);
    const m = ctx.run(`window.ThreadStream.mergeHeadMessages(window.__model, ${JSON.stringify(shortArray)})`);
    assert.equal(m.rewound, true);
    // 不把旧基线与新数组拼接：head 段并入为空
    assert.equal(m.messages.length, 130 + 40 + 30 + 20);
  });
});

describe('thread-stream frontend: rewrite triggers and rebind debounce', () => {
  test('shouldRewrite reacts to headSessionId and contentHash independently', async () => {
    const ctx = loadModule();
    const snapshot = await realSnapshot();
    const model = ctx.run(`window.ThreadStream.buildStreamModel(${JSON.stringify(snapshot)})`);
    assert.equal(ctx.run(`window.ThreadStream.shouldRewrite(null, {})`), true);
    assert.equal(ctx.run(`window.ThreadStream.shouldRewrite(undefined, { headSessionId: 's4' })`), true);
    ctx.run(`window.__m = window.ThreadStream.buildStreamModel(${JSON.stringify(snapshot)})`);
    assert.equal(ctx.run(`window.ThreadStream.shouldRewrite(window.__m, { headSessionId: 's4', contentHash: ${JSON.stringify(model.contentHash)} })`), false);
    assert.equal(ctx.run(`window.ThreadStream.shouldRewrite(window.__m, { headSessionId: 's5' })`), true);
    assert.equal(ctx.run(`window.ThreadStream.shouldRewrite(window.__m, { contentHash: 'deadbeef' })`), true);
  });

  test('debouncer merges bursts into one rebind carrying the latest head', async () => {
    const ctx = loadModule();
    ctx.run(`
      window.__rebinds = [];
      window.__deb = window.ThreadStream.createRebindDebouncer((h) => window.__rebinds.push(h), 5);
      window.__deb.schedule('s5');
      window.__deb.schedule('s6');
      window.__deb.schedule('s7');
    `);
    await new Promise((r) => setTimeout(r, 25));
    // 跨 vm realm 的数组不做 deepEqual（原型不等）：标量逐项断言
    const rebinds = ctx.run('window.__rebinds');
    assert.equal(rebinds.length, 1);
    assert.equal(rebinds[0], 's7');
    // cancel 抑制未触发的窗口
    ctx.run(`window.__deb2 = window.ThreadStream.createRebindDebouncer(() => window.__rebinds.push('late'), 5); window.__deb2.schedule(); window.__deb2.cancel();`);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(ctx.run('window.__rebinds.length'), 1);
  });
});

describe('thread-stream frontend: conversation-keyed view state', () => {
  test('drafts survive across keys and merges are per-key', () => {
    const ctx = loadModule();
    ctx.run(`
      window.ThreadStream.setConversationViewState('conv-a', { draft: '写着没发' });
      window.ThreadStream.setConversationViewState('conv-b', { draft: '另一段' });
      window.ThreadStream.setConversationViewState('conv-a', { scrollAnchor: 'msg-9' });
    `);
    const a = ctx.run(`window.ThreadStream.getConversationViewState('conv-a')`);
    const b = ctx.run(`window.ThreadStream.getConversationViewState('conv-b')`);
    assert.equal(a.draft, '写着没发');
    assert.equal(a.scrollAnchor, 'msg-9');
    assert.equal(b.draft, '另一段');
    assert.equal(b.scrollAnchor, null);
    assert.equal(ctx.run(`window.ThreadStream.getConversationViewState('conv-missing')`), null);
  });
});

describe('thread-stream frontend: status line & block rendering', () => {
  test('rotation_failed and thread_queued render as recoverable status strips', () => {
    const ctx = loadModule();
    const failed = ctx.run(`window.ThreadStream.threadStreamStatusLine({ threadStatus: 'rotation_failed' })`);
    assert.match(failed, /data-thread-status="rotation_failed"/);
    assert.match(failed, /thread-stream-status--error/);
    assert.ok(failed.includes('上下文轮换未完成'));

    const queued = ctx.run(`window.ThreadStream.threadStreamStatusLine({ pendingDelivery: { text: '继续' } })`);
    assert.match(queued, /data-thread-status="thread_queued"/);
    assert.ok(queued.includes('已发送，等待送达当前会话'));
    assert.ok(queued.includes('继续'));

    assert.equal(ctx.run(`window.ThreadStream.threadStreamStatusLine({ threadStatus: 'open' })`), '');
  });

  test('block render emits keyed skeleton; incomplete chains surface an explicit strip', async () => {
    const ctx = loadModule();
    const snapshot = await realSnapshot(incompleteFixture);
    ctx.run(`window.__snapshots = {}`);
    // 先渲染（无模型时骨架），注入模型后 incomplete 条出现
    const bare = ctx.run(`window.ThreadStream.renderThreadStreamBlock({ type: 'thread-stream', threadId: ${JSON.stringify(fixture.threadId)} })`);
    assert.match(bare, new RegExp(`data-thread-id="${fixture.threadId}"`));
    assert.match(bare, /data-thread-stream-messages="1"/);
    assert.match(bare, /data-thread-stream-composer="1"/);

    // 通过 attach 注入模型（fetch stub 返回 incomplete 快照）后渲染
    const ctx2 = loadModule({
      fetch: async () => ({ ok: true, json: async () => snapshot }),
      window: {
        ClawFW: {
          SseClient: {
            subscribeThreadEvents: () => () => {},
          },
        },
      },
    });
    ctx2.run(`
      window.__detach = window.ThreadStream.attachThreadStream(${JSON.stringify(incompleteFixture.threadId)}, {
        pollIntervalMs: 60000,
      });
    `);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const html = ctx2.run(`window.ThreadStream.renderThreadStreamBlock({ type: 'thread-stream', threadId: ${JSON.stringify(incompleteFixture.threadId)} })`);
      assert.match(html, /data-thread-incomplete="1"/);
    } finally {
      ctx2.run('if (window.__detach) window.__detach()');
    }
  });
});

describe('thread-stream frontend: submit via thread-addressed input', () => {
  test('posts to the thread input endpoint without any session/viewer id', async () => {
    const requests = [];
    const ctx = loadModule({
      fetch: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            ok: true,
            delivery: 'thread_queued',
            threadId: fixture.threadId,
            commandId: 'cmd-42',
          }),
        };
      },
    });
    const result = await ctx.run(`window.ThreadStream.submitThreadStreamInput(${JSON.stringify(fixture.threadId)}, {
      text: '继续',
      capabilityActivations: ['skill-x'],
      metadata: { note: 1 },
    })`);
    assert.equal(result.delivery, 'thread_queued');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `/protoclaw/threads/${fixture.threadId}/input`);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.text, '继续');
    assert.deepEqual(body.capabilityActivations, ['skill-x']);
    assert.deepEqual(body.metadata, { note: 1 });
    assert.equal('viewerAgentId' in body || 'sessionId' in body, false, 'must not compute session/viewer addressing');
    // 占位事实
    const pending = ctx.run(`window.ThreadStream.getPendingDelivery(${JSON.stringify(fixture.threadId)})`);
    assert.equal(pending.commandId, 'cmd-42');
    assert.equal(pending.text, '继续');
    ctx.run(`window.ThreadStream.clearPendingDelivery(${JSON.stringify(fixture.threadId)})`);
    assert.equal(ctx.run(`window.ThreadStream.getPendingDelivery(${JSON.stringify(fixture.threadId)})`), null);
  });

  test('surfaces structured errors (code/status) for failed submits', async () => {
    const ctx = loadModule({
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ ok: false, code: 'head_runtime_unavailable', message: 'nope' }),
      }),
    });
    await assert.rejects(
      () => ctx.run(`window.ThreadStream.submitThreadStreamInput('wt-x', { text: 'hi' })`),
      (err) => err.code === 'head_runtime_unavailable' && err.status === 503,
    );
  });
});

describe('thread-stream frontend: attach binds SSE subscription and initial snapshot', () => {
  test('subscribes to thread events, builds the baseline, detaches cleanly', async () => {
    const snapshot = await realSnapshot();
    const subscribed = [];
    let unsubscribeCalled = 0;
    const ctx = loadModule({
      fetch: async () => ({ ok: true, json: async () => snapshot }),
      window: {
        ClawFW: {
          SseClient: {
            subscribeThreadEvents: (threadId, handler) => {
              subscribed.push({ threadId, handler });
              return () => { unsubscribeCalled += 1; };
            },
          },
        },
      },
    });
    ctx.run(`
      window.__rewrites = [];
      window.__detach = window.ThreadStream.attachThreadStream(${JSON.stringify(fixture.threadId)}, {
        onRewrite: (m) => window.__rewrites.push(m),
        pollIntervalMs: 60000,
      });
    `);
    try {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(subscribed.length, 1);
      assert.equal(subscribed[0].threadId, fixture.threadId);
      const rewrites = ctx.run('window.__rewrites');
      assert.equal(rewrites.length, 1, 'initial snapshot triggers exactly one rewrite');
      assert.equal(rewrites[0].headSessionId, 's4');

      // SSE head-advanced 事件即时进入去抖通道（主 realm 直接调用注册的 handler）
      subscribed[0].handler({ type: 'thread.head-advanced', payload: { toSessionId: 's5' } });
      await new Promise((r) => setTimeout(r, 400)); // > 默认 300ms 去抖窗口
      assert.equal(ctx.run('window.__rewrites.length'), 2, 'head-advanced triggers a debounced rebind');
    } finally {
      // 清理纪律：detach 必须执行，否则轮询 interval 阻止进程退出
      ctx.run('if (window.__detach) window.__detach()');
    }
    assert.equal(unsubscribeCalled, 1);
  });
});
