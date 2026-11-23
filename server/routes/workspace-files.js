import path from 'node:path';
import { json as jsonBody } from 'express';
import { promises as fs } from 'node:fs';
import { readSessionIndexShared } from '../shared/session-access.js';
import { resolveSessionRuntimeDirectory } from '../shared/session-project.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import { sharedOfficeConverter } from '../shared/office-converter.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
// 预览分派对齐 DSH DocumentPreview 的「白名单之外一律纯文本」模型：
// 图片 → base64 dataUrl（<img> 模式加载，SVG 内嵌脚本在该模式下不执行）；
// pdf / video / audio → 同源 raw 字节流，浏览器原生查看器；
// docx → raw 字节流给 docx-preview；xlsx / xls → raw 字节流给 SheetJS；
// doc / ppt / pptx → 本机 LibreOffice 转 PDF（office-pdf 端点）；
// 其余后缀按文本读取，只有下面这份「已知二进制容器」清单判为不可预览。
// 用黑名单而非文本白名单：DSH 里任何非二进制后缀都能以纯文本打开，白名单
// 会让 .conf/.properties/.tf 这类文本在 Claw 侧变成「不支持预览」。
const UNVIEWABLE_BINARY_EXTENSIONS = new Set([
  // 归档
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.tar', '.jar',
  // 可执行与编译产物
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.class', '.pyc', '.wasm',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 磁盘镜像与数据库
  '.dmg', '.iso', '.img', '.sqlite', '.db',
  // 设计稿与本预览不支持的图片/办公格式（doc/ppt/pptx/xls 有专门渲染器，不在此列；
  // `.key` 保持在黑名单外：它常是 PEM 私钥这类文本，与 DSH 口径一致）
  '.psd', '.ai', '.sketch', '.tiff', '.tif', '.heic', '.heif', '.odt', '.ods', '.odp',
  '.pages', '.numbers', '.avi', '.mkv', '.flv', '.wmv', '.wma', '.opus',
]);
const IMAGE_MIME_BY_EXTENSION = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};
const MEDIA_MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.aac': 'audio/aac',
};
// Office 文档：docx / xlsx / xls 经 raw URL 取字节流，浏览器端由 docx-preview /
// SheetJS 渲染；doc / ppt / pptx 由本机 LibreOffice 转 PDF 后走 PDF 查看器
// （引擎缺失时 read() 直接返回可读的错误码，面板给出安装提示）。
const OFFICE_MIME_BY_EXTENSION = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};
const OFFICE_PDF_EXTENSIONS = new Set(['.doc', '.ppt', '.pptx']);

function previewKindOf(extension) {
  if (IMAGE_MIME_BY_EXTENSION[extension]) return 'image';
  if (MEDIA_MIME_BY_EXTENSION[extension]) {
    if (extension === '.pdf') return 'pdf';
    const mimeType = MEDIA_MIME_BY_EXTENSION[extension];
    return mimeType.startsWith('video/') ? 'video' : 'audio';
  }
  if (OFFICE_MIME_BY_EXTENSION[extension]) return extension === '.docx' ? 'docx' : 'xlsx';
  if (OFFICE_PDF_EXTENSIONS.has(extension)) return 'office-pdf';
  if (UNVIEWABLE_BINARY_EXTENSIONS.has(extension)) return null;
  return 'text';
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value)) return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.split('/').some(part => part === '..')) return null;
  return normalized === '.' ? '' : normalized.replace(/\/$/, '');
}

async function resolveInside(root, relativePath) {
  const safeRelative = normalizeRelativePath(relativePath);
  if (safeRelative === null) return { error: 'invalid_path' };
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, safeRelative);
  const relative = path.relative(rootReal, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: 'path_outside_workspace' };
  }
  let cursor = rootReal;
  for (const part of safeRelative.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await fs.lstat(cursor); } catch (error) {
      return { error: error.code === 'ENOENT' ? 'not_found' : 'read_failed' };
    }
    if (stat.isSymbolicLink()) return { error: 'symlink_not_allowed' };
  }
  return { absolutePath: candidate, relativePath: safeRelative };
}

async function resolveSessionRoot(agentId, sessionId, requireAgentLight) {
  if (!agentId || !sessionId) return { error: 'agentId_and_sessionId_required' };
  if (agentId !== 'programming-helper') return { error: 'unsupported_workspace' };
  const agent = await requireAgentLight(agentId);
  if (!agent) return { error: 'agent_not_found' };
  const index = await readSessionIndexShared(agentId);
  const record = index.sessions.find(item => item.id === sessionId);
  if (!record || record.archived) return { error: 'session_not_found' };
  let directory;
  try {
    directory = resolveSessionRuntimeDirectory(record, { sessionId });
  } catch {
    return { error: 'workspace_unavailable' };
  }
  const root = directory || cleanSessionText(record.openDirectory);
  if (!root) return { error: 'workspace_unavailable' };
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return { error: 'workspace_unavailable' };
    return { root: await fs.realpath(root) };
  } catch {
    return { error: 'workspace_unavailable' };
  }
}

function sendError(res, error) {
  const status = error === 'not_found' || error === 'session_not_found' ? 404
    : error === 'path_outside_workspace' || error === 'symlink_not_allowed' ? 403
      : error === 'office_engine_unavailable' ? 503
        : error === 'office_convert_timeout' ? 504
          : error === 'office_convert_failed' ? 502
            : error === 'binary_content' ? 415
              : error === 'invalid_path' || error === 'agentId_and_sessionId_required'
                || error === 'unsupported_file_type' || error === 'file_too_large' || error === 'not_a_file' ? 400 : 500;
  res.status(status).json({ error });
}

/** BOM 优先的文本解码；含 NUL 的内容判为二进制（未知后缀不做垃圾文本渲染）。 */
function decodeTextContent(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const swapped = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const low = swapped[index];
      swapped[index] = swapped[index + 1];
      swapped[index + 1] = low;
    }
    return swapped.toString('utf16le');
  }
  const start = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
  const limit = Math.min(bytes.length, 8192);
  for (let index = start; index < limit; index += 1) {
    if (bytes[index] === 0) return null;
  }
  return bytes.subarray(start).toString('utf8');
}

export function createWorkspaceFileService({
  requireAgentLight, fsApi = fs, resolveRoot, officeConverter = sharedOfficeConverter,
} = {}) {
  async function withTarget(body, res, action) {
    const agentId = cleanSessionText(body?.agentId);
    const sessionId = cleanSessionText(body?.sessionId);
    const scope = resolveRoot
      ? await resolveRoot(agentId, sessionId)
      : await resolveSessionRoot(agentId, sessionId, requireAgentLight);
    if (scope.error) return sendError(res, scope.error);
    const target = await resolveInside(scope.root, body?.path || '');
    if (target.error) return sendError(res, target.error);
    return action(scope.root, target);
  }

  return {
    async list(body, res) {
      return withTarget(body, res, async (_root, target) => {
        let entries;
        try { entries = await fsApi.readdir(target.absolutePath, { withFileTypes: true }); }
        catch (error) { return sendError(res, error.code === 'ENOENT' ? 'not_found' : 'read_failed'); }
        const result = [];
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const relativePath = [target.relativePath, entry.name].filter(Boolean).join('/');
          if (entry.isDirectory()) {
            result.push({ name: entry.name, path: relativePath, kind: 'directory' });
          } else if (entry.isFile()) {
            let stat;
            try { stat = await fsApi.stat(path.join(target.absolutePath, entry.name)); } catch { continue; }
            const extension = path.extname(entry.name).toLowerCase();
            const previewKind = previewKindOf(extension);
            result.push({
              name: entry.name,
              path: relativePath,
              kind: 'file',
              size: stat.size,
              supported: previewKind !== null,
            });
          }
        }
        result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory')
          || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        res.json({ path: target.relativePath, entries: result });
      });
    },
    async read(body, res) {
      return withTarget(body, res, async (_root, target) => {
        let stat;
        try { stat = await fsApi.stat(target.absolutePath); }
        catch (error) { return sendError(res, error.code === 'ENOENT' ? 'not_found' : 'read_failed'); }
        if (!stat.isFile()) return sendError(res, 'not_a_file');
        const extension = path.extname(target.absolutePath).toLowerCase();
        const previewKind = previewKindOf(extension);
        if (previewKind === null) return sendError(res, 'unsupported_file_type');
        try {
          if (previewKind === 'image') {
            if (stat.size > MAX_IMAGE_BYTES) return sendError(res, 'file_too_large');
            const bytes = await fsApi.readFile(target.absolutePath);
            res.json({
              path: target.relativePath,
              kind: 'image',
              mimeType: IMAGE_MIME_BY_EXTENSION[extension],
              dataUrl: `data:${IMAGE_MIME_BY_EXTENSION[extension]};base64,${bytes.toString('base64')}`,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            });
            return;
          }
          if (previewKind === 'pdf' || previewKind === 'video' || previewKind === 'audio') {
            if (stat.size > MAX_MEDIA_BYTES) return sendError(res, 'file_too_large');
            // 轻量握手：只回报类型元数据；字节流经 GET /raw 同源 URL 输出
            // （base64 dataUrl 在页面 CSP 下无法进 iframe/video，不作传输形态）。
            res.json({
              path: target.relativePath,
              kind: previewKind,
              mimeType: MEDIA_MIME_BY_EXTENSION[extension],
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            });
            return;
          }
          if (previewKind === 'docx' || previewKind === 'xlsx') {
            if (stat.size > MAX_MEDIA_BYTES) return sendError(res, 'file_too_large');
            // 同 raw 握手模式：前端 fetch /raw 取 arrayBuffer 交给渲染库。
            res.json({
              path: target.relativePath,
              kind: previewKind,
              mimeType: OFFICE_MIME_BY_EXTENSION[extension],
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            });
            return;
          }
          if (previewKind === 'office-pdf') {
            if (stat.size > MAX_MEDIA_BYTES) return sendError(res, 'file_too_large');
            // 引擎缺失在握手阶段就回报：面板能直接显示安装提示，而不是先挂
            // 一个会返回 JSON 错误的 iframe。
            if (!(await officeConverter.available())) return sendError(res, 'office_engine_unavailable');
            res.json({
              path: target.relativePath,
              kind: 'office-pdf',
              mimeType: 'application/pdf',
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            });
            return;
          }
          if (stat.size > MAX_FILE_BYTES) return sendError(res, 'file_too_large');
          const content = decodeTextContent(await fsApi.readFile(target.absolutePath));
          if (content === null) return sendError(res, 'binary_content');
          res.json({ path: target.relativePath, kind: 'text', content, size: stat.size, modifiedAt: stat.mtimeMs });
        } catch {
          sendError(res, 'read_failed');
        }
      });
    },
    async officePdf(body, res) {
      // doc / ppt / pptx 的本机转换端点：转换结果以 PDF 字节直出，交给面板
      // 现有的 PDF iframe（同源 + frame-ancestors 'self'，与 raw 同一套头）。
      return withTarget(body, res, async (_root, target) => {
        let stat;
        try { stat = await fsApi.stat(target.absolutePath); }
        catch (error) { return sendError(res, error.code === 'ENOENT' ? 'not_found' : 'read_failed'); }
        if (!stat.isFile()) return sendError(res, 'not_a_file');
        const extension = path.extname(target.absolutePath).toLowerCase();
        if (!OFFICE_PDF_EXTENSIONS.has(extension)) return sendError(res, 'unsupported_file_type');
        if (stat.size > MAX_MEDIA_BYTES) return sendError(res, 'file_too_large');
        try {
          const bytes = await officeConverter.toPdf(target.absolutePath, {
            realPath: target.absolutePath, mtimeMs: stat.mtimeMs, size: stat.size,
          });
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
          res.end(bytes);
        } catch (error) {
          const code = error?.code === 'office_engine_unavailable' ? 'office_engine_unavailable'
            : error?.code === 'office_convert_timeout' ? 'office_convert_timeout'
              : 'office_convert_failed';
          sendError(res, code);
        }
      });
    },
    async raw(body, res) {
      // pdf / video / audio 的同源字节流端点：iframe 与 <video>/<audio> 的 src
      // 直连此 URL（同源满足页面 CSP）。仅放行媒体类 kind，文本/图片仍走 read()。
      return withTarget(body, res, async (_root, target) => {
        let stat;
        try { stat = await fsApi.stat(target.absolutePath); }
        catch (error) { return sendError(res, error.code === 'ENOENT' ? 'not_found' : 'read_failed'); }
        if (!stat.isFile()) return sendError(res, 'not_a_file');
        const extension = path.extname(target.absolutePath).toLowerCase();
        const previewKind = previewKindOf(extension);
        if (previewKind !== 'pdf' && previewKind !== 'video' && previewKind !== 'audio'
          && previewKind !== 'docx' && previewKind !== 'xlsx') {
          return sendError(res, 'unsupported_file_type');
        }
        if (stat.size > MAX_MEDIA_BYTES) return sendError(res, 'file_too_large');
        try {
          const bytes = await fsApi.readFile(target.absolutePath);
          res.setHeader('Content-Type',
            MEDIA_MIME_BY_EXTENSION[extension] || OFFICE_MIME_BY_EXTENSION[extension]);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Disposition', 'inline');
          // 范围限定的嵌框例外：本端点就是给应用自身的 PDF 查看器 iframe 消费的，
          // 全局 frame-ancestors 'none' 会把同源嵌框一并拒绝。仍只允许自身源
          // （frame-ancestors 'self' / X-Frame-Options SAMEORIGIN），不放开外站。
          res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
          res.end(bytes);
        } catch {
          sendError(res, 'read_failed');
        }
      });
    },
  };
}

export function setupWorkspaceFileRoutes(app, { requireAgentLight, resolveRoot, officeConverter } = {}) {
  const service = createWorkspaceFileService({ requireAgentLight, resolveRoot, officeConverter });
  app.post('/protoclaw/workspace-files/list', jsonBody(), async (req, res, next) => {
    try { await service.list(req.body, res); } catch (error) { next(error); }
  });
  app.post('/protoclaw/workspace-files/read', jsonBody(), async (req, res, next) => {
    try { await service.read(req.body, res); } catch (error) { next(error); }
  });
  app.get('/protoclaw/workspace-files/raw', async (req, res, next) => {
    try { await service.raw(req.query, res); } catch (error) { next(error); }
  });
  app.get('/protoclaw/workspace-files/office-pdf', async (req, res, next) => {
    try { await service.officePdf(req.query, res); } catch (error) { next(error); }
  });
  return service;
}
