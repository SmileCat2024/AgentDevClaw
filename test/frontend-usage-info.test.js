/* global window */
/**
 * Tests for public/src/modules/usage-info-overlay.js（ESM 真实 import 路线）
 *
 * Covers pure utility functions:
 *   - Date helpers (usageInfoLocalDateString, usageInfoParseLocalDate,
 *     usageInfoDateDaysAgo, usageInfoDateRange)
 *   - Number formatting (usageInfoNumber, usageInfoFullNumber, usageInfoPct)
 *   - Breakdown aggregation (usageInfoEmptyBreakdown, usageInfoAddBreakdown)
 *   - Event date extraction (usageInfoEventDate, usageInfoEventHour)
 *   - Labels (usageInfoLabel)
 *   - Defaults (usageInfoDefaults)
 *   - Range dates (usageInfoRangeDates)
 *   - Metric rendering (renderUsageMetric)
 *   - SVG path smoothing (usageInfoSmoothPath)
 *
 * 装载路线：test/helpers/esm-module-loader.js 的真实 import（迁移配方第三节）。
 * 断言从 sandbox 全局直调改为 import 后调用；window 桩面只覆盖模块导入链的真实
 * 依赖：vendor 的 marked（markdown-utils 求值期构造 renderer 用）与
 * action-dispatcher 的 registerMany 注册表。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { Marked } from 'marked';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const registeredActions = new Map();

const cleanupGlobals = installBrowserStubs({
  window: {
    // vendor 面：index.html 的 marked UMD 先于 module 标签，markdown-utils 求值期
    // 就要 `new marked.Renderer()`。
    marked: new Marked(),
    // action-dispatcher 注册表：模块尾部 registerMany
    ClawFW: {
      actions: {
        registerMany(map) {
          for (const [name, handler] of Object.entries(map)) registeredActions.set(name, handler);
        },
      },
    },
  },
});
after(() => {
  cleanupGlobals();
});

await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
// 语言状态由 i18n 域模块持有（usage-info 的 import 解析到同一份实例）
const i18n = await import('../public/src/modules/i18n-environment-state.js');
i18n.setCurrentLanguage('zh');
const usage = (await loadModuleOnce('public/src/modules/usage-info-overlay.js', { installGlobals: false })).module;

const {
  usageInfoLocalDateString, usageInfoParseLocalDate, usageInfoToday, usageInfoDateDaysAgo,
  usageInfoDefaults, usageInfoRangeDates, usageInfoNumber, usageInfoFullNumber, usageInfoPct,
  usageInfoLabel, renderUsageMetric, usageInfoDateRange, usageInfoEventDate, usageInfoEventHour,
  usageInfoEmptyBreakdown, usageInfoAddBreakdown, usageInfoSmoothPath,
} = usage;

// ── usageInfoLocalDateString ───────────────────────────────────────

describe('usage-info: usageInfoLocalDateString', () => {
  it('formats a Date correctly', () => {
    const result = usageInfoLocalDateString(new Date(2026, 0, 5)); // Jan 5, 2026
    assert.equal(result, '2026-01-05');
  });

  it('pads month and day', () => {
    const result = usageInfoLocalDateString(new Date(2026, 10, 15)); // Nov 15
    assert.equal(result, '2026-11-15');
  });

  it('returns empty for invalid date', () => {
    assert.equal(usageInfoLocalDateString(new Date("invalid")), '');
  });

  it('accepts timestamp number', () => {
    const result = usageInfoLocalDateString(new Date(2026, 5, 1).getTime());
    assert.equal(result, '2026-06-01');
  });
});

// ── usageInfoParseLocalDate ────────────────────────────────────────

describe('usage-info: usageInfoParseLocalDate', () => {
  it('parses YYYY-MM-DD format', () => {
    const result = usageInfoParseLocalDate("2026-06-15");
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 5); // June (0-indexed)
    assert.equal(result.getDate(), 15);
  });

  it('falls back to Date constructor for non-matching format', () => {
    const result = usageInfoParseLocalDate("2026/06/15");
    assert.ok(result instanceof Date);
  });

  it('returns epoch for null', () => {
    const result = usageInfoParseLocalDate(null);
    assert.equal(result.getTime(), 0);
  });
});

// ── usageInfoDateDaysAgo ───────────────────────────────────────────

describe('usage-info: usageInfoDateDaysAgo', () => {
  it('returns today for 0 days ago', () => {
    const today = usageInfoToday();
    const zeroDays = usageInfoDateDaysAgo(0);
    assert.equal(zeroDays, today);
  });

  it('returns yesterday for 1 day ago', () => {
    const today = usageInfoToday();
    const yesterday = usageInfoDateDaysAgo(1);
    // Parse both and check they differ by 1 day
    const todayDate = new Date(today);
    const yesterdayDate = new Date(yesterday);
    const diff = (todayDate - yesterdayDate) / (1000 * 60 * 60 * 24);
    assert.equal(diff, 1);
  });

  it('produces valid date string', () => {
    const result = usageInfoDateDaysAgo(7);
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── usageInfoNumber ────────────────────────────────────────────────

describe('usage-info: usageInfoNumber', () => {
  it('returns raw number for small values', () => {
    assert.equal(usageInfoNumber(42), '42');
    assert.equal(usageInfoNumber(999), '999');
  });

  it('formats thousands with K suffix', () => {
    assert.equal(usageInfoNumber(1000), '1.00K');
    assert.equal(usageInfoNumber(5500), '5.50K');
  });

  it('formats millions with M suffix', () => {
    assert.equal(usageInfoNumber(1000000), '1.00M');
    assert.equal(usageInfoNumber(2500000), '2.50M');
  });

  it('formats billions with B suffix', () => {
    assert.equal(usageInfoNumber(1000000000), '1.00B');
  });

  it('handles 0', () => {
    assert.equal(usageInfoNumber(0), '0');
  });

  it('handles non-finite values as 0', () => {
    assert.equal(usageInfoNumber(NaN), '0');
    assert.equal(usageInfoNumber(null), '0');
    assert.equal(usageInfoNumber("abc"), '0');
  });
});

// ── usageInfoFullNumber ────────────────────────────────────────────

describe('usage-info: usageInfoFullNumber', () => {
  it('formats with locale separators', () => {
    const result = usageInfoFullNumber(1234567);
    // toLocaleString produces locale-dependent output, but should contain digit groups
    assert.ok(result.includes('1') && result.includes('7'));
  });

  it('handles 0', () => {
    assert.equal(usageInfoFullNumber(0), '0');
  });

  it('handles non-finite as 0', () => {
    assert.equal(usageInfoFullNumber(NaN), '0');
  });
});

// ── usageInfoPct ───────────────────────────────────────────────────

describe('usage-info: usageInfoPct', () => {
  it('calculates percentage', () => {
    assert.equal(usageInfoPct(25, 100), 25);
    assert.equal(usageInfoPct(1, 4), 25);
  });

  it('rounds to integer', () => {
    assert.equal(usageInfoPct(1, 3), 33);
    assert.equal(usageInfoPct(2, 3), 67);
  });

  it('returns 0 when total is 0', () => {
    assert.equal(usageInfoPct(5, 0), 0);
  });

  it('handles part > total (caps at 100 via rounding)', () => {
    const result = usageInfoPct(150, 100);
    assert.equal(result, 150); // No cap — just Math.round
  });
});

// ── usageInfoEmptyBreakdown / usageInfoAddBreakdown ────────────────

describe('usage-info: breakdown aggregation', () => {
  it('creates empty breakdown with all zeros', () => {
    const result = usageInfoEmptyBreakdown();
    assert.deepEqual(result, { total: 0, input: 0, output: 0, cache: 0, requests: 0 });
  });

  it('adds usage to breakdown', () => {
    const bd = usageInfoEmptyBreakdown();
    usageInfoAddBreakdown(bd, { totalTokens: 100, inputTokens: 60, outputTokens: 40, cacheReadTokens: 20, requests: 3 });
    const result = bd;
    assert.equal(result.total, 100);
    assert.equal(result.input, 60);
    assert.equal(result.output, 40);
    assert.equal(result.cache, 20);
    assert.equal(result.requests, 3);
  });

  it('accumulates across multiple calls', () => {
    const bd2 = usageInfoEmptyBreakdown();
    usageInfoAddBreakdown(bd2, { totalTokens: 50, inputTokens: 30, outputTokens: 20 });
    usageInfoAddBreakdown(bd2, { totalTokens: 50, inputTokens: 10, outputTokens: 40 });
    const result = bd2;
    assert.equal(result.total, 100);
    assert.equal(result.input, 40);
    assert.equal(result.output, 60);
    assert.equal(result.requests, 2); // default 1 per call
  });

  it('handles missing usage fields', () => {
    const bd3 = usageInfoEmptyBreakdown();
    usageInfoAddBreakdown(bd3, null);
    usageInfoAddBreakdown(bd3, {});
    const result = bd3;
    assert.equal(result.total, 0);
    assert.equal(result.requests, 2); // default 1 per call
  });
});

// ── usageInfoEventDate ─────────────────────────────────────────────

describe('usage-info: usageInfoEventDate', () => {
  it('uses event.date when available', () => {
    assert.equal(usageInfoEventDate({ date: "2026-06-15" }), '2026-06-15');
  });

  it('extracts date from timestamp', () => {
    const ts = new Date(2026, 5, 15).getTime();
    const result = usageInfoEventDate({ timestamp: ts });
    assert.equal(result, '2026-06-15');
  });

  it('extracts date from createdAt', () => {
    const ts = new Date(2026, 0, 1).getTime();
    const result = usageInfoEventDate({ createdAt: ts });
    assert.equal(result, '2026-01-01');
  });

  it('returns empty for invalid event', () => {
    assert.equal(usageInfoEventDate(null), '');
    assert.equal(usageInfoEventDate({}), '');
  });
});

// ── usageInfoEventHour ─────────────────────────────────────────────

describe('usage-info: usageInfoEventHour', () => {
  it('extracts hour from timestamp', () => {
    const ts = new Date(2026, 0, 1, 14, 30).getTime();
    const result = usageInfoEventHour({ timestamp: ts });
    assert.equal(result, 14);
  });

  it('returns NaN for invalid event', () => {
    assert.ok(Number.isNaN(usageInfoEventHour(null)));
    assert.ok(Number.isNaN(usageInfoEventHour({})));
  });
});

// ── usageInfoLabel ─────────────────────────────────────────────────

describe('usage-info: usageInfoLabel', () => {
  it('returns zh label for known key', () => {
    assert.equal(usageInfoLabel("model"), '模型');
    assert.equal(usageInfoLabel("agent"), 'Agent');
    assert.equal(usageInfoLabel("source"), '来源');
  });

  it('returns the key itself for unknown keys', () => {
    assert.equal(usageInfoLabel("unknown"), 'unknown');
  });
});

// ── usageInfoDefaults ──────────────────────────────────────────────

describe('usage-info: usageInfoDefaults', () => {
  it('returns object with expected default values', () => {
    const result = usageInfoDefaults();
    assert.equal(result.open, false);
    assert.equal(result.loading, false);
    assert.equal(result.error, '');
    assert.equal(result.range, 'today');
    assert.equal(result.groupBy, 'model');
    assert.equal(result.search, '');
    assert.equal(result.chartView, 'trend');
    assert.equal(result.chartModel, '__all__');
    assert.equal(result.calendarDaily, null);
    assert.equal(result.data, null);
  });

  it('from and to are today', () => {
    const result = usageInfoDefaults();
    const today = usageInfoToday();
    assert.equal(result.from, today);
    assert.equal(result.to, today);
  });
});

// ── usageInfoRangeDates ────────────────────────────────────────────

describe('usage-info: usageInfoRangeDates', () => {
  it('returns today for both from/to when range is "today"', () => {
    const today = usageInfoToday();
    const result = usageInfoRangeDates("today");
    assert.equal(result.from, today);
    assert.equal(result.to, today);
  });

  it('returns 7-day range for "7d"', () => {
    const today = usageInfoToday();
    const sevenDaysAgo = usageInfoDateDaysAgo(6);
    const result = usageInfoRangeDates("7d");
    assert.equal(result.from, sevenDaysAgo);
    assert.equal(result.to, today);
  });

  it('returns 30-day range for "30d"', () => {
    const today = usageInfoToday();
    const thirtyDaysAgo = usageInfoDateDaysAgo(29);
    const result = usageInfoRangeDates("30d");
    assert.equal(result.from, thirtyDaysAgo);
    assert.equal(result.to, today);
  });

  it('defaults to today for unknown range', () => {
    const today = usageInfoToday();
    const result = usageInfoRangeDates("unknown");
    assert.equal(result.from, today);
    assert.equal(result.to, today);
  });
});

// ── usageInfoDateRange ─────────────────────────────────────────────

describe('usage-info: usageInfoDateRange', () => {
  it('generates array of date strings', () => {
    const result = usageInfoDateRange("2026-06-01", "2026-06-03");
    assert.deepEqual(result, ['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('returns single element for same from/to', () => {
    const result = usageInfoDateRange("2026-06-15", "2026-06-15");
    assert.deepEqual(result, ['2026-06-15']);
  });

  it('returns empty for invalid dates', () => {
    assert.deepEqual(usageInfoDateRange("invalid", "2026-06-03"), []);
  });

  it('returns empty when start > end', () => {
    assert.deepEqual(usageInfoDateRange("2026-06-05", "2026-06-01"), []);
  });

  it('falls back to today for null params', () => {
    const today = usageInfoToday();
    const result = usageInfoDateRange(null, null);
    assert.deepEqual(result, [today]);
  });
});

// ── renderUsageMetric ──────────────────────────────────────────────

describe('usage-info: renderUsageMetric', () => {
  it('renders metric HTML with label and value', () => {
    const html = renderUsageMetric("Total", "1.5K", null);
    assert.ok(html.includes('usage-info-metric'));
    assert.ok(html.includes('Total'));
    assert.ok(html.includes('1.5K'));
  });

  it('includes detail when provided', () => {
    const html = renderUsageMetric("Cost", "$5", "$0.05/1K");
    assert.ok(html.includes('usage-info-metric-detail'));
    assert.ok(html.includes('$0.05/1K'));
  });

  it('escapes HTML in label and value', () => {
    const html = renderUsageMetric("<script>", "x", null);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

// ── usageInfoSmoothPath ────────────────────────────────────────────

describe('usage-info: usageInfoSmoothPath', () => {
  it('returns empty string for empty array', () => {
    assert.equal(usageInfoSmoothPath([]), '');
    assert.equal(usageInfoSmoothPath(null), '');
  });

  it('returns simple path for 1-2 points', () => {
    const result = usageInfoSmoothPath([[0, 0], [1, 1]]);
    assert.ok(result.startsWith('M '));
    assert.ok(result.includes(' L '));
  });

  it('returns smooth path with curves for 3+ points', () => {
    const result = usageInfoSmoothPath([[0, 0], [50, 100], [100, 50]]);
    assert.ok(result.startsWith('M '));
    assert.ok(result.includes(' C ')); // cubic bezier
  });

  it('handles flat line (all same y)', () => {
    const result = usageInfoSmoothPath([[0, 0], [50, 0], [100, 0]]);
    assert.ok(result.startsWith('M '));
  });
});

// ── 兼容面与状态归属（ESM 化后必须保持的协议）─────────────────────

describe('usage-info: 兼容面', () => {
  it('window.openUsageInfo 指向命名导出（classic app-ui / home-dashboard 协议）', () => {
    assert.equal(typeof usage.openUsageInfo, 'function');
    assert.equal(window.openUsageInfo, usage.openUsageInfo);
  });

  it('data-action 处理器仍按 usageInfo.* 全量注册', () => {
    // 本模块 import 的 markdown-utils 也会注册自己的 markdown.* 动作，按命名空间过滤
    const usageActions = [...registeredActions.keys()].filter((name) => name.startsWith('usageInfo.'));
    assert.deepEqual(usageActions.sort(), [
      'usageInfo.close',
      'usageInfo.search',
      'usageInfo.setChartView',
      'usageInfo.setRange',
      'usageInfo.toggleChartModelMenu',
      'usageInfo.toggleGroupMenu',
    ]);
  });

  it('覆盖层状态收敛为模块私有，不再写 window.ClawFW.usageInfo', () => {
    assert.equal(window.ClawFW.usageInfo, undefined);
  });
});
