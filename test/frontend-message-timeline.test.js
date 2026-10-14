/**
 * Tests for public/src/modules/message-timeline.js
 *
 * 用户消息时间分隔线（会话时间线）的纯函数面：
 *   - attachMessagesTimestamps（/messages 响应 timestamps 平行表合并）
 *   - resolveUserTimeSeparator（首条 / 间隔阈值 / 无时间锚降级）
 *   - formatChatTimestamp（时段前缀 + 时分 / 跨天 / 非当年）
 *   - renderTimeSeparatorHtml / prependTimeSeparatorHtml（渲染包装）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadTimeline() {
  const ctx = createFrontendSandbox({
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]),
  });
  ctx.loadSource('public/src/modules/message-timeline.js');
  return ctx;
}

/** ctx.run 只接受代码表达式：参数 JSON 内联求值（消息对象均为 JSON 安全）。 */
function call(ctx, fn, ...args) {
  return ctx.run(`${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
}

describe('attachMessagesTimestamps', () => {
  it('merges the parallel table into message copies (_ts)', () => {
    const ctx = loadTimeline();
    const out = call(ctx, 'attachMessagesTimestamps',
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], [111, null]);
    assert.equal(out[0]._ts, 111);
    // null（无锚）不挂字段：消费方按 typeof 判断降级
    assert.equal(out[1]._ts, undefined);
    assert.equal('_ts' in out[0], true);
    assert.equal('_ts' in out[1], false);
  });

  it('passes messages through untouched when the table is missing or mismatched', () => {
    const ctx = loadTimeline();
    const msgsJson = JSON.stringify([{ role: 'user', content: 'a' }]);
    const missingSame = ctx.run(`(function(){ var m = ${msgsJson}; return attachMessagesTimestamps(m, undefined) === m; })()`);
    const mismatchSame = ctx.run(`(function(){ var m = ${msgsJson}; return attachMessagesTimestamps(m, [1, 2]) === m; })()`);
    assert.equal(missingSame, true);
    assert.equal(mismatchSame, true);
  });

  it('keeps object identity when _ts already matches', () => {
    const ctx = loadTimeline();
    const same = ctx.run('(function(){ var m = [{ role: \'user\', content: \'a\', _ts: 111 }]; return attachMessagesTimestamps(m, [111])[0] === m[0]; })()');
    assert.equal(same, true);
  });
});

describe('resolveUserTimeSeparator', () => {
  const GAP = 5 * 60 * 1000;
  const mk = (role, _ts) => ({ role, content: 'x', ...(_ts !== undefined ? { _ts } : {}) });

  it('shows the first user message with a stamp', () => {
    const ctx = loadTimeline();
    const msgs = [mk('assistant'), mk('user', 1000), mk('user', 2000)];
    assert.equal(call(ctx, 'resolveUserTimeSeparator', msgs, 1), 1000);
  });

  it('shows only when the gap to the previous stamped user message exceeds the threshold', () => {
    const ctx = loadTimeline();
    // 间隔相对"前一条用户消息"计算：第二条差 1ms、第三条差 GAP+1ms
    const near = 1000 + GAP - 1;
    const far = near + GAP + 1;
    const msgs = [mk('user', 1000), mk('user', near), mk('user', far)];
    assert.equal(call(ctx, 'resolveUserTimeSeparator', msgs, 1), null);
    assert.equal(call(ctx, 'resolveUserTimeSeparator', msgs, 2), far);
  });

  it('degrades silently when the previous user message has no stamp', () => {
    const ctx = loadTimeline();
    const msgs = [mk('user'), mk('user', 1000)];
    assert.equal(call(ctx, 'resolveUserTimeSeparator', msgs, 1), null);
  });

  it('returns null for non-user or unstamped messages', () => {
    const ctx = loadTimeline();
    const msgs = [mk('assistant', 1000), mk('user')];
    assert.equal(call(ctx, 'resolveUserTimeSeparator', msgs, 0), null);
    assert.equal(call(ctx, 'resolveUserTimeSeparator', msgs, 1), null);
  });
});

describe('formatChatTimestamp', () => {
  it('labels the day period with a 12-hour clock (afternoon/evening) and 24h for early morning', () => {
    const ctx = loadTimeline();
    const now = new Date();
    const at = (hh, mm) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime();

    assert.equal(call(ctx, 'formatChatTimestamp', at(15, 24)), `下午 3:24`);
    assert.equal(call(ctx, 'formatChatTimestamp', at(23, 0)), `晚上 11:00`);
    assert.equal(call(ctx, 'formatChatTimestamp', at(9, 5)), `上午 9:05`);
    assert.equal(call(ctx, 'formatChatTimestamp', at(12, 30)), `下午 12:30`);
    assert.equal(call(ctx, 'formatChatTimestamp', at(0, 5)), `凌晨 0:05`);
    assert.equal(call(ctx, 'formatChatTimestamp', at(3, 24)), `凌晨 3:24`);
  });

  it('adds the date when not today, and the year when not this year', () => {
    const ctx = loadTimeline();
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 23);
    assert.equal(call(ctx, 'formatChatTimestamp', yesterday.getTime()), `${yesterday.getMonth() + 1}月${yesterday.getDate()}日 上午 10:23`);

    const otherYear = new Date(now.getFullYear() - 1, 9, 14, 20, 1);
    assert.equal(call(ctx, 'formatChatTimestamp', otherYear.getTime()), `${otherYear.getFullYear()}年10月14日 晚上 8:01`);
  });
});

describe('render separator html', () => {
  it('renders a separator row with escaped text', () => {
    const ctx = loadTimeline();
    const now = new Date();
    const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 24).getTime();
    const html = call(ctx, 'renderTimeSeparatorHtml', ts);
    assert.match(html, /^<div class="time-separator"><span>下午 3:24<\/span><\/div>$/);
  });

  it('prepends to user rows only and passes others through', () => {
    const ctx = loadTimeline();
    const msgs = [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'q', _ts: 1 }];
    const passthrough = call(ctx, 'prependTimeSeparatorHtml', msgs, 0, '<row/>');
    assert.equal(passthrough, '<row/>');
    const withSep = call(ctx, 'prependTimeSeparatorHtml', msgs, 1, '<row/>');
    assert.ok(withSep.startsWith('<div class="time-separator">'));
    assert.ok(withSep.endsWith('<row/>'));
  });
});
