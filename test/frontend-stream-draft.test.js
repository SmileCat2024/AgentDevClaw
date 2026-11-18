/**
 * Tests for the streaming ASR draft synthesis rules
 * (public/src/modules/stream-draft-logic.js + voice-input.js wiring).
 *
 * The core conflict being arbitrated: ASR partial rewrites (it may revise
 * earlier text within the active segment) vs. user manual edits to the same
 * textarea. Rule under test: ASR owns the untouched active tail; once the
 * user edits it, the segment is promoted to plain text and ASR degrades to
 * cursor-local incremental insertion, never deleting user content.
 *
 * stream-draft-logic.js and the voice-input.js wiring are both ESM (P4 L3):
 * the pure rules are imported directly, the wiring runs on the real module
 * graph (withP2EsmCase), and the composer/app-main consumers it late-binds
 * through `window` are supplied by the classic sandbox.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const VOICE_INPUT = 'public/src/modules/voice-input.js';

// 真实 import 路线：kernel-state 先装（被测模块顶层 defineKey 需要
// window.KernelState）；cleanup 经 t.after 恢复全局。
function loadLogic(t) {
  const cleanup = installBrowserStubs();
  t.after(cleanup);
  return loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false })
    .then(() => loadModuleOnce('public/src/modules/stream-draft-logic.js', { installGlobals: false })
      .then(({ module }) => module))
    .catch((err) => {
      cleanup();
      throw err;
    });
}

describe('planStreamDraftMutation', () => {
  it('grows the active tail in place when the user has not touched it', async (t) => {
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('已有的字你好', 6, 6, '你好', '你好世界');
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '已有的字你好世界');
    assert.equal(plan.caret, '已有的字你好世界'.length);
  });

  it('rewrites the active tail when ASR revises it (homophone fix)', async (t) => {
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你好世', 5, 5, '你好世', '您好吃');
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '前文您好吃');
  });

  it('appends from scratch when a new segment starts (empty active text)', async (t) => {
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文已固化段', 8, 8, '', '新段');
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '前文已固化段新段');
  });

  it('keeps user deletions inside the active segment and inserts at the cursor', async (t) => {
    // User deleted '好' from the active segment '你好' → value no longer ends
    // with it. Next event '你好世界' must NOT restore '好' and must NOT touch
    // anything except inserting the delta '世界' at the user's cursor.
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你', 3, 3, '你好', '你好世界');
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '世界');
    assert.equal(plan.start, 3);
    assert.equal(plan.end, 3);
  });

  it('inserts at the cursor when the user typed after the active tail', async (t) => {
    // User typed 'ab' after '你好' — endsWith fails, delta goes to the cursor.
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('xx你好ab', 6, 6, '你好', '你好世界');
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '世界');
  });

  it('preserves user edits before the active tail via tail replacement', async (t) => {
    // User deleted a char BEFORE the active segment: value still ends with
    // activeText, so the tail gets refreshed and the user's deletion stays.
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('已的字你好', 5, 5, '你好', '你好呀');
    assert.equal(plan.kind, 'replace-tail');
    assert.equal(plan.value, '已的字你好呀');
  });

  it('returns noop when ASR retracts and the user already edited the segment', async (t) => {
    // newText is a strict prefix of activeText (ASR retraction) and the user
    // edited the segment: nothing to insert, nothing may be deleted.
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你', 3, 3, '你好世界', '你好');
    assert.equal(plan.kind, 'noop');
  });

  it('drops punctuation-only deltas (transient pause punctuation after user edit)', async (t) => {
    // Streaming decode closes a pause with "。" then revises it later. After
    // the user typed behind the segment, the punctuation-only delta must NOT
    // be frozen into the textarea.
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你好世界xx', 8, 8, '你好世界', '你好世界。');
    assert.equal(plan.kind, 'noop');
  });

  it('strips leading punctuation from inserted deltas after user edit', async (t) => {
    // activeText ended at the pause close "你好世界。"; next event rewrites the
    // close into a continuation "你好世界，后面" — the leading "，" is the
    // transient rewrite of an already-frozen state and must not be inserted.
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你好世界。xx', 9, 9, '你好世界。', '你好世界，后面输');
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '后面输');
  });

  it('keeps interior punctuation inside inserted deltas', async (t) => {
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你xx', 5, 5, '你好', '你好，世界。再见');
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '世界。再见'); // only the LEADING mark is stripped
  });

  it('replaces a selected range rather than just the caret when inserting', async (t) => {
    const logic = await loadLogic(t);
    const plan = logic.planStreamDraftMutation('前文你', 1, 3, '你好', '你好吗');
    assert.equal(plan.kind, 'insert');
    assert.equal(plan.delta, '吗');
    assert.equal(plan.start, 1);
    assert.equal(plan.end, 3);
  });
});

describe('planStreamDraftCancel', () => {
  it('removes committed + active text when both are untouched', async (t) => {
    const logic = await loadLogic(t);
    const restored = logic.planStreamDraftCancel('前文固化段活跃段', '固化段', '活跃段');
    assert.equal(restored, '前文');
  });

  it('removes only the active segment when the committed part was edited', async (t) => {
    const logic = await loadLogic(t);
    const restored = logic.planStreamDraftCancel('前文改过的固化段活跃段', '固化段', '活跃段');
    assert.equal(restored, '前文改过的');
  });

  it('keeps everything when the user edited too much to locate speech text', async (t) => {
    const logic = await loadLogic(t);
    const restored = logic.planStreamDraftCancel('前文用户深度编辑过', '固化段', '活跃段');
    assert.equal(restored, null);
  });

  it('keeps everything when nothing was transcribed yet', async (t) => {
    const logic = await loadLogic(t);
    const restored = logic.planStreamDraftCancel('前文', '', '');
    assert.equal(restored, null);
  });
});

describe('stream-draft bridge (kernel-state compatibility)', () => {
  // 契约：classic 消费方 voice-input.js 裸调用这两个函数（沿全局词法环境
  // 解析到 window 访问器），ESM 化后行为不变。
  it('exposes both functions via window accessors and calls are equivalent', async (t) => {
    const logic = await loadLogic(t);
    assert.equal(window.planStreamDraftMutation, logic.planStreamDraftMutation);
    assert.equal(window.planStreamDraftCancel, logic.planStreamDraftCancel);
    const plan = window.planStreamDraftMutation('前文你', 3, 3, '你好', '你好世界');
    assert.equal(plan.kind, 'insert');
    assert.equal(window.planStreamDraftCancel('前文', '', ''), null);
  });

  it('forwards classic writes through the claimed accessor', async (t) => {
    await loadLogic(t);
    const sentinel = () => ({ kind: 'sentinel' });
    window.planStreamDraftMutation = sentinel;
    assert.equal(window.planStreamDraftMutation, sentinel);
    assert.deepEqual(window.planStreamDraftMutation(), { kind: 'sentinel' });
  });
});

describe('_applyStreamTextToDraft wiring (voice-input.js)', () => {
  /**
   * voice-input 已迁 ESM（P4 L3）：合成规则（stream-draft-logic）与接线在同一张
   * 真实模块图里，不再有「classic 片段抽取 + 同名全局桩」的装载。模块私有的
   * 活跃段 / 组字标志 / 录音目标与会话键经 `__testVoiceState` 读写；classic 相
   * 提供 composer 与 app-main 的消费面（`_cacheSessionInput` /
   * `_getSessionInputCacheKey`，生产里同样经 window 晚绑定取用）与 textarea 宿主。
   */
  async function withWiring(textarea, { cacheKeyFor = () => 'session-a' } = {}, fn) {
    return withP2EsmCase({
      classic: (sandbox) => {
        prepareClassicSandbox(sandbox);
        // 输入宿主 textarea 只替换输入面 id；其余 id（含 dom-refs 在模块相解析的
        // 那批元素引用）继续走沙箱的元素桩。
        const baseGetElementById = sandbox.document.getElementById.bind(sandbox.document);
        sandbox.document.getElementById = (id) => (String(id).startsWith('input-')
          ? textarea
          : baseGetElementById(id));
        sandbox._cacheSessionInput = () => {};
        sandbox._getSessionInputCacheKey = cacheKeyFor;
      },
    }, async (c) => {
      const voiceInput = await c.load(VOICE_INPUT);
      voiceInput.__testVoiceState.targetId = 'input-persistent';
      voiceInput.__testVoiceState.cacheKey = 'session-a';
      voiceInput.__testVoiceState.activeText = '';
      voiceInput.__testVoiceState.composing = false;
      return fn(voiceInput, voiceInput.__testVoiceState);
    });
  }

  function makeTextarea(value, selStart, selEnd) {
    const sel = { start: selStart, end: selEnd ?? selStart };
    return {
      value,
      // autoResize（input-actions，真实实现）按 scrollHeight 写行高
      style: {},
      scrollHeight: 0,
      get selectionStart() { return sel.start; },
      get selectionEnd() { return sel.end; },
      setSelectionRange(a, b) { sel.start = a; sel.end = b; },
      setRangeText(replacement, start, end) {
        this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
        sel.start = sel.end = start + replacement.length;
      },
    };
  }

  it('writes the tail replacement into the textarea and tracks the active text', async () => {
    const textarea = makeTextarea('已有的', 3);
    await withWiring(textarea, {}, (voiceInput, state) => {
      voiceInput._applyStreamTextToDraft('你好');
      assert.equal(textarea.value, '已有的你好');
      assert.equal(textarea.selectionStart, '已有的你好'.length);
      assert.equal(state.activeText, '你好');

      voiceInput._applyStreamTextToDraft('你好世界');
      assert.equal(textarea.value, '已有的你好世界');
    });
  });

  it('freezes rewriting once the user edits the active segment', async () => {
    const textarea = makeTextarea('已有的你好', 6);
    await withWiring(textarea, {}, (voiceInput, state) => {
      state.activeText = '你好';
      // User deletes '好' (outside our helpers): value becomes '已有的你'
      textarea.value = '已有的你';
      voiceInput._applyStreamTextToDraft('你好世界');
      // Segment promoted: delta inserted at cursor, user deletion preserved
      assert.equal(textarea.value, '已有的你世界');
    });
  });

  it('does not freeze transient pause punctuation after the user edited', async () => {
    // Real-world ASR oscillation around a pause: "你好" → "你好。"(pause close)
    // → "你好，世界"(rewrite into continuation). After one user edit the
    // wiring must surface neither the "。" nor the leading "，".
    const textarea = makeTextarea('已有的你好', 6);
    await withWiring(textarea, {}, (voiceInput, state) => {
      state.activeText = '你好';
      textarea.value = '已有的你'; // user deleted '好'
      voiceInput._applyStreamTextToDraft('你好。');
      assert.equal(textarea.value, '已有的你'); // punctuation-only delta: noop
      voiceInput._applyStreamTextToDraft('你好，世界');
      assert.equal(textarea.value, '已有的你世界'); // leading "，" stripped
    });
  });

  it('skips textarea writes entirely during IME composition', async () => {
    const textarea = makeTextarea('已有的', 3);
    await withWiring(textarea, {}, (voiceInput, state) => {
      state.composing = true;
      voiceInput._applyStreamTextToDraft('你好');
      // Nothing written, active text not advanced — the next event after
      // compositionend reconciles from the stale active text.
      assert.equal(textarea.value, '已有的');
      assert.equal(state.activeText, '');
    });
  });

  it('skips textarea writes after the session switched', async () => {
    const textarea = makeTextarea('已有的', 3);
    await withWiring(textarea, { cacheKeyFor: () => 'session-b' }, (voiceInput, state) => {
      voiceInput._applyStreamTextToDraft('你好');
      assert.equal(textarea.value, '已有的');
      assert.equal(state.activeText, '');
    });
  });
});
