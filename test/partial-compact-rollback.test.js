import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from 'agentdev';

class EchoLLM {
  constructor() {
    this.summaryMode = false;
  }

  async chat(messages) {
    if (this.summaryMode) {
      return {
        content: '',
        toolCalls: [{
          name: 'record_compaction_context',
          arguments: {
            session_title: 'partial compact test',
            summary: 'summary of second and third',
            important_files: [],
            important_skills: [],
          },
        }],
      };
    }
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content || '';
    return { content: `reply:${lastUser}` };
  }
}

class RollbackAgent extends Agent {
  constructor() {
    super({
      llm: new EchoLLM(),
      maxTurns: 2,
      name: 'PartialCompactRollbackAgent',
      systemMessage: 'partial compact rollback test',
    });
  }
}

describe('partial compact rollback shape', () => {
  it('rolls back target turn and injects a system reminder in the same context', async () => {
    const agent = new RollbackAgent();
    await agent.onCall('first');
    await agent.onCall('second');
    await agent.onCall('third');

    const before = agent.getContext().getAll();
    assert.equal(before.filter(message => message.role === 'user').length, 3);

    await agent.rollbackToCall(1);
    const ctx = agent.getContext();
    const restoredCallIndex = Number(agent._callIndex);
    const reminderTurn = Math.max(0, restoredCallIndex + 1);
    ctx.addSystemMessage('## 已压缩的后续对话摘要\n\nsummary of second and third', reminderTurn, 'partial-compact');

    const after = ctx.getAll();
    assert.deepEqual(
      after.filter(message => message.role === 'user').map(message => message.content),
      ['first'],
      'rollback should remove the target turn and everything after it',
    );
    assert.equal(after.at(-1).role, 'system');
    assert.equal(after.at(-1).turn, 1);
    assert.match(after.at(-1).content, /summary of second and third/);
    assert.ok(after.length < before.length, 'rolled-back context plus summary should be shorter than the original tail');
  });

  it('keeps rollback shape when summary generation runs before rollback', async () => {
    const agent = new RollbackAgent();
    await agent.onCall('first');
    await agent.onCall('second');
    await agent.onCall('third');

    const before = agent.getContext().getAll();
    const messagesToSummarize = before.slice(before.findIndex(message => message.role === 'user' && message.turn === 1));
    agent.llm.summaryMode = true;
    const response = await agent.llm.chat([
      ...messagesToSummarize,
      { role: 'user', content: 'partial compact prompt', turn: 3 },
    ]);
    const summary = response.toolCalls[0].arguments.summary;

    await agent.rollbackToCall(1);
    const ctx = agent.getContext();
    const restoredCallIndex = Number(agent._callIndex);
    const reminderTurn = Math.max(0, restoredCallIndex + 1);
    const keptMessages = before.slice(0, before.findIndex(message => message.role === 'user' && message.turn === 1));
    ctx.restore({
      version: 2,
      messages: [...keptMessages, { role: 'system', content: `## 已压缩的后续对话摘要\n\n${summary}`, turn: reminderTurn }],
      enrichedMessages: [],
      sequence: 0,
    });

    const after = ctx.getAll();
    assert.deepEqual(after.map(message => message.role), ['system', 'user', 'assistant', 'system']);
    assert.deepEqual(after.filter(message => message.role === 'user').map(message => message.content), ['first']);
    assert.equal(after.at(-1).turn, 1);
    assert.match(after.at(-1).content, /已压缩的后续对话摘要/);
    assert.match(after.at(-1).content, /summary of second and third/);
  });
});
