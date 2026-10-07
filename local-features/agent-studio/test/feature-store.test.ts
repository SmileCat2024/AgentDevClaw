/**
 * 全局 Feature 注册表（features.json）+ schema ≤ 4 迁移测试（node:test 格式）
 *
 * Validates:
 * 1. registerFeatureRecord：新记录按包名/名建 id；同名重注册保留账本字段
 * 2. removeFeatureRecord：按 id 精确删除
 * 3. migrateLegacyRegistry：projects.json + 旧档案 → features.json + 档案就地升级 schema 5
 * 4. 幂等：注册表已有记录优先，不被旧档案数据覆盖
 * 5. 损坏条目跳过不阻断其余迁移
 * 6. deleteLegacyProjectsRegistry：迁移收口删除 legacy 注册表
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MANIFEST_FILE_NAME,
  LEGACY_REGISTRY_FILE_NAME,
  getFeatureRegistryPaths,
  readFeatureRegistry,
  writeFeatureRegistry,
  registerFeatureRecord,
  removeFeatureRecord,
  migrateLegacyRegistry,
  deleteLegacyProjectsRegistry,
  type StudioFeatureEntry,
} from '../src/index.js';

async function writeLegacyManifest(dir: string, features: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, MANIFEST_FILE_NAME), JSON.stringify({
    schemaVersion: 4,
    name: 'old-project',
    goal: '旧项目',
    targetAgent: '',
    features,
    toolchain: { source: 'custom', nodePath: '/tools/node', npmPath: '/tools/npm' },
    testRuntime: { status: 'stopped' },
    tests: [],
    createdAt: 't0',
    updatedAt: 't0',
  }));
}

const STANDARD_ENTRY: StudioFeatureEntry = {
  name: 'ticket-feature',
  modulePath: 'D:/somewhere/ticket-feature/dist/index.js',
  package: '@agentdevjs/ticket-feature',
  status: 'verified',
  verification: { lastVerifiedRunId: 'run-1', verifiedAt: 't1', coverage: { tools: ['ticket_list'], hooks: [], deniedTools: [] } },
  source: { kind: 'project', projectDir: 'D:/somewhere/ticket-feature', entry: 'D:/somewhere/ticket-feature/dist/index.js', buildCommand: ['npm', 'run', 'build'] },
};

describe('feature-store registry', () => {
  let base: string;
  let statePath: string;

  before(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'agent-studio-store-'));
    statePath = join(base, 'state.json');
  });

  after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('registerFeatureRecord creates an id from the package name and keeps the ledger on re-registration', async () => {
    const first = await registerFeatureRecord(statePath, STANDARD_ENTRY, join(base, 'dir-a'), '工单看板');
    assert.equal(first.id, '@agentdevjs/ticket-feature');
    assert.equal(first.directory, join(base, 'dir-a'));
    assert.equal(first.status, 'verified');

    // 同名重注册 = 移动目录：directory/描述更新，账本字段保留
    const moved = await registerFeatureRecord(
      statePath,
      { ...STANDARD_ENTRY, status: 'implemented' },
      join(base, 'dir-b'),
      '更新后的描述',
    );
    assert.equal(moved.directory, join(base, 'dir-b'));
    assert.equal(moved.status, 'verified');
    assert.equal(moved.verification?.lastVerifiedRunId, 'run-1');
    assert.equal(moved.description, '更新后的描述');

    const records = await readFeatureRegistry(statePath);
    assert.equal(records.length, 1);
    assert.equal(records[0].directory, join(base, 'dir-b'));
  });

  it('removeFeatureRecord removes strictly by id', async () => {
    await removeFeatureRecord(statePath, '@agentdevjs/ticket-feature');
    assert.deepEqual(await readFeatureRegistry(statePath), []);
  });
});

describe('feature-store migration', () => {
  let base: string;
  let statePath: string;

  before(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'agent-studio-migrate-'));
    statePath = join(base, 'state.json');
  });

  after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('converts legacy projects.json + schema-4 manifests into features.json and upgrades manifests in place', async () => {
    const dirA = join(base, 'dir-a');
    const dirB = join(base, 'dir-b');
    await writeLegacyManifest(dirA, [
      {
        name: 'ticket-feature',
        modulePath: join(dirA, 'ticket-feature', 'dist', 'index.js'),
        package: '@agentdevjs/ticket-feature',
        status: 'verified',
        verification: { lastVerifiedRunId: 'run-1', verifiedAt: 't1', coverage: { tools: ['ticket_list'], hooks: [], deniedTools: [] } },
        snapshot: { version: '1.0.0', archivePath: 'D:/repo/x.tgz', archiveDigest: 'sha256:abc', createdAt: 't2' },
      },
    ]);
    await writeLegacyManifest(dirB, [
      { name: 'legacy-module', modulePath: join(dirB, 'legacy.mjs'), status: 'mounted' },
    ]);
    const { legacyRegistryPath } = getFeatureRegistryPaths(statePath);
    await fs.mkdir(join(base), { recursive: true });
    await fs.writeFile(legacyRegistryPath, JSON.stringify([{ projectDir: dirA }, { projectDir: dirB }]));

    const result = await migrateLegacyRegistry(statePath);
    assert.equal(result.changed, true);
    assert.deepEqual(result.directories.sort(), [dirA, dirB].sort());
    assert.deepEqual(result.skipped, []);

    const records = await readFeatureRegistry(statePath);
    const ticket = records.find((record) => record.id === '@agentdevjs/ticket-feature');
    assert.ok(ticket, 'package-keyed record migrated');
    assert.equal(ticket.directory, dirA);
    assert.equal(ticket.status, 'verified');
    assert.equal(ticket.snapshot?.version, '1.0.0');
    const legacyModule = records.find((record) => record.id === 'legacy-module');
    assert.ok(legacyModule, 'name-keyed record for package-less module');
    assert.equal(legacyModule.status, 'mounted');

    // 档案就地升级 schema 5：工具链保留，features[]/项目字段剥离
    for (const dir of [dirA, dirB]) {
      const onDisk = JSON.parse(await fs.readFile(join(dir, MANIFEST_FILE_NAME), 'utf8')) as Record<string, unknown>;
      assert.equal(onDisk.schemaVersion, 5);
      assert.equal('features' in onDisk, false);
      assert.equal('name' in onDisk, false);
      assert.equal('goal' in onDisk, false);
      assert.deepEqual(onDisk.toolchain, { source: 'custom', nodePath: '/tools/node', npmPath: '/tools/npm' });
    }
    // legacy 注册表还在（删除由调用方在会话重绑定后执行）
    const legacyStillExists = await fs.access(legacyRegistryPath).then(() => true, () => false);
    assert.equal(legacyStillExists, true);
  });

  it('is idempotent: existing registry records win over stale legacy data', async () => {
    // 注册表推进过账本后，再喂同名旧档案：不得回退
    const records = await readFeatureRegistry(statePath);
    const advanced = records.map((record) => record.id === '@agentdevjs/ticket-feature'
      ? { ...record, status: 'snapshotted' as const }
      : record);
    await writeFeatureRegistry(statePath, advanced);

    // 重建一个仍旧 schema 4 的目录（模拟首次迁移中断遗漏），同名 feature 状态更旧
    const dirC = join(base, 'dir-c');
    await writeLegacyManifest(dirC, [
      { name: 'ticket-feature', modulePath: join(dirC, 'x.js'), package: '@agentdevjs/ticket-feature', status: 'implemented' },
    ]);
    const { legacyRegistryPath } = getFeatureRegistryPaths(statePath);
    await fs.writeFile(legacyRegistryPath, JSON.stringify([{ projectDir: dirC }]));

    const result = await migrateLegacyRegistry(statePath);
    assert.equal(result.changed, false, 'no new records written');
    const after = await readFeatureRegistry(statePath);
    const ticket = after.find((record) => record.id === '@agentdevjs/ticket-feature');
    assert.equal(ticket.status, 'snapshotted', 'registry record preserved');
    assert.equal(ticket.directory, (advanced.find((record) => record.id === '@agentdevjs/ticket-feature') as { directory: string }).directory);
  });

  it('skips unreadable directories without blocking the rest', async () => {
    const freshBase = await fs.mkdtemp(join(tmpdir(), 'agent-studio-migrate2-'));
    try {
      const freshState = join(freshBase, 'state.json');
      const goodDir = join(freshBase, 'good');
      const brokenDir = join(freshBase, 'does-not-exist');
      await writeLegacyManifest(goodDir, [{ name: 'good-feature', modulePath: join(goodDir, 'g.mjs'), status: 'implemented' }]);
      const { legacyRegistryPath } = getFeatureRegistryPaths(freshState);
      await fs.writeFile(legacyRegistryPath, JSON.stringify([{ projectDir: brokenDir }, { projectDir: goodDir }]));

      const result = await migrateLegacyRegistry(freshState);
      assert.equal(result.changed, true);
      assert.deepEqual(result.skipped, [brokenDir]);
      const records = await readFeatureRegistry(freshState);
      assert.deepEqual(records.map((record) => record.id), ['good-feature']);
    } finally {
      await fs.rm(freshBase, { recursive: true, force: true });
    }
  });

  it('deleteLegacyProjectsRegistry removes the legacy registry file', async () => {
    const { legacyRegistryPath, registryPath } = getFeatureRegistryPaths(statePath);
    await deleteLegacyProjectsRegistry(statePath);
    const legacyGone = await fs.access(legacyRegistryPath).then(() => false, () => true);
    assert.equal(legacyGone, true);
    const registryKept = await fs.access(registryPath).then(() => true, () => false);
    assert.equal(registryKept, true, 'features.json survives the cleanup');
    // 无 legacy 文件时删除是幂等的
    await deleteLegacyProjectsRegistry(statePath);
    // 再跑一次迁移：无 legacy 注册表 → changed=false
    const result = await migrateLegacyRegistry(statePath);
    assert.equal(result.changed, false);
    assert.deepEqual(result.directories, []);
  });
});
