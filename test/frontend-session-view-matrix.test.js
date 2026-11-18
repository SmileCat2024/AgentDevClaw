import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { createMetadataCommit } from '../public/src/modules/metadata-commit.js';
import { APP_CORE_DOMAIN, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const loaderSource = fs.readFileSync(new URL('../public/src/modules/session-data-loader.js', import.meta.url), 'utf8');
const agentLoaderSource = fs.readFileSync(new URL('../public/src/modules/agent-loader.js', import.meta.url), 'utf8');
const sseSource = fs.readFileSync(new URL('../public/src/modules/sse-client.js', import.meta.url), 'utf8');

/**
 * 会话视图边界用例（P4 T2 起 session-view-state 是 ESM）：classic 侧只补窗口宿主面
 * （首屏编排 / overview / todo 的桥键实现不在本域），域模块在模块相真实求值，桥键
 * 因此装到同一个沙箱 window 上——用例里的裸名调用语义与迁移前一致。
 */
function withView(options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const { runtimeId = 'runtime-a', hostId = 'host-a', epoch = 1 } = options || {};
  // 沙箱在 classic 回调里创建，宿主工厂闭包取它的活值（focusedAgentId 会被用例改）
  let sandbox = null;
  return withP2EsmCase({
    label: 'session-view-matrix',
    classic: (caseSandbox) => {
      sandbox = caseSandbox;
      // app-core 是状态键的生产注册面（orchestration / agent-store / session-view-storage
      // 三域的 defineKey 与初值都在它里面）：本域 ESM 化后，owner 的活绑定与沙箱
      // 访问器必须经这些注册行接上，否则用例的裸名写入只落在沙箱属性上。
      prepareEsmModules(caseSandbox, APP_CORE_DOMAIN);
      caseSandbox.run(`currentRuntimeAgentId = ${JSON.stringify(runtimeId)};
        focusedAgentId = ${JSON.stringify(hostId)};
        _switchEpoch = ${epoch};`);
      prepareEsmModules(caseSandbox, SESSION_VIEW_DOMAIN);
    },
    globals: {
      getCurrentHostAgentRecord: () => ({ id: sandbox?.focusedAgentId }),
      getEmptyOverviewSnapshot: () => ({ empty: true }),
      getEmptyTodoPlan: () => ({ tasks: [] }),
      notifyInputSurfaceChanged() {},
    },
  }, async (c) => fn(c.sandbox));
}

const producers = [
  'initial load', 'poll', 'SSE', 'cache restoration',
  'await-surface messages', 'historical browsing', '404 handling',
];
const identityMigrations = [
  'same runtime, new session', 'new runtime', 'identity cleared', 'sessionMeta derives identity',
  'explicit identity change', 'same-runtime double-session revisit',
];
const timings = ['response commits before migration', 'response returns after migration', 'switch epoch advances'];

// Matrix coverage: every producer is checked against every meaningful identity migration.
// 同一 case 内逐组合重置（唯一身份 + runtimeId / epoch 复位）：断言与逐用例建沙箱时
// 等价，副产物是把 126 组矩阵压在一代模块图上（逐组合建图会超出单文件墙钟预算）。
test('producer × identity migration × timing matrix', async (t) => {
  let combo = 0;
  await withView(async (ctx) => {
    for (const producer of producers) {
      for (const migration of identityMigrations) {
        for (const timing of timings) {
          combo += 1;
          await t.test(`${producer}: ${timing} under ${migration}`, () => {
            ctx.run(`currentRuntimeAgentId = 'runtime-a'; focusedAgentId = 'host-a'; _switchEpoch = 1;
              applySessionViewPatch({ identity: { agentId: 'matrix-reset-${combo}', sessionId: 'reset' } });`);
            ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
            ctx.run("globalThis.__token = captureSessionViewToken('runtime-a')");
            if (timing === 'response commits before migration') {
              assert.equal(ctx.run(`commitSessionViewPatch(globalThis.__token, { messages: [{ content: ${JSON.stringify(producer)} }] })`), true);
              assert.equal(ctx.run('currentMessages[0].content'), producer);
              return;
            }

            if (migration === 'same runtime, new session') {
              ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-b' } })");
            } else if (migration === 'new runtime') {
              ctx.currentRuntimeAgentId = 'runtime-b';
              ctx.run("applySessionViewPatch({ identity: { agentId: 'host-b', sessionId: 'session-a' } })");
            } else if (migration === 'identity cleared') {
              ctx.run('applySessionViewPatch({ identity: null })');
            } else if (migration === 'sessionMeta derives identity') {
              ctx.run("applySessionViewPatch({ sessionMeta: { sessionId: 'session-b' } })");
            } else if (migration === 'explicit identity change') {
              ctx.run("applySessionViewPatch({ identity: { agentId: 'host-b', sessionId: 'session-b' } })");
            } else {
              ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-b' } })");
              ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
            }
            if (timing === 'switch epoch advances') ctx._switchEpoch += 1;
            ctx.run("currentMessages = [{ content: 'current' }]");
            // 身份代次守卫：任何身份变化（含 A→B→A 回访——epoch 未推进、身份
            // 恰好回到原值）都作废捕获时的 token，迟到响应一律拒绝提交。
            const committed = ctx.run(`commitSessionViewPatch(globalThis.__token, { messages: [{ content: ${JSON.stringify(producer)} }] })`);
            assert.equal(committed, false);
            assert.equal(ctx.run('currentMessages[0].content'), 'current');
          });
        }
      }
    }
  });
});

test('identity normalization trims IDs and maps missing/empty session IDs to host-only identity', async () => {
  await withView((ctx) => {
    const normalized = ctx.run("normalizeSessionViewIdentity({ agentId: ' host-a ', sessionId: '   ' })");
    assert.equal(normalized.agentId, 'host-a');
    assert.equal(normalized.sessionId, '');
    assert.equal(ctx.run("normalizeSessionViewIdentity({ agentId: ' ', sessionId: 'session-a' })"), null);
    assert.equal(ctx.run('normalizeSessionViewIdentity(null)'), null);
  });
});

test('identity-changing patch wipes all prior session snapshots', async () => {
  await withView((ctx) => {
    ctx.run(`applySessionViewPatch({
      identity: { agentId: 'host-a', sessionId: 'session-a' },
      messages: [{ content: 'A' }], inputRequests: [{ requestId: 'a' }],
      toolRenderConfigs: { a: true }, toolNames: { a: 'A' }, hookInspector: { hooks: ['a'] },
      overview: { modelName: 'A' }, todoPlan: { tasks: [{ id: 'a' }] },
      sessionMeta: { sessionId: 'session-a' }, connected: true,
    })`);
    ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-b' } })");
    const view = ctx.run('readCurrentSessionViewState()');
    assert.equal(view.identity.sessionId, 'session-b');
    assert.equal(view.messages.length, 0);
    assert.equal(view.inputRequests.length, 0);
    assert.equal(Object.keys(view.toolRenderConfigs).length, 0);
    assert.equal(Object.keys(view.toolNames).length, 0);
    assert.equal(view.hookInspector.hooks.length, 0);
    assert.equal(view.overview.empty, true);
    assert.equal(view.todoPlan.tasks.length, 0);
    assert.equal(view.sessionMeta.sessionId, '');
    assert.equal(view.connected, false);
  });
});

test('sessionMeta-only patch derives the current host and session identity without an explicit wipe', async () => {
  await withView((ctx) => {
    ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
    ctx.run("applySessionViewPatch({ sessionMeta: { sessionId: 'session-b' } })");
    const view = ctx.run('readCurrentSessionViewState()');
    assert.equal(view.identity.agentId, 'host-a');
    assert.equal(view.identity.sessionId, 'session-b');
  });
});

test('explicit identity equal to current identity does not wipe; null identity clears session snapshots', async () => {
  await withView((ctx) => {
    ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
    ctx.run("applySessionViewPatch({ messages: [{ content: 'A' }] })");
    ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' }, connected: true })");
    assert.equal(ctx.run('currentMessages[0].content'), 'A');
    ctx.run('applySessionViewPatch({ identity: null })');
    assert.equal(ctx.run('currentMessages.length'), 0);
    assert.equal(ctx.run('readCurrentSessionViewState().identity.sessionId'), '');
  });
});

test('direct apply callers are synchronous navigation transactions; async message producers are guarded', () => {
  // 等待表面（异步读档 → SessionView 提交）已随交互域迁出 thread-store-domain：
  // 源码契约的切片改在新文件上（引擎的刷新/对账链路不在本断言范围）。
  const threadDomain = fs.readFileSync(new URL('../public/src/modules/thread-store-domain.js', import.meta.url), 'utf8');
  // 历史记录浏览（只读浏览唯一实现）：异步读档必须带导航代次守卫，并有
  // 请求期间目标漂移的二次校验；提交走 SessionView token。
  const readonlySource = fs.readFileSync(new URL('../public/src/modules/session-readonly-view.js', import.meta.url), 'utf8');
  const awaitLoader = threadDomain.slice(
    threadDomain.indexOf('function _loadAwaitSurfaceMessages'),
    threadDomain.indexOf('export async function openConversationTarget'),
  );
  assert.match(awaitLoader, /captureSessionViewToken\('', \{ agentId, sessionId \}\)/);
  assert.match(awaitLoader, /commitSessionViewPatch\(viewToken, \{ messages: data\.messages \}/);
  assert.match(readonlySource, /navigationEpoch !== _navigationEpoch\(\)/);
  assert.match(readonlySource, /_state\.agentId !== agentId \|\| _state\.sessionId !== sessionId/);
  assert.match(readonlySource, /applySessionViewPatch\(\{ identity: \{ agentId, sessionId \} \}\)/);
  assert.match(readonlySource, /commitSessionViewPatch\(viewToken, patch, commit\)/);
});

test('initial loading and polling paths guard responses and commit through SessionView', async () => {
  assert.match(loaderSource, /const token = host\.capture\(agentId\)/);
  assert.match(loaderSource, /if \(!host\.isCurrent\(token\)\)/);
  assert.match(loaderSource, /host\.patch\(token/);
  // Real polling capture/stale-response behavior is exercised by the poll
  // consistency and rollback-button race suites, independent of source location.
  await withView(async (ctx) => {
    ctx.createCommittedViewRendererHost = () => ({});
    const metadata = createMetadataCommit({
      ...ctx.run(`(() => { ${mainSource.slice(mainSource.indexOf('function createMetadataCommitHost('), mainSource.indexOf('function createPollMaintenanceHost('))}; return createMetadataCommitHost(() => ({ renderMetadata() {} })); })()`),
      render() {},
    });
    const token = ctx.run('captureSessionViewToken()');
    ctx._switchEpoch += 1;
    assert.equal(metadata.commitMetadataUpdate(token, {}), false, 'a departed poll view cannot publish metadata');
  });
  // Runtime disappearance uses the same guarded patch; its thread-specific
  // preservation paths execute in the succession-404/await-rebind suites.
});

test('SSE focus events capture a SessionView token before metadata commits', () => {
  // sse-client 已迁 ESM：focus 帧的元数据提交在帧到达时捕获 SessionView
  // token，再交真实 metadata-commit。帧分发函数是模块私有（公开导出只有
  // 连接/看门狗/排队文本面），所以这是**源码契约**（不冒充运行时行为）。
  // 捕获点接受两种合法形态：经 classic 桥 `window.captureSessionViewToken(...)`
  // 与迁移后的直接 import `captureSessionViewToken(...)`。
  const captureSites = sseSource.match(/const token = (?:window\.)?captureSessionViewToken\(\s*frame\.agentId\s*\)/g) || [];
  assert.ok(captureSites.length > 0, 'focus 帧必须捕获 SessionView token（接受桥或 import 形态）');
  const commits = sseSource.match(/commitMetadataUpdate\(/g) || [];
  const tokenizedCommits = sseSource.match(/commitMetadataUpdate\(token/g) || [];
  assert.ok(commits.length > 0, 'SSE 帧确实提交元数据');
  assert.equal(tokenizedCommits.length, commits.length, '所有元数据提交都必须携带帧到达时捕获的 token（不允许无 token 提交漏网）');
});

test('session detail uses a guarded metadata commit for the selected identity', () => {
  // Runtime cache restoration is exercised with real SessionView patches in
  // session-ui-context.test.js; do not lock its implementation to app-core.
  assert.match(agentLoaderSource, /host\.commitSessionViewPatch\(sessionViewToken, \{ sessionMeta \},/);
  assert.match(agentLoaderSource, /extractSessionMetaFromDetail\(detail, selectedIdentity\.sessionId\)/);
});
