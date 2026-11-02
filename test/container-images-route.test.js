/**
 * container-images 路由单测：注入 fake dockerode 与 fake git，覆盖域边界
 * （宿主 + host 同域子应用可见，域外不返回、不接受）、一致性三态判定、
 * 未构建成员呈现、使用中删除保护、越域删除/构建拒绝、构建可用性闸。
 * 名册经真实 discoverAgents 读 fixture 树（agentsRoot 注入），构建闸读
 * fixture repoRoot。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupContainerImagesRoutes } from '../server/routes/container-images.js';

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, ...stack) { routes.set(`POST ${path}`, stack[stack.length - 1]); },
  };
}

const fakeExpress = { json: () => (_req, _res, next) => next() };

function makeReq(body, query = {}) {
  return { body, query };
}

function makeRes() {
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      if (this.statusCode === null) this.statusCode = 200; // Express 默认 200
      this.payload = payload;
      return this;
    },
  };
  return res;
}

const HOST_COMMIT = 'abcd1234';
const fakeGitClean = async () => ({ stdout: '' });
const fakeGitHead = async () => ({ stdout: `${HOST_COMMIT}\n` });

function makeImage({ id, labels, tags, created = 1700_000_000 }) {
  return { Id: `sha256:${id}`, RepoTags: tags, Labels: labels, Created: created, Size: 1024 };
}

function makeContainer({ id, imageId, agentId, name }) {
  return {
    Id: `sha256:${id}`,
    Names: [`/${name}`],
    Labels: { 'claw-runtime': '1', 'claw-runtime-agent': agentId },
    ImageID: `sha256:${imageId}`,
    State: 'running',
    Created: 1700_000_100,
  };
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'claw-ci-route-'));
  const official = join(root, 'prebuilt-agents', 'official');
  // 名册：宿主 + host 同域子应用（coder）+ 域外顶层应用（memo）
  mkdirSync(join(official, 'programming-helper'), { recursive: true });
  writeFileSync(
    join(official, 'programming-helper', 'metadata.json'),
    // 宿主展示名取工作空间内 Agent 名（agents[0].displayName），不是工作空间名
    JSON.stringify({
      id: 'programming-helper',
      name: '智能编码空间',
      agents: [{ id: 'main', displayName: '编程小助手' }],
      defaultAgentId: 'main',
    }),
  );
  mkdirSync(join(official, 'coder'), { recursive: true });
  writeFileSync(
    join(official, 'coder', 'metadata.json'),
    JSON.stringify({ id: 'coder', displayName: 'Coder', host: 'programming-helper' }),
  );
  mkdirSync(join(official, 'memo'), { recursive: true });
  writeFileSync(
    join(official, 'memo', 'metadata.json'),
    JSON.stringify({ id: 'memo', displayName: 'Memo' }),
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claw', version: '0.2.3' }));
  return root;
}

test('overview: domain scoping, consistency states, unbuilt members, occupancy', async () => {
  const repoRoot = fixtureRepo();
  try {
    const images = [
      makeImage({
        id: 'a'.repeat(64),
        labels: { 'dev.claw.agent': 'programming-helper', 'org.opencontainers.image.revision': '0.2.3-abcd1234', 'org.opencontainers.image.version': '0.2.3' },
        tags: ['agentdev-claw-runtime:programming-helper', 'agentdev-claw-runtime:programming-helper-0.2.3-abcd1234'],
      }),
      makeImage({
        id: 'b'.repeat(64),
        labels: { 'dev.claw.agent': 'programming-helper', 'org.opencontainers.image.revision': '0.2.3-00000000', 'org.opencontainers.image.version': '0.2.3' },
        tags: ['agentdev-claw-runtime:programming-helper-0.2.3-00000000'],
        created: 1600_000_000,
      }),
      makeImage({
        id: 'c'.repeat(64),
        labels: { 'dev.claw.agent': 'programming-helper', 'org.opencontainers.image.revision': '0.2.3-abcd1234-dirty', 'org.opencontainers.image.version': '0.2.3' },
        tags: ['agentdev-claw-runtime:programming-helper-0.2.3-abcd1234-dirty'],
        created: 1500_000_000,
      }),
      // 域外应用镜像：不得进入本面板
      makeImage({
        id: 'f'.repeat(64),
        labels: { 'dev.claw.agent': 'memo', 'org.opencontainers.image.revision': '0.2.3-abcd1234', 'org.opencontainers.image.version': '0.2.3' },
        tags: ['agentdev-claw-runtime:memo'],
      }),
      // 无 label 且 tag 无法归属本域：跳过
      makeImage({ id: '9'.repeat(64), labels: {}, tags: ['agentdev-claw-runtime:memo-0.2.3-old'] }),
    ];
    const containers = [
      makeContainer({ id: 'd'.repeat(64), imageId: 'a'.repeat(64), agentId: 'programming-helper', name: 'claw-rt-programming-helper-s1' }),
      makeContainer({ id: 'e'.repeat(64), imageId: 'f'.repeat(64), agentId: 'memo', name: 'claw-rt-memo-s9' }),
    ];
    const app = fakeApp();
    setupContainerImagesRoutes(app, fakeExpress, {
      repoRoot,
      agentsRoot: repoRoot,
      dockerFactory: () => ({
        version: async () => ({ Version: '27.0', ApiVersion: '1.46' }),
        listImages: async () => images,
        listContainers: async () => containers,
        getImage: () => { throw new Error('not expected'); },
      }),
      execGit: async (args) => (args[0] === 'rev-parse' ? fakeGitHead() : fakeGitClean()),
    });

    const res = makeRes();
    // host is not an authorization input: forged query values must not widen the domain.
    await app.routes.get('GET /protoclaw/container_images/overview')(makeReq(null, { host: 'memo' }), res);
    assert.equal(res.statusCode, 200);
    const data = res.payload;
    assert.equal(data.docker.reachable, true);
    assert.equal(data.docker.version, '27.0');
    assert.equal(data.host.commit, HOST_COMMIT);
    assert.equal(data.host.dirty, false);
    assert.equal(data.buildAvailable, false, 'fixture 树无构建脚本 → 不可构建');

    // 域边界：仅宿主自己 + host 同域子应用；宿主第一
    assert.deepEqual(data.agents.map((a) => a.id), ['programming-helper', 'coder']);
    assert.equal(data.agents[0].hosted, false);
    // 展示名口径：宿主用 Agent 名，子应用用 id
    assert.equal(data.agents[0].name, '编程小助手', '宿主显示工作空间内 Agent 名');
    assert.equal(data.agents[1].name, 'coder', '子应用显示 id');
    assert.equal(data.agents[1].hosted, true, 'coder 是 host 声明的同域子应用');
    assert.equal(data.agents[1].images.length, 0, '未构建成员以空清单呈现');
    assert.equal(data.domainHost, 'programming-helper');

    const group = data.agents[0];
    assert.equal(group.images.length, 3, 'memo 与无法归属的镜像不进入清单');
    assert.deepEqual(
      group.images.map((i) => i.consistency.state),
      ['ok', 'stale', 'unknown'],
      '按构建时间降序：一致 / 过期（hash 不同）/ 不可判定（镜像 dirty）',
    );
    assert.equal(group.images[0].primary, true);

    // 容器同样按域过滤
    assert.equal(data.containers.length, 1);
    assert.equal(data.containers[0].agentId, 'programming-helper');
    assert.equal(data.containers[0].sessionId, 's1');
    assert.equal(data.containers[0].imageId, 'a'.repeat(12));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('delete: out-of-domain rejected, in-use rejected with occupant names, idle removed', async () => {
  const repoRoot = fixtureRepo();
  try {
    const removed = [];
    const containers = [
      makeContainer({ id: 'd'.repeat(64), imageId: 'a'.repeat(64), agentId: 'programming-helper', name: 'claw-rt-programming-helper-s2' }),
    ];
    const app = fakeApp();
    setupContainerImagesRoutes(app, fakeExpress, {
      repoRoot,
      agentsRoot: repoRoot,
      dockerFactory: () => ({
        listContainers: async () => containers,
        getImage: (ref) => ({
          // 按 ref 区分：被占用主镜像 / 空闲副 tag / 域外镜像（memo）
          inspect: async () => ({
            Id: `sha256:${(ref.includes('-old') ? 'e' : ref.includes('memo') ? 'f' : 'a').repeat(64)}`,
            Config: { Labels: { 'dev.claw.agent': ref.includes('memo') ? 'memo' : 'programming-helper' } },
            RepoTags: [ref],
          }),
          remove: async () => { removed.push(ref); },
        }),
      }),
      execGit: async (args) => (args[0] === 'rev-parse' ? fakeGitHead() : fakeGitClean()),
    });

    const foreign = makeRes();
    await app.routes.get('POST /protoclaw/container_images/delete')(
      makeReq({ host: 'memo', imageRef: 'agentdev-claw-runtime:memo' }),
      foreign,
    );
    assert.equal(foreign.statusCode, 403, '域外镜像删除拒绝');
    assert.equal(foreign.payload.error, 'image_not_in_domain');
    assert.equal(removed.length, 0);

    const busy = makeRes();
    await app.routes.get('POST /protoclaw/container_images/delete')(
      makeReq({ host: 'programming-helper', imageRef: 'sha256:aaaa' }),
      busy,
    );
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.payload.error, 'image_in_use');
    assert.deepEqual(busy.payload.containers, ['claw-rt-programming-helper-s2']);
    assert.equal(removed.length, 0);

    const idle = makeRes();
    await app.routes.get('POST /protoclaw/container_images/delete')(
      makeReq({ host: 'programming-helper', imageRef: 'agentdev-claw-runtime:programming-helper-0.2.3-old' }),
      idle,
    );
    assert.equal(idle.statusCode, 200);
    assert.deepEqual(removed, ['agentdev-claw-runtime:programming-helper-0.2.3-old']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('build: out-of-domain rejected before build gate, gated without script, agentId required', async () => {
  const repoRoot = fixtureRepo();
  try {
    const app = fakeApp();
    setupContainerImagesRoutes(app, fakeExpress, {
      repoRoot,
      agentsRoot: repoRoot,
      dockerFactory: () => { throw new Error('not expected'); },
      execGit: async (args) => (args[0] === 'rev-parse' ? fakeGitHead() : fakeGitClean()),
    });

    const noAgent = makeRes();
    await app.routes.get('POST /protoclaw/container_images/build')(
      makeReq({ host: 'programming-helper' }),
      noAgent,
    );
    assert.equal(noAgent.statusCode, 400);

    const foreign = makeRes();
    await app.routes.get('POST /protoclaw/container_images/build')(
      makeReq({ host: 'memo', agentId: 'memo' }),
      foreign,
    );
    assert.equal(foreign.statusCode, 403, '域外应用构建拒绝（先于构建闸）');
    assert.equal(foreign.payload.error, 'agent_not_in_domain');

    const gated = makeRes();
    await app.routes.get('POST /protoclaw/container_images/build')(
      makeReq({ host: 'programming-helper', agentId: 'coder' }),
      gated,
    );
    assert.equal(gated.statusCode, 403, 'fixture 树缺构建脚本 → 拒绝构建');
    assert.ok(String(gated.payload.error).includes('pack-container'),
      '构建闸错误指向缺失的构建脚本，而非域错误');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
