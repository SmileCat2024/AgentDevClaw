import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeFormat, getTimeOfDayLabel } from '../public/src/modules/time-format.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

// Local-date construction keeps these calendar expectations timezone-independent.
const fixed = new Date(2026, 10, 17, 15, 30).getTime();
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [fixed])); }
}
const at = (day, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

test('elapsed minutes and local calendar groups retain distinct boundaries and live language', () => {
  let language = 'zh';
  const api = createTimeFormat(() => language, Clock);
  assert.equal(api.formatRelativeTime(at(17, 15, 30)), '刚刚');
  assert.equal(api.formatRelativeTime(at(17, 15, 29)), '1分钟前');
  assert.equal(api.formatRelativeTime(at(17, 14, 31)), '59分钟前');
  assert.equal(api.formatRelativeTime(at(17, 14, 30)), '今天下午2点');
  assert.equal(api.getSessionRecencyClass(at(17, 14, 31)), 'just-now');
  assert.equal(api.getSessionRecencyClass(at(17, 14, 30)), 'today');
  for (const [day, label, css, short] of [
    [17, '今天', 'today', '上午9点'], [16, '昨天', 'yesterday', '昨天上午'],
    [15, '前天', 'day-before', '前天上午'], [14, '本周', 'this-week', '周六上午'],
    [10, '更早', 'older', ''],
  ]) {
    assert.equal(api.getTimeGroupLabel(at(day)), label);
    assert.equal(api.getSessionRecencyClass(at(day)), css);
    assert.equal(api.getSessionShortTime(at(day)), short);
  }
  assert.equal(api.formatRelativeTime(at(16)), '昨天上午9点');
  assert.equal(api.formatRelativeTime(at(15)), '前天上午9点');
  assert.equal(api.formatRelativeTime(at(14)), '星期六 上午9点');
  assert.equal(api.formatRelativeTime(at(10)), '11月10日');
  language = 'en';
  assert.equal(api.formatRelativeTime(at(17, 15, 29)), '1m ago');
  assert.equal(api.getTimeGroupLabel(at(16)), 'Yesterday');
  assert.equal(api.getSessionShortTime(at(16)), 'Yest AM');
});

test('cross-midnight labels use elapsed minutes before switching to local calendar dates', () => {
  class MidnightClock extends Date {
    constructor(...args) { super(...(args.length ? args : [new Date(2026, 10, 17, 0, 30).getTime()])); }
  }
  const api = createTimeFormat(() => 'en', MidnightClock);
  assert.equal(api.formatRelativeTime(at(16, 23, 45)), '45m ago');
  assert.equal(api.getTimeGroupLabel(at(16, 23, 45)), 'Yesterday');
  assert.equal(api.getSessionRecencyClass(at(16, 23, 45)), 'just-now');
  assert.equal(api.getSessionShortTime(at(16, 23, 30)), 'Yest PM');
  assert.equal(api.formatRelativeTime(new Date(2025, 0, 2).toISOString()), 'Jan 2, 2025');
});

test('real session rows retain their time indicator and escape content after the ESM host takes over', async () => {
  const ctx = createFrontendSandbox({
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    t: (key) => key,
    renderSessionResumeBadge: () => '',
    renderSessionTodoBadge: () => '',
    renderSessionTitleAiButton: () => '',
    renderSessionTokenBar: () => '',
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.currentLanguage = 'zh';
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/session-list-render.js');
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    await loadModuleOnce('public/src/modules/time-format-host.js', { installGlobals: false });
    const session = { id: 'session', title: '<unsafe>', updatedAt: new Date().toISOString(), messageCount: 2 };
    const zh = ctx.renderPhSessionItemHtml({ id: 'host' }, session);
    assert.match(zh, /session-time-indicator just-now/);
    assert.match(zh, /session-time-label">刚刚<\/span>/);
    assert.match(zh, /&lt;unsafe&gt;/);
    assert.doesNotMatch(zh, /<unsafe>/);
    ctx.currentLanguage = 'en';
    const en = ctx.renderPhSessionItemHtml({ id: 'host' }, session);
    assert.match(en, /session-time-label">now<\/span>/);
    assert.match(en, /2 messages/);
    assert.equal(ctx.formatWorkspaceDate('bad'), 'bad');
    assert.equal(ctx.formatRelativeTime('bad'), '');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('empty and invalid dates retain each public formatter fallback', () => {
  const api = createTimeFormat(() => 'zh', Clock);
  assert.equal(api.formatWorkspaceDate(null), '-');
  assert.equal(api.formatWorkspaceDate('bad'), 'bad');
  for (const value of ['', 'bad', null]) {
    assert.equal(api.formatRelativeTime(value), '');
    assert.equal(api.getTimeGroupLabel(value), '');
    assert.equal(api.getSessionShortTime(value), '');
    assert.equal(api.getSessionRecencyClass(value), 'older');
  }
  assert.equal(getTimeOfDayLabel(5, true), '凌晨');
  assert.equal(getTimeOfDayLabel(6, true), '上午');
  assert.equal(getTimeOfDayLabel(12, true), '中午');
  assert.equal(getTimeOfDayLabel(14, true), '下午');
  assert.equal(getTimeOfDayLabel(18, true), '晚上');
});
