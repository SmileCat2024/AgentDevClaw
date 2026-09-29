// Long process views retain their DOM, but only nearby rows participate in
// painting and accessibility updates. Measure real heights before hiding rows;
// estimates would move the scrollbar and the user's reading position.
(() => {
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
    if (!entries.length || !showChatProcess || !_windowingDisabled || _windowingFrozen) return;
    const top = container.scrollTop, height = container.clientHeight;
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
    runWithSuppressedChatViewportObservers(() => {
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
    if (!supported || !showChatProcess || !_windowingDisabled) { clear(); return; }
    if (_windowingFrozen) return;
    const rows = Array.from(container.querySelectorAll('.message-row'));
    if (rows.length < 200) { clear(); return; }
    const nextWidth = container.clientWidth;
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
    if (resized && !followLatestEnabled) anchor = captureChatViewportAnchor();
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
    if (anchor) applyChatViewportAnchor(anchor);
    // Rows exposed by a patch must rejoin the correct window even if its
    // boundaries did not move.
    first = 0; last = -1;
    apply(true);
  }

  window.clearMeasuredChatRows = clear;
  window.refreshMeasuredChatRows = refresh;
  window.revealMeasuredChatRow = row => {
    const entry = byRow.get(row);
    if (entry) reveal(entry);
  };
  container.addEventListener('scroll', () => {
    if (entries.length && !raf) raf = requestAnimationFrame(() => apply());
  }, {passive:true});
  container.addEventListener('load', event => {
    if (event.target?.tagName !== 'IMG') return;
    const entry = byRow.get(event.target.closest('.message-row'));
    if (!entry) return;
    reveal(entry); refresh('image-load');
  }, true);
})();
