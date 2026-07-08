/**
 * Tests for server/shared/fs-helpers.js
 *
 * Covers: readJson, readJsonSafe, ensureDir, normalizePathCasing.
 * Uses real temp directories — no mocks.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readJson, readJsonSafe, ensureDir, normalizePathCasing } from '../server/shared/fs-helpers.js';

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fs-helpers-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('readJson', () => {
  it('should read and parse a valid JSON file', async () => {
    const filePath = join(tempDir, 'valid.json');
    writeFileSync(filePath, JSON.stringify({ key: 'value', num: 42 }));
    const result = await readJson(filePath);
    assert.deepEqual(result, { key: 'value', num: 42 });
  });

  it('should throw on non-existent file', async () => {
    await assert.rejects(
      () => readJson(join(tempDir, 'missing.json')),
      { code: 'ENOENT' },
    );
  });

  it('should throw on invalid JSON', async () => {
    const filePath = join(tempDir, 'bad.json');
    writeFileSync(filePath, 'not json');
    await assert.rejects(() => readJson(filePath));
  });
});

describe('readJsonSafe', () => {
  it('should return parsed JSON on success', async () => {
    const filePath = join(tempDir, 'ok.json');
    writeFileSync(filePath, '{"a":1}');
    const result = await readJsonSafe(filePath);
    assert.deepEqual(result, { a: 1 });
  });

  it('should return fallback on missing file', async () => {
    const result = await readJsonSafe(join(tempDir, 'missing.json'), { default: true });
    assert.deepEqual(result, { default: true });
  });

  it('should return null as default fallback', async () => {
    const result = await readJsonSafe(join(tempDir, 'missing.json'));
    assert.equal(result, null);
  });

  it('should return fallback on invalid JSON', async () => {
    const filePath = join(tempDir, 'bad.json');
    writeFileSync(filePath, 'broken');
    const result = await readJsonSafe(filePath, 'fallback');
    assert.equal(result, 'fallback');
  });
});

describe('ensureDir', () => {
  it('should create a single directory', async () => {
    const dirPath = join(tempDir, 'newdir');
    await ensureDir(dirPath);
    const stat = await fs.stat(dirPath);
    assert.ok(stat.isDirectory());
  });

  it('should create nested directories', async () => {
    const dirPath = join(tempDir, 'a', 'b', 'c');
    await ensureDir(dirPath);
    const stat = await fs.stat(dirPath);
    assert.ok(stat.isDirectory());
  });

  it('should not throw if directory already exists', async () => {
    const dirPath = join(tempDir, 'existing');
    mkdirSync(dirPath);
    await ensureDir(dirPath);
    const stat = await fs.stat(dirPath);
    assert.ok(stat.isDirectory());
  });
});

describe('normalizePathCasing', () => {
  it('should return empty string unchanged', async () => {
    const result = await normalizePathCasing('');
    assert.equal(result, '');
  });

  it('should return null/undefined unchanged', async () => {
    assert.equal(await normalizePathCasing(null), null);
    assert.equal(await normalizePathCasing(undefined), undefined);
  });

  it('should resolve real casing for existing directory', async () => {
    // Create a directory with known casing
    const dirPath = join(tempDir, 'MyDir');
    mkdirSync(dirPath);

    const result = await normalizePathCasing(dirPath);
    // The resolved path should point to the same location
    assert.ok(result.length > 0);
    // On all platforms, the basename should be 'MyDir' (or the real OS casing)
    assert.ok(result.endsWith('MyDir') || result.endsWith('mydir'));
  });

  it('should return original path when directory does not exist', async () => {
    const fakePath = join(tempDir, 'does-not-exist');
    const result = await normalizePathCasing(fakePath);
    assert.equal(result, fakePath);
  });
});
