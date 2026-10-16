/**
 * memo 便签数据面测试（server/shared/memo-notes.js）
 *
 * 临时目录真实 IO，覆盖：列表（过滤 / 排序 / 字段）、单篇读取、
 * 文件名净化、标题与预览提取。与 local-features/memo-notes 的工具面
 * 测试互补（两处实现语义对齐是刻意的，各自有测试锚定）。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  listMemoNotes,
  readMemoNote,
  writeMemoNote,
  sanitizeMemoFilename,
  extractNoteTitle,
  extractNotePreview,
} from '../server/shared/memo-notes.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-notes-server-test-'));

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('sanitizeMemoFilename', () => {
  it('与 runtime 侧同语义：取末段、去非法字符、补 .md、保留名拒绝', () => {
    assert.equal(sanitizeMemoFilename('a/b.md'), 'b.md');
    assert.equal(sanitizeMemoFilename('note: 1?'), 'note 1.md');
    assert.equal(sanitizeMemoFilename('hello'), 'hello.md');
    assert.equal(sanitizeMemoFilename('con'), null);
    assert.equal(sanitizeMemoFilename('///'), null);
  });
});

describe('标题与预览提取', () => {
  it('标题去 # 标记，预览取标题行后的正文', () => {
    assert.equal(extractNoteTitle('# 购物清单'), '购物清单');
    assert.equal(extractNotePreview('# 标题\n正文一行'), '正文一行');
    assert.equal(extractNoteTitle(''), '未命名便签');
  });
});

describe('listMemoNotes', () => {
  it('只收 .md，按更新时间倒序，字段完整', async () => {
    const dir = path.join(tmpRoot, 'list');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'old.md'), '# 旧便签\n旧正文', 'utf8');
    await fs.writeFile(path.join(dir, 'new.md'), '# 新便签\n新正文', 'utf8');
    await fs.writeFile(path.join(dir, 'ignore.txt'), 'not a note', 'utf8');
    await fs.utimes(path.join(dir, 'old.md'), new Date(), new Date(Date.now() - 60_000));

    const notes = await listMemoNotes(dir);
    assert.deepEqual(notes.map((note) => note.filename), ['new.md', 'old.md']);
    assert.equal(notes[1].title, '旧便签');
    assert.equal(notes[1].preview, '旧正文');
    assert.ok(typeof notes[1].updatedAt === 'number');
    assert.ok(typeof notes[1].createdAt === 'number');
  });

  it('目录不存在时自动创建并返回空列表', async () => {
    const dir = path.join(tmpRoot, 'auto-create');
    const notes = await listMemoNotes(dir);
    assert.deepEqual(notes, []);
    assert.equal((await fs.stat(dir)).isDirectory(), true);
  });
});

describe('writeMemoNote（阅读视图就地编辑的覆盖写）', () => {
  it('覆盖已有便签并返回最新字段', async () => {
    const dir = path.join(tmpRoot, 'write');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'note.md'), '# 旧标题\n旧正文', 'utf8');
    const note = await writeMemoNote(dir, 'note.md', '# 新标题\n新正文');
    assert.equal(note.filename, 'note.md');
    assert.equal(note.title, '新标题');
    assert.equal(note.content, '# 新标题\n新正文');
    assert.equal((await fs.readFile(path.join(dir, 'note.md'), 'utf8')), '# 新标题\n新正文');
  });

  it('content 允许为空串（清空便签是合法编辑终态）', async () => {
    const dir = path.join(tmpRoot, 'write');
    const note = await writeMemoNote(dir, 'note.md', '');
    assert.equal(note.content, '');
    assert.equal((await fs.readFile(path.join(dir, 'note.md'), 'utf8')), '');
  });

  it('不存在时不创建新文件（新建仍归 runtime 工具面）', async () => {
    const dir = path.join(tmpRoot, 'write');
    assert.equal(await writeMemoNote(dir, 'ghost.md', '# 新建'), null);
    await assert.rejects(fs.access(path.join(dir, 'ghost.md')));
  });

  it('无效文件名返回 null 且不落盘', async () => {
    const dir = path.join(tmpRoot, 'write');
    assert.equal(await writeMemoNote(dir, '', '# x'), null);
    assert.equal(await writeMemoNote(dir, 'con', '# x'), null);
    assert.equal(await writeMemoNote(dir, null, '# x'), null);
  });

  it('覆盖不影响相邻便签', async () => {
    const dir = path.join(tmpRoot, 'write');
    await fs.writeFile(path.join(dir, 'other.md'), '# 不动', 'utf8');
    await writeMemoNote(dir, 'note.md', '# 只改我');
    assert.equal((await fs.readFile(path.join(dir, 'other.md'), 'utf8')), '# 不动');
  });
});

describe('readMemoNote', () => {
  it('读取单篇全文与元数据', async () => {
    const dir = path.join(tmpRoot, 'read');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'note.md'), '# 标题\n正文', 'utf8');
    const note = await readMemoNote(dir, 'note.md');
    assert.equal(note.filename, 'note.md');
    assert.equal(note.title, '标题');
    assert.equal(note.content, '# 标题\n正文');
  });

  it('不存在或无效文件名返回 null', async () => {
    const dir = path.join(tmpRoot, 'read');
    assert.equal(await readMemoNote(dir, 'ghost'), null);
    assert.equal(await readMemoNote(dir, ''), null);
    assert.equal(await readMemoNote(dir, 'con'), null);
  });
});
