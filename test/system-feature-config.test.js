/**
 * 系统级 Feature 配置测试 (v2: exec/runtime 模式)
 *
 * 覆盖：
 * 1. 系统配置文件读写
 * 2. programming-helper 读取 LSP 配置（新格式：mode/runtime/binary）
 * 3. 运行时路径提取
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

// ── Inline replicas of server.js / agent.js logic ────────────

function readSystemFeatureConfig(configPath) {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSystemFeatureConfig(configPath, config) {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * 从系统配置中提取 LSP servers 配置 (v2 格式)
 * 输入: { lsp: { typescript: { mode, runtime, binary, package, uvPackage, args } } }
 * 输出: { typescript: { mode, runtime, binary, package, uvPackage, args } }
 */
function extractLspServerConfig(systemConfig) {
  const lspSection = systemConfig?.lsp;
  if (!lspSection || typeof lspSection !== 'object') return {};
  const result = {};
  for (const [serverId, entry] of Object.entries(lspSection)) {
    if (entry && typeof entry === 'object') {
      const serverConfig = {};
      if (typeof entry.mode === 'string') serverConfig.mode = entry.mode;
      if (typeof entry.runtime === 'string') serverConfig.runtime = entry.runtime;
      if (typeof entry.binary === 'string' && entry.binary.trim()) serverConfig.binary = entry.binary.trim();
      if (typeof entry.package === 'string' && entry.package.trim()) serverConfig.package = entry.package.trim();
      if (typeof entry.uvPackage === 'string' && entry.uvPackage.trim()) serverConfig.uvPackage = entry.uvPackage.trim();
      if (typeof entry.args === 'string' && entry.args.trim()) serverConfig.args = entry.args.trim().split(/\s+/);
      if (Object.keys(serverConfig).length) result[serverId] = serverConfig;
    }
  }
  return result;
}

describe('System Feature Config v2', () => {
  const testDir = join(tmpdir(), 'agentdev-test-feature-config-v2');
  const configPath = join(testDir, 'feature-setup.json');

  if (existsSync(testDir)) rmSync(testDir, { recursive: true });

  describe('readSystemFeatureConfig', () => {
    it('returns empty object when file does not exist', () => {
      const result = readSystemFeatureConfig(join(testDir, 'nonexistent.json'));
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
      const result = readSystemFeatureConfig(configPath);
      assert.strictEqual(result.runtimes.nodejs, '/usr/local/bin/node');
      assert.strictEqual(result.lsp.typescript.mode, 'runtime');
      assert.strictEqual(result.lsp.gopls.binary, '/usr/local/bin/gopls');
    });

    it('returns empty object for malformed JSON', () => {
      writeFileSync(configPath, 'not json {{{');
      const result = readSystemFeatureConfig(configPath);
      assert.deepStrictEqual(result, {});
    });
  });

  describe('writeSystemFeatureConfig', () => {
    it('writes new config format and reads it back', () => {
      const subDir = join(testDir, 'sub', 'dir');
      const subPath = join(subDir, 'config.json');
      const config = {
        runtimes: { nodejs: 'C:\\node\\node.exe' },
        lsp: { pyright: { mode: 'runtime', runtime: 'uv' } },
      };
      writeSystemFeatureConfig(subPath, config);
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
