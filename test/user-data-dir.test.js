/**
 * Tests for server/shared/constants.js resolveUserDataDir (R1-08)
 *
 * AGENTDEV_DATA_DIR 数据目录覆盖：多实例/测试场景隔离数据根，
 * 未设置时保持 ~/.agentdev/AgentDevClaw 默认布局不变。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { join, resolve } from 'path';

import { resolveUserDataDir } from '../server/shared/constants.js';

describe('resolveUserDataDir', () => {
  it('falls back to the legacy home layout when the env var is unset', () => {
    assert.equal(resolveUserDataDir({}), join(os.homedir(), '.agentdev', 'AgentDevClaw'));
  });

  it('ignores non-string values as if unset', () => {
    assert.equal(resolveUserDataDir({ AGENTDEV_DATA_DIR: undefined }), join(os.homedir(), '.agentdev', 'AgentDevClaw'));
    assert.equal(
      resolveUserDataDir({ AGENTDEV_DATA_DIR: /** @type {any} */ (42) }),
      join(os.homedir(), '.agentdev', 'AgentDevClaw'),
      'malformed env values must fall back to the legacy layout',
    );
  });

  it('treats a blank override as unset', () => {
    assert.equal(resolveUserDataDir({ AGENTDEV_DATA_DIR: '' }), join(os.homedir(), '.agentdev', 'AgentDevClaw'));
    assert.equal(
      resolveUserDataDir({ AGENTDEV_DATA_DIR: '   ' }),
      join(os.homedir(), '.agentdev', 'AgentDevClaw'),
      'whitespace-only overrides must not produce a bogus root',
    );
  });

  it('uses the trimmed override verbatim when absolute', () => {
    const override = join(os.tmpdir(), 'claw-lab-data');
    assert.equal(
      resolveUserDataDir({ AGENTDEV_DATA_DIR: `  ${override}  ` }),
      resolve(override),
      'surrounding whitespace must be trimmed before resolving',
    );
  });

  it('resolves relative overrides against the current working directory', () => {
    const relative = 'relative-lab-dir';
    assert.equal(
      resolveUserDataDir({ AGENTDEV_DATA_DIR: relative }),
      resolve(relative),
    );
  });
});
