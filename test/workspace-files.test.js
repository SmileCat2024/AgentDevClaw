import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import express from 'express';
import { once } from 'node:events';
import { createWorkspaceFileService, setupWorkspaceFileRoutes } from '../server/routes/workspace-files.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-workspace-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'export const answer = 42;');
  await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'photo.avif'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'doc.pdf'), Buffer.from('%PDF-1.4'));
  await fs.writeFile(path.join(root, 'clip.mp4'), Buffer.from([0, 0, 0, 24]));
  await fs.writeFile(path.join(root, 'tone.mp3'), Buffer.from([0xFF, 0xFB]));
  await fs.writeFile(path.join(root, 'data.csv'), 'name,value\nalpha,1\nbeta,"two, part"');
  await fs.writeFile(path.join(root, 'page.html'), '<!doctype html><p>hi</p>');
  await fs.writeFile(path.join(root, 'note.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await fs.writeFile(path.join(root, 'sheet.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const service = createWorkspaceFileService({ resolveRoot: async (agentId, sessionId) => {
    assert.equal(agentId, 'programming-helper');
    assert.equal(sessionId, 'session-1');
    return { root };
  } });
  return { root, service };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('HTTP routes parse session identity and return the authorized directory listing', async t => {
  const { root } = await fixture(t);
  const app = express();
  setupWorkspaceFileRoutes(app, { resolveRoot: async (agentId, sessionId) => {
    assert.equal(agentId, 'programming-helper');
    assert.equal(sessionId, 'session-1');
    return { root };
  } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const { port } = server.address();
  const request = (action, filePath) => fetch(`http://127.0.0.1:${port}/protoclaw/workspace-files/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'programming-helper', sessionId: 'session-1', path: filePath }),
  });
  const listing = await request('list', '');
  assert.equal(listing.status, 200);
  assert.deepEqual((await listing.json()).entries.map(entry => entry.name), [
    'src', 'blob.bin', 'clip.mp4', 'data.csv', 'doc.pdf', 'image.png', 'note.docx', 'page.html', 'photo.avif', 'sheet.xlsx', 'tone.mp3',
  ]);
  const file = await request('read', 'src/main.js');
  assert.equal(file.status, 200);
  assert.match((await file.json()).content, /answer = 42/);
  const pdf = await request('read', 'doc.pdf');
  assert.equal(pdf.status, 200);
  assert.equal((await pdf.json()).kind, 'pdf');
});

test('lists only direct children and identifies directories and previewable files', async t => {
  const { service } = await fixture(t);
  const res = response();
  await service.list({ agentId: 'programming-helper', sessionId: 'session-1', path: '' }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.entries.map(item => [item.name, item.kind, item.supported]), [
    ['src', 'directory', undefined],
    ['blob.bin', 'file', false],
    ['clip.mp4', 'file', true],
    ['data.csv', 'file', true],
    ['doc.pdf', 'file', true],
    ['image.png', 'file', true],
    ['note.docx', 'file', true],
    ['page.html', 'file', true],
    ['photo.avif', 'file', true],
    ['sheet.xlsx', 'file', true],
    ['tone.mp3', 'file', true],
  ]);
});

test('reads text and image files by preview kind and rejects unsupported or oversized content', async t => {
  const { root, service } = await fixture(t);
  const text = response();
  await service.read({ agentId: 'programming-helper', sessionId: 'session-1', path: 'src/main.js' }, text);
  assert.equal(text.body.kind, 'text');
  assert.match(text.body.content, /answer = 42/);
  const image = response();
  await service.read({ agentId: 'programming-helper', sessionId: 'session-1', path: 'image.png' }, image);
  assert.equal(image.statusCode, 200);
  assert.equal(image.body.kind, 'image');
  assert.equal(image.body.mimeType, 'image/png');
  assert.match(image.body.dataUrl, /^data:image\/png;base64,/);
  const unsupported = response();
  await service.read({ agentId: 'programming-helper', sessionId: 'session-1', path: 'blob.bin' }, unsupported);
  assert.equal(unsupported.statusCode, 400);
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
  const large = response();
  await service.read({ agentId: 'programming-helper', sessionId: 'session-1', path: 'large.txt' }, large);
  assert.equal(large.body.error, 'file_too_large');
});

test('reads csv and html as text and pdf/video/audio as raw-url handshake', async t => {
  const { service } = await fixture(t);
  const cases = [
    { path: 'data.csv', kind: 'text', expect: body => assert.match(body.content, /"two, part"/) },
    { path: 'page.html', kind: 'text', expect: body => assert.match(body.content, /doctype html/) },
    { path: 'photo.avif', kind: 'image', expect: body => assert.equal(body.mimeType, 'image/avif') },
    { path: 'doc.pdf', kind: 'pdf', expect: body => { assert.equal(body.mimeType, 'application/pdf'); assert.equal(body.dataUrl, undefined); } },
    { path: 'clip.mp4', kind: 'video', expect: body => { assert.equal(body.mimeType, 'video/mp4'); assert.equal(body.dataUrl, undefined); } },
    { path: 'tone.mp3', kind: 'audio', expect: body => { assert.equal(body.mimeType, 'audio/mpeg'); assert.equal(body.dataUrl, undefined); } },
    { path: 'note.docx', kind: 'docx', expect: body => {
      assert.equal(body.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      assert.equal(body.content, undefined); assert.equal(body.dataUrl, undefined);
    } },
    { path: 'sheet.xlsx', kind: 'xlsx', expect: body => {
      assert.equal(body.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.equal(body.content, undefined); assert.equal(body.dataUrl, undefined);
    } },
  ];
  for (const item of cases) {
    const res = response();
    await service.read({ agentId: 'programming-helper', sessionId: 'session-1', path: item.path }, res);
    assert.equal(res.statusCode, 200, item.path);
    assert.equal(res.body.kind, item.kind, item.path);
    item.expect(res.body);
  }
});

test('raw endpoint streams media bytes with fixed content type and rejects non-media kinds', async t => {
  const { root } = await fixture(t);
  const app = express();
  setupWorkspaceFileRoutes(app, { resolveRoot: async () => ({ root }) });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const { port } = server.address();
  const params = new URLSearchParams({ agentId: 'programming-helper', sessionId: 'session-1', path: 'doc.pdf' });
  const pdf = await fetch(`http://127.0.0.1:${port}/protoclaw/workspace-files/raw?${params}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  // 嵌框例外契约：仅允许自身源嵌框（供应用内 PDF 查看器），不放开外站
  assert.equal(pdf.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(pdf.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(await pdf.text(), await fs.readFile(path.join(root, 'doc.pdf'), 'utf8'));
  const textParams = new URLSearchParams({ agentId: 'programming-helper', sessionId: 'session-1', path: 'data.csv' });
  const text = await fetch(`http://127.0.0.1:${port}/protoclaw/workspace-files/raw?${textParams}`);
  assert.equal(text.status, 400);
  // office 字节流经 raw 端点输出（前端 fetch arrayBuffer 交给渲染库）
  const docxParams = new URLSearchParams({ agentId: 'programming-helper', sessionId: 'session-1', path: 'note.docx' });
  const docx = await fetch(`http://127.0.0.1:${port}/protoclaw/workspace-files/raw?${docxParams}`);
  assert.equal(docx.status, 200);
  assert.equal(docx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.deepEqual(Buffer.from(await docx.arrayBuffer()), await fs.readFile(path.join(root, 'note.docx')));
});

test('rejects traversal, absolute paths and symlinks leaving the workspace', async t => {
  const { root, service } = await fixture(t);
  for (const candidate of ['../outside.txt', path.join(root, 'src', 'main.js')]) {
    const res = response();
    await service.read({ agentId: 'programming-helper', sessionId: 'session-1', path: candidate }, res);
    assert.equal(res.statusCode, 400);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
  try {
    await fs.symlink(outside, path.join(root, 'escape'), 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlink creation requires elevated Windows permissions');
    throw error;
  }
  const res = response();
  await service.list({ agentId: 'programming-helper', sessionId: 'session-1', path: 'escape' }, res);
  assert.equal(res.statusCode, 403);
});
