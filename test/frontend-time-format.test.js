import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createTimeFormat, getTimeOfDayLabel } from '../public/src/modules/time-format.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareSidebarDomain } from './p2-classic-hosts.js';

/** 真实壳层 bootstrap（桥初值、宿主工厂与首屏同步面来源）。 */
const CLASSIC_STACK = [
  'public/src/modules/action-dispatcher.js',
  'public/src/modules/claw-host.js',
  'public/src/modules/right-panel-registry.js',
  'public/src/app-core.js',
  'public/src/modules/session-view-state.js',
  'public/src/app-ui.js',
  'public/src/app-main.js',
];

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
  // P2 真实图：session-list-render 已迁 ESM（静态 import 链），classic 侧只跑真实
  // 壳层 bootstrap 提供桥初值与宿主工厂；语言与时间格式都读同一 ESM owner。
  const agent = {
    id: 'programming-helper',
    workspace_sessions: { activeSessionId: 'session', sessions: [] },
    workspace_state: { openDirectory: '', phProjects: [] },
  };
  await withP2EsmCase({
    classic: (sandbox) => {
      sandbox.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      sandbox.marked = marked;
      sandbox.currentLanguage = 'zh';
      sandbox.phSearchQuery = '';
      sandbox.savedPhTabState = {};
      // app-main 首屏入口：本用例只驱动会话行渲染，不等认证后的 boot 链
      sandbox.run(`
        window.__clawAuthReady = new Promise(() => {});
        applyLanguage = () => {};
        applyTheme = () => {};
      `);
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      prepareSidebarDomain(sandbox);
      sandbox.allAgents = [agent];
      sandbox.getCurrentAgentRecord = () => agent;
      sandbox.renderCurrentMainView = () => {};
      sandbox.alert = () => {};
      sandbox.setTimeout = () => 0;
      sandbox.clearTimeout = () => {};
      sandbox.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
      sandbox.window.ClawFW = sandbox.window.ClawFW || {};
      sandbox.window.ClawFW._modelPresets = [];
    },
  }, async (c) => {
    // 远程连接域已迁 ESM（P4 T3）：真实 import 代替原 classic 标签位（生产顺序
    // 在 runtime-status 之前、sidebar-render 之前）。
    await c.load('public/src/modules/remote-connections.js');
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    const timeFormat = await c.load('public/src/modules/time-format-host.js');
    const list = await c.load('public/src/modules/session-list-render.js');

    i18n.setCurrentLanguage('zh');
    const session = { id: 'session', title: '<unsafe>', updatedAt: new Date().toISOString(), messageCount: 2 };
    const zh = list.renderPhSessionItemHtml({ id: 'host' }, session);
    assert.match(zh, /session-time-indicator just-now/);
    assert.match(zh, /session-time-label">刚刚<\/span>/);
    assert.match(zh, /&lt;unsafe&gt;/);
    assert.doesNotMatch(zh, /<unsafe>/);

    i18n.setCurrentLanguage('en');
    const en = list.renderPhSessionItemHtml({ id: 'host' }, session);
    assert.match(en, /session-time-label">now<\/span>/);
    assert.match(en, /2 messages/);
    assert.equal(timeFormat.formatWorkspaceDate('bad'), 'bad');
    assert.equal(timeFormat.formatRelativeTime('bad'), '');
  });
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
