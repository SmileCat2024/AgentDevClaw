/**
 * Tests for server/routes/agentero.js（只读数据面）
 *
 * 覆盖：
 * 1. resolveAgenteroVaultPath — agent 层覆盖全局层 / 未配置 / 空串忽略
 * 2. listAgenteroPapers — 全量、q 筛选、*_json 字段解析、vault 缺失错误码
 * 3. 路由 handler — status（未配置 / 已配置含计数）、papers（成功 / 未配置 409 信封）
 *
 * fixture：临时目录构造最小 catalog.sqlite（真实 schema 子集），不读真实
 * 用户数据目录。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';

import {
  setupAgenteroRoutes,
  resolveAgenteroVaultPath,
  listAgenteroPapers,
  getAgenteroPaper,
  resolveAgenteroPaperPdf,
} from '../server/routes/agentero.js';

// ── fixture：临时 vault（papers 表最小列集） ───────────────────────

function createFixtureVault() {
  const root = mkdtempSync(join(tmpdir(), 'agentero-routes-'));
  const vault = join(root, 'vault');
  mkdirSync(join(vault, '.agentero'), { recursive: true });
  mkdirSync(join(vault, 'papers', '2401.00001'), { recursive: true });
  writeFileSync(join(vault, 'papers', '2401.00001', '2401.00001.pdf'), Buffer.from('%PDF-1.4\\nfixture pdf bytes'));
  const db = new DatabaseSync(join(vault, '.agentero', 'catalog.sqlite'));
  db.exec(`
    CREATE TABLE papers (
      id TEXT, path TEXT, title TEXT, authors_json TEXT, year INTEGER,
      tags_json TEXT, is_read INTEGER, date TEXT, added_at TEXT,
      abstract TEXT, doi TEXT, arxiv_id TEXT
    );
    INSERT INTO papers VALUES
      ('2401.00001', 'papers/2401.00001', 'Attention Is All You Need',
       '["Ashish Vaswani","Noam Shazeer"]', 2017, '["transformer","attention"]', 1, NULL, '2026-01-03T00:00:00Z', 'We propose an attention mechanism.', '10.1000/test', '2401.00001'),
      ('2401.00002', 'papers/2401.00002', 'Language Models are Few-Shot Learners',
       '["Tom Brown"]', 2020, '[]', 0, NULL, '2026-01-02T00:00:00Z', 'A study of few-shot learning.', NULL, '2005.14165'),
      ('2401.00003', 'papers/2401.00003', 'GPT-4 Technical Report',
       '["OpenAI"]', 2024, '["report"]', 0, NULL, '2026-01-01T00:00:00Z', 'Technical report abstract.', NULL, '2303.08774');
  `);
  db.close();
  return { root, vault };
}

// ── mock express ───────────────────────────────────────────────────

function createMockApp() {
  const handlers = new Map();
  const app = {
    get(route, handler) { handlers.set(route, handler); },
  };
  return { app, handlers };
}

function createMockPdfRes() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  const res = writable;
  res.statusCode = 200;
  res.headersSent = false;
  res.contentType = '';
  // Model the application-wide anti-framing middleware that runs before routes.
  res.headers = {
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none';",
  };
  res.type = function type(value) { this.contentType = value; return this; };
  res.set = function set(name, value) { this.headers[name.toLowerCase()] = value; return this; };
  res.removeHeader = function removeHeader(name) { delete this.headers[name.toLowerCase()]; return this; };
  res.status = function status(code) { this.statusCode = code; return this; };
  res.json = function json(value) { this.body = value; return this; };
  res.finishedBody = new Promise((resolve) => res.once('finish', resolve));
  res.on('finish', () => { res.body = Buffer.concat(chunks); });
  return res;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

// ── tests ──────────────────────────────────────────────────────────

describe('resolveAgenteroVaultPath', () => {
  it('returns null when neither layer configures it', () => {
    assert.equal(resolveAgenteroVaultPath({ globalLayer: {}, agentLayer: {} }), null);
    assert.equal(resolveAgenteroVaultPath({}), null);
  });

  it('reads global layer and lets agent layer override', () => {
    const globalLayer = { agentero: { vaultPath: 'C:/global-vault' } };
    assert.equal(resolveAgenteroVaultPath({ globalLayer, agentLayer: {} }), 'C:/global-vault');
    const agentLayer = { agentero: { vaultPath: 'C:/agent-vault' } };
    assert.equal(resolveAgenteroVaultPath({ globalLayer, agentLayer }), 'C:/agent-vault');
  });

  it('ignores blank vaultPath and non-object entries', () => {
    assert.equal(
      resolveAgenteroVaultPath({ globalLayer: { agentero: { vaultPath: '  ' } }, agentLayer: {} }),
      null,
    );
    assert.equal(resolveAgenteroVaultPath({ globalLayer: { agentero: 'enabled' }, agentLayer: {} }), null);
  });
});

describe('listAgenteroPapers', () => {
  let fixture;

  beforeEach(() => { fixture = createFixtureVault(); });
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); });

  it('lists all papers newest-first with parsed array fields', () => {
    const rows = listAgenteroPapers(fixture.vault);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, '2401.00001'); // added_at DESC
    assert.deepEqual(rows[0].authors, ['Ashish Vaswani', 'Noam Shazeer']);
    assert.deepEqual(rows[0].tags, ['transformer', 'attention']);
    assert.equal(rows[0].is_read, true);
    assert.equal(rows[1].is_read, false);
  });

  it('filters by q across title/authors/tags', () => {
    const byTitle = listAgenteroPapers(fixture.vault, 'few-shot');
    assert.equal(byTitle.length, 1);
    assert.equal(byTitle[0].id, '2401.00002');

    const byAuthor = listAgenteroPapers(fixture.vault, 'OpenAI');
    assert.equal(byAuthor.length, 1);
    assert.equal(byAuthor[0].id, '2401.00003');

    const byTag = listAgenteroPapers(fixture.vault, 'attention');
    assert.equal(byTag.length, 1);
    assert.equal(byTag[0].id, '2401.00001');
  });

  it('loads abstract metadata by paper id and resolves the stored PDF inside the vault', () => {
    const paper = getAgenteroPaper(fixture.vault, '2401.00001');
    assert.equal(paper.title, 'Attention Is All You Need');
    assert.equal(paper.pdfAvailable, true);
    assert.equal(paper.abstract, 'We propose an attention mechanism.');
    assert.equal(paper.doi, '10.1000/test');
    assert.equal(resolveAgenteroPaperPdf(fixture.vault, '2401.00001'), join(fixture.vault, 'papers', '2401.00001', '2401.00001.pdf'));
    assert.equal(resolveAgenteroPaperPdf(fixture.vault, 'papers/2401.00001'), join(fixture.vault, 'papers', '2401.00001', '2401.00001.pdf'));
  });

  it('rejects invalid and missing PDF references', () => {
    assert.throws(() => resolveAgenteroPaperPdf(fixture.vault, '../secret'), (err) => err.code === 'invalid-paper-ref');
    assert.throws(() => resolveAgenteroPaperPdf(fixture.vault, '2401.99999'), (err) => err.code === 'pdf-not-found');
  });

  it('throws vault-not-found for a vault without catalog', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agentero-empty-'));
    try {
      assert.throws(() => listAgenteroPapers(empty), (err) => err.code === 'vault-not-found');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('routes', () => {
  let fixture;

  beforeEach(() => { fixture = createFixtureVault(); });
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); });

  function setupWithLayers(layers) {
    const { app, handlers } = createMockApp();
    setupAgenteroRoutes(app, { readLayers: () => layers });
    return handlers;
  }

  it('status reports unconfigured vault when layers are empty', () => {
    const handlers = setupWithLayers({ globalLayer: {}, agentLayer: {} });
    const res = createMockRes();
    handlers.get('/protoclaw/agentero/status')({}, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, data: { configured: false, vaultPath: null, name: null, canPick: false } });
  });

  it('status reports configured vault with paper count', () => {
    const handlers = setupWithLayers({
      globalLayer: {},
      agentLayer: { agentero: { vaultPath: fixture.vault } },
    });
    const res = createMockRes();
    handlers.get('/protoclaw/agentero/status')({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.configured, true);
    assert.equal(res.body.data.catalogOk, true);
    assert.equal(res.body.data.paperCount, 3);
    assert.equal(res.body.data.canPick, false);
  });

  it('paper detail route returns abstract metadata and PDF route streams the actual PDF', async () => {
    const handlers = setupWithLayers({
      globalLayer: {},
      agentLayer: { agentero: { vaultPath: fixture.vault } },
    });
    const detailRes = createMockRes();
    handlers.get('/protoclaw/agentero/papers/:paperRef')({ params: { paperRef: '2401.00001' } }, detailRes);
    assert.equal(detailRes.body.data.title, 'Attention Is All You Need');
    assert.equal(detailRes.body.data.abstract, 'We propose an attention mechanism.');
    assert.equal(detailRes.body.data.pdfAvailable, true);

    const pdfRes = createMockPdfRes();
    handlers.get('/protoclaw/agentero/papers/:paperRef/pdf')({ params: { paperRef: '2401.00001' } }, pdfRes);
    await pdfRes.finishedBody;
    assert.equal(pdfRes.contentType, 'application/pdf');
    assert.equal(pdfRes.headers['x-frame-options'], undefined, 'PDF must not inherit DENY when embedded by the same-origin reader');
    assert.equal(pdfRes.headers['content-security-policy'], "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'self'; frame-ancestors 'self'; base-uri 'self';");
    assert.equal(pdfRes.headers['x-frame-options'], undefined, 'PDF must not inherit DENY when embedded by the same-origin reader');
    assert.ok(pdfRes.body.toString('utf8').startsWith('%PDF-1.4'));
  });

  it('papers returns CLI-shaped envelope with rows', () => {
    const handlers = setupWithLayers({
      globalLayer: { agentero: { vaultPath: fixture.vault } },
      agentLayer: {},
    });
    const res = createMockRes();
    handlers.get('/protoclaw/agentero/papers')({ query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.length, 3);
    assert.equal(res.body.data[0].title, 'Attention Is All You Need');
  });

  it('papers passes q through and filters', () => {
    const handlers = setupWithLayers({
      globalLayer: { agentero: { vaultPath: fixture.vault } },
      agentLayer: {},
    });
    const res = createMockRes();
    handlers.get('/protoclaw/agentero/papers')({ query: { q: 'GPT-4' } }, res);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].id, '2401.00003');
  });

  it('papers responds 409 CLI-shaped error when unconfigured', () => {
    const handlers = setupWithLayers({ globalLayer: {}, agentLayer: {} });
    const res = createMockRes();
    handlers.get('/protoclaw/agentero/papers')({ query: {} }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'vault-not-configured');
  });
});
