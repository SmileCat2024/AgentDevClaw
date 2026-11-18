/**
 * app-chat-input.js — APP 型工作空间首页快记输入框（宿主通用能力）
 *
 * ESM 迁移（P2 W2-3b）：本模块整体转为原生 ESM。装载相位从 classic 加载序
 * 变为「首个 import 它的模块执行时」（deferred），逐条审计见批次交付报告：
 *   - `render` 的唯一调用点是 app-ui `syncAppChatInputSlot`（classic），且只在
 *     「当前有 agent 记录、该 agent 声明的 home block 含 app-chat-input、且
 *     slot 的呈现签名变化」时执行；agent 记录来自认证后的列表加载，必然晚于
 *     deferred 模块执行，因此相位变化等价（不新增等待队列、不复制实现、不新增
 *     跳过分支）。接线缺失时的表现沿用既有消费方写法——app-ui 是
 *     `window.AppChatInput?.render?.(agent, block) || ''`（**既有静默空串**，
 *     本批原样保留，未改成显式失败，也没有加任何兜底渲染）。
 *   - `window.ClawFW.actions.registerMany`（原顶层副作用）随迁到模块求值期；
 *     分发器只在校验交互时按名查表，而快记条的 DOM 由 `render` 生成。
 *   - `submit` 由 voice-input 的自动发送路径经 `window.AppChatInput?.submit?.`
 *     晚绑定调用，协议不变。
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
 *   - 草稿复用会话草稿缓存（owner：p2-w2-3a-composer-state.js），
 *     dataset.sessionKey = "app-chat-input:<agentId>"，不与对话视图的会话草稿
 *     互相污染；重渲染经 render() 内嵌草稿还原；
 *   - in-flight 防重入（is-sending spinner）；失败保留输入供重试；无 slash /
 *     图片 / 引用 / 模型切换 / stop，agent 忙碌时发送由统一网关排队。
 *
 * 依赖形态（一律「当前源码已是 ESM 就 import」，不因测试桩代价或“图太大”退回
 * window；真实 import 图已核对无环，见批次交付报告）：
 *   - import：`getCurrentLanguage`（i18n-environment-state）、`escapeHtml`
 *     （markdown-utils）、`ClawToast`（toast-notify）、`loadAgents`
 *     （agent-snapshot-loader-host）、`sessionInputCache`（p2-w2-3a-composer-state）、
 *     语音跨文件状态与 setter（p2-w2-3a-voice-state）；
 *   - 仍是 classic 唯一实现的函数，只能经 `window.X` 晚绑定调用，**保留原
 *     `typeof` 守卫**（缺失时按原语义跳过，不新增响亮失败也不静默改判）：
 *     `_cacheSessionInput`（input-composer）、`_updateVoiceUI`（voice-input）、
 *     `runWorkspaceAction`（workspace-actions，该域迁移落定后改 import）；
 *     `localizeWorkspaceValue`（app-core）原实现无守卫，保持直调；
 *     `toggleVoiceRecording` / `stopVoiceRecording`（voice-input）原实现即
 *     `window.` 直调，保持无守卫。
 *   以上 classic 函数随语音 / 输入面 / 导航域的联合迁移改 import（见批次报告）。
 *
 * 消费方：
 *   app-ui.js syncAppChatInputSlot（block.type === 'app-chat-input'，挂
 *   #app-chat-input-slot 主内容列底部槽位，不进 surface 内容流）
 *   voice-input.js _dispatchVoiceAutoSend（'app-chat-input-textarea-' 前缀分支）
 */

import { getCurrentLanguage } from './i18n-environment-state.js';
import { escapeHtml } from './markdown-utils.js';
import { ClawToast } from './toast-notify.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { sessionInputCache } from './p2-w2-3a-composer-state.js';
import { autoResize } from './input-actions.js';
import {
  voiceRecording,
  voiceStopping,
  voiceTranscribing,
  voiceTargetId,
  setVoicePendingSend,
  setVoiceTargetBtn,
} from './p2-w2-3a-voice-state.js';
import { localizeWorkspaceValue } from './format-utils.js';

export let AppChatInput = (() => {
  // agentId -> { agentId, agentName, resolveEndpoint, ensureEndpoint }（render 时刷新）
  const configs = {};
  // agentId -> 发送事务进行中（防双击重入）
  const inFlight = {};

  const TEXTAREA_ID_PREFIX = 'app-chat-input-textarea-';
  const MIC_SVG = '<svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>';
  const SEND_SVG = '<svg class="icon-send" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';

  function isZh() {
    return getCurrentLanguage() === 'zh';
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
    const draft = sessionInputCache[draftKey(agentId)] || '';
    const placeholder = escapeHtml(localizeWorkspaceValue(block?.placeholder, ''));
    queuePostMount(agentId);

    return [
      '<section class="app-chat-input-dock" data-agent-id="' + escapeHtml(agentId) + '">',
      '<div class="app-chat-input-capsule">',
      '<textarea id="' + taId + '" class="app-chat-input-textarea" rows="1"',
      ' data-agent-id="' + escapeHtml(agentId) + '"',
      ' data-session-key="' + escapeHtml(draftKey(agentId)) + '"',
      ' placeholder="' + placeholder + '"',
      ' data-action="appChatInput.input" data-event="input keydown">',
      escapeHtml(draft),
      '</textarea>',
      '<div class="app-chat-input-actions">',
      '<button class="voice-input-btn app-chat-voice-btn" type="button" data-target="' + taId + '"',
      ' title="' + (isZh() ? '语音输入' : 'Voice input') + '"',
      ' data-action="appChatInput.voice">',
      MIC_SVG,
      '</button>',
      '<button id="app-chat-input-send-' + escapeHtml(agentId) + '"',
      ' class="persistent-action-btn app-chat-send-btn" type="button"',
      ' data-agent-id="' + escapeHtml(agentId) + '"',
      ' title="' + (isZh() ? '发送' : 'Send') + '"',
      ' data-action="appChatInput.send">',
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
      if (ta.value) autoResize(ta);
      // 录音目标重绑：重渲染替换了按钮节点，录音态类与语音目标按钮需指向
      // 新节点（仅当录音目标本就是本 block 的 textarea，绝不抢 composer 的目标）。
      // 语音目标状态 owner 是 p2-w2-3a-voice-state.js（读写同一活绑定）。
      if (voiceTargetId === ta.id) {
        const btn = document.querySelector('.app-chat-voice-btn[data-target="' + ta.id + '"]');
        if (btn) {
          setVoiceTargetBtn(btn);
          if (voiceRecording || voiceStopping) {
            btn.classList.add('recording');
          }
          // 桥接期：_updateVoiceUI 定义于 voice-input（语音批次收敛时改 import）；
          // 原实现的 typeof 守卫原样保留。
          if (typeof window._updateVoiceUI === 'function') window._updateVoiceUI();
        }
      }
    }, 0);
  }

  // ── 输入事件 ────────────────────────────────────────────────────────────────

  function onInput(ta) {
    // 桥接期：_cacheSessionInput 定义于 input-composer（输入面批次收敛时改
    // import）；原实现的 typeof 守卫原样保留。
    autoResize(ta);
    if (typeof window._cacheSessionInput === 'function') window._cacheSessionInput(ta);
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
    // 桥接期：runWorkspaceAction 定义于 workspace-actions（导航域收敛时改 import）；
    // 原实现的 typeof 守卫原样保留。
    if (typeof window.runWorkspaceAction === 'function') {
      window.runWorkspaceAction({ type: 'start_app_conversation', endpoint: cfg.ensureEndpoint });
    }
  }

  async function submit(agentId) {
    const cfg = configs[agentId];
    if (!cfg || inFlight[agentId]) return;
    // 语音占用期（与对话视图 composer 同款语义，见 persistent-input.js submitQueuedInput）：
    // 转写中不可发送；录音中点发送 = 标记 pending、停止录音，转写完成自动发送
    if (voiceTranscribing) return;
    if (voiceRecording || voiceStopping) {
      setVoicePendingSend(true);
      if (voiceRecording) window.stopVoiceRecording();
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
        autoResize(live);
      }
      delete sessionInputCache[draftKey(agentId)];
      ClawToast.show({
        id: 'app-chat-input-sent-' + agentId,
        status: 'success',
        title: isZh() ? ('已发送给 ' + cfg.agentName) : ('Sent to ' + cfg.agentName),
        action: {
          label: isZh() ? '查看回复' : 'View reply',
          onClick: () => openConversation(agentId),
        },
        autoDismiss: 6000,
      });
      // 自启产生的侧栏叶子（新 runtime / 新会话）尽快出现。
      // loadAgents 是 ESM 导出（agent-snapshot-loader 宿主），直接 import；
      // 失败只吞自己的刷新错误，原语义（不阻断发送成功路径）不变。
      loadAgents().catch(() => {});
    } catch (error) {
      console.error('[app-chat-input] send failed:', error);
      ClawToast.show({
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

  // ── 分发器动作（原模板内联事件收编，命名空间 appChatInput.*）───────────────
  // 分发器（action-dispatcher.js）是 classic script，先于本模块求值装载；注册
  // 相位因此从「classic 加载序」变成模块求值期，而 handler 只在校验交互时按名
  // 查表（DOM 由上面的 render 生成），语义等价。
  window.ClawFW.actions.registerMany({
    // 文本框 input / keydown 双事件共用一个声明（同 choice-input 的 customInput 先例）
    'appChatInput.input': (el, event) => {
      if (event.type === 'keydown') { onKeydown(event, el); return; }
      onInput(el);
    },
    // 语音开录/停录（toggleVoiceRecording 定义域：voice-input.js，window 转调）
    'appChatInput.voice': (el) => window.toggleVoiceRecording(el),
    'appChatInput.send': (el) => onSendClick(el),
  });

  return { render, submit, onInput, onKeydown, onSendClick, openConversation };
})();

// 兼容桥（domain `app-chat-input`，ESM 相注册并立即认领）。消费方形态不变：
// app-ui `window.AppChatInput?.render?.(...)`、voice-input
// `window.AppChatInput?.submit?.(...)`。
//
// 语义基线是迁移前的 `window.AppChatInput = (() => …)()`：window 上的**可写
// 数据属性**，整值替换是既有能力。因此这里是标准的 bridgeApi 形态——`api` 上的
// 同名访问器代理到模块的**可写活绑定** `AppChatInput`：
//   - `window.AppChatInput = 新对象` 经 setter 写回绑定，导出与 window 始终读同一
//     引用（import 侧活绑定同步看到替换结果）；
//   - 模块侧对绑定的赋值同理反映到 `window.AppChatInput`；
//   - claim 的吸收式认领会把哑存储里的现值写回绑定——写回的就是同一个对象，
//     IIFE 不会重跑（不重初始化）；
//   - 未知键按标准形态落 `api`（可读回），不静默吞掉写入。
// 不引入 ready 等待或跳过策略。
const api = {
  get AppChatInput() { return AppChatInput; },
  set AppChatInput(value) { AppChatInput = value; },
};
window.KernelState.defineKey('app-chat-input', 'AppChatInput', AppChatInput);
window.KernelState.claim('app-chat-input', {
  get: (key) => api[key],
  set: (key, value) => { api[key] = value; },
});
