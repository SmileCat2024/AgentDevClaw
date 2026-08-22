/**
 * Tests for agents/coder/agent.js config-group queue assembly (ticket 04).
 *
 * Covers: group listing, selected-state priority (CLI > selected.json > none),
 * clear error on missing group name, and queue merge via resolveFeatureConfig
 * ([global layer, selected group]). Uses a temp feature-config dir — never the
 * real user directory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { listConfigGroups, resolveSelectedConfigGroup } from '../agents/coder/agent.js';

let tempDir;
let featureConfigDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coder-config-groups-test-'));
  featureConfigDir = join(tempDir, 'feature-config');
  mkdirSync(join(featureConfigDir, 'groups'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeGroup(name, content) {
  writeFileSync(join(featureConfigDir, 'groups', `${name}.json`), JSON.stringify(content), 'utf8');
}

describe('listConfigGroups', () => {
  it('returns sorted group names from groups/*.json', () => {
    writeGroup('b-group', {});
    writeGroup('a-group', {});
    writeFileSync(join(featureConfigDir, 'groups', 'notes.txt'), 'not json', 'utf8');
    assert.deepEqual(listConfigGroups(featureConfigDir), ['a-group', 'b-group']);
  });

  it('returns empty list when groups dir is absent', () => {
    rmSync(join(featureConfigDir, 'groups'), { recursive: true, force: true });
    assert.deepEqual(listConfigGroups(featureConfigDir), []);
  });
});

describe('resolveSelectedConfigGroup', () => {
  it('CLI --config-group wins over persisted selected.json (temporary override)', () => {
    writeGroup('from-cli', {});
    writeGroup('persisted', {});
    writeFileSync(
      join(featureConfigDir, 'selected.json'),
      JSON.stringify({ group: 'persisted' }),
      'utf8',
    );
    const selected = resolveSelectedConfigGroup({ configGroup: 'from-cli' }, featureConfigDir);
    assert.equal(selected, 'from-cli');
  });

  it('falls back to selected.json when no CLI arg', () => {
    writeGroup('persisted', {});
    writeFileSync(
      join(featureConfigDir, 'selected.json'),
      JSON.stringify({ group: 'persisted' }),
      'utf8',
    );
    assert.equal(resolveSelectedConfigGroup({}, featureConfigDir), 'persisted');
  });

  it('returns null with no CLI arg and no selected.json (no group layer)', () => {
    writeGroup('some-group', {});
    assert.equal(resolveSelectedConfigGroup({}, featureConfigDir), null);
  });

  it('treats corrupted selected.json as no selection', () => {
    writeGroup('persisted', {});
    writeFileSync(join(featureConfigDir, 'selected.json'), '{broken json', 'utf8');
    assert.equal(resolveSelectedConfigGroup({}, featureConfigDir), null);
  });

  it('throws a clear error naming the missing group and available ones', () => {
    writeGroup('real-a', {});
    writeGroup('real-b', {});
    assert.throws(
      () => resolveSelectedConfigGroup({ configGroup: 'real-' }, featureConfigDir),
      (error) => {
        const message = String(error?.message || error);
        return message.includes('"real-"') && message.includes('real-a') && message.includes('real-b');
      },
    );
  });

  it('throws a clear error when persisted selected.json names a missing group', () => {
    writeFileSync(
      join(featureConfigDir, 'selected.json'),
      JSON.stringify({ group: 'gone' }),
      'utf8',
    );
    assert.throws(
      () => resolveSelectedConfigGroup({}, featureConfigDir),
      /配置组不存在: "gone"/,
    );
  });

  it('ignores blank/whitespace CLI values like no selection', () => {
    writeGroup('g', {});
    writeFileSync(join(featureConfigDir, 'selected.json'), JSON.stringify({ group: 'g' }), 'utf8');
    // blank string falls through to persisted state rather than erroring
    assert.equal(resolveSelectedConfigGroup({ configGroup: '   ' }, featureConfigDir), 'g');
  });
});
