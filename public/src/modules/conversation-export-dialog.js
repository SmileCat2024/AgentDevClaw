/**
 * conversation-export-dialog.js — 标题弹窗入口的对话导出
 *
 * 流程（grill 共识定稿）：
 *   标题悬停弹窗标题行「导出」按钮 → 本模态（HTML / Markdown 单选 +
 *   保真度勾选框，默认不勾 = 仅 user/assistant 纯正文）→ 浏览器保存：
 *   Chromium/WebView2 走 showSaveFilePicker 选位置写文件；不支持的
 *   浏览器（Firefox / Safari / Linux WebKitGTK）回退 <a download> 下载。
 *
 * 服务端经 POST /protoclaw/render_conversation 的 returnContent 模式
 * 返回内容字符串（HTML 复用既有渲染器，MD 为镜像渲染），前端负责落盘；
 * IM 渠道用的 export_conversation 工具（temp 全量 HTML）不受影响。
 *
 * 导出全局函数:
 *   - window.openConversationExportDialog({ agentId, sessionId, title })
 */

(function () {
  'use strict';

  let _overlay = null;

  function _t(zh, en) {
    return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh') ? zh : en;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 文件名：会话标题清洗 + 时间戳 + 扩展名 */
  function _buildFilename(title, ext) {
    let base = String(title || '')
      // 控制字符（\x00-\x1f）是 Windows/Linux 文件名非法字符，有意剔除
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/g, '');
    if (base.length > 60) base = base.slice(0, 60);
    if (!base) base = _t('对话', 'conversation');
    let now = new Date();
    let p = function (n) { return String(n).padStart(2, '0'); };
    let stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate())
      + '-' + p(now.getHours()) + p(now.getMinutes());
    return base + '-' + stamp + '.' + ext;
  }

  function _toast(opts) {
    if (typeof ClawToast !== 'undefined' && ClawToast.show) ClawToast.show(opts);
  }

  function _close() {
    if (_overlay) {
      _overlay.remove();
      _overlay = null;
    }
    document.removeEventListener('keydown', _onKeydown);
  }

  function _onKeydown(e) {
    if (e.key === 'Escape') _close();
  }

  async function _renderContent(ctx) {
    const resp = await fetch('/protoclaw/render_conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        title: ctx.title,
        format: ctx.format,
        includeDetails: ctx.includeDetails,
        returnContent: true,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || ('HTTP ' + resp.status));
    }
    return resp.json();
  }

  /**
   * 保存顺序：先弹文件选择器（保住用户激活态，picker 必须紧跟点击手势），
   * 再拉取渲染内容，最后写文件。用户取消（AbortError / NotAllowedError
   * 且无句柄产出）静默返回。
   */
  async function _runExport(ctx) {
    const isMd = ctx.format === 'md';
    const ext = isMd ? 'md' : 'html';
    const mime = isMd ? 'text/markdown' : 'text/html';
    const filename = _buildFilename(ctx.title, ext);

    let handle = null;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: isMd ? 'Markdown' : 'HTML',
            accept: { [mime]: ['.' + ext] },
          }],
        });
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
        throw err;
      }
    }

    const data = await _renderContent(ctx);
    const blob = new Blob([data.content], { type: mime + ';charset=utf-8' });

    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      _toast({
        id: 'conversation-export',
        status: 'success',
        title: _t('已导出', 'Exported'),
        description: filename,
      });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      _toast({
        id: 'conversation-export',
        status: 'success',
        title: _t('已开始下载', 'Download started'),
        description: filename,
      });
    }
  }

  window.openConversationExportDialog = function (opts) {
    const ctx = {
      agentId: String(opts && opts.agentId || '').trim(),
      sessionId: String(opts && opts.sessionId || '').trim(),
      title: String(opts && opts.title || '').trim(),
      format: 'html',
      includeDetails: false,
    };
    if (!ctx.agentId || !ctx.sessionId) return;

    _close();

    const overlay = document.createElement('div');
    overlay.className = 'feature-detail-overlay cex-overlay';
    overlay.innerHTML =
      '<div class="feature-detail-window cex-window" role="dialog" aria-modal="true">'
      + '<div class="cex-header">'
      + '<div class="cex-title">' + _t('导出对话', 'Export Conversation') + '</div>'
      + '<button type="button" class="feature-detail-close" aria-label="' + _t('关闭', 'Close') + '">&times;</button>'
      + '</div>'
      + '<div class="cex-session" title="' + _esc(ctx.title) + '">' + _esc(ctx.title || ctx.sessionId) + '</div>'
      + '<div class="cex-field-label">' + _t('格式', 'Format') + '</div>'
      + '<div class="cex-format">'
      + '<button type="button" class="cex-format-btn active" data-format="html">HTML</button>'
      + '<button type="button" class="cex-format-btn" data-format="md">Markdown</button>'
      + '</div>'
      + '<label class="cex-detail-toggle">'
      + '<input type="checkbox" class="cex-detail-checkbox" />'
      + '<span>' + _t('包含工具调用、系统提醒与思考过程', 'Include tool calls, system reminders & reasoning') + '</span>'
      + '</label>'
      + '<div class="cex-actions">'
      + '<button type="button" class="workspace-action secondary cex-cancel">' + _t('取消', 'Cancel') + '</button>'
      + '<button type="button" class="workspace-action cex-submit">' + _t('导出', 'Export') + '</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(overlay);
    _overlay = overlay;
    document.addEventListener('keydown', _onKeydown);

    const submitBtn = overlay.querySelector('.cex-submit');
    const cancelBtn = overlay.querySelector('.cex-cancel');
    const closeBtn = overlay.querySelector('.feature-detail-close');
    const sessionLabel = overlay.querySelector('.cex-session');

    // 点遮罩关闭（窗口内点击不冒泡到遮罩）
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _close();
    });
    cancelBtn.addEventListener('click', _close);
    closeBtn.addEventListener('click', _close);

    overlay.querySelectorAll('.cex-format-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        overlay.querySelectorAll('.cex-format-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        ctx.format = btn.dataset.format || 'html';
      });
    });

    overlay.querySelector('.cex-detail-checkbox').addEventListener('change', function (e) {
      ctx.includeDetails = e.target.checked;
    });

    submitBtn.addEventListener('click', async function () {
      const original = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = _t('导出中...', 'Exporting...');
      sessionLabel.classList.add('cex-busy');
      try {
        await _runExport(ctx);
        _close();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = original;
        sessionLabel.classList.remove('cex-busy');
        _toast({
          id: 'conversation-export-error',
          status: 'error',
          title: _t('导出失败', 'Export failed'),
          description: String((err && err.message) || err).slice(0, 200),
        });
      }
    });
  };
})();
