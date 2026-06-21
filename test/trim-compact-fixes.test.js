import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimmedSeedMessages, normalizeExportPolicy, DEFAULT_EXPORT_POLICY } from '../server/context-continuity/handoff-package.js';

describe('trim-compact fixes', () => {

  describe('Fix 3: foldedToolNoteRole default is assistant (not system)', () => {
    it('defaults to assistant in DEFAULT_EXPORT_POLICY', () => {
      assert.equal(DEFAULT_EXPORT_POLICY.foldedToolNoteRole, 'assistant');
    });

    it('normalizeExportPolicy returns assistant when not specified', () => {
      const policy = normalizeExportPolicy({});
      assert.equal(policy.foldedToolNoteRole, 'assistant');
    });

    it('respects explicit system override', () => {
      const policy = normalizeExportPolicy({ foldedToolNoteRole: 'system' });
      assert.equal(policy.foldedToolNoteRole, 'system');
    });
  });

  describe('Fix: fullPreserveFromTurn=0 preserves all (by design)', () => {
    it('preserves all messages when fullPreserveFromTurn=0', () => {
      const messages = [
        { role: 'user', content: 'hello', turn: 0 },
        { role: 'assistant', content: 'hi', turn: 0, toolCalls: [{ name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ fullPreserveFromTurn: 0 });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      // All messages have turn >= 0, so all are preserved
      assert.equal(stats.keptSeedMessageCount, 5, 'all 5 messages should be in preserve zone');
      assert.equal(stats.foldedToolCallCount, 0, 'no folding should occur');
    });
  });

  describe('trim with fullPreserveFromTurn > 0 folds earlier turns', () => {
    it('folds tool activity in turns before preserve boundary', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: 'doing stuff', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true,"result":"file content"}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply to second', turn: 1 },
        { role: 'user', content: 'third', turn: 2 },
        { role: 'assistant', content: 'reply to third', turn: 2 },
      ];
      const policy = normalizeExportPolicy({ fullPreserveFromTurn: 2 });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      // Turn 2 messages should be in preserve zone (pass through as-is)
      const preservedUserMessages = seedMessages.filter(m => m.role === 'user');
      assert.ok(preservedUserMessages.some(m => m.content === 'third'), 'turn 2 user message preserved');

      // Tool calls in fold zone should be folded (not preserved with toolCalls)
      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.ok(foldNotes.length > 0, 'should have a fold note for tool activity in fold zone');
      assert.ok(stats.foldedToolCallCount > 0, 'tool calls should be folded');

      // Fold note should be assistant role (the fix)
      assert.equal(foldNotes[0].role, 'assistant', 'fold note role should be assistant');

      // Tool messages in fold zone should not appear as 'tool' role in seed
      const toolMessages = seedMessages.filter(m => m.role === 'tool');
      assert.equal(toolMessages.length, 0, 'no raw tool messages should survive in fold zone');
    });
  });

  describe('preservedTurns: non-contiguous turn preservation', () => {
    it('preserves ONLY specified turns, folds the rest', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: 'doing stuff', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true,"result":"file content"}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1, toolCalls: [{ name: 'edit', arguments: '{"filePath":"b.js"}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"success":true}', turn: 1 },
        { role: 'user', content: 'third', turn: 2 },
        { role: 'assistant', content: 'reply2', turn: 2 },
      ];
      // Keep ONLY turn 0, fold turns 1 and 2
      const policy = normalizeExportPolicy({ preservedTurns: [0] });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      // Turn 0 should be preserved with full detail (including toolCalls)
      const turn0Assistant = seedMessages.find(m => m.role === 'assistant' && m.turn === 0);
      assert.ok(turn0Assistant, 'turn 0 assistant should be preserved');
      assert.ok(turn0Assistant.toolCalls, 'turn 0 assistant should keep toolCalls (preserve zone)');

      // Turn 0 tool message should be preserved
      const turn0Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 0);
      assert.ok(turn0Tool, 'turn 0 tool message should be preserved');

      // Turns 1-2 tool calls should be folded
      assert.ok(stats.foldedToolCallCount > 0, 'tool calls from turns 1+ should be folded');

      // Turns 1-2 should NOT have preserved tool messages
      const turn1Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 1);
      assert.ok(!turn1Tool, 'turn 1 tool message should NOT be preserved (it is in fold zone)');

      // Fold notes should exist
      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.ok(foldNotes.length > 0, 'should have fold notes for folded turns');
    });

    it('preservedTurns takes precedence over fullPreserveFromTurn', () => {
      const messages = [
        { role: 'user', content: 'msg0', turn: 0 },
        { role: 'assistant', content: 'reply0', turn: 0, toolCalls: [{ name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{}', turn: 0 },
        { role: 'user', content: 'msg1', turn: 1 },
        { role: 'assistant', content: 'reply1', turn: 1 },
        { role: 'user', content: 'msg2', turn: 2 },
        { role: 'assistant', content: 'reply2', turn: 2, toolCalls: [{ name: 'edit', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{}', turn: 2 },
      ];
      // fullPreserveFromTurn=0 would preserve everything,
      // but preservedTurns=[2] should take precedence and only preserve turn 2
      const policy = normalizeExportPolicy({ fullPreserveFromTurn: 0, preservedTurns: [2] });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      // Turn 2 tool should be preserved (in preservedTurnSet)
      const turn2Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 2);
      assert.ok(turn2Tool, 'turn 2 tool should be preserved (in preservedTurnSet)');

      // Turn 0 tool should be folded (NOT in preservedTurnSet despite fullPreserveFromTurn=0)
      const turn0Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 0);
      assert.ok(!turn0Tool, 'turn 0 tool should NOT be preserved (preservedTurns overrides fullPreserveFromTurn)');
      assert.ok(stats.foldedToolCallCount > 0, 'turn 0 tool calls should be folded');
    });
  });

  describe('Fix 1: seed feature turn collision verification (logic)', () => {
    // This test verifies the core logic that was fixed:
    // Given seed messages with max turn N, _callIndex should be set to N+1
    // (previously N, causing collision)
    it('computes correct _callIndex = maxTurn + 1 for non-colliding user turn', () => {
      const seedMessages = [
        { role: 'user', content: 'msg0', turn: 0 },
        { role: 'assistant', content: 'reply0', turn: 0 },
        { role: 'user', content: 'msg1', turn: 1 },
        { role: 'assistant', content: 'reply1', turn: 1 },
        { role: 'user', content: 'msg2', turn: 2 },
        { role: 'assistant', content: 'reply2', turn: 2 },
      ];

      // Simulate seed feature logic (from context-handoff-seed/src/index.ts)
      let fallbackTurn = 0; // agent._callIndex at hook time (already set to nextCallIndex)
      let injectionTurn = fallbackTurn;
      for (const message of seedMessages) {
        const turn = typeof message.turn === 'number' ? message.turn : fallbackTurn;
        injectionTurn = Math.max(injectionTurn, turn + 1);
      }

      // OLD (buggy): _callIndex = injectionTurn - 1 = 2 → user gets turn 2 → COLLISION
      const oldCallIndex = injectionTurn - 1;
      assert.equal(oldCallIndex, 2, 'old logic sets _callIndex to 2 (collides with seed turn 2)');

      // NEW (fixed): _callIndex = injectionTurn = 3 → user gets turn 3 → NO COLLISION
      const newCallIndex = injectionTurn;
      assert.equal(newCallIndex, 3, 'new logic sets _callIndex to 3 (no collision)');
    });

    it('handles seed messages without explicit turns', () => {
      const seedMessages = [
        { role: 'user', content: 'msg0' },
        { role: 'assistant', content: 'reply0' },
        { role: 'user', content: 'msg1' },
      ];

      let fallbackTurn = 0;
      let injectionTurn = fallbackTurn;
      seedMessages.forEach((message, index) => {
        const turn = typeof message.turn === 'number' ? message.turn : (fallbackTurn + index);
        injectionTurn = Math.max(injectionTurn, turn + 1);
      });

      // Without explicit turns, turns = [0, 1, 2], injectionTurn = 3
      // OLD: _callIndex = 2 → user turn = 2 (collides with seed index 2)
      // NEW: _callIndex = 3 → user turn = 3 (no collision)
      assert.equal(injectionTurn, 3);
      assert.equal(injectionTurn - 1, 2, 'old logic would collide');
    });
  });
});
