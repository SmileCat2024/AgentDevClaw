/**
 * choice-input.js — Choice Input 卡片交互
 * 从 app-main.js 拆出（Phase A-2）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentInputRequests, choiceInputState, currentRuntimeAgentId,
 *   lastRenderedInputSignature
 * 依赖全局函数:
 *   renderInputRequests (app-main.js)
 *   poll (app-main.js)
 *   autoResize (app-main.js)
 *   escapeHtml (app-core.js)
 * 导出全局函数:
 *   isChoiceInputRequest, getChoiceRequestById, getChoiceState,
 *   getChoiceOptionCount, buildChoiceAnswer, rememberCurrentChoice,
 *   renderChoiceInputRequest, rerenderChoiceRequest, collapsePrimaryChoiceRequest
 * window 函数:
 *   selectChoiceOption, collapseChoiceRequest, expandChoiceRequest,
 *   updateChoiceCustomText, handleChoiceKey, handleChoiceCustomKey,
 *   confirmChoiceQuestion
 * HTML onclick 引用:
 *   onclick="selectChoiceOption(...)"
 *   onclick="collapseChoiceRequest(...)"
 *   onclick="expandChoiceRequest(...)"
 *   onclick="confirmChoiceQuestion(...)"
 *   onkeydown="handleChoiceKey(...)"
 *   onkeydown="handleChoiceCustomKey(...)"
 *   oninput="updateChoiceCustomText(...)"
 */

function isChoiceInputRequest(req) {
  return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
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
    };
  }
  return choiceInputState[requestId];
}

function getChoiceOptionCount(question) {
  const optionCount = Array.isArray(question?.options) ? Math.min(question.options.length, 4) : 0;
  return optionCount + (question?.allowCustom ? 1 : 0);
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
  const state = getChoiceState(req.requestId);
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
  card.className = 'user-input-card user-choice-card';
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
    <div class="user-choice-topline">
      <div class="user-choice-title">${escapeHtml(req.prompt || '需要你做个选择')}</div>
      <div class="user-choice-progress">${questionIndex + 1} / ${questions.length}</div>
      <button class="user-choice-close" type="button" title="临时收起" onclick="collapseChoiceRequest('${req.requestId}')">×</button>
    </div>
    <div class="user-choice-question">${escapeHtml(question.question || '')}</div>
    <div class="user-choice-options">
      ${optionHtml}
      ${customHtml}
    </div>
    <div class="user-choice-footer">
      <span>↑↓ 选项，←→ 题目，Enter 确认</span>
      <button class="user-choice-submit" type="button" onclick="confirmChoiceQuestion('${req.requestId}')">${questionIndex + 1 === questions.length ? '提交' : '下一题'}</button>
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
  lastRenderedInputSignature = '';
  const container = document.getElementById('user-input-container');
  if (!container) return;
  renderInputRequests(currentInputRequests || []);
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
    event.preventDefault();
    confirmChoiceQuestion(requestId);
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
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      delete choiceInputState[requestId];
      poll();
    }
  } catch (e) {
    console.error('提交选择失败:', e);
  }
};
