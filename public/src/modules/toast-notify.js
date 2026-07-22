/**
 * ClawToast — Global async task notification system.
 *
 * Provides floating status cards in the top-right of the main content area
 * for long-running async operations (title generation, summary generation, etc).
 *
 * Usage:
 *   ClawToast.show({ id: 'title-gen', title: 'Generating title...', status: 'loading' });
 *   ClawToast.update('title-gen', { status: 'success', title: 'Title generated' });
 *   ClawToast.update('title-gen', { status: 'error', description: 'API timeout' });
 *   ClawToast.dismiss('title-gen');
 *
 * Status: 'loading' (blue) | 'success' (green) | 'error' (red) | 'warning' (amber)
 */
(function () {
  'use strict';

  let container = null;
  let toasts = {}; // id -> { el, timer, status, title, description, createdAt }
  let modalEl = null;

  // ── SVG icons ──

  let ICON_SPINNER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
    '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';

  let ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="20 6 9 17 4 12"></polyline></svg>';

  let ICON_ERROR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="10"></circle>' +
    '<line x1="12" y1="8" x2="12" y2="12"></line>' +
    '<line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

  let ICON_WARNING =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
    '<line x1="12" y1="9" x2="12" y2="13"></line>' +
    '<line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';

  let ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<line x1="18" y1="6" x2="6" y2="18"></line>' +
    '<line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  let ICON_CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="9 18 15 12 9 6"></polyline></svg>';

  // ── i18n ──

  function isZh() {
    return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  }

  function lbl(key) {
    let zh = {
      detail: '详情',
      status: '状态',
      time: '时间',
      message: '信息',
      noDesc: '无附加信息',
      loading: '进行中',
      success: '已完成',
      error: '失败',
      warning: '警告',
    };
    let en = {
      detail: 'Details',
      status: 'Status',
      time: 'Time',
      message: 'Message',
      noDesc: 'No additional information',
      loading: 'In Progress',
      success: 'Completed',
      error: 'Failed',
      warning: 'Warning',
    };
    return (isZh() ? zh : en)[key] || key;
  }

  function statusLabel(status) {
    if (status === 'success') return lbl('success');
    if (status === 'error') return lbl('error');
    if (status === 'warning') return lbl('warning');
    return lbl('loading');
  }

  // ── Icon selection ──

  function iconForStatus(status) {
    if (status === 'success') return ICON_CHECK;
    if (status === 'error') return ICON_ERROR;
    if (status === 'warning') return ICON_WARNING;
    return ICON_SPINNER;
  }

  // ── Container management ──

  function ensureContainer() {
    if (container && container.parentNode) return container;
    container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      let main = document.querySelector('.main-content');
      if (main) {
        main.appendChild(container);
      } else {
        document.body.appendChild(container);
      }
    }
    return container;
  }

  // ── Build toast element ──

  function buildToastElement(opts) {
    let el = document.createElement('div');
    el.className = 'toast-card';
    el.setAttribute('data-status', opts.status || 'loading');

    let icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.innerHTML = iconForStatus(opts.status);

    let content = document.createElement('div');
    content.className = 'toast-content';

    let title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = opts.title || '';

    content.appendChild(title);

    if (opts.description) {
      let desc = document.createElement('div');
      desc.className = 'toast-desc';
      desc.textContent = opts.description;
      content.appendChild(desc);

      let detailBtn = document.createElement('button');
      detailBtn.className = 'toast-detail-btn';
      detailBtn.type = 'button';
      detailBtn.innerHTML = lbl('detail') + ICON_CHEVRON;
      content.appendChild(detailBtn);
    }

    let closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.title = 'Close';

    let progress = document.createElement('div');
    progress.className = 'toast-progress';

    el.appendChild(icon);
    el.appendChild(content);
    el.appendChild(closeBtn);
    el.appendChild(progress);

    return el;
  }

  // ── Update toast DOM ──

  function updateToastDom(id, el, opts) {
    let content = el.querySelector('.toast-content');

    if (opts.status) {
      el.setAttribute('data-status', opts.status);
      let icon = el.querySelector('.toast-icon');
      if (icon) icon.innerHTML = iconForStatus(opts.status);
    }
    if (opts.title !== undefined) {
      let titleEl = el.querySelector('.toast-title');
      if (titleEl) titleEl.textContent = opts.title;
    }
    if (opts.description !== undefined) {
      let descEl = content.querySelector('.toast-desc');
      let detailBtn = content.querySelector('.toast-detail-btn');
      if (opts.description) {
        if (!descEl) {
          descEl = document.createElement('div');
          descEl.className = 'toast-desc';
          // Insert before detail button if it exists, otherwise append
          if (detailBtn) {
            content.insertBefore(descEl, detailBtn);
          } else {
            content.appendChild(descEl);
          }
        }
        descEl.textContent = opts.description;
        // Ensure detail button exists
        if (!detailBtn) {
          detailBtn = document.createElement('button');
          detailBtn.className = 'toast-detail-btn';
          detailBtn.type = 'button';
          detailBtn.innerHTML = lbl('detail') + ICON_CHEVRON;
          detailBtn.addEventListener('click', function () {
            openDetailModal(id);
          });
          content.appendChild(detailBtn);
        }
      } else {
        if (descEl) descEl.remove();
        if (detailBtn) detailBtn.remove();
      }
    }
  }

  // ── Detail modal ──

  function formatTime(ts) {
    if (!ts) return '-';
    let d = new Date(ts);
    let pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function openDetailModal(id) {
    let entry = toasts[id];
    if (!entry) return;

    closeDetailModal();

    modalEl = document.createElement('div');
    modalEl.className = 'toast-modal';

    let overlay = document.createElement('div');
    overlay.className = 'toast-modal-overlay';

    let panel = document.createElement('div');
    panel.className = 'toast-modal-panel';

    // Header
    let header = document.createElement('div');
    header.className = 'toast-modal-header';

    let titleRow = document.createElement('div');
    titleRow.className = 'toast-modal-title-row';

    let iconDiv = document.createElement('div');
    iconDiv.className = 'toast-modal-icon';
    iconDiv.innerHTML = iconForStatus(entry.status);
    // Color the icon
    let svgEl = iconDiv.querySelector('svg');
    if (svgEl) {
      if (entry.status === 'success') svgEl.style.color = '#22c55e';
      else if (entry.status === 'error') svgEl.style.color = '#ef4444';
      else if (entry.status === 'warning') svgEl.style.color = '#f59e0b';
      else svgEl.style.color = '#3b82f6';
    }

    let titleEl = document.createElement('div');
    titleEl.className = 'toast-modal-title';
    titleEl.textContent = entry.title || '';

    titleRow.appendChild(iconDiv);
    titleRow.appendChild(titleEl);

    let closeBtn = document.createElement('button');
    closeBtn.className = 'toast-modal-close';
    closeBtn.type = 'button';
    closeBtn.innerHTML = ICON_CLOSE;

    header.appendChild(titleRow);
    header.appendChild(closeBtn);

    // Body
    let body = document.createElement('div');
    body.className = 'toast-modal-body';

    // Status field
    let statusField = document.createElement('div');
    statusField.className = 'toast-modal-field';
    let statusLabel_ = document.createElement('div');
    statusLabel_.className = 'toast-modal-field-label';
    statusLabel_.textContent = lbl('status');
    let statusBadge = document.createElement('div');
    statusBadge.className = 'toast-modal-status-badge';
    statusBadge.setAttribute('data-status', entry.status);
    statusBadge.textContent = statusLabel(entry.status);
    statusField.appendChild(statusLabel_);
    statusField.appendChild(statusBadge);
    body.appendChild(statusField);

    // Time field
    let timeField = document.createElement('div');
    timeField.className = 'toast-modal-field';
    let timeLabel = document.createElement('div');
    timeLabel.className = 'toast-modal-field-label';
    timeLabel.textContent = lbl('time');
    let timeValue = document.createElement('div');
    timeValue.className = 'toast-modal-field-value';
    timeValue.textContent = formatTime(entry.createdAt);
    timeField.appendChild(timeLabel);
    timeField.appendChild(timeValue);
    body.appendChild(timeField);

    // Message field
    let msgField = document.createElement('div');
    msgField.className = 'toast-modal-field';
    let msgLabel = document.createElement('div');
    msgLabel.className = 'toast-modal-field-label';
    msgLabel.textContent = lbl('message');
    let msgValue = document.createElement('div');
    msgValue.className = 'toast-modal-field-value';
    msgValue.textContent = entry.description || lbl('noDesc');
    msgField.appendChild(msgLabel);
    msgField.appendChild(msgValue);
    body.appendChild(msgField);

    panel.appendChild(header);
    panel.appendChild(body);

    modalEl.appendChild(overlay);
    modalEl.appendChild(panel);
    document.body.appendChild(modalEl);

    // Events
    overlay.addEventListener('click', closeDetailModal);
    closeBtn.addEventListener('click', closeDetailModal);
    document.addEventListener('keydown', onModalEsc);
  }

  function onModalEsc(e) {
    if (e.key === 'Escape') closeDetailModal();
  }

  function closeDetailModal() {
    document.removeEventListener('keydown', onModalEsc);
    if (modalEl && modalEl.parentNode) {
      modalEl.parentNode.removeChild(modalEl);
    }
    modalEl = null;
  }

  // ── Auto-dismiss timer ──

  function clearTimers(id) {
    let entry = toasts[id];
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function scheduleAutoDismiss(id, delay) {
    let entry = toasts[id];
    if (!entry) return;
    clearTimers(id);
    entry.timer = setTimeout(function () {
      dismiss(id);
    }, delay);
  }

  // ── Public API ──

  /**
   * Show a new toast or replace an existing one with the same id.
   * @param {Object} opts
   * @param {string} opts.id - Unique identifier for this toast.
   * @param {string} opts.title - Title text.
   * @param {string} [opts.status] - 'loading' | 'success' | 'error'. Default: 'loading'.
   * @param {string} [opts.description] - Optional description text.
   * @param {number} [opts.autoDismiss] - Auto-dismiss after N ms (success only by default).
   * @param {boolean} [opts.closable] - Show close button. Default: true.
   */
  function show(opts) {
    if (!opts || !opts.id) return;
    let id = opts.id;

    // If already exists, update it
    if (toasts[id]) {
      update(id, opts);
      return;
    }

    let c = ensureContainer();
    let el = buildToastElement(opts);

    // Close button
    let closeBtn = el.querySelector('.toast-close');
    if (opts.closable === false) {
      closeBtn.style.display = 'none';
    } else {
      closeBtn.addEventListener('click', function () {
        dismiss(id);
      });
    }

    // Detail button
    let detailBtn = el.querySelector('.toast-detail-btn');
    if (detailBtn) {
      detailBtn.addEventListener('click', function () {
        openDetailModal(id);
      });
    }

    c.appendChild(el);
    toasts[id] = {
      el: el,
      timer: null,
      status: opts.status || 'loading',
      title: opts.title || '',
      description: opts.description || '',
      createdAt: Date.now(),
    };

    // Auto-dismiss for success and warning
    let status = opts.status || 'loading';
    if ((status === 'success' || status === 'warning') && opts.autoDismiss !== 0) {
      scheduleAutoDismiss(id, opts.autoDismiss || (status === 'warning' ? 8000 : 3500));
    }
  }

  /**
   * Update an existing toast.
   * @param {string} id - Toast id.
   * @param {Object} changes - Fields to update: status, title, description, autoDismiss.
   */
  function update(id, changes) {
    let entry = toasts[id];
    if (!entry) {
      // If toast doesn't exist, create it
      if (changes) show(Object.assign({ id: id }, changes));
      return;
    }

    clearTimers(id);
    updateToastDom(id, entry.el, changes);

    // Sync stored data
    if (changes.status) entry.status = changes.status;
    if (changes.title !== undefined) entry.title = changes.title;
    if (changes.description !== undefined) entry.description = changes.description;

    // Auto-dismiss when transitioning to success or warning
    if ((changes.status === 'success' || changes.status === 'warning') && changes.autoDismiss !== 0) {
      scheduleAutoDismiss(id, changes.autoDismiss || (changes.status === 'warning' ? 8000 : 3500));
    }
  }

  /**
   * Dismiss a toast by id.
   * @param {string} id - Toast id.
   */
  function dismiss(id) {
    let entry = toasts[id];
    if (!entry) return;

    clearTimers(id);

    let el = entry.el;
    el.classList.add('toast-leaving');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      delete toasts[id];
    }, 250);
  }

  /**
   * Dismiss all toasts.
   */
  function dismissAll() {
    Object.keys(toasts).forEach(function (id) {
      dismiss(id);
    });
  }

  window.ClawToast = {
    show: show,
    update: update,
    dismiss: dismiss,
    dismissAll: dismissAll,
  };
})();
