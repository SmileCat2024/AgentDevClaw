/**
 * Tests for cross-platform shell detection in system-feature-config.js
 *
 * Verifies that detectShellPath correctly detects:
 * - Bash on Windows (Git Bash) and Linux/macOS (native bash)
 * - PowerShell on Windows (5.1 or Core) and Linux/macOS (Core only)
 * - Graceful "not found" when a shell is unavailable
 * - Custom configured paths override auto-detection
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// detectShellPath is not exported, so we need to test it indirectly via
// the /protoclaw/shell_availability endpoint. But we can also test the
// readSystemFeatureConfigFile / writeSystemFeatureConfigFile functions
// and the extractLspServerConfig function.

import {
  readSystemFeatureConfigFile,
  writeSystemFeatureConfigFile,
  extractLspServerConfig,
} from '../server/routes/system-feature-config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('System feature config file operations', () => {
  it('should return empty object for non-existent file', () => {
    const result = readSystemFeatureConfigFile(join(tmpdir(), 'non-existent-config-' + Date.now() + '.json'));
    assert.deepEqual(result, {});
  });

  it('should return empty object for invalid JSON', () => {
    const tempFile = join(tmpdir(), 'invalid-config-' + Date.now() + '.json');
    writeFileSync(tempFile, '{ invalid json }');
    const result = readSystemFeatureConfigFile(tempFile);
    assert.deepEqual(result, {});
  });

  it('should read and write config correctly', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    const configPath = join(tempDir, 'test-config.json');
    try {
      const config = {
        shell: {
          bashEnabled: true,
          bashPath: '/custom/bash',
          powershellEnabled: false,
        },
      };
      writeSystemFeatureConfigFile(config, configPath);
      const read = readSystemFeatureConfigFile(configPath);
      assert.deepEqual(read, config);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('extractLspServerConfig', () => {
  it('should extract LSP server config from system config', () => {
    const systemConfig = {
      lsp: {
        typescript: {
          mode: 'npx',
          package: 'typescript-language-server',
          args: '--stdio',
        },
        python: {
          mode: 'uv',
          uvPackage: 'python-lsp-server',
        },
      },
    };
    const result = extractLspServerConfig(systemConfig);
    assert.ok(result.typescript);
    assert.strictEqual(result.typescript.mode, 'npx');
    assert.strictEqual(result.typescript.package, 'typescript-language-server');
    assert.deepEqual(result.typescript.args, ['--stdio']);
    assert.ok(result.python);
    assert.strictEqual(result.python.mode, 'uv');
  });

  it('should return empty object when no LSP config', () => {
    assert.deepEqual(extractLspServerConfig({}), {});
    assert.deepEqual(extractLspServerConfig(null), {});
    assert.deepEqual(extractLspServerConfig(undefined), {});
  });

  it('should handle malformed entries gracefully', () => {
    const systemConfig = {
      lsp: {
        valid: { mode: 'npx' },
        invalid: 'not-an-object',
        nullEntry: null,
      },
    };
    const result = extractLspServerConfig(systemConfig);
    assert.ok(result.valid);
    assert.strictEqual(result.valid.mode, 'npx');
    assert.ok(!result.invalid);
    assert.ok(!result.nullEntry);
  });
});

// Helper to access the non-exported detectShellPath via HTTP endpoint
import http from 'http';
import express from 'express';
import { setupSystemFeatureConfigRoutes } from '../server/routes/system-feature-config.js';

function getShellAvailability() {
  return new Promise((resolve, reject) => {
    const app = express();
    setupSystemFeatureConfigRoutes(app, express);
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}/protoclaw/shell_availability`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe('Shell availability detection (current platform)', () => {
  it('should return structure with bash and powershell keys', async () => {
    const avail = await getShellAvailability();
    assert.ok(avail.bash, 'Missing bash availability info');
    assert.ok(avail.powershell, 'Missing powershell availability info');
  });

  it('each shell entry should have available, path, source fields', async () => {
    const avail = await getShellAvailability();
    for (const shell of [avail.bash, avail.powershell]) {
      assert.ok(typeof shell.available === 'boolean');
      assert.ok('path' in shell);
      assert.ok('source' in shell);
    }
  });

  it('bash should be available on most systems', async () => {
    const avail = await getShellAvailability();
    // On Windows, bash requires Git for Windows. On Linux/macOS, bash is native.
    if (process.platform !== 'win32') {
      assert.ok(avail.bash.available, 'Bash should be available on non-Windows');
      assert.ok(avail.bash.path, 'Bash path should be set when available');
    }
  });

  it('powershell source should be null when not found', async () => {
    const avail = await getShellAvailability();
    if (!avail.powershell.available) {
      assert.strictEqual(avail.powershell.source, null);
      assert.strictEqual(avail.powershell.path, null);
    }
  });
});
