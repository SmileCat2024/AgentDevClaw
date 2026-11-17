/**
 * renderToolResultBody：长 Read 结果的有界预览与展开语义；indexToolCalls 的单趟索引。
 *
 * 装载路线（P4 T2 批次）：chat-renderer 已迁 ESM，改真实 import（withP2EsmCase，
 * 每 case 一张模块图）。模块依赖 applyTemplate / renderJsonHighlight（template-engine
 * 真实实现）与 chatSurface 的折叠偏好宿主——用例把模板写成真实函数形态，
 * 折叠偏好经 app-core 的 host seam 读写，与生产同一条路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';

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

async function withRenderer(fn) {
  return withP2EsmCase({
    classic: (sandbox) => {
      // chat-renderer 的 import 链会触达 app-core / session-view-state / sidebar-render /
      // app-ui / app-main 的装载期宿主工厂：按生产先行脚本序整链装载（boot 体与周期
      // 排程由基座关掉），再补 markdown-bootstrap（markdown-utils 求值期捕获
      // escapeHtml / renderer / marked）。
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
    },
    globals: {
      document: makeDocument(),
      // markdown-bootstrap 装载期需要 vendor 的 marked（renderer 由它自建）。
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
    return fn({ c, renderer, surface: c.window.createP2BootstrapChatSurfaceHost() });
  });
}

test('long Read shows a bounded preview, expands fully and releases the full body on collapse without mutating data', async () => {
  await withRenderer(({ renderer, surface }) => {
    const template = { result: (data) => data.content || JSON.stringify(data) };
    const args = {};
    const data = { type: 'file', offset: 201, path: 'test.js', content: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') };
    const original = data.content;

    const preview = renderer.renderToolResultBody('read', template, data, true, args, 3);
    assert.ok(preview.includes('tool-read-preview'));
    assert.ok(preview.includes('line 7'));
    assert.ok(!preview.includes('line 8'));
    assert.equal(data.content, original);
    assert.equal(data.offset, 201);

    surface._userExpandedMsgs.add(3);
    assert.equal(renderer.renderToolResultBody('read', template, data, true, args, 3), original);
    surface._userExpandedMsgs.delete(3);
    assert.equal(renderer.renderToolResultBody('read', template, data, true, args, 3), preview);
  });
});

test('tool-call lookup indexes a long transcript once and retains first matching call', async () => {
  await withRenderer(({ renderer }) => {
    let reads = 0;
    const messages = Array.from({ length: 400 }, (_, i) => ({
      get toolCalls() { reads++; return [{ id: `call-${i}`, name: 'read', arguments: { index: i } }]; },
    }));
    messages.push({ toolCalls: [{ id: 'call-0', name: 'bash', arguments: {} }] });

    const calls = renderer.indexToolCalls(messages);
    for (let i = 0; i < 400; i++) assert.equal(calls.get(`call-${i}`).arguments.index, i);
    assert.equal(calls.get('call-0').name, 'read');
    assert.equal(reads, 400);
  });
});

test('short Read, directories, errors and other tools retain their complete result', async () => {
  await withRenderer(({ renderer }) => {
    const template = { result: (data) => data.content || JSON.stringify(data) };
    const args = {};
    const data = { type: 'file', offset: 201, path: 'test.js', content: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') };

    assert.equal(renderer.renderToolResultBody('bash', template, data, true, args, 3), data.content);
    assert.equal(renderer.renderToolResultBody('read', template, data, false, args, 3), data.content);
    data.type = 'directory';
    assert.equal(renderer.renderToolResultBody('read', template, data, true, args, 3), data.content);
    data.type = 'file'; data.content = 'a\nb';
    assert.equal(renderer.renderToolResultBody('read', template, data, true, args, 3), 'a\nb');
  });
});
