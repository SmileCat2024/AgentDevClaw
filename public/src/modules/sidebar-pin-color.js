/**
 * sidebar-pin-color.js
 *
 * 侧栏待办 pin 的颜色交互域：
 *  - 色板常量 SIDEBAR_TODO_COLORS：runtime-status（条目关联）与
 *    ctx-menu-items（ctxTodoSession 归一化）共用的合法色值集合。
 *  - 已待办 pin 的 pointer 状态机：tap = 取消待办（转调
 *    onSidebarSessionPinClick 的 toggle 链路）；长按或向上拖动 = 在 pin
 *    上方弹出横排五色选择器，拖动松手命中色块即应用颜色，未命中则保持
 *    打开等待点击选择，点击外部或 Escape 关闭。
 *
 * 颜色持久化复用 ctxTodoSession（显式 todo + color，非 toggle）。乐观
 * 更新不进侧栏渲染签名，应用颜色后需清签名强制立即重渲。
 *
 * ESM 化：P2 W2-6（2026-11-17）
 * 依赖（ESM）：实时语言（i18n-environment-state.js）、sidebarRender
 * （p2-bootstrap-sidebar.js 的渲染签名适配面，owner 仍是 classic sidebar-render.js）。
 * renderAgentList / onSidebarSessionPinClick 仍 classic（window 晚绑定）。
 * ctxTodoSession 已改 import（ctx-menu-items.js 具名导出）。
 *
 * 桥接期兼容面（KernelState defineKey/claim，domain: sidebar-pin-color）：
 *   - SIDEBAR_TODO_COLORS ← classic runtime-status（window.* 读取）；ctx-menu-items
 *     已改 import（顶层不读该 let 绑定）；
 *     原形态是**可写**的 window 属性，因此保留 `let` live binding + claim 直写绑定，
 *     认领后 classic 的整值替换真正落到模块状态（模块内 applyTodoColor 的色值门禁
 *     读同一绑定），不产生"模块原 const / 桥槽"两份分叉。
 *   - onSidebarPinPointerDown ← classic sidebar-render 生成的 pin 按钮内联
 *     onpointerdown 属性（事件时点按裸标识符解析到 window）
 * 注销条件：两处消费方迁移后改 import，删除 defineKey 并下调桥债基线。
 */

import { getCurrentLanguage } from './i18n-environment-state.js';
import { sidebarRender } from './p2-bootstrap-sidebar.js';
// 与 ctx-menu-items 的静态环：本模块取它的待办入口，它取本模块的色板
//（`let` 绑定，只在该模块函数体内读取，顶层不读）；真实图由 p2-w2-6 / sidebar 用例执行。
import { ctxTodoSession } from './ctx-menu-items.js';

// 可整体替换的色板（沿用原 window 属性的写语义：classic 指派新 Set 后，模块内的
// 色值门禁必须看到同一个新实例）。
let SIDEBAR_TODO_COLORS = new Set(['white', 'red', 'yellow', 'green', 'blue']);

const TODO_COLOR_SWATCHES = [
  { id: 'white', zh: '白色', en: 'White' },
  { id: 'red', zh: '红色', en: 'Red' },
  { id: 'yellow', zh: '黄色', en: 'Yellow' },
  { id: 'green', zh: '绿色', en: 'Green' },
  { id: 'blue', zh: '蓝色', en: 'Blue' },
];

// 上拖超过该距离（px）视为拖出选择器；长按该时长（ms）同样弹出
const PIN_DRAG_THRESHOLD = 6;
const PIN_LONGPRESS_MS = 200;

const pinDrag = {
  pressing: false,   // 按压中（选择器未激活）
  active: false,     // 选择器已由本次按压拖出
  pointerId: null,
  startX: 0,
  startY: 0,
  pinEl: null,
  longPressTimer: 0,
};

let pickerEl = null;
let pickerPinned = false; // 松手未命中色块时保持打开，等待点击选择

function currentLanguageIsZh() {
  return typeof getCurrentLanguage() === 'string' && getCurrentLanguage() === 'zh';
}

function getPicker() {
  if (pickerEl) return pickerEl;
  pickerEl = document.createElement('div');
  pickerEl.id = 'sidebar-todo-color-picker';
  pickerEl.className = 'todo-color-picker';
  for (const swatch of TODO_COLOR_SWATCHES) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `todo-color-swatch todo-c-${swatch.id}`;
    dot.dataset.color = swatch.id;
    dot.title = currentLanguageIsZh() ? swatch.zh : swatch.en;
    pickerEl.appendChild(dot);
  }
  // 色块点击：仅在选择器保持打开（非拖动松手）路径生效
  pickerEl.addEventListener('click', (event) => {
    const dot = event.target.closest('.todo-color-swatch');
    if (!dot || !pickerPinned) return;
    applyTodoColor(pickerEl._pinEl, dot.dataset.color);
    closeTodoColorPicker();
  });
  document.body.appendChild(pickerEl);
  return pickerEl;
}

function positionPicker(pinEl) {
  const picker = getPicker();
  const rect = pinEl.getBoundingClientRect();
  const width = picker.offsetWidth;
  const height = picker.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.top - height - 8;
  if (top < 8) top = rect.bottom + 8;
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

function setPickerHover(color) {
  if (!pickerEl) return;
  for (const dot of pickerEl.querySelectorAll('.todo-color-swatch')) {
    dot.classList.toggle('hover', dot.dataset.color === color);
  }
}

function openTodoColorPicker(pinEl) {
  const picker = getPicker();
  picker._pinEl = pinEl;
  pickerPinned = false;
  const currentColor = pinEl?.dataset.todoColor || 'white';
  for (const dot of picker.querySelectorAll('.todo-color-swatch')) {
    dot.classList.toggle('current', dot.dataset.color === currentColor);
    dot.classList.remove('hover');
  }
  positionPicker(pinEl);
  picker.classList.add('open');
}

function closeTodoColorPicker() {
  if (!pickerEl) return;
  pickerEl.classList.remove('open');
  pickerEl._pinEl = null;
  pickerPinned = false;
}

/**
 * 应用待办颜色：显式 todo=true + color 走 ctxTodoSession 的服务链路
 * （乐观更新、失败回滚、delta 应用），并强制侧栏立即重渲。
 */
function applyTodoColor(pinEl, color) {
  if (!pinEl || !SIDEBAR_TODO_COLORS.has(color)) return;
  const ctxEl = pinEl.closest('[data-ctx-role]');
  if (!ctxEl) return;
  const ns = ctxEl.dataset.ctxNs;
  const sessionId = ctxEl.dataset.ctxSessionId || ctxEl.dataset.ctxId;
  if (!ns || !sessionId) return;
  ctxTodoSession(
    { role: ctxEl.dataset.ctxRole, ns, id: sessionId, sessionId, variant: ctxEl.dataset.ctxVariant || 'default' },
    { todo: true, color },
  );
  // 乐观颜色不进渲染签名：清签名强制下次 renderAgentList 立即重建。
  sidebarRender.lastAgentListRenderSignature = '';
  // 桥接期：renderAgentList 定义于 classic sidebar-render（侧栏渲染域收敛时移除）
  if (typeof window.renderAgentList === 'function') window.renderAgentList();
}

function beginPinDrag() {
  if (!pinDrag.pressing || pinDrag.active) return;
  pinDrag.active = true;
  pinDrag.pinEl?.classList.add('dragging');
  openTodoColorPicker(pinDrag.pinEl);
}

function hitTestColorDot(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.('.todo-color-swatch') || null;
}

function releasePinListeners() {
  window.removeEventListener('pointermove', onPinPointerMove);
  window.removeEventListener('pointerup', onPinPointerUp);
  window.removeEventListener('pointercancel', onPinPointerCancel);
}

function onPinPointerMove(event) {
  if (!pinDrag.pressing || event.pointerId !== pinDrag.pointerId) return;
  const dy = event.clientY - pinDrag.startY;
  if (!pinDrag.active && dy <= -PIN_DRAG_THRESHOLD) {
    clearTimeout(pinDrag.longPressTimer);
    beginPinDrag();
  }
  if (pinDrag.active) {
    const dot = hitTestColorDot(event.clientX, event.clientY);
    setPickerHover(dot ? dot.dataset.color : '');
  }
}

function onPinPointerUp(event) {
  if (!pinDrag.pressing || event.pointerId !== pinDrag.pointerId) return;
  clearTimeout(pinDrag.longPressTimer);
  releasePinListeners();
  if (pinDrag.active) {
    pinDrag.pinEl?.classList.remove('dragging');
    const dot = hitTestColorDot(event.clientX, event.clientY);
    if (dot) {
      applyTodoColor(pinDrag.pinEl, dot.dataset.color);
      closeTodoColorPicker();
    } else {
      // 未命中色块：保持选择器打开，等待点击选择
      pickerPinned = true;
    }
  } else if (pinDrag.pinEl?.isConnected) {
    // tap：切换待办（toggle 链路）
    // 桥接期：onSidebarSessionPinClick 定义于 classic sidebar-render（侧栏渲染域收敛时移除）
    window.onSidebarSessionPinClick({ stopPropagation() {} }, pinDrag.pinEl);
  }
  pinDrag.pressing = false;
  pinDrag.active = false;
  pinDrag.pinEl = null;
}

function onPinPointerCancel(event) {
  if (event.pointerId !== pinDrag.pointerId) return;
  clearTimeout(pinDrag.longPressTimer);
  releasePinListeners();
  pinDrag.pinEl?.classList.remove('dragging');
  pinDrag.pressing = false;
  pinDrag.active = false;
  pinDrag.pinEl = null;
  closeTodoColorPicker();
}

/**
 * 侧栏会话 pin 的 pointerdown 入口（斜 pin 与已待办 pin 统一走此状态机）。
 * tap = 切换待办（转调 onSidebarSessionPinClick 的 toggle 链路）；长按或
 * 上拖 = 弹出颜色选择器，选中色块以该色设为待办/换色。stopPropagation
 * 防止触发条目点击切换会话。
 */
function onSidebarPinPointerDown(event, pinEl) {
  if (event.button !== 0 || !event.isPrimary) return;
  if (!pinEl?.classList.contains('agent-session-pin')) return;
  // 选择器已打开（保持态）时再次按压 pin：先收起再开始新的按压
  closeTodoColorPicker();
  event.stopPropagation();
  event.preventDefault();
  pinDrag.pressing = true;
  pinDrag.active = false;
  pinDrag.pointerId = event.pointerId;
  pinDrag.startX = event.clientX;
  pinDrag.startY = event.clientY;
  pinDrag.pinEl = pinEl;
  try { pinEl.setPointerCapture(event.pointerId); } catch (_) { /* 桌面鼠标无需捕获也可工作 */ }
  pinDrag.longPressTimer = setTimeout(() => {
    if (pinDrag.pressing) beginPinDrag();
  }, PIN_LONGPRESS_MS);
  window.addEventListener('pointermove', onPinPointerMove);
  window.addEventListener('pointerup', onPinPointerUp);
  window.addEventListener('pointercancel', onPinPointerCancel);
}

export { SIDEBAR_TODO_COLORS, onSidebarPinPointerDown };

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 注销条件见文件头：ctx-menu-items / runtime-status 与 sidebar-render 迁移后
// 改 import，删除对应 defineKey 并下调桥债基线。
const bridgeApi = { onSidebarPinPointerDown };
window.KernelState.defineKey('sidebar-pin-color', 'SIDEBAR_TODO_COLORS', SIDEBAR_TODO_COLORS);
window.KernelState.defineKey('sidebar-pin-color', 'onSidebarPinPointerDown', onSidebarPinPointerDown);
window.KernelState.claim('sidebar-pin-color', {
  // SIDEBAR_TODO_COLORS 是 live binding：认领后 classic 写方整值替换落到本模块变量上
  // （模块内的色值门禁与 classic 读方共享同一实例）。
  get: (key) => (key === 'SIDEBAR_TODO_COLORS' ? SIDEBAR_TODO_COLORS : bridgeApi[key]),
  set: (key, value) => {
    if (key === 'SIDEBAR_TODO_COLORS') SIDEBAR_TODO_COLORS = value;
    else bridgeApi[key] = value;
  },
});

// 保持打开的选择器：点击外部关闭
document.addEventListener('pointerdown', (event) => {
  if (!pickerEl || !pickerPinned) return;
  if (pickerEl.contains(event.target)) return;
  closeTodoColorPicker();
});

// Escape 关闭保持打开的选择器
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !pickerEl || !pickerPinned) return;
  closeTodoColorPicker();
});
