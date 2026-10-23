/**
 * PH 项目级 Feature 配置读写与实例隔离（ticket 043）
 *
 * 行为契约（docs/tickets/043 + 2026-10-22-ph-project-coexistence.md）：
 * - 两条正式配置链并存：目录会话 [global → agent → dir → session]，项目会话
 *   [global → agent → project → session]；项目层按项目 ID 寻址
 *   （project-<id>.json），不继承同路径目录配置，目录配置不因同路径有项目
 *   改变效果；global/agent 继承与覆盖规则不变。
 * - resolved 查询 / resolveWriteTarget 写回定位经真实项目校验：非法 ID 400、
 *   未知项目 404、dir 与 projectId 互斥 400；PUT 保存后重新 resolved 一致。
 * - $mount 项目层维持拒绝：PUT 校验（project: 前缀）与运行时装配提取
 *   （extractFeatureMounts 层角色白名单）两个入口都不能绕过；agent 层装配
 *   能力不变。
 * - 运行时队列唯一实现在 PH agent.js 的 assemblePhFeatureConfig（构造期按
 *   逐实例 projectId 组装，无进程级缓存）；真实共享进程隔离见
 *   ph-project-feature-config-runtime.test.js。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR 先于 import 设置），无真实模型请求。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-project-feature-config-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const EXTERNAL_ROOTS = [];

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  for (const dir of EXTERNAL_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeExternalDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  EXTERNAL_ROOTS.push(dir);
  return dir;
}

function writeLayer(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
}

// 先设 env 再 import：层路径常量与项目表在 import 时解析数据根
const { createPhProject } = await import('../server/routes/ph-projects.js');
const {
  buildScopeLayers,
  resolveScopeConfig,
  resolveWriteTarget,
  validateLayerContent,
  setupFeatureConfigRoutes,
} = await import('../server/routes/feature-config.js');
const {
  GLOBAL_LAYER_PATH,
  agentLayerPath,
  dirLayerPath,
  projectLayerPath,
  encodeProjectConfigFile,
  readProjectLayer,
} = await import('../server/shared/feature-config-layers.js');
const { assemblePhFeatureConfig } = await import('../prebuilt-agents/official/programming-helper/agent.js');

// ── 场景夹具：D 目录 + 同路径 A/B 项目（coexistence 形态） ────────────────

let dirD;
let projectA;
let projectB;

/** 规范层内容基线（各测试按需覆写后由需要者重置）。 */
function resetLayers() {
  writeLayer(GLOBAL_LAYER_PATH, { probe: { value: 'g-v' }, skill: { extraDirs: ['/global-skills'] } });
  writeLayer(agentLayerPath('programming-helper'), { probe: { value: 'a-v' } });
  writeLayer(dirLayerPath(dirD, 'programming-helper'), { probe: { value: 'd-v' } });
  writeLayer(projectLayerPath(projectA.id, 'programming-helper'), {
    probe: { value: 'pa-v' },
    skill: { extraDirs: ['/a-skills'] },
  });
  writeLayer(projectLayerPath(projectB.id, 'programming-helper'), { probe: { value: 'pb-v' } });
}

before(async () => {
  dirD = makeExternalDir('claw-ph-fc-dirD-');
  projectA = await createPhProject({ name: 'A', workDirectory: dirD });
  projectB = await createPhProject({ name: 'B', workDirectory: dirD });
  resetLayers();
});

// ── 1. 项目层文件定位 ────────────────────────────────────────────────────

describe('043 项目层文件定位', () => {
  test('projectLayerPath 按项目 ID 寻址（PH feature-config 目录，project-<id>.json）', () => {
    const projectId = 'prj_aaaaaaaaaaaa';
    assert.equal(encodeProjectConfigFile(projectId), `project-${projectId}.json`);
    const path = projectLayerPath(projectId, 'programming-helper');
    assert.ok(path.endsWith(join('workspaces', 'programming-helper', 'feature-config', `project-${projectId}.json`)));
    // 文件不存在 = 空层（正常态）
    assert.deepEqual(readProjectLayer(projectId, 'programming-helper'), {});
  });

  test('非法 projectId（含路径穿越）在文件名编码处拒绝', () => {
    for (const bad of ['', 'x', '../evil', 'prj_ABCDEFGHIJKL', 'prj_aaaaaaaaaaa']) {
      assert.throws(() => encodeProjectConfigFile(bad), /Invalid projectId/, `bad id: ${JSON.stringify(bad)}`);
    }
  });
});

// ── 2. server 队列：resolved / 写回定位 / 无效 scope ─────────────────────

describe('043 server 配置队列（真实 PH resolver）', () => {
  test('项目链 [global, agent, project:<id>]；目录链与无参链不变', () => {
    const project = buildScopeLayers({ agentId: 'programming-helper', projectId: projectA.id });
    assert.deepEqual(project.layers.map((l) => l.id), ['global', 'agent', `project:${projectA.id}`]);
    assert.equal(project.layers[2].label, 'A');
    assert.ok(project.layers[2].path.endsWith(`project-${projectA.id}.json`));

    const dirChain = buildScopeLayers({ agentId: 'programming-helper', dir: dirD });
    assert.deepEqual(dirChain.layers.map((l) => l.id), ['global', 'agent', `dir:${dirD}`]);

    const bare = buildScopeLayers({ agentId: 'programming-helper' });
    assert.deepEqual(bare.layers.map((l) => l.id), ['global', 'agent']);
  });

  test('无效项目 scope 明确失败：非法 ID / 未知项目 / dir 与 projectId 互斥', () => {
    assert.throws(
      () => buildScopeLayers({ agentId: 'programming-helper', projectId: 'dir:/not-a-project' }),
      /Invalid projectId/,
    );
    assert.throws(
      () => buildScopeLayers({ agentId: 'programming-helper', projectId: 'prj_ffffffffffff' }),
      /Unknown project/,
    );
    assert.throws(
      () => buildScopeLayers({ agentId: 'programming-helper', dir: dirD, projectId: projectA.id }),
      /互斥的归属参数/,
    );
  });

  test('resolved：D/A/B 各得其值，provenance 指向正确层；与运行时装配 merged 一致', () => {
    const dResolved = resolveScopeConfig({ agentId: 'programming-helper', dir: dirD });
    assert.equal(dResolved.merged.probe.value, 'd-v');

    const aResolved = resolveScopeConfig({ agentId: 'programming-helper', projectId: projectA.id });
    assert.equal(aResolved.merged.probe.value, 'pa-v');
    assert.equal(aResolved.provenance['probe.value'].sourceIndex, 2);

    const bResolved = resolveScopeConfig({ agentId: 'programming-helper', projectId: projectB.id });
    assert.equal(bResolved.merged.probe.value, 'pb-v');

    // 项目层不写 probe 字段时继承 agent 层（写 B 层为空后回落 'a-v'）
    writeLayer(projectLayerPath(projectB.id, 'programming-helper'), {});
    const bFallback = resolveScopeConfig({ agentId: 'programming-helper', projectId: projectB.id });
    assert.equal(bFallback.merged.probe.value, 'a-v');
    assert.equal(bFallback.provenance['probe.value'].sourceIndex, 1);
    resetLayers();

    // resolved 与 agent 侧构造期 merged 同源一致（UI 预览 = 运行时生效）
    const aRuntime = assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD });
    assert.equal(aRuntime.merged.probe.value, aResolved.merged.probe.value);
  });

  test('PUT 写回定位：project:<id> → 项目层文件；往返后 resolved 一致且不污染目录层', () => {
    assert.equal(
      resolveWriteTarget({ agentId: 'programming-helper', layerId: `project:${projectA.id}` }),
      projectLayerPath(projectA.id, 'programming-helper'),
    );

    const content = { probe: { value: 'pa2-v' }, skill: { extraDirs: ['/a2-skills'] } };
    writeFileSync(projectLayerPath(projectA.id, 'programming-helper'), JSON.stringify(content, null, 2), 'utf8');

    const after = resolveScopeConfig({ agentId: 'programming-helper', projectId: projectA.id });
    assert.equal(after.merged.probe.value, 'pa2-v');
    assert.deepEqual(after.merged.skill.extraDirs, ['/global-skills', '/a2-skills']);
    // 目录会话不受项目层写回影响（项目配置不写 dir 文件、不同路径文件）
    assert.equal(resolveScopeConfig({ agentId: 'programming-helper', dir: dirD }).merged.probe.value, 'd-v');
    assert.equal(
      assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD }).merged.probe.value,
      'pa2-v',
    );
    resetLayers();
  });

  test('PUT 写回对未知项目 layerId 失败（不得凭空创建项目层）', () => {
    assert.throws(
      () => resolveWriteTarget({ agentId: 'programming-helper', layerId: 'project:prj_ffffffffffff' }),
      /Unknown project/,
    );
    assert.throws(
      () => resolveWriteTarget({ agentId: 'programming-helper', layerId: 'project:not-an-id' }),
      /Invalid projectId/,
    );
  });
});

// ── 3. 运行时队列（assemblePhFeatureConfig 唯一实现） ────────────────────

describe('043 运行时配置队列：D/A/B 隔离与继承', () => {
  test('目录会话读目录层；项目会话读项目层且不进目录层（同路径不继承）', () => {
    const d = assemblePhFeatureConfig({ workspaceDir: dirD });
    assert.deepEqual(d.layerIds, ['global', 'agent', 'dir', 'session']);
    assert.equal(d.merged.probe.value, 'd-v');

    const a = assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD });
    assert.deepEqual(a.layerIds, ['global', 'agent', 'project', 'session']);
    assert.equal(a.merged.probe.value, 'pa-v');

    const b = assemblePhFeatureConfig({ projectId: projectB.id, workspaceDir: dirD });
    assert.equal(b.merged.probe.value, 'pb-v');
  });

  test('项目层缺字段继承 agent/全局层；会话注入最后生效', () => {
    writeLayer(projectLayerPath(projectA.id, 'programming-helper'), {});
    const a = assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD });
    assert.equal(a.merged.probe.value, 'a-v');
    assert.deepEqual(a.merged.skill.extraDirs, ['/global-skills']);

    const withSession = assemblePhFeatureConfig({
      projectId: projectA.id,
      workspaceDir: dirD,
      sessionConfig: { probe: { value: 's-v' } },
    });
    assert.equal(withSession.merged.probe.value, 's-v');
    resetLayers();
  });

  test('累加型字段跨层叠加契约在项目链同样成立（skill.extraDirs 并集去重）', () => {
    const a = assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD });
    assert.deepEqual(a.merged.skill.extraDirs, ['/global-skills', '/a-skills']);
    const b = assemblePhFeatureConfig({ projectId: projectB.id, workspaceDir: dirD });
    assert.deepEqual(b.merged.skill.extraDirs, ['/global-skills']);
  });

  test('手写层文件含 null：merge 出 null-removed 警示并按删除语义生效（项目链契约一致）', () => {
    writeLayer(projectLayerPath(projectA.id, 'programming-helper'), { probe: { value: null } });
    const result = resolveScopeConfig({ agentId: 'programming-helper', projectId: projectA.id });
    const warning = result.warnings.find((w) => w.kind === 'null-removed' && w.fieldPath === 'probe.value');
    assert.ok(warning);
    // null 是 merge 的删除语义（PUT 校验因此拒 null；手写文件按框架契约删除字段）
    assert.equal(result.merged.probe?.value, undefined);
    resetLayers();
  });
});

// ── 4. $mount 双入口拒绝（装配是 agent 身份级配置） ──────────────────────

describe('043 $mount 项目层拒绝', () => {
  test('PUT 校验：project: 前缀与 dir: 前缀同样拒绝 $mount', () => {
    const content = { 'some-feature': { $mount: { kind: 'builtin' } } };
    assert.match(
      validateLayerContent(content, { layerId: `project:${projectA.id}` }),
      /不支持 \$mount 装配声明/,
    );
    assert.match(
      validateLayerContent(content, { layerId: `dir:${dirD}` }),
      /不支持 \$mount 装配声明/,
    );
    // agent 层校验其结构（装配能力不变）
    assert.equal(validateLayerContent(content, { layerId: 'agent' }), null);
  });

  test('运行时提取：项目层声明 $mount 直接抛错（不能带着非法装配事实启动）', () => {
    writeLayer(projectLayerPath(projectA.id, 'programming-helper'), {
      'some-feature': { $mount: { kind: 'builtin' } },
    });
    assert.throws(
      () => assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD }),
      /层 'project' 不允许声明 \$mount/,
    );
    resetLayers();
  });

  test('运行时提取：agent 层 $mount 仍生效（装配能力不变回归）', () => {
    writeLayer(agentLayerPath('programming-helper'), {
      'some-feature': { $mount: { kind: 'builtin' } },
    });
    const { mounts } = assemblePhFeatureConfig({ projectId: projectA.id, workspaceDir: dirD });
    assert.equal(mounts.get('some-feature')?.kind, 'builtin');
    resetLayers();
  });
});

// ── 5. 路由层错误映射 ────────────────────────────────────────────────────

describe('043 路由错误映射', () => {
  function captureRoutes() {
    const handlers = {};
    const app = {
      get: (p, h) => { handlers[`GET ${p}`] = h; },
      put: (p, ...rest) => { handlers[`PUT ${p}`] = rest[rest.length - 1]; },
    };
    setupFeatureConfigRoutes(app, { json: () => (_req, _res, next) => next?.() });
    return handlers;
  }

  function makeRes() {
    return {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; },
    };
  }

  test('resolved：非法 projectId 400 / 未知项目 404 / dir+projectId 400', async () => {
    const handlers = captureRoutes();
    const cases = [
      [{ agentId: 'programming-helper', projectId: 'dir:/bad' }, 400, /Invalid projectId/],
      [{ agentId: 'programming-helper', projectId: 'prj_ffffffffffff' }, 404, /Unknown project/],
      [{ agentId: 'programming-helper', dir: dirD, projectId: projectA.id }, 400, /互斥/],
    ];
    for (const [query, code, pattern] of cases) {
      const res = makeRes();
      await handlers['GET /protoclaw/feature_config/resolved']({ query }, res);
      assert.equal(res.statusCode, code, JSON.stringify(query));
      assert.match(res.payload.error, pattern);
    }
    // 合法项目查询正常返回
    const ok = makeRes();
    await handlers['GET /protoclaw/feature_config/resolved'](
      { query: { agentId: 'programming-helper', projectId: projectA.id } }, ok,
    );
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.payload.merged.probe.value, 'pa-v');
  });

  test('PUT：未知项目 layerId 404，不落任何文件', async () => {
    const handlers = captureRoutes();
    const res = makeRes();
    await handlers['PUT /protoclaw/feature_config/layer'](
      { body: { agentId: 'programming-helper', layerId: 'project:prj_ffffffffffff', content: { probe: { value: 'x' } } } },
      res,
    );
    assert.equal(res.statusCode, 404);
    assert.match(res.payload.error, /Unknown project/);
  });
});

// ── 6. 旧目录回归（项目层存在不改变目录链行为） ──────────────────────────

describe('043 旧目录回归', () => {
  test('目录链层结构与取值不受同路径项目影响（042 之前语义）', () => {
    // dirD 上同时存在 A/B 两个项目（before 夹具），目录 resolved 不携带项目层
    const { layers, queue } = buildScopeLayers({ agentId: 'programming-helper', dir: dirD });
    assert.equal(layers.length, 3);
    assert.ok(layers.every((layer) => !layer.id.startsWith('project:')));
    const { merged } = assemblePhFeatureConfig({ workspaceDir: dirD });
    assert.equal(merged.probe.value, 'd-v');
    assert.equal(queue.length, 3);
    assert.equal(basename(layers[2].path).startsWith('dir-'), true);
  });
});
