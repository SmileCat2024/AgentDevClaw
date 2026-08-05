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
