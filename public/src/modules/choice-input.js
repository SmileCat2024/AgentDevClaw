/**
 * choice-input.js — Choice Input 卡片交互（ESM 域）。
 * 从 app-main.js 拆出（Phase A-2），P2 输入面收尾批次转 ESM。
 *
 * 装载相位（R4）：原 classic 标签改为 ESM 装载后，顶层语句的执行时相从「加载序」
 * 变为「首个 import 它的模块执行时」（deferred，DOMContentLoaded 之前）。逐条审计：
 *   - 顶层只有模块私有状态（_rejectedRequests / _submittedRequests / choiceInputState）
 *     与选择卡动作注册（`window.ClawFW.actions.registerMany`）。分发器按名查表，动作元素
 *     由选择卡渲染产生，晚于模块求值；无加载期依赖。
 *   - 首屏**不是** R1（真分支核对）：`app-main` 顶层 applyLanguage →
 *     renderCurrentMainView → notifyInputSurfaceChanged → input-render 渲染入口以空
 *     请求数组进入，`readInputSurfaceModeState` 的
 *     `Array.isArray(requests) && requests.some(req => isChoiceInputRequest(req) …)`
 *     在空数组上直接短路，谓词不被调用；`getInputRenderSignature` 的
 *     `getChoiceInteractionSignature(...)` 与 `renderChoiceInputRequest(...)` 都排在
 *     `renderMode === 'choice'` 之后，而首屏 renderMode 为 hidden（无 chatActive /
 *     无 runtime 选中），同样短路。真实 lease 只会在认证后的轮询 / SSE 到达，
 *     必然晚于 deferred 模块执行。因此整域（含谓词与交互处理器）具备迁移条件，
 *     不新增 ready 等待、不复制第二实现。
 *
 * 桥键（domain `choice-input`，classic 消费方尚未迁移；四个键同时有命名导出）：
 *   - `isChoiceInputRequest`          ← input-composer.js（模式判定级 5）、
 *     input-render.js（级 5 分支的 lease 判定）
 *   - `isChoiceInputConsumed`         ← input-composer.js（模式判定级 5 裸标识符）
 *   - `getChoiceInteractionSignature` ← input-render.js（choice 渲染签名）
 *   - `renderChoiceInputRequest`      ← input-render.js（级 5 渲染）
 *   注销条件：input-composer / input-render 迁 ESM 并改为 import。
 *   四个键都按配方经 defineKey 注册（函数键初值为函数引用，setter 原样转发：
 *   诊断 / 测试整体替换后，消费方命中替换实现）。
 *   `getChoiceRequestById` / `getChoiceState` / `getChoiceOptionCount` /
 *   `buildChoiceAnswer` / `rememberCurrentChoice` / `updateChoiceCustomText` /
 *   `handleChoiceKey` / `handleChoiceCustomKey` / `confirmChoiceQuestion` /
 *   `rejectChoiceRequest` / `selectChoiceOption` / `toggleChoiceContext` /
 *   `collapseChoiceRequest` / `expandChoiceRequest` / `collapsePrimaryChoiceRequest`
 *   零跨文件消费方（唯一入口是卡片里的 data-action 与容器 onclick），保持模块私有。
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：escapeHtml（markdown-utils）、autoResize 与
 *     newIdempotencyKey（input-actions）、currentInputRequests
 *     （session-view-storage）、currentRuntimeAgentId（orchestration-state）、
 *     poll（poll-coordinator-host）。
 *   - 选择卡草稿状态是本模块私有状态：唯一消费方就是本域，classic 侧零读取，
 *     不再经 bootstrap 宿主引用。
 *   - 仍 classic 的显式 window 晚绑定：notifyInputSurfaceChanged（input-render，
 *     原实现在一处带 `typeof` 守卫、其余直调，形态原样保留）。
 *
 * 事件接线（data-action=choice.*，经 ClawFW.actions 分发）：
 *   selectOption / customInput / cardKey / toggleContext / collapse / expand /
 *   reject / confirm —— 注册见文件尾部
 */
import { escapeHtml } from './markdown-utils.js';
import { autoResize, newIdempotencyKey } from './input-actions.js';
import { currentInputRequests } from './session-view-storage.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { poll } from './poll-coordinator-host.js';

const _rejectedRequests = new Set();
// 已成功提交答案的请求。提交 POST 返回后，poll 管道中的陈旧快照仍可能
// 短暂带回该 lease；已提交的 lease 在模式判定与渲染中都必须视为不存在，
// 否则交互状态已清理的选择卡会以初始题号重建（闪回第一题）。
const _submittedRequests = new Set();
// 选择卡交互草稿（按 requestId 就地读写的唯一状态源）。classic 侧零读取，
// 因此直接模块私有：不注册桥键、不镜像、不经 bootstrap 宿主。
const choiceInputState = {};

export function isChoiceInputRequest(req) {
  return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
}

/** Used by readInputSurfaceModeState and renderChoiceInputRequest */
export function isChoiceInputConsumed(requestId) {
  return _rejectedRequests.has(requestId) || _submittedRequests.has(requestId);
}

function getChoiceRequestById(requestId) {
  return (currentInputRequests || []).find(req => req.requestId === requestId) || null;
}

function getChoiceState(requestId) {
  if (!choiceInputState[requestId]) {
    choiceInputState[requestId] = {
      questionIndex: 0,
      answers: [],
      selectedIndex: 0,
      selectedIndexByQuestion: {},
      customTextByQuestion: {},
      collapsed: false,
      contextExpanded: false,
    };
  }
  return choiceInputState[requestId];
}

function getChoiceOptionCount(question) {
  const optionCount = Array.isArray(question?.options) ? Math.min(question.options.length, 4) : 0;
  return optionCount + (question?.allowCustom ? 1 : 0);
}

// 选择卡交互状态签名（工单 037）：选项、题号、折叠与上下文展开决定卡片
// 显示内容，入渲染签名后交互写入经声明入口即可触发重建。customTextByQuestion
// 刻意不入签名——自定义文本打字不得触发整卡重建（保焦点、保光标）。
export function getChoiceInteractionSignature(requestId) {
  const state = choiceInputState[requestId];
  if (!state) return 'new';
  return JSON.stringify([
    state.questionIndex || 0,
    state.selectedIndex || 0,
    !!state.collapsed,
    !!state.contextExpanded,
    state.selectedIndexByQuestion || {},
  ]);
}

function buildChoiceAnswer(req, state, questionIndex) {
  const question = req?.questions?.[questionIndex] || {};
  const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
  const selectedIndex = state.selectedIndexByQuestion?.[question.id] ?? (questionIndex === state.questionIndex ? state.selectedIndex : 0);
  const isCustom = question.allowCustom && selectedIndex >= options.length;
  return isCustom
    ? {
        questionId: question.id,
        customText: (state.customTextByQuestion[question.id] || '').trim(),
      }
    : {
        questionId: question.id,
        optionId: options[selectedIndex]?.id,
      };
}

function rememberCurrentChoice(req, state) {
  const question = req?.questions?.[state.questionIndex] || {};
  if (!question.id) return;
  state.selectedIndexByQuestion[question.id] = state.selectedIndex || 0;
  state.answers[state.questionIndex] = buildChoiceAnswer(req, state, state.questionIndex);
}

export function renderChoiceInputRequest(container, req) {
  if (isChoiceInputConsumed(req.requestId)) return;
  const state = getChoiceState(req.requestId);
  // The card is an answer to a specific runtime lease, not to whichever chat
  // happens to be selected when its asynchronous submit finishes.
  state.runtimeId = String(currentRuntimeAgentId || '');
  const questions = Array.isArray(req.questions) ? req.questions : [];
  container.classList.toggle('choice-collapsed', !!state.collapsed);
  container.parentNode?.classList.toggle('choice-collapsed', !!state.collapsed);
  if (state.collapsed) {
    const mini = document.createElement('button');
    mini.className = 'user-choice-mini';
    mini.type = 'button';
    mini.dataset.action = 'choice.expand';
    mini.dataset.requestId = req.requestId;
    mini.innerHTML = `
      <span class="user-choice-mini-title">${escapeHtml(req.prompt || '等待你的选择')}</span>
      <span class="user-choice-mini-meta">${Math.min((state.questionIndex || 0) + 1, questions.length)} / ${questions.length}</span>
    `;
    container.appendChild(mini);
    return;
  }

  container.classList.remove('choice-collapsed');
  const questionIndex = Math.max(0, Math.min(state.questionIndex || 0, questions.length - 1));
  state.questionIndex = questionIndex;
  const question = questions[questionIndex] || {};
  const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
  const hasCustom = !!question.allowCustom;
  const optionCount = options.length + (hasCustom ? 1 : 0);
  state.selectedIndex = Math.max(0, Math.min(state.selectedIndexByQuestion?.[question.id] ?? state.selectedIndex ?? 0, Math.max(0, optionCount - 1)));

  const card = document.createElement('div');
  const promptText = req.prompt || '';
  const hasContext = !!promptText;
  const contextOpen = hasContext && state.contextExpanded;
  card.className = 'user-input-card user-choice-card' + (contextOpen ? ' context-open' : '');
  card.tabIndex = 0;
  card.dataset.requestId = req.requestId;
  card.dataset.action = 'choice.cardKey';
  card.dataset.event = 'keydown';

  const optionHtml = options.map((option, index) => `
    <button class="user-choice-option ${index === state.selectedIndex ? 'active' : ''}" type="button" data-action="choice.selectOption" data-request-id="${escapeHtml(req.requestId)}" data-option-index="${index}">
      <span class="user-choice-key">${index + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(option.label || option.id || ('选项 ' + (index + 1)))}</span>
        ${option.description ? `<span class="user-choice-description">${escapeHtml(option.description)}</span>` : ''}
      </span>
    </button>
  `).join('');

  const customIndex = options.length;
  const customActive = hasCustom && state.selectedIndex === customIndex;
  const customText = state.customTextByQuestion[question.id] || '';
  const customHtml = hasCustom ? `
    <button class="user-choice-option ${customActive ? 'active' : ''}" type="button" data-action="choice.selectOption" data-request-id="${escapeHtml(req.requestId)}" data-option-index="${customIndex}">
      <span class="user-choice-key">${customIndex + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(question.customLabel || '其他，我想补充')}</span>
        <span class="user-choice-description">选择后可以直接输入想说的话</span>
      </span>
    </button>
    <div class="user-choice-custom ${customActive ? 'active' : ''}">
      <textarea id="choice-custom-${req.requestId}" rows="2"
        data-action="choice.customInput" data-event="input keydown" data-request-id="${escapeHtml(req.requestId)}"
        placeholder="${escapeHtml(question.customPlaceholder || '输入你的补充内容')}">${escapeHtml(customText)}</textarea>
    </div>
  ` : '';

  card.innerHTML = `
    <div class="user-choice-layout${contextOpen ? ' context-open' : ''}">
      ${hasContext ? `
      <aside class="user-choice-context">
        <div class="user-choice-context-head">
          <span class="user-choice-context-label">决策背景</span>
          <button class="user-choice-context-hide" type="button" data-action="choice.toggleContext" data-request-id="${escapeHtml(req.requestId)}">◀ 收起</button>
        </div>
        <div class="user-choice-context-body">${escapeHtml(promptText)}</div>
      </aside>
      ` : ''}
      <div class="user-choice-main">
        <div class="user-choice-head">
          ${hasContext && !contextOpen ? `
            <button class="user-choice-context-btn" type="button" data-action="choice.toggleContext" data-request-id="${escapeHtml(req.requestId)}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              <span>查看背景</span>
            </button>
          ` : '<span></span>'}
          <div class="user-choice-head-actions">
            <span class="user-choice-progress">${questionIndex + 1} / ${questions.length}</span>
            <button class="user-choice-close" type="button" title="临时收起" data-action="choice.collapse" data-request-id="${escapeHtml(req.requestId)}">×</button>
          </div>
        </div>
        <div class="user-choice-question">${escapeHtml(question.question || '')}</div>
        <div class="user-choice-options">
          ${optionHtml}
          ${customHtml}
        </div>
        <div class="user-choice-footer">
          <div class="user-choice-footer-left">
            <button class="user-choice-reject" type="button" data-action="choice.reject" data-request-id="${escapeHtml(req.requestId)}">跳过并打断</button>
            <span class="user-choice-hint">↑↓ 选项，←→ 题目，Enter 确认</span>
          </div>
          <button class="user-choice-submit" type="button" data-action="choice.confirm" data-request-id="${escapeHtml(req.requestId)}">${questionIndex + 1 === questions.length ? '提交' : '下一题'}</button>
        </div>
      </div>
    </div>
  `;

  container.appendChild(card);
  container.onclick = function(event) {
    if (event.target === container) collapsePrimaryChoiceRequest();
  };
  setTimeout(() => {
    const customInput = customActive ? document.getElementById(`choice-custom-${req.requestId}`) : null;
    const target = customInput || card;
    target.focus();
    if (customInput) {
      const end = customInput.value.length;
      customInput.setSelectionRange(end, end);
      autoResize(customInput);
    }
  }, 30);
}

function rerenderChoiceRequest(requestId) {
  // 工单 037：choice 交互状态（选项/题号/折叠/上下文）已入渲染签名，
  // 状态写入后经声明入口触发选择卡重建，无需手动 reset 签名。
  const container = document.getElementById('user-input-container');
  if (!container) return;
  // 桥接期：notifyInputSurfaceChanged 定义于 input-render（输入面渲染域收敛时改 import）。
  window.notifyInputSurfaceChanged(currentInputRequests || []);
}

function selectChoiceOption(requestId, optionIndex) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  state.selectedIndex = optionIndex;
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.selectedIndexByQuestion[question.id] = optionIndex;
  }
  rerenderChoiceRequest(requestId);
}

function toggleChoiceContext(requestId) {
  const state = getChoiceState(requestId);
  state.contextExpanded = !state.contextExpanded;
  rerenderChoiceRequest(requestId);
}

async function rejectChoiceRequest(requestId) {
  _rejectedRequests.add(requestId);
  const card = document.querySelector(`.user-choice-card[data-request-id="${requestId}"]`);
  if (card) card.classList.add('is-rejecting');
  // 声明变更即恢复普通输入面：isChoiceInputConsumed 现在返回 true，
  // hasChoiceRequest 为 false → 选择卡移除 → 普通输入面恢复（不等网络）。
  // 桥接期：定义域 input-render。
  window.notifyInputSurfaceChanged();
  // Send interrupt in the background.
  const targetRuntimeId = String(getChoiceState(requestId).runtimeId || currentRuntimeAgentId || '').trim();
  if (!targetRuntimeId) {
    console.error('[Choice] Cannot interrupt without an explicit runtime target');
    delete choiceInputState[requestId];
    poll();
    return;
  }
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
    });
    if (!response.ok) {
      console.error('[Choice] interrupt request failed:', response.status);
    }
  } catch (e) {
    console.error('[Choice] interrupt request failed:', e);
  }
  delete choiceInputState[requestId];
  poll();
}

function collapseChoiceRequest(requestId) {
  const state = getChoiceState(requestId);
  const req = getChoiceRequestById(requestId);
  rememberCurrentChoice(req, state);
  state.collapsed = true;
  rerenderChoiceRequest(requestId);
}

function expandChoiceRequest(requestId) {
  const state = getChoiceState(requestId);
  state.collapsed = false;
  rerenderChoiceRequest(requestId);
}

function collapsePrimaryChoiceRequest() {
  const request = (currentInputRequests || []).find(isChoiceInputRequest);
  if (request) {
    collapseChoiceRequest(request.requestId);
  }
}

function updateChoiceCustomText(requestId, value) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.customTextByQuestion[question.id] = value;
  }
}

function handleChoiceKey(event, requestId) {
  const req = getChoiceRequestById(requestId);
  if (!req) return;
  // Smart boundary: only intercept arrow keys when cursor is at the edge of textarea content
  const tag = event.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    const el = event.target;
    const val = el.value;
    const pos = el.selectionStart;
    if (event.key === 'ArrowUp') {
      if (val.substring(0, pos).includes('\n')) return;
    } else if (event.key === 'ArrowDown') {
      if (val.substring(pos).includes('\n')) return;
    } else if (event.key === 'ArrowLeft') {
      if (pos > 0) return;
    } else if (event.key === 'ArrowRight') {
      if (pos < val.length) return;
    }
  }
  const state = getChoiceState(requestId);
  const question = req.questions[state.questionIndex] || {};
  const optionCount = getChoiceOptionCount(question);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.selectedIndex = Math.min(optionCount - 1, (state.selectedIndex || 0) + 1);
    if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.selectedIndex = Math.max(0, (state.selectedIndex || 0) - 1);
    if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    rememberCurrentChoice(req, state);
    state.questionIndex = Math.min(req.questions.length - 1, state.questionIndex + 1);
    state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    rememberCurrentChoice(req, state);
    state.questionIndex = Math.max(0, state.questionIndex - 1);
    state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
  } else if (event.key === 'Enter') {
    if (event.target.tagName === 'TEXTAREA' && event.shiftKey) return;
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    rejectChoiceRequest(requestId);
  }
}

function handleChoiceCustomKey(event, requestId) {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  }
}

async function confirmChoiceQuestion(requestId) {
  const req = getChoiceRequestById(requestId);
  if (!req) return;
  const state = getChoiceState(requestId);
  const questions = req.questions || [];
  rememberCurrentChoice(req, state);

  if (state.questionIndex < questions.length - 1) {
    state.questionIndex += 1;
    state.selectedIndex = state.selectedIndexByQuestion[questions[state.questionIndex]?.id] ?? 0;
    rerenderChoiceRequest(requestId);
    return;
  }

  const finalAnswers = questions.map((_, index) => state.answers[index] || buildChoiceAnswer(req, state, index));
  const summary = finalAnswers.map((item, index) => {
    const q = questions[index] || {};
    if (item.customText) return `${q.question || item.questionId}: ${item.customText}`;
    const option = (q.options || []).find(candidate => candidate.id === item.optionId);
    return `${q.question || item.questionId}: ${option?.label || item.optionId || ''}`;
  }).join('\n');

  try {
    const targetRuntimeId = String(state.runtimeId || currentRuntimeAgentId || '').trim();
    if (!targetRuntimeId) return;
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        requestId,
        input: summary,
        response: {
          kind: 'choices',
          choices: finalAnswers,
          text: summary,
        },
      }),
    });
    if (res.ok) {
      // 先登记再触发渲染：poll 管道中的陈旧快照仍可能带回该 lease，
      // consumed 判定保证它不会再以初始题号重建（闪回第一题）。
      _submittedRequests.add(requestId);
      delete choiceInputState[requestId];
      // 立即恢复普通输入面，不等待下一轮 poll 才移除选择卡。
      // 当前 inputRequests 可能仍是陈旧快照，但 consumed 标记会让模式判定
      // 将该 lease 视为已消费，因此可以安全地乐观切回 persistent。
      if (typeof window.notifyInputSurfaceChanged === 'function') {
        window.notifyInputSurfaceChanged(currentInputRequests || []);
      }
      poll();
    }
  } catch (e) {
    console.error('提交选择失败:', e);
  }
}

// 选择卡动作（原内联 onclick/onkeydown/oninput 与 setAttribute 注入，统一经分发器）
window.ClawFW.actions.registerMany({
  'choice.selectOption': (el) => selectChoiceOption(el.dataset.requestId, Number(el.dataset.optionIndex)),
  'choice.customInput': (el, event) => {
    if (event.type === 'keydown') { handleChoiceCustomKey(event, el.dataset.requestId); return; }
    updateChoiceCustomText(el.dataset.requestId, el.value);
    autoResize(el);
  },
  'choice.cardKey': (el, event) => handleChoiceKey(event, el.dataset.requestId),
  'choice.toggleContext': (el) => toggleChoiceContext(el.dataset.requestId),
  'choice.collapse': (el) => collapseChoiceRequest(el.dataset.requestId),
  'choice.expand': (el) => expandChoiceRequest(el.dataset.requestId),
  'choice.reject': (el) => rejectChoiceRequest(el.dataset.requestId),
  'choice.confirm': (el) => confirmChoiceQuestion(el.dataset.requestId),
});

// ── 桥（classic 消费方：input-composer / input-render 的谓词与渲染入口）──────
// 函数键按值转发：classic 侧若整体替换该全局（诊断 / 测试接管），后续消费方
// 命中替换后的实现。四个键同时是本模块的命名导出。

const bridgeValues = {
  isChoiceInputRequest,
  isChoiceInputConsumed,
  getChoiceInteractionSignature,
  renderChoiceInputRequest,
};

window.KernelState.defineKey('choice-input', 'isChoiceInputRequest', isChoiceInputRequest);
window.KernelState.defineKey('choice-input', 'isChoiceInputConsumed', isChoiceInputConsumed);
window.KernelState.defineKey('choice-input', 'getChoiceInteractionSignature', getChoiceInteractionSignature);
window.KernelState.defineKey('choice-input', 'renderChoiceInputRequest', renderChoiceInputRequest);
window.KernelState.claim('choice-input', {
  get(key) {
    return bridgeValues[key];
  },
  set(key, value) {
    bridgeValues[key] = value;
  },
});
