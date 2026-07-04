/**
 * 系统级 Feature 配置测试 (v2: exec/runtime 模式)
 *
 * 覆盖：
 * 1. 系统配置文件读写
 * 2. programming-helper 读取 LSP 配置（新格式：mode/runtime/binary）
 * 3. 运行时路径提取
 *
 * Directly imports the real exported functions from system-feature-config.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readSystemFeatureConfigFile,
  writeSystemFeatureConfigFile,
  extractLspServerConfig,
} from '../server/routes/system-feature-config.js';

describe('System Feature Config v2', () => {
  const testDir = join(tmpdir(), 'agentdev-test-feature-config-v2');
  const configPath = join(testDir, 'feature-setup.json');

  if (existsSync(testDir)) rmSync(testDir, { recursive: true });

  describe('readSystemFeatureConfigFile', () => {
    it('returns empty object when file does not exist', () => {
      const result = readSystemFeatureConfigFile(join(testDir, 'nonexistent.json'));
      assert.deepStrictEqual(result, {});
    });

    it('returns parsed JSON with new format', () => {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        runtimes: { nodejs: '/usr/local/bin/node', uv: '/usr/local/bin/uv' },
        lsp: {
          typescript: { mode: 'runtime', runtime: 'nodejs' },
          gopls: { mode: 'exec', binary: '/usr/local/bin/gopls' },
        },
      }));
      const result = readSystemFeatureConfigFile(configPath);
      assert.strictEqual(result.runtimes.nodejs, '/usr/local/bin/node');
      assert.strictEqual(result.lsp.typescript.mode, 'runtime');
      assert.strictEqual(result.lsp.gopls.binary, '/usr/local/bin/gopls');
    });

    it('returns empty object for malformed JSON', () => {
      writeFileSync(configPath, 'not json {{{');
      const result = readSystemFeatureConfigFile(configPath);
      assert.deepStrictEqual(result, {});
    });
  });

  describe('writeSystemFeatureConfigFile', () => {
    it('writes new config format and reads it back', () => {
      const subDir = join(testDir, 'sub', 'dir');
      const subPath = join(subDir, 'config.json');
      const config = {
        runtimes: { nodejs: 'C:\\node\\node.exe' },
        lsp: { pyright: { mode: 'runtime', runtime: 'uv' } },
      };
      writeSystemFeatureConfigFile(config, subPath);
      assert.ok(existsSync(subPath));
      const parsed = JSON.parse(readFileSync(subPath, 'utf8'));
      assert.deepStrictEqual(parsed, config);
    });
  });

  describe('extractLspServerConfig (v2)', () => {
    it('extracts runtime mode config with package and args', () => {
      const systemConfig = {
        lsp: {
          typescript: { mode: 'runtime', runtime: 'nodejs', package: 'typescript-language-server', args: '--stdio' },
          pyright: { mode: 'runtime', runtime: 'uv', package: 'pyright-langserver', uvPackage: 'pyright' },
        },
      };
      const result = extractLspServerConfig(systemConfig);
      assert.deepStrictEqual(result, {
        typescript: { mode: 'runtime', runtime: 'nodejs', package: 'typescript-language-server', args: ['--stdio'] },
        pyright: { mode: 'runtime', runtime: 'uv', package: 'pyright-langserver', uvPackage: 'pyright' },
      });
    });

    it('extracts exec mode config', () => {
      const systemConfig = {
        lsp: {
          gopls: { mode: 'exec', binary: '/usr/local/bin/gopls' },
          clangd: { mode: 'exec', binary: '/usr/bin/clangd' },
        },
      };
      const result = extractLspServerConfig(systemConfig);
      assert.deepStrictEqual(result, {
        gopls: { mode: 'exec', binary: '/usr/local/bin/gopls' },
        clangd: { mode: 'exec', binary: '/usr/bin/clangd' },
      });
    });

    it('returns empty object when no lsp section', () => {
      assert.deepStrictEqual(extractLspServerConfig({}), {});
      assert.deepStrictEqual(extractLspServerConfig(null), {});
      assert.deepStrictEqual(extractLspServerConfig(undefined), {});
    });

    it('ignores non-object entries and empty binaries', () => {
      const systemConfig = {
        lsp: {
          typescript: { mode: 'runtime', runtime: 'nodejs' },
          gopls: 'just a string',          // ignored
          clangd: 123,                      // ignored
          bash: { mode: 'exec', binary: '  ' }, // binary trimmed empty → excluded, mode kept
        },
      };
      const result = extractLspServerConfig(systemConfig);
      assert.deepStrictEqual(result, {
        typescript: { mode: 'runtime', runtime: 'nodejs' },
        bash: { mode: 'exec' },
      });
    });

    it('preserves partial fields', () => {
      const systemConfig = {
        lsp: {
          typescript: { mode: 'exec' },  // no binary
          deno: { binary: '/usr/bin/deno' },  // no mode
        },
      };
      const result = extractLspServerConfig(systemConfig);
      assert.deepStrictEqual(result, {
        typescript: { mode: 'exec' },
        deno: { binary: '/usr/bin/deno' },
      });
    });
  });

  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});
