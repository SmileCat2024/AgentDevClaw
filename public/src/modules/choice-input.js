/**
 * choice-input.js — Choice Input 卡片交互
 * 从 app-main.js 拆出（Phase A-2）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentInputRequests, choiceInputState, currentRuntimeAgentId
 * 依赖全局函数:
 *   notifyInputSurfaceChanged (input-render.js，工单 037 唯一渲染声明入口)
 *   poll (app-main.js)
 *   autoResize (app-main.js)
 *   escapeHtml (app-core.js)
 * 导出全局函数:
 *   isChoiceInputRequest, getChoiceRequestById, getChoiceState,
 *   getChoiceOptionCount, buildChoiceAnswer, rememberCurrentChoice,
 *   renderChoiceInputRequest, rerenderChoiceRequest, collapsePrimaryChoiceRequest,
 *   getChoiceInteractionSignature
 * window 函数:
 *   isChoiceInputConsumed, selectChoiceOption, collapseChoiceRequest,
 *   expandChoiceRequest, updateChoiceCustomText, handleChoiceKey,
 *   handleChoiceCustomKey, confirmChoiceQuestion, toggleChoiceContext,
 *   rejectChoiceRequest
 * HTML onclick 引用:
 *   onclick="selectChoiceOption(...)"
 *   onclick="collapseChoiceRequest(...)"
 *   onclick="expandChoiceRequest(...)"
 *   onclick="confirmChoiceQuestion(...)"
 *   onclick="toggleChoiceContext(...)"
 *   onclick="rejectChoiceRequest(...)"
 *   onkeydown="handleChoiceKey(...)"
 *   onkeydown="handleChoiceCustomKey(...)"
 *   oninput="updateChoiceCustomText(...)"
 */

const _rejectedRequests = new Set();
// 已成功提交答案的请求。提交 POST 返回后，poll 管道中的陈旧快照仍可能
// 短暂带回该 lease；已提交的 lease 在模式判定与渲染中都必须视为不存在，
// 否则交互状态已清理的选择卡会以初始题号重建（闪回第一题）。
const _submittedRequests = new Set();

function isChoiceInputRequest(req) {
  return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
}

/** Globally accessible — used by readInputSurfaceModeState and renderChoiceInputRequest */
window.isChoiceInputConsumed = function(requestId) {
  return _rejectedRequests.has(requestId) || _submittedRequests.has(requestId);
};

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
function getChoiceInteractionSignature(requestId) {
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

function renderChoiceInputRequest(container, req) {
  if (isChoiceInputConsumed(req.requestId)) return;
  const state = getChoiceState(req.requestId);
  // The card is an answer to a specific runtime lease, not to whichever chat
  // happens to be selected when its asynchronous submit finishes.
  state.runtimeId = String(currentRuntimeAgentId || '');
  const questions = Array.isArray(req.questions) ? req.questions : [];
  if (state.collapsed) {
    container.classList.add('choice-collapsed');
    const mini = document.createElement('button');
    mini.className = 'user-choice-mini';
    mini.type = 'button';
    mini.setAttribute('onclick', `expandChoiceRequest('${req.requestId}')`);
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
  card.setAttribute('onkeydown', `handleChoiceKey(event, '${req.requestId}')`);

  const optionHtml = options.map((option, index) => `
    <button class="user-choice-option ${index === state.selectedIndex ? 'active' : ''}" type="button" onclick="selectChoiceOption('${req.requestId}', ${index})">
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
    <button class="user-choice-option ${customActive ? 'active' : ''}" type="button" onclick="selectChoiceOption('${req.requestId}', ${customIndex})">
      <span class="user-choice-key">${customIndex + 1}</span>
      <span>
        <span class="user-choice-label">${escapeHtml(question.customLabel || '其他，我想补充')}</span>
        <span class="user-choice-description">选择后可以直接输入想说的话</span>
      </span>
    </button>
    <div class="user-choice-custom ${customActive ? 'active' : ''}">
      <textarea id="choice-custom-${req.requestId}" rows="2"
        oninput="updateChoiceCustomText('${req.requestId}', this.value); autoResize(this)"
        onkeydown="handleChoiceCustomKey(event, '${req.requestId}')"
        placeholder="${escapeHtml(question.customPlaceholder || '输入你的补充内容')}">${escapeHtml(customText)}</textarea>
    </div>
  ` : '';

  card.innerHTML = `
    <div class="user-choice-layout${contextOpen ? ' context-open' : ''}">
      ${hasContext ? `
      <aside class="user-choice-context">
        <div class="user-choice-context-head">
          <span class="user-choice-context-label">决策背景</span>
          <button class="user-choice-context-hide" type="button" onclick="toggleChoiceContext('${req.requestId}')">◀ 收起</button>
        </div>
        <div class="user-choice-context-body">${escapeHtml(promptText)}</div>
      </aside>
      ` : ''}
      <div class="user-choice-main">
        <div class="user-choice-head">
          ${hasContext && !contextOpen ? `
            <button class="user-choice-context-btn" type="button" onclick="toggleChoiceContext('${req.requestId}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              <span>查看背景</span>
            </button>
          ` : '<span></span>'}
          <div class="user-choice-head-actions">
            <span class="user-choice-progress">${questionIndex + 1} / ${questions.length}</span>
            <button class="user-choice-close" type="button" title="临时收起" onclick="collapseChoiceRequest('${req.requestId}')">×</button>
          </div>
        </div>
        <div class="user-choice-question">${escapeHtml(question.question || '')}</div>
        <div class="user-choice-options">
          ${optionHtml}
          ${customHtml}
        </div>
        <div class="user-choice-footer">
          <div class="user-choice-footer-left">
            <button class="user-choice-reject" type="button" onclick="rejectChoiceRequest('${req.requestId}')">跳过并打断</button>
            <span class="user-choice-hint">↑↓ 选项，←→ 题目，Enter 确认</span>
          </div>
          <button class="user-choice-submit" type="button" onclick="confirmChoiceQuestion('${req.requestId}')">${questionIndex + 1 === questions.length ? '提交' : '下一题'}</button>
        </div>
      </div>
    </div>
  `;

  container.appendChild(card);
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
  notifyInputSurfaceChanged(currentInputRequests || []);
}

window.selectChoiceOption = function(requestId, optionIndex) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  state.selectedIndex = optionIndex;
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.selectedIndexByQuestion[question.id] = optionIndex;
  }
  rerenderChoiceRequest(requestId);
};

window.toggleChoiceContext = function(requestId) {
  const state = getChoiceState(requestId);
  state.contextExpanded = !state.contextExpanded;
  rerenderChoiceRequest(requestId);
};

window.rejectChoiceRequest = async function(requestId) {
  _rejectedRequests.add(requestId);
  const card = document.querySelector(`.user-choice-card[data-request-id="${requestId}"]`);
  if (card) card.classList.add('is-rejecting');
  // 声明变更即恢复普通输入面：isChoiceInputConsumed 现在返回 true，
  // hasChoiceRequest 为 false → 选择卡移除 → 普通输入面恢复（不等网络）。
  notifyInputSurfaceChanged();
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
};

window.collapseChoiceRequest = function(requestId) {
  const state = getChoiceState(requestId);
  const req = getChoiceRequestById(requestId);
  rememberCurrentChoice(req, state);
  state.collapsed = true;
  rerenderChoiceRequest(requestId);
};

window.expandChoiceRequest = function(requestId) {
  const state = getChoiceState(requestId);
  state.collapsed = false;
  rerenderChoiceRequest(requestId);
};

function collapsePrimaryChoiceRequest() {
  const request = (currentInputRequests || []).find(isChoiceInputRequest);
  if (request) {
    window.collapseChoiceRequest(request.requestId);
  }
}

window.updateChoiceCustomText = function(requestId, value) {
  const req = getChoiceRequestById(requestId);
  const state = getChoiceState(requestId);
  const question = req?.questions?.[state.questionIndex];
  if (question?.id) {
    state.customTextByQuestion[question.id] = value;
  }
};

window.handleChoiceKey = function(event, requestId) {
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
};

window.handleChoiceCustomKey = function(event, requestId) {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    confirmChoiceQuestion(requestId);
  }
};

window.confirmChoiceQuestion = async function(requestId) {
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
      poll();
    }
  } catch (e) {
    console.error('提交选择失败:', e);
  }
};
