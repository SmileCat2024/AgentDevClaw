/**
 * wg-annotations.js — 批注域
 *
 * 依赖：WgState, wgEsc (wg-core.js), wgFormatTime (wg-core.js), wgApiPut, wgApiDelete (wg-core.js)
 */

'use strict';

function _openAnnotationEditor(msgId) {
  _closeAnnotationEditor();

  const existing = WgState._annotations[msgId];
  const overlay = document.createElement('div');
  overlay.className = 'wg-modal-overlay wg-annotation-overlay';
  overlay.innerHTML = [
    '<div class="wg-modal wg-annotation-modal">',
    '  <div class="wg-modal-title">批注消息</div>',
    `  <textarea class="wg-annotation-textarea" placeholder="输入批注内容…" rows="5">${wgEsc(existing ? existing.text : '')}</textarea>`,
    '  <div class="wg-modal-actions">',
    existing ? '    <button class="wg-modal-btn danger" data-action="delete">删除批注</button>' : '',
    '    <div style="flex:1"></div>',
    '    <button class="wg-modal-btn" data-action="cancel">取消</button>',
    '    <button class="wg-modal-btn confirm" data-action="save">保存</button>',
    '  </div>',
    '</div>',
  ].join('');
  document.body.appendChild(overlay);

  const textarea = overlay.querySelector('.wg-annotation-textarea');
  textarea.focus();
  if (existing) {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { _closeAnnotationEditor(); return; }
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'cancel') {
      _closeAnnotationEditor();
    } else if (action === 'save') {
      const text = textarea.value.trim();
      if (!text) return;
      _saveAnnotation(msgId, text);
      _closeAnnotationEditor();
    } else if (action === 'delete') {
      _deleteAnnotation(msgId);
      _closeAnnotationEditor();
    }
  });

  // Enter 保存，Escape 取消
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      const text = textarea.value.trim();
      if (text) { _saveAnnotation(msgId, text); _closeAnnotationEditor(); }
    }
    if (ev.key === 'Escape') { _closeAnnotationEditor(); }
  });
}

function _closeAnnotationEditor() {
  const el = document.querySelector('.wg-annotation-overlay');
  if (el) el.remove();
}

async function _saveAnnotation(msgId, text) {
  if (!WgState.activeChatId) return;
  try {
    const data = await wgApiPut(
      `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/annotations/${encodeURIComponent(msgId)}`,
      { text }
    );
    if (data.annotation) WgState._annotations[msgId] = data.annotation;
    _renderAnnotationBars();
  } catch (err) {
    console.error('[WorkGroup] saveAnnotation:', err);
  }
}

async function _deleteAnnotation(msgId) {
  if (!WgState.activeChatId) return;
  try {
    await wgApiDelete(
      `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/annotations/${encodeURIComponent(msgId)}`
    );
    delete WgState._annotations[msgId];
    _renderAnnotationBars();
  } catch (err) {
    console.error('[WorkGroup] deleteAnnotation:', err);
  }
}

/** 在消息列表渲染后，给每条有批注的消息插入批注条 */
function _renderAnnotationBars() {
  if (!WgState.activeChatId) return;
  const container = document.querySelector('.wg-msg-list');
  if (!container) return;
  // 清理旧批注条
  container.querySelectorAll('.wg-annotation-bar').forEach((el) => el.remove());
  // 插入新批注条
  Object.entries(WgState._annotations).forEach(([msgId, ann]) => {
    const row = container.querySelector(`.wg-msg-row[data-wg-msg-id="${CSS.escape(msgId)}"]`);
    if (!row) return;
    const body = row.querySelector('.wg-msg-body');
    if (!body) return;
    const time = wgFormatTime(ann.timestamp);
    const bar = document.createElement('div');
    bar.className = 'wg-annotation-bar';
    bar.innerHTML = [
      '<span class="wg-annotation-icon">我：</span>',
      `<span class="wg-annotation-text">${wgEsc(ann.text)}</span>`,
      `<span class="wg-annotation-time">${wgEsc(time)}</span>`,
    ].join('');
    body.appendChild(bar);
  });
}
