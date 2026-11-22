/**
 * files-scenes.js — 文件面板「对话页签」域（宿主 scenes 能力的首个实现）
 *
 * 页签模型：面板标题恒为「文件」；上方一排对话页签——已固定的对话各占
 * 一个页签（对话标题 + 关闭，任何视角下都能认出所属对话），末尾是「当前
 * 对话」页签（字面标注，hover 提示当前对话名），跟随当前对话并带加号，
 * 点加号即把当前对话固定成页签；当前对话已固定时当前页签隐藏（那个固定
 * 页签就是它）。固定页签的现场（目录树 + 打开文件 + 分栏）在切对话、切
 * 面板、收起右栏时保活；接续按线程 head session 重新寻址文件请求，绝不
 * 改投当前焦点对话。分支是另一条线程，天然不会被接走（身份按 threadId 认）。
 *
 * 分工：本模块只管文件域的事实与页签 UI（哪些对话固定了、选中谁、怎么
 * 固定、怎么解析线程 head）；实例的保活/暂存/恢复/卸载由 debug-panel-host
 * 的 scenes 机制按 instanceKey 通用处理，宿主不感知「文件」语义。
 *
 * 现场身份：agentId + threadId（无线程的会话退化为 sessionId，此时不跟随
 * 接续——head 无从解析）。第一版不跨页面刷新持久化（刷新后页签消失，与
 * 既有承诺一致）。
 */
import { escapeHtml } from './markdown-utils.js';
import { activeFeaturePanel } from './render-entry-state.js';
import {
  renderFeaturePanel,
  toggleFeaturePanel,
  adoptSceneInstance,
  releaseSceneInstance,
} from './debug-panel-host.js';
import { getThreadById, getThreadForSession, refreshThreads } from './thread-store.js';

const PANEL_ID = 'files';

const pinnedScenes = new Map(); // key → { key, agentId, threadId, sessionId, label }
let selectedSceneKey = ''; // '' = 当前页签（跟随当前对话）

// ── 身份与标签 ────────────────────────────────────────────────────

function currentIdentity() {
  const agentId = window.getCurrentHostAgentRecord?.()?.id || window.focusedAgentId || '';
  const view = window.getCurrentSessionViewIdentity?.();
  const sessionId = window.currentRuntimeAgentId && view?.agentId === agentId ? String(view.sessionId || '') : '';
  return { agentId, sessionId };
}

function threadIdOf(identity) {
  return (identity.agentId && identity.sessionId
    ? getThreadForSession(identity.agentId, identity.sessionId)?.threadId
    : '') || '';
}

function sessionLabel(identity) {
  const session = (window.allAgents || []).find?.((item) => item.sessionId === identity.sessionId);
  const thread = identity.agentId && identity.sessionId
    ? getThreadForSession(identity.agentId, identity.sessionId) : null;
  return thread?.title || session?.title || '对话';
}

function sceneKey(agentId, threadId, sessionId) {
  return `${agentId}:${threadId || sessionId}`;
}

function liveInstanceKey(identity) {
  return `files:live:${identity.agentId}:${identity.sessionId}`;
}

/** 现场的文件请求目标：线程 head session（接续换代后自动指向新一代）。 */
function headSessionIdOf(scene) {
  return (scene.threadId && getThreadById(scene.threadId)?.headSessionId) || scene.sessionId;
}

// ── 页签操作 ───────────────────────────────────────────────────────

function refreshView() {
  renderStripIntoSlot();
  if (activeFeaturePanel === PANEL_ID) renderFeaturePanel();
  else toggleFeaturePanel(PANEL_ID);
}

function renderStripIntoSlot() {
  const slot = document.getElementById('feature-panel-scenes');
  if (slot) renderStrip(slot);
}

/**
 * 固定当前对话：刷新线程事实 → 以 threadId 登记页签 → 宿主把在位实例原地
 * 转正（DOM 不重建）。仅在当前页签（未选中固定页签）时可调用；重复固定
 * 同一对话是幂等的选中。
 */
export async function pinCurrentScene() {
  if (selectedSceneKey) return;
  await refreshThreads(true).catch(() => {});
  const identity = currentIdentity();
  if (!identity.agentId || !identity.sessionId) return;
  const threadId = threadIdOf(identity);
  const key = sceneKey(identity.agentId, threadId, identity.sessionId);
  if (!pinnedScenes.has(key)) {
    pinnedScenes.set(key, {
      key,
      agentId: identity.agentId,
      threadId,
      sessionId: identity.sessionId,
      label: getThreadForSession(identity.agentId, identity.sessionId)?.title || sessionLabel(identity),
    });
  }
  selectedSceneKey = key;
  adoptSceneInstance(PANEL_ID, key);
  refreshView();
}

export function selectCurrentScene() {
  selectedSceneKey = '';
  refreshView();
}

export function selectPinnedScene(key) {
  if (!pinnedScenes.has(key)) return false;
  selectedSceneKey = key;
  refreshView();
  return true;
}

export function closePinnedScene(key) {
  if (!pinnedScenes.delete(key)) return false;
  if (selectedSceneKey === key) selectedSceneKey = '';
  releaseSceneInstance(PANEL_ID, key); // 精确卸载该现场实例（暂存或在位）
  refreshView();
  return true;
}

export function listPinnedScenes() {
  return [...pinnedScenes.values()];
}

// ── scenes 能力面（交给面板注册元数据）──────────────────────────

/**
 * 宿主构建面板上下文时的现场覆盖。当前页签给出跟随当前对话的 identity 与
 * live instanceKey；固定页签按线程 head session 寻址，instanceKey 用页签
 * key（接续换代时 identity 更新、instanceKey 不变 → 实例原地保留、请求
 * 重定向到新 head）。pinned 标记面板内部「跟随当前会话」还是「钉住目标」。
 */
function overlayContext() {
  const scene = selectedSceneKey ? pinnedScenes.get(selectedSceneKey) : null;
  if (!scene) {
    const identity = currentIdentity();
    return {
      identity,
      instanceKey: liveInstanceKey(identity),
      keepAlive: false,
      pinned: false,
    };
  }
  return {
    identity: { agentId: scene.agentId, sessionId: headSessionIdOf(scene) },
    instanceKey: scene.key,
    keepAlive: true,
    pinned: true,
  };
}

/** 头部对话页签条：固定页签在前，当前页签垫底（当前对话已固定则隐藏）。 */
function renderStrip(stripEl) {
  const identity = currentIdentity();
  const showCurrent = !!identity.sessionId
    && !pinnedScenes.has(sceneKey(identity.agentId, threadIdOf(identity), identity.sessionId));
  stripEl.innerHTML = [...pinnedScenes.values()].map((scene) => {
    const active = scene.key === selectedSceneKey;
    return `<div class="feature-panel-scene${active ? ' is-active' : ''}" role="presentation">`
      + `<button type="button" class="feature-panel-scene-select" role="tab" aria-selected="${active}" data-scene-key="${escapeHtml(scene.key)}">${escapeHtml(scene.label)}</button>`
      + `<button type="button" class="feature-panel-scene-close" aria-label="关闭 ${escapeHtml(scene.label)}" data-close-scene="${escapeHtml(scene.key)}">×</button></div>`;
  }).join('') + (showCurrent
    ? `<div class="feature-panel-scene${!selectedSceneKey ? ' is-active' : ''}" role="presentation">`
      + `<button type="button" class="feature-panel-scene-select" role="tab" aria-selected="${!selectedSceneKey}" data-scene-current title="${escapeHtml(sessionLabel(identity))}">当前对话</button>`
      + `<button type="button" class="feature-panel-scene-pin" aria-label="固定此对话" data-pin-scene>+</button></div>`
    : '');
  stripEl.querySelector('[data-scene-current]')?.addEventListener('click', selectCurrentScene);
  stripEl.querySelectorAll('[data-scene-key]').forEach((button) => {
    button.addEventListener('click', () => selectPinnedScene(button.dataset.sceneKey));
  });
  stripEl.querySelectorAll('[data-close-scene]').forEach((button) => {
    button.addEventListener('click', () => closePinnedScene(button.dataset.closeScene));
  });
  stripEl.querySelector('[data-pin-scene]')?.addEventListener('click', () => { void pinCurrentScene(); });
}

/**
 * rail 图标点击接管：选中固定页签时，图标点击永远回到当前页签（「文件
 * 入口打开当前对话的文件树」契约）；在当前页签时返回 false 走常规开关。
 */
function activateDefault() {
  if (!selectedSceneKey) return false;
  selectedSceneKey = '';
  refreshView();
  return true;
}

export const filesSceneCapability = { overlayContext, renderStrip, activateDefault };
