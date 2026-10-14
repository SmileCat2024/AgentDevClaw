/**
 * MemoNotesFeature 测试（node:test）
 *
 * 临时目录真实文件 IO（放宽预算），覆盖：
 * 1. 文件名净化（目录成分 / 平台非法字符 / 保留名 / 扩展名补全）
 * 2. 标题与预览提取
 * 3. write 新建 + 同名拒绝（绝不覆盖）
 * 4. read 索引（倒序）与带行号全文
 * 5. edit 行号范围整体替换 / 空串删行 / 越界与非整数报错
 * 6. delete 直接删除
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import { join } from 'path';
import type { Tool } from '@agentdevjs/core';
import {
  MemoNotesFeature,
  sanitizeNoteFilename,
  extractNoteTitle,
  extractNotePreview,
} from '../src/index.js';

const tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'memo-notes-test-'));

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeFeature(name: string): MemoNotesFeature {
  return new MemoNotesFeature({ notesDir: join(tmpRoot, name) });
}

function toolByName(feature: MemoNotesFeature, name: string): Tool {
  const tool = feature.getTools()!.find((entry) => entry.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

describe('sanitizeNoteFilename', () => {
  it('取最后一段路径成分，杜绝目录穿越', () => {
    assert.equal(sanitizeNoteFilename('a/b/c.md'), 'c.md');
    assert.equal(sanitizeNoteFilename('..\\evil'), 'evil.md');
  });

  it('剔除平台非法字符与控制字符，压缩空白', () => {
    assert.equal(sanitizeNoteFilename('note: 1?'), 'note 1.md');
    assert.equal(sanitizeNoteFilename('a<b>*c|"d'), 'abcd.md');
  });

  it('缺 .md 补 .md；已带扩展名（大小写）不重复', () => {
    assert.equal(sanitizeNoteFilename('hello'), 'hello.md');
    assert.equal(sanitizeNoteFilename('hello.md'), 'hello.md');
    assert.equal(sanitizeNoteFilename('hello.MD'), 'hello.md');
  });

  it('尾部点与空格去除（Windows 语义）', () => {
    assert.equal(sanitizeNoteFilename('trailing... '), 'trailing.md');
  });

  it('净化后为空或保留名返回 null', () => {
    assert.equal(sanitizeNoteFilename(''), null);
    assert.equal(sanitizeNoteFilename('   '), null);
    assert.equal(sanitizeNoteFilename('///'), null);
    assert.equal(sanitizeNoteFilename('con'), null);
    assert.equal(sanitizeNoteFilename('COM1.md'), null);
  });
});

describe('标题与预览提取', () => {
  it('标题 = 第一个非空行去 # 标记', () => {
    assert.equal(extractNoteTitle('# 购物清单'), '购物清单');
    assert.equal(extractNoteTitle('##无空格标记'), '无空格标记');
    assert.equal(extractNoteTitle('\n\n正文开头'), '正文开头');
    assert.equal(extractNoteTitle(''), '未命名便签');
  });

  it('预览 = 标题行之后的正文，压缩空白并截断', () => {
    const content = '# 标题\n\n第一段。\n第二段。\n';
    assert.equal(extractNotePreview(content), '第一段。 第二段。');
    assert.equal(extractNotePreview('# 标题\n' + 'x'.repeat(200)), 'x'.repeat(160));
    assert.equal(extractNotePreview('只有一行'), '');
  });
});

describe('memo_note_write', () => {
  it('新建便签并返回生效文件名与标题', async () => {
    const feature = makeFeature('write');
    const write = toolByName(feature, 'memo_note_write');
    const result: any = await write.execute({ filename: '购物清单', content: '# 购物清单\n牛奶' });
    assert.equal(result.ok, true);
    assert.equal(result.filename, '购物清单.md');
    assert.equal(result.title, '购物清单');
    const onDisk = await fs.readFile(join(tmpRoot, 'write', '购物清单.md'), 'utf8');
    assert.equal(onDisk, '# 购物清单\n牛奶');
  });

  it('同名拒绝且不覆盖原内容', async () => {
    const feature = makeFeature('write-collision');
    const write = toolByName(feature, 'memo_note_write');
    await write.execute({ filename: 'a', content: '# 第一篇' });
    const second: any = await write.execute({ filename: 'a', content: '# 覆盖尝试' });
    assert.ok(second.error);
    assert.ok(Array.isArray(second.existing));
    const onDisk = await fs.readFile(join(tmpRoot, 'write-collision', 'a.md'), 'utf8');
    assert.equal(onDisk, '# 第一篇');
  });

  it('空 content 与无效 filename 报错', async () => {
    const feature = makeFeature('write-invalid');
    const write = toolByName(feature, 'memo_note_write');
    assert.ok((await write.execute({ filename: 'x', content: '   ' } as any) as any).error);
    assert.ok((await write.execute({ filename: '', content: '正文' } as any) as any).error);
  });
});

describe('memo_note_read', () => {
  it('不带 filename 列出索引（按更新时间倒序）', async () => {
    const feature = makeFeature('read-index');
    const write = toolByName(feature, 'memo_note_write');
    const read = toolByName(feature, 'memo_note_read');
    await write.execute({ filename: 'old', content: '# 旧便签\n旧正文' });
    // 用 utimes 拉开 mtime，保证排序断言稳定（同毫秒写入顺序不定）。
    await write.execute({ filename: 'new', content: '# 新便签\n新正文' });
    await fs.utimes(join(tmpRoot, 'read-index', 'old.md'), new Date(), new Date(Date.now() - 60_000));

    const result: any = await read.execute({});
    assert.equal(result.total, 2);
    assert.equal(result.notes[0].filename, 'new.md');
    assert.equal(result.notes[1].filename, 'old.md');
    assert.equal(result.notes[1].preview, '旧正文');
    assert.match(result.text, /new\.md/);
  });

  it('空存储返回空态', async () => {
    const feature = makeFeature('read-empty');
    const read = toolByName(feature, 'memo_note_read');
    const result: any = await read.execute({});
    assert.equal(result.total, 0);
  });

  it('带 filename 返回带行号全文', async () => {
    const feature = makeFeature('read-full');
    const write = toolByName(feature, 'memo_note_write');
    const read = toolByName(feature, 'memo_note_read');
    await write.execute({ filename: 'note', content: '第一行\n第二行' });
    const result: any = await read.execute({ filename: 'note' });
    assert.equal(result.lineCount, 2);
    assert.match(result.text, / {3}1\| 第一行/);
    assert.match(result.text, / {3}2\| 第二行/);
  });

  it('读取不存在的便签报错', async () => {
    const feature = makeFeature('read-missing');
    const read = toolByName(feature, 'memo_note_read');
    const result: any = await read.execute({ filename: 'ghost' });
    assert.match(result.error, /不存在/);
  });
});

describe('memo_note_edit', () => {
  async function seed(name: string) {
    const feature = makeFeature(name);
    const write = toolByName(feature, 'memo_note_write');
    await write.execute({ filename: 'doc', content: '第一行\n第二行\n第三行' });
    return feature;
  }

  it('行号范围整体替换', async () => {
    const feature = await seed('edit-range');
    const edit = toolByName(feature, 'memo_note_edit');
    const result: any = await edit.execute({ filename: 'doc', startLine: 2, endLine: 3, newContent: '二改\n三改' });
    assert.equal(result.ok, true);
    assert.equal(result.lineCount, 3);
    const onDisk = await fs.readFile(join(tmpRoot, 'edit-range', 'doc.md'), 'utf8');
    assert.equal(onDisk, '第一行\n二改\n三改');
  });

  it('newContent 空字符串删除该范围行', async () => {
    const feature = await seed('edit-delete-lines');
    const edit = toolByName(feature, 'memo_note_edit');
    const result: any = await edit.execute({ filename: 'doc', startLine: 1, endLine: 2, newContent: '' });
    assert.equal(result.ok, true);
    const onDisk = await fs.readFile(join(tmpRoot, 'edit-delete-lines', 'doc.md'), 'utf8');
    assert.equal(onDisk, '第三行');
  });

  it('越界与非整数行号报错，文件不变', async () => {
    const feature = await seed('edit-invalid');
    const edit = toolByName(feature, 'memo_note_edit');
    const outOfRange: any = await edit.execute({ filename: 'doc', startLine: 1, endLine: 9, newContent: 'x' });
    assert.match(outOfRange.error, /越界/);
    const reversed: any = await edit.execute({ filename: 'doc', startLine: 2, endLine: 1, newContent: 'x' });
    assert.match(reversed.error, /整数/);
    const fractional: any = await edit.execute({ filename: 'doc', startLine: 1.5, endLine: 2, newContent: 'x' });
    assert.match(fractional.error, /整数/);
    const onDisk = await fs.readFile(join(tmpRoot, 'edit-invalid', 'doc.md'), 'utf8');
    assert.equal(onDisk, '第一行\n第二行\n第三行');
  });

  it('修改不存在的便签报错', async () => {
    const feature = makeFeature('edit-missing');
    const edit = toolByName(feature, 'memo_note_edit');
    const result: any = await edit.execute({ filename: 'ghost', startLine: 1, endLine: 1, newContent: 'x' });
    assert.match(result.error, /不存在/);
  });
});

describe('memo_note_delete', () => {
  it('直接删除便签', async () => {
    const feature = makeFeature('delete');
    const write = toolByName(feature, 'memo_note_write');
    const remove = toolByName(feature, 'memo_note_delete');
    const read = toolByName(feature, 'memo_note_read');
    await write.execute({ filename: 'gone', content: '# 待删' });
    const result: any = await remove.execute({ filename: 'gone' });
    assert.equal(result.ok, true);
    assert.equal((await read.execute({} as any) as any).total, 0);
  });

  it('删除不存在的便签报错', async () => {
    const feature = makeFeature('delete-missing');
    const remove = toolByName(feature, 'memo_note_delete');
    const result: any = await remove.execute({ filename: 'ghost' });
    assert.match(result.error, /不存在/);
  });
});
