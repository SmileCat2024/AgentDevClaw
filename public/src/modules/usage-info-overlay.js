/**
 * usage-info-overlay.js — 用量信息覆盖层模块（从 settings-overlay.js 拆分）
 *
 * 包含：用量仪表盘（趋势图、柱状图、日历热力、分组排行、事件列表）。
 * 依赖（全局）：escapeHtml, currentLanguage
 */

function ensureUsageInfoHost() {
  let host = document.getElementById('usage-info-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'usage-info-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

function usageInfoLocalDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function usageInfoParseLocalDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function usageInfoToday() {
  return usageInfoLocalDateString(new Date());
}

function usageInfoDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return usageInfoLocalDateString(date);
}

function usageInfoDefaults() {
  const today = usageInfoToday();
  return {
    open: false,
    loading: false,
    error: '',
    range: 'today',
    groupBy: 'model',
    search: '',
    chartView: 'trend',
    chartModel: '__all__',
    calendarDaily: null,
    groupMenuOpen: false,
    chartModelMenuOpen: false,
    from: today,
    to: today,
    data: null,
  };
}

function getUsageInfoState() {
  window.ClawFW.usageInfo = window.ClawFW.usageInfo || usageInfoDefaults();
  return window.ClawFW.usageInfo;
}

function usageInfoRangeDates(range) {
  const today = usageInfoToday();
  if (range === '7d') return { from: usageInfoDateDaysAgo(6), to: today };
  if (range === '30d') return { from: usageInfoDateDaysAgo(29), to: today };
  return { from: today, to: today };
}

async function loadUsageInfoCalendarData() {
  const state = getUsageInfoState();
  try {
    const params = new URLSearchParams({
      from: usageInfoDateDaysAgo(364),
      to: usageInfoToday(),
      groupBy: 'model',
    });
    const resp = await fetch('/protoclaw/usage/summary?' + params.toString());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    state.calendarDaily = Array.isArray(data.daily) ? data.daily : [];
  } catch (e) {
    state.calendarDaily = [];
  }
  renderUsageInfoOverlay();
}

async function openUsageInfo() {
  const state = getUsageInfoState();
  Object.assign(state, usageInfoDefaults(), { open: true });
  renderUsageInfoOverlay();
  await Promise.all([
    loadUsageInfoData(),
    loadUsageInfoCalendarData(),
  ]);
}

function closeUsageInfo() {
  const host = document.getElementById('usage-info-overlay-host');
  if (host) host.innerHTML = '';
  window.ClawFW.usageInfo = usageInfoDefaults();
}

async function loadUsageInfoData() {
  const state = getUsageInfoState();
  const dates = usageInfoRangeDates(state.range);
  state.loading = true;
  state.error = '';
  state.from = dates.from;
  state.to = dates.to;
  renderUsageInfoOverlay();
  try {
    const params = new URLSearchParams({
      from: state.from,
      to: state.to,
      groupBy: state.groupBy || 'model',
    });
    if (state.search) params.set('search', state.search);
    const resp = await fetch('/protoclaw/usage/summary?' + params.toString());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    state.data = await resp.json();
  } catch (error) {
    state.error = error?.message || String(error);
  } finally {
    state.loading = false;
    renderUsageInfoOverlay();
  }
}

function usageInfoNumber(value) {
  const n = Number.isFinite(value) ? value : 0;
  if (n >= 1000000000) return (n / 1000000000).toFixed(2) + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
  return String(n);
}

function usageInfoFullNumber(value) {
  return (Number.isFinite(value) ? value : 0).toLocaleString();
}

function usageInfoPct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function usageInfoLabel(key) {
  const isZh = currentLanguage === 'zh';
  const zh = {
    model: '模型',
    preset: '预设',
    agent: 'Agent',
    source: '来源',
    date: '日期',
  };
  const en = {
    model: 'Model',
    preset: 'Preset',
    agent: 'Agent',
    source: 'Source',
    date: 'Date',
  };
  return (isZh ? zh : en)[key] || key;
}

function renderUsageMetric(label, value, detail) {
  return [
    '<div class="usage-info-metric">',
    '<div class="usage-info-metric-label">' + escapeHtml(label) + '</div>',
    '<div class="usage-info-metric-value">' + escapeHtml(value) + '</div>',
    detail ? '<div class="usage-info-metric-detail">' + escapeHtml(detail) + '</div>' : '',
    '</div>',
  ].join('');
}

function usageInfoDateRange(from, to) {
  const result = [];
  const start = usageInfoParseLocalDate(from || usageInfoToday());
  const end = usageInfoParseLocalDate(to || from || usageInfoToday());
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return result;
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    result.push(usageInfoLocalDateString(d));
  }
  return result;
}

function usageInfoEventDate(event) {
  if (event?.date) return String(event.date);
  const value = event?.timestamp || event?.createdAt;
  const date = new Date(Number.isFinite(value) ? value : String(value || ''));
  return Number.isNaN(date.getTime()) ? '' : usageInfoLocalDateString(date);
}

function usageInfoEventHour(event) {
  const value = event?.timestamp || event?.createdAt;
  const date = new Date(Number.isFinite(value) ? value : String(value || ''));
  return Number.isNaN(date.getTime()) ? NaN : date.getHours();
}

function usageInfoEmptyBreakdown() {
  return { total: 0, input: 0, output: 0, cache: 0, requests: 0 };
}

function usageInfoAddBreakdown(target, usage) {
  target.total += usage?.totalTokens || 0;
  target.input += usage?.inputTokens || 0;
  target.output += usage?.outputTokens || 0;
  target.cache += usage?.cacheReadTokens || 0;
  target.requests += usage?.requests || 1;
}

function usageInfoSmoothPath(points) {
  if (!Array.isArray(points) || !points.length) return '';
  if (points.length < 3) {
    return 'M ' + points.map((point) => point.map((value) => value.toFixed(2)).join(' ')).join(' L ');
  }
  const slopes = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const dx = points[index + 1][0] - points[index][0] || 1;
    slopes.push((points[index + 1][1] - points[index][1]) / dx);
  }
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes[slopes.length - 1];
    if (slopes[index - 1] * slopes[index] <= 0) return 0;
    return (slopes[index - 1] + slopes[index]) / 2;
  });
  for (let index = 0; index < slopes.length; index += 1) {
    if (slopes[index] === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = tangents[index] / slopes[index];
    const b = tangents[index + 1] / slopes[index];
    const sum = a * a + b * b;
    if (sum > 9) {
      const scale = 3 / Math.sqrt(sum);
      tangents[index] = scale * a * slopes[index];
      tangents[index + 1] = scale * b * slopes[index];
    }
  }
  const commands = ['M ' + points[0][0].toFixed(2) + ' ' + points[0][1].toFixed(2)];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p1 = points[index];
    const p2 = points[index + 1];
    const dx = p2[0] - p1[0];
    const c1x = p1[0] + dx / 3;
    const c1y = p1[1] + (tangents[index] * dx) / 3;
    const c2x = p2[0] - dx / 3;
    const c2y = p2[1] - (tangents[index + 1] * dx) / 3;
    commands.push(
      'C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2)
      + ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2)
      + ' ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2)
    );
  }
  return commands.join(' ');
}

function usageInfoBucketRows(daily, from, to, events) {
  const byDate = new Map((Array.isArray(daily) ? daily : []).map((item) => [item.date, item]));
  const dates = usageInfoDateRange(from, to);
  const rows = dates.map((date) => byDate.get(date) || { date, totals: { totalTokens: 0 } });
  const isSingleDay = rows.length === 1;
  const buckets = isSingleDay
    ? Array.from({ length: 24 }, (_, index) => {
        const hour = String(index).padStart(2, '0');
        return { key: hour, label: hour + ':00', title: rows[0]?.date + ' ' + hour + ':00', total: 0, input: 0, output: 0, cache: 0, models: new Map() };
      })
    : rows.map((item) => ({
        key: item.date,
        label: String(item.date || '').slice(5),
        title: item.date || '',
        total: item?.totals?.totalTokens || 0,
        input: item?.totals?.inputTokens || 0,
        output: item?.totals?.outputTokens || 0,
        cache: item?.totals?.cacheReadTokens || 0,
        models: new Map(),
      }));

  (Array.isArray(events) ? events : []).forEach((event) => {
    const eventDate = usageInfoEventDate(event);
    const usage = event?.usage || {};
    // __default__ 是 resolver 合成名（可能对应不同时期的模型），统计视图落到具体 modelName
    const eventPreset = event?.model?.presetName;
    const model = (eventPreset && eventPreset !== '__default__') ? eventPreset : (event?.model?.modelName || 'unknown');
    const bucketIndex = isSingleDay
      ? usageInfoEventHour(event)
      : rows.findIndex((item) => eventDate === item.date);
    if (!Number.isFinite(bucketIndex) || bucketIndex < 0 || bucketIndex >= buckets.length) return;
    const bucket = buckets[bucketIndex];
    const total = usage.totalTokens || 0;
    bucket.total += isSingleDay ? total : 0;
    bucket.input += isSingleDay ? (usage.inputTokens || 0) : 0;
    bucket.output += isSingleDay ? (usage.outputTokens || 0) : 0;
    bucket.cache += isSingleDay ? (usage.cacheReadTokens || 0) : 0;
    if (!bucket.models.has(model)) bucket.models.set(model, usageInfoEmptyBreakdown());
    usageInfoAddBreakdown(bucket.models.get(model), usage);
  });

  if (isSingleDay) {
    const bucketTotal = buckets.reduce((acc, item) => acc + item.total, 0);
    const dayTotals = rows[0]?.totals || {};
    if (bucketTotal <= 0 && (dayTotals.totalTokens || 0) > 0) {
      buckets[12].total = dayTotals.totalTokens || 0;
      buckets[12].input = dayTotals.inputTokens || 0;
      buckets[12].output = dayTotals.outputTokens || 0;
      buckets[12].cache = dayTotals.cacheReadTokens || 0;
    }
  }
  return { rows, buckets, isSingleDay };
}

function usageInfoModelOptions(events) {
  return Array.from(
    (Array.isArray(events) ? events : []).reduce((map, event) => {
      const optPreset = event?.model?.presetName;
      const label = (optPreset && optPreset !== '__default__') ? optPreset : (event?.model?.modelName || 'unknown');
      map.set(label, (map.get(label) || 0) + (event?.usage?.totalTokens || 0));
      return map;
    }, new Map()).entries()
  ).sort((a, b) => b[1] - a[1]);
}

function renderUsageInfoTrend(daily, from, to, events) {
  const isZh = currentLanguage === 'zh';
  const { rows, buckets, isSingleDay } = usageInfoBucketRows(daily, from, to, events);
  const max = rows.reduce((acc, item) => Math.max(acc, item?.totals?.totalTokens || 0), 0);
  if (!rows.length) {
    return '<div class="usage-info-empty">' + (isZh ? '当前范围暂无用量事件。' : 'No usage events in this range.') + '</div>';
  }
  const state = getUsageInfoState();
  const selectedModel = state.chartModel || '__all__';
  const usingAllModels = selectedModel === '__all__';
  const bucketValue = (item) => {
    if (usingAllModels) return item;
    return item.models.get(selectedModel) || usageInfoEmptyBreakdown();
  };
  const bucketTotal = (item) => usingAllModels ? (item.total || 0) : (bucketValue(item).total || 0);
  const chartMax = Math.max(1, buckets.reduce((acc, item) => Math.max(acc, bucketTotal(item)), 0));
  const width = 720;
  const height = 190;
  const left = 56;
  const right = 14;
  const top = 14;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const xFor = (index) => left + (buckets.length === 1 ? plotWidth / 2 : (index / (buckets.length - 1)) * plotWidth);
  const yFor = (total) => top + (1 - (total / chartMax)) * plotHeight;
  const totalPoints = buckets.map((item, index) => [xFor(index), yFor(bucketTotal(item))]);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / (isSingleDay ? 6 : 7)));
  const yTicks = [1, 0.75, 0.5, 0.25, 0];
  return [
    '<div class="usage-info-trend">',
    '<svg class="usage-info-trend-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + (isZh ? 'Token 用量趋势' : 'Token usage trend') + '">',
    yTicks.map((ratio) => {
      const value = Math.round(chartMax * ratio);
      const y = yFor(value);
      return '<line class="usage-info-trend-grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y + '" y2="' + y + '"></line>'
        + '<text class="usage-info-trend-axis" x="' + (left - 8) + '" y="' + (y + 4) + '">' + escapeHtml(usageInfoNumber(value)) + '</text>';
    }).join(''),
    buckets.map((item, index) => {
      const x = xFor(index);
      return '<line class="usage-info-trend-guide" data-guide="' + index + '" x1="' + x.toFixed(2) + '" x2="' + x.toFixed(2) + '" y1="' + top + '" y2="' + (height - bottom) + '"></line>';
    }).join(''),
    buckets.map((item, index) => {
      const value = bucketValue(item);
      const total = bucketTotal(item);
      const x = xFor(index);
      const modelLines = Array.from(item.models.entries())
        .sort((a, b) => (b[1]?.total || 0) - (a[1]?.total || 0))
        .slice(0, 5)
        .map(([model, stats]) => model + '  ' + usageInfoNumber(stats.total || 0));
      const tip = usingAllModels
        ? [
            item.title,
            (isZh ? '总量' : 'Total') + ' ' + usageInfoNumber(total),
            ...(modelLines.length ? modelLines : [isZh ? '暂无模型明细' : 'No model detail']),
          ].join('\n')
        : [
            item.title,
            selectedModel,
            (isZh ? '总量' : 'Total') + ' ' + usageInfoNumber(total),
            (isZh ? '请求' : 'Requests') + ' ' + usageInfoNumber(value.requests || 0),
          ].join('\n');
      return '<rect class="usage-info-trend-hit" x="' + Math.max(left, x - (plotWidth / Math.max(1, buckets.length)) / 2).toFixed(2) + '" y="' + top + '" width="' + Math.max(10, plotWidth / Math.max(1, buckets.length)).toFixed(2) + '" height="' + plotHeight + '" data-tip="' + escapeHtml(tip) + '" data-guide-target="' + index + '"></rect>';
    }).join(''),
    '<path class="usage-info-trend-line" d="' + usageInfoSmoothPath(totalPoints) + '"></path>',
    buckets.map((item, index) => {
      const total = bucketTotal(item);
      if (total <= 0) return '';
      const point = totalPoints[index];
      return '<circle class="usage-info-trend-point" cx="' + point[0].toFixed(2) + '" cy="' + point[1].toFixed(2) + '" r="3.5"></circle>';
    }).join(''),
    buckets.map((item, index) => {
      if (index % labelEvery !== 0 && index !== buckets.length - 1) return '';
      return '<text class="usage-info-trend-label" x="' + xFor(index).toFixed(2) + '" y="' + (height - 6) + '">' + escapeHtml(item.label) + '</text>';
    }).join(''),
    '</svg>',
    '<div class="usage-info-trend-legend">',
    '<span><i></i>' + (isZh ? 'Token 趋势' : 'Token trend') + '</span>',
    '<strong>' + escapeHtml(usingAllModels ? (isZh ? '全部模型' : 'All models') : selectedModel) + '</strong>',
    '</div>',
    '</div>',
  ].join('');
}

function renderUsageInfoBars(daily, from, to, events) {
  const isZh = currentLanguage === 'zh';
  const { buckets, isSingleDay } = usageInfoBucketRows(daily, from, to, events);
  const state = getUsageInfoState();
  const selectedModel = state.chartModel || '__all__';
  const usingAllModels = selectedModel === '__all__';
  const bucketValue = (item) => usingAllModels ? item : (item.models.get(selectedModel) || usageInfoEmptyBreakdown());
  const bucketTotal = (item) => {
    const value = bucketValue(item);
    return usingAllModels ? (item.total || 0) : (value.total || 0);
  };
  const chartMax = Math.max(1, buckets.reduce((acc, item) => Math.max(acc, bucketTotal(item)), 0));
  const width = 720;
  const height = 190;
  const left = 56;
  const right = 14;
  const top = 14;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const xFor = (index) => left + (buckets.length === 1 ? plotWidth / 2 : (index / (buckets.length - 1)) * plotWidth);
  const yFor = (value) => top + (1 - (value / chartMax)) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / (isSingleDay ? 6 : 7)));
  const yTicks = [1, 0.75, 0.5, 0.25, 0];
  return [
    '<div class="usage-info-trend usage-info-bars">',
    '<svg class="usage-info-trend-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + (isZh ? 'Token 构成柱状图' : 'Token breakdown bars') + '">',
    yTicks.map((ratio) => {
      const value = Math.round(chartMax * ratio);
      const y = yFor(value);
      return '<line class="usage-info-trend-grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y + '" y2="' + y + '"></line>'
        + '<text class="usage-info-trend-axis" x="' + (left - 8) + '" y="' + (y + 4) + '">' + escapeHtml(usageInfoNumber(value)) + '</text>';
    }).join(''),
    buckets.map((item, index) => {
      const x = xFor(index);
      return '<line class="usage-info-trend-guide" data-guide="' + index + '" x1="' + x.toFixed(2) + '" x2="' + x.toFixed(2) + '" y1="' + top + '" y2="' + (height - bottom) + '"></line>';
    }).join(''),
    buckets.map((item, index) => {
      const value = bucketValue(item);
      const total = bucketTotal(item);
      const x = xFor(index);
      const barWidth = Math.max(6, Math.min(18, plotWidth / Math.max(1, buckets.length) * 0.34));
      const cached = Math.min(value.input || 0, value.cache || 0);
      const uncached = Math.max(0, (value.input || 0) - cached);
      const output = value.output || 0;
      let segmentBottom = height - bottom;
      const segment = (segmentValue, klass) => {
        const segmentHeight = segmentValue > 0 ? Math.max(2, (segmentValue / chartMax) * plotHeight) : 0;
        segmentBottom -= segmentHeight;
        return '<rect class="' + klass + '" x="' + (x - barWidth / 2).toFixed(2) + '" y="' + segmentBottom.toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + segmentHeight.toFixed(2) + '"></rect>';
      };
      const tip = [
        item.title,
        usingAllModels ? (isZh ? '全部模型' : 'All models') : selectedModel,
        (isZh ? '总量' : 'Total') + ' ' + usageInfoNumber(total),
        (isZh ? '输入（命中缓存）' : 'Input cached') + ' ' + usageInfoNumber(cached),
        (isZh ? '输入（未命中缓存）' : 'Input uncached') + ' ' + usageInfoNumber(uncached),
        (isZh ? '输出' : 'Output') + ' ' + usageInfoNumber(output),
      ].join('\n');
      return '<rect class="usage-info-trend-hit" x="' + Math.max(left, x - (plotWidth / Math.max(1, buckets.length)) / 2).toFixed(2) + '" y="' + top + '" width="' + Math.max(10, plotWidth / Math.max(1, buckets.length)).toFixed(2) + '" height="' + plotHeight + '" data-tip="' + escapeHtml(tip) + '" data-guide-target="' + index + '"></rect>'
        + '<g class="usage-info-trend-stack" data-tip="' + escapeHtml(tip) + '">'
        + segment(cached, 'usage-info-trend-bar usage-info-trend-bar-cache')
        + segment(uncached, 'usage-info-trend-bar usage-info-trend-bar-input')
        + segment(output, 'usage-info-trend-bar usage-info-trend-bar-output')
        + '</g>';
    }).join(''),
    buckets.map((item, index) => {
      if (index % labelEvery !== 0 && index !== buckets.length - 1) return '';
      return '<text class="usage-info-trend-label" x="' + xFor(index).toFixed(2) + '" y="' + (height - 6) + '">' + escapeHtml(item.label) + '</text>';
    }).join(''),
    '</svg>',
    '<div class="usage-info-trend-legend">',
    '<span><i class="usage-info-legend-cache"></i>' + (isZh ? '输入命中缓存' : 'Input cached') + '</span>',
    '<span><i class="usage-info-legend-input"></i>' + (isZh ? '输入未命中' : 'Input uncached') + '</span>',
    '<span><i class="usage-info-legend-output"></i>' + (isZh ? '输出' : 'Output') + '</span>',
    '<strong>' + escapeHtml(usingAllModels ? (isZh ? '全部模型' : 'All models') : selectedModel) + '</strong>',
    '</div>',
    '</div>',
  ].join('');
}

function renderUsageInfoCalendar() {
  const isZh = currentLanguage === 'zh';
  const state = getUsageInfoState();
  const end = usageInfoParseLocalDate(usageInfoToday());
  const start = new Date(end.getTime() - 364 * 86400000);
  const dates = usageInfoDateRange(usageInfoLocalDateString(start), usageInfoLocalDateString(end));
  const byDate = new Map((Array.isArray(state.calendarDaily) ? state.calendarDaily : []).map((item) => [item.date, item]));
  const cells = dates.map((date) => ({ date, total: byDate.get(date)?.totals?.totalTokens || 0 }));
  const max = Math.max(1, cells.reduce((acc, item) => Math.max(acc, item.total), 0));
  if (!cells.length) return '';
  const leading = usageInfoParseLocalDate(cells[0].date).getDay();
  const padded = Array.from({ length: leading }, () => null).concat(cells);
  const monthLabels = [];
  let lastMonth = '';
  padded.forEach((item, index) => {
    if (!item) return;
    const month = String(item.date).slice(5, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      monthLabels.push({ month, column: Math.floor(index / 7) + 1 });
    }
  });
  return [
    '<div class="usage-info-calendar">',
    '<div class="usage-info-calendar-head">',
    '<span>' + (isZh ? 'Token 活动' : 'Token activity') + '</span>',
    '</div>',
    '<div class="usage-info-calendar-scroll">',
    '<div class="usage-info-calendar-grid">',
    padded.map((item) => {
      if (!item) return '<div class="usage-info-calendar-cell ghost"></div>';
      const level = item.total <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((item.total / max) * 4)));
      const tip = item.date + '\n' + (isZh ? 'Token 增量 ' : 'Token delta ') + usageInfoNumber(item.total);
      return '<div class="usage-info-calendar-cell level-' + level + '" data-tip="' + escapeHtml(tip) + '"></div>';
    }).join(''),
    '</div>',
    '<div class="usage-info-calendar-months">',
    monthLabels.map((item) => '<span style="grid-column:' + item.column + '">' + Number(item.month) + (isZh ? '月' : '') + '</span>').join(''),
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderUsageInfoMainChart(daily, from, to, events) {
  const state = getUsageInfoState();
  if (state.chartModel === '__all__' && state.chartView === 'bar') state.chartView = 'trend';
  if (state.chartModel !== '__all__' && state.chartView === 'calendar') state.chartView = 'trend';
  if (state.chartView === 'calendar') return renderUsageInfoCalendar();
  if (state.chartView === 'bar') return renderUsageInfoBars(daily, from, to, events);
  return renderUsageInfoTrend(daily, from, to, events);
}

function renderUsageInfoChartControls(events) {
  const isZh = currentLanguage === 'zh';
  const state = getUsageInfoState();
  const models = usageInfoModelOptions(events).slice(0, 12);
  const selectedLabel = state.chartModel === '__all__' ? (isZh ? '全部模型' : 'All models') : state.chartModel;
  const chartViewOptions = state.chartModel === '__all__'
    ? [
        ['trend', isZh ? '趋势' : 'Trend'],
        ['calendar', isZh ? '日历' : 'Calendar'],
      ]
    : [
        ['trend', isZh ? '趋势' : 'Trend'],
        ['bar', isZh ? '详情' : 'Detail'],
      ];
  return [
    '<div class="usage-info-chart-controls">',
    chartViewOptions.map(([value, label]) => '<button class="' + (state.chartView === value ? 'active' : '') + '" type="button" onclick="setUsageInfoChartView(\'' + value + '\')">' + escapeHtml(label) + '</button>').join(''),
    '<div class="usage-info-dropdown usage-info-chart-model-dropdown">',
    '<button class="usage-info-dropdown-trigger" type="button" onclick="toggleUsageInfoChartModelMenu(event)">',
    '<span>' + escapeHtml(selectedLabel) + '</span><span class="usage-info-dropdown-arrow">⌄</span>',
    '</button>',
    '<div class="usage-info-dropdown-menu' + (state.chartModelMenuOpen ? ' open' : '') + '">',
    '<button class="' + (state.chartModel === '__all__' ? 'active' : '') + '" type="button" data-model="__all__" onclick="setUsageInfoChartModelFromButton(this)">' + (isZh ? '全部模型' : 'All models') + '</button>',
    models.map(([model]) => '<button class="' + (state.chartModel === model ? 'active' : '') + '" type="button" data-model="' + escapeHtml(model) + '" onclick="setUsageInfoChartModelFromButton(this)">' + escapeHtml(model) + '</button>').join(''),
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderUsageInfoGroups(groups, totals) {
  const isZh = currentLanguage === 'zh';
  const rows = Array.isArray(groups) ? groups : [];
  const max = rows.reduce((acc, item) => Math.max(acc, item?.totals?.totalTokens || 0), 0);
  if (!rows.length) {
    return '<div class="usage-info-empty">' + (isZh ? '没有匹配的分组。' : 'No matching groups.') + '</div>';
  }
  return [
    '<div class="usage-info-rank">',
    rows.map((item) => {
      const rowTotals = item.totals || {};
      const total = rowTotals.totalTokens || 0;
      const pct = usageInfoPct(total, totals?.totalTokens || max);
      const width = max > 0 ? Math.max(2, Math.round((total / max) * 100)) : 2;
      const metaParts = [];
      if (item.presetName && item.presetName !== item.label) {
        metaParts.push(typeof formatPresetDisplayName === 'function' ? formatPresetDisplayName(item.presetName) : item.presetName);
      }
      if (item.provider) metaParts.push(item.provider);
      if (item.source && item.source !== item.label) metaParts.push(item.source);
      return [
        '<div class="usage-info-rank-row">',
        '<div class="usage-info-rank-main">',
        '<div class="usage-info-rank-title">' + escapeHtml(item.label || item.key || '') + '</div>',
        '<div class="usage-info-rank-meta">' + escapeHtml(metaParts.join(' · ') || (isZh ? '无额外归因' : 'No extra attribution')) + '</div>',
        '<div class="usage-info-rank-bar"><span style="width:' + width + '%"></span></div>',
        '</div>',
        '<div class="usage-info-rank-value">',
        '<strong>' + usageInfoNumber(total) + '</strong>',
        '<span>' + pct + '% · ' + usageInfoNumber(rowTotals.requests || 0) + ' req</span>',
        '</div>',
        '</div>',
      ].join('');
    }).join(''),
    '</div>',
  ].join('');
}

function renderUsageInfoEvents(events) {
  const isZh = currentLanguage === 'zh';
  const rows = Array.isArray(events) ? events.slice(0, 30) : [];
  if (!rows.length) {
    return '<div class="usage-info-empty">' + (isZh ? '暂无最近事件。' : 'No recent events.') + '</div>';
  }
  return [
    '<div class="usage-info-events">',
    rows.map((event) => {
      const when = event.timestamp ? new Date(event.timestamp).toLocaleString() : '';
      const evPreset = event.model?.presetName;
      const model = (evPreset && evPreset !== '__default__') ? evPreset : (event.model?.modelName || (isZh ? '未知模型' : 'Unknown model'));
      const usage = event.usage || {};
      const bits = [
        (event.source || 'unknown'),
        event.agentId || '',
        event.sessionId ? event.sessionId.slice(0, 16) : '',
      ].filter(Boolean).join(' · ');
      return [
        '<div class="usage-info-event-row">',
        '<div class="usage-info-event-main">',
        '<div class="usage-info-event-title">' + escapeHtml(model) + '</div>',
        '<div class="usage-info-event-meta">' + escapeHtml(bits) + '</div>',
        '</div>',
        '<div class="usage-info-event-side">',
        '<strong>' + usageInfoNumber(usage.totalTokens || 0) + '</strong>',
        '<span>' + escapeHtml(when) + '</span>',
        '</div>',
        '</div>',
      ].join('');
    }).join(''),
    '</div>',
  ].join('');
}

function renderUsageInfoGroupControls(groupOptions, state, isZh) {
  return [
    '<div class="usage-info-group-controls">',
    '<div class="usage-info-dropdown">',
    '<button class="usage-info-dropdown-trigger" type="button" onclick="toggleUsageInfoGroupMenu(event)">',
    '<span>' + escapeHtml(usageInfoLabel(state.groupBy)) + '</span><span class="usage-info-dropdown-arrow">⌄</span>',
    '</button>',
    '<div class="usage-info-dropdown-menu' + (state.groupMenuOpen ? ' open' : '') + '">',
    groupOptions.map((value) => '<button class="' + (state.groupBy === value ? 'active' : '') + '" type="button" onclick="setUsageInfoGroupBy(\'' + value + '\')">' + escapeHtml(usageInfoLabel(value)) + '</button>').join(''),
    '</div>',
    '</div>',
    '<input class="settings-input usage-info-search" value="' + escapeHtml(state.search || '') + '" placeholder="' + (isZh ? '搜索分组' : 'Search breakdown') + '" oninput="queueUsageInfoSearch(this.value)" onblur="setUsageInfoSearch(this.value)" onkeydown="if(event.key===\'Enter\') setUsageInfoSearch(this.value)">',
    '</div>',
  ].join('');
}

function renderUsageInfoOverlay() {
  const host = ensureUsageInfoHost();
  const state = getUsageInfoState();
  if (!state.open) {
    host.innerHTML = '';
    return;
  }
  const isZh = currentLanguage === 'zh';
  const data = state.data || {};
  const totals = data.totals || {};
  const cacheRate = usageInfoPct(totals.cacheHitRequests || 0, totals.requests || 0);
  const inputShare = usageInfoPct(totals.inputTokens || 0, totals.totalTokens || 0);
  const outputShare = usageInfoPct(totals.outputTokens || 0, totals.totalTokens || 0);
  const rangeOptions = [
    ['today', isZh ? '今天' : 'Today'],
    ['7d', isZh ? '近 7 天' : '7 days'],
    ['30d', isZh ? '近 30 天' : '30 days'],
  ];
  const groupOptions = ['model', 'preset', 'agent', 'source', 'date'];
  const chartTitle = state.chartView === 'calendar'
    ? (isZh ? '日期热力' : 'Date heat')
    : state.chartView === 'bar'
      ? (isZh ? '模型详情' : 'Model detail')
      : (isZh ? '用量趋势' : 'Usage trend');

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window usage-info-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '用量信息' : 'Usage') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml((state.from || '') + ' ~ ' + (state.to || '')) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeUsageInfo()">×</button>',
    '</div>',

    '<div class="usage-info-toolbar">',
    '<div class="usage-info-segment">',
    rangeOptions.map(([value, label]) => (
      '<button class="' + (state.range === value ? 'active' : '') + '" type="button" onclick="setUsageInfoRange(\'' + value + '\')">' + escapeHtml(label) + '</button>'
    )).join(''),
    '</div>',
    '</div>',

    state.error ? '<div class="usage-info-error">' + escapeHtml(state.error) + '</div>' : '',

    '<div class="usage-info-metrics">',
    renderUsageMetric(isZh ? '总 Token' : 'Total tokens', usageInfoNumber(totals.totalTokens || 0), usageInfoFullNumber(totals.totalTokens || 0)),
    renderUsageMetric(isZh ? '输入 / 输出' : 'Input / Output', usageInfoNumber(totals.inputTokens || 0) + ' / ' + usageInfoNumber(totals.outputTokens || 0), inputShare + '% / ' + outputShare + '%'),
    renderUsageMetric(isZh ? '缓存读取' : 'Cache read', usageInfoNumber(totals.cacheReadTokens || 0), cacheRate + '% ' + (isZh ? '请求命中' : 'request hit')),
    renderUsageMetric(isZh ? '请求数' : 'Requests', usageInfoFullNumber(totals.requests || 0), usageInfoFullNumber(data.eventCount || 0) + ' events'),
    '</div>',

    '<div class="usage-info-layout">',
    '<section class="usage-info-section usage-info-chart-section">',
    '<div class="usage-info-section-head usage-info-section-head-controls"><span>' + chartTitle + '</span>' + renderUsageInfoChartControls(data.events) + '</div>',
    renderUsageInfoMainChart(data.daily, state.from, state.to, data.events),
    '</section>',
    '<section class="usage-info-section usage-info-list-section">',
    '<div class="usage-info-section-head usage-info-section-head-controls"><span>' + (isZh ? '分组排行' : 'Breakdown') + '</span>' + renderUsageInfoGroupControls(groupOptions, state, isZh) + '</div>',
    '<div class="usage-info-list-body">',
    renderUsageInfoGroups(data.groups, totals),
    '</div>',
    '</section>',
    '<section class="usage-info-section usage-info-list-section">',
    '<div class="usage-info-section-head"><span>' + (isZh ? '最近事件' : 'Recent events') + '</span><small>' + (isZh ? '增量记录' : 'incremental') + '</small></div>',
    '<div class="usage-info-list-body">',
    renderUsageInfoEvents(data.recentEvents),
    '</div>',
    '</section>',
    '<div id="usage-info-tooltip" class="usage-info-tooltip"></div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
  bindUsageInfoTooltip(host);
  scrollUsageInfoCalendarToLatest(host);
}

window.setUsageInfoRange = async function(range) {
  const state = getUsageInfoState();
  state.range = range;
  await loadUsageInfoData();
};

window.setUsageInfoGroupBy = async function(groupBy) {
  const state = getUsageInfoState();
  state.groupBy = groupBy;
  state.groupMenuOpen = false;
  await loadUsageInfoData();
};

window.toggleUsageInfoGroupMenu = function(event) {
  if (event) event.stopPropagation();
  const state = getUsageInfoState();
  state.groupMenuOpen = !state.groupMenuOpen;
  renderUsageInfoOverlay();
};

window.setUsageInfoSearch = async function(search) {
  const state = getUsageInfoState();
  state.search = String(search || '').trim();
  await loadUsageInfoData();
};

window.queueUsageInfoSearch = function(search) {
  const state = getUsageInfoState();
  state.search = String(search || '').trim();
};

function bindUsageInfoTooltip(host) {
  const tooltip = host.querySelector('#usage-info-tooltip');
  if (!tooltip) return;
  host.querySelectorAll('[data-tip]').forEach((node) => {
    node.addEventListener('mouseenter', (event) => {
      const text = node.getAttribute('data-tip') || '';
      tooltip.innerHTML = escapeHtml(text).replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
      tooltip.classList.add('visible');
      setUsageInfoGuide(host, node.getAttribute('data-guide-target'), true);
      moveUsageInfoTooltip(event, tooltip);
    });
    node.addEventListener('mousemove', (event) => {
      setUsageInfoGuide(host, node.getAttribute('data-guide-target'), true);
      moveUsageInfoTooltip(event, tooltip);
    });
    node.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
      setUsageInfoGuide(host, node.getAttribute('data-guide-target'), false);
    });
  });
}

function setUsageInfoGuide(host, index, active) {
  if (index == null || index === '') return;
  host.querySelectorAll('.usage-info-trend-guide.active').forEach((line) => line.classList.remove('active'));
  if (!active) return;
  host.querySelectorAll('.usage-info-trend-guide[data-guide="' + CSS.escape(String(index)) + '"]').forEach((line) => line.classList.add('active'));
}

function scrollUsageInfoCalendarToLatest(host) {
  host.querySelectorAll('.usage-info-calendar-scroll').forEach((node) => {
    node.scrollLeft = node.scrollWidth;
  });
}

function moveUsageInfoTooltip(event, tooltip) {
  const rect = tooltip.parentElement.getBoundingClientRect();
  tooltip.style.left = Math.min(rect.width - 190, Math.max(8, event.clientX - rect.left + 12)) + 'px';
  tooltip.style.top = Math.max(8, event.clientY - rect.top - 12) + 'px';
}

window.setUsageInfoChartView = function(chartView) {
  const state = getUsageInfoState();
  state.chartView = chartView;
  renderUsageInfoOverlay();
};

window.toggleUsageInfoChartModelMenu = function(event) {
  if (event) event.stopPropagation();
  const state = getUsageInfoState();
  state.chartModelMenuOpen = !state.chartModelMenuOpen;
  renderUsageInfoOverlay();
};

window.setUsageInfoChartModelFromButton = function(button) {
  const state = getUsageInfoState();
  state.chartModel = button?.dataset?.model || '__all__';
  if (state.chartModel === '__all__' && state.chartView === 'bar') state.chartView = 'trend';
  if (state.chartModel !== '__all__' && state.chartView === 'calendar') state.chartView = 'trend';
  state.chartModelMenuOpen = false;
  renderUsageInfoOverlay();
};

// ── window 导出 ──────────────────────────────────────────────
window.openUsageInfo = openUsageInfo;
window.closeUsageInfo = closeUsageInfo;
window.loadUsageInfoData = loadUsageInfoData;
