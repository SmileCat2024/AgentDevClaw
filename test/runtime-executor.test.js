import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * ADR-0037 M4 执行后端 seam 契约测试：
 * 1. resolveRuntimeExecutor 选择逻辑（纯逻辑，无子进程）
 * 2. startLocalRuntime 与真实子进程的语义事件契约（identity 回执、
 *    session-exited 直通、output 事件、tail、原生 message 透传、kill）
 */

const {
  resolveRuntimeExecutor,
  localRuntimeBackend,
} = await import('../server/runtime-executor/index.js');
const { startLocalRuntime } = await import('../server/runtime-executor/local-backend.js');

// ── 选择逻辑 ────────────────────────────────────────────────

describe('resolveRuntimeExecutor（执行后端选择）', () => {
  it('默认与显式 local 都返回本地后端', () => {
    assert.equal(resolveRuntimeExecutor({ agentId: 'coder', processMode: 'isolated', env: {} }), localRuntimeBackend);
    assert.equal(
      resolveRuntimeExecutor({ agentId: 'coder', processMode: 'isolated', env: { CLAW_RUNTIME_EXECUTOR: 'local' } }),
      localRuntimeBackend,
    );
  });

  it('container 后端尚未实施：显式报错，不静默回退', () => {
    assert.throws(
      () => resolveRuntimeExecutor({ agentId: 'coder', processMode: 'isolated', env: { CLAW_RUNTIME_EXECUTOR: 'container' } }),
      /尚未实施/,
    );
  });

  it('container + agent 清单不匹配时落回 local（单 agent 试点支持）', () => {
    assert.equal(
      resolveRuntimeExecutor({
        agentId: 'qqbot',
        processMode: 'isolated',
        env: { CLAW_RUNTIME_EXECUTOR: 'container', CLAW_RUNTIME_EXECUTOR_AGENTS: 'coder, agent-studio' },
      }),
      localRuntimeBackend,
    );
  });

  it('container + agent 清单命中时仍按 container 走（显式报错）', () => {
    assert.throws(
      () => resolveRuntimeExecutor({
        agentId: 'coder',
        processMode: 'isolated',
        env: { CLAW_RUNTIME_EXECUTOR: 'container', CLAW_RUNTIME_EXECUTOR_AGENTS: 'coder' },
      }),
      /尚未实施/,
    );
  });

  it('container + 共享进程模式回退 local（add-session IPC 跨不了容器边界）', () => {
    for (const processMode of ['shared-by-project', 'shared-global']) {
      assert.equal(
        resolveRuntimeExecutor({ agentId: 'programming-helper', processMode, env: { CLAW_RUNTIME_EXECUTOR: 'container' } }),
        localRuntimeBackend,
        `${processMode} 应回退 local`,
      );
    }
  });

  it('未知取值直接报错', () => {
    assert.throws(
      () => resolveRuntimeExecutor({ agentId: 'coder', processMode: 'isolated', env: { CLAW_RUNTIME_EXECUTOR: 'vm' } }),
      /未知 CLAW_RUNTIME_EXECUTOR/,
    );
  });
});

// ── 本地后端契约（真实子进程）────────────────────────────────

function once(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeoutMs);
    emitter.once(event, (a, b) => {
      clearTimeout(timer);
      resolve([a, b]);
    });
  });
}

const liveChildren = [];
after(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

describe('startLocalRuntime（handle 契约）', () => {
  it('identity / session-exited / output / tail / message 透传 / exit 全链路', async () => {
    const childSource = `
      process.stdout.write('Viewer Agent ID: va-test-1\\n');
      process.stdout.write('[ProtoClaw Runtime] READY session=s1\\n');
      process.stderr.write('stderr line\\n');
      process.on('message', (msg) => {
        if (msg.type === 'runtime-identity-accepted') {
          process.stdout.write('ACK:' + msg.viewerAgentId + ':' + msg.sessionId + '\\n');
          process.send({ type: 'session-exited', sessionId: 's1', persisted: true });
          process.send({ type: 'custom-passthrough' });
          setTimeout(() => process.exit(0), 30);
        }
      });
      process.send({ type: 'runtime-identity', agentId: 'a1', sessionId: 's1', viewerAgentId: ' va-test-1 ' });
    `;
    const child = startLocalRuntime({
      argv: ['--input-type=module', '-e', childSource],
      env: process.env,
      cwd: process.cwd(),
      ipc: true,
    });
    liveChildren.push(child);

    assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'handle 即 ChildProcess（pid 可用）');

    const rawMessages = [];
    child.on('message', (msg) => rawMessages.push(msg));
    // 透传断言的确定性等待点：子进程在 session-exited 之后才发送
    // custom-passthrough，不能在收到 session-exited 后立即断言。
    const passthroughSeen = new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg?.type === 'custom-passthrough') {
          child.off('message', onMsg);
          resolve(msg);
        }
      };
      child.on('message', onMsg);
    });

    const outputs = [];
    child.on('output', ({ stream, text }) => outputs.push({ stream, text }));

    // runtime-identity → 语义事件 + 回执（回执到达子进程后才会推进后续消息）
    const [identity] = await once(child, 'identity');
    assert.equal(identity.agentId, 'a1');
    assert.equal(identity.sessionId, 's1');
    assert.equal(identity.viewerAgentId, 'va-test-1', 'viewerAgentId 经 cleanSessionText 归一');
    identity.accept();

    const [exited] = await once(child, 'session-exited');
    assert.deepEqual(exited, { sessionId: 's1', persisted: true });

    await passthroughSeen;
    assert.ok(
      rawMessages.some((msg) => msg.type === 'custom-passthrough'),
      '原生 message 事件不被翻译层吞掉（共享进程 join 依赖）',
    );

    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 0);

    assert.ok(outputs.some((o) => o.stream === 'stdout' && o.text.includes('Viewer Agent ID: va-test-1')));
    assert.ok(outputs.some((o) => o.stream === 'stdout' && o.text.includes('[ProtoClaw Runtime] READY session=s1')));
    assert.ok(outputs.some((o) => o.stream === 'stderr' && o.text.includes('stderr line')));
    assert.ok(outputs.some((o) => o.stream === 'stdout' && o.text.includes('ACK:va-test-1:s1')), 'accept() 回执确实到达子进程');
    assert.ok(child.getOutputTail().includes('ACK:va-test-1:s1'), 'tail 覆盖 stdout');
    assert.ok(child.getOutputTail().includes('stderr line'), 'tail 覆盖 stderr');
  });

  it('tail 截断上限：超限时头部标记被丢弃、末段标记保留（诊断 tail 语义）', async () => {
    // 组合输出 > 上限（8000 字符）：唯一头部标记落在窗口外，尾部标记在窗口内。
    // 断言的是截断行为本身（保留末段），不绑定具体窗口大小的实现细节。
    const childSource = `
      process.stdout.write('HEAD_MARKER_DROP' + 'x'.repeat(10000) + 'TAIL_MARKER_KEEP');
      process.exit(0);
    `;
    const child = startLocalRuntime({
      argv: ['--input-type=module', '-e', childSource],
      env: process.env,
      cwd: process.cwd(),
      ipc: false,
    });
    liveChildren.push(child);
    await once(child, 'exit');

    const tail = child.getOutputTail();
    assert.ok(tail.includes('TAIL_MARKER_KEEP'), '末段标记保留');
    assert.ok(!tail.includes('HEAD_MARKER_DROP'), '超限头部标记被截断');
  });

  it('kill() 与 exit 事件可用（stop 通道依赖 ChildProcess 原生能力）', async () => {
    const child = startLocalRuntime({
      argv: ['--input-type=module', '-e', 'setTimeout(() => {}, 60000)'],
      env: process.env,
      cwd: process.cwd(),
      ipc: false,
    });
    liveChildren.push(child);
    child.kill('SIGTERM');
    const [, signal] = await once(child, 'exit');
    // Windows 下信号语义退化为 exit code 1（无 signal），只断言已退出
    assert.ok(child.exitCode !== null || signal, '进程已退出');
  });
});
