/**
 * Tests for accumulation-field collapse across config layers.
 *
 * 累加型多值字段（skill.extraDirs 等）跨层叠加：上游在前、精确去重、
 * 并集写回最后一个提及层、merge 规范本身不变。覆盖折叠助手的纯逻辑
 * 与 resolveFeatureConfig 的集成（merged 等于并集）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFeatureConfig } from '@agentdevjs/core';
import {
  ACCUMULATED_FIELD_PATHS,
  collapseAccumulatedFields,
} from '../server/shared/feature-config-accumulate.js';

describe('collapseAccumulatedFields', () => {
  it('unions mentions across layers in upstream-first order with exact dedupe', () => {
    const queue = [
      { skill: { extraDirs: ['/etc/codex/skills'] } },
      { skill: { scanClaudeDir: true } },
      { skill: { extraDirs: ['/proj/skills', '/etc/codex/skills'] } },
    ];
    const collapsed = collapseAccumulatedFields(queue);

    // 并集写回最后一个提及层；更早的提及保持原值（被 merge 的整体替换遮蔽）
    assert.deepEqual(collapsed[0].skill.extraDirs, ['/etc/codex/skills']);
    assert.deepEqual(collapsed[2].skill.extraDirs, ['/etc/codex/skills', '/proj/skills']);

    const { merged } = resolveFeatureConfig(collapsed);
    assert.deepEqual(merged.skill.extraDirs, ['/etc/codex/skills', '/proj/skills']);
    assert.equal(merged.skill.scanClaudeDir, true);
  });

  it('returns the same queue reference when only one layer mentions the field', () => {
    const queue = [
      { skill: { extraDirs: ['/a'] } },
      { lsp: { typescript: { mode: 'runtime' } } },
    ];
    assert.equal(collapseAccumulatedFields(queue), queue);
  });

  it('returns the same queue reference when the last mention already equals the union', () => {
    const queue = [
      { skill: { extraDirs: ['/a'] } },
      { skill: { extraDirs: ['/a'] } },
    ];
    assert.equal(collapseAccumulatedFields(queue), queue);
  });

  it('skips non-array mentions; null no longer clears upstream entries', () => {
    const queue = [
      { skill: { extraDirs: ['/a'] } },
      { skill: { extraDirs: null } },
      { skill: { extraDirs: ['/b'] } },
    ];
    const { merged } = resolveFeatureConfig(collapseAccumulatedFields(queue));
    assert.deepEqual(merged.skill.extraDirs, ['/a', '/b']);
  });

  it('leaves the queue untouched when all mentions are non-arrays', () => {
    const queue = [
      { skill: { extraDirs: null } },
      { skill: { extraDirs: null } },
    ];
    assert.equal(collapseAccumulatedFields(queue), queue);
  });

  it('does not touch other array fields (wholesale replace semantics unchanged)', () => {
    const queue = [
      { lsp: { runtimes: ['a', 'b'] } },
      { lsp: { runtimes: ['c'] } },
    ];
    const collapsed = collapseAccumulatedFields(queue);
    assert.deepEqual(collapsed[1].lsp.runtimes, ['c']);
    const { merged } = resolveFeatureConfig(collapsed);
    assert.deepEqual(merged.lsp.runtimes, ['c']);
  });

  it('does not mutate the input queue (copy-on-write)', () => {
    const queue = [
      { skill: { extraDirs: ['/a'] } },
      { skill: { extraDirs: ['/b'] } },
    ];
    collapseAccumulatedFields(queue);
    assert.deepEqual(queue[1].skill.extraDirs, ['/b']);
  });

  it('registers skill.extraDirs as the known accumulation field', () => {
    assert.ok(ACCUMULATED_FIELD_PATHS.includes('skill.extraDirs'));
  });
});
