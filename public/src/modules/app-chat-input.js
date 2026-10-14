/**
 * app-chat-input.js — APP 型工作空间首页快记输入框（宿主通用能力）
 *
 * block 契约（APP 在 metadata ui.home.blocks 声明；公共代码不按 APP ID 分支，
 * 未声明的 APP 不受影响——配置不完整时本能力渲染空串，与未知 block 行为一致）：
 *   {
 *     "type": "app-chat-input",
 *     "resolveEndpoint": "GET；返回 { ok, threadId } 或 { ok, activeThread: { threadId } }，无线程时两者皆空",
 *     "ensureEndpoint":  "POST；空态创建对话事务，返回 { ok, threadId }",
 *     "placeholder": { "zh": "…", "en": "…" }
 *   }
 *
 * 发送编排（快记条语义，回复在对话视图查看）：
 *   ① GET resolveEndpoint 解析 APP 活动对话 → 有 threadId 直接 ②；
 *   ② POST /protoclaw/threads/:threadId/input（宿主通用线程寻址入口：head
 *      runtime 不在时自动唤起，交接窗口 Inbox 暂存——直投与暂存同为成功）；
 *   无活动对话时先 POST ensureEndpoint 创建再投递。两个端点都是 APP 自己的
 *   业务状态端点（ADR-0024 决策 1：唯一活动对话是 APP 业务状态，宿主只提供
 *   渲染与投递，不收编 APP 的对话选择逻辑）。
 *
 * 交互细节：
 *   - 发送成功 toast 带「查看回复」动作 → 复用 start_app_conversation 导航链
 *     （endpoint 即 ensureEndpoint，与 hero「打开对话」同源）；
 *   - 语音走 voice-input.js 主链路（voice 按钮 data-target 指向本 block 的
 *     textarea；录音中点发送 = 停止录音、转写完成自动发送，_dispatchVoiceAutoSend
 *     里按 targetId 前缀交回本模块）；
 *   - 草稿复用 _sessionInputCache，dataset.sessionKey = "app-chat-input:<agentId>"，
 *     不与对话视图的会话草稿互相污染；重渲染经 render() 内嵌草稿还原；
 *   - in-flight 防重入（is-sending spinner）；失败保留输入供重试；无 slash /
 *     图片 / 引用 / 模型切换 / stop，agent 忙碌时发送由统一网关排队。
 *
 * 依赖全局（运行时解析，加载顺序见 index.html）：
 *   currentLanguage, escapeHtml, localizeWorkspaceValue (app-core.js)
 *   autoResize (input-helpers.js)
 *   _sessionInputCache (input-composer.js)
 *   toggleVoiceRecording, stopVoiceRecording, _voiceRecording, _voiceStopping,
 *   _voiceTranscribing, _voicePendingSend, _voiceTargetId, _voiceTargetBtn,
 *   _updateVoiceUI (voice-input.js)
 *   ClawToast (toast-notify.js)
 *   loadAgents (app-main.js)
 *   runWorkspaceAction (workspace-actions.js)
 * 消费方：
 *   app-ui.js renderWorkspaceBlock（block.type === 'app-chat-input'）
 *   voice-input.js _dispatchVoiceAutoSend（'app-chat-input-textarea-' 前缀分支）
 */

window.AppChatInput = (() => {
  // agentId -> { agentId, agentName, resolveEndpoint, ensureEndpoint }（render 时刷新）
  const configs = {};
  // agentId -> 发送事务进行中（防双击重入）
  const inFlight = {};

  const TEXTAREA_ID_PREFIX = 'app-chat-input-textarea-';
  const MIC_SVG = '<svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>';
  const SEND_SVG = '<svg class="icon-send" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';

  function isZh() {
    return typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  }

  function textareaId(agentId) {
    return TEXTAREA_ID_PREFIX + agentId;
  }

  function draftKey(agentId) {
    return 'app-chat-input:' + agentId;
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────────

  function render(agent, block) {
    const agentId = String(agent?.id || '').trim();
    const resolveEndpoint = String(block?.resolveEndpoint || '').trim();
    const ensureEndpoint = String(block?.ensureEndpoint || '').trim();
    // 配置不完整 = 能力不可用：渲染空串（可拔插基线，不报错不占位）
    if (!agentId || !resolveEndpoint.startsWith('/') || !ensureEndpoint.startsWith('/')) return '';
    configs[agentId] = {
      agentId,
      agentName: String(agent?.name || agentId),
      resolveEndpoint,
      ensureEndpoint,
    };

    const taId = textareaId(agentId);
    // 草稿经 render 内嵌还原（重渲染重建 textarea 时不丢输入；keystroke 不触发
    // 重渲染，签名式跳过保证常规输入期 DOM 稳定）
    const draft = (typeof _sessionInputCache !== 'undefined' && _sessionInputCache[draftKey(agentId)]) || '';
    const placeholder = escapeHtml(localizeWorkspaceValue(block?.placeholder, ''));
    queuePostMount(agentId);

    return [
      '<section class="app-chat-input-dock" data-agent-id="' + escapeHtml(agentId) + '">',
      '<div class="app-chat-input-capsule">',
      '<textarea id="' + taId + '" class="app-chat-input-textarea" rows="1"',
      ' data-agent-id="' + escapeHtml(agentId) + '"',
      ' data-session-key="' + escapeHtml(draftKey(agentId)) + '"',
      ' placeholder="' + placeholder + '"',
      ' oninput="window.AppChatInput.onInput(this)"',
      ' onkeydown="window.AppChatInput.onKeydown(event, this)">',
      escapeHtml(draft),
      '</textarea>',
      '<div class="app-chat-input-actions">',
      '<button class="voice-input-btn app-chat-voice-btn" type="button" data-target="' + taId + '"',
      ' title="' + (isZh() ? '语音输入' : 'Voice input') + '"',
      ' onclick="toggleVoiceRecording(this)">',
      MIC_SVG,
      '</button>',
      '<button id="app-chat-input-send-' + escapeHtml(agentId) + '"',
      ' class="persistent-action-btn app-chat-send-btn" type="button"',
      ' data-agent-id="' + escapeHtml(agentId) + '"',
      ' title="' + (isZh() ? '发送' : 'Send') + '"',
      ' onclick="window.AppChatInput.onSendClick(this)">',
      SEND_SVG,
      '</button>',
      '</div>',
      '</div>',
      '</section>',
    ].join('');
  }

  /**
   * render() 在 innerHTML 赋值前组串，挂载后的 DOM 修正下一拍执行；
   * 视图已切走时 getElementById 落空，安全 no-op。
   */
  function queuePostMount(agentId) {
    setTimeout(() => {
      const ta = document.getElementById(textareaId(agentId));
      if (!ta) return;
      if (ta.value && typeof autoResize === 'function') autoResize(ta);
      // 录音目标重绑：重渲染替换了按钮节点，录音态类与 _voiceTargetBtn 需指向
      // 新节点（仅当录音目标本就是本 block 的 textarea，绝不抢 composer 的目标）
      if (typeof _voiceTargetId !== 'undefined' && _voiceTargetId === ta.id) {
        const btn = document.querySelector('.app-chat-voice-btn[data-target="' + ta.id + '"]');
        if (btn) {
          _voiceTargetBtn = btn;
          if (typeof _voiceRecording !== 'undefined' && (_voiceRecording || _voiceStopping)) {
            btn.classList.add('recording');
          }
          if (typeof _updateVoiceUI === 'function') _updateVoiceUI();
        }
      }
    }, 0);
  }

  // ── 输入事件 ────────────────────────────────────────────────────────────────

  function onInput(ta) {
    if (typeof autoResize === 'function') autoResize(ta);
    if (typeof _cacheSessionInput === 'function') _cacheSessionInput(ta);
  }

  function onKeydown(event, ta) {
    // Enter 发送；Shift/Ctrl+Enter 换行；IME 组字中的 Enter 不触发（isComposing）
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.isComposing) return;
    event.preventDefault();
    submit(ta.dataset.agentId);
  }

  function onSendClick(btn) {
    submit(btn.dataset.agentId);
  }

  // ── 发送编排 ────────────────────────────────────────────────────────────────

  async function resolveActiveThreadId(cfg) {
    const resp = await fetch(cfg.resolveEndpoint);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.ok) {
      throw new Error(data?.message || data?.code || (cfg.resolveEndpoint + ' HTTP ' + resp.status));
    }
    return String(data?.threadId || data?.activeThread?.threadId || '').trim() || null;
  }

  async function ensureConversation(cfg) {
    const resp = await fetch(cfg.ensureEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.ok || !data?.threadId) {
      throw new Error(data?.message || data?.code || (cfg.ensureEndpoint + ' HTTP ' + resp.status));
    }
    return String(data.threadId);
  }

  async function deliverToThread(threadId, text) {
    const resp = await fetch('/protoclaw/threads/' + encodeURIComponent(threadId) + '/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: 'app-chat-input' }),
    });
    const data = await resp.json().catch(() => null);
    // 直投与 Inbox 暂存（thread_queued）同为成功；唤起失败（503）等显式抛错，
    // 输入保留供重试
    if (!resp.ok || !data?.ok) {
      throw new Error(data?.message || data?.code || ('threads/input HTTP ' + resp.status));
    }
    return data;
  }

  function setSending(agentId, sending) {
    const btn = document.getElementById('app-chat-input-send-' + agentId);
    if (btn) btn.classList.toggle('is-sending', sending);
  }

  function openConversation(agentId) {
    const cfg = configs[agentId];
    if (!cfg) return;
    if (typeof runWorkspaceAction === 'function') {
      runWorkspaceAction({ type: 'start_app_conversation', endpoint: cfg.ensureEndpoint });
    }
  }

  async function submit(agentId) {
    const cfg = configs[agentId];
    if (!cfg || inFlight[agentId]) return;
    // 语音占用期（与对话视图 composer 同款语义，见 input-helpers.js submitInput）：
    // 转写中不可发送；录音中点发送 = 标记 pending、停止录音，转写完成自动发送
    if (typeof _voiceTranscribing !== 'undefined' && _voiceTranscribing) return;
    if (typeof _voiceRecording !== 'undefined' && (_voiceRecording || _voiceStopping)) {
      if (typeof _voicePendingSend !== 'undefined') _voicePendingSend = true;
      if (_voiceRecording) stopVoiceRecording();
      return;
    }
    const ta = document.getElementById(textareaId(agentId));
    if (!ta) return;
    const text = String(ta.value || '').trim();
    if (!text) return;

    inFlight[agentId] = true;
    setSending(agentId, true);
    try {
      let threadId = await resolveActiveThreadId(cfg);
      if (!threadId) threadId = await ensureConversation(cfg);
      await deliverToThread(threadId, text);

      // 成功：清输入与草稿（await 期间视图可能已切走，按 id 重查）
      const live = document.getElementById(textareaId(agentId));
      if (live) {
        live.value = '';
        if (typeof autoResize === 'function') autoResize(live);
      }
      if (typeof _sessionInputCache !== 'undefined') delete _sessionInputCache[draftKey(agentId)];
      window.ClawToast?.show?.({
        id: 'app-chat-input-sent-' + agentId,
        status: 'success',
        title: isZh() ? ('已发送给 ' + cfg.agentName) : ('Sent to ' + cfg.agentName),
        action: {
          label: isZh() ? '查看回复' : 'View reply',
          onClick: () => openConversation(agentId),
        },
        autoDismiss: 6000,
      });
      // 自启产生的侧栏叶子（新 runtime / 新会话）尽快出现
      if (typeof loadAgents === 'function') loadAgents().catch(() => {});
    } catch (error) {
      console.error('[app-chat-input] send failed:', error);
      window.ClawToast?.show?.({
        id: 'app-chat-input-error-' + agentId,
        status: 'error',
        title: isZh() ? '发送失败，输入已保留' : 'Failed to send; input kept',
        description: String(error?.message || error),
        autoDismiss: 6000,
      });
    } finally {
      inFlight[agentId] = false;
      setSending(agentId, false);
    }
  }

  return { render, submit, onInput, onKeydown, onSendClick, openConversation };
})();
