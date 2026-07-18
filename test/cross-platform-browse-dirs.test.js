/**
 * Tests for /protoclaw/browse_dirs endpoint with includeFiles support
 *
 * Verifies that:
 * - Default behavior (no includeFiles) returns only directories
 * - With includeFiles=true, both files and directories are returned
 * - Entries have correct isDirectory flag
 * - Sorting puts directories before files
 * - Parent navigation works correctly
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { setupSystemFeatureConfigRoutes } from '../server/routes/system-feature-config.js';

let tempDir;
let app;
let server;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'browse-dirs-test-'));

  // Create structure:
  //   tempDir/
  //     subdir1/
  //     subdir2/
  //     file1.txt
  //     file2.js
  mkdirSync(join(tempDir, 'subdir1'));
  mkdirSync(join(tempDir, 'subdir2'));
  writeFileSync(join(tempDir, 'file1.txt'), 'hello');
  writeFileSync(join(tempDir, 'file2.js'), 'code');

  app = express();
  setupSystemFeatureConfigRoutes(app, express);
  server = app.listen(0);
});

afterEach(() => {
  server?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

describe('browse_dirs without includeFiles', () => {
  it('should return only directories by default', async () => {
    const result = await fetchJson(`/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}`);
    assert.strictEqual(result.status, 200);

    const dirs = result.body.entries.filter((e) => e.isDirectory !== false);
    const files = result.body.entries.filter((e) => e.isDirectory === false);

    // Should have exactly 2 directories and 0 files
    assert.strictEqual(dirs.length, 2, 'Expected 2 directories');
    assert.strictEqual(files.length, 0, 'Expected 0 files when includeFiles is not set');
  });

  it('should return entries with name and path', async () => {
    const result = await fetchJson(`/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}`);
    assert.strictEqual(result.status, 200);

    for (const entry of result.body.entries) {
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0);
      assert.ok(typeof entry.path === 'string' && entry.path.length > 0);
    }
  });

  it('should return parent when not at root', async () => {
    const result = await fetchJson(`/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}`);
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.parent, 'Should have a parent directory');
  });

  it('should return platform field', async () => {
    const result = await fetchJson(`/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}`);
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.platform, 'Should include platform field');
  });
});

describe('browse_dirs with includeFiles=true', () => {
  it('should return both directories and files', async () => {
    const result = await fetchJson(
      `/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}&includeFiles=true`,
    );
    assert.strictEqual(result.status, 200);

    const dirs = result.body.entries.filter((e) => e.isDirectory === true);
    const files = result.body.entries.filter((e) => e.isDirectory === false);

    assert.strictEqual(dirs.length, 2, 'Expected 2 directories');
    assert.strictEqual(files.length, 2, 'Expected 2 files');
  });

  it('should sort directories before files', async () => {
    const result = await fetchJson(
      `/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}&includeFiles=true`,
    );
    assert.strictEqual(result.status, 200);

    const entries = result.body.entries;
    assert.strictEqual(entries.length, 4);

    // First two should be directories
    assert.strictEqual(entries[0].isDirectory, true);
    assert.strictEqual(entries[1].isDirectory, true);
    // Last two should be files
    assert.strictEqual(entries[2].isDirectory, false);
    assert.strictEqual(entries[3].isDirectory, false);
  });

  it('should include correct file names', async () => {
    const result = await fetchJson(
      `/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}&includeFiles=true`,
    );
    assert.strictEqual(result.status, 200);

    const fileNames = result.body.entries
      .filter((e) => !e.isDirectory)
      .map((e) => e.name)
      .sort();

    assert.deepEqual(fileNames, ['file1.txt', 'file2.js']);
  });

  it('should include correct directory names', async () => {
    const result = await fetchJson(
      `/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}&includeFiles=true`,
    );
    assert.strictEqual(result.status, 200);

    const dirNames = result.body.entries
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort();

    assert.deepEqual(dirNames, ['subdir1', 'subdir2']);
  });
});

describe('browse_dirs edge cases', () => {
  it('should handle empty directory', async () => {
    const emptyDir = join(tempDir, 'subdir1');
    const result = await fetchJson(
      `/protoclaw/browse_dirs?path=${encodeURIComponent(emptyDir)}&includeFiles=true`,
    );
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.entries.length, 0);
  });

  it('should handle includeFiles=false explicitly', async () => {
    const result = await fetchJson(
      `/protoclaw/browse_dirs?path=${encodeURIComponent(tempDir)}&includeFiles=false`,
    );
    assert.strictEqual(result.status, 200);

    const files = result.body.entries.filter((e) => e.isDirectory === false);
    assert.strictEqual(files.length, 0, 'Should not include files when includeFiles=false');
  });

  it('should default to home dir when no path provided', async () => {
    const result = await fetchJson('/protoclaw/browse_dirs');
    assert.strictEqual(result.status, 200);
    assert.ok(result.body.currentPath, 'Should have a currentPath');
  });
});
