import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

describe('persistent input interrupt precedence', () => {
  it('stops the agent without stopping an independent voice recording', () => {
    let interruptCalls = 0;
    let stopRecordingCalls = 0;
    const classes = new Set(['is-stop']);
    const button = {
      classList: {
        contains: (name) => classes.has(name),
      },
    };
    const ctx = createFrontendSandbox({
      document: { getElementById: () => button },
      _imageBucket: () => [],
      _voiceRecording: true,
      _voiceStopping: false,
      _voiceTranscribing: false,
      _voicePendingSend: false,
      interruptAgent: () => { interruptCalls += 1; },
      stopVoiceRecording: () => { stopRecordingCalls += 1; },
      submitQueuedInput() { throw new Error('must not submit'); },
    });
    const source = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
    ctx.run(sourceBetween(source, 'function onPersistentBtnClick()', 'function _setActionBtnStop()'));
    ctx.run('let _submitInFlight = false; onPersistentBtnClick();');

    assert.equal(interruptCalls, 1);
    assert.equal(stopRecordingCalls, 0);
    assert.equal(ctx._voicePendingSend, false);
  });

  it('sends instead of interrupting when the composer holds text', () => {
    // 新语义：runtime calling 中按钮显示 stop，但输入框有内容时点击 = 发送
    //（user-turn 由 ViewerWorker 排队），仅空输入才解释为中断。
    let interruptCalls = 0;
    let submitCalls = 0;
    const classes = new Set(['is-stop']);
    const button = {
      classList: {
        contains: (name) => classes.has(name),
      },
    };
    const textarea = { value: '  继续刚才的任务  ' };
    const ctx = createFrontendSandbox({
      document: { getElementById: (id) => (id === 'input-persistent' ? textarea : button) },
      _imageBucket: () => [],
      _voiceRecording: false,
      _voiceStopping: false,
      _voiceTranscribing: false,
      _voicePendingSend: false,
      interruptAgent: () => { interruptCalls += 1; },
      stopVoiceRecording: () => {},
      submitQueuedInput() { submitCalls += 1; },
    });
    const source = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
    ctx.run(sourceBetween(source, 'function onPersistentBtnClick()', 'function _setActionBtnStop()'));
    ctx.run('let _submitInFlight = false; onPersistentBtnClick();');

    assert.equal(interruptCalls, 0);
    assert.equal(submitCalls, 1);
  });

  it('sends instead of interrupting when only session references are attached', () => {
    // 引用-only 消息（空文本 + 引用 pill）同样走发送而非中断。
    let interruptCalls = 0;
    let submitCalls = 0;
    const classes = new Set(['is-stop']);
    const button = {
      classList: {
        contains: (name) => classes.has(name),
      },
    };
    const textarea = { value: '' };
    const ctx = createFrontendSandbox({
      document: { getElementById: (id) => (id === 'input-persistent' ? textarea : button) },
      _imageBucket: () => [],
      _voiceRecording: false,
      _voiceStopping: false,
      _voiceTranscribing: false,
      _voicePendingSend: false,
      window: { SessionReference: { peek: () => [{ agentId: 'a', sessionId: 's' }] } },
      interruptAgent: () => { interruptCalls += 1; },
      stopVoiceRecording: () => {},
      submitQueuedInput() { submitCalls += 1; },
    });
    const source = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
    ctx.run(sourceBetween(source, 'function onPersistentBtnClick()', 'function _setActionBtnStop()'));
    ctx.run('let _submitInFlight = false; onPersistentBtnClick();');

    assert.equal(interruptCalls, 0);
    assert.equal(submitCalls, 1);
  });
});

describe('voice input render lifecycle', () => {
  it('preserves recording/stopping/transcribing across same-session input redraws only', () => {
    const ctx = createFrontendSandbox({
      _voiceRecording: true,
      _voiceStopping: false,
      _voiceTranscribing: false,
      _voiceCacheKey: 'session-a',
    });
    const source = fs.readFileSync('public/src/modules/voice-input.js', 'utf8');
    ctx.run(sourceBetween(source, 'function _shouldPreserveVoiceInputForRender', 'function _markVoiceAutoSendAccepted'));

    assert.equal(ctx.run('_shouldPreserveVoiceInputForRender("persistent", "session-a")'), true);
    assert.equal(ctx.run('_shouldPreserveVoiceInputForRender("requests", "session-a")'), true);
    assert.equal(ctx.run('_shouldPreserveVoiceInputForRender("requests", "session-b")'), false);
    assert.equal(ctx.run('_shouldPreserveVoiceInputForRender("hidden", "session-a")'), false);

    ctx.run('_voiceRecording = false; _voiceStopping = true;');
    assert.equal(ctx.run('_shouldPreserveVoiceInputForRender("persistent", "session-a")'), true);
    ctx.run('_voiceStopping = false; _voiceTranscribing = true;');
    assert.equal(ctx.run('_shouldPreserveVoiceInputForRender("persistent", "session-a")'), true);
  });

  it('restores a cross-session voice draft when delivery is rejected', () => {
    const toasts = [];
    const ctx = createFrontendSandbox();
    ctx.window.ClawToast = { show: (value) => toasts.push(value) };
    const source = fs.readFileSync('public/src/modules/voice-input.js', 'utf8');
    ctx.run('let _sessionInputCache = {};');
    ctx.run(sourceBetween(source, 'function _restoreCrossSessionVoiceInput', 'function stopVoiceRecording'));
    ctx.run(`_restoreCrossSessionVoiceInput('session-a', 'typed and spoken', 'agent-a', 'runtime unavailable')`);

    assert.equal(ctx.run(`_sessionInputCache['session-a']`), 'typed and spoken');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'error');
  });
});
