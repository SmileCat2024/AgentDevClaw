// server/routes/studio-feature-migration.js 的重绑定与幂等测试。
// AGENTDEV_DATA_DIR 必须在 import 被测模块前设置：session-access 的
// PREBUILT_WORKSPACES_ROOT 是模块加载时固化的常量（不读真实用户数据目录）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const DATA_ROOT = await fs.mkdtemp(path.join(tmpdir(), 'studio-migration-test-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const STUDIO_DIR = path.join(DATA_ROOT, 'workspaces', 'agent-studio');
const SESSIONS_DIR = path.join(STUDIO_DIR, 'sessions');

let runStudioFeatureMigration;

before(async () => {
  ({ runStudioFeatureMigration } = await import('../server/routes/studio-feature-migration.js'));
});

after(async () => {
  await fs.rm(DATA_ROOT, { recursive: true, force: true });
});

async function writeSessionIndex(sessions, revision = 1) {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SESSIONS_DIR, 'index.json'),
    JSON.stringify({ revision, activeSessionId: sessions[0]?.id || null, sessions }),
    'utf8',
  );
}

async function readSessionIndex() {
  return JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, 'index.json'), 'utf8'));
}

function studioRecord(id, extra = {}) {
  return {
    id,
    title: `Session ${id}`,
    openDirectory: '',
    archived: false,
    metadata: {},
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    ...extra,
  };
}

test('rebinds studioProjectId to the full feature set of the session directory', async () => {
  const directory = path.join(DATA_ROOT, 'demo-dir');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(STUDIO_DIR, { recursive: true });
  const records = [
    { id: 'feature-a', name: 'FeatureA', modulePath: 'dist/index.js', directory, status: 'implemented', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'feature-b', name: 'FeatureB', modulePath: 'dist/index.js', directory, status: 'verified', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
  ];
  await fs.writeFile(path.join(STUDIO_DIR, 'features.json'), JSON.stringify(records), 'utf8');
  await fs.writeFile(path.join(STUDIO_DIR, 'projects.json'), JSON.stringify([{ projectDir: directory }]), 'utf8');
  await writeSessionIndex([
    studioRecord('s-matched', {
      openDirectory: directory,
      metadata: { studioProjectId: 'legacy-project-1' },
    }),
    studioRecord('s-unmatched', {
      openDirectory: path.join(DATA_ROOT, 'gone-dir'),
      metadata: { studioProjectId: 'legacy-project-2' },
    }),
    studioRecord('s-clean', { openDirectory: directory }),
  ]);

  await runStudioFeatureMigration();

  const index = await readSessionIndex();
  const matched = index.sessions.find((s) => s.id === 's-matched');
  const unmatched = index.sessions.find((s) => s.id === 's-unmatched');
  const clean = index.sessions.find((s) => s.id === 's-clean');

  // 宁多绑不丢可见性：目录匹配的会话拿到该目录全部 feature id
  assert.deepEqual(matched.metadata.studioFeatureIds, ['feature-a', 'feature-b']);
  assert.equal(matched.metadata.studioProjectId, undefined);
  assert.equal(matched.studioProjectId, undefined);
  // 目录匹配不到 feature：绑定置空（由首页「最近的对话」兜底），旧字段同样清除
  assert.equal(unmatched.metadata.studioProjectId, undefined);
  assert.equal(unmatched.metadata.studioFeatureIds, undefined);
  // 无旧字段的记录不被触碰
  assert.deepEqual(clean.metadata, {});

  // projects.json 迁移收口后被删除
  await assert.rejects(fs.access(path.join(STUDIO_DIR, 'projects.json')));
});

test('migration is idempotent: a second run changes nothing', async () => {
  const beforeIndex = await readSessionIndex();
  await runStudioFeatureMigration();
  const afterIndex = await readSessionIndex();
  assert.equal(afterIndex.revision, beforeIndex.revision);
  assert.deepEqual(afterIndex.sessions, beforeIndex.sessions);
});
