/**
 * 工具结果行的图片附件：渲染 / 懒加载属性 / 末行 patch 同步。
 *
 * 装载路线（P4 T2 批次）：chat-renderer 已迁 ESM——前两条仍是源码契约断言
 * （直接读文件），第三条改真实 import 调 `syncMessageImages`（原先把该函数切片
 * 进 vm 并替换 renderUserImages 桩；迁 ESM 后模块内部实现不可替换，改成断言真实
 * 渲染产物里的图片 URL 与容器类名）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';
const rendererSource = fs.readFileSync(
  new URL('../public/src/modules/chat-renderer.js', import.meta.url),
  'utf8',
);

function makeDocument() {
  const element = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; }, remove() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  return {
    getElementById: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => element(),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: element(), head: element(), documentElement: element(),
  };
}

test('appended tool result rows render their image attachments', () => {
  const start = rendererSource.indexOf("} else if (msg.role === 'tool') {");
  const end = rendererSource.indexOf('// 追加到容器', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(rendererSource.slice(start, end), /renderUserImages\(msg\.images\)/);
});

test('chat image thumbnails defer loading and decoding', () => {
  const start = rendererSource.indexOf('function renderUserImages(images) {');
  const end = rendererSource.indexOf('/**', start);
  const imageRenderer = rendererSource.slice(start, end);
  assert.match(imageRenderer, /loading="lazy"/);
  assert.match(imageRenderer, /decoding="async"/);
});

test('last-message patch synchronizes tool result images into the existing row', async () => {
  await withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
    },
    globals: {
      document: makeDocument(),
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
      createPollCoordinatorHost: () => ({
        run: () => Promise.resolve(),
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
    },
  }, async (c) => {
    const renderer = await c.load(CHAT_RENDERER);
    const inserted = [];
    const row = {
      querySelector(selector) {
        if (selector === '.message-images') return null;
        if (selector === '.message-content') {
          return { insertAdjacentHTML: (position, html) => inserted.push({ position, html }) };
        }
        return null;
      },
    };

    renderer.syncMessageImages(row, [{ path: 'managed.png' }]);
    assert.equal(inserted.length, 1, 'image container is inserted once');
    assert.equal(inserted[0].position, 'afterend');
    assert.match(inserted[0].html, /message-images/);
    assert.match(inserted[0].html, /managed\.png/, 'thumbnail URL derives from the attachment path');
  });
});
