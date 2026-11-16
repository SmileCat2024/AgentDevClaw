import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  markRuntimeForHostShutdown,
  shouldConvergeThreadAfterRuntimeExit,
} from '../server/thread-control/runtime-stop-intent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('runtime stop intent', () => {
  test('整机关闭标记为可恢复中断，不触发线程 idle 收敛', () => {
    const runtime = { stopped: false };
    assert.equal(markRuntimeForHostShutdown(runtime), true);
    assert.equal(runtime.stopReason, 'host_shutdown');
    assert.equal(runtime.stopped, true);
    assert.equal(shouldConvergeThreadAfterRuntimeExit(runtime), false);
  });

  test('用户主动停止仍收敛线程 idle', () => {
    assert.equal(shouldConvergeThreadAfterRuntimeExit({ stopped: true }), true);
  });

  test('意外崩溃不触发主动停止收敛', () => {
    assert.equal(shouldConvergeThreadAfterRuntimeExit({ stopped: false }), false);
  });

  test('忽略无效 runtime 输入', () => {
    assert.equal(markRuntimeForHostShutdown(null), false);
    assert.equal(shouldConvergeThreadAfterRuntimeExit(null), false);
  });

  test('宿主关闭和 runtime 退出回调都接入同一停止意图策略', () => {
    const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const startup = readFileSync(path.join(ROOT, 'server/routes/agent-startup.js'), 'utf8');
    assert.match(server, /markRuntimeForHostShutdown\(runtime\)/);
    assert.match(startup, /shouldConvergeThreadAfterRuntimeExit\(rt\)/);
  });
});
