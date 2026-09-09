// guide.js — 「AgentDevClaw 指南」工作空间的服务端能力
//
// 职责：
//   - 扫描指南根目录（默认仓库顶层 guide/，可在 metadata block.guideDocset.path 配置）
//     生成目录树（仅含含 md 文档的目录），供 workspace_data 聚合给前端。
//   - GET /protoclaw/guide_doc   读取单个 md 文档（剥离 frontmatter，回传标题与正文）
//   - GET /protoclaw/guide_asset 按相对路径提供图片等静态资源（白名单扩展名）
//
// 安全边界：所有路径解析都收敛在指南根目录内（拒绝绝对路径、盘符、.. 越界与
// realpath 逃逸），资产接口只服务允许的扩展名。

import path from 'path';
import { promises as fs } from 'fs';

import { PROJECT_ROOT, AGENTS_ROOT } from '../shared/constants.js';
import { readJsonSafe } from '../shared/fs-helpers.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

const GUIDE_ASSET_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Normalize a guide-internal relative path (markdown 语义：相对解析，允许 ../
 * 在根内导航）。返回 null 表示绝对路径、盘符或越出根目录。
 * `..` 在此做词法归一化；最终包含性由 resolveGuideFileWithinRoot 的
 * realpath 校验兜底。
 */
export function sanitizeGuideRelativePath(raw) {
  let cleaned = String(raw || '').trim();
  if (!cleaned || cleaned.includes('\0')) return null;
  // 解码 URL 编码再校验，防 %2e%2e 绕过；解码失败（如文件名含字面 %）回退
  // 原始串——归一化与包含性校验都发生在解码之后，回退不影响安全边界
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // 保持原始字符串继续走归一化
  }
  cleaned = cleaned.replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('\0')) return null;
  // 前导 / 视为绝对路径拒绝（本接口的路径都相对指南根解析）
  if (cleaned.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  const normalized = [];
  for (const segment of cleaned.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    if (segment === '~') return null;
    normalized.push(segment);
  }
  if (normalized.length === 0) return null;
  return normalized.join('/');
}

/**
 * Resolve a guide-relative path to an absolute path, verifying the target (or,
 * when it does not exist yet, its deepest existing ancestor — so missing files
 * report 404 rather than a traversal error) stays inside the guide root.
 * Returns { absolute, relative } or null when outside the root.
 */
export async function resolveGuideFileWithinRoot(rootAbs, relative) {
  const cleaned = sanitizeGuideRelativePath(relative);
  if (!cleaned) return null;

  let rootReal;
  try {
    rootReal = await fs.realpath(rootAbs);
  } catch {
    return null;
  }

  const target = path.resolve(rootReal, cleaned);
  const relToRoot = path.relative(rootReal, target);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return null;
  }

  // 对最深已存在的祖先做 realpath 校验（防符号链接逃逸）；缺失部分只是
  // 尚不存在的字面路径段，sanitize 已拒绝 '..' 与绝对形式，拼回仍在根内。
  let probe = target;
  for (;;) {
    try {
      const probeReal = await fs.realpath(probe);
      const relProbe = path.relative(rootReal, probeReal);
      if (relProbe.startsWith('..') || path.isAbsolute(relProbe)) return null;
      return { absolute: target, relative: cleaned };
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

// ── Markdown helpers ─────────────────────────────────────────────────────────

/**
 * Strip a leading YAML frontmatter block and return its top-level scalar
 * attributes plus the remaining body.
 */
export function stripGuideFrontmatter(source) {
  const text = String(source || '');
  if (!text.startsWith('---')) {
    return { attrs: {}, body: text };
  }
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    return { attrs: {}, body: text };
  }
  const attrs = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (pair && pair[2].trim() !== '') {
      attrs[pair[1].trim()] = pair[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { attrs, body: text.slice(match[0].length) };
}

/**
 * Extract the first top-level (#) heading as the display title.
 */
export function extractGuideTitle(body) {
  const segments = String(body || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  for (let i = 0; i < segments.length; i += 2) {
    const match = segments[i].match(/^#\s+(.+?)\s*#*\s*$/m);
    if (match) {
      return match[1].replace(/[*_`]/g, '').trim();
    }
  }
  return '';
}

/**
 * Extract h2/h3 headings for the page outline.
 */
export function extractGuideHeadings(body, maxLevel = 3) {
  const headings = [];
  const segments = String(body || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  for (let i = 0; i < segments.length; i += 2) {
    for (const line of segments[i].split(/\r?\n/)) {
      const match = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
      if (match && match[1].length <= maxLevel) {
        headings.push({
          level: match[1].length,
          text: match[2].replace(/[*_`]/g, '').trim(),
        });
      }
    }
  }
  return headings;
}

// ── Tree scanning ────────────────────────────────────────────────────────────

const TITLE_SCAN_BYTES = 8192;

async function readGuideDocTitle(absPath, fileName) {
  try {
    const handle = await fs.open(absPath, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(TITLE_SCAN_BYTES), 0, TITLE_SCAN_BYTES, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      const { attrs, body } = stripGuideFrontmatter(head);
      return attrs.title || extractGuideTitle(body) || fileName.replace(/\.md$/i, '');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export function guideNameCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/**
 * Build the guide tree. Only directories containing at least one md
 * descendant are included; non-md files never appear (they are assets).
 */
export async function buildGuideTree(rootAbs) {
  const visit = async (relative) => {
    const absolute = relative ? path.join(rootAbs, relative) : rootAbs;
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return { children: [], updatedAt: null, docCount: 0 };
    }

    const jobs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        jobs.push(visit(childRelative).then((subtree) => ({ subtree, childRelative, name: entry.name })));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        jobs.push((async () => {
          const stat = await fs.stat(path.join(absolute, entry.name)).catch(() => null);
          const title = await readGuideDocTitle(path.join(absolute, entry.name), entry.name);
          return {
            subtree: {
              node: { type: 'doc', id: childRelative, name: entry.name.replace(/\.md$/i, ''), title },
              updatedAt: stat ? stat.mtime.toISOString() : null,
              docCount: 1,
            },
            childRelative,
            name: entry.name,
          };
        })());
      }
    }

    const children = [];
    let updatedAt = null;
    let docCount = 0;

    const results = await Promise.all(jobs);
    for (const { subtree, childRelative, name } of results) {
      if (!subtree || !subtree.docCount) continue;
      if (subtree.node) {
        children.push(subtree.node);
      } else {
        children.push({ type: 'dir', id: childRelative, name, children: subtree.children, updatedAt: subtree.updatedAt });
      }
      docCount += subtree.docCount;
      if (subtree.updatedAt && (!updatedAt || subtree.updatedAt > updatedAt)) {
        updatedAt = subtree.updatedAt;
      }
    }

    children.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
      return guideNameCompare(left.name, right.name);
    });

    return { children, updatedAt, docCount };
  };

  return visit('');
}

/**
 * Summarize one guide root for workspace_data aggregation (block id → data).
 */
export async function summarizeGuideDocset(config = {}) {
  const rootAbs = resolveGuideRootFromConfig(config.path);
  if (!rootAbs) {
    return { exists: false, type: 'guide-docset', docCount: 0, tree: [], defaultDoc: '', error: 'guideDocset.path is not configured' };
  }
  try {
    const rootStat = await fs.stat(rootAbs);
    if (!rootStat.isDirectory()) {
      return { exists: false, type: 'guide-docset', root: rootAbs, path: config.path, docCount: 0, tree: [], defaultDoc: '', error: 'Not a directory' };
    }
    const tree = await buildGuideTree(rootAbs);
    const docs = [];
    const collectDocs = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'doc') docs.push(node.id);
        else collectDocs(node.children || []);
      }
    };
    collectDocs(tree.children);
    return {
      exists: true,
      type: 'guide-docset',
      root: rootAbs,
      path: config.path,
      docCount: docs.length,
      updatedAt: tree.updatedAt,
      defaultDoc: docs[0] || '',
      tree: tree.children,
    };
  } catch (error) {
    return {
      exists: false,
      type: 'guide-docset',
      root: rootAbs,
      path: config.path,
      docCount: 0,
      tree: [],
      defaultDoc: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Guide root resolution from agent metadata ────────────────────────────────

export function resolveGuideRootFromConfig(rawPath) {
  const cleaned = String(rawPath || '').trim();
  if (!cleaned) return '';
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(PROJECT_ROOT, cleaned);
}

async function resolveGuideRootForAgent(agentId) {
  const safeId = sanitizeSessionFragment(String(agentId || ''));
  if (!safeId) return null;
  for (const candidate of [path.join('official', safeId), safeId]) {
    const meta = await readJsonSafe(path.join(AGENTS_ROOT, candidate, 'metadata.json'), null).catch(() => null);
    const block = Array.isArray(meta?.ui?.home?.blocks)
      ? meta.ui.home.blocks.find((item) => item?.guideDocset?.path)
      : null;
    if (block?.guideDocset?.path) {
      return resolveGuideRootFromConfig(block.guideDocset.path);
    }
  }
  return null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function setupGuideRoutes(app) {
  app.get('/protoclaw/guide_doc', async (req, res, next) => {
    try {
      if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
        res.status(400).json({ ok: false, error: 'agentId is required' });
        return;
      }
      const rootAbs = await resolveGuideRootForAgent(req.query.agentId);
      if (!rootAbs) {
        res.status(404).json({ ok: false, error: 'No guide root configured for this agent' });
        return;
      }
      const target = await resolveGuideFileWithinRoot(rootAbs, req.query.doc);
      if (!target || !target.relative.toLowerCase().endsWith('.md')) {
        res.status(404).json({ ok: false, error: 'Document not found' });
        return;
      }
      let source;
      try {
        source = await fs.readFile(target.absolute, 'utf8');
      } catch {
        res.status(404).json({ ok: false, error: 'Document not found' });
        return;
      }
      const { attrs, body } = stripGuideFrontmatter(source);
      res.json({
        ok: true,
        doc: {
          path: target.relative,
          title: attrs.title || extractGuideTitle(body) || path.basename(target.relative).replace(/\.md$/i, ''),
          content: body,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/guide_asset', async (req, res, next) => {
    try {
      if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      const rootAbs = await resolveGuideRootForAgent(req.query.agentId);
      if (!rootAbs) {
        res.status(404).json({ error: 'No guide root configured for this agent' });
        return;
      }
      const target = await resolveGuideFileWithinRoot(rootAbs, req.query.path);
      if (!target) {
        res.status(403).json({ error: 'Path outside guide root' });
        return;
      }
      const extension = path.extname(target.absolute).toLowerCase();
      const contentType = GUIDE_ASSET_EXTENSIONS[extension];
      if (!contentType) {
        res.status(415).json({ error: `Unsupported asset type: ${extension || '(none)'}` });
        return;
      }
      const body = await fs.readFile(target.absolute).catch(() => null);
      if (!body) {
        res.status(404).json({ error: 'Asset not found' });
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', body.length);
      // SVG/PDF 可内嵌脚本，直接导航时会在 Claw 同源执行：sandbox 掉脚本能力
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (contentType === 'image/svg+xml' || contentType === 'application/pdf') {
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      }
      res.status(200).end(body);
    } catch (error) {
      next(error);
    }
  });
}
