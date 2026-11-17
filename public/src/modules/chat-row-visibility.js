/**
 * chat-row-visibility.js — 长会话整行可见性窗口（ESM 域）
 *
 * Long process views retain their DOM, but only nearby rows participate in
 * painting and accessibility updates. Measure real heights before hiding rows;
 * estimates would move the scrollbar and the user's reading position.
 *
 * ESM 迁移（P2 第二波批次 1，原位转换）：原 classic IIFE 的三个
 * `window.clearMeasuredChatRows / refreshMeasuredChatRows / revealMeasuredChatRow`
 * 收敛为命名导出，内部状态（entries / byRow / first / last / width / raf）与
 * `hiddenClass` 变为模块私有。装载时相从「classic 加载相」变为「首个 import
 * 它的模块执行相」（deferred）；模块顶层只做 CSS 能力探测与 container 监听
 * 注册，无首屏同步调用点。
 *
 * 首屏唯一触达与为何可延后：classic 相的
 * `app-main 顶层 applyLanguage → renderCurrentMainView → updateChatContextBar
 * → notifyChatViewportMutation` 里对 refreshMeasuredChatRows 是
 * `typeof … === 'function'` 可选调用，且首屏 0 条 message-row 时该调用本身
 * 必然走 `refresh()` 的 `rows.length < 200 → clear()` 分支（entries 为空，
 * 只取消一个不存在的 rAF）——纯 no-op。延后到模块执行相注册不改变首屏表现，
 * 也不引入等待或补画。
 *
 * 依赖（已迁移部分直接 import）：
 *   - domRefs（p2-bootstrap-dom，container）
 *   - chatSurface（p2-bootstrap-chat-surface，showChatProcess / followLatestEnabled）
 *   - processWindowingMode（p2-w2-1-process-windowing-mode，原 lazy-tool-content 顶层标志）
 *   - clearMeasuredChatRows 的反向消费方 lazy-tool-content 走 import 本模块，
 *     不构成环（本模块不再 import 它）
 * 依赖（classic，显式 window 晚绑定；classic 脚本先于 deferred 模块执行，故
 * 模块执行相取用即已定义）：
 *   - window.captureChatViewportAnchor / window.applyChatViewportAnchor
 *     / window.runWithSuppressedChatViewportObservers（chat-viewport.js 顶层函数）
 */
import { domRefs } from './p2-bootstrap-dom.js';
import { chatSurface } from './p2-bootstrap-chat-surface.js';
import { processWindowingMode } from './p2-w2-1-process-windowing-mode.js';

const hiddenClass = 'chat-row-distant';
let entries = [], byRow = new Map(), first = 0, last = -1, width = 0, raf = 0;
const supported = typeof CSS !== 'undefined' && CSS.supports('content-visibility', 'hidden');

function reveal(entry) {
  if (!entry.hidden) return;
  entry.row.classList.remove(hiddenClass);
  entry.row.style.removeProperty('--chat-row-height');
  entry.hidden = false;
}

function hide(entry) {
  if (entry.hidden || entry.height <= 0 || entry.row.contains(document.activeElement)) return;
  entry.row.style.setProperty('--chat-row-height', entry.height + 'px');
  entry.row.classList.add(hiddenClass);
  entry.hidden = true;
}

function clear() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  for (const entry of entries) {
    if (entry.row.isConnected) reveal(entry);
  }
  entries = []; byRow.clear(); first = 0; last = -1; width = 0;
}

function apply(force = false) {
  raf = 0;
  if (!entries.length || !chatSurface.showChatProcess
    || !processWindowingMode.disabled || processWindowingMode.frozen) return;
  const top = domRefs.container.scrollTop, height = domRefs.container.clientHeight;
  // Move the window in batches, leaving a viewport of headroom on either
  // side. Ordinary wheel frames then perform no style writes.
  if (!force && last >= first && entries[first].top <= Math.max(0, top - height)
    && entries[last].top + entries[last].height >= top + height * 2) return;
  const lower = Math.max(0, top - height * 3), upper = top + height * 4;
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].top + entries[mid].height < lower) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  lo = start; hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].top <= upper) lo = mid + 1;
    else hi = mid;
  }
  const end = lo - 1;
  window.runWithSuppressedChatViewportObservers(() => {
    if (last < first) {
      entries.forEach((entry, i) => { if (i < start || i > end) hide(entry); });
    } else {
      for (let i = first; i <= last; i++) {
        if (i < start || i > end) hide(entries[i]);
      }
    }
    for (let i = start; i <= end; i++) reveal(entries[i]);
  }, 180);
  first = start; last = end;
}

function refresh(reason) {
  if (!supported || !chatSurface.showChatProcess || !processWindowingMode.disabled) { clear(); return; }
  if (processWindowingMode.frozen) return;
  const rows = Array.from(domRefs.container.querySelectorAll('.message-row'));
  if (rows.length < 200) { clear(); return; }
  const nextWidth = domRefs.container.clientWidth;
  const resized = width && width !== nextWidth;
  const rebuilt = !entries.length || entries[0].row !== rows[0]
    || rows.length < entries.length;

  // Incremental paths for streaming events: an append only appends rows
  // after the existing tail (prior offsetTop values are unaffected by a
  // tail insert), a patch-last only rewrites the last row's content. Both
  // reuse the old entries and skip the full measure pass + entries/byRow
  // rebuild — that full pass on every message event is the dominant JS
  // cost of long conversations in show-process mode.
  if (!resized && !rebuilt) {
    if (reason === 'append' && rows.length > entries.length) {
      for (let i = entries.length; i < rows.length; i++) {
        const row = rows[i];
        let entry = byRow.get(row);
        if (!entry) {
          entry = { row, hidden: false, top: 0, height: 0 };
          byRow.set(row, entry);
        }
        entry.top = row.offsetTop;
        entry.height = row.getBoundingClientRect().height;
        entries.push(entry);
      }
      width = nextWidth;
      first = 0; last = -1;
      apply(true);
      return;
    }
    if (reason === 'patch-last' && rows.length === entries.length) {
      const tail = entries[entries.length - 1];
      // Same contract as the full path: reveal before measuring, and never
      // realize the whole history for one patched row.
      reveal(tail);
      tail.top = tail.row.offsetTop;
      if (!tail.hidden) tail.height = tail.row.getBoundingClientRect().height;
      width = nextWidth;
      first = 0; last = -1;
      apply(true);
      return;
    }
  }

  let anchor = null;
  if (resized && !chatSurface.followLatestEnabled) anchor = window.captureChatViewportAnchor();
  if (rebuilt || resized) clear();
  // A tail patch can change an offscreen row while its old height is fixed.
  // Reveal that one row before measuring it; never realize the whole history.
  if (reason === 'patch-last') {
    const tail = byRow.get(rows[rows.length - 1]);
    if (tail) reveal(tail);
  }
  entries = rows.map(row => byRow.get(row) || {row, hidden:false, top:0, height:0});
  byRow = new Map(entries.map(entry => [entry.row, entry]));
  // Complete the read pass before changing any visibility/height styles.
  for (const entry of entries) {
    entry.top = entry.row.offsetTop;
    if (!entry.hidden) entry.height = entry.row.getBoundingClientRect().height;
  }
  width = nextWidth;
  if (anchor) window.applyChatViewportAnchor(anchor);
  // Rows exposed by a patch must rejoin the correct window even if its
  // boundaries did not move.
  first = 0; last = -1;
  apply(true);
}

domRefs.container.addEventListener('scroll', () => {
  if (entries.length && !raf) raf = requestAnimationFrame(() => apply());
}, {passive:true});
domRefs.container.addEventListener('load', event => {
  if (event.target?.tagName !== 'IMG') return;
  const entry = byRow.get(event.target.closest('.message-row'));
  if (!entry) return;
  reveal(entry); refresh('image-load');
}, true);

// ── 对外命名导出 ───────────────────────────────────────────────────
// 迁移前是 IIFE 内的 window.clearMeasuredChatRows / refreshMeasuredChatRows /
// revealMeasuredChatRow（行为层全局键）。导出名沿用原 window 键名：
//   - clearMeasuredChatRows：唯一消费方 lazy-tool-content 已改为 import 本模块，
//     无 classic 消费者，不上兼容桥；
//   - refreshMeasuredChatRows / revealMeasuredChatRow：仍有 classic 消费者
//     （chat-viewport 的 notifyChatViewportMutation、chat-renderer 的行揭示），
//     兼容桥在 p2-w2-1-chat-windowing-host.js，注销条件见该文件头注。
//
// revealMeasuredChatRow 的入参是**行元素**（chat-renderer 传
// `el.closest('.message-row')`），不是内部 entry：必须保留 byRow 查表包装，
// 不能直接把内部 reveal(entry) 当成导出面（否则会拿 row 当 entry 用，
// entry.row 为 undefined 直接抛错）。refreshMeasuredChatRows 的入参是
// process 变更原因（'append' / 'patch-last' / 'width-settled' …）。
function revealMeasuredChatRow(row) {
  const entry = byRow.get(row);
  if (entry) reveal(entry);
}

export { clear as clearMeasuredChatRows, refresh as refreshMeasuredChatRows, revealMeasuredChatRow };
