/**
 * 回退后前端 UI 不刷新的根因回归：chat-renderer 的渲染签名去重
 * （_lastRenderedChatSig）必须始终描述容器实际呈现的消息列表。
 *
 * 历史 bug：appendNewMessages / updateLastMessage 走增量 DOM 变更但
 * 不推进签名 → 回退让消息列表「恰好回到上次全量渲染的指纹」时，
 * render() 的去重误判「DOM 已是该状态」而跳过重建，UI 停留在幽灵
 * 消息（数据层已回退，只有硬刷新才恢复）。
 *
 * 装载路线（P4 T2 批次）：chat-renderer 已迁 ESM，改真实 import
 * （withP2EsmCase + prepareClassicSandbox 提供 classic 宿主链）。夹具仍用最小
 * 行容器，以 innerHTML 重建计数观察去重行为；消息列表经 session-view-storage
 * 的桥键写入（`window.currentMessages`，与生产同一 owner）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_UI_DOMAIN, prepareClassicSandbox, prepareEsmModules } from './p2-classic-hosts.js';

const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';

// ── mini DOM：只支撑 render / appendNewMessages / updateLastMessage 路径 ──
function makeRowEl() {
  return {
    className: 'message-row',
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    matches: () => false,
    querySelector(sel) {
      // updateLastMessage 的 user 正文替换路径
      if (typeof sel === 'string' && sel.includes('markdown-body')) {
        if (!this._contentEl) {
          this._contentEl = { _v: '', set innerHTML(v) { this._v = v; }, get innerHTML() { return this._v; } };
        }
        return this._contentEl;
      }
      return null;
    },
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    remove() {},
    dataset: {},
    style: {},
  };
}

function makeContainer() {
  return {
    _rows: [],
    rebuildCount: 0,
    set innerHTML(html) {
      const chunks = String(html).split(/(?=<div class="message-row)/)
        .filter(chunk => chunk.startsWith('<div class="message-row'));
      this._rows = chunks.map(chunk => {
        const row = makeRowEl();
        row._msgId = /id="(msg-\d+)"/.exec(chunk)?.[1];
        return row;
      });
      this.rebuildCount += 1;
    },
    get innerHTML() { return ''; },
    get lastElementChild() { return this._rows[this._rows.length - 1] || null; },
    querySelector(sel) {
      if (sel === '.message-row') return this._rows[0] || null;
      const row = this._rows.find(row => '#' + row._msgId === sel);
      return row ? { closest: () => row } : null;
    },
    querySelectorAll(sel) {
      if (sel === '.message-row' || sel.endsWith('.message-row')) return [...this._rows];
      return [];
    },
    insertAdjacentHTML(_pos, html) {
      const count = (String(html).match(/<div class="message-row/g) || []).length;
      for (let i = 0; i < count; i += 1) this._rows.push(makeRowEl());
    },
    getElementsByTagName: () => [],
    // app-ui / chat-viewport 在装载期给容器注册 scroll / wheel 监听
    addEventListener() {},
    removeEventListener() {},
    scrollTop: 0,
    style: {},
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
  };
}

function makeDocument(container) {
  const generic = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', id: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; }, remove() {},
    insertAdjacentHTML() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  return {
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => (id === 'chat-container' ? container : generic()),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => generic(),
    createTextNode: (text) => ({ textContent: text }),
    body: generic(), head: generic(), documentElement: generic(),
  };
}

/** 一个用例 = 真实 chat-renderer 模块 + 夹具容器（重建计数即去重观察面）。 */
async function withSignatureCase(fn) {
  const container = makeContainer();
  return withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // app-ui（P4 T2 末件）已迁 ESM：被渲染链调用的 shouldRenderWorkspaceSurface /
      // isChatSurfaceActive 等桥键由它在模块相注册，classic 链不再提供。
      prepareEsmModules(sandbox, APP_UI_DOMAIN);
    },
    globals: {
      document: makeDocument(container),
      // 过程显隐按钮的同步由 input-helpers 的桥键提供（生产经 p4-entry 装载）；
      // 本文件的观察面是渲染签名与行数，按钮同步按 no-op 桩提供。
      updateChatProcessToggle: () => {},
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
      createPollCoordinatorHost: () => ({
        run: () => Promise.resolve(),
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
    },
  }, async (c) => fn({
    renderer: await c.load(CHAT_RENDERER),
    surface: c.window.createP2BootstrapChatSurfaceHost(),
    sandbox: c.window,
    container,
  }));
}

/** 消息列表写入：session-view-storage 的 owner 桥键（生产同一入口）。 */
function setMessages(sandbox, messages) {
  sandbox.currentMessages = messages;
}

test('first user append after a hidden system-only welcome retains the system prefix', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    surface.showChatProcess = false;
    const prefix = [
      { role: 'system', content: 'system prompt' },
      { role: 'system', content: 'system reminder' },
    ];
    setMessages(sandbox, prefix);
    renderer.render(prefix);
    assert.equal(container._rows.length, 0, 'system-only hidden process shows welcome instead of rows');

    const user = { role: 'user', content: 'first input' };
    setMessages(sandbox, [...prefix, user]);
    renderer.appendNewMessages([user], prefix.length);
    surface.showChatProcess = true;
    // Even requesting render cannot recover: append recorded a signature for
    // the entire transcript despite only putting the user row into the DOM.
    renderer.render(sandbox.currentMessages);
    assert.equal(container._rows.length, 3, 'show process must include both system messages above the first user');  });
});

test('welcome boundary append keeps the signature honest about the rendered DOM', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    surface.showChatProcess = false;
    const prefix = [{ role: 'system', content: 'system prompt' }];
    setMessages(sandbox, prefix);
    renderer.render(prefix);
    const all = [...prefix, { role: 'user', content: 'first input' }];
    setMessages(sandbox, all);
    renderer.appendNewMessages(all.slice(1), 1);
    assert.equal(container._rows.length, 2, 'upgraded full render materialises the system prefix');
    surface.showChatProcess = true;
    renderer.render(sandbox.currentMessages);
    assert.equal(container._rows.length, 2, 'identical data render dedups against the now-complete DOM');
    assert.equal(container.rebuildCount, 2, 'dedup means no extra rebuild after the boundary render');  });
});

test('optimistic echo bubble does not count as a history row at the welcome boundary', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    surface.showChatProcess = false;
    const prefix = [{ role: 'system', content: 'system prompt' }];
    setMessages(sandbox, prefix);
    renderer.render(prefix);
    // 用户从欢迎页直接发首条消息：echo 覆盖层先占一行（.message-row.user.
    // optimistic-user-echo），真实消息随后经 poll 抵达——echo 行不能让增量
    // 路径误判"容器已有历史行"。
    const echoRow = makeRowEl();
    echoRow.className = 'message-row user optimistic-user-echo';
    echoRow.classList = {
      contains: (c) => String(echoRow.className).split(' ').includes(c),
      add() {}, remove() {}, toggle() {},
    };
    container._rows.push(echoRow);
    const all = [...prefix, { role: 'user', content: 'first input' }];
    setMessages(sandbox, all);
    renderer.appendNewMessages(all.slice(1), 1);
    surface.showChatProcess = true;
    renderer.render(sandbox.currentMessages);
    assert.equal(container._rows.length, 2, 'echo-only container still upgrades to a full render');  });
});

const M = (i) => ({ role: 'user', content: `m${i}` });
const M5 = [M(1), M(2), M(3), M(4), M(5)];

test('render dedup still works for identical input (no over-fix)', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    setMessages(sandbox, M5);
    renderer.render(M5);
    assert.equal(container._rows.length, 5);
    assert.equal(container.rebuildCount, 1);
    renderer.render(M5);
    assert.equal(container.rebuildCount, 1, 'identical input must be deduped');  });
});

test('rollback after append rebuilds DOM (ghost-message regression)', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    // 1. 全量渲染 5 条（签名 = sig(M5)）
    setMessages(sandbox, M5);
    renderer.render(M5);
    assert.equal(container._rows.length, 5);

    // 2. append 增量渲染 2 条（真实路径：不经过 render()）
    const M7 = [...M5, M(6), M(7)];
    setMessages(sandbox, M7);
    renderer.appendNewMessages(M7.slice(5), 5);
    assert.equal(container._rows.length, 7);

    // 3. 回退：消息列表回到旧指纹 M5 —— render 必须重建而非去重跳过
    setMessages(sandbox, M5);
    renderer.render(M5);
    assert.equal(container.rebuildCount, 2, 'rollback fingerprint collision must rebuild');
    assert.equal(container._rows.length, 5, 'ghost rows must be removed');  });
});

test('rollback after updateLastMessage rebuilds DOM', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    const M5a = [...M5];
    setMessages(sandbox, M5a);
    renderer.render(M5a);
    assert.equal(container.rebuildCount, 1);

    // 同长度、末条内容变化（compact + summary reminder 场景）：在位 patch
    const M5b = [...M5.slice(0, 4), { role: 'user', content: 'm5-edited' }];
    setMessages(sandbox, M5b);
    renderer.updateLastMessage(M5b[4]);
    assert.equal(container.rebuildCount, 1, 'in-place patch must not rebuild');

    // 回退到编辑前指纹：render 必须重建
    setMessages(sandbox, M5a);
    renderer.render(M5a);
    assert.equal(container.rebuildCount, 2, 'signature must reflect patched DOM state');  });
});

test('continuation transcript (system + assistant, no user) renders content in hide mode', async () => {
  await withSignatureCase(({ renderer, surface, sandbox, container }) => {
    surface.showChatProcess = false;
    // 自动接续会话：上下文以 system 消息注入（handoff seed / 摘要 / reminder），
    // 助手已输出多轮正文，用户从未发言——隐藏过程模式下必须显示正文而非欢迎页。
    const transcript = [
      { role: 'system', content: '## 上下文交接摘要\n继续同一任务。' },
      { role: 'assistant', content: '正在继续处理任务。' },
      { role: 'assistant', content: '第一步已完成。' },
    ];
    setMessages(sandbox, transcript);
    renderer.render(transcript);
    assert.equal(container._rows.length, 3,
      'hide mode must render assistant replies as content, not the welcome page');  });
});
