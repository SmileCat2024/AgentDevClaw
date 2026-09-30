import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const rendererSource = fs.readFileSync(
  new URL('../public/src/modules/chat-renderer.js', import.meta.url),
  'utf8',
);

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

test('last-message patch synchronizes tool result images into the existing row', () => {
  const ctx = createFrontendSandbox({
    renderUserImages: (images) => images?.length ? '<div class="message-images">preview</div>' : '',
  });
  vm.runInContext(sourceBetween(rendererSource, 'function syncMessageImages(', 'function updateLastMessage('), ctx);

  ctx.inserted = [];
  ctx.row = {
    querySelector(selector) {
      if (selector === '.message-images') return null;
      if (selector === '.message-content') {
        return { insertAdjacentHTML: (position, html) => ctx.inserted.push({ position, html }) };
      }
      return null;
    },
  };

  ctx.syncImagesForTest = () => ctx.run("syncMessageImages(row, [{ path: 'managed.png' }])");
  ctx.run('syncImagesForTest()');
  assert.equal(ctx.inserted.length, 1);
  assert.equal(ctx.inserted[0].position, 'afterend');
  assert.match(ctx.inserted[0].html, /message-images/);
});
