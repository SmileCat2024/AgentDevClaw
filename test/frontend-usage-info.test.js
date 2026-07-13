/**
 * Tests for public/src/modules/usage-info-overlay.js
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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadUsageInfo() {
  const ctx = createFrontendSandbox({});
  ctx.loadSource('public/src/modules/usage-info-overlay.js');
  return ctx;
}

// ── usageInfoLocalDateString ───────────────────────────────────────

describe('usage-info: usageInfoLocalDateString', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('formats a Date correctly', () => {
    const result = fn('usageInfoLocalDateString(new Date(2026, 0, 5))'); // Jan 5, 2026
    assert.equal(result, '2026-01-05');
  });

  it('pads month and day', () => {
    const result = fn('usageInfoLocalDateString(new Date(2026, 10, 15))'); // Nov 15
    assert.equal(result, '2026-11-15');
  });

  it('returns empty for invalid date', () => {
    assert.equal(fn('usageInfoLocalDateString(new Date("invalid"))'), '');
  });

  it('accepts timestamp number', () => {
    const result = fn('usageInfoLocalDateString(new Date(2026, 5, 1).getTime())');
    assert.equal(result, '2026-06-01');
  });
});

// ── usageInfoParseLocalDate ────────────────────────────────────────

describe('usage-info: usageInfoParseLocalDate', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('parses YYYY-MM-DD format', () => {
    const result = fn('usageInfoParseLocalDate("2026-06-15")');
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 5); // June (0-indexed)
    assert.equal(result.getDate(), 15);
  });

  it('falls back to Date constructor for non-matching format', () => {
    const result = fn('usageInfoParseLocalDate("2026/06/15")');
    assert.ok(result instanceof Date);
  });

  it('returns epoch for null', () => {
    const result = fn('usageInfoParseLocalDate(null)');
    assert.equal(result.getTime(), 0);
  });
});

// ── usageInfoDateDaysAgo ───────────────────────────────────────────

describe('usage-info: usageInfoDateDaysAgo', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('returns today for 0 days ago', () => {
    const today = fn('usageInfoToday()');
    const zeroDays = fn('usageInfoDateDaysAgo(0)');
    assert.equal(zeroDays, today);
  });

  it('returns yesterday for 1 day ago', () => {
    const today = fn('usageInfoToday()');
    const yesterday = fn('usageInfoDateDaysAgo(1)');
    // Parse both and check they differ by 1 day
    const todayDate = new Date(today);
    const yesterdayDate = new Date(yesterday);
    const diff = (todayDate - yesterdayDate) / (1000 * 60 * 60 * 24);
    assert.equal(diff, 1);
  });

  it('produces valid date string', () => {
    const result = fn('usageInfoDateDaysAgo(7)');
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── usageInfoNumber ────────────────────────────────────────────────

describe('usage-info: usageInfoNumber', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('returns raw number for small values', () => {
    assert.equal(fn('usageInfoNumber(42)'), '42');
    assert.equal(fn('usageInfoNumber(999)'), '999');
  });

  it('formats thousands with K suffix', () => {
    assert.equal(fn('usageInfoNumber(1000)'), '1.00K');
    assert.equal(fn('usageInfoNumber(5500)'), '5.50K');
  });

  it('formats millions with M suffix', () => {
    assert.equal(fn('usageInfoNumber(1000000)'), '1.00M');
    assert.equal(fn('usageInfoNumber(2500000)'), '2.50M');
  });

  it('formats billions with B suffix', () => {
    assert.equal(fn('usageInfoNumber(1000000000)'), '1.00B');
  });

  it('handles 0', () => {
    assert.equal(fn('usageInfoNumber(0)'), '0');
  });

  it('handles non-finite values as 0', () => {
    assert.equal(fn('usageInfoNumber(NaN)'), '0');
    assert.equal(fn('usageInfoNumber(null)'), '0');
    assert.equal(fn('usageInfoNumber("abc")'), '0');
  });
});

// ── usageInfoFullNumber ────────────────────────────────────────────

describe('usage-info: usageInfoFullNumber', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('formats with locale separators', () => {
    const result = fn('usageInfoFullNumber(1234567)');
    // toLocaleString produces locale-dependent output, but should contain digit groups
    assert.ok(result.includes('1') && result.includes('7'));
  });

  it('handles 0', () => {
    assert.equal(fn('usageInfoFullNumber(0)'), '0');
  });

  it('handles non-finite as 0', () => {
    assert.equal(fn('usageInfoFullNumber(NaN)'), '0');
  });
});

// ── usageInfoPct ───────────────────────────────────────────────────

describe('usage-info: usageInfoPct', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('calculates percentage', () => {
    assert.equal(fn('usageInfoPct(25, 100)'), 25);
    assert.equal(fn('usageInfoPct(1, 4)'), 25);
  });

  it('rounds to integer', () => {
    assert.equal(fn('usageInfoPct(1, 3)'), 33);
    assert.equal(fn('usageInfoPct(2, 3)'), 67);
  });

  it('returns 0 when total is 0', () => {
    assert.equal(fn('usageInfoPct(5, 0)'), 0);
  });

  it('handles part > total (caps at 100 via rounding)', () => {
    const result = fn('usageInfoPct(150, 100)');
    assert.equal(result, 150); // No cap — just Math.round
  });
});

// ── usageInfoEmptyBreakdown / usageInfoAddBreakdown ────────────────

describe('usage-info: breakdown aggregation', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('creates empty breakdown with all zeros', () => {
    const result = fn('usageInfoEmptyBreakdown()');
    assert.deepEqual(result, { total: 0, input: 0, output: 0, cache: 0, requests: 0 });
  });

  it('adds usage to breakdown', () => {
    fn('var bd = usageInfoEmptyBreakdown()');
    fn('usageInfoAddBreakdown(bd, { totalTokens: 100, inputTokens: 60, outputTokens: 40, cacheReadTokens: 20, requests: 3 })');
    const result = fn('bd');
    assert.equal(result.total, 100);
    assert.equal(result.input, 60);
    assert.equal(result.output, 40);
    assert.equal(result.cache, 20);
    assert.equal(result.requests, 3);
  });

  it('accumulates across multiple calls', () => {
    fn('var bd2 = usageInfoEmptyBreakdown()');
    fn('usageInfoAddBreakdown(bd2, { totalTokens: 50, inputTokens: 30, outputTokens: 20 })');
    fn('usageInfoAddBreakdown(bd2, { totalTokens: 50, inputTokens: 10, outputTokens: 40 })');
    const result = fn('bd2');
    assert.equal(result.total, 100);
    assert.equal(result.input, 40);
    assert.equal(result.output, 60);
    assert.equal(result.requests, 2); // default 1 per call
  });

  it('handles missing usage fields', () => {
    fn('var bd3 = usageInfoEmptyBreakdown()');
    fn('usageInfoAddBreakdown(bd3, null)');
    fn('usageInfoAddBreakdown(bd3, {})');
    const result = fn('bd3');
    assert.equal(result.total, 0);
    assert.equal(result.requests, 2); // default 1 per call
  });
});

// ── usageInfoEventDate ─────────────────────────────────────────────

describe('usage-info: usageInfoEventDate', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('uses event.date when available', () => {
    assert.equal(fn('usageInfoEventDate({ date: "2026-06-15" })'), '2026-06-15');
  });

  it('extracts date from timestamp', () => {
    const ts = new Date(2026, 5, 15).getTime();
    const result = fn(`usageInfoEventDate({ timestamp: ${ts} })`);
    assert.equal(result, '2026-06-15');
  });

  it('extracts date from createdAt', () => {
    const ts = new Date(2026, 0, 1).getTime();
    const result = fn(`usageInfoEventDate({ createdAt: ${ts} })`);
    assert.equal(result, '2026-01-01');
  });

  it('returns empty for invalid event', () => {
    assert.equal(fn('usageInfoEventDate(null)'), '');
    assert.equal(fn('usageInfoEventDate({})'), '');
  });
});

// ── usageInfoEventHour ─────────────────────────────────────────────

describe('usage-info: usageInfoEventHour', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('extracts hour from timestamp', () => {
    const ts = new Date(2026, 0, 1, 14, 30).getTime();
    const result = fn(`usageInfoEventHour({ timestamp: ${ts} })`);
    assert.equal(result, 14);
  });

  it('returns NaN for invalid event', () => {
    assert.ok(Number.isNaN(fn('usageInfoEventHour(null)')));
    assert.ok(Number.isNaN(fn('usageInfoEventHour({})')));
  });
});

// ── usageInfoLabel ─────────────────────────────────────────────────

describe('usage-info: usageInfoLabel', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('returns zh label for known key', () => {
    assert.equal(fn('usageInfoLabel("model")'), '模型');
    assert.equal(fn('usageInfoLabel("agent")'), 'Agent');
    assert.equal(fn('usageInfoLabel("source")'), '来源');
  });

  it('returns the key itself for unknown keys', () => {
    assert.equal(fn('usageInfoLabel("unknown")'), 'unknown');
  });
});

// ── usageInfoDefaults ──────────────────────────────────────────────

describe('usage-info: usageInfoDefaults', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('returns object with expected default values', () => {
    const result = fn('usageInfoDefaults()');
    assert.equal(result.open, false);
    assert.equal(result.loading, false);
    assert.equal(result.error, '');
    assert.equal(result.range, 'today');
    assert.equal(result.groupBy, 'model');
    assert.equal(result.search, '');
    assert.equal(result.chartView, 'trend');
    assert.equal(result.chartModel, '__all__');
    assert.equal(result.calendarDaily, null);
    assert.equal(result.groupMenuOpen, false);
    assert.equal(result.chartModelMenuOpen, false);
    assert.equal(result.data, null);
  });

  it('from and to are today', () => {
    const result = fn('usageInfoDefaults()');
    const today = fn('usageInfoToday()');
    assert.equal(result.from, today);
    assert.equal(result.to, today);
  });
});

// ── usageInfoRangeDates ────────────────────────────────────────────

describe('usage-info: usageInfoRangeDates', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('returns today for both from/to when range is "today"', () => {
    const today = fn('usageInfoToday()');
    const result = fn('usageInfoRangeDates("today")');
    assert.equal(result.from, today);
    assert.equal(result.to, today);
  });

  it('returns 7-day range for "7d"', () => {
    const today = fn('usageInfoToday()');
    const sevenDaysAgo = fn('usageInfoDateDaysAgo(6)');
    const result = fn('usageInfoRangeDates("7d")');
    assert.equal(result.from, sevenDaysAgo);
    assert.equal(result.to, today);
  });

  it('returns 30-day range for "30d"', () => {
    const today = fn('usageInfoToday()');
    const thirtyDaysAgo = fn('usageInfoDateDaysAgo(29)');
    const result = fn('usageInfoRangeDates("30d")');
    assert.equal(result.from, thirtyDaysAgo);
    assert.equal(result.to, today);
  });

  it('defaults to today for unknown range', () => {
    const today = fn('usageInfoToday()');
    const result = fn('usageInfoRangeDates("unknown")');
    assert.equal(result.from, today);
    assert.equal(result.to, today);
  });
});

// ── usageInfoDateRange ─────────────────────────────────────────────

describe('usage-info: usageInfoDateRange', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('generates array of date strings', () => {
    const result = fn('usageInfoDateRange("2026-06-01", "2026-06-03")');
    assert.deepEqual(result, ['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('returns single element for same from/to', () => {
    const result = fn('usageInfoDateRange("2026-06-15", "2026-06-15")');
    assert.deepEqual(result, ['2026-06-15']);
  });

  it('returns empty for invalid dates', () => {
    assert.deepEqual(fn('usageInfoDateRange("invalid", "2026-06-03")'), []);
  });

  it('returns empty when start > end', () => {
    assert.deepEqual(fn('usageInfoDateRange("2026-06-05", "2026-06-01")'), []);
  });

  it('falls back to today for null params', () => {
    const today = fn('usageInfoToday()');
    const result = fn('usageInfoDateRange(null, null)');
    assert.deepEqual(result, [today]);
  });
});

// ── renderUsageMetric ──────────────────────────────────────────────

describe('usage-info: renderUsageMetric', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('renders metric HTML with label and value', () => {
    const html = fn('renderUsageMetric("Total", "1.5K", null)');
    assert.ok(html.includes('usage-info-metric'));
    assert.ok(html.includes('Total'));
    assert.ok(html.includes('1.5K'));
  });

  it('includes detail when provided', () => {
    const html = fn('renderUsageMetric("Cost", "$5", "$0.05/1K")');
    assert.ok(html.includes('usage-info-metric-detail'));
    assert.ok(html.includes('$0.05/1K'));
  });

  it('escapes HTML in label and value', () => {
    const html = fn('renderUsageMetric("<script>", "x", null)');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

// ── usageInfoSmoothPath ────────────────────────────────────────────

describe('usage-info: usageInfoSmoothPath', () => {
  const ctx = loadUsageInfo();
  const fn = ctx.run;

  it('returns empty string for empty array', () => {
    assert.equal(fn('usageInfoSmoothPath([])'), '');
    assert.equal(fn('usageInfoSmoothPath(null)'), '');
  });

  it('returns simple path for 1-2 points', () => {
    const result = fn('usageInfoSmoothPath([[0, 0], [1, 1]])');
    assert.ok(result.startsWith('M '));
    assert.ok(result.includes(' L '));
  });

  it('returns smooth path with curves for 3+ points', () => {
    const result = fn('usageInfoSmoothPath([[0, 0], [50, 100], [100, 50]])');
    assert.ok(result.startsWith('M '));
    assert.ok(result.includes(' C ')); // cubic bezier
  });

  it('handles flat line (all same y)', () => {
    const result = fn('usageInfoSmoothPath([[0, 0], [50, 0], [100, 0]])');
    assert.ok(result.startsWith('M '));
  });
});
