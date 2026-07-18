/**
 * Tests for platform-aware UDS path in agent-startup.js
 *
 * Ensures that the default UDS path correctly adapts to the runtime platform:
 * - Windows: Named Pipe format (\\.\pipe\...)
 * - Linux/macOS: Unix Domain Socket file path (/tmp/...)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_UDS_PATH } from '../server/routes/agent-startup.js';

describe('DEFAULT_UDS_PATH', () => {
  it('should be a non-empty string', () => {
    assert.ok(typeof DEFAULT_UDS_PATH === 'string');
    assert.ok(DEFAULT_UDS_PATH.length > 0);
  });

  it('should use Named Pipe format on Windows', () => {
    if (process.platform !== 'win32') return; // skip on non-Windows
    assert.ok(
      DEFAULT_UDS_PATH.includes('pipe'),
      `Expected Named Pipe format on win32, got: ${DEFAULT_UDS_PATH}`,
    );
  });

  it('should use Unix socket path on Linux/macOS', () => {
    if (process.platform === 'win32') return; // skip on Windows
    assert.ok(
      DEFAULT_UDS_PATH.startsWith('/'),
      `Expected Unix-style path on ${process.platform}, got: ${DEFAULT_UDS_PATH}`,
    );
    assert.ok(
      DEFAULT_UDS_PATH.endsWith('.sock'),
      `Expected .sock extension on ${process.platform}, got: ${DEFAULT_UDS_PATH}`,
    );
  });

  it('should not contain Windows pipe prefix on non-Windows', () => {
    if (process.platform === 'win32') return;
    assert.ok(
      !DEFAULT_UDS_PATH.includes('pipe'),
      `Named Pipe path leaked to non-Windows platform: ${DEFAULT_UDS_PATH}`,
    );
  });
});
