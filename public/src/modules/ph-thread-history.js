/**
 * PH 对话历史存档面板（ticket 050，ADR-0032 决策 3）
 *
 * 用户语言模型：本对话每次精简 / 摘要发生之前，原样存了一份完整记录。
 * 面板按时间倒序呈现这些存档（时间锚 + 触发方式 + 规模），不暴露内部
 * 代次概念。数据来自 GET /protoclaw/threads/:threadId 的 sessionChainMeta
 * （服务端合并链事实与会话索引元数据）。
 *
 * 入口：会话行「历史 · N」徽标（renderSessionThreadBadge）。
 * 动作：
 *   - 查看原文：只读挂载既有路径（view_session_record action，ADR-0026
 *     持久化会话读取适配器），面板关闭。
 *   - 从这段继续：在该代末尾创建分支（sessions/branch，整代保留），分支
 *     是新对话（threadHost 下自动建新线），面板关闭。
 *
 * 弹窗容器复用 feature-detail-overlay / feature-detail-window（Feature
 * 详情弹窗同款配方，不自造同类控件）。
 */

(function () {
  let _openOverlay = null;

  function _closePanel() {
    if (_openOverlay && _openOverlay.parentNode) {
      _openOverlay.parentNode.removeChild(_openOverlay);
    }
    _openOverlay = null;
  }

  function _endKindLabel(endKind, isZh) {
    if (endKind === 'trim') return isZh ? '精简前' : 'Before trim';
    if (endKind === 'summary') return isZh ? '摘要前' : 'Before summary';
    return isZh ? '接续前' : 'Before handoff';
  }

  function _endKindDetail(endKind, isZh) {
    if (endKind === 'trim') return isZh ? '上下文裁剪' : 'Context trim';
    if (endKind === 'summary') return isZh ? '上下文摘要' : 'Context summary';
    return isZh ? '上下文接续' : 'Context handoff';
  }

  function _formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const isZh = currentLanguage === 'zh';
    const pad = (n) => String(n).padStart(2, '0');
    const date = isZh
      ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function _archiveCardHtml(entry, isZh) {
    const title = entry.title || entry.sessionId;
    const time = _formatTime(entry.endedAt || entry.updatedAt);
    const count = Number.isFinite(entry.messageCount) && entry.messageCount !== null
      ? ((isZh ? ' · ' : ' · ') + entry.messageCount + (isZh ? ' 条消息' : ' messages'))
      : '';
    const viewAction = escapeHtml(JSON.stringify({
      type: 'view_session_record',
      agentId: window.__phThreadHistoryAgentId,
      sessionId: entry.sessionId,
    }));
    return [
      '<div class="ph-history-card" data-history-session="' + escapeHtml(entry.sessionId) + '">',
      '<div class="ph-history-card-main">',
      '<div class="ph-history-card-title">' + escapeHtml(title) + '</div>',
      '<div class="ph-history-card-meta">',
      escapeHtml(_endKindLabel(entry.endKind, isZh) + (time ? ' · ' + time : '') + count),
      '<span class="ph-history-card-kind">' + escapeHtml(_endKindDetail(entry.endKind, isZh)) + '</span>',
      '</div>',
      '</div>',
      '<div class="ph-history-card-actions">',
      '<button class="workspace-action" type="button" data-workspace-action="' + viewAction + '" onclick="window.PhThreadHistory.viewOriginal(this.dataset.workspaceAction)">' + (isZh ? '查看原文' : 'View') + '</button>',
      '<button class="workspace-action secondary" type="button" onclick="window.PhThreadHistory.continueFrom(\'' + escapeHtml(entry.sessionId) + '\', this)">' + (isZh ? '从这段继续' : 'Continue from here') + '</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  function _panelHtml(agentId, threadId, meta, isZh) {
    const cards = meta
      .filter((entry) => entry.sessionId !== threadId && entry.role !== 'head')
      .map((entry) => _archiveCardHtml(entry, isZh))
      .join('');
    return [
      '<form class="feature-detail-window ph-history-window" role="dialog" aria-modal="true" onsubmit="return false">',
      '<div class="feature-detail-header">',
      '<div class="feature-detail-title">' + (isZh ? '历史记录' : 'History') + '</div>',
      '<button type="button" class="feature-detail-close" onclick="window.PhThreadHistory.close()" aria-label="' + (isZh ? '关闭' : 'Close') + '">&times;</button>',
      '</div>',
      '<div class="ph-history-desc">' + (isZh
        ? '每次精简或摘要发生前，这段对话当时的完整记录都会原样存档。'
        : 'Before each trim or summary, the conversation is archived exactly as it was.') + '</div>',
      '<div class="ph-history-list">' + (cards || '<div class="ph-history-empty">' + (isZh ? '暂无存档' : 'No archives yet') + '</div>') + '</div>',
      '</form>',
    ].join('');
  }

  window.phOpenThreadHistory = async function (agentId, threadId) {
    _closePanel();
    const isZh = currentLanguage === 'zh';
    let data = null;
    try {
      const res = await fetch('/protoclaw/threads/' + encodeURIComponent(threadId));
      if (!res.ok) throw new Error('thread detail request failed: ' + res.status);
      data = await res.json();
    } catch (error) {
      ClawToast.show({ title: (isZh ? '历史加载失败：' : 'Failed to load history: ') + (error?.message || error), status: 'error' });
      return;
    }
    const meta = Array.isArray(data?.sessionChainMeta) ? data.sessionChainMeta : [];
    if (meta.length === 0) {
      ClawToast.show({ title: isZh ? '该对话暂无历史存档' : 'No archives for this conversation', status: 'info' });
      return;
    }
    window.__phThreadHistoryAgentId = agentId;
    window.__phThreadHistoryThreadId = threadId;
    const host = document.getElementById('ph-thread-history-host') || (() => {
      const el = document.createElement('div');
      el.id = 'ph-thread-history-host';
      document.body.appendChild(el);
      return el;
    })();
    const overlay = document.createElement('div');
    overlay.className = 'feature-detail-overlay';
    overlay.innerHTML = _panelHtml(agentId, threadId, meta, isZh);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) window.PhThreadHistory.close();
    });
    host.appendChild(overlay);
    _openOverlay = overlay;
  };

  window.PhThreadHistory = {
    close: _closePanel,

    viewOriginal(actionJson) {
      _closePanel();
      if (typeof window.runWorkspaceAction === 'function') {
        window.runWorkspaceAction(actionJson);
      }
    },

    /** 在该存档末尾创建分支（新对话）：整代保留（cut 到最后一条消息），
     * threadHost 下分支自动建新线；分支会话异步启动，经 open_session
     * 既有等待路径打开。 */
    async continueFrom(sourceSessionId, btn) {
      const isZh = currentLanguage === 'zh';
      const agentId = window.__phThreadHistoryAgentId || '';
      if (!agentId || !sourceSessionId) return;
      if (btn) btn.disabled = true;
      try {
        const recordRes = await fetch('/protoclaw/session_record?agentId=' + encodeURIComponent(agentId)
          + '&sessionId=' + encodeURIComponent(sourceSessionId));
        if (!recordRes.ok) throw new Error('record request failed: ' + recordRes.status);
        const record = await recordRes.json();
        const messageCount = Array.isArray(record?.messages) ? record.messages.length : 0;
        if (messageCount === 0) throw new Error(isZh ? '该存档没有可保留的消息' : 'Archive has no messages');
        const branchRes = await fetch('/protoclaw/sessions/branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            sourceSessionId,
            cutMsgIndexEnd: messageCount - 1,
          }),
        });
        if (!branchRes.ok) {
          const text = await branchRes.text().catch(() => '');
          throw new Error(text || ('branch request failed: ' + branchRes.status));
        }
        const branch = await branchRes.json();
        _closePanel();
        ClawToast.show({
          title: isZh ? '已从历史存档创建新对话' : 'New conversation created from archive',
          status: 'success',
          autoDismiss: 3000,
        });
        if (typeof window.runWorkspaceAction === 'function' && branch?.newSessionId) {
          window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: branch.newSessionId }));
        }
      } catch (error) {
        if (btn) btn.disabled = false;
        ClawToast.show({ title: (isZh ? '创建分支失败：' : 'Branch failed: ') + (error?.message || error), status: 'error' });
      }
    },
  };
})();
