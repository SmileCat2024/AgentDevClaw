import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { setupFeatureRepositoryRoutes, cleanupStaleUploadSessions } from '../server/routes/feature-repository.js';

// 分片上传协议（公网网关 413 场景的标准解法）：init → append×N → complete
// 复用 parse_upload 的 pendingFeatureImports 会话；uploadsRoot 注入临时目录，
// 不触碰真实用户数据目录。server 全文件共享一次（单文件墙钟预算 1.5s），
// 每用例清空 uploads 目录保证"目录为空"类断言不受残留影响。

function makeTgz(root, name) {
  const pkgDir = path.join(root, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name, version: '1.0.0',
    agentdev: { schemaVersion: 2, id: name, displayName: { zh: '分片', en: 'Chunked' }, type: 'ability', capabilities: ['tools'] },
  }));
  // 相对路径 + cwd：Windows GNU tar 把盘符冒号当远程主机分隔符
  execFileSync('tar', ['-czf', `${name}-1.0.0.tgz`, 'package'], { cwd: root });
  return readFileSync(path.join(root, `${name}-1.0.0.tgz`));
}

describe('feature_repository chunked upload', () => {
  let dataRoot;
  let uploadsRoot;
  let server;
  let base;

  before(async () => {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'fs-chunked-'));
    uploadsRoot = path.join(dataRoot, 'uploads');
    const app = express();
    setupFeatureRepositoryRoutes(app, express, { uploadsRoot });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    server.closeAllConnections?.();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(uploadsRoot, { recursive: true, force: true });
    mkdirSync(uploadsRoot, { recursive: true });
  });

  const postJson = (url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const postChunk = (url, bytes) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'chunk.part');
    return fetch(`${base}${url}`, { method: 'POST', body: form });
  };

  it('init 拒绝非 .tgz 文件名与非整数/越界的 totalChunks / totalSize', async () => {
    for (const body of [
      { fileName: 'plugin.zip', totalChunks: 1, totalSize: 10 },
      { fileName: 'plugin.tgz', totalChunks: 0, totalSize: 10 },
      { fileName: 'plugin.tgz', totalChunks: 1.5, totalSize: 10 },
      { fileName: 'plugin.tgz', totalChunks: 1, totalSize: 0 },
      { fileName: 'plugin.tgz', totalChunks: 1, totalSize: 512 * 1024 * 1024 + 1 },
    ]) {
      const res = await postJson('/protoclaw/feature_repository/chunk_init', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('乱序 + 重复分片幂等落位，complete 拼装与原包字节一致并进入待确认态', async () => {
    const tgzBytes = makeTgz(dataRoot, 'chunked-plugin');
    const totalChunks = 4;
    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'chunked-plugin-1.0.0.tgz',
      totalChunks,
      totalSize: tgzBytes.length,
    });
    assert.equal(init.status, 200);
    const { uploadId } = await init.json();
    assert.match(uploadId, /^[0-9a-f-]{36}$/);

    const slice = (i) => tgzBytes.subarray(i * Math.ceil(tgzBytes.length / totalChunks), (i + 1) * Math.ceil(tgzBytes.length / totalChunks));
    // 乱序：3, 1, 0, 2；index 1 重复传一次（幂等覆盖）
    for (const i of [3, 1, 1, 0, 2]) {
      const res = await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=${i}`, slice(i));
      assert.equal(res.status, 200, `chunk ${i}`);
      const body = await res.json();
      assert.equal(body.totalChunks, totalChunks);
    }

    const complete = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId });
    assert.equal(complete.status, 200);
    const payload = await complete.json();
    assert.equal(payload.uploadId, uploadId);
    assert.equal(payload.summary.packageName, 'chunked-plugin');
    // 拼装产物与原包字节一致
    const assembled = readFileSync(path.join(uploadsRoot, `${uploadId}.tgz`));
    assert.ok(tgzBytes.equals(assembled));
    // 分片目录已清
    assert.equal(readdirSync(uploadsRoot).filter((name) => name.startsWith('chunk-')).length, 0);
    // 已进入待确认态：cancel_import 消费该会话并移除其临时文件
    // （cancel 对未知 id 恒 200，文件消失才是 pending 态真实成立的观察点）
    const cancel = await postJson('/protoclaw/feature_repository/cancel_import', { uploadId });
    assert.equal(cancel.status, 200);
    assert.equal(readdirSync(uploadsRoot).includes(`${uploadId}.tgz`), false);
    // 会话已消费：再次 complete → 404
    const again = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId });
    assert.equal(again.status, 404);
  });

  it('append 对未知 uploadId 返回 404、对非法 index 返回 400', async () => {
    const stray = await postChunk('/protoclaw/feature_repository/chunk_append?uploadId=00000000-0000-0000-0000-000000000000&index=0', Buffer.from('x'));
    assert.equal(stray.status, 404);

    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'p.tgz', totalChunks: 2, totalSize: 1024,
    });
    const { uploadId } = await init.json();
    for (const index of [-1, 2, 'abc']) {
      const res = await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=${index}`, Buffer.from('x'));
      assert.equal(res.status, 400, `index=${index}`);
    }
  });

  it('complete 缺片时返回 400 并列出缺失分片', async () => {
    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'p.tgz', totalChunks: 3, totalSize: 3072,
    });
    const { uploadId } = await init.json();
    await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=1`, Buffer.alloc(1024));
    const res = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body.missing, [0, 2]);
  });

  it('complete 拼装大小与声明不符时返回 400 并清理会话', async () => {
    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'p.tgz', totalChunks: 2, totalSize: 4096,
    });
    const { uploadId } = await init.json();
    await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=0`, Buffer.alloc(1024));
    await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=1`, Buffer.alloc(1024));
    const res = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /size mismatch/);
    // 会话与拼装产物均已清理
    assert.equal(readdirSync(uploadsRoot).length, 0);
    const again = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId });
    assert.equal(again.status, 404);
  });

  it('坏包与 parse_upload 同语义：宽容忍返回带 warnings 的降级 summary，仍进入待确认态', async () => {
    const junk = Buffer.alloc(2048, 7);
    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'junk.tgz', totalChunks: 2, totalSize: junk.length,
    });
    const { uploadId } = await init.json();
    for (const i of [0, 1]) {
      await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=${i}`, junk.subarray(i * 1024, (i + 1) * 1024));
    }
    const res = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId });
    // summarizeFeatureArchive 宽容忍：坏 gzip 不抛错，降级 summary 带 warnings
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.ok(payload.summary.warningCount >= 1);
    assert.match(payload.summary.warnings.join(';'), /无法读取 package\.json/);
    // 仍进入待确认态（拼装产物在盘），abort 可清理
    assert.equal(readdirSync(uploadsRoot).includes(`${uploadId}.tgz`), true);
    await postJson('/protoclaw/feature_repository/chunk_abort', { uploadId });
    assert.equal(readdirSync(uploadsRoot).length, 0);
  });

  it('chunk_abort 覆盖两个阶段：分片中清目录，待确认态清临时文件', async () => {
    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'a.tgz', totalChunks: 2, totalSize: 2048,
    });
    const { uploadId } = await init.json();
    await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=0`, Buffer.alloc(1024));
    const abortMid = await postJson('/protoclaw/feature_repository/chunk_abort', { uploadId });
    assert.equal(abortMid.status, 200);
    assert.equal(readdirSync(uploadsRoot).length, 0);

    // 待确认阶段（complete 之后）
    const tgzBytes = makeTgz(dataRoot, 'abort-plugin');
    const init2 = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'abort-plugin-1.0.0.tgz', totalChunks: 1, totalSize: tgzBytes.length,
    });
    const { uploadId: uploadId2 } = await init2.json();
    await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId2}&index=0`, tgzBytes);
    const complete = await postJson('/protoclaw/feature_repository/chunk_complete', { uploadId: uploadId2 });
    assert.equal(complete.status, 200);
    const abortLate = await postJson('/protoclaw/feature_repository/chunk_abort', { uploadId: uploadId2 });
    assert.equal(abortLate.status, 200);
    assert.equal(readdirSync(uploadsRoot).length, 0);
  });

  it('cleanupStaleUploadSessions 清超龄会话与孤儿文件，保留活跃与新鲜文件', async () => {
    const init = await postJson('/protoclaw/feature_repository/chunk_init', {
      fileName: 'stale.tgz', totalChunks: 2, totalSize: 2048,
    });
    const { uploadId } = await init.json();
    await postChunk(`/protoclaw/feature_repository/chunk_append?uploadId=${uploadId}&index=0`, Buffer.alloc(1024));
    // 孤儿：无会话归属的老文件（模拟进程崩溃残留）
    const orphan = path.join(uploadsRoot, 'orphan-leftover');
    writeFileSync(orphan, 'x');
    utimesSync(orphan, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));
    // 新鲜孤儿（不足 TTL）应保留
    const freshOrphan = path.join(uploadsRoot, 'fresh-leftover');
    writeFileSync(freshOrphan, 'x');

    // 第一次扫描（当前时刻）：超龄孤儿清，新鲜孤儿与活跃会话保留
    await cleanupStaleUploadSessions({ now: Date.now(), uploadsRoot });
    assert.equal(readdirSync(uploadsRoot).includes('orphan-leftover'), false);
    assert.equal(readdirSync(uploadsRoot).includes('fresh-leftover'), true);
    assert.equal(readdirSync(uploadsRoot).filter((name) => name.startsWith('chunk-')).length, 1);

    // 第二次扫描（TTL 之后）：活跃会话已超龄，会话目录一并清理
    // （该时钟下 fresh 文件也已超龄，按 TTL 语义同样会被清，不作保留断言）
    await cleanupStaleUploadSessions({ now: Date.now() + 31 * 60_000, uploadsRoot });
    assert.equal(readdirSync(uploadsRoot).filter((name) => name.startsWith('chunk-')).length, 0);
  });
});
