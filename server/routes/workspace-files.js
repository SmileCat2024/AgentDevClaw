import path from 'node:path';
import { json as jsonBody } from 'express';
import { promises as fs } from 'node:fs';
import { readSessionIndexShared } from '../shared/session-access.js';
import { resolveSessionRuntimeDirectory } from '../shared/session-project.js';
import { cleanSessionText } from '../shared/string-helpers.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.json', '.jsonc', '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
  '.ini', '.env', '.sh', '.bash', '.ps1', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.sql', '.log', '.diff', '.patch', '.gitignore', '.dockerfile',
  '.csv', '.tsv', '.vue', '.svelte', '.astro', '.kt', '.kts', '.swift', '.dart', '.scala',
  '.clj', '.cljs', '.ex', '.exs', '.erl', '.hs', '.lua', '.pl', '.r', '.jl', '.groovy',
  '.gradle', '.proto', '.graphql', '.gql', '.bat', '.cmd', '.tex', '.rst', '.adoc',
  '.editorconfig', '.gitattributes', '.npmrc', '.babelrc', '.eslintrc', '.prettierrc',
]);
// 预览分派按类型返回（对齐 DSH DocumentPreview 支持矩阵）：
// 文本走 content；图片走 base64 dataUrl（<img> 模式加载，SVG 内嵌脚本在该模式
// 下不执行）；pdf / video / audio 走 base64 dataUrl（前端转 object URL 用浏览器
// 原生查看器）；html 源码按文本返回，前端以禁脚本沙箱 iframe 渲染。
// 其余后缀视为不可预览。
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
// Office 文档（OOXML）：前端经 raw URL fetch 字节流后由 docx-preview / SheetJS
// 浏览器端渲染（DSH 用 LibreOffice 转 PDF，本机无该引擎，取等效浏览器渲染路径；
// 二进制老格式 doc/xls/ppt 维持不可预览）。
const OFFICE_MIME_BY_EXTENSION = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function previewKindOf(extension) {
  if (IMAGE_MIME_BY_EXTENSION[extension]) return 'image';
  if (MEDIA_MIME_BY_EXTENSION[extension]) {
    if (extension === '.pdf') return 'pdf';
    const mimeType = MEDIA_MIME_BY_EXTENSION[extension];
    return mimeType.startsWith('video/') ? 'video' : 'audio';
  }
  if (OFFICE_MIME_BY_EXTENSION[extension]) return extension === '.docx' ? 'docx' : 'xlsx';
  if (TEXT_EXTENSIONS.has(extension) || !extension) return 'text';
  return null;
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
      : error === 'invalid_path' || error === 'agentId_and_sessionId_required'
        || error === 'unsupported_file_type' || error === 'file_too_large' || error === 'not_a_file' ? 400 : 500;
  res.status(status).json({ error });
}

export function createWorkspaceFileService({ requireAgentLight, fsApi = fs, resolveRoot } = {}) {
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
          if (stat.size > MAX_FILE_BYTES) return sendError(res, 'file_too_large');
          const content = await fsApi.readFile(target.absolutePath, 'utf8');
          res.json({ path: target.relativePath, kind: 'text', content, size: stat.size, modifiedAt: stat.mtimeMs });
        } catch {
          sendError(res, 'read_failed');
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

export function setupWorkspaceFileRoutes(app, { requireAgentLight, resolveRoot } = {}) {
  const service = createWorkspaceFileService({ requireAgentLight, resolveRoot });
  app.post('/protoclaw/workspace-files/list', jsonBody(), async (req, res, next) => {
    try { await service.list(req.body, res); } catch (error) { next(error); }
  });
  app.post('/protoclaw/workspace-files/read', jsonBody(), async (req, res, next) => {
    try { await service.read(req.body, res); } catch (error) { next(error); }
  });
  app.get('/protoclaw/workspace-files/raw', async (req, res, next) => {
    try { await service.raw(req.query, res); } catch (error) { next(error); }
  });
  return service;
}
