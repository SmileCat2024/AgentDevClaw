/**
 * Tests for the streaming ASR draft synthesis rules
 * (public/src/modules/stream-draft-logic.js + voice-input.js wiring).
 *
 * The core conflict being arbitrated: ASR partial rewrites (it may revise
 * earlier text within the active segment) vs. user manual edits to the same
 * textarea. Rule under test: ASR owns the untouched active tail; once the
 * user edits it, the segment is promoted to plain text and ASR degrades to
 * cursor-local incremental insertion, never deleting user content.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const logicSource = fs.readFileSync('public/src/modules/stream-draft-logic.js', 'utf8');

function loadLogic() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/stream-draft-logic.js');
  return ctx;
}

describe('planStreamDraftMutation', () => {
  it('grows the active tail in place when the user has not touched it', () => {
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('已有的字你好', 6, 6, '你好', '你好世界')`);
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '已有的字你好世界');
    assert.equal(plan.caret, '已有的字你好世界'.length);
  });

  it('rewrites the active tail when ASR revises it (homophone fix)', () => {
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('前文你好世', 5, 5, '你好世', '您好吃')`);
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '前文您好吃');
  });

  it('appends from scratch when a new segment starts (empty active text)', () => {
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('前文已固化段', 8, 8, '', '新段')`);
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '前文已固化段新段');
  });

  it('keeps user deletions inside the active segment and inserts at the cursor', () => {
    // User deleted '好' from the active segment '你好' → value no longer ends
    // with it. Next event '你好世界' must NOT restore '好' and must NOT touch
    // anything except inserting the delta '世界' at the user's cursor.
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('前文你', 3, 3, '你好', '你好世界')`);
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '世界');
    assert.equal(plan.start, 3);
    assert.equal(plan.end, 3);
  });

  it('inserts at the cursor when the user typed after the active tail', () => {
    const ctx = loadLogic();
    // User typed 'ab' after '你好' — endsWith fails, delta goes to the cursor.
    const plan = ctx.run(`planStreamDraftMutation('xx你好ab', 6, 6, '你好', '你好世界')`);
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '世界');
  });

  it('preserves user edits before the active tail via tail replacement', () => {
    // User deleted a char BEFORE the active segment: value still ends with
    // activeText, so the tail gets refreshed and the user's deletion stays.
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('已的字你好', 5, 5, '你好', '你好呀')`);
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '已的字你好呀');
  });

  it('returns noop when ASR retracts and the user already edited the segment', () => {
    const ctx = loadLogic();
    // newText is a strict prefix of activeText (ASR retraction) and the user
    // edited the segment: nothing to insert, nothing may be deleted.
    const plan = ctx.run(`planStreamDraftMutation('前文你', 3, 3, '你好世界', '你好')`);
    assert.equal(plan.kind, 'noop');
  });

  it('drops punctuation-only deltas (transient pause punctuation after user edit)', () => {
    const ctx = loadLogic();
    // Streaming decode closes a pause with "。" then revises it later. After
    // the user typed behind the segment, the punctuation-only delta must NOT
    // be frozen into the textarea.
    const plan = ctx.run(`planStreamDraftMutation('前文你好世界xx', 8, 8, '你好世界', '你好世界。')`);
    assert.equal(plan.kind, 'noop');
  });

  it('strips leading punctuation from inserted deltas after user edit', () => {
    const ctx = loadLogic();
    // activeText ended at the pause close "你好世界。"; next event rewrites the
    // close into a continuation "你好世界，后面" — the leading "，" is the
    // transient rewrite of an already-frozen state and must not be inserted.
    const plan = ctx.run(`planStreamDraftMutation('前文你好世界。xx', 9, 9, '你好世界。', '你好世界，后面输')`);
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '后面输');
  });

  it('keeps interior punctuation inside inserted deltas', () => {
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('前文你xx', 5, 5, '你好', '你好，世界。再见')`);
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '世界。再见'); // only the LEADING mark is stripped
  });

  it('replaces a selected range rather than just the caret when inserting', () => {
    const ctx = loadLogic();
    const plan = ctx.run(`planStreamDraftMutation('前文你', 1, 3, '你好', '你好吗')`);
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '吗');
    assert.equal(plan.start, 1);
    assert.equal(plan.end, 3);
  });
});

describe('planStreamDraftCancel', () => {
  it('removes committed + active text when both are untouched', () => {
    const ctx = loadLogic();
    const restored = ctx.run(`planStreamDraftCancel('前文固化段活跃段', '固化段', '活跃段')`);
    assert.equal(restored, '前文');
  });

  it('removes only the active segment when the committed part was edited', () => {
    const ctx = loadLogic();
    const restored = ctx.run(`planStreamDraftCancel('前文改过的固化段活跃段', '固化段', '活跃段')`);
    assert.equal(restored, '前文改过的');
  });

  it('keeps everything when the user edited too much to locate speech text', () => {
    const ctx = loadLogic();
    const restored = ctx.run(`planStreamDraftCancel('前文用户深度编辑过', '固化段', '活跃段')`);
    assert.equal(restored, null);
  });

  it('keeps everything when nothing was transcribed yet', () => {
    const ctx = loadLogic();
    const restored = ctx.run(`planStreamDraftCancel('前文', '', '')`);
    assert.equal(restored, null);
  });
});

describe('_applyStreamTextToDraft wiring (voice-input.js)', () => {
  function loadWiring(textarea, overrides = {}) {
    const ctx = createFrontendSandbox({
      document: { getElementById: () => textarea },
      autoResize: () => {},
      _cacheSessionInput: () => {},
      _getSessionInputCacheKey: () => 'session-a',
      ...overrides,
    });
    ctx.run(logicSource);
    const source = fs.readFileSync('public/src/modules/voice-input.js', 'utf8');
    ctx.run(sourceBetween(source, 'function _applyStreamTextToDraft', 'function _haltStreamCapture'));
    ctx.run(`let _voiceTargetId = 'input-persistent'; let _voiceCacheKey = 'session-a';`);
    return ctx;
  }

  function makeTextarea(value, selStart, selEnd) {
    const sel = { start: selStart, end: selEnd ?? selStart };
    return {
      value,
      get selectionStart() { return sel.start; },
      get selectionEnd() { return sel.end; },
      setSelectionRange(a, b) { sel.start = a; sel.end = b; },
      setRangeText(replacement, start, end) {
        this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
        sel.start = sel.end = start + replacement.length;
      },
    };
  }

  it('writes the tail replacement into the textarea and tracks the active text', () => {
    const textarea = makeTextarea('已有的', 3);
    const ctx = loadWiring(textarea);
    ctx.run(`let _voiceStreamActiveText = ''; let _voiceStreamComposing = false;`);
    ctx.run(`_applyStreamTextToDraft('你好')`);
    assert.equal(textarea.value, '已有的你好');
    assert.equal(textarea.selectionStart, '已有的你好'.length);
    assert.equal(ctx.run('_voiceStreamActiveText'), '你好');

    ctx.run(`_applyStreamTextToDraft('你好世界')`);
    assert.equal(textarea.value, '已有的你好世界');
  });

  it('freezes rewriting once the user edits the active segment', () => {
    const textarea = makeTextarea('已有的你好', 6);
    const ctx = loadWiring(textarea);
    ctx.run(`let _voiceStreamActiveText = '你好'; let _voiceStreamComposing = false;`);
    // User deletes '好' (outside our helpers): value becomes '已有的你'
    textarea.value = '已有的你';
    ctx.run(`_applyStreamTextToDraft('你好世界')`);
    // Segment promoted: delta inserted at cursor, user deletion preserved
    assert.equal(textarea.value, '已有的你世界');
  });

  it('does not freeze transient pause punctuation after the user edited', () => {
    // Real-world ASR oscillation around a pause: "你好" → "你好。"(pause close)
    // → "你好，世界"(rewrite into continuation). After one user edit the
    // wiring must surface neither the "。" nor the leading "，".
    const textarea = makeTextarea('已有的你好', 6);
    const ctx = loadWiring(textarea);
    ctx.run(`let _voiceStreamActiveText = '你好'; let _voiceStreamComposing = false;`);
    textarea.value = '已有的你'; // user deleted '好'
    ctx.run(`_applyStreamTextToDraft('你好。')`);
    assert.equal(textarea.value, '已有的你'); // punctuation-only delta: noop
    ctx.run(`_applyStreamTextToDraft('你好，世界')`);
    assert.equal(textarea.value, '已有的你世界'); // leading "，" stripped
  });

  it('skips textarea writes entirely during IME composition', () => {
    const textarea = makeTextarea('已有的', 3);
    const ctx = loadWiring(textarea);
    ctx.run(`let _voiceStreamActiveText = ''; let _voiceStreamComposing = true;`);
    ctx.run(`_applyStreamTextToDraft('你好')`);
    // Nothing written, active text not advanced — the next event after
    // compositionend reconciles from the stale active text.
    assert.equal(textarea.value, '已有的');
    assert.equal(ctx.run('_voiceStreamActiveText'), '');
  });

  it('skips textarea writes after the session switched', () => {
    const textarea = makeTextarea('已有的', 3);
    const ctx = loadWiring(textarea, { _getSessionInputCacheKey: () => 'session-b' });
    ctx.run(`let _voiceStreamActiveText = ''; let _voiceStreamComposing = false;`);
    ctx.run(`_applyStreamTextToDraft('你好')`);
    assert.equal(textarea.value, '已有的');
    assert.equal(ctx.run('_voiceStreamActiveText'), '');
  });
});
