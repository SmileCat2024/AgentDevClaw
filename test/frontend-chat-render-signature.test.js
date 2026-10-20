/**
 * 回退后前端 UI 不刷新的根因回归：chat-renderer 的渲染签名去重
 * （_lastRenderedChatSig）必须始终描述容器实际呈现的消息列表。
 *
 * 历史 bug：appendNewMessages / updateLastMessage 走增量 DOM 变更但
 * 不推进签名 → 回退让消息列表「恰好回到上次全量渲染的指纹」时，
 * render() 的去重误判「DOM 已是该状态」而跳过重建，UI 停留在幽灵
 * 消息（数据层已回退，只有硬刷新才恢复）。
 *
 * 本测试在 vm 沙箱加载真实 chat-renderer.js，以 container 的
 * innerHTML 重建计数观察去重行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

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
      const count = (String(html).match(/<div class="message-row/g) || []).length;
      this._rows = Array.from({ length: count }, makeRowEl);
      this.rebuildCount += 1;
    },
    get innerHTML() { return ''; },
    get lastElementChild() { return this._rows[this._rows.length - 1] || null; },
    querySelector(sel) {
      if (sel === '.message-row') return this._rows[0] || null;
      return null;
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
    scrollTop: 0,
    style: {},
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
  };
}

function createRendererSandbox() {
  const container = makeContainer();
  const noop = () => undefined;
  const base = {
    window: {},
    console,
    // chat-renderer 依赖的全局状态
    container,
    currentMessages: [],
    _lastRenderedChatSig: '',
    showChatProcess: true,
    followLatestEnabled: false,
    toolRenderConfigs: {},
    _userExpandedReasoning: [],
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    // 依赖全局函数（no-op 桩；渲染输出只统计 .message-row 行数）
    renderMarkdown: (s) => String(s ?? ''),
    escapeHtml: (s) => String(s ?? ''),
    // message-timeline.js：透传行 html（默认 no-op 桩返回 undefined 会拼进 DOM）
    prependTimeSeparatorHtml: (_messages, _index, rowHtml) => rowHtml,
    t: (s) => String(s ?? ''),
    getEmptyStateHtml: () => '<div class="empty-state"></div>',
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    consumePendingChatScrollRestore: () => null,
    requestAnimationFrame: noop,
    enhanceMathInElement: noop,
    enhanceMarkdownTables: noop,
    renderUserImages: () => '',
    notifyChatViewportMutation: noop,
    updateFollowLatestButton: noop,
    updateRollbackActionVisibility: noop,
    applyConversationProcessState: noop,
    applyCollapseLogic: noop,
    restoreUserCollapseState: noop,
    ensureChatRuntimeIndicator: noop,
    setProcessWindowingDisabled: noop,
    clearTruncatedHighlightData: noop,
    syncMessageImages: noop,
  };
  // Proxy 兜底：文件内其余自由标识符（同文件已声明的不走兜底）。
  // 宿主真实存在的全局（Map/Set/JSON 等内置）必须透传，否则 `new Map()`
  // 会拿到 no-op 桩直接崩溃；项目级全局（app-core 等的函数/状态）宿主
  // 没有，落到 no-op。
  const sandbox = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in globalThis) return globalThis[prop];
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has() { return true; },
  });
  base.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(load('public/src/modules/chat-renderer.js'), sandbox, { filename: 'chat-renderer.js' });
  // appendNewMessages 的 user 分支走 renderMessage；覆盖为最小行模板
  sandbox.renderMessage = () => '<div class="message-row user"></div>';
  sandbox.getMessageActionButtonsHtml = () => '';
  return { sandbox, container };
}

test('first user append after a hidden system-only welcome retains the system prefix', () => {
  const { sandbox, container } = createRendererSandbox();
  sandbox.showChatProcess = false;
  const prefix = [
    { role: 'system', content: 'system prompt' },
    { role: 'system', content: 'system reminder' },
  ];
  sandbox.currentMessages = prefix;
  sandbox.render(prefix);
  assert.equal(container._rows.length, 0, 'system-only hidden process shows welcome instead of rows');

  const user = { role: 'user', content: 'first input' };
  sandbox.currentMessages = [...prefix, user];
  sandbox.appendNewMessages([user], prefix.length);
  sandbox.showChatProcess = true;
  // Even requesting render cannot recover: append recorded a signature for
  // the entire transcript despite only putting the user row into the DOM.
  sandbox.render(sandbox.currentMessages);
  assert.equal(container._rows.length, 3, 'show process must include both system messages above the first user');
});

test('welcome boundary append keeps the signature honest about the rendered DOM', () => {
  const { sandbox, container } = createRendererSandbox();
  sandbox.showChatProcess = false;
  const prefix = [{ role: 'system', content: 'system prompt' }];
  sandbox.currentMessages = prefix;
  sandbox.render(prefix);
  const all = [...prefix, { role: 'user', content: 'first input' }];
  sandbox.currentMessages = all;
  sandbox.appendNewMessages(all.slice(1), 1);
  assert.equal(container._rows.length, 2, 'upgraded full render materialises the system prefix');
  sandbox.showChatProcess = true;
  sandbox.render(sandbox.currentMessages);
  assert.equal(container._rows.length, 2, 'identical data render dedups against the now-complete DOM');
  assert.equal(container.rebuildCount, 2, 'dedup means no extra rebuild after the boundary render');
});

test('optimistic echo bubble does not count as a history row at the welcome boundary', () => {
  const { sandbox, container } = createRendererSandbox();
  sandbox.showChatProcess = false;
  const prefix = [{ role: 'system', content: 'system prompt' }];
  sandbox.currentMessages = prefix;
  sandbox.render(prefix);
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
  sandbox.currentMessages = all;
  sandbox.appendNewMessages(all.slice(1), 1);
  sandbox.showChatProcess = true;
  sandbox.render(sandbox.currentMessages);
  assert.equal(container._rows.length, 2, 'echo-only container still upgrades to a full render');
});

const M = (i) => ({ role: 'user', content: `m${i}` });
const M5 = [M(1), M(2), M(3), M(4), M(5)];

test('render dedup still works for identical input (no over-fix)', () => {
  const { sandbox, container } = createRendererSandbox();
  sandbox.currentMessages = M5;
  sandbox.render(M5);
  assert.equal(container._rows.length, 5);
  assert.equal(container.rebuildCount, 1);
  sandbox.render(M5);
  assert.equal(container.rebuildCount, 1, 'identical input must be deduped');
});

test('rollback after append rebuilds DOM (ghost-message regression)', () => {
  const { sandbox, container } = createRendererSandbox();
  // 1. 全量渲染 5 条（签名 = sig(M5)）
  sandbox.currentMessages = M5;
  sandbox.render(M5);
  assert.equal(container._rows.length, 5);

  // 2. append 增量渲染 2 条（真实路径：不经过 render()）
  const M7 = [...M5, M(6), M(7)];
  sandbox.currentMessages = M7;
  sandbox.appendNewMessages(M7.slice(5), 5);
  assert.equal(container._rows.length, 7);

  // 3. 回退：消息列表回到旧指纹 M5 —— render 必须重建而非去重跳过
  sandbox.currentMessages = M5;
  sandbox.render(M5);
  assert.equal(container.rebuildCount, 2, 'rollback fingerprint collision must rebuild');
  assert.equal(container._rows.length, 5, 'ghost rows must be removed');
});

test('rollback after updateLastMessage rebuilds DOM', () => {
  const { sandbox, container } = createRendererSandbox();
  const M5a = [...M5];
  sandbox.currentMessages = M5a;
  sandbox.render(M5a);
  assert.equal(container.rebuildCount, 1);

  // 同长度、末条内容变化（compact + summary reminder 场景）：在位 patch
  const M5b = [...M5.slice(0, 4), { role: 'user', content: 'm5-edited' }];
  sandbox.currentMessages = M5b;
  sandbox.updateLastMessage(M5b[4]);
  assert.equal(container.rebuildCount, 1, 'in-place patch must not rebuild');

  // 回退到编辑前指纹：render 必须重建
  sandbox.currentMessages = M5a;
  sandbox.render(M5a);
  assert.equal(container.rebuildCount, 2, 'signature must reflect patched DOM state');
});
