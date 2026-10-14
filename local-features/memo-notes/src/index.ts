/**
 * MemoNotesFeature — memo 便签存储（增删改查工具面）
 *
 * 便签 = 一篇 Markdown 文件，落盘在数据根 workspaces/memo/notes/ 下
 * （ADR-0016 分区治理：用户数据必须落在 resolveUserDataDir() 之下）。
 * 纯 Markdown、无 front-matter：标题 = 第一个非空行（去 # 标记），
 * 时间戳取文件系统（mtime / birthtime），不维护任何索引文件。
 *
 * 寻址模型（刻意无 id 概念）：filename 是唯一寻址键，由 memo_note_read
 * （不带参数）列出。write 是纯新建（同名拒绝，绝不覆盖——备忘录最不可
 * 接受的失败模式是「记下的东西没了」）；修改走 memo_note_edit 的行号
 * 范围整体替换（read 返回带行号全文供定位）；删除直接 unlink。
 *
 * 首页便签墙的数据面在 Claw server（/protoclaw/memo-app/notes，
 * server/shared/memo-notes.js）。两侧的文件名净化 / 标题 / 预览提取语义
 * 保持一致，属刻意的双份小实现（runtime 子进程与 server 进程不共享
 * 构建产物，local-features 的 TS 不进 server 的 import 图）。
 */

import { promises as fs } from 'fs';
import os from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentFeature, PackageInfo, Tool } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';

// 与 server/shared/constants.js 的 resolveUserDataDir 同语义（TS 独立构建无法
// 直接复用）：AGENTDEV_DATA_DIR 仅用于多实例/测试场景，未设置时保持默认布局。
function resolveUserDataDir(): string {
  const override = process.env.AGENTDEV_DATA_DIR?.trim();
  return override ? resolve(override) : join(os.homedir(), '.agentdev', 'AgentDevClaw');
}

export function resolveDefaultNotesDir(): string {
  return join(resolveUserDataDir(), 'workspaces', 'memo', 'notes');
}

const NOTE_TITLE_MAX_CHARS = 80;
const NOTE_PREVIEW_CHARS = 160;

/** Windows 保留设备名（任意扩展名都保留），文件名净化时直接拒绝。 */
const WINDOWS_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 便签文件名净化：只取最后一段路径成分（容忍模型带目录）、剔除平台非法
 * 字符与控制字符、去掉尾部点与空格（Windows）、缺 .md 补 .md。返回 null
 * 表示净化后为空或命中保留名，调用方报错。
 */
export function sanitizeNoteFilename(raw: unknown): string | null {
  let name = String(raw ?? '').trim();
  name = name.split(/[\\/]+/).pop() || '';
  name = name.replace(/[\p{Cc}<>:"|?*]+/gu, '');
  name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!name) return null;
  const stem = name.replace(/\.md$/i, '');
  if (!stem || WINDOWS_RESERVED_STEMS.has(stem.toLowerCase())) return null;
  return `${stem}.md`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 标题 = 第一个非空行去 # 标记（与 server/shared/memo-notes.js 同语义）。 */
export function extractNoteTitle(content: unknown): string {
  const lines = String(content ?? '').split(/\r?\n/).map((line) => line.trim());
  const first = lines.find((line) => line !== '') || '';
  return collapseWhitespace(first.replace(/^#{1,6}\s*/, '')).slice(0, NOTE_TITLE_MAX_CHARS) || '未命名便签';
}

/** 预览 = 标题行之后的正文纯文本（压缩空白后截断）。 */
export function extractNotePreview(content: unknown, limit = NOTE_PREVIEW_CHARS): string {
  const lines = String(content ?? '').split(/\r?\n/).map((line) => collapseWhitespace(line));
  const titleIndex = lines.findIndex((line) => line !== '');
  const body = lines.slice(titleIndex + 1).filter(Boolean).join(' ');
  return body.slice(0, limit);
}

interface NoteEntry {
  filename: string;
  title: string;
  preview: string;
  updatedAt: number;
  createdAt: number;
}

async function ensureNotesDir(notesDir: string): Promise<void> {
  await fs.mkdir(notesDir, { recursive: true });
}

async function listNotes(notesDir: string): Promise<NoteEntry[]> {
  await ensureNotesDir(notesDir);
  const names = (await fs.readdir(notesDir))
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort();
  const entries = await Promise.all(names.map(async (filename) => {
    const filePath = join(notesDir, filename);
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

function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE').replace('T', ' ');
}

/** 带行号全文：行号是 memo_note_edit 行号范围定位的唯一依据。 */
function renderNumbered(content: string, filename: string): { text: string; lineCount: number } {
  const lines = content.split(/\r?\n/);
  const numbered = lines
    .map((line, index) => `${String(index + 1).padStart(4, ' ')}| ${line}`)
    .join('\n');
  return {
    text: `[${filename}｜共 ${lines.length} 行｜行号供 memo_note_edit 定位]\n${numbered}`,
    lineCount: lines.length,
  };
}

function cleanTextArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const NOT_FOUND_HINT = '可先用不带 filename 的 memo_note_read 列出全部便签';

export class MemoNotesFeature implements AgentFeature {
  readonly name = 'memo-notes';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  private readonly notesDir: string;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: { notesDir?: string } = {}) {
    const explicit = cleanTextArg(config.notesDir);
    this.notesDir = explicit ? resolve(explicit) : resolveDefaultNotesDir();
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'memo_note_write',
        description:
          '新建一篇便签（Markdown 纯文本）。filename 是便签的寻址名（可省略 .md 扩展名，会自动补全；' +
          '含路径分隔符或平台非法字符时会被净化为安全文件名）。content 的第一个非空行作为便签标题。' +
          '同名便签已存在时会拒绝（新建绝不覆盖已有便签）。返回最终生效的 filename，' +
          '之后对该便签的读取 / 修改 / 删除都用它寻址。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '便签文件名（寻址键，无需扩展名）' },
            content: { type: 'string', description: '便签全文（Markdown），第一个非空行将作为标题' },
          },
          required: ['filename', 'content'],
        },
        execute: async (args: Record<string, unknown>) => {
          const filename = sanitizeNoteFilename(args?.filename);
          if (!filename) {
            return { error: 'filename 无效（净化后为空，或是系统保留名）' };
          }
          const content = typeof args?.content === 'string' ? args.content : '';
          if (!content.trim()) {
            return { error: 'content 不能为空' };
          }
          try {
            await ensureNotesDir(this.notesDir);
            // flag 'wx'：已存在即失败，杜绝覆盖语义（TOCTOU 安全）。
            await fs.writeFile(join(this.notesDir, filename), content, { encoding: 'utf8', flag: 'wx' });
          } catch (err: any) {
            if (err?.code === 'EEXIST') {
              const existing = (await listNotes(this.notesDir)).map((entry) => entry.filename);
              return {
                error: `便签已存在: ${filename}（新建不会覆盖已有便签；修改用 memo_note_edit，或换一个文件名）`,
                existing,
              };
            }
            return { error: `便签写入失败: ${err?.message || err}` };
          }
          return { ok: true, filename, title: extractNoteTitle(content) };
        },
      },
      {
        name: 'memo_note_read',
        parallelizable: true,
        description:
          '读取便签。不带 filename 时列出全部便签索引（filename / 标题 / 预览 / 更新时间，按更新时间倒序）' +
          '——便签按 filename 寻址，先在这里拿名字；带 filename 时返回该便签的带行号全文' +
          '（行号用于 memo_note_edit 的行号范围定位）。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '要读取的便签文件名；缺省时列出全部便签索引' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const raw = cleanTextArg(args?.filename);
          if (!raw) {
            const entries = await listNotes(this.notesDir);
            if (entries.length === 0) {
              return { text: '便签存储为空。', total: 0 };
            }
            const lines = entries.map((entry) => {
              const preview = entry.preview ? `｜${entry.preview}` : '';
              return `- ${entry.filename}｜${entry.title}｜更新 ${formatStamp(entry.updatedAt)}${preview}`;
            });
            return {
              text: `共 ${entries.length} 篇便签（按更新时间倒序）：\n${lines.join('\n')}`,
              total: entries.length,
              notes: entries,
            };
          }
          const filename = sanitizeNoteFilename(raw);
          if (!filename) {
            return { error: 'filename 无效' };
          }
          let content: string;
          try {
            content = await fs.readFile(join(this.notesDir, filename), 'utf8');
          } catch {
            return { error: `便签不存在: ${filename}`, hint: NOT_FOUND_HINT };
          }
          const numbered = renderNumbered(content, filename);
          return { text: numbered.text, filename, lineCount: numbered.lineCount };
        },
      },
      {
        name: 'memo_note_edit',
        description:
          '修改便签：把 [startLine, endLine] 行号范围（1 起始、含两端，行号来自 memo_note_read ' +
          '的带行号全文）整体替换为 newContent。newContent 传空字符串表示删除该范围行。' +
          '范围必须落在现有行数之内；返回替换后的带行号全文供确认。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '要修改的便签文件名' },
            startLine: { type: 'number', description: '起始行号（1 起始，含）' },
            endLine: { type: 'number', description: '结束行号（含，须 ≥ startLine 且不超过总行数）' },
            newContent: { type: 'string', description: '替换后的新内容；空字符串表示删除该行号范围' },
          },
          required: ['filename', 'startLine', 'endLine', 'newContent'],
        },
        execute: async (args: Record<string, unknown>) => {
          const filename = sanitizeNoteFilename(args?.filename);
          if (!filename) {
            return { error: 'filename 无效' };
          }
          const startLine = Number(args?.startLine);
          const endLine = Number(args?.endLine);
          const newContent = typeof args?.newContent === 'string' ? args.newContent : '';
          if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
            || startLine < 1 || endLine < startLine) {
            return { error: 'startLine / endLine 必须是整数，且 1 ≤ startLine ≤ endLine' };
          }
          const filePath = join(this.notesDir, filename);
          let content: string;
          try {
            content = await fs.readFile(filePath, 'utf8');
          } catch {
            return { error: `便签不存在: ${filename}`, hint: NOT_FOUND_HINT };
          }
          const lines = content.split(/\r?\n/);
          if (endLine > lines.length) {
            return { error: `行号范围越界: 便签共 ${lines.length} 行，endLine=${endLine}` };
          }
          const replacement = newContent === '' ? [] : newContent.split(/\r?\n/);
          const next = [...lines.slice(0, startLine - 1), ...replacement, ...lines.slice(endLine)];
          try {
            await fs.writeFile(filePath, next.join('\n'), 'utf8');
          } catch (err: any) {
            return { error: `便签写入失败: ${err?.message || err}` };
          }
          const numbered = renderNumbered(next.join('\n'), filename);
          return { ok: true, filename, lineCount: numbered.lineCount, text: numbered.text };
        },
      },
      {
        name: 'memo_note_delete',
        description: '删除便签（永久删除，直接移除文件，无回收站）。filename 来自 memo_note_read 的索引。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '要删除的便签文件名' },
          },
          required: ['filename'],
        },
        execute: async (args: Record<string, unknown>) => {
          const filename = sanitizeNoteFilename(args?.filename);
          if (!filename) {
            return { error: 'filename 无效' };
          }
          try {
            await fs.unlink(join(this.notesDir, filename));
          } catch {
            return { error: `便签不存在: ${filename}`, hint: NOT_FOUND_HINT };
          }
          return { ok: true, filename };
        },
      },
    ];
  }
}
