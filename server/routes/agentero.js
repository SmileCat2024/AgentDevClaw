/**
 * Agentero 数据面路由（只读）
 *
 * 对接 Agentero 研究 vault（本对接 = ADR-0044 P6 样本，仓库内集成三件套之一）。
 * 数据真相：`{vault}/.agentero/catalog.sqlite`（官方 CLI 写入，schema 见
 * agentero CLI `paper list` 的字段清单）。本模块 node:sqlite 只读直查，
 * 不写、不建索引、不缓存句柄（低频面板查询，每次开关节点句柄最安全）。
 *
 * 返回信封对齐 agentero CLI `--json` 形态（`{ok:true, data}` /
 * `{ok:false, error:{code, message}}`）——dsh 侧面板的解析层按该形态宽容
 * 解析（papers.ts 的 paperItems），shim 只需指 URL，无需字段翻译。
 *
 * vault 路径解析：feature 配置 `agentero.vaultPath`，agent 层覆盖全局层
 * （server 侧只消费两层；目录/项目层属会话上下文，由 runtime 侧 feature
 * 消费）。未配置时 status 暴露 configured:false，papers 返回
 * vault-not-configured（面板据此走 vaultMissing 态）。
 *
 * 写操作（import/tags/delete/discover 等）刻意不提供：面板侧由 shim 裁剪；
 * Agent 侧写需求经 local-feature 的 CLI 子进程走官方契约。
 */

import path from 'path';
import { createReadStream, existsSync, realpathSync, statSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

import { readGlobalLayer, readAgentLayer } from '../shared/feature-config-layers.js';

const FEATURE_KEY = 'agentero';
const CATALOG_RELATIVE = path.join('.agentero', 'catalog.sqlite');
const PAPER_DETAIL_COLUMNS = 'id, path, title, authors_json, year, abstract, tags_json, is_read, date, doi, arxiv_id';
const PDF_MIME = 'application/pdf';

/** 列表行字段（CLI `paper list` 同款精简集，authors/tags 解析为数组）。 */
const LIST_COLUMNS = 'id, path, title, authors_json, year, tags_json, is_read, date, added_at';

// ── vault 路径与查询（导出供测试） ─────────────────────────────────

/** 解析生效 vault 路径：agent 层覆盖全局层；未配置返回 null。 */
export function resolveAgenteroVaultPath({ globalLayer, agentLayer } = {}) {
  const readLayer = (layer) => {
    const entry = layer?.[FEATURE_KEY];
    if (entry && typeof entry === 'object' && typeof entry.vaultPath === 'string' && entry.vaultPath.trim() !== '') {
      return entry.vaultPath.trim();
    }
    return null;
  };
  return readLayer(agentLayer) ?? readLayer(globalLayer);
}

/**
 * 只读查询论文列表。返回 CLI 同款行数组；q 为空返回全量。
 * 抛错语义：未配置（Error.code='vault-not-configured'）、文件缺失
 * （'vault-not-found'）、查询失败（'catalog-error'，含 cause）。
 */
export function listAgenteroPapers(vaultPath, q = '') {
  const catalogPath = path.join(vaultPath, CATALOG_RELATIVE);
  if (!existsSync(catalogPath)) {
    const error = new Error(`catalog not found under vault: ${vaultPath}`);
    error.code = 'vault-not-found';
    throw error;
  }
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  try {
    let rows;
    if (q && q.trim() !== '') {
      const like = `%${q.trim()}%`;
      rows = db.prepare(
        `SELECT ${LIST_COLUMNS} FROM papers
         WHERE title LIKE ? OR authors_json LIKE ? OR tags_json LIKE ?
         ORDER BY added_at DESC`
      ).all(like, like, like);
    } else {
      rows = db.prepare(`SELECT ${LIST_COLUMNS} FROM papers ORDER BY added_at DESC`).all();
    }
    return rows.map(clipRow);
  } catch (err) {
    const error = new Error(`catalog query failed: ${err?.message || err}`);
    error.code = 'catalog-error';
    error.cause = err;
    throw error;
  } finally {
    db.close();
  }
}

/** 查询单篇论文详情（摘要等元数据）；PDF 文件通过独立流式路由提供。 */
export function getAgenteroPaper(vaultPath, paperRef) {
  const catalogPath = path.join(vaultPath, CATALOG_RELATIVE);
  if (!existsSync(catalogPath)) {
    const error = new Error(`catalog not found under vault: ${vaultPath}`);
    error.code = 'vault-not-found';
    throw error;
  }
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT ${PAPER_DETAIL_COLUMNS} FROM papers WHERE id = ? OR path = ? LIMIT 1`).get(paperRef, paperRef);
    if (!row) {
      const error = new Error('paper not found');
      error.code = 'paper-not-found';
      throw error;
    }
    let pdfAvailable = false;
    try {
      resolveAgenteroPaperPdf(vaultPath, row.id);
      pdfAvailable = true;
    } catch (err) {
      if (err?.code !== 'pdf-not-found') throw err;
    }
    return {
      ...clipRow(row),
      abstract: typeof row.abstract === 'string' ? row.abstract : '',
      doi: typeof row.doi === 'string' ? row.doi : null,
      arxiv_id: typeof row.arxiv_id === 'string' ? row.arxiv_id : null,
      pdfAvailable,
    };
  } catch (err) {
    if (err?.code === 'paper-not-found') throw err;
    const error = new Error(`catalog query failed: ${err?.message || err}`);
    error.code = 'catalog-error';
    error.cause = err;
    throw error;
  } finally {
    db.close();
  }
}

/**
 * 解析 catalog 内 paper.path 对应的 PDF，只允许 vault/papers/<id> 下的 PDF。
 * realpath 检查拒绝符号链接逃逸；文件名固定使用目录名，不能由请求传路径。
 */
export function resolveAgenteroPaperPdf(vaultPath, paperRef) {
  if (typeof paperRef !== 'string' || paperRef.length > 300 || !/^(?:papers\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(paperRef)) {
    const error = new Error('invalid paper reference');
    error.code = 'invalid-paper-ref';
    throw error;
  }
  const id = paperRef.startsWith('papers/') ? paperRef.slice('papers/'.length) : paperRef;
  const paperDir = path.resolve(vaultPath, 'papers', id);
  const expectedRoot = path.resolve(vaultPath, 'papers');
  const pdfPath = path.join(paperDir, `${id}.pdf`);
  let realRoot;
  let realDir;
  let realPdf;
  try {
    realRoot = realpathSync(expectedRoot);
    realDir = realpathSync(paperDir);
    realPdf = realpathSync(pdfPath);
  } catch {
    const error = new Error('paper PDF not found');
    error.code = 'pdf-not-found';
    throw error;
  }
  if (!realDir.startsWith(realRoot + path.sep) || !realPdf.startsWith(realDir + path.sep)) {
    const error = new Error('paper PDF path is outside the vault');
    error.code = 'invalid-paper-path';
    throw error;
  }
  const stat = statSync(realPdf);
  if (!stat.isFile()) {
    const error = new Error('paper PDF not found');
    error.code = 'pdf-not-found';
    throw error;
  }
  return realPdf;
}

/** sqlite 行 → CLI JSON 行：authors/tags 的 *_json 解析为数组，其余原样。 */
function clipRow(row) {
  const out = {
    id: row.id,
    path: row.path,
    title: row.title,
    authors: parseJsonArrayField(row.authors_json),
    tags: parseJsonArrayField(row.tags_json),
    year: row.year ?? null,
    is_read: row.is_read === 1,
    date: row.date ?? null,
  };
  return out;
}

/** JSON 数组字段宽容解析：解析失败回空数组（面板 tagsFrom/authorsText 均能吃）。 */
function parseJsonArrayField(value) {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── 路由注册 ───────────────────────────────────────────────────────

/** HTTP 信封错误写入（状态码 + CLI 同款 error 形态）。 */
function sendEnvelopeError(res, statusCode, code, message) {
  if (res.headersSent) return;
  res.status(statusCode).json({ ok: false, error: { code, message } });
}

/**
 * 路由装配。deps.readLayers 可注入（测试隔离）；默认读真实配置层
 * （agent 层覆盖全局层，与 feature 配置语义一致）。
 */
export function setupAgenteroRoutes(app, deps = {}) {
  const readLayers = deps.readLayers || (() => ({ globalLayer: readGlobalLayer(), agentLayer: readAgentLayer() }));
  const resolveCurrentVaultPath = () => resolveAgenteroVaultPath(readLayers());

  // vault 状态：面板 loadVault 消费。canPick:false——目录选择器属宿主能力，
  // 第一方集成不暴露；未配置时面板走 vaultMissing 文案态。
  app.get('/protoclaw/agentero/status', (_req, res) => {
    const vaultPath = resolveCurrentVaultPath();
    if (!vaultPath) {
      res.json({ ok: true, data: { configured: false, vaultPath: null, name: null, canPick: false } });
      return;
    }
    const catalogPath = path.join(vaultPath, CATALOG_RELATIVE);
    if (!existsSync(catalogPath)) {
      res.json({
        ok: true,
        data: { configured: true, vaultPath, name: path.basename(vaultPath), catalogOk: false, canPick: false },
      });
      return;
    }
    let paperCount = null;
    try {
      const db = new DatabaseSync(catalogPath, { readOnly: true });
      try {
        paperCount = db.prepare('SELECT COUNT(*) AS n FROM papers').get().n;
      } finally {
        db.close();
      }
    } catch {
      // 计数失败不阻塞 status（保持 null），列表端点会给完整错误
    }
    res.json({
      ok: true,
      data: { configured: true, vaultPath, name: path.basename(vaultPath), catalogOk: true, paperCount, canPick: false },
    });
  });

  app.get('/protoclaw/agentero/papers/:paperRef/pdf', (req, res) => {
    const vaultPath = resolveCurrentVaultPath();
    if (!vaultPath) {
      sendEnvelopeError(res, 409, 'vault-not-configured', 'Agentero vault is not configured');
      return;
    }
    try {
      const pdfPath = resolveAgenteroPaperPdf(vaultPath, req.params.paperRef);
      // The global app policy denies all framing. This PDF response alone allows
      // same-origin embedding; the document-wide policy remains unchanged.
      res.removeHeader('X-Frame-Options');
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'self'; frame-ancestors 'self'; base-uri 'self';");
      res.type(PDF_MIME);
      res.set('Content-Disposition', 'inline');
      res.set('X-Content-Type-Options', 'nosniff');
      createReadStream(pdfPath).on('error', () => {
        if (!res.headersSent) sendEnvelopeError(res, 404, 'pdf-not-found', 'Paper PDF not found');
        else res.destroy();
      }).pipe(res);
    } catch (err) {
      const code = err?.code === 'invalid-paper-ref' || err?.code === 'invalid-paper-path' ? 400
        : err?.code === 'pdf-not-found' ? 404 : 500;
      sendEnvelopeError(res, code, err?.code || 'pdf-error', err?.message || String(err));
    }
  });

  app.get('/protoclaw/agentero/papers/:paperRef', (req, res) => {
    const vaultPath = resolveCurrentVaultPath();
    if (!vaultPath) {
      sendEnvelopeError(res, 409, 'vault-not-configured', 'Agentero vault is not configured');
      return;
    }
    try {
      res.json({ ok: true, data: getAgenteroPaper(vaultPath, req.params.paperRef) });
    } catch (err) {
      const code = err?.code === 'paper-not-found' ? 404 : err?.code === 'vault-not-found' ? 404 : 500;
      sendEnvelopeError(res, code, err?.code || 'catalog-error', err?.message || String(err));
    }
  });

  // 论文列表（CLI `paper list` 同款信封）。q：标题/作者/标签子串筛选。
  app.get('/protoclaw/agentero/papers', (req, res) => {
    const vaultPath = resolveCurrentVaultPath();
    if (!vaultPath) {
      sendEnvelopeError(res, 409, 'vault-not-configured', 'Agentero vault is not configured (feature config agentero.vaultPath)');
      return;
    }
    try {
      const q = typeof req.query?.q === 'string' ? req.query.q : '';
      res.json({ ok: true, data: listAgenteroPapers(vaultPath, q) });
    } catch (err) {
      const code = err?.code === 'vault-not-found' ? 404 : 500;
      sendEnvelopeError(res, code, err?.code || 'catalog-error', err?.message || String(err));
    }
  });
}
