// PH 历史存档面板（ticket 050）：面板渲染与「从这段继续」分支动作。
// 面板契约（ADR-0032 决策 3 用户语言模型）：按时间倒序呈现「精简 / 摘要
// 发生前的完整记录」存档卡（时间锚 + 触发方式 + 规模），head 不在存档
// 列表；查看原文走 view_session_record；从这段继续 = 整代保留的分支
// （cutMsgIndexEnd 到最后一条消息），成功后经 open_session 打开新对话。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/modules/ph-thread-history.js', import.meta.url), 'utf8');

function makeElement() {
  return {
    id: '',
    className: '',
    innerHTML: '',
    parentNode: null,
    children: [],
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    addEventListener() {},
  };
}

function loadModule({ fetchImpl } = {}) {
  const toasts = [];
  const actions = [];
  const created = [];
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    fetch: fetchImpl,
    ClawToast: { show: (t) => toasts.push(t) },
    runWorkspaceAction: (action) => actions.push(action),
  });
  ctx.document.createElement = () => { const el = makeElement(); created.push(el); return el; };
  // overrides 只注入 vm 裸全局；面板模块经 window.runWorkspaceAction 访问
  ctx.window.runWorkspaceAction = (action) => actions.push(action);
  ctx.run(source);
  return { ctx, toasts, actions, created };
}

const CHAIN_META = [
  { sessionId: 'sess-head', role: 'head', endKind: null, title: 'head-title', messageCount: 2 },
  { sessionId: 'sess-arch', role: 'predecessor', endKind: 'trim', endedAt: '2026-10-24T10:30:00+08:00', title: '当时的标题', messageCount: 12 },
  { sessionId: 'sess-arch2', role: 'predecessor', endKind: 'summary', endedAt: '2026-10-20T09:15:00+08:00', title: '更早的标题', messageCount: 30 },
];

function findOverlay(created) {
  return created.find((el) => el.className === 'feature-detail-overlay') || null;
}

test('面板渲染：存档卡按用户语言呈现（时间锚 + 触发方式 + 规模），head 不出现', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sessionChainMeta: CHAIN_META }) });
  const { ctx, created } = loadModule({ fetchImpl });
  await ctx.run(`window.phOpenThreadHistory('programming-helper', 'wt-1')`);
  const overlay = findOverlay(created);
  assert.ok(overlay, '面板 overlay 已创建');
  const html = overlay.innerHTML;
  assert.ok(html.includes('历史记录'), '面板标题');
  assert.ok(html.includes('精简前'), 'trim 存档触发方式标签');
  assert.ok(html.includes('摘要前'), 'summary 存档触发方式标签');
  assert.ok(html.includes('10 月 24 日'), '时间锚（用户语言格式）');
  assert.ok(html.includes('12 条消息'), '存档规模');
  assert.ok(!html.includes('head-title'), 'head 不作为存档卡渲染');
  assert.ok(html.includes('查看原文') && html.includes('从这段继续'), '两张动作按钮');
});

test('整代保留：从这段继续 → 分支 cut 到最后一条消息，成功后打开新对话', async () => {
  const branchCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/protoclaw/session_record')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{}, {}, {}] }) };
    }
    if (String(url).includes('/protoclaw/sessions/branch')) {
      branchCalls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, newSessionId: 'sess-new' }) };
    }
    return { ok: true, status: 200, json: async () => ({ sessionChainMeta: CHAIN_META }) };
  };
  const { ctx, toasts, actions, created } = loadModule({ fetchImpl });
  await ctx.run(`window.phOpenThreadHistory('programming-helper', 'wt-1')`);
  assert.ok(findOverlay(created), '前置：面板已打开');
  await ctx.run(`window.PhThreadHistory.continueFrom('sess-arch')`);
  assert.equal(branchCalls.length, 1, '一次分支请求');
  assert.deepEqual(branchCalls[0], {
    agentId: 'programming-helper',
    sourceSessionId: 'sess-arch',
    cutMsgIndexEnd: 2, // 3 条消息 → 保留到索引 2（整代）
  });
  assert.ok(toasts.some((t) => String(t.title).includes('新对话')), '成功提示');
  assert.equal(actions.length, 1, '面板关闭后打开新对话');
  assert.equal(JSON.parse(actions[0]).type, 'open_session');
  assert.equal(JSON.parse(actions[0]).sessionId, 'sess-new');
});

test('空历史：提示且不开面板', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ sessionChainMeta: [] }) });
  const { ctx, toasts, created } = loadModule({ fetchImpl });
  await ctx.run(`window.phOpenThreadHistory('programming-helper', 'wt-1')`);
  assert.equal(findOverlay(created), null, '无 overlay 创建');
  assert.ok(toasts.some((t) => String(t.title).includes('暂无历史存档')), '空历史提示');
});

test('详情请求失败：错误提示，不开面板', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const { ctx, toasts, created } = loadModule({ fetchImpl });
  await ctx.run(`window.phOpenThreadHistory('programming-helper', 'wt-1')`);
  assert.equal(findOverlay(created), null, '失败不开面板');
  assert.ok(toasts.some((t) => t.status === 'error'), '错误 toast');
});
