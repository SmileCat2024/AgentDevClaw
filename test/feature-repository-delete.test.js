/**
 * 仓库 tgz 删除（ADR-0046 决策 5：删除前置检查无任何装配引用）
 *
 * 覆盖：
 * 1. 空间私有仓库删除：只删本空间仓库的包，全局仓库不动
 * 2. 装配引用保护：仍被装配层引用时 409 package_in_use，文件保留
 * 3. 全局仓库删除：无引用时按包坐标删除；被身份层引用时拒绝
 * 4. 旧调用形态兼容：按 packageId（仓库文件名）删除
 *
 * 数据目录经 AGENTDEV_DATA_DIR 隔离（必须先固化再动态 import server 模块），
 * 不触碰真实用户数据。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'fs-delete-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const express = (await import('express')).default;
const { setupFeatureRepositoryRoutes } = await import('../server/routes/feature-repository.js');

const USER_REPO = path.join(DATA_DIR, 'user-features');
const WORKSPACE_REPO = path.join(DATA_DIR, 'workspaces', 'programming-helper', 'features');
const AGENT_LAYER = path.join(DATA_DIR, 'workspaces', 'programming-helper', 'feature-config', 'agent.json');

function makeTgz(dir, { packageName = 'demo-plugin', version = '1.0.0' } = {}) {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'fs-delete-pack-'));
  const pkgDir = path.join(packRoot, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: packageName, version }));
  // 相对路径 + cwd：Windows GNU tar 把盘符冒号当远程主机分隔符
  const fileName = `${packageName.replace(/[/\\]/g, '!')}-${version}.tgz`;
  execFileSync('tar', ['-czf', fileName, 'package'], { cwd: packRoot });
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);
  writeFileSync(target, readFileSync(path.join(packRoot, fileName)));
  rmSync(packRoot, { recursive: true, force: true });
  return target;
}

describe('feature_repository/delete（装配引用保护）', () => {
  let server;
  let base;

  before(async () => {
    const app = express();
    setupFeatureRepositoryRoutes(app, express, { uploadsRoot: path.join(DATA_DIR, 'uploads') });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    server.closeAllConnections?.();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const postDelete = (body) => fetch(`${base}/protoclaw/feature_repository/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('空间私有包：装配引用存在时拒绝删除，移除装配后删除成功且全局仓库不动', async () => {
    const privateTgz = makeTgz(WORKSPACE_REPO, { packageName: 'private-demo', version: '1.0.0' });
    const globalTgz = makeTgz(USER_REPO, { packageName: 'private-demo', version: '1.0.0' });

    // 装配声明指向该包（本空间 agent 层）
    mkdirSync(path.dirname(AGENT_LAYER), { recursive: true });
    writeFileSync(AGENT_LAYER, JSON.stringify({
      'private-demo': { $mount: { package: 'private-demo', version: '1.0.0' } },
    }, null, 2));

    const blocked = await postDelete({ packageName: 'private-demo', version: '1.0.0', agentId: 'programming-helper' });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.code, 'package_in_use');
    assert.ok(blockedBody.blocked?.[0]?.references?.some((ref) => ref.layerId === 'agent'));
    assert.equal(existsSync(privateTgz), true, '被引用时不得删除文件');

    // 移除装配后删除成功；全局仓库的同名包不受影响
    writeFileSync(AGENT_LAYER, '{}');
    const ok = await postDelete({ packageName: 'private-demo', version: '1.0.0', agentId: 'programming-helper' });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.deleted.length, 1);
    assert.equal(okBody.deleted[0].source, 'workspace');
    assert.equal(existsSync(privateTgz), false);
    assert.equal(existsSync(globalTgz), true, '空间删除不得动全局仓库');
  });

  it('全局仓库：被身份层引用时拒绝删除，未被引用时按包坐标删除', async () => {
    const globalTgz = makeTgz(USER_REPO, { packageName: 'global-demo', version: '2.0.0' });

    mkdirSync(path.dirname(AGENT_LAYER), { recursive: true });
    writeFileSync(AGENT_LAYER, JSON.stringify({
      'global-demo': { $mount: { package: 'global-demo', version: '2.0.0' } },
    }, null, 2));

    const blocked = await postDelete({ packageName: 'global-demo', version: '2.0.0' });
    assert.equal(blocked.status, 409);
    assert.equal(existsSync(globalTgz), true);

    writeFileSync(AGENT_LAYER, '{}');
    const ok = await postDelete({ packageName: 'global-demo', version: '2.0.0' });
    assert.equal(ok.status, 200);
    assert.equal(existsSync(globalTgz), false);
  });

  it('旧调用形态：按 packageId（仓库文件名）删除仍可用', async () => {
    const globalTgz = makeTgz(USER_REPO, { packageName: 'legacy-demo', version: '1.0.0' });
    const packageId = path.basename(globalTgz, '.tgz');
    const ok = await postDelete({ packageId });
    assert.equal(ok.status, 200);
    assert.equal(existsSync(globalTgz), false);
  });

  it('坐标不存在时 404，不误删其他包', async () => {
    const other = makeTgz(USER_REPO, { packageName: 'keep-demo', version: '1.0.0' });
    const res = await postDelete({ packageName: 'missing-demo', version: '1.0.0' });
    assert.equal(res.status, 404);
    assert.equal(existsSync(other), true);
  });
});
