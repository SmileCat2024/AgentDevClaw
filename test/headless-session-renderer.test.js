import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import {
  attachSessionEventOutput,
  emitFatalSessionError,
  renderSessionEventHuman,
} from '../scripts/headless-session-renderer.js';

function capture() {
  const chunks = [];
  return {
    stream: new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } }),
    lines: () => chunks.join('').split('\n').filter(Boolean),
  };
}

describe('headless-session-renderer', () => {
  describe('renderSessionEventHuman', () => {
    it('reasoning 与 agent_message 缩进渲染，turn.completed 带 tokens', () => {
      const lines = [
        ...renderSessionEventHuman({
          type: 'item.completed',
          item: { id: 'i0', turn: 0, type: 'reasoning', text: '思考中\n第二行' },
        }),
        ...renderSessionEventHuman({
          type: 'item.completed',
          item: { id: 'i1', turn: 0, type: 'agent_message', text: '回复正文' },
        }),
        ...renderSessionEventHuman({
          type: 'turn.completed',
          turn: 0,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
      ];
      assert.deepEqual(lines, [
        '  思考中',
        '  第二行',
        '',
        'agent:',
        '  回复正文',
        'tokens: input=10 output=5',
      ]);
    });

    it('tool_call started/completed/failed 渲染', () => {
      const started = renderSessionEventHuman({
        type: 'item.started',
        item: { id: 'c1', turn: 0, type: 'tool_call', tool: 'shell', arguments: { command: 'ls' }, status: 'in_progress' },
      });
      assert.deepEqual(started, ['tool: shell {"command":"ls"}']);

      const ok = renderSessionEventHuman({
        type: 'item.completed',
        item: { id: 'c1', turn: 0, type: 'tool_call', tool: 'shell', arguments: {}, status: 'completed', result: 'file.txt' },
      });
      assert.deepEqual(ok, ['  succeeded: file.txt']);

      const failed = renderSessionEventHuman({
        type: 'item.completed',
        item: { id: 'c2', turn: 0, type: 'tool_call', tool: 'read', arguments: {}, status: 'failed', error: 'not found' },
      });
      assert.deepEqual(failed, ['  failed: not found']);
    });

    it('turn.failed 与 error 渲染错误信息', () => {
      assert.deepEqual(
        renderSessionEventHuman({ type: 'turn.failed', turn: 0, error: { message: 'boom' } }),
        ['failed: boom'],
      );
      assert.deepEqual(
        renderSessionEventHuman({ type: 'error', message: 'fatal' }),
        ['error: fatal'],
      );
    });

    it('turn.started 渲染为空行数组', () => {
      assert.deepEqual(renderSessionEventHuman({ type: 'turn.started', turn: 0 }), []);
    });

    it('长参数与长结果截断', () => {
      const long = 'x'.repeat(200);
      const [line] = renderSessionEventHuman({
        type: 'item.started',
        item: { id: 'c1', turn: 0, type: 'tool_call', tool: 'shell', arguments: { command: long }, status: 'in_progress' },
      });
      assert.ok(line.length <= 100);
      assert.ok(line.endsWith('...'));
    });
  });

  describe('attachSessionEventOutput', () => {
    let detach;

    afterEach(() => {
      detach?.();
      detach = null;
    });

    it('jsonl 模式：thread.started 与事件写 stdout，每行一个 JSON', () => {
      const out = capture();
      const err = capture();
      detach = attachSessionEventOutput({
        format: 'jsonl',
        threadId: 's1',
        streams: { stdout: out.stream, stderr: err.stream },
      });
      const lines = out.lines();
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), { type: 'thread.started', threadId: 's1' });
      assert.equal(err.lines().length, 0);
    });

    it('human 模式：thread 行写 stderr，stdout 干净', () => {
      const out = capture();
      const err = capture();
      detach = attachSessionEventOutput({
        format: 'human',
        threadId: 's1',
        streams: { stdout: out.stream, stderr: err.stream },
      });
      assert.deepEqual(err.lines(), ['session: s1']);
      assert.equal(out.lines().length, 0);
    });

    it('退订后不再接收事件', () => {
      const out = capture();
      detach = attachSessionEventOutput({
        format: 'jsonl',
        threadId: 's1',
        streams: { stdout: out.stream, stderr: capture().stream },
      });
      const before = out.lines().length;
      detach();
      detach = null;
      emitFatalSessionError('ignored');
      assert.equal(out.lines().length, before);
    });

    it('jsonl 模式截断超限的工具结果并标记，agent_message 不截断', async () => {
      const { emitSessionEvent } = await import('@agentdevjs/core');
      const out = capture();
      detach = attachSessionEventOutput({
        format: 'jsonl',
        threadId: 's1',
        streams: { stdout: out.stream, stderr: capture().stream },
      });

      const huge = 'x'.repeat(5000);
      emitSessionEvent({
        type: 'item.completed',
        item: { id: 'c1', turn: 0, type: 'tool_call', tool: 'read', arguments: {}, status: 'completed', result: huge },
      });
      const toolLine = JSON.parse(out.lines()[1]);
      assert.equal(toolLine.item.result.length, 1000);
      assert.equal(toolLine.item.resultTruncated, true);
      assert.equal(toolLine.item.fullLength, 5000);

      const message = 'y'.repeat(5000);
      emitSessionEvent({
        type: 'item.completed',
        item: { id: 'i1', turn: 0, type: 'agent_message', text: message },
      });
      const msgLine = JSON.parse(out.lines()[2]);
      assert.equal(msgLine.item.text.length, 5000);
    });
  });
});
