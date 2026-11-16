import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_BUNDLE_AGENT_IDS,
  registerSessionBundleAgents,
  declareSessionBundleAgent,
  deriveSessionBundleAgentIds,
  registerSessionBundleAgentsFromScan,
  isSessionBundleAgent,
  resolveSessionStoreDir,
} from '../server/shared/session-storage.js';
import { runSessionStoreMigration } from '../server/shared/session-storage-migration.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_IDS = ['feature-creator', 'agent-creator', 'agent-studio', 'programming-helper', 'flow-workspace', 'coder'];

function restoreFallback() {
  registerSessionBundleAgents(FALLBACK_IDS);
}

test('兜底集合为声明化前的现役事实，未注册时判定不漂移', () => {
  restoreFallback();
  assert.deepEqual([...SESSION_BUNDLE_AGENT_IDS].sort(), [...FALLBACK_IDS].sort());
  assert.equal(isSessionBundleAgent('programming-helper'), true);
  assert.equal(isSessionBundleAgent('memo'), false);
  restoreFallback();
});

test('registerSessionBundleAgents 替换式幂等，空输入清空集合', () => {
  registerSessionBundleAgents(['memo']);
  registerSessionBundleAgents(['memo']);
  assert.deepEqual([...SESSION_BUNDLE_AGENT_IDS], ['memo']);
  registerSessionBundleAgents([]);
  assert.equal(SESSION_BUNDLE_AGENT_IDS.size, 0);
  restoreFallback();
});

test('declareSessionBundleAgent 单点增删，不影响其他成员', () => {
  restoreFallback();
  declareSessionBundleAgent('memo', true);
  assert.equal(isSessionBundleAgent('memo'), true);
  assert.equal(isSessionBundleAgent('programming-helper'), true);
  declareSessionBundleAgent('memo', false);
  assert.equal(isSessionBundleAgent('memo'), false);
  restoreFallback();
});

test('deriveSessionBundleAgentIds 按 sessionBundle 声明派生，enabled=false 排除', () => {
  const ids = deriveSessionBundleAgentIds([
    { id: 'memo', sessionBundle: true },
    { id: 'disabled-app', sessionBundle: true, enabled: false },
    { id: 'plain-app' },
    { sessionBundle: true }, // 无 id，跳过
    null,
  ]);
  assert.deepEqual(ids, ['memo']);
});

test('resolveSessionStoreDir 两路解析与 dataRoot 参数化', () => {
  restoreFallback();
  const dataRoot = join(tmpdir(), 'ssm-parameterized');
  // 未声明（且不在兜底集合）：旧位
  assert.equal(
    resolveSessionStoreDir('coding-app', dataRoot),
    join(dataRoot, 'prebuilt-sessions', 'coding-app'),
  );
  // 声明后：新位
  registerSessionBundleAgents(['coding-app']);
  assert.equal(
    resolveSessionStoreDir('coding-app', dataRoot),
    join(dataRoot, 'workspaces', 'coding-app', 'sessions'),
  );
  restoreFallback();
  assert.equal(
    resolveSessionStoreDir('portal-app', dataRoot),
    join(dataRoot, 'prebuilt-sessions', 'portal-app'),
  );
});

test('registerSessionBundleAgentsFromScan 扫出仓库内全部 sessionBundle 声明', () => {
  registerSessionBundleAgentsFromScan(join(REPO_ROOT, 'prebuilt-agents'));
  const ids = [...SESSION_BUNDLE_AGENT_IDS].sort();
  assert.deepEqual(ids, [...FALLBACK_IDS, 'memo'].sort());
  restoreFallback();
});

test('runSessionStoreMigration：归位、非名单保留、有文件保留、空壳清理、幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'ssm-test-'));
  try {
    mkdirSync(join(root, 'prebuilt-sessions', 'memo'), { recursive: true });
    writeFileSync(join(root, 'prebuilt-sessions', 'memo', 'session-1.json'), '{}');
    mkdirSync(join(root, 'prebuilt-sessions', 'qqbot'));
    writeFileSync(join(root, 'prebuilt-sessions', 'qqbot', 'session-2.json'), '{}');
    mkdirSync(join(root, 'prebuilt-sessions', 'home', 'sub'), { recursive: true });
    writeFileSync(join(root, 'prebuilt-sessions', 'home', 'sub', 'f.json'), '{}');
    mkdirSync(join(root, 'prebuilt-sessions', 'agent-1-123'));
    mkdirSync(join(root, 'prebuilt-sessions', 'agent-2-456'));

    const first = runSessionStoreMigration({ dataRoot: root, bundleAgentIds: ['memo'] });
    assert.deepEqual(first.relocated, ['memo']);
    assert.equal(first.cleanedEmptyDirs, 2);
    assert.equal(existsSync(join(root, 'workspaces', 'memo', 'sessions', 'session-1.json')), true);
    assert.equal(existsSync(join(root, 'prebuilt-sessions', 'qqbot', 'session-2.json')), true);
    assert.equal(existsSync(join(root, 'prebuilt-sessions', 'home', 'sub', 'f.json')), true);

    const second = runSessionStoreMigration({ dataRoot: root, bundleAgentIds: ['memo'] });
    assert.deepEqual(second.relocated, []);
    assert.equal(second.cleanedEmptyDirs, 0);
    assert.equal(second.conflicts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runSessionStoreMigration：新旧位置均有数据时冲突保留不合并', () => {
  const root = mkdtempSync(join(tmpdir(), 'ssm-conflict-'));
  try {
    mkdirSync(join(root, 'prebuilt-sessions', 'memo'), { recursive: true });
    writeFileSync(join(root, 'prebuilt-sessions', 'memo', 'old.json'), '{}');
    mkdirSync(join(root, 'workspaces', 'memo', 'sessions'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'memo', 'sessions', 'new.json'), '{}');

    const actions = runSessionStoreMigration({ dataRoot: root, bundleAgentIds: ['memo'] });
    assert.deepEqual(actions.relocated, []);
    assert.equal(actions.conflicts.length, 1);
    assert.equal(existsSync(join(root, 'prebuilt-sessions', 'memo', 'old.json')), true);
    assert.equal(existsSync(join(root, 'workspaces', 'memo', 'sessions', 'new.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runSessionStoreMigration：源缺失跳过（目标已就位的正常态）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ssm-clean-'));
  try {
    mkdirSync(join(root, 'workspaces', 'memo', 'sessions'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'memo', 'sessions', 'session.json'), '{}');
    const actions = runSessionStoreMigration({ dataRoot: root, bundleAgentIds: ['memo'] });
    assert.deepEqual(actions.relocated, []);
    assert.equal(actions.conflicts.length, 0);
    assert.equal(existsSync(join(root, 'workspaces', 'memo', 'sessions', 'session.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
