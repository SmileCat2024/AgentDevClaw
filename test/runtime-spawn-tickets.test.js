import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * runtime-spawn-tickets 契约（ADR-0037 M6）：
 * - 消费要求 ticket 存在、未过期、agentId / sessionId 与签发吻合
 * - 一次性：消费成功（乃至 onRegister 抛错）后不可重放
 * - 过期票据等同无效
 */
const {
  issueManagedSpawnTicket,
  consumeManagedSpawnTicket,
  countPendingSpawnTickets,
} = await import('../server/shared/runtime-spawn-tickets.js');

describe('runtime-spawn-tickets', () => {
  it('valid ticket hands over and is consumed exactly once', async () => {
    const calls = [];
    const ticket = issueManagedSpawnTicket({
      agentId: 'coder',
      sessionId: 's-1',
      onRegister: (viewerAgentId) => calls.push(viewerAgentId),
    });
    const before = countPendingSpawnTickets();
    const result = await consumeManagedSpawnTicket({ ticket, agentId: 'coder', sessionId: 's-1', viewerAgentId: 'agent-1-1' });
    assert.equal(result?.ok, true);
    assert.deepEqual(calls, ['agent-1-1']);
    assert.equal(countPendingSpawnTickets(), before - 1, 'consumed ticket must leave the pending set');

    const replay = await consumeManagedSpawnTicket({ ticket, agentId: 'coder', sessionId: 's-1', viewerAgentId: 'agent-1-1' });
    assert.equal(replay, null);
    assert.deepEqual(calls, ['agent-1-1'], 'replay must not re-invoke onRegister');
  });

  it('rejects unknown, mismatched, and empty tickets without invoking onRegister', async () => {
    const calls = [];
    issueManagedSpawnTicket({ agentId: 'coder', sessionId: 's-2', onRegister: (v) => calls.push(v) });

    assert.equal(await consumeManagedSpawnTicket({ ticket: 'not-issued', agentId: 'coder', sessionId: 's-2', viewerAgentId: 'a' }), null);
    // 找不到对应签发条目的 agentId / sessionId 组合（唯一 pending 是 s-2）
    assert.equal(await consumeManagedSpawnTicket({ ticket: 'guess', agentId: 'other', sessionId: 's-x', viewerAgentId: 'a' }), null);
    assert.equal(await consumeManagedSpawnTicket({ ticket: '', agentId: 'coder', sessionId: 's-2', viewerAgentId: 'a' }), null);
    assert.deepEqual(calls, []);
  });

  it('rejects a ticket whose payload does not match issuance', async () => {
    const calls = [];
    const ticket = issueManagedSpawnTicket({ agentId: 'coder', sessionId: 's-3', onRegister: (v) => calls.push(v) });
    const mismatched = await consumeManagedSpawnTicket({ ticket, agentId: 'coder', sessionId: 'different', viewerAgentId: 'a' });
    assert.equal(mismatched, null);
    assert.deepEqual(calls, [], 'mismatched payload must not trigger handover');
    // 原票据仍可按正确载荷消费（校验失败不消耗票据）
    const ok = await consumeManagedSpawnTicket({ ticket, agentId: 'coder', sessionId: 's-3', viewerAgentId: 'agent-3-1' });
    assert.ok(ok);
  });

  it('propagates onRegister failures (and still burns the ticket)', async () => {
    const ticket = issueManagedSpawnTicket({
      agentId: 'coder',
      sessionId: 's-4',
      onRegister: () => { throw new Error('runtime exited before registration'); },
    });
    await assert.rejects(
      () => consumeManagedSpawnTicket({ ticket, agentId: 'coder', sessionId: 's-4', viewerAgentId: 'a' }),
      /runtime exited before registration/,
    );
    assert.equal(await consumeManagedSpawnTicket({ ticket, agentId: 'coder', sessionId: 's-4', viewerAgentId: 'a' }), null,
      'failed handover must not leave a replayable ticket');
  });

  it('requires an onRegister callback at issuance', () => {
    assert.throws(() => issueManagedSpawnTicket({ agentId: 'coder', sessionId: 's-5' }), /onRegister/);
  });
});
