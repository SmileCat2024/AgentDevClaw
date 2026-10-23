/**
 * PH 独立项目存储与基本管理端点（ticket 041）
 *
 * 行为契约：
 * - projects.json 缺文件 = 空集合并且读取不落盘；损坏表读取抛错（500 语义），
 *   绝不静默当空再覆盖——create 在表损坏时必须失败且原文件字节不变
 * - 同一目录新建 A/B 得到两个稳定 ID（名称/目录不参与 ID 生成）；改名只动
 *   name/updatedAt，ID 与目录不变；重新读取仍存在
 * - external 项目复用目录解析（存在性 + Windows 大小写还原），不向外部目录
 *   写任何文件；managed 项目在数据根 ph-projects/<id>/ 创建专属目录
 * - 无 Session/runtime 副作用：不建 sessions/、不写 workspace state.json
 *
 * harness 参照 git-default-repo.test.js：AGENTDEV_DATA_DIR 隔离数据目录
 * （ph-projects.js 模块链在 import 时解析数据根），capture handler 直接调用。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-project-store-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const EXTERNAL_ROOTS = [];

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  for (const dir of EXTERNAL_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeExternalRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  EXTERNAL_ROOTS.push(dir);
  return dir;
}

const {
  setupPhProjectRoutes,
  readPhProjectStore,
  listPhProjects,
  createPhProject,
  getPhProjectStorePath,
  getPhManagedProjectDir,
} = await import('../server/routes/ph-projects.js');

function captureHandlers() {
  const handlers = {};
  setupPhProjectRoutes(
    {
      get: (routePath, handler) => { handlers[routePath] = handler; },
      post: (routePath, ...rest) => { handlers[routePath] = rest[rest.length - 1]; },
    },
    { json: () => (_req, _res, next) => next?.() },
  );
  return handlers;
}

function makeRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    error: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  };
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res, (error) => { res.error = error; });
  return res;
}

// 断言 handler 经 next(error) 抛出的业务错误码（express error middleware 语义）
function assertRouteError(res, statusCode, messagePart) {
  assert.ok(res.error, `expected route error, got payload: ${JSON.stringify(res.jsonPayload)}`);
  assert.equal(res.error.statusCode, statusCode);
  if (messagePart) assert.ok(res.error.message.includes(messagePart), `message "${res.error.message}" should include "${messagePart}"`);
}

function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('PH 独立项目路由（隔离数据根）', () => {
  const handlers = captureHandlers();
  const createHandler = handlers['/protoclaw/ph_project/project_create'];
  const renameHandler = handlers['/protoclaw/ph_project/project_rename'];
  const listHandler = handlers['/protoclaw/ph_project/projects'];
  const getHandler = handlers['/protoclaw/ph_project/project'];

  const externalRoot = makeExternalRoot('claw-ph-external-');
  const sharedDir = join(externalRoot, 'shared');
  mkdirSync(sharedDir);

  test('agentId 守卫：非 PH agentId 直接 400', async () => {
    for (const [handler, req] of [
      [listHandler, { query: { agentId: 'coder' } }],
      [getHandler, { query: { agentId: 'coder', projectId: 'prj_000000000000' } }],
      [createHandler, { body: { agentId: 'coder', name: 'X' } }],
      [renameHandler, { body: { agentId: 'coder', projectId: 'prj_000000000000', name: 'X' } }],
    ]) {
      const res = await call(handler, req);
      assertRouteError(res, 400, 'agentId is not supported');
    }
  });

  test('缺项目表时 list 返回空集合且不落盘、不触碰旧目录状态文件', async () => {
    const res = await call(listHandler, { query: {} });
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.ok, true);
    assert.deepStrictEqual(res.jsonPayload.projects, []);
    // 无项目表 = 尚无独立项目：读取不创建 projects.json，也不写 workspace state
    assert.equal(existsSync(getPhProjectStorePath()), false);
    assert.equal(existsSync(join(DATA_ROOT, 'workspaces', 'programming-helper', 'state.json')), false);
  });

  test('同一目录新建 A/B：两个稳定 ID、同 workDirectory、external 不向目录写文件', async () => {
    const before = listDir(sharedDir);

    const resA = await call(createHandler, { body: { name: 'Project A', workDirectory: sharedDir } });
    assert.equal(resA.statusCode, 200);
    const projectA = resA.jsonPayload.project;
    assert.match(projectA.id, /^prj_[0-9a-f]{12}$/);
    assert.equal(projectA.name, 'Project A');
    assert.equal(projectA.directorySource, 'external');
    assert.equal(projectA.archived, false);
    assert.equal(projectA.archivedAt, null);
    assert.ok(projectA.createdAt && projectA.updatedAt);

    const resB = await call(createHandler, { body: { name: 'Project B', workDirectory: sharedDir } });
    assert.equal(resB.statusCode, 200);
    const projectB = resB.jsonPayload.project;
    assert.notEqual(projectA.id, projectB.id);
    assert.equal(projectA.workDirectory, projectB.workDirectory);

    // external 目录零新增文件
    assert.deepStrictEqual(listDir(sharedDir), before);
  });

  test('托管项目：数据根 ph-projects/<id>/ 专属目录；无 Session / workspace state 副作用', async () => {
    const res = await call(createHandler, { body: { name: 'Managed 项目' } });
    assert.equal(res.statusCode, 200);
    const project = res.jsonPayload.project;
    assert.equal(project.directorySource, 'managed');
    assert.equal(project.workDirectory, getPhManagedProjectDir(project.id));
    assert.ok(statSync(project.workDirectory).isDirectory());

    // 无 Session 文件或 runtime 副作用：不建会话目录/索引，不写目录状态
    const phWorkspace = join(DATA_ROOT, 'workspaces', 'programming-helper');
    assert.equal(existsSync(join(phWorkspace, 'sessions')), false);
    assert.equal(existsSync(join(phWorkspace, 'state.json')), false);
  });

  test('get：按 ID 查询；非法 ID 400、未知 ID 404；目录缺失的项目不出表', async () => {
    const listRes = await call(listHandler, { query: {} });
    const first = listRes.jsonPayload.projects[0];

    const got = await call(getHandler, { query: { projectId: first.id } });
    assert.equal(got.statusCode, 200);
    assert.equal(got.jsonPayload.project.id, first.id);

    assertRouteError(await call(getHandler, { query: { projectId: 'dir:/foo' } }), 400, 'Invalid projectId');
    assertRouteError(await call(getHandler, { query: { projectId: 'prj_ffffffffffff' } }), 404, 'Unknown project');
    assertRouteError(await call(getHandler, { query: {} }), 400, 'projectId is required');

    // 存量项目引用暂时不存在的目录：记录保留，不做存在性过滤
    const store = await readPhProjectStore();
    store.projects.push({
      id: 'prj_0123456789ab',
      name: 'Ghost Dir',
      workDirectory: join(externalRoot, 'deleted-dir'),
      directorySource: 'external',
      archived: false,
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      archivedAt: null,
    });
    writeFileSync(getPhProjectStorePath(), JSON.stringify(store, null, 2), 'utf8');
    const ghost = await call(getHandler, { query: { projectId: 'prj_0123456789ab' } });
    assert.equal(ghost.statusCode, 200);
    assert.equal(ghost.jsonPayload.project.name, 'Ghost Dir');
  });

  test('改名：ID 与目录不变；重新读取仍存在；非法/未知 ID 400/404', async () => {
    const listRes = await call(listHandler, { query: {} });
    const target = listRes.jsonPayload.projects.find((p) => p.name === 'Project A');
    assert.ok(target, 'Project A should exist');

    const res = await call(renameHandler, { body: { projectId: target.id, name: 'Project A 改名' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonPayload.project.id, target.id);
    assert.equal(res.jsonPayload.project.name, 'Project A 改名');
    assert.equal(res.jsonPayload.project.workDirectory, target.workDirectory);

    const reread = await call(getHandler, { query: { projectId: target.id } });
    assert.equal(reread.jsonPayload.project.name, 'Project A 改名');
    assert.equal(reread.jsonPayload.project.id, target.id);

    assertRouteError(await call(renameHandler, { body: { projectId: 'nope', name: 'X' } }), 400, 'Invalid projectId');
    assertRouteError(await call(renameHandler, { body: { projectId: 'prj_ffffffffffff', name: 'X' } }), 404, 'Unknown project');
    assertRouteError(await call(renameHandler, { body: { projectId: target.id, name: '   ' } }), 400, 'name is required');
  });

  test('create 入参校验：缺 name 400；外部目录不存在 400；表文件 schemaVersion=1', async () => {
    assertRouteError(await call(createHandler, { body: { workDirectory: sharedDir } }), 400, 'name is required');
    assertRouteError(
      await call(createHandler, { body: { name: 'X', workDirectory: join(externalRoot, 'missing') } }),
      400,
      'does not exist',
    );

    const raw = JSON.parse(readFileSync(getPhProjectStorePath(), 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.ok(Array.isArray(raw.projects) && raw.projects.length >= 3);
  });
});

describe('项目表损坏防护', () => {
  test('损坏 JSON：list 报错且不把表当空；create 失败且不覆盖原文件字节', async () => {
    const corrupt = '{ "schemaVersion": 1, "projects": [ NOT JSON';
    writeFileSync(getPhProjectStorePath(), corrupt, 'utf8');

    const handlers = captureHandlers();
    const listRes = await call(handlers['/protoclaw/ph_project/projects'], { query: {} });
    assertRouteError(listRes, 500, 'corrupted');

    const createRes = await call(handlers['/protoclaw/ph_project/project_create'], { body: { name: 'X' } });
    assertRouteError(createRes, 500, 'corrupted');
    assert.equal(readFileSync(getPhProjectStorePath(), 'utf8'), corrupt, '损坏表不得被覆盖');
  });

  test('结构损坏（projects 非数组 / 记录缺字段 / schemaVersion 不支持）一律 500', async () => {
    const handlers = captureHandlers();
    const cases = [
      { schemaVersion: 1, projects: {} },
      { schemaVersion: 1, projects: [{ id: 'not-prj', name: 'x', workDirectory: '/x', directorySource: 'external', archived: false }] },
      { schemaVersion: 1, projects: [{ id: 'prj_0123456789ab', name: '', workDirectory: '/x', directorySource: 'external', archived: false }] },
      { schemaVersion: 2, projects: [] },
      ['not', 'an', 'object'],
    ];
    for (const payload of cases) {
      writeFileSync(getPhProjectStorePath(), JSON.stringify(payload), 'utf8');
      const res = await call(handlers['/protoclaw/ph_project/projects'], { query: {} });
      assertRouteError(res, 500, 'corrupted');
      await assert.rejects(() => listPhProjects(), /corrupted/);
    }
  });
});

describe('存储函数直调语义', () => {
  test('getPhProject/createPhProject 的错误对象带 statusCode；workDirectory 去空白', async () => {
    // 重建干净表（上一组测试留下损坏文件）
    writeFileSync(getPhProjectStorePath(), JSON.stringify({ schemaVersion: 1, projects: [] }), 'utf8');

    const dir = makeExternalRoot('claw-ph-external-2-');
    const created = await createPhProject({ name: 'Trim', workDirectory: `  ${dir}  ` });
    // Windows realpath 会还原真实大小写，比较按大小写/分隔符归一
    assert.equal(
      created.workDirectory.replace(/\\/g, '/').toLowerCase(),
      dir.replace(/\\/g, '/').toLowerCase(),
      '外部目录去空白后解析',
    );

    await assert.rejects(() => createPhProject({ workDirectory: dir }), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /name is required/);
      return true;
    });
  });
});
