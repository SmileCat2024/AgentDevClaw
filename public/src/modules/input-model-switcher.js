/**
 * input-model-switcher.js — 自 persistent-input.js 拆出（ticket 020，纯搬移不改逻辑）
 * 挂在输入框工具栏上的两个独立切换器组件。
 *
 * 包含：
 * - model 切换下拉：_getInputAgentId / _getInputDefaultPresetName /
 *   _closeInputModelDropdown / _inputModelDropdownOutsideClick /
 *   _performInputModelSwap / window.toggleInputModelDropdown / updateInputModelSwitcher
 * - thinking effort 切换下拉：OPENAI_EFFORT_LABELS / ANTHROPIC_EFFORT_LABELS /
 *   _getCurrentPreset / _getCurrentPresetProtocol / _getEffortList / _getEffortLabel /
 *   _getCurrentThinkingEffort / _currentModelSupportsThinking /
 *   _closeThinkingEffortDropdown / _inputThinkingDropdownOutsideClick /
 *   _performThinkingEffortSwap / window.toggleThinkingEffortDropdown / updateThinkingEffortSwitcher
 *
 * 依赖（全局符号，由先于本文件加载的脚本提供，加载序见 index.html）：
 * - escapeHtml, currentLanguage, ClawToast, window.ClawFW._modelPresets (app-core.js)
 * - focusedAgentId (app-core.js / app-main.js)
 * - currentRuntimeAgentId, currentOverviewSnapshot, getActiveWorkspaceSessionId,
 *   getRuntimeAwareAgentRecord, getCurrentHostAgentRecord, getCurrentAgentRecord (app-main.js)
 * - _cacheModelInfo, getCachedThinkingEffort (session-ui.js)
 */

// ── 输入框模型切换下拉 ──────────────────────────────────────────────

let _inputModelDropdown = null;

function _getInputAgentId() {
  // Model swap is keyed on the HOST agent ID (e.g. 'programming-helper'),
  // not the ViewerWorker child UUID. The config file
  // (.agentdev/agent-configs/{agentId}.json) and IPC delivery
  // (sendIPCToAllSessions → listAgentRuntimes) both use the host ID.
  // focusedAgentId is set to the host ID by switchAgent().
  if (typeof focusedAgentId !== 'undefined' && focusedAgentId) return focusedAgentId;
  // Fallback: resolve via host record
  if (typeof getCurrentHostAgentRecord === 'function') {
    let host = getCurrentHostAgentRecord();
    if (host && host.id) return host.id;
  }
  if (typeof getCurrentAgentRecord === 'function') {
    let agent = getCurrentAgentRecord();
    if (agent && agent.id) return agent.id;
  }
  return null;
}

function _getInputDefaultPresetName() {
  // Priority 1: overview.presetName — the runtime LLM instance's actual preset.
  // This is the same per-session data source as the context bar's modelName.
  // It's set by agent.setLLM() and pushed via overview poll, so it's always
  // correct for the current session and immune to loadAgents replacement gaps.
  if (typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot) {
    let pn = currentOverviewSnapshot.presetName;
    if (pn && typeof pn === 'string') return pn;
  }

  // Priority 2: preset from agent config (startup default, before first poll)
  let agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : null;
  if (!agent) return '';
  let modelPresets = agent.modelPresets || {};
  let defaultCfg = modelPresets.default || {};
  if (typeof defaultCfg === 'string') return defaultCfg;
  return (defaultCfg && defaultCfg.primary) || '';
}

function _closeInputModelDropdown() {
  if (_inputModelDropdown) {
    _inputModelDropdown.classList.remove('visible');
    setTimeout(function() {
      if (_inputModelDropdown) { _inputModelDropdown.remove(); _inputModelDropdown = null; }
    }, 150);
  }
}

function _inputModelDropdownOutsideClick(e) {
  if (_inputModelDropdown && !_inputModelDropdown.contains(e.target)) {
    let btn = document.getElementById('input-model-switch-btn');
    if (!btn || !btn.contains(e.target)) {
      _closeInputModelDropdown();
    }
  } else if (_inputModelDropdown) {
    document.addEventListener('click', _inputModelDropdownOutsideClick, { once: true });
  }
}

async function _performInputModelSwap(agentId, presetName) {
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let toastId = 'input-model-swap';

  if (typeof ClawToast !== 'undefined') {
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在切换模型...' : 'Switching model...',
      status: 'loading',
      closable: false,
    });
  }

  try {
    let sessionId = typeof getActiveWorkspaceSessionId === 'function'
      ? getActiveWorkspaceSessionId()
      : '';
    let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
    const resp = await fetch('/protoclaw/swap_model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, presetName, sessionId: sessionId || undefined, runtimeId: runtimeId || undefined }),
    });
    const result = await resp.json();
    if (result.ok) {
      // Clear thinking effort override on model change
      let agent = typeof getRuntimeAwareAgentRecord === 'function'
        ? getRuntimeAwareAgentRecord()
        : null;
      if (agent && typeof _cacheModelInfo === 'function') {
        _cacheModelInfo(agent, null, null, null, null);
      }
      if (typeof ClawToast !== 'undefined') {
        // __default__ 合成名 → 显示实际切换到的模型名（回执 meta 携带）
        let swapDesc = presetName;
        if (presetName === '__default__' && result?.meta?.modelName) swapDesc = result.meta.modelName;
        else if (typeof formatPresetDisplayName === 'function') swapDesc = formatPresetDisplayName(presetName);
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '模型已切换' : 'Model switched',
          description: swapDesc,
          autoDismiss: 3000,
        });
      }
      // Re-fetch presets so thinking effort reads from the new preset
      try {
        const resp2 = await fetch('/protoclaw/model_config');
        const data2 = await resp2.json();
        if (window.ClawFW) window.ClawFW._modelPresets = Array.isArray(data2?.presets) ? data2.presets : [];
      } catch (_) {}
      updateInputModelSwitcher();
      updateThinkingEffortSwitcher();
      if (typeof updateChatContextBar === 'function') updateChatContextBar();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('[InputModelSwitch] Swap failed:', e);
    if (typeof ClawToast !== 'undefined') {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '切换失败' : 'Switch failed',
        description: e?.message || String(e),
        closable: true,
        autoDismiss: 8000,
      });
    }
  }
}

window.toggleInputModelDropdown = function(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (_inputModelDropdown) {
    _closeInputModelDropdown();
    return;
  }

  let btn = document.getElementById('input-model-switch-btn');
  if (!btn) return;

  let agentId = _getInputAgentId();
  if (!agentId) return;

  // Fetch presets synchronously from cache or API
  (async function() {
    let presets = (window.ClawFW && window.ClawFW._modelPresets) || [];
    if (!presets.length) {
      try {
        const resp = await fetch('/protoclaw/model_config');
        const data = await resp.json();
        presets = Array.isArray(data && data.presets) ? data.presets : [];
        if (window.ClawFW) window.ClawFW._modelPresets = presets;
      } catch (e) {
        console.error('[InputModelSwitch] Failed to load presets:', e);
        return;
      }
    }
    if (!presets.length) return;

    let currentPreset = _getInputDefaultPresetName();
    let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';

    _inputModelDropdown = document.createElement('div');
    _inputModelDropdown.className = 'ccb-model-dropdown';

    let html = '<div class="ccb-model-dropdown-list">';
    presets.forEach(function(p) {
      let name = p.name || p.model || '';
      let isActive = name === currentPreset;
      let visionIcon = p.vision === true
        ? '<svg class="ccb-md-vision" title="' + (isZh ? '支持视觉' : 'Vision') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '';
      let ctxText = p.contextLength && p.contextLength > 0
        ? Math.round(p.contextLength / 1000) + 'K'
        : '';
      html += '<div class="ccb-md-item' + (isActive ? ' active' : '') + '" data-preset="' + escapeHtml(name) + '">'
        + '<span class="ccb-md-left">'
        + '<span class="ccb-md-name">' + escapeHtml(name) + '</span>'
        + visionIcon
        + '</span>'
        + '<span class="ccb-md-right">'
        + (ctxText ? '<span class="ccb-md-ctx">' + ctxText + '</span>' : '')
        + '</span>'
        + '</div>';
    });
    html += '</div>';
    _inputModelDropdown.innerHTML = html;

    // Position relative to the button — open upward
    let rect = btn.getBoundingClientRect();
    _inputModelDropdown.style.left = rect.left + 'px';

    _inputModelDropdown.addEventListener('click', function(e) {
      let item = e.target.closest('.ccb-md-item');
      if (!item) return;
      let presetName = item.dataset.preset;
      _closeInputModelDropdown();
      _performInputModelSwap(agentId, presetName);
    });

    document.body.appendChild(_inputModelDropdown);
    // Measure height after insert, then place above the button
    let ddHeight = _inputModelDropdown.offsetHeight;
    _inputModelDropdown.style.top = (rect.top - ddHeight - 4) + 'px';
    requestAnimationFrame(function() { _inputModelDropdown.classList.add('visible'); });

    setTimeout(function() {
      document.addEventListener('click', _inputModelDropdownOutsideClick, { once: true });
    }, 0);
  })();
};

/**
 * Update the model name shown in the input-area switcher button.
 * Called on render and after model swap.
 */

function updateInputModelSwitcher() {
  let nameEl = document.querySelector('.input-model-name');
  if (!nameEl) return;
  // _getInputDefaultPresetName already checks runtime cache first,
  // then falls back to the preset. No additional cache logic needed here.
  let displayName = _getInputDefaultPresetName() || '';
  // __default__ 是合成名：runtime 实际在用的模型名就在 overview 里，优先显示它；
  // overview 未推到时由 formatPresetDisplayName 兜底为"全局默认"占位。
  if (displayName === '__default__' && typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot?.modelName) {
    displayName = currentOverviewSnapshot.modelName;
  }
  if (typeof formatPresetDisplayName === 'function') displayName = formatPresetDisplayName(displayName);
  nameEl.textContent = displayName || (currentLanguage === 'zh' ? '模型' : 'Model');
}

// ── 输入框思考强度切换下拉 ──────────────────────────────────────────

const OPENAI_EFFORT_LABELS = {
  'none': 'none',
  'minimal': 'minimal',
  'low': 'low',
  'medium': 'medium',
  'high': 'high',
  'xhigh': 'xhigh',
};
const ANTHROPIC_EFFORT_LABELS = {
  'none': 'none',
  'low': 'low',
  'medium': 'medium',
  'high': 'high',
  'xhigh': 'xhigh',
  'max': 'max',
};

let _inputThinkingDropdown = null;

function _getCurrentPreset() {
  let presets = (window.ClawFW && window.ClawFW._modelPresets) || [];
  if (!presets.length) return null;
  let currentName = _getInputDefaultPresetName();
  if (!currentName) return null;
  return presets.find(function(p) { return (p.name || p.model) === currentName; }) || null;
}

function _getCurrentPresetProtocol() {
  // Priority 1: overview.provider — runtime live meta（含 __default__ 全局默认，
  // 它不在 presets.json 里，查表必然落空）
  if (typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot) {
    let p = currentOverviewSnapshot.provider;
    if (p && typeof p === 'string') return p;
  }
  let preset = _getCurrentPreset();
  return (preset && (preset.provider || preset.protocol)) || 'anthropic';
}

function _getEffortList(protocol) {
  return protocol === 'openai'
    ? Object.keys(OPENAI_EFFORT_LABELS)
    : Object.keys(ANTHROPIC_EFFORT_LABELS);
}

function _getEffortLabel(effort) {
  return OPENAI_EFFORT_LABELS[effort] || ANTHROPIC_EFFORT_LABELS[effort] || effort;
}

function _getCurrentThinkingEffort() {
  // Priority 1: Local optimistic cache (set during swap, before overview catches up)
  let agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : null;
  if (agent && typeof getCachedThinkingEffort === 'function') {
    let cached = getCachedThinkingEffort(agent);
    if (cached !== undefined) return cached;
  }
  // Priority 2: Overview snapshot (authoritative from runtime polling)
  if (typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot) {
    if (typeof currentOverviewSnapshot.thinkingEffort === 'string' && currentOverviewSnapshot.thinkingEffort) {
      return currentOverviewSnapshot.thinkingEffort;
    }
  }
  // Priority 3: Preset default
  let preset = _getCurrentPreset();
  return (preset && preset.thinkingEffort) || null;
}

function _currentModelSupportsThinking() {
  let preset = _getCurrentPreset();
  if (preset) {
    return preset.thinkingEffort != null && preset.thinkingEffort !== '' && preset.thinkingEffort !== 'none';
  }
  // preset 表查不到（如 __default__ 全局默认）时以 runtime live meta 判断
  if (typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot) {
    let te = currentOverviewSnapshot.thinkingEffort;
    return te != null && te !== '' && te !== 'none';
  }
  return false;
}

function _closeThinkingEffortDropdown() {
  if (_inputThinkingDropdown) {
    _inputThinkingDropdown.classList.remove('visible');
    setTimeout(function() {
      if (_inputThinkingDropdown) { _inputThinkingDropdown.remove(); _inputThinkingDropdown = null; }
    }, 150);
  }
}

function _inputThinkingDropdownOutsideClick(e) {
  if (_inputThinkingDropdown && !_inputThinkingDropdown.contains(e.target)) {
    let btn = document.getElementById('input-thinking-btn');
    if (!btn || !btn.contains(e.target)) {
      _closeThinkingEffortDropdown();
    }
  } else if (_inputThinkingDropdown) {
    document.addEventListener('click', _inputThinkingDropdownOutsideClick, { once: true });
  }
}

async function _performThinkingEffortSwap(agentId, thinkingEffort) {
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let toastId = 'input-thinking-swap';

  if (typeof ClawToast !== 'undefined') {
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在切换思考强度...' : 'Switching thinking effort...',
      status: 'loading',
      closable: false,
    });
  }

  try {
    let sessionId = typeof getActiveWorkspaceSessionId === 'function'
      ? getActiveWorkspaceSessionId()
      : '';
    let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
    const resp = await fetch('/protoclaw/swap_thinking_effort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, thinkingEffort, sessionId: sessionId || undefined, runtimeId: runtimeId || undefined }),
    });
    const result = await resp.json();
    if (result.ok) {
      // Cache the runtime override so the switcher reflects it immediately.
      // swap_thinking_effort no longer mutates config/presets.json, so we
      // must track the override locally rather than re-fetching presets.
      let agent = typeof getRuntimeAwareAgentRecord === 'function'
        ? getRuntimeAwareAgentRecord()
        : null;
      if (agent && typeof _cacheModelInfo === 'function') {
        _cacheModelInfo(agent, null, null, null, thinkingEffort);
      }
      if (typeof ClawToast !== 'undefined') {
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '思考强度已切换' : 'Thinking effort switched',
          autoDismiss: 3000,
        });
      }
      updateThinkingEffortSwitcher();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('[InputThinkingEffort] Swap failed:', e);
    if (typeof ClawToast !== 'undefined') {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '切换失败' : 'Switch failed',
        description: e?.message || String(e),
        closable: true,
        autoDismiss: 8000,
      });
    }
  }
}

window.toggleThinkingEffortDropdown = function(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (_inputThinkingDropdown) {
    _closeThinkingEffortDropdown();
    return;
  }

  let btn = document.getElementById('input-thinking-btn');
  if (!btn) return;

  let agentId = _getInputAgentId();
  if (!agentId) return;

  // Block switching if current model doesn't support thinking
  if (!_currentModelSupportsThinking()) {
    return;
  }

  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let protocol = _getCurrentPresetProtocol();
  let efforts = _getEffortList(protocol);
  let currentEffort = _getCurrentThinkingEffort();

  _inputThinkingDropdown = document.createElement('div');
  _inputThinkingDropdown.className = 'ccb-model-dropdown';

  let html = '<div class="ccb-model-dropdown-list">';
  // "默认" option — clears the override
  html += '<div class="ccb-md-item' + (!currentEffort ? ' active' : '') + '" data-effort="">'
    + '<span class="ccb-md-left">'
    + '<span class="ccb-md-name">' + (isZh ? '默认（预设）' : 'Default (preset)') + '</span>'
    + '</span>'
    + '</div>';
  for (const effort of efforts) {
    let isActive = effort === currentEffort;
    let label = _getEffortLabel(effort);
    html += '<div class="ccb-md-item' + (isActive ? ' active' : '') + '" data-effort="' + effort + '">'
      + '<span class="ccb-md-left">'
      + '<span class="ccb-md-name">' + escapeHtml(label) + '</span>'
      + '</span>'
      + '</div>';
  }
  html += '</div>';
  _inputThinkingDropdown.innerHTML = html;

  // Position relative to the button — open upward
  let rect = btn.getBoundingClientRect();
  _inputThinkingDropdown.style.left = rect.left + 'px';

  _inputThinkingDropdown.addEventListener('click', function(e) {
    let item = e.target.closest('.ccb-md-item');
    if (!item) return;
    let effort = item.dataset.effort;
    _closeThinkingEffortDropdown();
    _performThinkingEffortSwap(agentId, effort || null);
  });

  document.body.appendChild(_inputThinkingDropdown);
  // Measure height after insert, then place above the button
  let ddHeight = _inputThinkingDropdown.offsetHeight;
  _inputThinkingDropdown.style.top = (rect.top - ddHeight - 4) + 'px';
  requestAnimationFrame(function() { _inputThinkingDropdown.classList.add('visible'); });

  setTimeout(function() {
    document.addEventListener('click', _inputThinkingDropdownOutsideClick, { once: true });
  }, 0);
};

function updateThinkingEffortSwitcher() {
  let btn = document.getElementById('input-thinking-btn');
  let nameEl = document.querySelector('.input-thinking-name');
  if (!nameEl) return;
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';

  // Sync local cache with authoritative overview snapshot so that
  // session switches, page reloads, and agent restarts all converge
  // to the correct runtime thinkingEffort.
  if (typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot) {
    if (typeof currentOverviewSnapshot.thinkingEffort === 'string' && currentOverviewSnapshot.thinkingEffort) {
      let syncAgent = typeof getRuntimeAwareAgentRecord === 'function'
        ? getRuntimeAwareAgentRecord()
        : null;
      if (syncAgent && typeof _cacheModelInfo === 'function') {
        _cacheModelInfo(syncAgent, null, null, null, currentOverviewSnapshot.thinkingEffort);
      }
    }
  }

  // If presets aren't loaded yet, fetch them first and re-render.
  // This MUST happen before the supportsThinking check, otherwise
  // the early return for "不支持思考" blocks the fallback forever.
  let presets = (window.ClawFW && window.ClawFW._modelPresets) || [];
  if (!presets.length) {
    // Show a neutral label while loading — NOT "不支持思考" which is misleading
    nameEl.textContent = isZh ? '思考强度' : 'Thinking';
    nameEl.style.opacity = '';
    if (btn) {
      btn.classList.remove('thinking-disabled');
      btn.title = '';
    }
    fetch('/protoclaw/model_config').then(function(r) { return r.json(); }).then(function(d) {
      if (window.ClawFW) window.ClawFW._modelPresets = Array.isArray(d?.presets) ? d.presets : [];
      // Re-render now that presets are available
      updateThinkingEffortSwitcher();
    }).catch(function() {});
    return;
  }

  // If current model doesn't support thinking, disable the button and show hint
  let supportsThinking = _currentModelSupportsThinking();
  if (btn) {
    if (supportsThinking) {
      btn.classList.remove('thinking-disabled');
      btn.title = '';
    } else {
      btn.classList.add('thinking-disabled');
      btn.title = isZh ? '当前模型不支持思考' : 'Current model does not support thinking';
    }
  }

  if (!supportsThinking) {
    nameEl.textContent = isZh ? '不支持思考' : 'No Thinking';
    nameEl.style.opacity = '0.5';
    return;
  }
  nameEl.style.opacity = '';

  let effort = _getCurrentThinkingEffort();
  nameEl.textContent = effort
    ? _getEffortLabel(effort)
    : (isZh ? '思考强度' : 'Thinking');
}
