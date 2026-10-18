/**
 * Tests for memo reminder time semantics (public/src/modules/memo-reminders-ui.js).
 *
 * 三页改版的时间语义锁：相对时间徽标（过期分钟/小时/天、今天、明天、周内、
 * 远期、跨年、无效 fire_at）与分组边界（日界两侧、fired、invalid）。
 * 时刻全部经 nowMs 注入、用宿主本地时间构造，任意时区下均确定；
 * 涉及 Intl 输出的断言只锚定前缀（分隔符随 locale 漂移），跨度断言用精确值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function harness(language = 'zh') {
  const ctx = createFrontendSandbox({ currentLanguage: language });
  ctx.loadSource('public/src/modules/memo-reminders-ui.js');
  return ctx;
}

// 2026-10-18 是周日；now 取宿主本地 10:00，日界判断与宿主时区无关地确定
const NOW = new Date(2026, 9, 18, 10, 0, 0).getTime();
const iso = (date) => date.toISOString();
const badge = (ctx, fireAt, now = NOW) =>
  ctx.run(`window.MemoRemindersUI.fmtRelativeBadge({ fire_at: ${JSON.stringify(fireAt)} }, ${now})`);
const group = (ctx, entry, now = NOW) =>
  ctx.run(`window.MemoRemindersUI.groupOf(${JSON.stringify(entry)}, ${now})`);

// vm 跨 realm 对象不能 deepEqual（原型引用不等），断言逐字段进行
const badgeText = (ctx, fireAt, now = NOW) =>
  ctx.run(`window.MemoRemindersUI.fmtRelativeBadge({ fire_at: ${JSON.stringify(fireAt)} }, ${now}).text`);
const badgeOverdue = (ctx, fireAt, now = NOW) =>
  ctx.run(`window.MemoRemindersUI.fmtRelativeBadge({ fire_at: ${JSON.stringify(fireAt)} }, ${now}).overdue`);

test('fmtRelativeBadge zh: overdue spans take the largest unit, floored at one minute', () => {
  const ctx = harness();
  assert.equal(badgeText(ctx, iso(new Date(NOW - 30 * 60000))), '已过期 30 分钟');
  assert.equal(badgeOverdue(ctx, iso(new Date(NOW - 30 * 60000))), true);
  assert.equal(badgeText(ctx, iso(new Date(NOW - 2 * 3600000))), '已过期 2 小时');
  assert.equal(badgeText(ctx, iso(new Date(NOW - 3 * 86400000))), '已过期 3 天');
  assert.equal(badgeText(ctx, iso(new Date(NOW - 5 * 1000))), '已过期 1 分钟');
});

test('fmtRelativeBadge zh: today uses human spans, beyond today degrades to calendar labels', () => {
  const ctx = harness();
  assert.equal(badgeText(ctx, iso(new Date(NOW + 40 * 60000))), '40 分钟后');
  assert.equal(badgeOverdue(ctx, iso(new Date(NOW + 40 * 60000))), false);
  assert.equal(badgeText(ctx, iso(new Date(2026, 9, 18, 15, 0))), '5 小时后');
  assert.match(badgeText(ctx, iso(new Date(2026, 9, 19, 9, 0))), /^明天 /);
  assert.match(badgeText(ctx, iso(new Date(2026, 9, 21, 9, 0))), /^周三 /); // 7 天内 → 周X
  assert.match(badgeText(ctx, iso(new Date(2026, 9, 26, 9, 0))), /^10/);    // 超过 7 天 → 日历日期
  assert.match(badgeText(ctx, iso(new Date(2027, 0, 5, 9, 0))), /^2027/);   // 跨年带年份
});

test('fmtRelativeBadge: unparseable fire_at yields an empty badge', () => {
  const ctx = harness();
  assert.equal(badgeText(ctx, 'not-a-date'), '');
  assert.equal(badgeOverdue(ctx, 'not-a-date'), false);
});

test('fmtRelativeBadge en', () => {
  const ctx = harness('en');
  assert.equal(badgeText(ctx, iso(new Date(NOW + 40 * 60000))), 'in 40 min');
  assert.equal(badgeText(ctx, iso(new Date(NOW - 2 * 3600000))), '2 h overdue');
  assert.match(badgeText(ctx, iso(new Date(2026, 9, 19, 9, 0))), /^Tomorrow/);
});

test('groupOf: calendar-day boundaries via injected now', () => {
  const ctx = harness();
  assert.equal(group(ctx, { status: 'fired', fire_at: iso(new Date(NOW)) }), 'done');
  assert.equal(group(ctx, { fire_at: 'not-a-date' }), 'later');
  assert.equal(group(ctx, { fire_at: iso(new Date(NOW - 1)) }), 'overdue');
  assert.equal(group(ctx, { fire_at: iso(new Date(2026, 9, 18, 23, 59)) }), 'today');
  assert.equal(group(ctx, { fire_at: iso(new Date(2026, 9, 19, 0, 1)) }), 'tomorrow');
  assert.equal(group(ctx, { fire_at: iso(new Date(2026, 9, 25, 9, 0)) }), 'later');
});
