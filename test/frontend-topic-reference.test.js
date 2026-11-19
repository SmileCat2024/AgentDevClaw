/**
 * 主题卡片拖拽引用（topic-reference-picker）行为。
 *
 * 装载路线：与 frontend-ph-topics 同款 withP2EsmCase——classic 侧真实
 * loadSource 跑 action-dispatcher（ClawFW.actions 注册）与 app-core（宿主
 * 工厂 + i18n 桥初值），ESM 侧真实 import topic-reference-picker（其静态
 * 依赖含 session-reference-picker，投放目标判定复用它导出的助手）。
 *
 * 断言面：
 *   - 桶生命周期（挂载幂等 / consume / restore）与 pill 标记；
 *   - 拖拽源：委托 dragstart 从 DOM 读出 payload（topicId / 标题 / 面板
 *     归属 agentId），写专用 MIME；
 *   - 投放目标：当前输入卡（引用进活跃桶 + 聚焦输入框）与左栏会话条目
 *     （引用进目标会话自己的桶——经 setViewerSessionBinding 切换 activeKey
 *     后正向验证，不靠「活跃桶没被污染」的反证独撑）；
 *   - metadata 键契约 = 'topic-management'（feature 注册名，忙时排队路径
 *     dispatchTurnMetadata 按「键 = feature 名」派发）。
 *
 * Node 全局由用例注入（frontend-vm 沙箱无 Node；picker 的目标判定用
 * `instanceof Node`），事件为合成 drag/drop 事件，经 document 桩记录的
 * 委托监听器派发。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const PICKER = 'public/src/modules/topic-reference-picker.js';

/** 浏览器 Node 类的测试替身（globals 注入后 ESM 与事件目标共享同一类）。 */
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(props = {}) {
    super();
    this.dataset = props.dataset || {};
    this.textContent = props.textContent ?? '';
    this.innerHTML = '';
    this.className = '';
    this.style = {};
    this._selectorMap = props.selectorMap || null;
    this._closestMap = props.closestMap || null;
    this._focused = false;
    this.classList = {
      add(cls) { (this._set ||= new Set()).add(cls); },
      remove(cls) { this._set?.delete(cls); },
      contains(cls) { return this._set?.has(cls) || false; },
    };
  }
  closest(selector) { return this._closestMap ? (this._closestMap[selector] || null) : null; }
  querySelector(selector) { return this._selectorMap ? (this._selectorMap[selector] || null) : null; }
  querySelectorAll() { return []; }
  appendChild(child) { return child; }
  addEventListener() {}
  setAttribute() {}
  focus() { this._focused = true; }
}

/** createElement 产物：querySelector 返回宽松子元素（toast 构建链需要
 *  closeBtn.addEventListener 等子面），不匹配选择器也不返回 null。 */
function makeLooseElement() {
  const el = new FakeElement();
  el.querySelector = () => makeLooseElement();
  return el;
}

/** document 桩：记录委托监听器（合成 drag/drop 事件的派发面），其余查询为空。 */
function makeDocumentStub() {
  const listeners = new Map();
  const doc = {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getElementById() { return null; },
    createElement() { return makeLooseElement(); },
    createTextNode(text) { return { textContent: text }; },
    body: new FakeElement(),
    head: new FakeElement(),
    documentElement: new FakeElement(),
    readyState: 'complete',
    activeElement: null,
  };
  return doc;
}

function dispatch(doc, type, event) {
  for (const fn of doc.listeners.get(type) || []) fn(event);
}

function makeDataTransfer(types, data = {}) {
  const store = { ...data };
  return {
    types: [...types],
    dropEffect: null,
    setData(type, value) { store[type] = value; },
    getData(type) { return store[type] || ''; },
  };
}

/** 组装 Topic 看板卡片拖拽源（面板归属 → 卡片身份 → 标题元素的 closest 链）。 */
function makeTopicCardSource({ topicId, title, agentId }) {
  const panel = new FakeElement({ dataset: { topicAgentId: agentId } });
  const titleEl = new FakeElement({ textContent: title });
  const card = new FakeElement({
    dataset: { topicId },
    selectorMap: { '.ph-topic-card-title': titleEl },
  });
  card._closestMap = { '.ph-topic-panel': panel };
  const inner = new FakeElement();
  inner._closestMap = { '.ph-topic-card': card };
  return { panel, card, inner };
}

describe('topic-reference-picker', () => {
  it('metadata key is the feature registration name (dispatchTurnMetadata contract)', async () => {
    const document = makeDocumentStub();
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      const picker = await c.load(PICKER);
      assert.equal(picker.TOPIC_REF_METADATA_KEY, 'topic-management');
      assert.equal(picker.TOPIC_REF_MIME, 'application/x-claw-topic-ref');
    });
  });

  it('attach lifecycle: idempotent add, chips markup, consume/restore round-trip', async () => {
    const document = makeDocumentStub();
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      const picker = await c.load(PICKER);
      assert.equal(picker.addTopicReference({ agentId: 'programming-helper', topicId: 'relation_a', title: '主题A' }), true);
      // 幂等：同 (agentId, topicId) 不重复挂载
      assert.equal(picker.addTopicReference({ agentId: 'programming-helper', topicId: 'relation_a', title: '主题A' }), true);
      // 缺 topicId 的条目拒绝
      assert.equal(picker.addTopicReference({ agentId: 'programming-helper', title: '无 id' }), false);
      assert.equal(picker.peekTopicReferences().length, 1);

      const chips = picker.topicReferenceChipsHtml();
      assert.match(chips, /class="session-ref-chip topic-ref-chip"/);
      assert.match(chips, /data-action="topicRef\.removeChip" data-args="\[0\]"/);
      assert.match(chips, />主题A</);

      const consumed = picker.consumeTopicReferences();
      assert.deepEqual(consumed, [{ agentId: 'programming-helper', topicId: 'relation_a', title: '主题A' }]);
      assert.equal(picker.peekTopicReferences().length, 0);
      assert.equal(picker.topicReferenceChipsHtml(), '');

      picker.restoreTopicReferences(consumed);
      assert.equal(picker.peekTopicReferences().length, 1);
    });
  });

  it('delegated dragstart reads topic card payload from DOM and writes the dedicated MIME', async () => {
    const document = makeDocumentStub();
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      await c.load(PICKER);
      const { inner } = makeTopicCardSource({ topicId: 'relation_a', title: '前端 ESM 迁移', agentId: 'programming-helper' });
      const dataTransfer = makeDataTransfer(['text/plain']);
      dispatch(document, 'dragstart', { target: inner, dataTransfer, preventDefault() {} });
      const payload = JSON.parse(dataTransfer.getData('application/x-claw-topic-ref'));
      assert.deepEqual(payload, { agentId: 'programming-helper', topicId: 'relation_a', title: '前端 ESM 迁移' });
      assert.equal(dataTransfer.effectAllowed, 'copy');
      // 非主题卡片的 dragstart 不写 payload
      const unrelated = new FakeElement();
      const emptyTransfer = makeDataTransfer([]);
      dispatch(document, 'dragstart', { target: unrelated, dataTransfer: emptyTransfer, preventDefault() {} });
      assert.equal(emptyTransfer.getData('application/x-claw-topic-ref'), '');
    });
  });

  it('dragstart swaps the drag image for an off-screen pill (not the whole card snapshot)', async () => {
    const document = makeDocumentStub();
    const appended = [];
    document.body.appendChild = (child) => { appended.push(child); return child; };
    document.createElement = () => {
      const el = new FakeElement();
      el._removed = false;
      el.remove = () => { el._removed = true; };
      return el;
    };
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      await c.load(PICKER);
      const dropTargets = await c.load('public/src/modules/reference-drop-targets.js');

      // 主题卡片源：dragstart 后 setDragImage 收到挂在 body 的透明 frame，
      // 内层是主题 pill。不显式设置时浏览器退回整卡半透明快照——正是本
      // helper 要消除的形态；透明缓冲的意图见 helper 注释（对抗 drag image
      // 位图边缘的 alpha 渐隐）。
      const { inner } = makeTopicCardSource({ topicId: 'relation_a', title: '前端 ESM 迁移', agentId: 'programming-helper' });
      const topicTransfer = makeDataTransfer([]);
      const imageCalls = [];
      topicTransfer.setDragImage = (...args) => imageCalls.push(args);
      dispatch(document, 'dragstart', { target: inner, dataTransfer: topicTransfer, preventDefault() {} });
      assert.equal(imageCalls.length, 1, 'drag image 必须被显式设置');
      const [ghost, x, y] = imageCalls[0];
      assert.equal(appended[appended.length - 1], ghost, 'ghost 必须挂到 document.body 才能被截取');
      assert.match(ghost.className, /(^| )reference-drag-ghost( |$)/);
      assert.match(ghost.innerHTML, /session-ref-chip reference-drag-ghost-chip topic-ref-chip/);
      assert.match(ghost.innerHTML, /前端 ESM 迁移/);
      assert.ok(Number.isInteger(x) && Number.isInteger(y), '指针偏移为整数（pill 居中）');

      // dragend 清理：ghost 从 DOM 移除，离屏节点不残留
      dispatch(document, 'dragend', {});
      assert.equal(ghost._removed, true);

      // 会话 kind（PH 会话记录 / 侧栏条目两类源转发同一实现）：不带主题
      // 配色，空标题回退到 kind 通用标签
      const sessionTransfer = makeDataTransfer([]);
      const sessionCalls = [];
      sessionTransfer.setDragImage = (...args) => sessionCalls.push(args);
      dropTargets.setReferenceDragImage({ dataTransfer: sessionTransfer }, { kind: 'session', title: '' });
      assert.equal(sessionCalls.length, 1);
      const [sessionGhost] = sessionCalls[0];
      assert.equal(sessionGhost.innerHTML.includes('topic-ref-chip'), false);
      assert.match(sessionGhost.innerHTML, /会话引用|Session/);
      dispatch(document, 'dragend', {});
      assert.equal(sessionGhost._removed, true);

      // 降级容错：dataTransfer 无 setDragImage（合成事件桩 / 老 API）时，
      // 拖拽链路其余行为不受影响
      const appendedBefore = appended.length;
      const bare = makeDataTransfer([]);
      dispatch(document, 'dragstart', { target: inner, dataTransfer: bare, preventDefault() {} });
      assert.equal(bare.getData('application/x-claw-topic-ref').length > 0, true, 'MIME 照写');
      assert.equal(appended.length, appendedBefore, '不创建 ghost 元素');
    });
  });

  it('drop onto the active composer card attaches the reference and focuses the textarea', async () => {
    const document = makeDocumentStub();
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      const picker = await c.load(PICKER);
      const textarea = new FakeElement();
      const card = new FakeElement({ selectorMap: { '.user-input-textarea': textarea } });
      card._closestMap = { '.user-input-card': card }; // 投放判定：目标是输入卡自身
      const payload = JSON.stringify({ agentId: 'programming-helper', topicId: 'relation_a', title: '主题A' });

      const over = { target: card, dataTransfer: makeDataTransfer(['application/x-claw-topic-ref']), preventDefault() { this.defaulted = true; } };
      dispatch(document, 'dragover', over);
      assert.equal(over.defaulted, true);
      assert.equal(over.dataTransfer.dropEffect, 'copy');
      assert.equal(card.classList.contains('session-ref-drop-target'), true);

      const drop = { target: card, dataTransfer: makeDataTransfer(['application/x-claw-topic-ref'], { 'application/x-claw-topic-ref': payload }), preventDefault() { this.defaulted = true; } };
      dispatch(document, 'drop', drop);
      assert.equal(drop.defaulted, true);
      assert.deepEqual(picker.peekTopicReferences(), [{ agentId: 'programming-helper', topicId: 'relation_a', title: '主题A' }]);
      assert.equal(textarea._focused, true);
    });
  });

  it('drop onto a sidebar session item lands in that session bucket (verified by switching activeKey)', async () => {
    const document = makeDocumentStub();
    const previewCalls = { count: 0 };
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      c.window._renderAttachmentPreview = () => { previewCalls.count += 1; };
      const picker = await c.load(PICKER);
      const identity = await c.load('public/src/modules/identity.js');
      const orchestration = await c.load('public/src/modules/orchestration-state.js');
      const agentName = new FakeElement({ textContent: '目标会话' });
      agentName.childNodes = [{ textContent: '目标会话' }];
      const item = new FakeElement({
        dataset: { agentId: 'runtime-1', ctxNs: 'programming-helper', ctxSessionId: 's-9' },
        selectorMap: { '.agent-name': agentName },
      });
      item._closestMap = { '.agent-runtime-item': item };
      const payload = JSON.stringify({ agentId: 'programming-helper', topicId: 'relation_b', title: '主题B' });

      const drop = { target: item, dataTransfer: makeDataTransfer(['application/x-claw-topic-ref'], { 'application/x-claw-topic-ref': payload }), preventDefault() { this.defaulted = true; } };
      dispatch(document, 'drop', drop);
      assert.equal(drop.defaulted, true);
      // 活跃桶未被污染：引用挂到目标会话自己的桶
      assert.equal(picker.peekTopicReferences().length, 0);

      // 正向验证：切换到目标会话（runtime-1 / s-9 的 viewer 绑定），pill 恢复显示
      identity.setViewerSessionBinding('runtime-1', 's-9');
      orchestration.setCurrentRuntimeAgentId('runtime-1');
      assert.deepEqual(picker.peekTopicReferences(), [{ agentId: 'programming-helper', topicId: 'relation_b', title: '主题B' }]);
      assert.match(picker.topicReferenceChipsHtml(), />主题B</);
      assert.ok(previewCalls.count >= 1, 'preview re-render notified on attach');
    });
  });

  it('topic drag does not claim session-reference channel events (parallel MIME channels)', async () => {
    const document = makeDocumentStub();
    await withP2EsmCase({
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      },
      globals: { document, Node: FakeNode },
    }, async (c) => {
      const picker = await c.load(PICKER);
      const card = new FakeElement();
      card._closestMap = { '.user-input-card': card };
      // 只有会话引用 MIME 的投放事件：可能被 session picker 的处理器认领
      // （它注册在同一 document 上，行为正确），主题侧契约是不受影响——
      // 不产生任何主题引用。
      const drop = { target: card, dataTransfer: makeDataTransfer(['application/x-claw-session-ref']), preventDefault() {} };
      dispatch(document, 'drop', drop);
      assert.equal(picker.peekTopicReferences().length, 0);
      // 源侧对称：主题卡片 dragstart 只写主题 MIME，不写会话引用 MIME。
      const { inner } = makeTopicCardSource({ topicId: 'relation_a', title: 'T', agentId: 'programming-helper' });
      const dataTransfer = makeDataTransfer([]);
      dispatch(document, 'dragstart', { target: inner, dataTransfer, preventDefault() {} });
      assert.equal(dataTransfer.getData('application/x-claw-session-ref'), '');
      assert.equal(dataTransfer.getData('application/x-claw-topic-ref').length > 0, true);
    });
  });
});
