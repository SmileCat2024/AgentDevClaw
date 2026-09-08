/**
 * readSessionIndex 进程内缓存（server/shared/session-access.js）
 *
 * 背景：侧栏轮询（每标签每 3s 的 get_connected_agents / prebuilt_sessions 条件
 * 刷新）反复全量 读+parse+归一化 索引；PH 工作空间索引达数 MB/数千条时是主进程
 * 事件循环停顿的主要来源。缓存以 mtime+size 失效，写路径主动失效。
 *
 * AGENTDEV_DATA_DIR 隔离数据目录（session-access 模块链在 import 时解析数据根）。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-index-cache-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const {
  getPrebuiltSessionIndexPath,
  readSessionIndex,
  writeSessionIndex,
} = await import('../server/shared/session-access.js');

const AGENT_ID = 'cache-test-agent';

function makeIndex(revision, sessionOverrides = {}) {
  return {
    revision,
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        title: '  对话一  ',
        openDirectory: 'D:\\code\\demo',
        sessionType: 'main',
        archived: false,
        todo: true,
        metadata: { resumeMode: 'trim', emptyField: '' },
        ...sessionOverrides,
      },
      { id: 'legacy' }, // 被 legacy 过滤
    ],
  };
}

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('readSessionIndex 缓存', () => {
  test('基础读取：归一化字段与 legacy 过滤', async () => {
    const indexPath = getPrebuiltSessionIndexPath(AGENT_ID);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify(makeIndex(5)), 'utf8');
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 5);
    assert.equal(idx.activeSessionId, 's1');
    assert.equal(idx.sessions.length, 1); // legacy 被滤掉
    assert.equal(idx.sessions[0].title, '对话一');
    assert.equal(idx.sessions[0].sessionType, 'main');
    assert.equal(idx.sessions[0].archived, false);
    assert.equal(idx.sessions[0].todo, true);
    assert.deepEqual(idx.sessions[0].metadata, { resumeMode: 'trim' }); // 空串字段被清
  });

  test('返回值是克隆：调用方突变不污染缓存', async () => {
    const first = await readSessionIndex(AGENT_ID);
    first.sessions[0].title = '已被突变';
    first.revision = 999;
    const second = await readSessionIndex(AGENT_ID);
    assert.equal(second.revision, 5);
    assert.equal(second.sessions[0].title, '对话一');
  });

  test('外部写入（mtime 推进）后读到新数据', async () => {
    const indexPath = getPrebuiltSessionIndexPath(AGENT_ID);
    const st = statSync(indexPath);
    const later = new Date(st.mtimeMs + 3000);
    writeFileSync(indexPath, JSON.stringify(makeIndex(6)), 'utf8');
    utimesSync(indexPath, later, later);
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 6);
  });

  test('writeSessionIndex 落盘后缓存立即失效', async () => {
    await writeSessionIndex(AGENT_ID, makeIndex(7));
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 7);
  });

  test('缓存命中不重读文件：同尺寸损坏内容 + 还原 mtime 仍返回缓存值', async () => {
    const indexPath = getPrebuiltSessionIndexPath(AGENT_ID);
    // NTFS mtime 为 100ns 精度而 Date 只有 ms：用整秒锚点对齐，保证 utimes 往返后
    // stat 完全一致（缓存键 mtimeMs/size 精确相等）
    const anchor = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(indexPath, anchor, anchor);
    const idxBefore = await readSessionIndex(AGENT_ID);
    assert.equal(idxBefore.revision, 7);
    const good = readFileSync(indexPath, 'utf8');
    // good 含中文（对话一），字符数≠UTF-8 字节数，必须按字节数补齐
    writeFileSync(indexPath, '{'.repeat(Buffer.byteLength(good)), 'utf8'); // 同字节数、内容损坏
    utimesSync(indexPath, anchor, anchor); // 还原 stat
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 7); // 命中缓存，未触碰损坏内容
  });

  test('缺文件返回空索引且不缓存空结果，文件出现后读到新数据', async () => {
    const indexPath = getPrebuiltSessionIndexPath(AGENT_ID);
    unlinkSync(indexPath);
    const empty = await readSessionIndex(AGENT_ID);
    assert.deepEqual(empty, { revision: 0, activeSessionId: null, sessions: [] });
    writeFileSync(indexPath, JSON.stringify(makeIndex(8)), 'utf8');
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 8);
  });
});
