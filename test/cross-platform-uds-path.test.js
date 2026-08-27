/**
 * Tests for platform-aware UDS path resolution (shared/constants.js)
 *
 * Ensures the instance UDS path adapts to the runtime platform on both the
 * legacy default and data-dir-isolated derivations:
 * - Windows: Named Pipe format (\\.\pipe\...)
 * - Linux/macOS: Unix Domain Socket file path (/tmp/...sock)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { join } from 'path';

import { resolveInstanceUdsPath } from '../server/shared/constants.js';

describe('resolveInstanceUdsPath platform shapes', () => {
  it('legacy default: non-empty and platform-appropriate', () => {
    const p = resolveInstanceUdsPath({});
    assert.ok(typeof p === 'string' && p.length > 0);
    if (process.platform === 'win32') {
      assert.ok(p.includes('pipe'), `Expected Named Pipe format on win32, got: ${p}`);
    } else {
      assert.ok(p.startsWith('/'), `Expected Unix-style path, got: ${p}`);
      assert.ok(p.endsWith('.sock'), `Expected .sock extension, got: ${p}`);
      assert.ok(!p.includes('pipe'), `Named Pipe path leaked to non-Windows: ${p}`);
    }
  });

  it('data-dir derivation: non-empty and platform-appropriate', () => {
    const p = resolveInstanceUdsPath({ AGENTDEV_DATA_DIR: join(os.tmpdir(), 'uds-shape-lab') });
    if (process.platform === 'win32') {
      assert.ok(p.startsWith('\\\\.\\pipe\\'), `Expected Named Pipe format on win32, got: ${p}`);
    } else {
      assert.ok(p.startsWith('/tmp/agentdev-viewer-') && p.endsWith('.sock'), `Expected namespaced sock path, got: ${p}`);
    }
  });
});
