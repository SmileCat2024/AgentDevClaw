/**
 * memo 提醒子页面的时间语义。
 *
 * 锁三条契约：相对时间徽标（过期/今天/明天/周内/远期/跨年/无效 fire_at）、
 * 时间分组边界（日界两侧、fired、invalid）、英文口径。时刻全部经 nowMs
 * 注入并用宿主本地时间构造，任意时区下确定；Intl 输出只锚定前缀
 * （分隔符随 locale 漂移），跨度断言用精确值。
 *
 * 模块形态：public/src/plugins/memo/reminders.js 是 ES 模块插件，
 * 逻辑经 mount(host) 注入宿主能力后调用，见 helpers/memo-plugin-loader.js。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMemoModule } from './helpers/memo-plugin-loader.js';

async function harness(language = 'zh') {
  const { api, cleanup } = await loadMemoModule('reminders', { language });
  return { api, cleanup };
}

// 2026-10-18 是周日；now 取宿主本地 10:00，日界判断与宿主时区无关地确定
const NOW = new Date(2026, 9, 18, 10, 0, 0).getTime();
const iso = (date) => date.toISOString();
const badgeText = (api, fireAt, now = NOW) => api.fmtRelativeBadge({ fire_at: fireAt }, now).text;
const badgeOverdue = (api, fireAt, now = NOW) => api.fmtRelativeBadge({ fire_at: fireAt }, now).overdue;
const group = (api, entry, now = NOW) => api.groupOf(entry, now);

test('fmtRelativeBadge zh: overdue spans take the largest unit, floored at one minute', async () => {
  const { api, cleanup } = await harness();
  try {
    assert.equal(badgeText(api, iso(new Date(NOW - 30 * 60000))), '已过期 30 分钟');
    assert.equal(badgeOverdue(api, iso(new Date(NOW - 30 * 60000))), true);
    assert.equal(badgeText(api, iso(new Date(NOW - 2 * 3600000))), '已过期 2 小时');
    assert.equal(badgeText(api, iso(new Date(NOW - 3 * 86400000))), '已过期 3 天');
    assert.equal(badgeText(api, iso(new Date(NOW - 5 * 1000))), '已过期 1 分钟');
  } finally { cleanup(); }
});

test('fmtRelativeBadge zh: today uses human spans, beyond today degrades to calendar labels', async () => {
  const { api, cleanup } = await harness();
  try {
    assert.equal(badgeText(api, iso(new Date(NOW + 40 * 60000))), '40 分钟后');
    assert.equal(badgeOverdue(api, iso(new Date(NOW + 40 * 60000))), false);
    assert.equal(badgeText(api, iso(new Date(2026, 9, 18, 15, 0))), '5 小时后');
    assert.match(badgeText(api, iso(new Date(2026, 9, 19, 9, 0))), /^明天 /);
    assert.match(badgeText(api, iso(new Date(2026, 9, 21, 9, 0))), /^周三 /); // 7 天内 → 周X
    assert.match(badgeText(api, iso(new Date(2026, 9, 26, 9, 0))), /^10/);    // 超过 7 天 → 日历日期
    assert.match(badgeText(api, iso(new Date(2027, 0, 5, 9, 0))), /^2027/);   // 跨年带年份
  } finally { cleanup(); }
});

test('fmtRelativeBadge: unparseable fire_at yields an empty badge', async () => {
  const { api, cleanup } = await harness();
  try {
    assert.equal(badgeText(api, 'not-a-date'), '');
    assert.equal(badgeOverdue(api, 'not-a-date'), false);
  } finally { cleanup(); }
});

test('fmtRelativeBadge en', async () => {
  const { api, cleanup } = await harness('en');
  try {
    assert.equal(badgeText(api, iso(new Date(NOW + 40 * 60000))), 'in 40 min');
    assert.equal(badgeText(api, iso(new Date(NOW - 2 * 3600000))), '2 h overdue');
    assert.match(badgeText(api, iso(new Date(2026, 9, 19, 9, 0))), /^Tomorrow/);
  } finally { cleanup(); }
});

test('groupOf: calendar-day boundaries via injected now', async () => {
  const { api, cleanup } = await harness();
  try {
    assert.equal(group(api, { status: 'fired', fire_at: iso(new Date(NOW)) }), 'done');
    assert.equal(group(api, { fire_at: 'not-a-date' }), 'later');
    assert.equal(group(api, { fire_at: iso(new Date(NOW - 1)) }), 'overdue');
    assert.equal(group(api, { fire_at: iso(new Date(2026, 9, 18, 23, 59)) }), 'today');
    assert.equal(group(api, { fire_at: iso(new Date(2026, 9, 19, 0, 1)) }), 'tomorrow');
    assert.equal(group(api, { fire_at: iso(new Date(2026, 9, 25, 9, 0)) }), 'later');
  } finally { cleanup(); }
});
