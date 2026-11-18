/**
 * 本地资源身份契约（P4 T1 起直测 modules/identity.js —— 该族已从 app-core 抽出）。
 *
 * 真实 import 路线：identity 域是纯函数 + 一个 viewer 侧绑定 Map，不依赖 DOM；
 * 顶层 defineKey / claim 需要桥基础设施，因此 kernel-state 先装。
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

let identity;
let cleanup;

before(async () => {
  cleanup = installBrowserStubs();
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  ({ module: identity } = await loadModuleOnce('public/src/modules/identity.js', { installGlobals: false }));
});

after(() => cleanup());

test('logical agent identity belongs to the host and never guesses a child parent', () => {
  assert.equal(identity.getLogicalAgentId({ id: 'programming-helper', source: 'prebuilt' }), 'programming-helper');
  assert.equal(identity.getLogicalAgentId({ id: 'runtime-1', source: 'child', parent_id: 'programming-helper' }), 'programming-helper');
  assert.equal(identity.getLogicalAgentId({ id: 'runtime-1', source: 'child' }), null);
  assert.equal(identity.getParentAgentId({ id: 'runtime-1', source: 'child' }), null);
});

test('runtime identity uses explicit runtime fields and treats a stopped host as having no runtime', () => {
  assert.equal(identity.getRuntimeId({ id: 'runtime-1', source: 'child', parent_id: 'host' }), 'runtime-1');
  assert.equal(identity.getRuntimeId({ id: 'host', source: 'prebuilt' }), null);
  assert.equal(identity.getRuntimeId({ id: 'host', source: 'prebuilt', runtime_session_id: 'runtime-2' }), 'runtime-2');
  assert.equal(identity.getRuntimeId({ id: 'runtime-1', runtime_session_id: 'runtime-2', runtimeSessionId: 'runtime-3' }), null);
});

test('active session identity requires consistent session fields and does not require a runtime', () => {
  assert.equal(identity.getActiveSessionId({ active_workspace_session_id: 'session-a' }), 'session-a');
  assert.equal(identity.getActiveSessionId({ workspace_sessions: { activeSessionId: 'session-b' } }), 'session-b');
  assert.equal(identity.getActiveSessionId({ sessionId: 'session-a', active_workspace_session_id: 'session-b' }), null);
  assert.equal(identity.getActiveSessionId({ id: 'host', source: 'prebuilt' }), null);
});

test('local resource references expose only explicit local identities', () => {
  assert.deepEqual(
    identity.buildLocalResourceRef({ id: 'runtime-1', source: 'child', parent_id: 'host', active_workspace_session_id: 'session-a' }),
    {
      scope: 'local',
      agentId: 'host',
      parentId: 'host',
      sessionId: 'session-a',
      runtimeId: 'runtime-1',
    },
  );
  assert.deepEqual(
    identity.buildLocalResourceRef({ id: 'host', source: 'prebuilt' }),
    {
      scope: 'local',
      agentId: 'host',
      parentId: null,
      sessionId: null,
      runtimeId: null,
    },
  );
  assert.deepEqual(
    identity.buildLocalResourceRef({ agentId: 'host', runtimeId: 'runtime-1', sessionId: 'session-a', parentId: 'wrong' }),
    {
      scope: 'local',
      agentId: 'host',
      parentId: 'wrong',
      sessionId: 'session-a',
      runtimeId: 'runtime-1',
    },
  );
});
