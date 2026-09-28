import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

function harness() {
  const ctx = createFrontendSandbox({
    _userExpandedMsgs: new Set(),
    applyTemplate: (template, data, success, args) => template(data, success, args),
    renderJsonHighlight: data => JSON.stringify(data),
  });
  const source = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
  vm.runInContext(sourceBetween(source, 'function renderToolResultBody(', '// 生成单条消息的 HTML'), ctx);
  ctx.template = { result: data => data.content || JSON.stringify(data) };
  ctx.args = {};
  ctx.data = { type: 'file', offset: 201, path: 'test.js', content: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') };
  return ctx;
}

test('long Read shows a bounded preview, expands fully and releases the full body on collapse without mutating data', () => {
  const ctx = harness();
  const original = ctx.data.content;
  const preview = ctx.run('renderToolResultBody("read", template, data, true, args, 3)');
  assert.ok(preview.includes('tool-read-preview'));
  assert.ok(preview.includes('line 7'));
  assert.ok(!preview.includes('line 8'));
  assert.equal(ctx.data.content, original);
  assert.equal(ctx.data.offset, 201);
  ctx._userExpandedMsgs.add(3);
  assert.equal(ctx.run('renderToolResultBody("read", template, data, true, args, 3)'), original);
  ctx._userExpandedMsgs.delete(3);
  assert.equal(ctx.run('renderToolResultBody("read", template, data, true, args, 3)'), preview);
});

test('tool-call lookup indexes a long transcript once and retains first matching call', () => {
  const ctx = createFrontendSandbox();
  const source = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
  vm.runInContext(sourceBetween(source, 'function indexToolCalls(', '// 追加新消息'), ctx);
  let reads = 0;
  const messages = Array.from({ length: 400 }, (_, i) => ({
    get toolCalls() { reads++; return [{ id: `call-${i}`, name: 'read', arguments: { index: i } }]; },
  }));
  messages.push({ toolCalls: [{ id: 'call-0', name: 'bash', arguments: {} }] });
  ctx.messages = messages;
  const calls = ctx.run('indexToolCalls(messages)');
  for (let i = 0; i < 400; i++) assert.equal(calls.get(`call-${i}`).arguments.index, i);
  assert.equal(calls.get('call-0').name, 'read');
  assert.equal(reads, 400);
});

test('short Read, directories, errors and other tools retain their complete result', () => {
  const ctx = harness();
  assert.equal(ctx.run('renderToolResultBody("bash", template, data, true, args, 3)'), ctx.data.content);
  assert.equal(ctx.run('renderToolResultBody("read", template, data, false, args, 3)'), ctx.data.content);
  ctx.data.type = 'directory';
  assert.equal(ctx.run('renderToolResultBody("read", template, data, true, args, 3)'), ctx.data.content);
  ctx.data.type = 'file'; ctx.data.content = 'a\nb';
  assert.equal(ctx.run('renderToolResultBody("read", template, data, true, args, 3)'), 'a\nb');
});
