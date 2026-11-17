/**
 * slash-menu（Slash 命令菜单）真实行为测试 —— P2 第 1 波批次 5 专用。
 *
 * 真实 import 路线：模块经 esm-module-loader 真实动态 import（每次拿全新实例，
 * 模块级状态不跨用例共享）；document 用本文件的最小记录式 DOM（保留 innerHTML
 * 文本、classList、父子关系与事件监听），据此驱动模块真实注册的 document
 * capture 监听（input / keydown），验证完整用户链路而不是内部私有函数。
 *
 * 覆盖：
 *   1. 注册 → 前缀过滤 → Enter 执行 host 命令 → 命令段消费 + 菜单关闭；
 *   2. 会话命令拉取（GET /protoclaw/commands）→ prompt 型 pill 暂存 →
 *      ClawSlash.submitWithPendingPrompts 逐个 invoke → 激活 refs 移交发送管线；
 *   3. 兼容面：window.ClawSlash（仍有 classic 消费方）指向同一命名导出；
 *      window.SlashMenu 不再存在（唯一消费方 slash-commands 已 import）。
 *
 * 依赖注入：已迁 ESM 的状态域用 owner 模块 setter 驱动（活绑定读）；仍是
 * classic 的函数按调用时点以 window 桩注入（与生产中的晚绑定解析同形态）。
 * 已迁 ESM 的 ClawToast（toast-notify）不再经 window 桩：用例把真实模块对象的
 * `show` 换成记录器（与 sse-client / annotations 用例同一做法），恢复在 after。
 * slash-menu 的静态依赖现在包含 input-actions（autoResize），后者在装载期经
 * `window.createXHost()` 取 classic 相宿主；本用例不触达这些能力，故用惰性
 * 空实现占位（真实契约由生产 classic 相与 classic 宿主用例覆盖）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE_PATH = 'public/src/modules/slash-menu.js';

let orchestration;
let agentStore;
let i18n;
let toast;
let baseKernel;
let baseCleanup;
const pendingCleanups = [];

/** markdown-bootstrap 的 escapeHtml 实现（生产 classic 相经 KernelState 桥注册）。 */
function escapeHtml(text) {
  const str = String(text);
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, (m) => map[m]);
}

before(async () => {
  // 一个基础 window：状态模块与 markdown-utils 在首次装载时读取（桥键 / ClawFW）。
  baseCleanup = installBrowserStubs({
    window: { ClawFW: { actions: { registerMany() {} } } },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  baseKernel = globalThis.window.KernelState;
  globalThis.window.KernelState.defineKey('markdown-utils', 'escapeHtml', escapeHtml);
  globalThis.window.KernelState.defineKey('markdown-utils', 'renderer', null);
  orchestration = await import('../public/src/modules/orchestration-state.js');
  agentStore = await import('../public/src/modules/agent-store-state.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  toast = await import('../public/src/modules/toast-notify.js');
  // 在桥键就位时完成 markdown-utils 的首次装载（生产由 index.html 的 module
  // 入口 + markdown-bootstrap 保证同一顺序）；之后各用例的 window 桩只需
  // 满足运行时调用面。
  await import('../public/src/modules/markdown-utils.js');
});

after(() => {
  while (pendingCleanups.length > 0) pendingCleanups.pop()();
  baseCleanup();
});

// ── 最小记录式 DOM（保留 innerHTML 文本 + 事件监听，够本模块的真实链路）──

function createRecordingDom() {
  const elementsById = new Map();
  const documentListeners = [];

  class Element {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.innerHTML = '';
      this.textContent = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.isConnected = true;
      this._id = '';
      this.listeners = new Map();
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
      };
    }

    get id() { return this._id; }

    set id(value) {
      if (this._id) elementsById.delete(this._id);
      this._id = String(value || '');
      if (this._id) elementsById.set(this._id, this);
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }

    getAttribute(name) { return this.attributes[name] ?? null; }

    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }

    insertBefore(child, reference) {
      if (child.parentNode) {
        const oldIndex = child.parentNode.children.indexOf(child);
        if (oldIndex >= 0) child.parentNode.children.splice(oldIndex, 1);
      }
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index >= 0) this.children.splice(index, 0, child);
      else this.children.push(child);
      child.parentNode = this;
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    remove() { if (this.parentNode) this.parentNode.removeChild(this); }

    contains(node) {
      let cursor = node;
      while (cursor) {
        if (cursor === this) return true;
        cursor = cursor.parentNode;
      }
      return false;
    }

    addEventListener(type, listener) {
      const list = this.listeners.get(type) || [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    querySelector() { return null; }

    querySelectorAll() { return []; }

    getBoundingClientRect() {
      return { top: 400, bottom: 480, left: 0, right: 800, width: 800, height: 80 };
    }

    closest() { return null; }

    focus() {}

    dispatchEvent() { return true; }
  }

  const document = {
    body: new Element('body'),
    head: new Element('head'),
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) => elementsById.get(id) || null,
    addEventListener: (type, listener) => { documentListeners.push({ type, listener }); },
    removeEventListener() {},
  };

  const fire = (type, event) => {
    for (const entry of documentListeners) {
      if (entry.type === type) entry.listener(event);
    }
  };

  return { document, fire };
}

/** 菜单浮层由模块懒创建后挂在 body（宿主输入框容器也在 body 上，按类名定位）。 */
function findMenu(dom) {
  return dom.document.body.children.find((element) => element.className === 'slash-menu') || null;
}

/** 装载一份全新模块实例（含本用例的 window 桩与 DOM）。 */
async function loadSlashMenu({ window: windowOverrides = {}, fetch: fetchOverride } = {}) {
  const dom = createRecordingDom();
  const dispatched = [];
  const cleanupStubs = installBrowserStubs({
    window: {
      // 同一份 kernel 桥实例：本用例的模块（含静态依赖）在装载期 claim 到它，
      // 与 before 里已装载的状态模块保持同一 store。
      KernelState: baseKernel,
      ClawFW: { actions: { registerMany() {} } },
      t: (key) => key,
      _cacheSessionInput() {},
      getRuntimeId: () => '',
      getLogicalAgentId: (record) => (record ? record.id : ''),
      getRuntimeWorkspaceSessionId: () => null,
      getCurrentRuntimeRecord: () => null,
      getCurrentAgentRecord: () => null,
      innerWidth: 1280,
      innerHeight: 720,
      dispatchEvent: (event) => { dispatched.push(event); return true; },
      // input-actions 的装载期宿主（生产由 classic 相 app-core / app-main /
      // session-view-state 提供）；本用例不触达这些能力。
      createSessionViewCommitHost: () => ({}),
      createPollCoordinatorHost: () => ({}),
      createP2BootstrapDomHost: () => ({}),
      createCallInterruptHost: () => ({}),
      createP2BootstrapCallActivityHost: () => ({ _seenChoiceAlertIds: new Set() }),
      ...windowOverrides,
    },
    document: dom.document,
  });
  // 真实 toast 模块对象：只把 show 换成记录器（本用例不断言 DOM 呈现面）。
  const realToastShow = toast.ClawToast.show;
  toast.ClawToast.show = (spec) => { dispatched.push({ toast: spec }); };
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchOverride || (async () => ({ ok: false, status: 0, json: async () => ({}) }));
  pendingCleanups.push(() => {
    if (hadFetch) globalThis.fetch = prevFetch; else delete globalThis.fetch;
    toast.ClawToast.show = realToastShow;
    cleanupStubs();
  });

  orchestration.setCurrentRuntimeAgentId('');
  agentStore.setFocusedAgentId('programming-helper');
  i18n.setCurrentLanguage('zh');

  const { module } = await loadModuleOnce(MODULE_PATH, { installGlobals: false });
  // 输入框：两类输入框共有的 .user-input-textarea 特征
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const textarea = dom.document.createElement('textarea');
  textarea.classList.add('user-input-textarea');
  textarea.value = '';
  host.appendChild(textarea);
  return { module, dom, dispatched, textarea, host };
}

/** 让模块内部的异步链（fetch → then → 重渲染）跑完。 */
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('slash-menu：注册、过滤与 host 命令执行', () => {
  it('filters by prefix, executes the host handler on Enter and consumes only the command segment', async () => {
    const handled = [];
    const { module, dom, textarea } = await loadSlashMenu();
    module.SlashMenu.registerCommands([
      { name: 'trim', description: 'Trim all rounds', destination: 'host', handler: () => { handled.push('trim'); } },
      { name: 'summary', description: 'Summarize', destination: 'host', handler: () => { handled.push('summary'); } },
    ]);

    textarea.value = '/tri';
    dom.fire('input', { target: textarea });

    assert.equal(module.SlashMenu.isActive(), true, '有可选项时菜单激活');
    const menu = findMenu(dom);
    assert.match(menu.innerHTML, /\/trim/);
    assert.doesNotMatch(menu.innerHTML, /\/summary/, '前缀命中只有 trim');

    textarea.value = '/trim 请保留这段正文';
    dom.fire('input', { target: textarea });
    dom.fire('keydown', {
      key: 'Enter', target: textarea, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      preventDefault() {}, stopPropagation() {},
    });
    await flushAsync();

    assert.deepEqual(handled, ['trim']);
    assert.equal(textarea.value, '请保留这段正文', '命令只消费命令段，正文保留');
    assert.equal(module.SlashMenu.isActive(), false, '执行后菜单关闭');
  });

  it('drops registered entries without a name and keeps Enter as a normal send in the empty state', async () => {
    const { module, dom, textarea } = await loadSlashMenu();
    module.SlashMenu.registerCommands([{ name: '' }, { description: 'no name' }, null]);
    textarea.value = '/unknown';
    dom.fire('input', { target: textarea });
    assert.equal(module.SlashMenu.isActive(), false, '无可用命令时退化为普通消息输入');
  });

  it('applies the command applies predicate per input context', async () => {
    const { module, dom, textarea } = await loadSlashMenu();
    module.SlashMenu.registerCommands([
      { name: 'trim', destination: 'host', applies: () => false, handler: () => {} },
      { name: 'summary', destination: 'host', applies: () => true, handler: () => {} },
    ]);
    textarea.value = '/';
    dom.fire('input', { target: textarea });
    const menu = findMenu(dom);
    assert.match(menu.innerHTML, /\/summary/);
    assert.doesNotMatch(menu.innerHTML, /\/trim/);
  });
});

describe('slash-menu：会话命令与 prompt pill 激活交接', () => {
  it('fetches session commands, stores a prompt pill and hands activation refs to the send pipeline', async () => {
    const posts = [];
    const fetchStub = async (url, options = {}) => {
      if (String(url).startsWith('/protoclaw/commands')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            commands: [
              { ref: 'voice.activate', name: 'activate', kind: 'prompt', description: 'Voice mode' },
            ],
          }),
        };
      }
      posts.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    const { module, dom, textarea, dispatched } = await loadSlashMenu({
      window: {
        getRuntimeId: (record) => (record ? 'rt-1' : ''),
        getCurrentRuntimeRecord: () => ({ id: 'programming-helper' }),
        getRuntimeWorkspaceSessionId: () => 'sess-1',
      },
      fetch: fetchStub,
    });
    orchestration.setCurrentRuntimeAgentId('rt-1');

    textarea.value = '/voice';
    dom.fire('input', { target: textarea });
    await flushAsync();

    const menu = findMenu(dom);
    assert.match(menu.innerHTML, /\/voice\.activate/, '会话命令以完整 ref 呈现');

    dom.fire('keydown', {
      key: 'Enter', target: textarea, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      preventDefault() {}, stopPropagation() {},
    });
    await flushAsync();

    // prompt 型：选中不执行，改为挂 pill 并清空命令段
    assert.equal(textarea.value, '');
    const bar = dom.document.getElementById('slash-prompt-bar');
    assert.ok(bar, 'pill bar 已挂载');
    assert.match(bar.innerHTML, /slash-prompt-pill/);
    assert.match(bar.innerHTML, /\/activate/);
    assert.equal(posts.length, 0, '选中 pill 时不投递 invoke');

    let submitted = 0;
    textarea.value = '额外说明';
    const ok = await module.ClawSlash.submitWithPendingPrompts(textarea, async () => { submitted += 1; });

    assert.equal(ok, true);
    assert.equal(submitted, 1, '激活成功后走原提交入口');
    const [post] = posts;
    assert.equal(post.url, '/protoclaw/capability_invoke');
    const body = JSON.parse(post.options.body);
    assert.equal(body.ref, 'voice.activate');
    assert.deepEqual(body.args, {});
    assert.equal(body.agentId, 'programming-helper');
    assert.equal(body.runtimeId, 'rt-1');
    assert.equal(body.sessionId, 'sess-1');
    assert.equal(textarea.value, '/activate 额外说明', '短名前缀并入消息文本');
    // 激活 refs 移交给发送管线，取走即清空
    assert.deepEqual(module.ClawSlash.consumeActivations(), ['voice.activate']);
    assert.equal(module.ClawSlash.consumeActivations(), null);
    // pill 路径只做激活投递（不广播事实）：广播是 invoke 型命令执行侧的语义
    assert.equal(dispatched.some((event) => event && event.type === 'claw:capability-invoked'), false);
  });

  it('invokes an invoke-kind session command on Enter and broadcasts the capability fact', async () => {
    const posts = [];
    const dispatched = [];
    const fetchStub = async (url, options = {}) => {
      if (String(url).startsWith('/protoclaw/commands')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, commands: [{ ref: 'force.continue', name: 'continue', kind: 'invoke' }] }),
        };
      }
      posts.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { ok: true } }) };
    };
    const { dom, textarea } = await loadSlashMenu({
      window: {
        getRuntimeId: (record) => (record ? 'rt-1' : ''),
        getCurrentRuntimeRecord: () => ({ id: 'programming-helper' }),
        getRuntimeWorkspaceSessionId: () => 'sess-1',
        dispatchEvent: (event) => { dispatched.push(event); return true; },
      },
      fetch: fetchStub,
    });
    orchestration.setCurrentRuntimeAgentId('rt-1');

    textarea.value = '/cont';
    dom.fire('input', { target: textarea });
    await flushAsync();
    dom.fire('keydown', {
      key: 'Enter', target: textarea, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      preventDefault() {}, stopPropagation() {},
    });
    await flushAsync();

    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].options.body).ref, 'force.continue');
    const invoked = dispatched.find((event) => event && event.type === 'claw:capability-invoked');
    assert.ok(invoked, '广播了 claw:capability-invoked 事实');
    assert.deepEqual(invoked.detail, {
      ref: 'force.continue', agentId: 'programming-helper', runtimeId: 'rt-1', sessionId: 'sess-1',
    });
  });

  it('restores handed-off refs when the send fails so a retry still carries them', async () => {
    const { module } = await loadSlashMenu();
    module.ClawSlash.restoreActivations(['skill.a']);
    assert.deepEqual(module.ClawSlash.consumeActivations(), ['skill.a']);
    module.ClawSlash.restoreActivations([]);
    assert.equal(module.ClawSlash.consumeActivations(), null, '空数组不覆盖已清空状态');
  });
});

describe('slash-menu：ESM 兼容面', () => {
  it('keeps window.ClawSlash (live classic consumers) and exposes no window.SlashMenu', async () => {
    const { module } = await loadSlashMenu();
    // ClawSlash 仍有 classic 消费方（persistent-input / input-composer）
    assert.equal(globalThis.window.ClawSlash, module.ClawSlash);
    for (const key of ['consumeActivations', 'restoreActivations', 'rebindSession', 'submitWithPendingPrompts']) {
      assert.equal(typeof module.ClawSlash[key], 'function', `${key} 仍在命名空间面上`);
    }
    // SlashMenu 的消费方已全部 import（slash-commands）→ 不挂 window 面
    assert.equal(globalThis.window.SlashMenu, undefined, '无生产消费者的命名空间不得留全局');
    assert.equal(typeof module.SlashMenu.isActive, 'function');
    assert.equal(typeof module.SlashMenu.registerCommands, 'function');
  });
});
