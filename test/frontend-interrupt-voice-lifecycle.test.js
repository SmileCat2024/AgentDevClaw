/**
 * frontend-interrupt-voice-lifecycle.test.js — 常驻输入面的中断 / 语音门控优先级
 * 与语音渲染生命周期。
 *
 * 装载路线（P4 输入面批次）：persistent-input 已迁 ESM——
 *   - 行为用例不再切源码片段，改为 `withP2EsmCase` + 真实 `c.load`，classic 相装
 *     生产宿主链（prepareClassicSandbox）；点击路径的终态经真实网络面（fetch 桩）
 *     观察「中断 POST」与「user-turn POST」两种结果；
 *   - 语音判定用例继续真实 import voice-input / voice-state。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
import { createDomHarness } from './helpers/dom-harness.js';

const VOICE_INPUT = 'public/src/modules/voice-input.js';
const VOICE_STATE = 'public/src/modules/p2-w2-3a-voice-state.js';
const PERSISTENT_INPUT = 'public/src/modules/persistent-input.js';

// classic 先行链（prepareClassicSandbox）在装载期按 id 取自己的控件并注册监听：
// 生产由 index.html 的静态标记提供，这里按同一批 id 建最小节点。
const BOOTSTRAP_ELEMENT_IDS = [
  'agent-context-menu', 'agent-list', 'app-chat-input-slot', 'chat-container',
  'chat-process-toggle', 'compact-branch-action', 'compact-context-menu',
  'compact-summary-action', 'compact-trim-action', 'ctx-menu', 'current-agent-name',
  'delete-agent-action', 'delete-feature-action', 'delete-project-action',
  'external-agent-list', 'external-count', 'external-group', 'feature-panel',
  'feature-panel-body', 'feature-panel-collapse-hint', 'feature-panel-resizer',
  'feature-panel-title', 'feature-repo-context-menu', 'follow-latest-btn',
  'language-toggle', 'notification-metrics', 'notification-phase', 'notification-status',
  'notification-summary', 'persistent-action-btn', 'prebuilt-agent-list', 'prebuilt-count',
  'prebuilt-group', 'project-context-menu', 'project-docset-overlay', 'project-docset-sheet',
  'project-docset-toggle', 'restart-agent-action', 'settings-flyout-auth',
  'settings-flyout-config', 'settings-flyout-exit', 'settings-flyout-mcp-gateway',
  'settings-flyout-menu', 'settings-flyout-plugins', 'settings-flyout-proxy',
  'settings-flyout-remote', 'settings-flyout-remote-servers', 'settings-flyout-usage',
  'settings-flyout-workspace', 'settings-toggle', 'sidebar', 'sidebar-collapse-hint',
  'sidebar-resizer', 'sidebar-toggle', 'stop-agent-action', 'theme-toggle',
  'tool-agent-list', 'tool-count', 'tool-group', 'workspace-tabs-bar',
];

function createDocumentWithBootstrapNodes() {
  const harness = createDomHarness();
  const { document } = harness;
  for (const id of BOOTSTRAP_ELEMENT_IDS) {
    if (document.getElementById(id)) continue;
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  return document;
}

/**
 * 常驻输入面点击用例基座：真实 persistent-input（含其 import 图）+ 生产 classic
 * 宿主链；网络面按 fetch 记账，点击路径的终态由「发了哪个端点」判定。
 */
async function withComposerClickCase({ buttonClasses = [], textarea = null, sessionRefs = [], voice = {} }, fn) {
  const classes = new Set(buttonClasses);
  const document = createDocumentWithBootstrapNodes();
  // 控件按真实 DOM 语义落到文档里：点击路径经 document.getElementById 取按钮、
  // 再经 closest('.user-input-card') / querySelector('.user-input-textarea') 取输入框。
  const card = document.createElement('div');
  card.className = 'user-input-card';
  document.body.appendChild(card);
  const button = document.getElementById('persistent-action-btn');
  card.appendChild(button);
  button.classList.contains = (name) => classes.has(name);
  let textareaEl = null;
  if (textarea) {
    // 真实元素语义：submit 路径经 document.getElementById('input-persistent') 取它
    textareaEl = document.createElement('textarea');
    textareaEl.className = 'user-input-textarea';
    textareaEl.value = textarea.value;
    textareaEl.dataset.sessionKey = textarea.dataset?.sessionKey || '';
    textareaEl.id = 'input-persistent';
    card.appendChild(textareaEl);
  }
  const refs = [...sessionRefs];
  const fetchCalls = [];
  const stopRecordingCalls = [];
  return withP2EsmCase({
    classic: (sandbox) => { prepareClassicSandbox(sandbox); },
    globals: {
      document,
      fetch: async (url, init = {}) => {
        fetchCalls.push({ url: String(url), body: init.body });
        return { ok: true, status: 200, json: async () => ({}) };
      },
      SessionReference: {
        activeKey: () => 'agent-1::session-a',
        peek: () => refs.map((ref) => ref),
        consume: () => refs.splice(0, refs.length),
        restore: (value) => { refs.push(...value); },
        chipsHtml: () => '',
      },
      // 以下 classic 汇点不在本文件的验收面内（desktop-notify / input-render /
      // recap-hint 的实现不在 prepareClassicSandbox 的链里）：按既有同名协议提供。
      _requestNotifyPermission: () => {},
      _clearRecapForNewMessage: () => {},
      notifyInputSurfaceChanged: () => {},
      updateQueueIndicator: () => {},
      _markAgentCallStartedForNotify: () => {},

    },
  }, async (c) => {
    // 真实浏览器有 rAF；经典基座为省句柄把 sandbox.requestAnimationFrame 中和成
    // 返回 0 的空实现，而提交路径的 paint 门槛（_nextPaint）必须等到回调——这里
    // 恢复一个「立即回调」的同义实现（模块裸引用的是 globalThis，故一并替换）。
    c.window.requestAnimationFrame = (cb) => c.window.setTimeout(() => cb(Date.now()), 0);
    globalThis.requestAnimationFrame = c.window.requestAnimationFrame;
    // 侧栏绘制与聊天跟随属 UI 落点：sidebar-render 的 classic renderAgentList 依赖
    // sidebar-layout（P4 已迁 ESM，不在本基座的 classic 链里），chat-viewport 的
    // 跟随入口同样未装载。本文件只判定「走了哪个端点」，两处按记录器覆盖。
    c.window.renderAgentList = () => {};
    c.window.beginFollowLatestEntryWindow = () => {};
    c.window.requestFollowLatest = () => {};
    // 削轮询相位的立即轮询入口（app-main 的 ClawFW 协议）会拉起完整轮询链；
    // 本文件只判定提交端点，按「立即轮询已受理」的空实现覆盖。
    c.window.ClawFW.requestImmediatePoll = () => {};
    // 焦点 runtime：生产由切换链写入 orchestration owner（本用例按真实 setter 设置）
    const orchestration = await c.load('public/src/modules/orchestration-state.js');
    orchestration.setCurrentRuntimeAgentId('agent-1');
    const persistent = await c.load(PERSISTENT_INPUT);
    const voiceState = await c.load(VOICE_STATE);
    voiceState.setVoiceRecording(Boolean(voice.recording));
    voiceState.setVoiceStopping(Boolean(voice.stopping));
    voiceState.setVoiceTranscribing(Boolean(voice.transcribing));
    // 语音停止是 voice-input-api 的桥键：记到调用记录里（本用例不装语音实现）。
    c.window.stopVoiceRecording = () => { stopRecordingCalls.push(1); };
    return fn({ c, persistent, voiceState, fetchCalls, stopRecordingCalls });
  });
}

describe('persistent input interrupt precedence', () => {
  it('stops the agent without stopping an independent voice recording', async () => {
    await withComposerClickCase({ buttonClasses: ['is-stop'], voice: { recording: true } }, async ({
      persistent, voiceState, fetchCalls, stopRecordingCalls,
    }) => {
      persistent.onPersistentBtnClick();
      // 空输入 + stop 语义 = 中断：走真实 interruptAgent（端点在网络面可见）
      assert.equal(fetchCalls.length, 1);
      assert.match(fetchCalls[0].url, /\/interrupt$/);
      assert.equal(stopRecordingCalls.length, 0, '中断优先于语音停止');
      assert.equal(voiceState.voicePendingSend, false);
    });
  });

  it('sends instead of interrupting when the composer holds text', async () => {
    // 新语义：runtime calling 中按钮显示 stop，但输入框有内容时点击 = 发送
    //（user-turn 由 ViewerWorker 排队），仅空输入才解释为中断。
    const textarea = { value: '  继续刚才的任务  ', dataset: { sessionKey: 'agent-1::session-a' } };
    await withComposerClickCase({ buttonClasses: ['is-stop'], textarea }, async ({ persistent, fetchCalls }) => {
      await persistent.onPersistentBtnClick();
      assert.equal(fetchCalls.length, 1);
      assert.match(fetchCalls[0].url, /\/user-turn$/);
      assert.equal(JSON.parse(fetchCalls[0].body).text, '继续刚才的任务');
    });
  });

  it('sends instead of interrupting when only session references are attached', async () => {
    // 引用-only 消息（空文本 + 引用 pill）同样走发送而非中断。
    const textarea = { value: '', dataset: { sessionKey: 'agent-1::session-a' } };
    await withComposerClickCase({
      buttonClasses: ['is-stop'],
      textarea,
      sessionRefs: [{ agentId: 'a', sessionId: 's' }],
    }, async ({ persistent, fetchCalls }) => {
      await persistent.onPersistentBtnClick();
      assert.equal(fetchCalls.length, 1);
      assert.match(fetchCalls[0].url, /\/user-turn$/);
      assert.deepEqual(JSON.parse(fetchCalls[0].body).metadata,
        { 'session-reference': [{ agentId: 'a', sessionId: 's' }] });
    });
  });
});

describe('voice input render lifecycle', () => {
  it('prevents Enter newline and queues a send while streaming ASR is finalizing', async () => {
    await withComposerClickCase({ voice: { transcribing: true } }, async ({
      persistent, voiceState, fetchCalls,
    }) => {
      let prevented = 0;
      persistent.handlePersistentInputKey({
        key: 'Enter',
        ctrlKey: false,
        shiftKey: false,
        preventDefault() { prevented += 1; },
      });

      assert.equal(prevented, 1, 'plain Enter must not insert a newline while final ASR is pending');
      assert.equal(voiceState.voicePendingSend, true, 'Enter queues the send until the final transcript is applied');
      assert.equal(fetchCalls.length, 0, 'do not send before the final streamed transcript arrives');
    });
  });

  // voice-input 已迁 ESM（P4 L3）：判定函数与录音状态 owner 都在真实模块图里。
  // classic 相只装生产宿主链（prepareClassicSandbox），桥键由模块自身注册。
  it('preserves recording/stopping/transcribing across same-session input redraws only', async () => {
    await withP2EsmCase({ classic: prepareClassicSandbox }, async (c) => {
      const voiceInput = await c.load(VOICE_INPUT);
      const voiceState = await c.load(VOICE_STATE);
      voiceInput.__testVoiceState.cacheKey = 'session-a';
      voiceState.setVoiceRecording(true);
      voiceState.setVoiceStopping(false);
      voiceState.setVoiceTranscribing(false);

      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('persistent', 'session-a'), true);
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('choice', 'session-a'), true);
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('compacting', 'session-a'), true);
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('persistent', 'session-b'), false);
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('hidden', 'session-a'), false);
      // requests 模式已退役（ADR-0035）：文本 lease 不再构成渲染模式，
      // 传入旧枚举值不得被当成可保留录音的交互面。
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('requests', 'session-a'), false);

      voiceState.setVoiceRecording(false);
      voiceState.setVoiceStopping(true);
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('persistent', 'session-a'), true);
      voiceState.setVoiceStopping(false);
      voiceState.setVoiceTranscribing(true);
      assert.equal(voiceInput._shouldPreserveVoiceInputForRender('persistent', 'session-a'), true);
    });
  });

  it('restores a cross-session voice draft when delivery is rejected', async () => {
    const toasts = [];
    const drafts = {};
    await withP2EsmCase({
      classic: (sandbox) => {
        prepareClassicSandbox(sandbox);
        // composer 域草稿缓存（桥键）：模块经 window 晚绑定取用
        sandbox._sessionInputCache = drafts;
      },
    }, async (c) => {
      const voiceInput = await c.load(VOICE_INPUT);
      // toast-notify 在自己的模块求值时挂 window.ClawToast，因此桩在装载之后覆盖。
      c.window.ClawToast = { show: (value) => toasts.push(value) };
      voiceInput._restoreCrossSessionVoiceInput('session-a', 'typed and spoken', 'agent-a', 'runtime unavailable');

      assert.equal(drafts['session-a'], 'typed and spoken');
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].status, 'error');
    });
  });
});
