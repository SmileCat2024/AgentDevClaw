/**
 * claw-core provider 架构测试
 *
 * 测试范围：
 *   1. Provider 自动发现与加载
 *   2. 数据读取函数按 workspaceId 参数化（不再硬编码）
 *   3. dispatch 操作分发与必填参数校验
 *   4. createContext 上下文对象完整性
 *   5. 通用 helper 函数
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadProviders, listProviders, getProvider, getDefaultWorkspaceId,
  dispatch, createContext,
  cleanText, truncate, formatDate, readJson,
  getWorkspaceDir, getSessionsDir, getHandoffsDir,
  readSessionIndex, getExplorations, getSubs,
} from '../server/claw-core.mjs';
import { join } from 'path';
import { existsSync } from 'fs';
import os from 'os';

// ── 1. Provider 发现与加载 ─────────────────────────────────────

describe('Provider 发现与加载', () => {
  it('loadProviders 应自动发现 providers/ 目录下的 .mjs 文件', async () => {
    await loadProviders();
    const providers = listProviders();
    assert.ok(providers.length >= 1, '至少应有 1 个 provider');
  });

  it('应发现 programming-helper provider', async () => {
    await loadProviders();
    const ph = getProvider('programming-helper');
    assert.ok(ph, 'programming-helper provider 应存在');
    assert.strictEqual(ph.id, 'programming-helper');
    assert.ok(ph.name, 'provider 应有 name');
    assert.ok(ph.description, 'provider 应有 description');
  });

  it('每个 provider 应有 operations 数组且非空', async () => {
    await loadProviders();
    for (const p of listProviders()) {
      assert.ok(Array.isArray(p.operations), `${p.id} 的 operations 应为数组`);
      assert.ok(p.operations.length > 0, `${p.id} 的 operations 应非空`);
      for (const op of p.operations) {
        assert.ok(op.name, `${p.id} 的操作应有 name`);
        assert.ok(typeof op.execute === 'function', `${p.id}.${op.name} 的 execute 应为函数`);
      }
    }
  });

  it('getDefaultWorkspaceId 应返回第一个 provider 的 id', async () => {
    await loadProviders();
    const defaultId = getDefaultWorkspaceId();
    assert.ok(defaultId, '应有默认 workspace');
    assert.strictEqual(defaultId, 'programming-helper');
  });

  it('getProvider 对不存在的 id 应返回 null', () => {
    assert.strictEqual(getProvider('nonexistent-workspace'), null);
  });
});

// ── 2. 数据读取参数化 ──────────────────────────────────────────

describe('数据读取按 workspaceId 参数化', () => {
  it('getWorkspaceDir 应按 workspaceId 生成不同路径', () => {
    const dir1 = getWorkspaceDir('programming-helper');
    const dir2 = getWorkspaceDir('flow-workspace');
    assert.ok(dir1.includes('programming-helper'));
    assert.ok(dir2.includes('flow-workspace'));
    assert.notStrictEqual(dir1, dir2);
  });

  it('getSessionsDir 应包含 workspaceId', () => {
    const dir = getSessionsDir('programming-helper');
    assert.ok(dir.includes('programming-helper'));
    assert.ok(dir.includes('sessions'));
  });

  it('getHandoffsDir 应包含 workspaceId', () => {
    const dir = getHandoffsDir('programming-helper');
    assert.ok(dir.includes('programming-helper'));
    assert.ok(dir.includes('context-handoffs'));
  });

  it('路径应位于用户数据目录下', () => {
    const expectedRoot = join(os.homedir(), '.agentdev', 'AgentDevClaw');
    const dir = getWorkspaceDir('test-ws');
    assert.ok(dir.startsWith(expectedRoot), `路径 ${dir} 应在 ${expectedRoot} 下`);
  });

  it('readSessionIndex 对不存在的 workspace 应返回空结构', () => {
    const index = readSessionIndex('definitely-nonexistent-ws-12345');
    assert.ok(index, '应返回对象');
    assert.ok(Array.isArray(index.sessions), 'sessions 应为数组');
    assert.strictEqual(index.sessions.length, 0);
  });

  it('getExplorations 对不存在的 workspace 应返回空数组', () => {
    const exps = getExplorations('definitely-nonexistent-ws-12345');
    assert.ok(Array.isArray(exps));
    assert.strictEqual(exps.length, 0);
  });

  it('getSubs 对不存在的 workspace 应返回空数组', () => {
    const subs = getSubs('definitely-nonexistent-ws-12345');
    assert.ok(Array.isArray(subs));
    assert.strictEqual(subs.length, 0);
  });
});

// ── 3. dispatch 操作分发 ───────────────────────────────────────

describe('dispatch 操作分发', () => {
  it('对不存在的 workspace 应返回错误', async () => {
    await loadProviders();
    const { ok, error } = await dispatch('nonexistent', 'overview');
    assert.strictEqual(ok, false);
    assert.ok(error.includes('Unknown workspace'));
  });

  it('对不存在的操作应返回错误', async () => {
    await loadProviders();
    const { ok, error } = await dispatch('programming-helper', 'nonexistent-op');
    assert.strictEqual(ok, false);
    assert.ok(error.includes('Unknown operation'));
    assert.ok(error.includes('Available:'), '错误信息应列出可用操作');
  });

  it('缺少必填参数应返回错误', async () => {
    await loadProviders();
    const { ok, error } = await dispatch('programming-helper', 'show', {});
    assert.strictEqual(ok, false);
    assert.ok(error.includes('Missing required parameter'));
    assert.ok(error.includes('sessionId'));
  });

  it('overview 操作应成功执行', async () => {
    await loadProviders();
    const { ok, result } = await dispatch('programming-helper', 'overview');
    assert.strictEqual(ok, true);
    assert.ok(result, '应返回结果对象');
    assert.ok(typeof result.workingDirectory !== 'undefined', '应有 workingDirectory');
    assert.ok(typeof result.explorationCount !== 'undefined', '应有 explorationCount');
    assert.ok(typeof result.subAgentCount !== 'undefined', '应有 subAgentCount');
  });

  it('explorations 操作应成功执行', async () => {
    await loadProviders();
    const { ok, result } = await dispatch('programming-helper', 'explorations', { limit: 5 });
    assert.strictEqual(ok, true);
    assert.ok(result, '应返回结果');
    assert.ok(typeof result.total !== 'undefined', '应有 total');
    assert.ok(Array.isArray(result.records), 'records 应为数组');
    assert.ok(result.records.length <= 5, '不应超过 limit');
  });

  it('subs 操作应成功执行', async () => {
    await loadProviders();
    const { ok, result } = await dispatch('programming-helper', 'subs');
    assert.strictEqual(ok, true);
    assert.ok(result, '应返回结果');
    assert.ok(typeof result.total !== 'undefined', '应有 total');
    assert.ok(Array.isArray(result.records), 'records 应为数组');
  });

  it('show 对不存在的 session 应返回错误结果', async () => {
    await loadProviders();
    const { ok, result } = await dispatch('programming-helper', 'show', {
      sessionId: 'nonexistent-session-12345',
    });
    // dispatch 本身成功 (ok=true)，但 result 包含 error
    assert.strictEqual(ok, true);
    assert.ok(result.error, '结果应包含 error');
    assert.ok(result.error.includes('not found'), '错误信息应说明未找到');
  });
});

// ── 4. createContext 上下文完整性 ──────────────────────────────

describe('createContext 上下文对象', () => {
  it('应包含所有必需的数据读取方法', () => {
    const ctx = createContext('programming-helper');
    assert.strictEqual(ctx.workspaceId, 'programming-helper');
    assert.ok(typeof ctx.readWorkspaceState === 'function');
    assert.ok(typeof ctx.readSessionIndex === 'function');
    assert.ok(typeof ctx.getExplorations === 'function');
    assert.ok(typeof ctx.getSubs === 'function');
    assert.ok(typeof ctx.loadSessionDetail === 'function');
    assert.ok(typeof ctx.loadFinalOutput === 'function');
    assert.ok(typeof ctx.findHandoffSummary === 'function');
    assert.ok(typeof ctx.http === 'function');
    assert.ok(typeof ctx.execFileSync === 'function');
    assert.ok(typeof ctx.getSessionsDir === 'function');
    assert.ok(typeof ctx.getHandoffsDir === 'function');
    assert.ok(typeof ctx.projectRoot === 'string');
    assert.ok(typeof ctx.serverUrl === 'string');
  });

  it('readWorkspaceState 应返回对象', () => {
    const ctx = createContext('programming-helper');
    const state = ctx.readWorkspaceState();
    assert.ok(typeof state === 'object');
  });

  it('readSessionIndex 应返回正确的结构', () => {
    const ctx = createContext('programming-helper');
    const index = ctx.readSessionIndex();
    assert.ok(index);
    assert.ok(Array.isArray(index.sessions));
  });
});

// ── 5. 通用 helpers ────────────────────────────────────────────

describe('通用 helper 函数', () => {
  it('cleanText 应 trim 字符串', () => {
    assert.strictEqual(cleanText('  hello  '), 'hello');
    assert.strictEqual(cleanText(null), '');
    assert.strictEqual(cleanText(undefined), '');
    assert.strictEqual(cleanText(123), '');
  });

  it('truncate 应截断长文本', () => {
    const long = 'a'.repeat(200);
    const result = truncate(long, 50);
    assert.ok(result.length <= 50);
    assert.ok(result.endsWith('…'));
  });

  it('truncate 不应截断短文本', () => {
    assert.strictEqual(truncate('short', 50), 'short');
    assert.strictEqual(truncate('', 50), '');
    assert.strictEqual(truncate(null, 50), '');
  });

  it('formatDate 应格式化 ISO 日期', () => {
    const result = formatDate('2024-01-15T10:30:00Z');
    assert.ok(result, '应返回非空字符串');
    assert.ok(result.includes('2024') || result.includes('24'), '应包含年份');
  });

  it('formatDate 对空值应返回空字符串', () => {
    assert.strictEqual(formatDate(null), '');
    assert.strictEqual(formatDate(''), '');
  });

  it('readJson 对不存在的文件应返回 null', () => {
    assert.strictEqual(readJson('/definitely/nonexistent/path/file.json'), null);
  });
});

// ── 6. Provider 接口约定 ───────────────────────────────────────

describe('Provider 接口约定', () => {
  it('programming-helper provider 应有正确的操作集合', async () => {
    await loadProviders();
    const ph = getProvider('programming-helper');
    const opNames = ph.operations.map(op => op.name);
    
    // 核心操作必须存在
    const required = ['overview', 'explorations', 'subs', 'show', 'spawn', 'compact', 'resume'];
    for (const name of required) {
      assert.ok(opNames.includes(name), `应包含操作: ${name}`);
    }
  });

  it('每个操作的 params 应为数组且每个 param 有 name', async () => {
    await loadProviders();
    const ph = getProvider('programming-helper');
    for (const op of ph.operations) {
      if (op.params) {
        assert.ok(Array.isArray(op.params), `${op.name}.params 应为数组`);
        for (const p of op.params) {
          assert.ok(p.name, `${op.name} 的 param 应有 name`);
        }
      }
    }
  });

  it('有必填参数的操作应在缺少参数时被 dispatch 拦截', async () => {
    await loadProviders();
    // spawn 需要 goal
    const { ok, error } = await dispatch('programming-helper', 'spawn', {});
    assert.strictEqual(ok, false);
    assert.ok(error.includes('goal'));
  });
});
