/**
 * Tests for public/src/modules/message-timeline.js
 *
 * 用户消息时间分隔线（会话时间线）的纯函数面：
 *   - attachMessagesTimestamps（/messages 响应 timestamps 平行表合并）
 *   - resolveUserTimeSeparator（首条 / 间隔阈值 / 无时间锚降级）
 *   - formatChatTimestamp（时段前缀 + 时分 / 跨天 / 非当年）
 *   - renderTimeSeparatorHtml / prependTimeSeparatorHtml（渲染包装）
 *
 * 装载路线（P2）：message-timeline 与 markdown-utils 已迁 ESM，用例经
 * withP2EsmCase 的 `c.load(...)` 真实 import（每个用例一张独立模块图）。
 * 唯一 classic 相依赖是 markdown-bootstrap 在 window 上注册的 escapeHtml，
 * 这里按同一语义注入 window.escapeHtml（生产由 classic 脚本先于 deferred 模块
 * 注册，ESM 侧 `escapeHtml` 具名导出就是该 window 值的快照）。断言直接调用
 * 模块命名导出——ESM 的真实调用路径是导入值，不是 window 包装。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const TIMELINE = 'public/src/modules/message-timeline.js';

/** classic 相 escapeHtml（生产：markdown-bootstrap.js 注册的 KernelState 桥键）。 */
function escapeHtmlStub(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * 每个用例一张独立模块图：classic 相注册 escapeHtml（markdown-bootstrap）与
 * action-dispatcher 的分发表（index.html 先于一切模块装载），再真实 import 模块。
 */
async function withTimeline(fn) {
  const ClawFW = { actions: { registerMany() {} } };
  return withP2EsmCase({ globals: { escapeHtml: escapeHtmlStub, ClawFW } }, async (c) => {
    const timeline = await c.load(TIMELINE);
    return fn(timeline, c);
  });
}

describe('attachMessagesTimestamps', () => {
  it('merges the parallel table into message copies (_ts)', async () => {
    await withTimeline((tl) => {
      const out = tl.attachMessagesTimestamps(
        [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], [111, null]);
      assert.equal(out[0]._ts, 111);
      // null（无锚）不挂字段：消费方按 typeof 判断降级
      assert.equal(out[1]._ts, undefined);
      assert.equal('_ts' in out[0], true);
      assert.equal('_ts' in out[1], false);
    });
  });

  it('passes messages through untouched when the table is missing or mismatched', async () => {
    await withTimeline((tl) => {
      const msgs = [{ role: 'user', content: 'a' }];
      // 表缺失 / 长度失配都原样返回同一数组引用（调用方据此跳过拷贝）
      assert.equal(tl.attachMessagesTimestamps(msgs, undefined), msgs);
      assert.equal(tl.attachMessagesTimestamps(msgs, [1, 2]), msgs);
    });
  });

  it('keeps object identity when _ts already matches', async () => {
    await withTimeline((tl) => {
      const m = [{ role: 'user', content: 'a', _ts: 111 }];
      assert.equal(tl.attachMessagesTimestamps(m, [111])[0], m[0]);
    });
  });
});

/**
 * 用户消息分隔线的真实边界：`resolveUserTimeSeparator` 是模块私有判定，只有
 * `prependTimeSeparatorHtml` 是生产入口（chat-renderer 渲染行时调用）。这里经
 * 该入口取值——分隔线前缀 = 应显示的时间戳渲染结果，无分隔线 = 判定为 null。
 *
 * 可接受边界（审核 #4）：该公开入口的输出同时受私有判定与时间格式化/包装
 * 影响，无法单独区分「判定阈值写错」与「包装层写错」这两类内部 bug；断言按
 * `renderTimeSeparatorHtml(期望 ts)` 做整串比对，任一环写错都会红，但报错
 * 不指向具体层。补上分层要求新增私有导出，故有意保留在公开边界上。
 */
const rowHtml = '<row/>';
function separatorHtml(tl, messages, index) {
  const html = tl.prependTimeSeparatorHtml(messages, index, rowHtml);
  if (html === rowHtml) return null;
  assert.ok(html.endsWith(rowHtml), 'passes the row through after the separator');
  return html.slice(0, -rowHtml.length);
}

describe('user time separator（经 prependTimeSeparatorHtml 真实入口）', () => {
  const GAP = 5 * 60 * 1000;
  const mk = (role, _ts) => ({ role, content: 'x', ...(_ts !== undefined ? { _ts } : {}) });

  it('shows the first user message with a stamp', async () => {
    await withTimeline((tl) => {
      const msgs = [mk('assistant'), mk('user', 1000), mk('user', 2000)];
      assert.equal(separatorHtml(tl, msgs, 1), tl.renderTimeSeparatorHtml(1000));
    });
  });

  it('shows only when the gap to the previous stamped user message exceeds the threshold', async () => {
    await withTimeline((tl) => {
      // 间隔相对"前一条用户消息"计算：第二条差 1ms、第三条差 GAP+1ms
      const near = 1000 + GAP - 1;
      const far = near + GAP + 1;
      const msgs = [mk('user', 1000), mk('user', near), mk('user', far)];
      assert.equal(separatorHtml(tl, msgs, 1), null);
      assert.equal(separatorHtml(tl, msgs, 2), tl.renderTimeSeparatorHtml(far));
    });
  });

  it('degrades silently when the previous user message has no stamp', async () => {
    await withTimeline((tl) => {
      const msgs = [mk('user'), mk('user', 1000)];
      assert.equal(separatorHtml(tl, msgs, 1), null);
    });
  });

  it('returns null for non-user or unstamped messages', async () => {
    await withTimeline((tl) => {
      const msgs = [mk('assistant', 1000), mk('user')];
      assert.equal(separatorHtml(tl, msgs, 0), null);
      assert.equal(separatorHtml(tl, msgs, 1), null);
    });
  });
});

describe('formatChatTimestamp', () => {
  it('labels the day period with a 12-hour clock (afternoon/evening) and 24h for early morning', async () => {
    await withTimeline((tl) => {
      const now = new Date();
      const at = (hh, mm) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime();

      assert.equal(tl.formatChatTimestamp(at(15, 24)), `下午 3:24`);
      assert.equal(tl.formatChatTimestamp(at(23, 0)), `晚上 11:00`);
      assert.equal(tl.formatChatTimestamp(at(9, 5)), `上午 9:05`);
      assert.equal(tl.formatChatTimestamp(at(12, 30)), `下午 12:30`);
      assert.equal(tl.formatChatTimestamp(at(0, 5)), `凌晨 0:05`);
      assert.equal(tl.formatChatTimestamp(at(3, 24)), `凌晨 3:24`);
    });
  });

  it('adds the date when not today, and the year when not this year', async () => {
    await withTimeline((tl) => {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 23);
      assert.equal(tl.formatChatTimestamp(yesterday.getTime()), `${yesterday.getMonth() + 1}月${yesterday.getDate()}日 上午 10:23`);

      const otherYear = new Date(now.getFullYear() - 1, 9, 14, 20, 1);
      assert.equal(tl.formatChatTimestamp(otherYear.getTime()), `${otherYear.getFullYear()}年10月14日 晚上 8:01`);
    });
  });
});

describe('render separator html', () => {
  it('renders a separator row with escaped text', async () => {
    await withTimeline((tl) => {
      const now = new Date();
      const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 24).getTime();
      const html = tl.renderTimeSeparatorHtml(ts);
      assert.match(html, /^<div class="time-separator"><span>下午 3:24<\/span><\/div>$/);
    });
  });

  it('appends a sanitized extra class when given', async () => {
    await withTimeline((tl) => {
      const now = new Date();
      const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 24).getTime();
      const html = tl.renderTimeSeparatorHtml(ts, 'time-separator--echo');
      assert.match(html, /^<div class="time-separator time-separator--echo"><span>下午 3:24<\/span><\/div>$/);
      // 非法字符被剥除，不进 class 属性
      const dirty = tl.renderTimeSeparatorHtml(ts, 'a"b c');
      assert.ok(dirty.startsWith('<div class="time-separator abc">'));
    });
  });

  it('prepends to user rows only and passes others through', async () => {
    await withTimeline((tl) => {
      const msgs = [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'q', _ts: 1 }];
      const passthrough = tl.prependTimeSeparatorHtml(msgs, 0, '<row/>');
      assert.equal(passthrough, '<row/>');
      const withSep = tl.prependTimeSeparatorHtml(msgs, 1, '<row/>');
      assert.ok(withSep.startsWith('<div class="time-separator">'));
      assert.ok(withSep.endsWith('<row/>'));
    });
  });
});

describe('resolveEchoTimeSeparator（乐观回显分隔线预判）', () => {
  const GAP = 5 * 60 * 1000;
  const SLACK = 30 * 1000;
  const mk = (role, _ts) => ({ role, content: 'x', ...(_ts !== undefined ? { _ts } : {}) });

  it('shows for the first user message (no prior user row)', async () => {
    await withTimeline((tl) => {
      assert.equal(tl.resolveEchoTimeSeparator([mk('assistant', 1)], 9000), 9000);
      assert.equal(tl.resolveEchoTimeSeparator([], 9000), 9000);
    });
  });

  it('shows when the gap exceeds GAP + slack (local clock approximation)', async () => {
    await withTimeline((tl) => {
      const prev = 1000;
      const now = prev + GAP + SLACK + 1;
      assert.equal(tl.resolveEchoTimeSeparator([mk('user', prev)], now), now);
    });
  });

  it('stays conservative inside the slack band (may lag, never flashes)', async () => {
    await withTimeline((tl) => {
      const prev = 1000;
      // 间隔已过 GAP 但未过 GAP + slack：预渲染会被真实判定撤回的窗口，不出线
      assert.equal(tl.resolveEchoTimeSeparator([mk('user', prev)], prev + GAP + 1), null);
      assert.equal(tl.resolveEchoTimeSeparator([mk('user', prev)], prev + GAP + SLACK), null);
      assert.equal(tl.resolveEchoTimeSeparator([mk('user', prev)], prev + GAP - 1), null);
    });
  });

  it('degrades silently when the previous user message has no stamp', async () => {
    await withTimeline((tl) => {
      assert.equal(tl.resolveEchoTimeSeparator([mk('user')], 5000), null);
    });
  });

  it('looks past non-user rows for the previous stamped user anchor', async () => {
    await withTimeline((tl) => {
      // 前一条用户消息之后隔了 assistant / tool 行：锚仍是那条用户消息
      const msgs = [mk('user', 1000), mk('assistant'), mk('tool')];
      assert.equal(tl.resolveEchoTimeSeparator(msgs, 1000 + GAP + SLACK + 1), 1000 + GAP + SLACK + 1);
      // 最近用户锚隔着非用户行且无 _ts（旧数据）→ 同样不出线
      const unstamped = [mk('user'), mk('assistant')];
      assert.equal(tl.resolveEchoTimeSeparator(unstamped, 9000), null);
    });
  });

  it('rejects a non-finite now', async () => {
    await withTimeline((tl) => {
      assert.equal(tl.resolveEchoTimeSeparator([], NaN), null);
      assert.equal(tl.resolveEchoTimeSeparator([], 'x'), null);
    });
  });
});
