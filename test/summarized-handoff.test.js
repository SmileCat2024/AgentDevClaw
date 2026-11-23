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
  buildRecentUserInputReminder,
  writeSummarizedHandoffPackage,
} from '../server/context-continuity/summarized-handoff.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
        sessionType: 'coder',
      });
      assert.equal(rec.title, 'My Title');
      assert.equal(rec.sessionType, 'coder');
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
        'referenceMaterials', 'openDirectory', 'createdAt', 'updatedAt', 'sessionType', 'workspaceAgentId',
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
      // 框架 SummaryTransformation 的九段摘要协议已升级至 v2。
      assert.equal(policy.summaryShape, 'claude-nine-section-v2');
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

  describe('buildRecentUserInputReminder', () => {
    it('keeps the last user messages verbatim, newest last, within the caps', () => {
      const reminder = buildRecentUserInputReminder([
        { role: 'user', content: '早期要求' },
        { role: 'assistant', content: '答复' },
        { role: 'tool', toolCallId: 't1', content: '工具输出' },
        { role: 'user', content: '改一下方向：先别动配置层' },
        { role: 'assistant', content: '收到' },
        { role: 'user', content: '另外补一个回归用例' },
      ], { maxMessages: 2 });
      assert.ok(reminder.includes('1. 改一下方向：先别动配置层'));
      assert.ok(reminder.includes('2. 另外补一个回归用例'));
      assert.ok(!reminder.includes('早期要求'), 'older user input is dropped by the message cap');
      assert.ok(!reminder.includes('工具输出'), 'tool results never enter the reminder');
    });

    it('truncates long input instead of letting it blow the char budget', () => {
      const reminder = buildRecentUserInputReminder(
        [{ role: 'user', content: 'x'.repeat(500) }],
        { maxChars: 120 },
      );
      assert.ok(reminder.includes('…'));
      assert.ok(reminder.length < 260, `reminder stays bounded, got ${reminder.length}`);
    });

    it('returns an empty string when the session has no user input', () => {
      assert.equal(buildRecentUserInputReminder([{ role: 'assistant', content: 'a' }]), '');
      assert.equal(buildRecentUserInputReminder(null), '');
    });
  });

  describe('writeSummarizedHandoffPackage appendix', () => {
    it('attaches the reminder without touching the summary seed skeleton', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'claw-summarized-appendix-'));
      try {
        const { handoffPath } = await writeSummarizedHandoffPackage({
          userDataRoot: root,
          agentId: 'coder',
          sessionId: 'session-1',
          summaryText: '摘要正文',
          appendixContent: '以下是用户此前在这项任务中说过的话（按时间顺序）：\n1. 先别动配置层',
        });
        const onDisk = JSON.parse(await readFile(handoffPath, 'utf8'));
        assert.equal(onDisk.seedMessages.length, 1, 'seed skeleton stays a single summary message');
        assert.equal(onDisk.appendix.kind, 'recent-user-input');
        assert.ok(onDisk.appendix.content.includes('先别动配置层'));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('omits the appendix field when the option is off', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'claw-summarized-noappendix-'));
      try {
        const { handoff } = await writeSummarizedHandoffPackage({
          userDataRoot: root,
          agentId: 'coder',
          sessionId: 'session-1',
          summaryText: '摘要正文',
        });
        assert.equal(handoff.appendix, undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
