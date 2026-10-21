/** User-owned sidebar layout. Business workspace/session identities stay unchanged. */
(() => {
  const folderIds = ['prebuilt-group', 'tool-group'];
  const groupKeys = ['prebuilt', 'tool'];
  const endpoint = '/protoclaw/workspace_settings/sidebar_layout';
  let layout = null;
  let loaded = false;
  let loading = null;
  let saving = false;
  let gesture = null;
  let suppressClickUntil = 0;
  const root = document.getElementById('agent-list');
  const clone = value => JSON.parse(JSON.stringify(value));
  const zh = () => currentLanguage === 'zh';

  function project(groups, saved = layout) {
    const next = saved ? clone(saved) : {
      version: 1,
      order: folderIds.map(id => `folder:${id}`),
      folders: folderIds.map(id => ({ id, apps: [], collapsed: false })),
      externalCollapsed: false,
    };
    const known = new Set(next.order.filter(id => id.startsWith('app:')).map(id => id.slice(4)));
    next.folders.forEach(folder => folder.apps.forEach(id => known.add(id)));
    groupKeys.forEach((key, index) => {
      for (const agent of groups[key] || []) {
        if (known.has(agent.id)) continue;
        next.folders.find(folder => folder.id === folderIds[index]).apps.push(agent.id);
        known.add(agent.id);
      }
    });
    return next;
  }

  function moved(value, source, target) {
    const next = clone(value);
    if (source.startsWith('folder:') && target.folderId) return next;
    if (source === target.before) return next;
    next.order = next.order.filter(id => id !== source);
    if (source.startsWith('app:')) {
      next.folders.forEach(folder => { folder.apps = folder.apps.filter(id => `app:${id}` !== source); });
    }
    const list = target.folderId ? next.folders.find(folder => folder.id === target.folderId)?.apps : next.order;
    if (!list) return clone(value);
    const item = target.folderId ? source.slice(4) : source;
    const anchor = target.folderId && target.before ? target.before.slice(4) : target.before;
    const index = anchor ? list.indexOf(anchor) : -1;
    list.splice(index < 0 ? list.length : index, 0, item);
    return next;
  }

  function announce(message, error = false) {
    let status = document.getElementById('sidebar-layout-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'sidebar-layout-status';
      status.className = 'sidebar-layout-status';
      status.setAttribute('role', 'status');
      document.getElementById('sidebar').appendChild(status);
    }
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  async function load(refresh = false) {
    if (loading || saving || gesture || (loaded && !refresh)) return loading;
    loading = (async () => {
      try {
        const response = await fetch(endpoint);
        const data = await response.json();
        if (!response.ok || data.ok !== true) throw new Error(data.error || 'Layout load failed');
        layout = data.sidebarLayout;
        loaded = true;
        announce('');
        renderAgentList();
      } catch (error) {
        loaded = false;
        announce(zh() ? '左栏布局读取失败；重新聚焦窗口后重试。' : 'Layout could not load. Refocus the window to retry.', true);
        console.warn('[sidebar-layout] load failed', error);
      } finally { loading = null; }
    })();
    return loading;
  }

  async function save(next) {
    if (!loaded || saving) return false;
    const previous = layout;
    layout = next;
    saving = true;
    renderAgentList();
    announce(zh() ? '正在保存左栏布局…' : 'Saving sidebar layout…');
    try {
      const response = await fetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sidebarLayout: next }),
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error(data.error || 'Layout save failed');
      layout = data.sidebarLayout;
      announce('');
      return true;
    } catch (error) {
      layout = previous;
      announce(zh() ? '左栏布局保存失败，已恢复原布局；请再次整理。' : 'Layout could not save. Original layout restored; please try again.', true);
      console.warn('[sidebar-layout] save failed', error);
      return false;
    } finally {
      saving = false;
      renderAgentList();
    }
  }

  function render(groups) {
    const focusId = document.activeElement?.dataset?.layoutHandle;
    const next = project(groups);
    const agents = new Map(groupKeys.flatMap(key => groups[key] || []).map(agent => [agent.id, agent]));
    root.querySelectorAll(':scope > .sidebar-root-app').forEach(el => el.remove());
    const labels = zh() ? ['系统空间', '工具与效率'] : ['System spaces', 'Tools & productivity'];
    for (const folder of next.folders) {
      const el = document.getElementById(folder.id);
      const header = el.querySelector('.agent-group-header');
      const items = el.querySelector('.agent-group-items');
      const entries = folder.apps.map(id => agents.get(id)).filter(Boolean);
      renderAgentGroup(items, el, el.querySelector('.agent-group-count'), entries, { prebuilt: true });
      // Empty folders remain available as destinations after their last app moves out.
      el.style.display = '';
      el.dataset.layoutId = `folder:${folder.id}`;
      header.dataset.layoutHandle = `folder:${folder.id}`;
      header.setAttribute('role', 'button');
      header.setAttribute('tabindex', '0');
      header.setAttribute('aria-expanded', String(!folder.collapsed));
      header.title = zh() ? '长按拖动排序；键盘空格整理、方向键选择位置、回车确认' : 'Hold to reorder; Space to arrange, arrows to choose, Enter to confirm';
      header.querySelector('.agent-group-header-label > span:last-child').textContent = labels[folderIds.indexOf(folder.id)];
      el.classList.toggle('collapsed', folder.collapsed);
      decorate(items);
    }
    for (const id of next.order) {
      if (id.startsWith('folder:')) root.appendChild(document.getElementById(id.slice(7)));
      else {
        const agent = agents.get(id.slice(4));
        if (!agent) continue;
        const el = document.createElement('div');
        el.className = 'sidebar-root-app';
        el.dataset.layoutId = id;
        el.innerHTML = renderAgentItems([agent], { prebuilt: true });
        decorate(el);
        root.appendChild(el);
      }
    }
    root.appendChild(document.getElementById('external-group'));
    document.getElementById('external-group').classList.toggle('collapsed', next.externalCollapsed);
    if (focusId) [...root.querySelectorAll('[data-layout-handle]')].find(el => el.dataset.layoutHandle === focusId)?.focus({ preventScroll: true });
  }

  function decorate(container) {
    container.querySelectorAll('[data-agent-prebuilt="true"]').forEach(el => {
      el.dataset.layoutHandle = `app:${el.dataset.agentId}`;
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.title = zh() ? '点击打开；长按拖动整理，或按空格整理' : 'Click to open; hold or press Space to arrange';
      el.parentElement.dataset.layoutId = el.dataset.layoutHandle;
    });
  }

  function current() { return project(groupConnectedAgents(allAgents)); }
  function handleFrom(target) { return target.closest('[data-layout-handle]'); }
  function clearMarks() {
    root.querySelectorAll('.layout-drop-before, .layout-drop-after, .layout-drop-inside').forEach(el => {
      el.classList.remove('layout-drop-before', 'layout-drop-after', 'layout-drop-inside');
    });
    if (gesture) { gesture.target = null; gesture.mark = null; }
  }

  function mark(target, el, kind) {
    if (kind === 'inside') el = document.getElementById(target.folderId);
    if (gesture.mark?.el === el && gesture.mark.kind === kind
      && gesture.target?.folderId === target.folderId && gesture.target?.before === target.before) return;
    clearMarks();
    gesture.target = target;
    gesture.mark = { el, kind };
    el?.classList.add(`layout-drop-${kind}`);
  }

  // Resolve against layout rectangles, including gaps, rather than hit DOM descendants.
  function locate(x, y) {
    if (!gesture?.active) return;
    const bounds = root.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
      clearMarks(); return;
    }
    const nodes = [...root.children].filter(node => node.dataset.layoutId && node.style.display !== 'none');
    const node = nodes.find(item => { const rect = item.getBoundingClientRect(); return y >= rect.top && y <= rect.bottom; });
    if (node?.dataset.layoutId === gesture.source
      || (gesture.source.startsWith('app:') && [...(node?.querySelectorAll('.agent-group-items > [data-layout-id]') || [])]
        .some(item => item.dataset.layoutId === gesture.source && y >= item.getBoundingClientRect().top && y <= item.getBoundingClientRect().bottom))) {
      clearMarks(); return;
    }
    if (gesture.source.startsWith('app:') && node?.classList.contains('agent-group') && x > bounds.left + 28) {
      const header = node.querySelector('.agent-group-header');
      if (y <= header.getBoundingClientRect().bottom || node.classList.contains('collapsed')) {
        mark({ folderId: node.id, before: null }, header, 'inside'); return;
      }
      const entries = [...node.querySelector('.agent-group-items').children].filter(item => item.dataset.layoutId);
      const before = entries.find(item => { const rect = item.getBoundingClientRect(); return y < rect.top + rect.height / 2; });
      if (before) mark({ folderId: node.id, before: before.dataset.layoutId }, before, 'before');
      else if (entries.length) mark({ folderId: node.id, before: null }, entries[entries.length - 1], 'after');
      else mark({ folderId: node.id, before: null }, header, 'inside');
      return;
    }
    const before = nodes.find(item => { const rect = item.getBoundingClientRect(); return y < rect.top + rect.height / 2; });
    const external = document.getElementById('external-group');
    const end = external.style.display !== 'none' ? external : nodes[nodes.length - 1];
    mark({ before: before?.dataset.layoutId || null }, before || end, before || end === external ? 'before' : 'after');
  }

  function begin(handle, pointerId = null) {
    if (!loaded || saving || loading) return false;
    gesture = { source: handle.dataset.layoutHandle, handle, pointerId, active: true, target: null, timer: 0 };
    root.classList.add('layout-arranging');
    handle.classList.add('layout-picked');
    handle.setAttribute('aria-pressed', 'true');
    if (pointerId !== null) root.setPointerCapture(pointerId);
    announce('');
    return true;
  }

  function finish(commit) {
    if (!gesture) return;
    const old = gesture;
    clearTimeout(old.timer);
    gesture = null;
    clearMarks();
    root.classList.remove('layout-arranging');
    old.handle.classList.remove('layout-picked');
    old.handle.removeAttribute('aria-pressed');
    if (old.pointerId !== null && root.hasPointerCapture(old.pointerId)) root.releasePointerCapture(old.pointerId);
    if (old.active) suppressClickUntil = Date.now() + 400;
    announce('');
    if (commit && old.active && old.target) {
      const value = current();
      const next = moved(value, old.source, old.target);
      if (JSON.stringify(value) !== JSON.stringify(next)) void save(next);
      else renderAgentList();
    } else renderAgentList();
  }

  root.addEventListener('pointerdown', event => {
    suppressClickUntil = 0;
    if (event.button !== 0 || event.isPrimary === false || gesture) return;
    const handle = handleFrom(event.target);
    if (!handle || event.target.closest('button, input, a') || !loaded || saving || loading) return;
    const press = { handle, source: handle.dataset.layoutHandle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    gesture = press;
    press.timer = setTimeout(() => {
      if (gesture !== press) return;
      gesture = null;
      begin(handle, event.pointerId);
    }, 350);
  });
  document.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) finish(false);
      return;
    }
    event.preventDefault();
    const bounds = root.getBoundingClientRect();
    if (event.clientY < bounds.top + 32) root.scrollTop -= 12;
    if (event.clientY > bounds.bottom - 32) root.scrollTop += 12;
    locate(event.clientX, event.clientY);
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    if (gesture?.pointerId === event.pointerId) finish(true);
  });
  document.addEventListener('pointercancel', () => finish(false));
  root.addEventListener('lostpointercapture', () => finish(false));
  root.addEventListener('contextmenu', event => {
    if (gesture?.active) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  root.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  root.addEventListener('touchmove', event => {
    if (gesture?.active) event.preventDefault();
  }, { passive: false });
  root.addEventListener('dragstart', event => {
    if (handleFrom(event.target)) event.preventDefault();
  });

  function keyboardTargets(source) {
    const result = [];
    for (const node of [...root.children].filter(el => el.dataset.layoutId && el.style.display !== 'none')) {
      const id = node.dataset.layoutId;
      if (id !== source) result.push({ target: { before: id }, el: node, kind: 'before' });
      if (source.startsWith('app:') && id.startsWith('folder:')) {
        const folderId = id.slice(7);
        for (const child of node.querySelectorAll('.agent-group-items > [data-layout-id]')) {
          if (child.dataset.layoutId !== source) result.push({ target: { folderId, before: child.dataset.layoutId }, el: child, kind: 'before' });
        }
        result.push({ target: { folderId, before: null }, el: node.querySelector('.agent-group-header'), kind: 'inside' });
      }
    }
    result.push({ target: { before: null }, el: document.getElementById('external-group'), kind: 'before' });
    return result;
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(false); }
  });
  root.addEventListener('keydown', event => {
    const handle = handleFrom(event.target);
    if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(false); return; }
    if (!handle) return;
    if (!gesture && event.key === ' ') {
      event.preventDefault();
      if (begin(handle)) gesture.keyboardIndex = -1;
    } else if (gesture?.active && gesture.pointerId === null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const targets = keyboardTargets(gesture.source);
        gesture.keyboardIndex = (gesture.keyboardIndex + (event.key === 'ArrowDown' ? 1 : -1) + targets.length) % targets.length;
        const choice = targets[gesture.keyboardIndex];
        mark(choice.target, choice.el, choice.kind);
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); finish(true); }
    } else if (event.key === 'Enter') { event.preventDefault(); handle.click(); }
  });
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('focus', () => { void load(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finish(false);
    else void load(true);
  });

  window.ClawSidebarLayout = {
    project, moved, load, render,
    signature: () => JSON.stringify({ layout, loaded, saving }),
    isInteracting: () => !!gesture,
    toggle(folderId) {
      if (!loaded || saving || loading) return;
      const next = current();
      if (folderId === 'external-group') next.externalCollapsed = !next.externalCollapsed;
      else {
        const folder = next.folders.find(item => item.id === folderId);
        if (!folder) return;
        folder.collapsed = !folder.collapsed;
      }
      void save(next);
    },
  };
})();
