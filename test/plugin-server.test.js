/**
 * 插件数据面（server 面）挂载器测试（ADR-0045 P2）
 *
 * 覆盖真实链路：tgz（manifest server 声明 + server/ 面）→ extractServerAssets
 * 解出（ESM 标记）→ buildPluginServerMounts（装配过滤 / prefix 校验 /
 * entry 防穿越 / 未解出跳过）→ mountPluginServerRoutes（真 Express app +
 * 随机端口 HTTP 验证：路由可达、getConfig 读层文件、前缀冲突拒绝、
 * registerRoutes 形状校验、连续异常熔断、unmount/remount 重建）。
 * 不读真实用户数据目录；全部 fixture 在临时目录构造。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import http from 'node:http';
import crypto from 'crypto';
import express from 'express';

import { setupFeatureStoreRoutes } from '../server/routes/feature-store.js';
import { setupFeatureConfigRoutes } from '../server/routes/feature-config.js';
import { validatePluginSettingsWrite } from '../server/feature-runtime/plugin-settings-context.js';
import { extractServerAssets, versionServerDir } from '../server/feature-runtime/feature-assets.js';
import {
  buildPluginServerMounts,
  mountPluginServerRoutes,
  unmountPluginServerRoutes,
  remountPluginServerRoutes,
} from '../server/feature-runtime/plugin-server.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-server-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── fixture ────────────────────────────────────────────────────────

function makeServerPluginTgz({
  packageName = 'srv-demo',
  version = '1.0.0',
  prefix = 'srv-demo',
  entry = 'index.js',
  manifest = {},
  serverCode = `
export default {
  registerRoutes(router, context) {
    router.get('/status', (req, res) => {
      res.json({ ok: true, vault: (context.getConfig() || {}).vaultPath || null });
    });
  },
};
`,
} = {}) {
  const src = join(root, 'pack-src');
  const pkgDir = join(src, 'package');
  mkdirSync(join(pkgDir, 'server'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: packageName, version }),
  );
  writeFileSync(
    join(pkgDir, 'agentdev-feature.json'),
    JSON.stringify({ schemaVersion: 3, id: packageName, entry: 'dist/index.js', server: { entry, prefix }, ...manifest }),
  );
  writeFileSync(join(pkgDir, 'server', 'index.js'), serverCode);
  const archivePath = join(root, `${packageName.replace(/[/\\]/g, '!')}-${version}.tgz`);
  execFileSync('tar', ['-czf', pathRelative(root, archivePath), '-C', pathRelative(root, src), 'package'], { cwd: root });
  const digest = `sha256:${crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')}`;
  return { archivePath, digest, packageName, version };
}

/**
 * 身份层 fixture：agent 层与 global 层各一份文件（与生产 scope 层清单一致，
 * global 是公共首层）。globalLayerSparse 缺省为空（无全局级装配）。
 */
function makeResolvers(agentLayerSparse, globalLayerSparse) {
  const resolvers = new Map();
  const globalFile = join(root, 'layer-global.json');
  writeFileSync(globalFile, JSON.stringify(globalLayerSparse || {}, null, 2));
  const file = join(root, 'layer-agent.json');
  writeFileSync(file, JSON.stringify(agentLayerSparse, null, 2));
  resolvers.set('programming-helper', () => ({
    layers: [
      { id: 'global', label: '全局', path: globalFile },
      { id: 'agent', label: 'agent', path: file },
    ],
  }));
  return resolvers;
}

const mountedLayer = (pkg, version, vaultPath) => ({
  [pkg]: { $mount: { package: pkg, version }, ...(vaultPath ? { vaultPath } : {}) },
});

/** 真实 Express app + 随机端口 server，返回 { app, listen(), close() }。 */
function makeHttpApp() {
  const app = express();
  const server = http.createServer(app);
  return {
    app,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

it('统一设置按当前会话归属读取，拒绝错误制品或未装配空间', async () => {
  const fixture = makeServerPluginTgz({
    manifest: { pluginSettings: { fields: {
      library: { schema: { type: 'string' }, exposeToUi: true },
      privateValue: { schema: { type: 'string', default: 'server only' } },
    } } },
    serverCode: `export function registerRoutes(router, context) {
      router.get('/status', (req, res) => res.json(context.getConfig(req)));
    }`,
  });
  const key = '$plugin:srv-demo';
  const resolvers = makeResolvers({ ...mountedLayer('srv-demo', '1.0.0'), [key]: { library: 'workspace' } });
  const workspace = resolvers.get('programming-helper');
  const coderFile = join(root, 'coder.json');
  writeFileSync(coderFile, JSON.stringify({ ...mountedLayer('srv-demo', '1.0.0'), [key]: { library: 'coder' } }));
  resolvers.set('coder', () => ({ layers: [{ id: 'agent', path: coderFile }] }));
  resolvers.set('programming-helper', ({ projectId, dir } = {}) => ({ layers: [
    ...workspace().layers,
    ...(projectId || dir ? [{ id: projectId ? 'project:p' : 'dir:d', path: join(root, projectId ? 'p.json' : 'd.json') }] : []),
  ] }));
  writeFileSync(join(root, 'p.json'), JSON.stringify({ [key]: { library: 'project' } }));
  writeFileSync(join(root, 'd.json'), JSON.stringify({ [key]: { library: 'directory' } }));
  const options = {
    catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
    resolvers, serverRoot: join(root, 'server-env'),
    findSession: async (_agent, id) => ({ p: { projectId: 'p', openDirectory: '/same' }, d: { openDirectory: '/same' } })[id],
  };
  const httpApp = makeHttpApp();
  setupFeatureStoreRoutes(httpApp.app, express, options);
  setupFeatureConfigRoutes(httpApp.app, express, {
    resolvers, validatePluginSettingsWrite: (input) => validatePluginSettingsWrite(input, options),
  });
  const result = await mountPluginServerRoutes(httpApp.app, options);
  assert.equal(result.mounted.length, 1);
  const port = await httpApp.listen();
  try {
    const request = (overrides = {}) => fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/status?${new URLSearchParams({ agentId: 'programming-helper', digest: fixture.digest, ...overrides })}`);
    for (const [id, expected] of [['', 'workspace'], ['p', 'project'], ['d', 'directory']]) {
      const response = await request(id ? { sessionId: id } : {});
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { library: expected, privateValue: 'server only' });
    }
    const browserQuery = new URLSearchParams({ packageName: 'srv-demo', agentId: 'programming-helper', sessionId: 'p', digest: fixture.digest });
    const browserResponse = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin_settings?${browserQuery}`);
    assert.equal(browserResponse.status, 200);
    assert.deepEqual(await browserResponse.json(), { settings: { library: 'project' } });
    assert.equal((await request({ digest: 'other' })).status, 409);
    const coderResponse = await request({ agentId: 'coder' });
    assert.equal(coderResponse.status, 200);
    assert.deepEqual(await coderResponse.json(), { library: 'coder', privateValue: 'server only' });
    assert.equal((await request({ agentId: 'memo' })).status, 404);
    assert.equal((await request({ sessionId: 'missing' })).status, 404);
    // A reset removes only the project override, so the request inherits the workspace value.
    const save = (content) => fetch(`http://127.0.0.1:${port}/protoclaw/feature_config/layer`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'programming-helper', layerId: 'project:p', content }),
    });
    assert.equal((await save({ [key]: { library: 42 } })).status, 400);
    assert.equal((await (await request({ sessionId: 'p' })).json()).library, 'project');
    assert.equal((await save({ [key]: { library: 'new-project' } })).status, 200);
    assert.equal((await (await request({ sessionId: 'p' })).json()).library, 'new-project');
    assert.equal((await save({})).status, 200);
    assert.equal((await (await request({ sessionId: 'p' })).json()).library, 'workspace');
  } finally {
    unmountPluginServerRoutes(httpApp.app);
    await httpApp.close();
  }
});

// ── buildPluginServerMounts ────────────────────────────────────────

describe('buildPluginServerMounts', () => {
  it('已装配的 server 面包产出挂载点（装配版本、prefix、entry 路径）', async () => {
    const fixture = makeServerPluginTgz();
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0')),
      serverRoot: join(root, 'server-env'),
    });
    assert.deepEqual(warnings, []);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].prefix, 'srv-demo');
    assert.equal(mounts[0].entryPath, join(versionServerDir(fixture, join(root, 'server-env')), 'index.js'));
  });

  it('未装配的包不挂载（与 assembly 面板同语义）', async () => {
    const fixture = makeServerPluginTgz();
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const { mounts } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers({}),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounts.length, 0);
  });

  it('禁用装配（enabled:false）→ server 面不挂载（三态处置：数据面整体下线）', async () => {
    const fixture = makeServerPluginTgz();
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers({
        'disabled-srv': { $mount: { package: 'srv-demo', version: '1.0.0', enabled: false } },
      }),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounts.length, 0);
    assert.deepEqual(warnings, [], '禁用是显式处置，静默摘除');
  });

  it('默认装配源（global 层 $mount）对 opt-in 身份挂载，identities 归属到身份', async () => {
    const fixture = makeServerPluginTgz();
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers({}, mountedLayer('srv-demo', '1.0.0')),
      serverRoot: join(root, 'server-env'),
    });
    assert.deepEqual(warnings, []);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].identities.length, 1);
    // ADR-0046 2026-11-19 修订：默认装配源展开为 opt-in 身份条目（无 agentId=null 形态）
    assert.equal(mounts[0].identities[0].identity, 'main');
    assert.equal(mounts[0].identities[0].agentId, 'programming-helper');
  });

  it('版本钉装配：catalog 有更高版本不跟随，按装配版本挂载', async () => {
    const old = makeServerPluginTgz({ packageName: 'pinned-srv', version: '1.0.0', prefix: 'pinned-srv' });
    makeServerPluginTgz({ packageName: 'pinned-srv', version: '1.1.0', prefix: 'pinned-srv' });
    await extractServerAssets(old, { serverRoot: join(root, 'server-env') });
    await extractServerAssets(
      { archivePath: join(root, 'pinned-srv-1.1.0.tgz'), packageName: 'pinned-srv', version: '1.1.0', archiveDigest: 'sha256:unused' },
      { serverRoot: join(root, 'server-env') },
    );
    const { mounts } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('pinned-srv', '1.0.0')),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].version, '1.0.0');
    assert.ok(mounts[0].entryPath.includes(join('1.0.0')));
  });

  it('prefix 非法与 entry 穿越拒绝并出警告', async () => {
    makeServerPluginTgz({ prefix: 'Bad Prefix!' });
    makeServerPluginTgz({ packageName: 'srv-evil', version: '1.0.0', prefix: 'evil', entry: '../../escape.js' });
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers({
        ...mountedLayer('srv-demo', '1.0.0'),
        ...mountedLayer('srv-evil', '1.0.0'),
      }),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounts.length, 0);
    assert.equal(warnings.length, 2);
  });

  it('解出物缺失但 tgz 在仓库：自愈解出后正常挂载（tgz 手拷未走导入的场景）', async () => {
    makeServerPluginTgz();
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0')),
      serverRoot: join(root, 'server-env'), // 从未解出
    });
    assert.deepEqual(warnings, []);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].prefix, 'srv-demo');
    assert.ok(existsSync(mounts[0].entryPath), 'server 入口应已自愈解出');
  });

  it('装配引用悬空（包不在仓库）：不挂载、不抛错', async () => {
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('ghost-srv', '9.9.9')),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounts.length, 0);
    assert.ok(Array.isArray(warnings));
  });
});

// ── mountPluginServerRoutes（真 HTTP 链路） ───────────────────────

describe('mountPluginServerRoutes', () => {
  let httpApp;

  beforeEach(() => {
    httpApp = makeHttpApp();
  });
  afterEach(async () => {
    unmountPluginServerRoutes(httpApp.app);
    await httpApp.close();
  });

  it('路由挂载到 /protoclaw/plugin/<prefix>/，getConfig 读 agent 层配置', async () => {
    const fixture = makeServerPluginTgz();
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const opts = {
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0', '/tmp/demo-vault')),
      serverRoot: join(root, 'server-env'),
    };
    const { mounted } = await mountPluginServerRoutes(httpApp.app, opts);
    assert.deepEqual(mounted, [{ packageName: 'srv-demo', prefix: 'srv-demo' }]);

    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, vault: '/tmp/demo-vault' });
  });

  it('server 面缺 registerRoutes 导出：跳过挂载并警告', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: 'export default {};\n',
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const { mounted, warnings } = await mountPluginServerRoutes(httpApp.app, {
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0')),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounted.length, 0);
    assert.ok(warnings.some((w) => w.includes('registerRoutes')));
  });

  it('registerRoutes 抛错：该包整体跳过，不影响其他包', async () => {
    const bad = makeServerPluginTgz({
      serverCode: 'export default { registerRoutes() { throw new Error("boom"); } };\n',
    });
    const good = makeServerPluginTgz({ packageName: 'srv-good', version: '1.0.0', prefix: 'srv-good' });
    await extractServerAssets(bad, { serverRoot: join(root, 'server-env') });
    await extractServerAssets(good, { serverRoot: join(root, 'server-env') });
    const { mounted, warnings } = await mountPluginServerRoutes(httpApp.app, {
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers({ ...mountedLayer('srv-demo', '1.0.0'), ...mountedLayer('srv-good', '1.0.0') }),
      serverRoot: join(root, 'server-env'),
    });
    assert.deepEqual(mounted, [{ packageName: 'srv-good', prefix: 'srv-good' }]);
    assert.ok(warnings.some((w) => w.includes('srv-demo')));
  });

  it('同前缀冲突：保留先挂载者', async () => {
    const first = makeServerPluginTgz({ packageName: 'srv-a', prefix: 'clash' });
    const second = makeServerPluginTgz({ packageName: 'srv-b', prefix: 'clash' });
    await extractServerAssets(first, { serverRoot: join(root, 'server-env') });
    await extractServerAssets(second, { serverRoot: join(root, 'server-env') });
    const { mounted, warnings } = await mountPluginServerRoutes(httpApp.app, {
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers({ ...mountedLayer('srv-a', '1.0.0'), ...mountedLayer('srv-b', '1.0.0') }),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].packageName, 'srv-a');
    assert.ok(warnings.some((w) => w.includes('clash')));
  });

  it('连续异常熔断：5 次 500 后摘除该前缀（503 circuit-open）', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: 'export default { registerRoutes(router) { router.get("/boom", () => { throw new Error("kaboom"); }); } };\n',
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const opts = {
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0')),
      serverRoot: join(root, 'server-env'),
    };
    await mountPluginServerRoutes(httpApp.app, opts);
    const port = await httpApp.listen();
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/boom`);
      assert.equal(res.status, 500, `第 ${i + 1} 次应仍是 500`);
    }
    const after = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/boom`);
    assert.equal(after.status, 503);
    const body = await after.json();
    assert.equal(body.error.code, 'plugin-server-circuit-open');
  });

  it('unmount 摘除后路由 404；remount 重新挂载', async () => {
    const fixture = makeServerPluginTgz();
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    const opts = {
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0', '/v1')),
      serverRoot: join(root, 'server-env'),
    };
    await mountPluginServerRoutes(httpApp.app, opts);
    const port = await httpApp.listen();

    let res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/status`);
    assert.equal(res.status, 200);

    const removed = unmountPluginServerRoutes(httpApp.app);
    assert.ok(removed >= 1, '至少摘除一条挂载路由');
    res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/status`);
    assert.equal(res.status, 404);

    await remountPluginServerRoutes(httpApp.app, {
      ...opts,
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0', '/v2')),
    });
    res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.vault, '/v2');
  });
});

// ── plugin-host 子进程执行模型（ADR-0055）──────────────────────────

describe('plugin-host 子进程执行模型（ADR-0055）', () => {
  let httpApp;

  beforeEach(() => {
    httpApp = makeHttpApp();
  });
  afterEach(async () => {
    unmountPluginServerRoutes(httpApp.app);
    await httpApp.close();
  });

  const baseOpts = (sparse = mountedLayer('srv-demo', '1.0.0')) => ({
    catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
    resolvers: makeResolvers(sparse),
    serverRoot: join(root, 'server-env'),
  });

  it('插件 handler 跑在独立子进程：process.pid 异于宿主', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) { router.get('/who', (req, res) => res.json({ pid: process.pid })); } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/who`);
    assert.equal(res.status, 200);
    const { pid } = await res.json();
    assert.notEqual(pid, process.pid, '插件执行进程必须不是宿主（server.js）进程');
  });

  it('子进程崩溃：在途请求 503，退避重启后自动恢复', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) {
        router.get('/crash', () => { process.exit(7); });
        router.get('/ok', (req, res) => res.json({ ok: true }));
      } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const crashed = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/crash`);
    assert.equal(crashed.status, 503);
    assert.equal((await crashed.json()).error.code, 'plugin-host-crashed');
    // 指数退避首次 250ms + fork 启动：轮询等待恢复（不固定 sleep）
    let recovered = false;
    for (let i = 0; i < 40 && !recovered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/ok`);
        recovered = probe.status === 200 && (await probe.json()).ok === true;
      } catch { /* 重启窗口内的瞬时失败：继续轮询 */ }
    }
    assert.ok(recovered, '崩溃后应在指数退避重启后自动恢复服务');
  });

  it('请求超时：504 且携带 plugin-host-timeout（cancel 通知子进程）', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) { router.get('/hang', () => new Promise(() => {})); } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, { ...baseOpts(), requestTimeoutMs: 250 });
    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/hang`);
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, 'plugin-host-timeout');
  });

  it('分块流式响应：多 chunk 顺序收全（pipe 语义的协议基底）', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) {
        router.get('/stream', (req, res) => {
          res.set('Content-Type', 'text/plain');
          res.write('chunk1;');
          res.write('chunk2;');
          res.end('done');
        });
      } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/stream`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'chunk1;chunk2;done');
  });

  it('removeHeader 透传：插件可摘除宿主预设安全头（PDF iframe 嵌入语义）', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) {
        router.get('/frame', (req, res) => { res.removeHeader('X-Frame-Options'); res.type('text/plain'); res.end('ok'); });
      } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    httpApp.app.use((_req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); next(); });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/frame`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), null, '插件 removeHeader 的宿主预设头不应出现在响应');
  });

  it('POST JSON body 经 IPC 下发并可解析', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) { router.post('/echo', (req, res) => res.json({ got: req.body ?? null })); } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { got: { a: 1 } });
  });

  it('HEAD 请求按 Express 语义回落 GET 路由（不 404）', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) { router.get('/data', (req, res) => { res.type('application/json'); res.end('{"ok":true}'); }); } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/data`, { method: 'HEAD' });
    assert.equal(res.status, 200, 'HEAD 应命中 GET 路由（Express 自动回落语义），而非子进程精确匹配 404');
    assert.match(res.headers.get('content-type') || '', /json/);
    assert.equal(await res.text(), '', 'HEAD 响应不带 body');
  });

  it('remount 切换瞬间：在途请求在宽限期内完成，新请求由新进程服务', async () => {
    const fixture = makeServerPluginTgz({
      serverCode: `export default { registerRoutes(router) {
        router.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 350));
        router.get('/ping', (req, res) => res.json({ pid: process.pid }));
      } };`,
    });
    await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    await mountPluginServerRoutes(httpApp.app, baseOpts());
    const port = await httpApp.listen();
    const before = await (await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/ping`)).json();
    // 发出慢请求，途中触发 remount（预启新进程 + 原子切换 + 旧进程宽限回收）
    const inflight = fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/slow`);
    await new Promise((resolve) => setTimeout(resolve, 80)); // 让请求进入旧子进程
    await remountPluginServerRoutes(httpApp.app, baseOpts());
    const slow = await inflight; // 旧进程在宽限期（3s）内完成 350ms 的在途请求
    assert.equal(slow.status, 200);
    assert.deepEqual(await slow.json(), { ok: true });
    const after = await (await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/ping`)).json();
    assert.notEqual(after.pid, before.pid, 'remount 后应由新子进程服务');
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/protoclaw/plugin/srv-demo/slow`)).json()).ok, true);
  });
});

// ── extractServerAssets 的 ESM 标记 ────────────────────────────────

describe('extractServerAssets ESM 标记', () => {
  it('解出目录自动补写 { "type": "module" }（脱离包根后 .js 按 ESM 解析）', async () => {
    const fixture = makeServerPluginTgz();
    const result = await extractServerAssets(fixture, { serverRoot: join(root, 'server-env') });
    assert.equal(result.extracted, true);
    const marker = JSON.parse(readFileSync(join(versionServerDir(fixture, join(root, 'server-env')), 'package.json'), 'utf8'));
    assert.equal(marker.type, 'module');
    // 动态 import 真实可用（ESM 契约的执行证据）
    const mod = await import(`file://${join(versionServerDir(fixture, join(root, 'server-env')), 'index.js').replace(/\\/g, '/')}`);
    assert.equal(typeof mod.default.registerRoutes, 'function');
  });
});

// ── plugin-server-bus（数据面自动重建信号桥）────────────────────────

describe('plugin-server-bus（数据面自动重建信号桥）', () => {
  it('notify 后监听者收到 reason；退订后不再收到', async () => {
    const { notifyPluginServerDirty, onPluginServerDirty } = await import('../server/shared/plugin-server-bus.js');
    const received = [];
    const off = onPluginServerDirty((reason) => received.push(reason));
    notifyPluginServerDirty('导入 demo');
    notifyPluginServerDirty('安装 pkg@1.0.0 → global');
    off();
    notifyPluginServerDirty('删除 pkg');
    assert.deepEqual(received, ['导入 demo', '安装 pkg@1.0.0 → global'], '退订前的两条送达，退订后不再收到');
  });

  it('无监听时 notify 安全（宿主未接线不抛错）', async () => {
    const { notifyPluginServerDirty } = await import('../server/shared/plugin-server-bus.js');
    notifyPluginServerDirty('no-listener');
  });
});
