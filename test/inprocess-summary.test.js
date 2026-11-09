import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummaryPromptForSession,
  runInProcessSummary,
} from '../server/context-continuity/inprocess-summary.js';
import { buildSummaryPrompt } from '@agentdevjs/core';
import { scanFilesAndSkills } from '../server/context-continuity/claude-compact-prompts.js';

it('Claw summary scanning recognizes structured slash activation without reading document text', () => {
  const scanned = scanFilesAndSkills([
    { role: 'system', source: 'skill', tag: { kind: 'skill-activation', skill: 'slash-only' }, content: 'opaque document' },
    { role: 'user', content: '[技能激活：fake]' },
  ]);
  assert.deepEqual(scanned.skills, ['slash-only']);
});

describe('buildSummaryPromptForSession', () => {
  it('uses the official base prompt for ordinary sessions', () => {
    const prompt = buildSummaryPromptForSession({ sessionType: '', trimAppended: false });
    assert.equal(prompt, buildSummaryPrompt({}));
  });

  it('uses the official trim-appended prompt when trimAppended is set', () => {
    const prompt = buildSummaryPromptForSession({ sessionType: '', trimAppended: true });
    assert.equal(prompt, buildSummaryPrompt({ trimAppended: true }));
  });

  it('forwards additionalInstructions to the official builder', () => {
    const prompt = buildSummaryPromptForSession({
      sessionType: '',
      trimAppended: false,
      additionalInstructions: '保留迁移细节',
    });
    assert.ok(prompt.includes('## 额外压缩指令'));
    assert.ok(prompt.includes('保留迁移细节'));
  });

  it('non-main sessionTypes use the official base prompt', () => {
    const prompt = buildSummaryPromptForSession({ sessionType: 'sub', trimAppended: false });
    assert.equal(prompt, buildSummaryPrompt({}));
  });
});

describe('runInProcessSummary error paths', () => {
  it('throws when the session snapshot cannot be loaded', async () => {
    await assert.rejects(
      runInProcessSummary({
        agentRelativeDir: 'prebuilt-agents/official/no-such-agent',
        projectRoot: process.cwd(),
        agentId: 'no-such-agent',
        sessionId: 'no-such-session',
      }),
      /Session snapshot not found/,
    );
  });

  it('throws when the session snapshot has no messages', async () => {
    await assert.rejects(
      runInProcessSummary({
        agentRelativeDir: 'prebuilt-agents/official/whatever',
        projectRoot: process.cwd(),
        agentId: 'whatever',
        sessionId: 'whatever',
        sourceSessionSnapshot: { runtime: { context: { messages: [] } } },
      }),
      /no messages/,
    );
  });

  it('throws a descriptive error when no model preset resolves', async () => {
    await assert.rejects(
      runInProcessSummary({
        agentRelativeDir: 'prebuilt-agents/official/no-such-agent',
        projectRoot: process.cwd(),
        agentId: 'no-such-agent',
        sessionId: 'session',
        sourceSessionSnapshot: { runtime: { context: { messages: [{ role: 'user', content: 'hi' }] } } },
      }),
      /No model preset resolved.*role=system/,
    );
  });
});
