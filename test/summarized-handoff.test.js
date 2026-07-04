import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFragment,
  cleanInlineText,
  cleanMultilineText,
  buildSourceRecord,
  buildCompactOverview,
  normalizeSummaryPolicy,
  buildSummarySeedMessage,
} from '../server/context-continuity/summarized-handoff.js';

describe('summarized-handoff pure functions', () => {

  describe('sanitizeFragment', () => {
    it('returns trimmed alphanumeric fragment', () => {
      assert.equal(sanitizeFragment('my-agent-id'), 'my-agent-id');
    });

    it('replaces non-alphanumeric characters with hyphens', () => {
      assert.equal(sanitizeFragment('my agent!'), 'my-agent');
    });

    it('collapses consecutive hyphens', () => {
      assert.equal(sanitizeFragment('a---b'), 'a-b');
    });

    it('strips leading/trailing hyphens', () => {
      assert.equal(sanitizeFragment('--abc--'), 'abc');
    });

    it('falls back to "default" for empty or null', () => {
      assert.equal(sanitizeFragment(null), 'default');
      assert.equal(sanitizeFragment(''), 'default');
      assert.equal(sanitizeFragment(undefined), 'default');
    });

    it('converts numbers to string', () => {
      assert.equal(sanitizeFragment(123), '123');
    });
  });

  describe('cleanInlineText', () => {
    it('collapses whitespace into single spaces and trims', () => {
      assert.equal(cleanInlineText('  hello   world  '), 'hello world');
    });

    it('returns empty string for non-string values', () => {
      assert.equal(cleanInlineText(null), '');
      assert.equal(cleanInlineText(undefined), '');
      assert.equal(cleanInlineText(42), '');
    });

    it('handles tabs and newlines', () => {
      assert.equal(cleanInlineText('hello\t\nworld'), 'hello world');
    });
  });

  describe('cleanMultilineText', () => {
    it('normalizes line endings', () => {
      assert.equal(cleanMultilineText('a\r\nb\rc'), 'a\nb\nc');
    });

    it('collapses trailing spaces on each line', () => {
      assert.equal(cleanMultilineText('a   \nb   '), 'a\nb');
    });

    it('collapses multiple blank lines into one', () => {
      const input = 'line1\n\n\n\nline2';
      assert.equal(cleanMultilineText(input), 'line1\n\nline2');
    });

    it('trims leading and trailing whitespace', () => {
      assert.equal(cleanMultilineText('\n\n  hello  \n\n'), 'hello');
    });

    it('returns empty string for non-string values', () => {
      assert.equal(cleanMultilineText(null), '');
      assert.equal(cleanMultilineText(123), '');
    });
  });

  describe('buildSourceRecord', () => {
    it('applies cleanInlineText and cleanMultilineText to fields', () => {
      const rec = buildSourceRecord({
        title: '  My  Title ',
        goal: 'Fix\n\nthe\n\nbug',
        constraints: '  must be fast  ',
      });
      assert.equal(rec.title, 'My Title');
      assert.equal(rec.goal, 'Fix\n\nthe\n\nbug');
      assert.equal(rec.constraints, 'must be fast');
    });

    it('returns empty strings for missing fields', () => {
      const rec = buildSourceRecord({});
      assert.equal(rec.title, '');
      assert.equal(rec.goal, '');
      assert.equal(rec.openDirectory, '');
    });

    it('returns all expected keys', () => {
      const rec = buildSourceRecord();
      const expectedKeys = [
        'title', 'featureName', 'agentName', 'taskTitle', 'taskType',
        'goal', 'constraints', 'expectedOutput', 'targetFiles',
        'referenceMaterials', 'openDirectory', 'createdAt', 'updatedAt',
      ];
      assert.deepEqual(Object.keys(rec).sort(), expectedKeys.sort());
    });
  });

  describe('buildCompactOverview', () => {
    it('builds overview from taskTitle', () => {
      const overview = buildCompactOverview({ taskTitle: 'Fix bug' });
      assert.ok(overview.includes('Task: Fix bug'));
    });

    it('falls back to title when taskTitle is empty', () => {
      const overview = buildCompactOverview({ title: 'General Task' });
      assert.ok(overview.includes('Task: General Task'));
    });

    it('includes goal, constraints, and openDirectory when present', () => {
      const overview = buildCompactOverview({
        taskTitle: 'Build API',
        goal: 'Create REST endpoints',
        constraints: 'Must be fast',
        openDirectory: '/project',
      });
      assert.ok(overview.includes('Goal: Create REST endpoints'));
      assert.ok(overview.includes('Constraints: Must be fast'));
      assert.ok(overview.includes('Working directory: /project'));
    });

    it('returns empty string for empty input', () => {
      assert.equal(buildCompactOverview({}), '');
      assert.equal(buildCompactOverview(), '');
    });

    it('omits sections when fields are empty', () => {
      const overview = buildCompactOverview({ taskTitle: 'Only task' });
      assert.ok(!overview.includes('Goal:'));
      assert.ok(!overview.includes('Constraints:'));
    });
  });

  describe('normalizeSummaryPolicy', () => {
    it('defaults maxAttempts to 3', () => {
      const policy = normalizeSummaryPolicy({});
      assert.equal(policy.maxAttempts, 3);
    });

    it('clamps maxAttempts between 1 and 5', () => {
      assert.equal(normalizeSummaryPolicy({ maxAttempts: 0 }).maxAttempts, 1);
      assert.equal(normalizeSummaryPolicy({ maxAttempts: 99 }).maxAttempts, 5);
      assert.equal(normalizeSummaryPolicy({ maxAttempts: 2 }).maxAttempts, 2);
    });

    it('clamps non-finite maxAttempts to 3', () => {
      assert.equal(normalizeSummaryPolicy({ maxAttempts: NaN }).maxAttempts, 3);
      assert.equal(normalizeSummaryPolicy({ maxAttempts: Infinity }).maxAttempts, 3);
    });

    it('sets strategy and summaryShape', () => {
      const policy = normalizeSummaryPolicy({});
      assert.equal(policy.strategy, 'summarized-nine-section');
      assert.equal(policy.summaryShape, 'claude-nine-section-v1');
    });

    it('cleans additionalInstructions with cleanMultilineText', () => {
      // cleanMultilineText uses trimEnd() per line, so leading single spaces survive
      const policy = normalizeSummaryPolicy({ additionalInstructions: 'line1\n\nline2' });
      assert.equal(policy.additionalInstructions, 'line1\n\nline2');
    });
  });

  describe('buildSummarySeedMessage', () => {
    it('returns a system message with turn 0', () => {
      const msg = buildSummarySeedMessage('test summary');
      assert.equal(msg.role, 'system');
      assert.equal(msg.turn, 0);
    });

    it('embeds the cleaned summary text in content', () => {
      const msg = buildSummarySeedMessage('  fixed  \n\n  the  bug  ');
      assert.ok(msg.content.includes('fixed'));
      assert.ok(msg.content.includes('the'));
      assert.ok(msg.content.includes('bug'));
      assert.ok(msg.content.includes('摘要：'));
    });

    it('includes guidance to continue work', () => {
      const msg = buildSummarySeedMessage('did stuff');
      assert.ok(msg.content.includes('无需要求用户重复陈述背景'));
    });

    it('handles empty input', () => {
      const msg = buildSummarySeedMessage('');
      assert.equal(msg.role, 'system');
      assert.ok(msg.content.includes('摘要：'));
    });
  });
});
