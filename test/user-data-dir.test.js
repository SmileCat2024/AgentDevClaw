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

import { resolveUserDataDir, resolveInstanceUdsPath } from '../server/shared/constants.js';

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

/**
 * resolveInstanceUdsPath（多实例 IPC 隔离，R1-08 后续热修）：
 * 默认管道是全局固定名，两个实例的数据目录被 AGENTDEV_DATA_DIR 隔离后，
 * 运行时若仍连接同一条管道会注册进另一个实例的 ViewerWorker。
 */
describe('resolveInstanceUdsPath', () => {
  const legacyPipe = process.platform === 'win32' ? '\\\\.\\pipe\\agentdev-viewer' : '/tmp/agentdev-viewer.sock';

  it('keeps the legacy global pipe when the data dir is the Claw default', () => {
    assert.equal(resolveInstanceUdsPath({}), legacyPipe);
    assert.equal(
      resolveInstanceUdsPath({ AGENTDEV_DATA_DIR: join(os.homedir(), '.agentdev', 'AgentDevClaw') }),
      legacyPipe,
    );
  });

  it('derives a stable, distinct pipe per data dir', () => {
    const a = { AGENTDEV_DATA_DIR: join(os.tmpdir(), 'lab-one') };
    const b = { AGENTDEV_DATA_DIR: join(os.tmpdir(), 'lab-two') };
    for (const env of [a, b]) {
      const p1 = resolveInstanceUdsPath(env);
      const p2 = resolveInstanceUdsPath(env);
      assert.equal(p1, p2, 'same env must yield a deterministic pipe');
      assert.ok(p1.includes('agentdev-viewer-'), `derived pipe must be namespaced: ${p1}`);
      assert.notEqual(p1, legacyPipe);
    }
    assert.notEqual(resolveInstanceUdsPath(a), resolveInstanceUdsPath(b), 'different data dirs must not share a pipe');
  });

  it('gives an explicit AGENTDEV_UDS_PATH override top precedence', () => {
    assert.equal(
      resolveInstanceUdsPath({ AGENTDEV_UDS_PATH: '\\\\.\\pipe\\custom', AGENTDEV_DATA_DIR: join(os.tmpdir(), 'x') }),
      '\\\\.\\pipe\\custom',
    );
  });
});
