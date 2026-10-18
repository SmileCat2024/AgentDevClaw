/**
 * trim-ratio-core.js 纯函数测试（frontend-vm 沙箱加载，script 全局模式）。
 *
 * 数据面直接构造服务端 buildSessionTrimMessagePreview 的投影形状
 * （index/role/charCount/contentCharCount/toolCalls/toolCallId），
 * 服务端投影自身的正确性由 session-helpers-pure.test.js 覆盖。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

const NOTE_PREFIX = '[Folded tool activity]\nassistant tool calls: ';

function loadCore() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/trim-ratio-core.js');
  // 模块经 window 守卫挂载（script 全局模式），落在沙箱的 window stub 上
  return ctx.window.TrimRatioCore;
}

// 投影构造器：模拟服务端 messages[] 形状
function msg(role, { charCount = 0, contentCharCount = 0, toolCalls, toolCallId } = {}) {
  return {
    role,
    charCount,
    contentCharCount,
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

function toolPair(id, file, argChars, resultChars) {
  return [
    msg('assistant', {
      charCount: argChars,
      toolCalls: [{ id, name: 'read', summary: `read(${file})` }],
    }),
    msg('tool', { charCount: resultChars, toolCallId: id }),
  ];
}

describe('TrimRatioCore.safeCutCandidates', () => {
  it('marks cut indexes safe only when no dangling tool_use stays behind', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 10, contentCharCount: 10 }),
      ...toolPair('tc-1', 'a.js', 100, 200),
      ...toolPair('tc-2', 'b.js', 100, 200),
    ];
    const candidates = core.safeCutCandidates(messages);
    // user(0) 后、res1(2) 后、res2(4) 后安全；tc2(3) 与 res2 之间悬空
    assert.deepEqual([...candidates.map((c) => c.cutIndex)], [0, 1, 3, 5]);
  });

  it('flags round boundaries where the keep zone starts at a user message', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 10, contentCharCount: 10 }),
      msg('assistant', { charCount: 10, contentCharCount: 10 }),
      msg('user', { charCount: 10, contentCharCount: 10 }),
      msg('assistant', { charCount: 10, contentCharCount: 10 }),
    ];
    const byIndex = new Map(core.safeCutCandidates(messages).map((c) => [c.cutIndex, c.roundBoundary]));
    assert.equal(byIndex.get(0), true);  // msgs[0] is user
    assert.equal(byIndex.get(1), false);
    assert.equal(byIndex.get(2), true);  // msgs[2] is user
    assert.equal(byIndex.get(4), false); // tail end
  });

  it('treats id-less tool calls as non-dangling', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 5, contentCharCount: 5 }),
      msg('assistant', { charCount: 50, toolCalls: [{ name: 'bash', summary: 'bash' }] }),
      msg('tool', { charCount: 100 }), // no toolCallId to pair
    ];
    assert.deepEqual([...core.safeCutCandidates(messages).map((c) => c.cutIndex)], [0, 1, 2, 3]);
  });
});

describe('TrimRatioCore.estimateFoldResidue', () => {
  it('keeps dialogue text, folds tool activity into one note per run', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 10, contentCharCount: 10 }),
      msg('assistant', { charCount: 40, toolCalls: [{ id: 't1', name: 'read', summary: 'read(a.js)' }] }),
      msg('tool', { charCount: 500, toolCallId: 't1' }),
      msg('assistant', { charCount: 7, contentCharCount: 7 }),
    ];
    // residue = user text 10 + note(read(a.js)) + assistant text 7
    const expected = 10 + (NOTE_PREFIX + 'read(a.js)').length + 7;
    assert.equal(core.estimateFoldResidue(messages, 4), expected);
  });

  it('merges consecutive tool runs but splits them at dialogue text', () => {
    const core = loadCore();
    const messages = [
      ...toolPair('t1', 'a.js', 40, 500),
      msg('user', { charCount: 6, contentCharCount: 6 }),
      ...toolPair('t2', 'b.js', 40, 500),
    ];
    // 两段工具块各出一条注记，user 文本打断
    const expected = (NOTE_PREFIX + 'read(a.js)').length + 6 + (NOTE_PREFIX + 'read(b.js)').length;
    assert.equal(core.estimateFoldResidue(messages, 5), expected);
  });

  it('dedupes identical summaries with ×N like the engine', () => {
    const core = loadCore();
    const messages = [
      msg('assistant', { charCount: 20, toolCalls: [
        { id: 't1', name: 'read', summary: 'read(a.js)' },
        { id: 't2', name: 'read', summary: 'read(a.js)' },
        { id: 't3', name: 'read', summary: 'read(b.js)' },
      ] }),
      msg('tool', { charCount: 10, toolCallId: 't1' }),
      msg('tool', { charCount: 10, toolCallId: 't2' }),
      msg('tool', { charCount: 10, toolCallId: 't3' }),
    ];
    const expected = (NOTE_PREFIX + 'read(a.js) ×2; read(b.js)').length;
    assert.equal(core.estimateFoldResidue(messages, 4), expected);
  });
});

describe('TrimRatioCore.ratioToCut', () => {
  it('prefers round boundaries when one fits the budget', () => {
    const core = loadCore();
    // 轮1：user 100 文本 + 工具对（args 1000 / result 2000）
    // 轮2：user 200 + assistant 200 纯文本
    const messages = [
      msg('user', { charCount: 100, contentCharCount: 100 }),
      ...toolPair('t1', 'a.js', 1000, 2000),
      msg('user', { charCount: 200, contentCharCount: 200 }),
      msg('assistant', { charCount: 200, contentCharCount: 200 }),
    ];
    // total 3500；轮2 头（index 3）kept = 100 + note + 400 ≈ 555 ≤ 0.2×3500=700
    const result = core.ratioToCut(messages, 0, 0.2);
    assert.equal(result.cutIndex, 3);
    assert.equal(result.unmet, false);
  });

  it('cuts inside a giant single round when no round boundary fits', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 50, contentCharCount: 50 }),
    ];
    for (let i = 0; i < 20; i++) {
      messages.push(...toolPair(`t${i}`, `f${i}.js`, 500, 9500));
    }
    // 单轮 200,050 字符：轮边界候选只剩 c0（全保留，必超预算）
    const result = core.ratioToCut(messages, 0, 0.3);
    assert.equal(result.unmet, false);
    assert.ok(result.cutIndex > 0 && result.cutIndex < messages.length, 'cut must fall inside the round');
    const readout = core.computeReadout(messages, 0, result.cutIndex);
    assert.ok(readout.keptPercent <= 0.3 + 1e-9);
  });

  it('reports unmet when even full trim cannot reach the ratio', () => {
    const core = loadCore();
    // 纯文本会话：对话文本全保留，折叠不省体积
    const messages = [
      msg('user', { charCount: 100, contentCharCount: 100 }),
      msg('assistant', { charCount: 100, contentCharCount: 100 }),
    ];
    const result = core.ratioToCut(messages, 0, 0.3);
    assert.equal(result.unmet, true);
    // 帕累托链上 kept 全并列（切了不省），保留最靠前切点：不误指全精简
    assert.equal(result.cutIndex, 0);
  });

  it('keeps the cut marker moving up monotonically as the ratio grows', () => {
    const core = loadCore();
    // 轮 1 = 大文本 + 大工具对 + 文本 + 微型工具对（折叠注记 57 反超原样 10）：
    // 轮 2 头（cut 6）kept = 2214 > 轮 1 内锚点（cut 3）kept = 2167——
    // 切到轮 2 头反而更长，是「切了不省」的坏切点。未过滤时比例跨过
    // 2214/5810 的瞬间，轮边界优先会把切点从 3 拉到 6（视觉下移）。
    const messages = [
      msg('user', { charCount: 1000, contentCharCount: 1000 }),
      ...toolPair('t1', 'a.js', 200, 3500),
      msg('assistant', { charCount: 500, contentCharCount: 500 }),
      ...toolPair('t2', 'z.js', 5, 5),
      msg('user', { charCount: 500, contentCharCount: 500 }),
      msg('assistant', { charCount: 100, contentCharCount: 100 }),
    ];
    assert.ok(
      core.keptCharCount(messages, 0, 6) > core.keptCharCount(messages, 0, 3),
      'fixture premise: the round-2 head is a dominated (cut-more-save-less) point',
    );
    let prev = Infinity;
    for (let pct = 5; pct <= 95; pct += 1) {
      const { cutIndex } = core.ratioToCut(messages, 0, pct / 100);
      assert.ok(cutIndex <= prev, `ratio ${pct}%: cut ${cutIndex} moved down from ${prev}`);
      prev = cutIndex;
    }
    // 跨界点：预算刚过坏轮头 kept（2214/5810 ≈ 38.1%）时切点仍钉在 3
    const at38 = core.ratioToCut(messages, 0, 2214 / 5810);
    assert.equal(at38.cutIndex, 3);
  });

  it('round-trips: cutToRatio(ratioToCut(r)) never exceeds r', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 100, contentCharCount: 100 }),
      ...toolPair('t1', 'a.js', 800, 2200),
      msg('user', { charCount: 120, contentCharCount: 120 }),
      ...toolPair('t2', 'b.js', 600, 1400),
      msg('user', { charCount: 80, contentCharCount: 80 }),
      msg('assistant', { charCount: 60, contentCharCount: 60 }),
    ];
    for (const ratio of [0.05, 0.15, 0.3, 0.5, 0.75, 0.95]) {
      const { cutIndex, unmet } = core.ratioToCut(messages, 40, ratio);
      const actual = core.cutToRatio(messages, 40, cutIndex);
      assert.ok(unmet || actual <= ratio + 1e-9, `ratio ${ratio}: actual ${actual} exceeds budget`);
    }
  });
  it('never lands the cut where the keep zone holds no dialogue (tail system injection)', () => {
    const core = loadCore();
    // 打断/任务提醒注入的形态：末轮文本与工具结果之后跟一条 system 注入
    // 消息。其后的安全切点保留区不含任何 user/assistant——提交后末轮对话
    // 全被折叠（实测事故：handoff preservedMsgRanges=[[277,277]] 仅保留
    // 任务状态提醒一条）。kept% 几乎全是折叠残留底量，读数「保留 X%」
    // 掩盖了保留区为空的事实。
    const messages = [
      msg('user', { charCount: 100, contentCharCount: 100 }),
      ...toolPair('t1', 'a.js', 800, 2000),
      msg('user', { charCount: 100, contentCharCount: 100 }),
      msg('assistant', { charCount: 500, contentCharCount: 40, toolCalls: [{ id: 't2', name: 'edit', summary: 'edit(x.md)' }] }),
      msg('tool', { charCount: 178, toolCallId: 't2' }),
      msg('system', { charCount: 60, contentCharCount: 60 }),
    ];
    for (const ratio of [0.09, 0.2]) {
      const { cutIndex } = core.ratioToCut(messages, 0, ratio);
      assert.ok(
        messages.slice(cutIndex).some((m) => m.role === 'user' || m.role === 'assistant'),
        `ratio ${ratio}: keep zone [${cutIndex}, ${messages.length}) holds no dialogue message`,
      );
    }
  });

  it('unmet fallback keeps a dialogue-bearing minimal zone instead of trimming everything', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 100, contentCharCount: 100 }),
      ...toolPair('t1', 'a.js', 800, 2000),
      msg('user', { charCount: 100, contentCharCount: 100 }),
      msg('assistant', { charCount: 40, contentCharCount: 40 }),
      msg('system', { charCount: 60, contentCharCount: 60 }),
    ];
    // 预算低于一切有效切点的 kept（全精简残留 310 仍 > 5%×3548）
    const { cutIndex, unmet } = core.ratioToCut(messages, 0, 0.05);
    assert.equal(unmet, true);
    assert.ok(
      messages.slice(cutIndex).some((m) => m.role === 'user' || m.role === 'assistant'),
      `unmet fallback cut ${cutIndex} leaves no dialogue in the keep zone`,
    );
  });

  it('exposes keepZoneHasDialogue for the trim page submit guard', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 10, contentCharCount: 10 }),
      msg('assistant', { charCount: 10, contentCharCount: 10 }),
      msg('tool', { charCount: 10 }),
      msg('system', { charCount: 10 }),
    ];
    assert.equal(typeof core.keepZoneHasDialogue, 'function');
    assert.equal(core.keepZoneHasDialogue(messages, 0), true);   // 含 user/assistant
    assert.equal(core.keepZoneHasDialogue(messages, 1), true);   // 含 assistant
    assert.equal(core.keepZoneHasDialogue(messages, 2), false);  // 仅 tool/system
    assert.equal(core.keepZoneHasDialogue(messages, 3), false);  // 仅 system
    assert.equal(core.keepZoneHasDialogue(messages, 4), false);  // 空保留区
    // cutIndex 越界按 clamp 处理（与 keptCharCount 同口径）
    assert.equal(core.keepZoneHasDialogue(messages, 99), false);
    assert.equal(core.keepZoneHasDialogue(messages, -1), true);
  });
});

describe('TrimRatioCore.computeReadout', () => {
  it('reports kept/released percent and message counts for a cut', () => {
    const core = loadCore();
    const messages = [
      msg('user', { charCount: 100, contentCharCount: 100 }),
      ...toolPair('t1', 'a.js', 1000, 2000),
      msg('user', { charCount: 200, contentCharCount: 200 }),
      msg('assistant', { charCount: 200, contentCharCount: 200 }),
    ];
    const readout = core.computeReadout(messages, 100, 3);
    // total = 100(preamble) + 3500 = 3600；kept = 100 + (100 + note) + 400
    assert.equal(readout.totalCharCount, 3600);
    assert.equal(readout.keptMessageCount, 2);
    assert.equal(readout.foldedMessageCount, 3);
    const expectedKept = 100 + 100 + (NOTE_PREFIX + 'read(a.js)').length + 400;
    assert.equal(readout.keptCharCount, expectedKept);
    assert.ok(Math.abs(readout.keptPercent - expectedKept / 3600) < 1e-9);
    assert.ok(Math.abs(readout.releasedPercent - (1 - expectedKept / 3600)) < 1e-9);
  });
});
