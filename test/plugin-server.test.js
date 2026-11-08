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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative as pathRelative } from 'path';
import http from 'node:http';
import crypto from 'crypto';
import express from 'express';

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
    JSON.stringify({ schemaVersion: 3, id: packageName, entry: 'dist/index.js', server: { entry, prefix } }),
  );
  writeFileSync(join(pkgDir, 'server', 'index.js'), serverCode);
  const archivePath = join(root, `${packageName.replace(/[/\\]/g, '!')}-${version}.tgz`);
  execFileSync('tar', ['-czf', pathRelative(root, archivePath), '-C', pathRelative(root, src), 'package'], { cwd: root });
  const digest = `sha256:${crypto.createHash('sha256').update(readFileSync(archivePath)).digest('hex')}`;
  return { archivePath, digest, packageName, version };
}

/** 身份层 fixture：agent 层写 $mount + 插件配置（vaultPath）。 */
function makeResolvers(agentLayerSparse) {
  const resolvers = new Map();
  const file = join(root, 'layer-agent.json');
  writeFileSync(file, JSON.stringify(agentLayerSparse, null, 2));
  resolvers.set('programming-helper', () => ({ layers: [{ id: 'agent', label: 'agent', path: file }] }));
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

  it('声明了 server 面但未解出的包跳过（tgz 手拷未走导入）', async () => {
    makeServerPluginTgz();
    const { mounts, warnings } = await buildPluginServerMounts({
      catalogRoots: { userRoot: root, officialRoot: join(root, 'official-empty') },
      resolvers: makeResolvers(mountedLayer('srv-demo', '1.0.0')),
      serverRoot: join(root, 'server-env'),
    });
    assert.equal(mounts.length, 0);
    assert.ok(warnings.some((w) => w.includes('未解出')));
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
