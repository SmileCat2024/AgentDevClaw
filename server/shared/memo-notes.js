/**
 * Memo 便签存储的数据面（server 侧）
 *
 * 便签 = workspaces/memo/notes/ 下的一篇 Markdown 文件（ADR-0016 分区）。
 * 纯 Markdown、无 front-matter：标题 = 第一个非空行（去 # 标记），时间戳
 * 取文件系统（mtime / birthtime），不维护任何索引文件。
 *
 * 本模块是首页便签墙端点（server/routes/memo-app.js）的纯逻辑层；与
 * local-features/memo-notes（runtime 侧工具面）的净化 / 提取语义保持一致，
 * 属刻意的双份小实现（runtime 子进程与 server 进程不共享构建产物）。
 */

import { promises as fs } from 'fs';
import path from 'path';

const NOTE_TITLE_MAX_CHARS = 80;
const NOTE_PREVIEW_CHARS = 160;

/** Windows 保留设备名（任意扩展名都保留），文件名净化时直接拒绝。 */
const WINDOWS_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 便签文件名净化（与 local-features/memo-notes 同语义）：只取最后一段路径
 * 成分、剔除平台非法字符与控制字符、去掉尾部点与空格（Windows）、缺 .md
 * 补 .md。返回 null 表示净化后为空或命中保留名。
 */
export function sanitizeMemoFilename(raw) {
  let name = String(raw ?? '').trim();
  name = name.split(/[\\/]+/).pop() || '';
  name = name.replace(/[\p{Cc}<>:"|?*]+/gu, '');
  name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!name) return null;
  const stem = name.replace(/\.md$/i, '');
  if (!stem || WINDOWS_RESERVED_STEMS.has(stem.toLowerCase())) return null;
  return `${stem}.md`;
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 标题 = 第一个非空行去 # 标记。 */
export function extractNoteTitle(content) {
  const lines = String(content ?? '').split(/\r?\n/).map((line) => line.trim());
  const first = lines.find((line) => line !== '') || '';
  return collapseWhitespace(first.replace(/^#{1,6}\s*/, '')).slice(0, NOTE_TITLE_MAX_CHARS) || '未命名便签';
}

/** 预览 = 标题行之后的正文纯文本（压缩空白后截断）。 */
export function extractNotePreview(content, limit = NOTE_PREVIEW_CHARS) {
  const lines = String(content ?? '').split(/\r?\n/).map((line) => collapseWhitespace(line));
  const titleIndex = lines.findIndex((line) => line !== '');
  const body = lines.slice(titleIndex + 1).filter(Boolean).join(' ');
  return body.slice(0, limit);
}

/** 列出便签索引（按更新时间倒序）。目录不存在时自动创建并返回空列表。 */
export async function listMemoNotes(notesDir) {
  await fs.mkdir(notesDir, { recursive: true });
  const names = (await fs.readdir(notesDir))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort();
  const entries = await Promise.all(names.map(async (filename) => {
    const filePath = path.join(notesDir, filename);
    const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
    return {
      filename,
      title: extractNoteTitle(content),
      preview: extractNotePreview(content),
      updatedAt: stat.mtimeMs,
      createdAt: stat.birthtimeMs,
    };
  }));
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

/**
 * 覆盖写入整篇便签（阅读视图块级就地编辑的保存语义）：只覆盖已有便签，
 * 不创建新文件——新建仍归 runtime 侧 memo_note_write（新建拒绝覆盖是
 * 「记下的东西不能丢」的产品约束，编辑覆盖是既存便签的合法改写）。
 * content 允许为空串（用户把便签清空是合法编辑终态）。文件名无效或
 * 便签不存在返回 null。
 */
export async function writeMemoNote(notesDir, rawFilename, content) {
  const filename = sanitizeMemoFilename(rawFilename);
  if (!filename) return null;
  const filePath = path.join(notesDir, filename);
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const text = String(content ?? '');
  await fs.writeFile(filePath, text, 'utf8');
  const stat = await fs.stat(filePath);
  return {
    filename,
    title: extractNoteTitle(text),
    content: text,
    updatedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs,
  };
}

/** 读取单篇便签全文（便签墙查看 overlay 用）。不存在或文件名无效返回 null。 */
export async function readMemoNote(notesDir, rawFilename) {
  const filename = sanitizeMemoFilename(rawFilename);
  if (!filename) return null;
  try {
    const filePath = path.join(notesDir, filename);
    const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
    return {
      filename,
      title: extractNoteTitle(content),
      content,
      updatedAt: stat.mtimeMs,
      createdAt: stat.birthtimeMs,
    };
  } catch {
    return null;
  }
}
