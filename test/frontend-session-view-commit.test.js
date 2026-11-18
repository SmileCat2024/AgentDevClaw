/**
 * SessionView 提交策略（session-view-commit.js）与真实会话视图边界的对接。
 *
 * P4 T2 起 session-view-state / session-view-commit-host 都是 ESM：classic 相只剩
 * app-core 的状态键注册面，域模块在模块相真实求值（桥键装到同一个沙箱 window 上，
 * 用例里的 `ctx.x` 调用因此与迁移前同义）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

test('ESM commit host rejects stale visits without effects while preserving newer input and model fields', async () => {
  await withP2EsmCase({
    label: 'session-view-commit',
    classic: (sandbox) => {
      sandbox.loadSource('public/src/app-core.js');
      sandbox.run("currentRuntimeAgentId = 'runtime'; focusedAgentId = 'host';");
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
    },
  }, async (c) => {
    const ctx = c.sandbox;
    const { module } = { module: await c.load('public/src/modules/session-view-commit-host.js') };
    ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
    const beforeModule = ctx.captureSessionViewToken();
    let callbacks = 0;
    assert.equal(module.commitSessionViewPatch(beforeModule, { messages: [{ content: 'first' }] }, () => { callbacks++; }), true);
    assert.equal(ctx.currentMessages[0].content, 'first');
    assert.equal(callbacks, 1, 'the observer must see a valid commit before checking rejected commits');
    const oldVisit = ctx.captureSessionViewToken();
    ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
    ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
    const messages = ctx.currentMessages;
    assert.equal(module.commitSessionViewPatch(oldVisit, { messages: [{ content: 'stale' }] }, () => { callbacks++; }), false);
    assert.strictEqual(ctx.currentMessages, messages);
    assert.equal(callbacks, 1, 'a stale transaction cannot run its UI callback');

    ctx.applySessionViewPatch({ overview: { modelRevision: 2, modelName: 'current', usage: 10 } });
    const token = ctx.captureSessionViewToken();
    const latestRequests = [{ requestId: 'new-lease' }];
    ctx.applySessionViewPatch({ inputRequests: latestRequests });
    assert.equal(module.commitSessionViewPatch(token, {
      messages: [{ content: 'accepted' }], inputRequests: [{ requestId: 'old-lease' }],
      overview: { modelRevision: 1, modelName: 'old', usage: 20 },
    }, ({ previous, current }) => {
      assert.strictEqual(previous.messages, messages);
      assert.equal(current.messages[0].content, 'accepted');
      assert.strictEqual(current.inputRequests, latestRequests);
      assert.equal(current.overview.modelName, 'current');
      callbacks++;
    }), true);
    assert.equal(ctx.currentOverviewSnapshot.usage, 20, 'fresh non-model fields survive model revision filtering');
    assert.equal(ctx.currentOverviewSnapshot.modelRevision, 2);
    assert.strictEqual(ctx.currentInputRequests, latestRequests);
    assert.equal(callbacks, 2);
    assert.throws(() => module.commitSessionViewState(token, null), /synchronous apply function/);
    assert.throws(() => module.commitSessionViewPatch(token, {}, null), /afterCommit must be a function/);
  });
});
