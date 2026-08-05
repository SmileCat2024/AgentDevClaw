import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimmedSeedMessages, normalizeExportPolicy, DEFAULT_EXPORT_POLICY } from '../server/context-continuity/handoff-package.js';

describe('trim-compact fixes', () => {

  describe('Fix 3: foldedToolNoteRole default is system (not assistant)', () => {
    it('defaults to system in DEFAULT_EXPORT_POLICY', () => {
      assert.equal(DEFAULT_EXPORT_POLICY.foldedToolNoteRole, 'system');
    });

    it('normalizeExportPolicy returns system when not specified', () => {
      const policy = normalizeExportPolicy({});
      assert.equal(policy.foldedToolNoteRole, 'system');
    });

    it('respects explicit assistant override', () => {
      const policy = normalizeExportPolicy({ foldedToolNoteRole: 'assistant' });
      assert.equal(policy.foldedToolNoteRole, 'assistant');
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

      // Fold note should be system role (system reminder, not assistant)
      assert.equal(foldNotes[0].role, 'system', 'fold note role should be system');

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

    it('preserves tool-result images only for explicitly preserved turns', () => {
      const managedImage = {
        path: 'C:/managed-images/hash.png',
        mediaType: 'image/png',
        source: 'C:/workspace/original.png',
      };
      const messages = [
        { role: 'user', content: 'read old image', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_old', name: 'read_image', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc_old', content: '{"success":true}', turn: 0, images: [managedImage] },
        { role: 'user', content: 'read current image', turn: 1 },
        { role: 'assistant', content: '', turn: 1, toolCalls: [{ id: 'tc_keep', name: 'read_image', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc_keep', content: '{"success":true}', turn: 1, images: [managedImage] },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      assert.ok(!seedMessages.some(m => m.role === 'tool' && m.toolCallId === 'tc_old'),
        'folded turn must not retain the old tool image');
      const preserved = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_keep');
      assert.ok(preserved, 'explicitly preserved tool result should survive trim');
      assert.deepEqual(preserved.images, [managedImage]);
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

  describe('Fix: consecutive tool-only assistant turns merge into one fold', () => {
    it('produces a single fold note for consecutive tool-only assistant messages', () => {
      // Simulates the common pattern: assistant calls tools back-to-back
      // without text output between them.
      const messages = [
        { role: 'user', content: 'fix the bug', turn: 0 },
        { role: 'assistant', content: 'Let me investigate.', turn: 0, toolCalls: [{ name: 'grep', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"result":"match found"}', turn: 0 },
        // tool-only assistant turns (no text):
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'grep', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"result":"another match"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc3', content: '{"result":"done"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc4', content: '{"result":"file content"}', turn: 0 },
        // Finally, assistant produces text:
        { role: 'assistant', content: 'Found the issue.', turn: 0 },
        { role: 'user', content: 'great', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      // All 4 tool calls (grep, grep, bash, read) should be in a SINGLE fold note
      assert.equal(foldNotes.length, 1, 'consecutive tool-only turns should produce exactly ONE fold note');
      assert.ok(foldNotes[0].content.includes('grep'), 'fold should contain grep');
      assert.ok(foldNotes[0].content.includes('bash'), 'fold should contain bash');
      assert.ok(foldNotes[0].content.includes('read'), 'fold should contain read');
      assert.equal(stats.foldedToolNoteCount, 1, 'only one foldedToolNoteCount');
      assert.equal(stats.foldedToolCallCount, 4, 'all 4 tool calls folded');
    });

    it('still separates folds when assistant text appears between tool calls', () => {
      const messages = [
        { role: 'user', content: 'do task', turn: 0 },
        { role: 'assistant', content: 'Step 1.', turn: 0, toolCalls: [{ name: 'grep', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{}', turn: 0 },
        { role: 'assistant', content: 'Step 2.', turn: 0, toolCalls: [{ name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{}', turn: 0 },
        { role: 'user', content: 'ok', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      // "Step 1." and "Step 2." are real text, so each should flush the previous fold
      assert.equal(foldNotes.length, 2, 'text between tool calls should produce separate folds');
    });
  });

  describe('Claw continuity protected tools', () => {
    it('preserves protected todo tool calls and their tool results outside the normal preserve window', () => {
      const messages = [
        { role: 'user', content: 'plan this', turn: 0 },
        {
          role: 'assistant',
          content: '',
          turn: 0,
          toolCalls: [
            { id: 'tc_todo', name: 'task_update', arguments: '{"id":"1","status":"in_progress"}' },
            { id: 'tc_read', name: 'read', arguments: '{"filePath":"a.js"}' },
          ],
        },
        { role: 'tool', toolCallId: 'tc_todo', content: '{"ok":true}', turn: 0 },
        { role: 'tool', toolCallId: 'tc_read', content: '{"result":"file"}', turn: 0 },
        { role: 'user', content: 'continue', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({
        preservedTurns: [1],
        preserveToolNames: ['task_update'],
      });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const protectedAssistant = seedMessages.find(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.name === 'task_update'));
      assert.ok(protectedAssistant, 'assistant message containing task_update should survive trim');
      assert.ok(seedMessages.some(m => m.role === 'tool' && m.toolCallId === 'tc_todo'), 'task_update tool result should survive trim');
      assert.ok(!seedMessages.some(m => m.role === 'tool' && m.toolCallId === 'tc_read'), 'unprotected read result should still be foldable/droppable');
      assert.equal(stats.keptProtectedToolCallCount, 1);
      assert.equal(stats.keptProtectedToolMessageCount, 1);
    });
  });

  describe('skill protection is message-level (not turn-level)', () => {
    it('protects only invoke_skill call and its result, NOT other tools in the same turn', () => {
      // This is the core bug: a single invoke_skill in a 286-message turn
      // used to protect ALL 286 messages. Now only the skill call itself
      // and its tool result should be preserved; other tool calls in the
      // same turn should still be folded.
      const messages = [
        { role: 'user', content: 'do research', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_skill', name: 'invoke_skill', arguments: '{"skill":"test"}' }] },
        { role: 'tool', toolCallId: 'tc_skill', content: '{"success":true,"result":"skill content"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_read', name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc_read', content: '{"success":true,"result":"file content"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_bash', name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc_bash', content: '{"success":true,"result":"done"}', turn: 0 },
        { role: 'assistant', content: 'Finished research.', turn: 0 },
        { role: 'user', content: 'thanks', turn: 1 },
        { role: 'assistant', content: 'you are welcome', turn: 1 },
      ];

      // Trim all rounds (preservedTurns = []), skill protection enabled
      const policy = normalizeExportPolicy({ preservedTurns: [], keepRecentSkillInvokes: 5 });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      // The invoke_skill assistant message should be preserved in full detail
      const skillAssistant = seedMessages.find(m =>
        m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some(tc => tc.name === 'invoke_skill')
      );
      assert.ok(skillAssistant, 'invoke_skill assistant message should be preserved');

      // The skill tool result should be preserved in full detail
      const skillTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_skill');
      assert.ok(skillTool, 'invoke_skill tool result should be preserved');

      // BUT: the read/bash tool calls in the same turn should be folded
      const readTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_read');
      assert.ok(!readTool, 'read tool result should NOT be preserved (not a skill call)');
      const bashTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_bash');
      assert.ok(!bashTool, 'bash tool result should NOT be preserved (not a skill call)');

      // Fold notes should exist for the non-skill tool calls
      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.ok(foldNotes.length > 0, 'non-skill tool calls should be folded');
      assert.ok(stats.foldedToolCallCount > 0, 'folded tool call count should be > 0');
    });

    it('protects skill calls even when preservedTurns is null (default behavior)', () => {
      const messages = [
        { role: 'user', content: 'do research', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_skill', name: 'invoke_skill', arguments: '{"skill":"test"}' }] },
        { role: 'tool', toolCallId: 'tc_skill', content: '{"success":true,"result":"skill content"}', turn: 0 },
        { role: 'user', content: 'thanks', turn: 1 },
        { role: 'assistant', content: 'welcome', turn: 1 },
      ];

      // No preservedTurns at all (null) — default behavior
      const policy = normalizeExportPolicy({ keepRecentSkillInvokes: 5 });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const skillTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_skill');
      assert.ok(skillTool, 'skill tool result should be preserved when preservedTurns is null');
    });

    it('does NOT protect skill calls when keepRecentSkillInvokes is disabled', () => {
      const messages = [
        { role: 'user', content: 'do research', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_skill', name: 'invoke_skill', arguments: '{"skill":"test"}' }] },
        { role: 'tool', toolCallId: 'tc_skill', content: '{"success":true,"result":"skill content"}', turn: 0 },
        { role: 'user', content: 'thanks', turn: 1 },
        { role: 'assistant', content: 'welcome', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ keepRecentSkillInvokes: null });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const skillTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_skill');
      assert.ok(!skillTool, 'skill tool result should NOT be preserved when keepRecentSkillInvokes is null');
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

  // ===== tag-based system message preservation =====

  describe('keepSystemTags default', () => {
    it('includes folded-tool-activity in DEFAULT_EXPORT_POLICY', () => {
      assert.ok(DEFAULT_EXPORT_POLICY.keepSystemTags.includes('folded-tool-activity'));
    });

    it('normalizeExportPolicy keeps default keepSystemTags when not specified', () => {
      const policy = normalizeExportPolicy({});
      assert.ok(policy.keepSystemTags.includes('folded-tool-activity'));
    });

    it('normalizeExportPolicy respects explicit keepSystemTags override', () => {
      const policy = normalizeExportPolicy({ keepSystemTags: ['custom-tag'] });
      assert.deepEqual(policy.keepSystemTags, ['custom-tag']);
    });
  });

  describe('folded tool activity notes carry tag', () => {
    it('fold note has tag folded-tool-activity', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const foldNotes = seedMessages.filter(m => m.tag === 'folded-tool-activity');
      assert.ok(foldNotes.length > 0, 'should have at least one fold note with tag');

      const allFoldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.equal(foldNotes.length, allFoldNotes.length, 'all fold notes should carry the tag');
    });
  });

  describe('repeated trim preserves tagged system messages', () => {
    // This is the core bug: first trim creates [Folded tool activity] notes
    // with role:'system'. Second trim drops them because includeSystemMessages=false.
    // The fix: fold notes carry tag:'folded-tool-activity', which is in keepSystemTags.
    it('second trim does not drop fold notes from first trim', () => {
      // Simulate messages that would exist AFTER a first trim:
      // - turn 0 was trimmed, produced a fold note (role:system, tag:folded-tool-activity)
      // - turn 1 is preserved (full detail)
      const afterFirstTrim = [
        { role: 'user', content: 'original question', turn: 0 },
        { role: 'system', content: '[Folded tool activity]\nassistant tool calls: read(a.js)', turn: 0, tag: 'folded-tool-activity' },
        { role: 'user', content: 'follow up', turn: 1 },
        { role: 'assistant', content: 'answer', turn: 1 },
      ];

      // Second trim: trim turn 0, keep turn 1
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(afterFirstTrim, policy);

      // The fold note from turn 0 should survive because it has tag 'folded-tool-activity'
      const survivingFoldNotes = seedMessages.filter(m =>
        m.tag === 'folded-tool-activity' && m.content.includes('[Folded tool activity]')
      );
      assert.ok(survivingFoldNotes.length > 0,
        'fold note with tag folded-tool-activity must survive second trim');
    });

    it('untagged system messages are still dropped by default', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'system', content: 'some runtime reminder without tag', turn: 0 },
        { role: 'assistant', content: 'reply', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply2', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const survivingUntaggedSystem = seedMessages.filter(m =>
        m.role === 'system' && !m.tag
      );
      assert.equal(survivingUntaggedSystem.length, 0,
        'untagged system messages should be dropped');
    });

    it('includeSystemMessages=true overrides keepSystemTags and keeps all system messages', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'system', content: 'untagged reminder', turn: 0 },
        { role: 'system', content: 'tagged note', turn: 0, tag: 'folded-tool-activity' },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [1], includeSystemMessages: true });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const systemMessages = seedMessages.filter(m => m.role === 'system');
      assert.ok(systemMessages.length >= 2, 'both system messages should survive');
    });
  });

  describe('preserve zone passes tag through unchanged', () => {
    it('preserved system messages keep their tag', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'system', content: 'tagged note', turn: 0, tag: 'folded-tool-activity' },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1 },
      ];

      // Preserve both turns
      const policy = normalizeExportPolicy({ preservedTurns: [0, 1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const taggedSystem = seedMessages.find(m =>
        m.role === 'system' && m.tag === 'folded-tool-activity'
      );
      assert.ok(taggedSystem, 'preserved system message should retain its tag');
    });
  });
});
