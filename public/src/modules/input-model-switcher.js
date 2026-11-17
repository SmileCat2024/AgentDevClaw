/**
 * input-model-switcher.js — 输入区「模型」与「思考强度」两个切换器域
 * （自 persistent-input.js 拆出，ticket 020 纯搬移不改逻辑）。
 *
 * P2 长尾批次：整域原位转 ESM——路径 / 文件名 / 既有函数名与键名全部不变，
 * 只做搬移 + export 化，不重命名、不改业务逻辑。装载相位由 classic 加载序变为
 * 「首个 import 它的模块执行时」（deferred），时序审计结论见下。
 *
 * 包含：
 * - model 切换下拉：_getInputAgentId / _getInputDefaultPresetName /
 *   _closeInputModelDropdown / _inputModelDropdownOutsideClick /
 *   _performInputModelSwap / toggleInputModelDropdown / updateInputModelSwitcher
 * - thinking effort 切换下拉：OPENAI_EFFORT_LABELS / ANTHROPIC_EFFORT_LABELS /
 *   _getCurrentPreset / _getCurrentPresetProtocol / _getEffortLabel /
 *   _getCurrentThinkingEffort / _currentModelSupportsThinking /
 *   _closeThinkingEffortDropdown / _inputThinkingDropdownOutsideClick /
 *   _performThinkingEffortSwap / toggleThinkingEffortDropdown /
 *   updateThinkingEffortSwitcher
 * - `getThinkingEffortOptions`：既有 `window.ClawFW.getThinkingEffortOptions`
 *   命名空间协议（memo 插件 / ph-settings / ph-project-actions 按既有协议取用）
 *
 * 依赖形态（一律「当前源码已是 ESM 就直接 import」，不退回 window、不复制状态）：
 *   - import：`getCurrentLanguage`（i18n-environment-state）、`escapeHtml`
 *     （markdown-utils）、`ClawToast`（toast-notify）、`ClawFeatureCommunication`
 *     （feature-communication）、`getClawModelPresets` /
 *     `clawModelPresetsMatchSession` / `ensureClawModelPresetsForSession`
 *     （model-preset-cache）、`focusedAgentId`（agent-store-state，live binding）、
 *     `currentRuntimeAgentId`（orchestration-state，live binding）、
 *     `isSessionViewTokenCurrent` / `commitSessionViewPatch`
 *     （session-view-commit-host，会话视图提交策略的唯一 ESM 入口）。
 *   - 仍是 classic 唯一实现，只能经 `window.X` 晚绑定调用；**保留原 `typeof`
 *     守卫**（缺失时按原语义跳过）：`getCurrentHostAgentRecord` /
 *     `getCurrentAgentRecord`（app-main）、`getRuntimeAwareAgentRecord`（app-ui）、
 *     `formatPresetDisplayName`（app-core）、`updateChatContextBar`
 *     （chat-context-bar）。
 *   - `readCurrentSessionViewState` / `captureSessionViewToken`：session-view-state
 *     的同步快照读取仍为 classic（首屏同步链使用），本域原实现即无守卫直调，
 *     保持 `window.` 直调。
 *
 * 兼容桥（KernelState 访问器，注册在本模块执行相；逐键消费面见文件末尾）：
 *   - `updateInputModelSwitcher` / `updateThinkingEffortSwitcher`：persistent-input
 *     （classic，renderPersistentInput 无守卫直调）、app-main（classic，宿主
 *     适配器带 typeof 守卫）、agent-data-loader / p2-w2-3a-queue-projection
 *     （ESM 侧仍是 `window.` 调用，由那两个文件的批次改 import 后注销）。
 *   - `toggleInputModelDropdown` / `toggleThinkingEffortDropdown`：input-composer
 *     （classic，按钮 onclick 装配处无守卫直调）。
 *   其余函数与全部状态（两个下拉元素、单飞标志、通道可用性缓存、恢复失败
 *   提示标志）零跨文件消费，按配方收敛为模块私有，不上桥。
 *
 * 时序审计（R1–R4 + S；「键 × 触达点」逐条结论见批次交付报告）：
 *   - R1/R2：classic 相位与 boot 首轮都不触达本域任何函数。首屏同步链
 *     `app-main` 顶层 applyLanguage → renderCurrentMainView →
 *     `notifyInputSurfaceChanged(viewState.inputRequests)` → renderInputRequests
 *     在冷态（currentRuntimeAgentId 为空、无 thread await target、非只读、无
 *     回退对话框、无压缩、请求为空）下逐级短路到 `renderMode === 'hidden'`
 *     分支，先 detach + 隐藏 composer 再 return——**不执行** renderPersistentInput，
 *     因此两个 update*Switcher 不在首屏触达。认证启动等待 DOMContentLoaded
 *     （静态非 async module 先求值），boot 之后才第一次可能进入 interactive
 *     分支，此时桥键已注册。故本域保留零 classic 实现，无残余键。
 *   - R3：本域无 DOM 引用类状态键——两个下拉元素都是函数内局部、模块私有。
 *   - R4：模块顶层只有 import、常量表、协议挂载、桥注册与 claim；无 DOM 查询、
 *     无监听安装、无定时器，延迟到模块执行相与加载序等价。
 *   - S（sloppy → strict）：原文件无 'use strict'。逐条排查：无隐式全局赋值、
 *     无对只读属性的静默失败赋值、无 `with`、无顶层 `this`、函数体内无裸
 *     `this`（全部是具名函数声明 / 对象方法形态）。转为 strict 后唯一形态差异
 *     是 `typeof <未声明标识符>` 的守卫——本文件里这些目标已改为 import 或显式
 *     `window.X`，不再依赖 sloppy 的「未声明标识符 typeof 也安全」行为。
 *
 * TDZ 修复与语言读取边界：`toggleInputModelDropdown` 原有两处语言读取（点击时 /
 * 异步查询后起菜单前），后者与外层同名 `isZh` 把失败提示分支整段遮蔽成 TDZ。
 * 修法保留两个读取时点：失败提示（runtime 未就绪 / 通道未声明 / 请求冲突 /
 * 恢复失败）用点击时的 `isZh`；菜单文案用独立变量 `menuIsZh`，读取点仍是原
 * 声明位置（通道 / 状态 / 预设三次查询之后），作用范围只到菜单渲染。
 *
 * 投递路径（ADR-0034）：模型 / 思考档位切换统一走 model-selection Feature 的
 * feature-comms 请求面（selectModel / clearThinkingOverride）；旧
 * /protoclaw/swap_model、/protoclaw/swap_thinking_effort 路由已退役。
 * 控件可用性 = 通道声明事实（未装配 / 远程 / runtime 未起 → 不可用提示）。
 */

import { getCurrentLanguage } from './i18n-environment-state.js';
import { escapeHtml } from './markdown-utils.js';
import { ClawToast } from './toast-notify.js';
import { ClawFeatureCommunication } from './feature-communication.js';
import {
  clawModelPresetsMatchSession,
  ensureClawModelPresetsForSession,
  getClawModelPresets,
} from './model-preset-cache.js';
import { focusedAgentId } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { commitSessionViewPatch, isSessionViewTokenCurrent } from './session-view-commit-host.js';

// ── 输入框模型切换下拉 ──────────────────────────────────────────────

let _inputModelDropdown = null;
let _inputModelDropdownLoading = false;

// ── preset 列表的缓存与回源统一走 owner 模块（model-preset-cache.js）────
// 会话命名空间语义（ADR-0011）：agentId 始终携带当前会话身份（远程为
// remote:<connId>:… 命名空间），服务端派生连接后返回远程自己的 preset
// 列表，本地会话行为不变；缓存按会话身份失效，防止本地/远程切换后
// 串用上一会话的列表。

function _getInputAgentId() {
  // Model swap is keyed on the HOST agent ID (e.g. 'programming-helper'),
  // not the ViewerWorker child UUID. The config file
  // (user data agent-configs/{agentId}.json) and IPC delivery
  // (sendIPCToAllSessions → listAgentRuntimes) both use the host ID.
  // focusedAgentId is set to the host ID by switchAgent().
  if (focusedAgentId) return focusedAgentId;
  // Fallback: resolve via host record
  if (typeof window.getCurrentHostAgentRecord === 'function') {
    let host = window.getCurrentHostAgentRecord();
    if (host && host.id) return host.id;
  }
  if (typeof window.getCurrentAgentRecord === 'function') {
    let agent = window.getCurrentAgentRecord();
    if (agent && agent.id) return agent.id;
  }
  return null;
}

function _getInputDefaultPresetName() {
  const model = window.readCurrentSessionViewState().overview;
  if (model.presetName) return model.presetName;
  if (model.modelRevision != null || model.modelName) return '';

  // 启动配置只用于首份运行时模型状态到达之前。
  // Priority 2: preset from agent config (startup default, before first poll)
  let agent = typeof window.getRuntimeAwareAgentRecord === 'function'
    ? window.getRuntimeAwareAgentRecord()
    : null;
  if (!agent) return '';
  let modelPresets = agent.modelPresets || {};
  let defaultCfg = modelPresets.default || {};
  if (typeof defaultCfg === 'string') return defaultCfg;
  return (defaultCfg && defaultCfg.primary) || '';
}

function _closeInputModelDropdown() {
  if (_inputModelDropdown) {
    let dropdown = _inputModelDropdown;
    _inputModelDropdown = null;
    dropdown.classList.remove('visible');
    let btn = document.getElementById('input-model-switch-btn');
    if (btn) btn.classList.remove('dd-open');
    setTimeout(function() {
      dropdown.remove();
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

// ── 通道可用性（ADR-0034 §5.1）──────────────────────────────────────
// 模型切换改走 model-selection Feature 的 feature-comms 请求面
// （/protoclaw/feature-comms/request → runtime IPC → onHostRequest）。
// 控件可用性 = 通道声明事实：未装配 Feature / 远程会话（本地 store 无声明）/
// runtime 未起 → 不开下拉，toast 提示。只缓存"可用"结论（不可用时重查，
// 避免 runtime 刚恢复阶段被失败缓存卡死）。

let _modelSelectionChannelOk = false; // { key, ok }
let _restoreFailureNotified = false; // per page session（会话切换重置）

function _modelSelectionTarget(agentId, viewToken = window.captureSessionViewToken()) {
  // 请求目标与回执归属必须来自同一份视图身份。宿主 active 是跨标签页可变的
  // 工作空间状态，不能用它补齐缺失身份，否则会切到另一个对话。
  const identity = viewToken.identity;
  if (!viewToken.runtimeId || !identity?.sessionId || identity.agentId !== agentId) return null;
  return { agentId: identity.agentId, sessionId: identity.sessionId, featureId: 'model-selection', channelId: 'selection' };
}

function _isModelSelectionTargetPending(agentId, viewToken) {
  const identity = viewToken?.identity;
  return !!identity?.sessionId
    && identity.agentId === agentId
    && !viewToken.runtimeId;
}

function _notifyModelSelectionTargetUnavailable(agentId, viewToken, isZh) {
  if (_isModelSelectionTargetPending(agentId, viewToken)) {
    _notifyModelSelectionNotReady(isZh);
    return;
  }
  _notifyModelSelectionUnavailable(isZh);
}

async function _ensureModelSelectionChannel(agentId, viewToken = window.captureSessionViewToken()) {
  const target = _modelSelectionTarget(agentId, viewToken);
  if (!target) return _isModelSelectionTargetPending(agentId, viewToken) ? null : false;
  if (!isSessionViewTokenCurrent(viewToken)) return false;
  const { sessionId } = target;
  let key = agentId + '|' + sessionId + '|' + viewToken.runtimeId;
  if (_modelSelectionChannelOk && _modelSelectionChannelOk.key === key && _modelSelectionChannelOk.ok) return true;
  if (!_modelSelectionChannelOk || _modelSelectionChannelOk.key !== key) _restoreFailureNotified = false;
  try {
    let channels = await ClawFeatureCommunication.listChannels(agentId, sessionId);
    if (!isSessionViewTokenCurrent(viewToken)) return false;
    let declared = (channels || []).some(function(ch) {
      return ch && ch.featureId === 'model-selection' && ch.channelId === 'selection';
    });
    _modelSelectionChannelOk = { key, ok: declared };
    return declared;
  } catch (e) {
    // 查询失败不等于 Feature 缺席：所选对话正在重新打开时，runtime / 会话
    // 操作会临时拒绝请求。此类情况按「尚未就绪」处理，不缓存为不可用。
    _modelSelectionChannelOk = false;
    return null;
  }
}

function _notifyModelSelectionUnavailable(isZh) {
  ClawToast.show({
    id: 'input-model-unavailable',
    title: isZh ? '当前会话不支持模型切换' : 'Model switching unavailable for this session',
    status: 'info',
    autoDismiss: 3500,
  });
}

function _notifyModelSelectionNotReady(isZh) {
  ClawToast.show({
    id: 'input-model-not-ready',
    title: isZh ? '会话正在加载，请稍后再试' : 'Session is loading. Try again shortly.',
    status: 'info',
    autoDismiss: 3500,
  });
}

function _isSessionOperationConflict(error) {
  return error?.status === 409 || error?.code === 'session_operation_in_progress';
}

function _notifySessionOperationInProgress(isZh, toastId = null) {
  const notice = {
    status: 'info',
    title: isZh ? '会话正在切换，请稍后重试' : 'Session is changing. Try again shortly.',
    description: '',
    closable: true,
    autoDismiss: 3500,
  };
  if (toastId) ClawToast.update(toastId, notice);
  else ClawToast.show({ id: 'input-model-operation-in-progress', ...notice });
}

function _notifyModelSelectionRequestError(error, isZh, toastId) {
  const busy = _isSessionOperationConflict(error);
  if (busy) {
    _notifySessionOperationInProgress(isZh, toastId);
    return;
  }
  ClawToast.update(toastId, {
    status: 'error',
    title: isZh ? '切换失败' : 'Switch failed',
    description: error?.message || String(error),
    closable: true,
    autoDismiss: 8000,
  });
}

async function _performInputModelSwap(agentId, presetName, viewToken = window.captureSessionViewToken()) {
  let isZh = getCurrentLanguage() === 'zh';
  if (!isSessionViewTokenCurrent(viewToken)) return;
  const target = _modelSelectionTarget(agentId, viewToken);
  if (!target) { _notifyModelSelectionTargetUnavailable(agentId, viewToken, isZh); return; }
  let toastId = 'input-model-swap';

  ClawToast.show({
    id: toastId,
    title: isZh ? '正在切换模型...' : 'Switching model...',
    status: 'loading',
    closable: false,
  });

  try {
    // 会话级 Feature 请求面（ADR-0034）：精确四元组寻址会话 runtime，
    // 回执 meta 为 Feature 端 getLLMMeta() 快照；代次拒绝机制沿用。
    const result = await ClawFeatureCommunication.request(
      target,
      'selectModel',
      { presetName },
    );
    if (result && result.ok) {
      commitSessionViewPatch(viewToken, { model: result.meta }, () => {
        updateInputModelSwitcher();
        updateThinkingEffortSwitcher();
        if (typeof window.updateChatContextBar === 'function') window.updateChatContextBar();
      });
      // __default__ 合成名 → 显示实际切换到的模型名（回执 meta 携带）
      let swapDesc = presetName;
      if (presetName === '__default__' && result?.meta?.modelName) swapDesc = result.meta.modelName;
      else if (typeof window.formatPresetDisplayName === 'function') swapDesc = window.formatPresetDisplayName(presetName);
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '模型已切换' : 'Model switched',
        description: swapDesc,
        autoDismiss: 3000,
      });
    } else {
      const error = new Error((result && (result.error || result.code)) || 'Unknown error');
      error.code = result?.code;
      throw error;
    }
  } catch (e) {
    console.error('[InputModelSwitch] Swap failed:', e);
    _notifyModelSelectionRequestError(e, isZh, toastId);
  }
}

export function toggleInputModelDropdown(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (_inputModelDropdown) {
    _closeInputModelDropdown();
    return;
  }
  if (_inputModelDropdownLoading) return;

  let btn = document.getElementById('input-model-switch-btn');
  if (!btn) return;

  let agentId = _getInputAgentId();
  if (!agentId) return;
  const viewToken = window.captureSessionViewToken();
  const target = _modelSelectionTarget(agentId, viewToken);

  let isZh = getCurrentLanguage() === 'zh';
  if (!target) { _notifyModelSelectionTargetUnavailable(agentId, viewToken, isZh); return; }

  _inputModelDropdownLoading = true;
  // Fetch presets before creating the dropdown; keep the open action single-flight.
  return (async function() {
    try {
      // 通道声明事实 = 控件可用性（ADR-0034 §5.1）：未装配 / 远程 / runtime
      // 未起均无 model-selection 声明 → 不可用提示，不打开下拉。
      const available = await _ensureModelSelectionChannel(agentId, viewToken);
      if (!isSessionViewTokenCurrent(viewToken)) return;
      if (available === null) {
        _notifyModelSelectionNotReady(isZh);
        return;
      }
      if (!available) {
        _notifyModelSelectionUnavailable(isZh);
        return;
      }
      // 恢复失败事实对账（§5.3）：每次打开下拉查一次 getStatus，
      // 有 lastRestoreFailure 时 toast 呈现一次（per session）。
      try {
        const status = await ClawFeatureCommunication.request(
          target,
          'getStatus',
          {},
        );
        if (!isSessionViewTokenCurrent(viewToken)) return;
        if (status?.ok && status.lastRestoreFailure && !_restoreFailureNotified) {
          _restoreFailureNotified = true;
          let presetLabel = status?.choice?.presetName || '';
          if (typeof window.formatPresetDisplayName === 'function' && presetLabel) {
            presetLabel = window.formatPresetDisplayName(presetLabel);
          }
          ClawToast.show({
            id: 'model-restore-failure',
            title: isZh ? '模型恢复失败' : 'Model restore failed',
            description: isZh
              ? `模型 ${presetLabel || '(未知)'} 恢复失败，已回退全局默认；原选择保留`
              : `Model ${presetLabel || '(unknown)'} could not be restored; fell back to global default (choice kept)`,
            status: 'warn',
            autoDismiss: 8000,
          });
        }
      } catch (error) {
        if (_isSessionOperationConflict(error)) {
          _notifySessionOperationInProgress(getCurrentLanguage() === 'zh');
          return;
        }
        // 状态对账失败不代表 Feature 不支持；非冲突错误不阻止打开菜单。
      }

      if (!isSessionViewTokenCurrent(viewToken)) return;
      let presets;
      try {
        presets = await ensureClawModelPresetsForSession(viewToken.runtimeId);
      } catch (e) {
        console.error('[InputModelSwitch] Failed to load presets:', e);
        return;
      }
      if (!isSessionViewTokenCurrent(viewToken) || !presets.length) return;

      let currentPreset = _getInputDefaultPresetName();
      // 菜单文案的语言在**原声明时点**重新读取（通道 / 状态 / 预设三次查询与
      // 其间可能发生的语言切换之后）。原实现就是在这里再读一次当前语言，只是
      // 与外层同名 `isZh` 而整段遮蔽了失败提示分支；改用独立变量后读取时点与
      // 作用范围都保持原样——只服务菜单渲染，失败提示仍用点击时的 isZh。
      const menuIsZh = getCurrentLanguage() === 'zh';

    let dropdown = document.createElement('div');
    _inputModelDropdown = dropdown;
    dropdown.className = 'ccb-model-dropdown';

     let selectedSource = 'all';
     const sourceLabel = function(p) {
       if (p.catalogProvider === 'codex' || p.authType === 'oauth-codex') return 'codex';
       if (p.catalogProvider === 'opencode' || ['OpenCode Zen', 'OpenCode Go'].includes(p.providerName)) return 'opencode';
       return 'custom';
     };
     const sourceTabs = '<div class="ccb-model-source-tabs">'
       + ['all', 'custom', 'codex', 'opencode'].map(function(source) {
         const label = source === 'all' ? (menuIsZh ? '全部' : 'All') : source === 'custom' ? (menuIsZh ? '自定义' : 'Custom') : source === 'codex' ? 'Codex' : 'OpenCode';
         return '<button type="button" class="ccb-model-source-tab' + (source === 'all' ? ' active' : '') + '" data-source="' + source + '">' + label + '</button>';
       }).join('') + '</div>';
      let html = '<div class="ccb-model-dropdown-card">' + sourceTabs + '<div class="ccb-model-dropdown-list">';
     presets.forEach(function(p) {
      let name = p.name || p.model || '';
      let isActive = name === currentPreset;
      let visionIcon = p.vision === true
        ? '<svg class="ccb-md-vision" title="' + (menuIsZh ? '支持视觉' : 'Vision') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '';
      let ctxText = p.contextLength && p.contextLength > 0
        ? Math.round(p.contextLength / 1000) + 'K'
        : '';
      html += '<div class="ccb-md-item' + (isActive ? ' active' : '') + '" data-source="' + sourceLabel(p) + '" data-preset="' + escapeHtml(name) + '">'
        + '<span class="ccb-md-left">'
        + '<span class="ccb-md-name">' + escapeHtml(name) + '</span>'
        + visionIcon
        + '</span>'
        + '<span class="ccb-md-right">'
        + (ctxText ? '<span class="ccb-md-ctx">' + ctxText + '</span>' : '')
        + '</span>'
        + '</div>';
    });
      html += '</div></div>';
    dropdown.innerHTML = html;

    // Position relative to the button — open upward
    let rect = btn.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';

     dropdown.addEventListener('click', function(e) {
       const sourceTab = e.target.closest('.ccb-model-source-tab');
       if (sourceTab) {
         selectedSource = sourceTab.dataset.source || 'all';
         dropdown.querySelectorAll('.ccb-model-source-tab').forEach(function(button) { button.classList.toggle('active', button === sourceTab); });
         dropdown.querySelectorAll('.ccb-md-item').forEach(function(item) { item.style.display = selectedSource === 'all' || item.dataset.source === selectedSource ? '' : 'none'; });
         return;
       }
       let item = e.target.closest('.ccb-md-item');
      if (!item) return;
      let presetName = item.dataset.preset;
      _closeInputModelDropdown();
      _performInputModelSwap(agentId, presetName, viewToken);
    });

    document.body.appendChild(dropdown);
    btn.classList.add('dd-open');
    // Measure height after insert, then place above the button
    let ddHeight = dropdown.offsetHeight;
    dropdown.style.top = (rect.top - ddHeight - 4) + 'px';
    requestAnimationFrame(function() { if (dropdown.isConnected) dropdown.classList.add('visible'); });

    setTimeout(function() {
      document.addEventListener('click', _inputModelDropdownOutsideClick, { once: true });
    }, 0);
    } finally {
      _inputModelDropdownLoading = false;
    }
  })();
}

/**
 * Update the model name shown in the input-area switcher button.
 * Called on render and after model swap.
 */

export function updateInputModelSwitcher() {
  let nameEl = document.querySelector('.input-model-name');
  if (!nameEl) return;
  let displayName = _getInputDefaultPresetName() || window.readCurrentSessionViewState().overview.modelName || '';
  if (displayName === '__default__') {
    displayName = window.readCurrentSessionViewState().overview.modelName;
  }
  if (typeof window.formatPresetDisplayName === 'function') displayName = window.formatPresetDisplayName(displayName);
  nameEl.textContent = displayName || (getCurrentLanguage() === 'zh' ? '模型' : 'Model');
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

// 既有命名空间协议：protocol → 可选思考档位列表。
// 消费方（ph-settings / ph-project-actions / memo 插件）按 ClawFW 命名空间
// 取用，因此保留挂载；本域内部直接调用同一函数，不再经 window 绕行。
export function getThinkingEffortOptions(protocol) {
  return Object.keys(protocol === 'openai' ? OPENAI_EFFORT_LABELS : ANTHROPIC_EFFORT_LABELS);
}

window.ClawFW = window.ClawFW || {};
window.ClawFW.getThinkingEffortOptions = getThinkingEffortOptions;

let _inputThinkingDropdown = null;

function _getCurrentPreset() {
  let presets = getClawModelPresets();
  if (!presets.length) return null;
  let currentName = _getInputDefaultPresetName();
  if (!currentName) return null;
  return presets.find(function(p) { return (p.name || p.model) === currentName; }) || null;
}

function _getCurrentPresetProtocol() {
  const provider = window.readCurrentSessionViewState().overview.provider;
  if (provider) return provider;
  let preset = _getCurrentPreset();
  return (preset && (preset.provider || preset.protocol)) || 'anthropic';
}

function _getEffortLabel(effort) {
  return OPENAI_EFFORT_LABELS[effort] || ANTHROPIC_EFFORT_LABELS[effort] || effort;
}

function _getCurrentThinkingEffort() {
  const model = window.readCurrentSessionViewState().overview;
  if (model.modelRevision != null || model.modelName || model.presetName) return model.thinkingEffort ?? null;
  return _getCurrentPreset()?.thinkingEffort || null;
}

function _currentModelSupportsThinking() {
  let preset = _getCurrentPreset();
  if (preset) {
    return preset.thinkingEffort != null && preset.thinkingEffort !== '' && preset.thinkingEffort !== 'none';
  }
  // preset 表查不到（如 __default__ 全局默认）时以 runtime live meta 判断
  const effort = window.readCurrentSessionViewState().overview.thinkingEffort;
  return effort != null && effort !== '' && effort !== 'none';
}

function _closeThinkingEffortDropdown() {
  if (_inputThinkingDropdown) {
    _inputThinkingDropdown.classList.remove('visible');
    let btn = document.getElementById('input-thinking-btn');
    if (btn) btn.classList.remove('dd-open');
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

async function _performThinkingEffortSwap(agentId, thinkingEffort, viewToken = window.captureSessionViewToken()) {
  let isZh = getCurrentLanguage() === 'zh';
  if (!isSessionViewTokenCurrent(viewToken)) return;
  const target = _modelSelectionTarget(agentId, viewToken);
  if (!target) { _notifyModelSelectionTargetUnavailable(agentId, viewToken, isZh); return; }
  let toastId = 'input-thinking-swap';

  ClawToast.show({
    id: toastId,
    title: isZh ? '正在切换思考强度...' : 'Switching thinking effort...',
    status: 'loading',
    closable: false,
  });

  try {
    // 两态契约（ADR-0034 §7）：显式档位 = selectModel（当前 preset + thinkingEffort）；
    // "默认（预设）" = clearThinkingOverride（删除覆盖，回 preset 配置档——
    // 修正旧行为：此前发送 null 实为"厂商默认"语义，与文案不符）。
    let result;
    if (thinkingEffort) {
      let presetName = _getInputDefaultPresetName();
      if (!presetName) {
        throw new Error(isZh ? '当前模型无 preset 锚点，无法切换思考强度' : 'No preset anchor for thinking effort switch');
      }
      result = await ClawFeatureCommunication.request(
        target,
        'selectModel',
        { presetName, thinkingEffort },
      );
    } else {
      result = await ClawFeatureCommunication.request(
        target,
        'clearThinkingOverride',
        {},
      );
    }
    if (result && result.ok) {
      commitSessionViewPatch(viewToken, { model: result.meta }, () => {
        updateInputModelSwitcher();
        updateThinkingEffortSwitcher();
        if (typeof window.updateChatContextBar === 'function') window.updateChatContextBar();
      });
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '思考强度已切换' : 'Thinking effort switched',
        autoDismiss: 3000,
      });
    } else {
      const error = new Error((result && (result.error || result.code)) || 'Unknown error');
      error.code = result?.code;
      throw error;
    }
  } catch (e) {
    console.error('[InputThinkingEffort] Swap failed:', e);
    _notifyModelSelectionRequestError(e, isZh, toastId);
  }
}

export async function toggleThinkingEffortDropdown(event) {
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

  let isZh0 = getCurrentLanguage() === 'zh';
  const viewToken = window.captureSessionViewToken();

  // 与模型下拉同一可用性闸（ADR-0034 §5.1）：两控件同属 model-selection 通道。
  const available = await _ensureModelSelectionChannel(agentId, viewToken);
  if (!isSessionViewTokenCurrent(viewToken)) return;
  if (available === null) {
    _notifyModelSelectionNotReady(isZh0);
    return;
  }
  if (!available) {
    _notifyModelSelectionUnavailable(isZh0);
    return;
  }

  // Block switching if current model doesn't support thinking
  if (!_currentModelSupportsThinking()) {
    return;
  }

  let isZh = getCurrentLanguage() === 'zh';
  let protocol = _getCurrentPresetProtocol();
  let efforts = getThinkingEffortOptions(protocol);
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
    _performThinkingEffortSwap(agentId, effort || null, viewToken);
  });

  document.body.appendChild(_inputThinkingDropdown);
  btn.classList.add('dd-open');
  // Measure height after insert, then place above the button
  let ddHeight = _inputThinkingDropdown.offsetHeight;
  _inputThinkingDropdown.style.top = (rect.top - ddHeight - 4) + 'px';
  requestAnimationFrame(function() { _inputThinkingDropdown.classList.add('visible'); });

  setTimeout(function() {
    document.addEventListener('click', _inputThinkingDropdownOutsideClick, { once: true });
  }, 0);
}

export function updateThinkingEffortSwitcher() {
  let btn = document.getElementById('input-thinking-btn');
  let nameEl = document.querySelector('.input-thinking-name');
  if (!nameEl) return;
  let isZh = getCurrentLanguage() === 'zh';

  // If presets aren't loaded yet, fetch them first and re-render.
  // This MUST happen before the supportsThinking check, otherwise
  // the early return for "不支持思考" blocks the fallback forever.
  // Presets must match the current session namespace (ADR-0011)：缓存按会话
  // 身份失效，回源带当前会话 agentId（远程会话拿到远程自己的 preset 列表）。
  let presets = clawModelPresetsMatchSession(currentRuntimeAgentId || '')
    ? getClawModelPresets() : [];
  if (!presets.length) {
    // Show a neutral label while loading — NOT "不支持思考" which is misleading
    const effort = _getCurrentThinkingEffort();
    nameEl.textContent = effort ? _getEffortLabel(effort) : (isZh ? '思考强度' : 'Thinking');
    nameEl.style.opacity = '';
    if (btn) {
      btn.classList.remove('thinking-disabled');
      btn.title = '';
    }
    ensureClawModelPresetsForSession(currentRuntimeAgentId || '').then(function() {
      // 只在缓存真正命中时重渲染：列表为空（或 ClawFW 未就绪）时不再递归
      // 回源，避免空 preset 列表场景下的无限 fetch 循环。
      if (clawModelPresetsMatchSession(currentRuntimeAgentId || '')) updateThinkingEffortSwitcher();
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

// ── 兼容桥（KernelState 访问器）────────────────────────────────────────
// 逐键消费面（grep public/，排除定义方）：
//   updateInputModelSwitcher         ← persistent-input.js（renderPersistentInput，
//     无守卫直调）、app-main.js（两处宿主适配器，typeof 守卫）、
//     agent-data-loader.js（ESM，window 调用 + typeof 守卫）、
//     p2-w2-3a-queue-projection.js（ESM，window 调用）
//   updateThinkingEffortSwitcher     ← 同上四处
//   toggleInputModelDropdown         ← input-composer.js（按钮 onclick 装配）
//   toggleThinkingEffortDropdown     ← input-composer.js（同上）
// 注销条件：上述 classic 文件与两个 ESM 消费方各自迁移后改 import、逐键注销
// （ESM 消费方由后续批次收敛，不在本批授权范围）。
// 注册相位 = 本模块执行相：四个键只在函数体 / 事件回调内被调用或读取，classic
// 相与 boot 首轮均无触达点（见文件头时序审计 R1/R2）。
const bridgeApi = {
  updateInputModelSwitcher,
  updateThinkingEffortSwitcher,
  toggleInputModelDropdown,
  toggleThinkingEffortDropdown,
};

window.KernelState.defineKey('input-model-switcher', 'updateInputModelSwitcher', updateInputModelSwitcher);
window.KernelState.defineKey('input-model-switcher', 'updateThinkingEffortSwitcher', updateThinkingEffortSwitcher);
window.KernelState.defineKey('input-model-switcher', 'toggleInputModelDropdown', toggleInputModelDropdown);
window.KernelState.defineKey('input-model-switcher', 'toggleThinkingEffortDropdown', toggleThinkingEffortDropdown);
window.KernelState.claim('input-model-switcher', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
