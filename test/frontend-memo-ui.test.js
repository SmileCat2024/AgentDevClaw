/**
 * memo 三面板的「取数不挂渲染」契约。
 *
 * render 是纯投影（缓存先显、零闪烁），冷启动无缓存时幂等兜底一次（在途去重），
 * 常规刷新由导航事件与窗口聚焦触发。三块共用同一契约，故分三组验证。
 *
 * 模块形态：public/src/plugins/memo/*.js 是 ES 模块插件；数据面仍走全局
 * fetch（浏览器 fetch，测试注入可控实现），见 helpers/memo-plugin-loader.js。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMemoModule } from './helpers/memo-plugin-loader.js';

/**
 * 可控 fetch：请求计数，响应经 deferred 手动放行（不 sleep，全靠微任务 flush）。
 * 每调用 createMemoHarness 换一套 fetch 与模块实例，用例之间互不污染。
 */
function createFetchControl() {
  const calls = [];
  const deferreds = [];
  const impl = (...args) => {
    calls.push(args);
    let settle;
    const response = new Promise((resolve) => { settle = resolve; });
    deferreds.push({ settle });
    return response;
  };
  return {
    impl,
    calls,
    /** 放行最早一批未决响应。 */
    async respondNext(value) {
      const d = deferreds.shift();
      assert.ok(d, 'respondNext called with no pending fetch');
      d.settle({ ok: true, json: () => Promise.resolve(value) });
      await flush();
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function createMemoHarness(moduleName, language = 'zh') {
  const control = createFetchControl();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = control.impl;
  const { api, cleanup: cleanupWindow } = await loadMemoModule(moduleName, { language });
  const cleanup = () => {
    globalThis.fetch = previousFetch;
    cleanupWindow();
  };
  return { api, fetchCalls: control.calls, respondNext: control.respondNext, flush, cleanup };
}

describe('memo 总览 fetch discipline', () => {
  it('cold double render fetches once (in-flight dedup across two sources)', async () => {
    const { api, fetchCalls, cleanup } = await createMemoHarness('overview');
    try {
      api.render();
      api.render(); // 主视图双渲染路径
      assert.equal(fetchCalls.length, 2, '两源各一次，双渲染不翻倍');
    } finally { cleanup(); }
  });

  it('refresh while in-flight is dropped, not queued', async () => {
    const { api, fetchCalls, cleanup } = await createMemoHarness('overview');
    try {
      api.render();
      api.refresh();
      assert.equal(fetchCalls.length, 2, '导航重取与渲染兜底并发只发一次');
    } finally { cleanup(); }
  });

  it('warm render is pure projection; refresh revalidates', async () => {
    const { api, fetchCalls, respondNext, cleanup } = await createMemoHarness('overview');
    try {
      api.render();
      await respondNext({ reminders: [] });
      await respondNext({ notes: [] });
      assert.equal(fetchCalls.length, 2);
      fetchCalls.length = 0;
      api.render();
      assert.equal(fetchCalls.length, 0, '缓存已就绪后 render 不发请求');
      api.refresh();
      assert.equal(fetchCalls.length, 2, '导航刷新照常重取两源');
    } finally { cleanup(); }
  });
});

describe('memo 提醒 fetch discipline', () => {
  it('cold double render fetches once', async () => {
    const { api, fetchCalls, cleanup } = await createMemoHarness('reminders');
    try {
      api.render();
      api.render();
      assert.equal(fetchCalls.length, 1, '双渲染不翻倍');
    } finally { cleanup(); }
  });

  it('warm render fetches nothing; refresh revalidates once', async () => {
    const { api, fetchCalls, respondNext, cleanup } = await createMemoHarness('reminders');
    try {
      api.render();
      await respondNext({ reminders: [] });
      fetchCalls.length = 0;
      api.render();
      assert.equal(fetchCalls.length, 0, '缓存就绪后 render 纯投影');
      api.refresh();
      assert.equal(fetchCalls.length, 1);
    } finally { cleanup(); }
  });
});

describe('memo 便签 fetch discipline', () => {
  it('cold double render (wall) fetches once', async () => {
    const { api, fetchCalls, cleanup } = await createMemoHarness('notes');
    try {
      api.render();
      api.render();
      assert.equal(fetchCalls.length, 1, '双渲染不翻倍');
    } finally { cleanup(); }
  });

  it('warm wall render fetches nothing', async () => {
    const { api, fetchCalls, respondNext, cleanup } = await createMemoHarness('notes');
    try {
      api.render();
      await respondNext({ notes: [] });
      fetchCalls.length = 0;
      api.render();
      assert.equal(fetchCalls.length, 0, '缓存就绪后 render 纯投影');
    } finally { cleanup(); }
  });

  it('reading state: render fetches nothing; refresh revalidates the open note', async () => {
    const { api, fetchCalls, respondNext, cleanup } = await createMemoHarness('notes');
    try {
      api.render();
      await respondNext({ notes: [] });
      fetchCalls.length = 0;
      api.openNote('todo.md');
      assert.equal(fetchCalls.length, 1, 'openNote 交互回调取正文');
      await respondNext({ note: { filename: 'todo.md', title: 't', content: '# hi', updatedAt: 1 } });
      fetchCalls.length = 0;
      api.render();
      assert.equal(fetchCalls.length, 0, '阅读态 render 不发请求');
      api.refresh();
      assert.equal(fetchCalls.length, 1, '导航刷新重取当前篇');
      assert.match(String(fetchCalls[0][0]), /filename=/, '重取的是阅读中的便签');
    } finally { cleanup(); }
  });
});

/**
 * 卡片点击动作的编码契约。
 *
 * 回归背景：便签墙卡片曾把文件名塞进 data-args 的 JSON 字符串，而属性值本身
 * 用双引号包裹——裸写的 JSON 双引号在第一个引号处就截断了属性值，浏览器解析
 * 出的 data-args 是残缺的 "[，dispatch 放弃分发，表现为「点便签没反应」。
 * 总览卡片当时用的是 &quot; 转义因而正常，两个面板行为不一致。
 *
 * 断言口径：渲染出的 HTML 里，带 data-action 的元素其属性值必须整体被双引号
 * 包裹且内部不再出现裸双引号——用真实 HTML 解析器看不到，这里用正则近似。
 */
describe('memo 卡片动作属性编码', () => {
  it('便签墙卡片：data-action 存在且属性值不被裸引号截断', async () => {
    const { api, respondNext, cleanup } = await createMemoHarness('notes');
    try {
      api.render();
      await respondNext({ notes: [{ filename: 'plan.md', title: 'plan', preview: '', updatedAt: 1 }] });
      const html = api.render();
      const card = html.match(/<button class="memo-note-card"[^>]*>/);
      assert.ok(card, '便签墙应渲染出卡片');
      assert.match(card[0], /data-action="memo\.openNote"/);
      assert.match(card[0], /data-note-filename="plan\.md"/);
      // 若这里出现裸 JSON（data-args="["plan.md"]"），说明属性值已被截断
      assert.doesNotMatch(card[0], /data-args="\["/, 'data-args 不得以裸双引号开头');
    } finally { cleanup(); }
  });

  it('总览卡片：data-args 用 &quot; 转义，JSON 可解码', async () => {
    const { api, respondNext, cleanup } = await createMemoHarness('overview');
    try {
      api.render();
      await respondNext({ reminders: [] });
      await respondNext({ notes: [{ filename: 'plan.md', title: 'plan', preview: '', updatedAt: 1 }] });
      const html = api.render();
      const card = html.match(/<button class="memo-note-card"[^>]*>/);
      assert.ok(card, '总览应渲染出便签卡');
      const args = card[0].match(/data-args="([^"]*)"/);
      assert.ok(args, 'data-args 属性值应完整闭合');
      assert.deepEqual(JSON.parse(args[1].replace(/&quot;/g, '"')), ['plan.md']);
    } finally { cleanup(); }
  });
});
