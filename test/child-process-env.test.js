/**
 * childProcessEnv 剥离契约（server/shared/string-helpers.js）：
 * - 平台专属 env 不得泄漏给 spawn 出的托管 agent runtime（ADR-0037）：
 *   - AGENTDEV_VIEWER_ADDR（ViewerWorker TCP 控制监听地址）：托管 runtime
 *     固定走 UDS，而 DebugHub 中 TCP 地址优先于 UDS 路径；
 *   - AGENTDEV_VIEWER_ORIGIN（HTTP 面完整 origin）：面向外部 runtime 的
 *     部署配置，托管本地 runtime 固定回环 + 注入端口，该 origin 对同机
 *     runtime 可能不可达。
 * - per-session env 只经 extraEnv 显式传递，同样不得泄漏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { childProcessEnv } from '../server/shared/string-helpers.js';

test('childProcessEnv strips platform-only env keys (viewer addr / origin)', () => {
  const env = childProcessEnv({
    AGENTDEV_VIEWER_ADDR: '127.0.0.1:2027',
    AGENTDEV_VIEWER_ORIGIN: 'http://192.0.2.10:2526',
    PROTOCLAW_INTERNAL_TOKEN: 'keep-me',
    PATH: 'x',
  });
  assert.equal(env.AGENTDEV_VIEWER_ADDR, undefined);
  assert.equal(env.AGENTDEV_VIEWER_ORIGIN, undefined);
  assert.equal(env.PROTOCLAW_INTERNAL_TOKEN, 'keep-me');
  assert.equal(env.PATH, 'x');
});

test('childProcessEnv strips per-session env keys', () => {
  const env = childProcessEnv({
    PROTOCLAW_HANDOFF_PATH: '/tmp/handoff.json',
    PROTOCLAW_HANDOFF_PAYLOAD: '{}',
  });
  assert.equal(env.PROTOCLAW_HANDOFF_PATH, undefined);
  assert.equal(env.PROTOCLAW_HANDOFF_PAYLOAD, undefined);
});

test('childProcessEnv does not mutate the input env', () => {
  const input = { AGENTDEV_VIEWER_ADDR: '127.0.0.1:2027', AGENTDEV_VIEWER_ORIGIN: 'http://192.0.2.10:2526' };
  childProcessEnv(input);
  assert.equal(input.AGENTDEV_VIEWER_ADDR, '127.0.0.1:2027');
  assert.equal(input.AGENTDEV_VIEWER_ORIGIN, 'http://192.0.2.10:2526');
});
