/**
 * settings-overlay.js — 模型设置覆盖层模块（从 app-ui.js 提取）
 *
 * 包含：模型预设管理、语音模型配置、API Key 可视性切换等。
 * 依赖（全局）：escapeHtml, currentLanguage, getCurrentAgentRecord, updateChatContextBar
 */

function ensureSettingsHost() {
  let host = document.getElementById('settings-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'settings-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

async function openSettings() {
  window.ClawFW.settingsOpen = true;
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  window.ClawFW._speechModelConfig = null;
  window.ClawFW._speechPresets = [];
  renderSettingsOverlay();
  try {
    const [modelResp, speechResp] = await Promise.all([
      fetch('/protoclaw/model_config'),
      fetch('/protoclaw/speech_model_config'),
    ]);
    const data = await modelResp.json();
    window.ClawFW.settingsData = data;
    window.ClawFW._modelPresets = Array.isArray(data?.presets) ? data.presets : [];
    try {
      const speechData = await speechResp.json();
      window.ClawFW._speechModelConfig = speechData?.speechModel || null;
      window.ClawFW._speechPresets = Array.isArray(speechData?.speechPresets) ? speechData.speechPresets : [];
    } catch (e) { /* speech config may not exist yet */ }
    renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to load model config:', error);
  }
}

function closeSettings() {
  window.ClawFW.settingsOpen = false;
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  window.ClawFW._speechEditing = null;
  window.ClawFW._speechPresets = [];
  const host = document.getElementById('settings-overlay-host');
  if (host) host.innerHTML = '';
}

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
    calendarMode: 'daily',
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

async function openUsageInfo() {
  const state = getUsageInfoState();
  Object.assign(state, usageInfoDefaults(), { open: true });
  renderUsageInfoOverlay();
  await loadUsageInfoData();
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
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K';
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
    const model = event?.model?.presetName || event?.model?.modelName || 'unknown';
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
      const label = event?.model?.presetName || event?.model?.modelName || 'unknown';
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
        .map(([model, stats]) => model + '  ' + usageInfoFullNumber(stats.total || 0));
      const tip = usingAllModels
        ? [
            item.title,
            (isZh ? '总量' : 'Total') + ' ' + usageInfoFullNumber(total),
            ...(modelLines.length ? modelLines : [isZh ? '暂无模型明细' : 'No model detail']),
          ].join('\n')
        : [
            item.title,
            selectedModel,
            (isZh ? '总量' : 'Total') + ' ' + usageInfoFullNumber(total),
            (isZh ? '请求' : 'Requests') + ' ' + usageInfoFullNumber(value.requests || 0),
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
        (isZh ? '总量' : 'Total') + ' ' + usageInfoFullNumber(total),
        (isZh ? '输入（命中缓存）' : 'Input cached') + ' ' + usageInfoFullNumber(cached),
        (isZh ? '输入（未命中缓存）' : 'Input uncached') + ' ' + usageInfoFullNumber(uncached),
        (isZh ? '输出' : 'Output') + ' ' + usageInfoFullNumber(output),
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

function renderUsageInfoCalendar(daily, from, to) {
  const isZh = currentLanguage === 'zh';
  const state = getUsageInfoState();
  const end = usageInfoParseLocalDate(to || usageInfoToday());
  const start = new Date(end.getTime() - 364 * 86400000);
  const dates = usageInfoDateRange(usageInfoLocalDateString(start), usageInfoLocalDateString(end));
  const byDate = new Map((Array.isArray(daily) ? daily : []).map((item) => [item.date, item]));
  const cells = dates.map((date) => ({ date, rawTotal: byDate.get(date)?.totals?.totalTokens || 0, total: byDate.get(date)?.totals?.totalTokens || 0 }));
  if (state.calendarMode === 'weekly') {
    for (let index = 0; index < cells.length; index += 7) {
      const sum = cells.slice(index, index + 7).reduce((acc, item) => acc + item.rawTotal, 0);
      cells.slice(index, index + 7).forEach((item) => { item.total = sum; });
    }
  } else if (state.calendarMode === 'cumulative') {
    let running = 0;
    cells.forEach((item) => {
      running += item.rawTotal;
      item.total = running;
    });
  }
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
    '<div>',
    [['daily', isZh ? '每日' : 'Daily'], ['weekly', isZh ? '每周' : 'Weekly'], ['cumulative', isZh ? '累计' : 'Total']].map(([value, label]) => (
      '<button class="' + (state.calendarMode === value ? 'active' : '') + '" type="button" onclick="setUsageInfoCalendarMode(\'' + value + '\')">' + escapeHtml(label) + '</button>'
    )).join(''),
    '</div>',
    '</div>',
    '<div class="usage-info-calendar-scroll">',
    '<div class="usage-info-calendar-grid">',
    padded.map((item) => {
      if (!item) return '<div class="usage-info-calendar-cell ghost"></div>';
      const level = item.total <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((item.total / max) * 4)));
      const tip = item.date + '\n' + (isZh ? 'Token 增量 ' : 'Token delta ') + usageInfoFullNumber(item.rawTotal) + '\n' + (isZh ? '当前口径 ' : 'Current view ') + usageInfoFullNumber(item.total);
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
  if (state.chartView === 'calendar') return renderUsageInfoCalendar(daily, from, to);
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
      if (item.presetName && item.presetName !== item.label) metaParts.push(item.presetName);
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
        '<span>' + pct + '% · ' + usageInfoFullNumber(rowTotals.requests || 0) + ' req</span>',
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
      const model = event.model?.presetName || event.model?.modelName || (isZh ? '未知模型' : 'Unknown model');
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

window.setUsageInfoCalendarMode = function(calendarMode) {
  const state = getUsageInfoState();
  state.calendarMode = calendarMode;
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

function renderSettingsOverlay() {
  const host = ensureSettingsHost();
  if (!window.ClawFW.settingsOpen) {
    host.innerHTML = '';
    return;
  }
  const data = window.ClawFW.settingsData;
  const config = data?.config || { defaultModel: {}, agent: {} };
  const presets = Array.isArray(data?.presets) ? data.presets : [];
  const dm = config.defaultModel || {};
  const ag = config.agent || {};
  const editing = window.ClawFW.settingsEditing;
  const isZh = currentLanguage === 'zh';
  const activeTab = window.ClawFW.settingsTab || 'text';

  // ── Find active preset name ──
  const activePreset = presets.find(function(p) {
    return dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
  });
  const activePresetName = activePreset
    ? (activePreset.name || activePreset.model || '')
    : '';

  const presetCards = presets.length
    ? presets.map((p, idx) => {
        const isActive = dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
        return [
          '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySettingsPreset(' + idx + ')">',
          '<div class="settings-preset-dot"></div>',
          '<div class="settings-preset-info">',
          '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
          '<div class="settings-preset-detail">' + escapeHtml((p.provider || '—') + ' · ' + (p.model || '—')) + '</div>',
          '</div>',
          '<div class="settings-preset-actions">',
          '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();editSettingsPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
          '</button>',
          '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();deleteSettingsPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
          '</button>',
          '</div>',
          '</div>',
        ].join('');
      }).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">' + (isZh ? '暂无预设，点击下方按钮添加' : 'No presets yet. Click the button below to add one') + '</div>';

  // ── Tab bar ──
  const tabText = activeTab === 'text';
  const tabBar = [
    '<div class="settings-tab-bar">',
    '<button class="settings-tab' + (tabText ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'text\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
    (isZh ? '文本模型' : 'Text Model'),
    '</button>',
    '<button class="settings-tab' + (!tabText ? ' active' : '') + '" type="button" onclick="switchSettingsTab(\'speech\')">',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>',
    (isZh ? '语音模型' : 'Speech Model'),
    '</button>',
    '</div>',
  ].join('');

  // ── Tab content ──
  let tabContent = '';

  if (tabText) {
    // Text model tab
    const activeBanner = [
      '<div class="settings-active-banner">',
      '<div class="settings-active-icon">',
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
      '</div>',
      '<div class="settings-active-info">',
      '<div class="settings-active-label">' + (isZh ? '当前激活' : 'ACTIVE') + '</div>',
      '<div class="settings-active-name">' + escapeHtml(activePresetName || dm.model || (isZh ? '未选择预设' : 'No preset selected')) + '</div>',
      '<div class="settings-active-detail">' + escapeHtml((dm.provider || '—') + (dm.model ? ' · ' + dm.model : '') + (dm.baseUrl ? ' · ' + dm.baseUrl : '')) + '</div>',
      '</div>',
      activePresetName ? '<div class="settings-active-badge">' + (isZh ? '预设' : 'Preset') + '</div>' : '',
      '</div>',
    ].join('');

    tabContent = [
      /* Active Config Banner (always visible) */
      '<div class="settings-section">',
      activeBanner,
      '</div>',

      /* Presets Section (hidden when editing) */
      editing === null ? [
        '<div class="settings-section">',
        '<div class="settings-section-title">' + (isZh ? '预设列表' : 'Presets') + '</div>',
        '<div class="settings-presets-grid">' + presetCards + '</div>',
        '<button class="settings-btn settings-btn-secondary" type="button" style="align-self:flex-start;margin-top:4px;" onclick="addSettingsPreset()">+ ' + (isZh ? '添加预设' : 'Add Preset') + '</button>',
        '</div>',
      ].join('') : '',

      /* Edit Form (inline) */
      editing !== null ? renderSettingsEditForm(editing, presets, isZh) : '',
    ].join('');
  } else {
    // Speech model tab
    tabContent = renderSpeechModelSection(isZh);
  }

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,560px);max-height:min(100%,720px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '模型设置' : 'Model Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '管理模型预设与配置' : 'Manage model presets and configurations') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeSettings()">×</button>',
    '</div>',

    tabBar,
    '<div class="settings-tab-content">',
    tabContent,
    '</div>',

    '</div>',
    '</div>',
  ].join('');
}

window.switchSettingsTab = function(tab) {
  window.ClawFW.settingsTab = tab;
  renderSettingsOverlay();
};

function renderSpeechModelSection(isZh) {
  const sc = window.ClawFW._speechModelConfig || {};
  const presets = window.ClawFW._speechPresets || [];
  const speechEditing = window.ClawFW._speechEditing; // null = not editing, 'new' = new preset, number = edit existing
  const configured = !!(sc.baseUrl && sc.apiKey);

  // Find active preset
  const activePreset = presets.find(function(p) {
    return p.baseUrl === sc.baseUrl && p.apiKey === sc.apiKey && p.model === sc.model;
  });
  const activePresetName = activePreset ? (activePreset.name || activePreset.model || '') : '';

  // Active banner
  const activeBanner = [
    '<div class="settings-active-banner">',
    '<div class="settings-active-icon">',
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>',
    '</div>',
    '<div class="settings-active-info">',
    '<div class="settings-active-label">' + (isZh ? '当前激活' : 'ACTIVE') + '</div>',
    configured
      ? '<div class="settings-active-name">' + escapeHtml(activePresetName || sc.model || (isZh ? '自定义配置' : 'Custom Config')) + '</div>' +
        '<div class="settings-active-detail">' + escapeHtml((sc.model || '—') + (sc.language ? ' · ' + sc.language : '') + (sc.baseUrl ? ' · ' + sc.baseUrl : '')) + '</div>'
      : '<div class="settings-active-name">' + (isZh ? '未配置' : 'Not Configured') + '</div>' +
        '<div class="settings-active-detail">' + (isZh ? '请添加并激活一个语音模型预设' : 'Add and activate a speech model preset') + '</div>',
    '</div>',
    activePresetName ? '<div class="settings-active-badge">' + (isZh ? '预设' : 'Preset') + '</div>' : '',
    '</div>',
  ].join('');

  // If editing a preset, show edit form
  if (speechEditing != null) {
    const editPreset = speechEditing === 'new'
      ? { name: '', baseUrl: '', apiKey: '', model: 'mimo-v2.5-asr', language: 'auto' }
      : (presets[speechEditing] || {});
    return [
      '<div class="settings-section">',
      activeBanner,
      '</div>',
      renderSpeechPresetEditForm(editPreset, speechEditing, isZh),
    ].join('');
  }

  // Preset list
  const presetCards = presets.length
    ? presets.map(function(p, idx) {
        const isActive = p.baseUrl === sc.baseUrl && p.apiKey === sc.apiKey && p.model === sc.model;
        return [
          '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySpeechPreset(' + idx + ')">',
          '<div class="settings-preset-dot"></div>',
          '<div class="settings-preset-info">',
          '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
          '<div class="settings-preset-detail">' + escapeHtml((p.model || '—') + (p.language ? ' · ' + p.language : '')) + '</div>',
          '</div>',
          '<div class="settings-preset-actions">',
          '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();editSpeechPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
          '</button>',
          '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();deleteSpeechPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
          '</button>',
          '</div>',
          '</div>',
        ].join('');
      }).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">' + (isZh ? '暂无预设，点击下方按钮添加' : 'No presets yet. Click below to add one') + '</div>';

  return [
    '<div class="settings-section">',
    activeBanner,
    '</div>',
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isZh ? '语音预设列表' : 'Speech Presets') + '</div>',
    '<div class="settings-presets-compact">' + presetCards + '</div>',
    '<button class="settings-btn settings-btn-secondary" type="button" style="align-self:flex-start;margin-top:4px;" onclick="addSpeechPreset()">+ ' + (isZh ? '添加预设' : 'Add Preset') + '</button>',
    '</div>',
  ].join('');
}

function renderSpeechPresetEditForm(preset, editIdx, isZh) {
  const isNew = editIdx === 'new';
  return [
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isNew ? (isZh ? '新建语音预设' : 'New Speech Preset') : (isZh ? '编辑语音预设' : 'Edit Speech Preset')) + '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '名称' : 'Name') + '</label>',
    '<input class="settings-input" id="speech-preset-name" type="text" value="' + escapeHtml(preset.name || '') + '" placeholder="' + (isZh ? '例如：小米 MiMo ASR' : 'e.g. MiMo ASR') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>Base URL</label>',
    '<input class="settings-input" id="speech-preset-baseurl" type="text" value="' + escapeHtml(preset.baseUrl || '') + '" placeholder="https://api.xiaomimimo.com/v1">',
    '</div>',
    '<div class="settings-field">',
    '<label>API Key</label>',
    '<input class="settings-input" id="speech-preset-apikey" type="password" value="' + escapeHtml(preset.apiKey || '') + '" placeholder="sk-...">',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Model</label>',
    '<input class="settings-input" id="speech-preset-model" type="text" value="' + escapeHtml(preset.model || 'mimo-v2.5-asr') + '" placeholder="mimo-v2.5-asr">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '语言' : 'Language') + '</label>',
    '<select class="settings-input" id="speech-preset-language">',
    '<option value="auto"' + ((preset.language || 'auto') === 'auto' ? ' selected' : '') + '>' + (isZh ? '自动检测' : 'Auto Detect') + '</option>',
    '<option value="zh"' + (preset.language === 'zh' ? ' selected' : '') + '>' + (isZh ? '中文' : 'Chinese') + '</option>',
    '<option value="en"' + (preset.language === 'en' ? ' selected' : '') + '>' + (isZh ? '英文' : 'English') + '</option>',
    '</select>',
    '</div>',
    '</div>',
    '<div class="settings-actions">',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSpeechPresetEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="saveSpeechPreset(\'' + editIdx + '\')">' + (isZh ? '保存' : 'Save') + '</button>',
    '</div>',
    '</div>',
  ].join('');
}

window.addSpeechPreset = function() {
  window.ClawFW._speechEditing = 'new';
  renderSettingsOverlay();
};

window.editSpeechPreset = function(idx) {
  window.ClawFW._speechEditing = idx;
  renderSettingsOverlay();
};

window.cancelSpeechPresetEdit = function() {
  window.ClawFW._speechEditing = null;
  renderSettingsOverlay();
};

window.deleteSpeechPreset = async function(idx) {
  const presets = window.ClawFW._speechPresets || [];
  presets.splice(idx, 1);
  window.ClawFW._speechPresets = presets;
  window.ClawFW._speechEditing = null;
  await saveSpeechFullConfig();
};

window.applySpeechPreset = async function(idx) {
  const presets = window.ClawFW._speechPresets || [];
  const preset = presets[idx];
  if (!preset) return;
  // Set as active speech model
  window.ClawFW._speechModelConfig = {
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
    model: preset.model || 'mimo-v2.5-asr',
    language: preset.language || 'auto',
  };
  await saveSpeechFullConfig();
};

window.saveSpeechPreset = async function(editIdx) {
  const el = (id) => document.getElementById(id);
  const preset = {
    name: (el('speech-preset-name')?.value || '').trim(),
    baseUrl: (el('speech-preset-baseurl')?.value || '').trim(),
    apiKey: (el('speech-preset-apikey')?.value || '').trim(),
    model: (el('speech-preset-model')?.value || '').trim() || 'mimo-v2.5-asr',
    language: el('speech-preset-language')?.value || 'auto',
  };
  const presets = window.ClawFW._speechPresets || [];
  if (editIdx === 'new') {
    presets.push(preset);
  } else {
    presets[editIdx] = preset;
  }
  window.ClawFW._speechPresets = presets;
  window.ClawFW._speechEditing = null;
  await saveSpeechFullConfig();
};

async function saveSpeechFullConfig() {
  const speechModel = window.ClawFW._speechModelConfig || { baseUrl: '', apiKey: '', model: 'mimo-v2.5-asr', language: 'auto' };
  const speechPresets = window.ClawFW._speechPresets || [];
  try {
    const resp = await fetch('/protoclaw/speech_model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speechModel, speechPresets }),
    });
    const result = await resp.json();
    window.ClawFW._speechModelConfig = result.speechModel;
    window.ClawFW._speechPresets = Array.isArray(result.speechPresets) ? result.speechPresets : [];
    renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to save speech model config:', error);
  }
}

function renderSettingsEditForm(editIdx, presets, isZh) {
  const preset = presets[editIdx] || {};
  const isNew = preset._isNew;
  return [
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isNew ? (isZh ? '新建预设' : 'New Preset') : (isZh ? '编辑预设' : 'Edit Preset')) + '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '名称' : 'Name') + '</label>',
    '<input class="settings-input" id="settings-preset-name" type="text" value="' + escapeHtml(preset.name || '') + '" placeholder="' + (isZh ? '例如：智谱 GLM-5' : 'e.g. ZhiPu GLM-5') + '">',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '接口协议' : 'Protocol') + '</label>',
    '<select class="settings-input" id="settings-preset-provider">',
    '<option value="anthropic"' + (preset.provider === 'anthropic' ? ' selected' : '') + '>Anthropic</option>',
    '<option value="openai"' + (preset.provider === 'openai' && (preset.apiSurface || 'chat') !== 'responses' ? ' selected' : '') + '>OpenAI Chat</option>',
    '<option value="openai-responses"' + (preset.provider === 'openai' && (preset.apiSurface || 'chat') === 'responses' ? ' selected' : '') + '>OpenAI Responses</option>',
    '</select>',
    '</div>',
    '<div class="settings-field">',
    '<label>Model</label>',
    '<input class="settings-input" id="settings-preset-model" type="text" value="' + escapeHtml(preset.model || '') + '" placeholder="glm-5-turbo">',
    '</div>',
    '</div>',
    '<div class="settings-field">',
    '<label>Base URL</label>',
    '<input class="settings-input" id="settings-preset-baseurl" type="text" value="' + escapeHtml(preset.baseUrl || '') + '" placeholder="https://open.bigmodel.cn/api/anthropic">',
    '</div>',
    '<div class="settings-field">',
    '<label>API Key</label>',
    '<div style="position:relative;display:flex;align-items:stretch;">',
    '<input class="settings-input" id="settings-preset-apikey" type="password" value="' + escapeHtml(preset.apiKey || '') + '" placeholder="sk-..." style="padding-right:40px;">',
    '<button type="button" onclick="toggleApiKeyVisibility()" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);transition:color 0.2s;" onmouseover="this.style.color=\'var(--text-primary)\'" onmouseout="this.style.color=\'var(--text-secondary)\'" title="' + (isZh ? '显示/隐藏' : 'Show/Hide') + '">',
    '<svg id="apikey-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>',
    '<circle cx="12" cy="12" r="3"></circle>',
    '</svg>',
    '<svg id="apikey-eye-off-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">',
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>',
    '<line x1="1" y1="1" x2="23" y2="23"></line>',
    '</svg>',
    '</button>',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Thinking Budget Tokens</label>',
    '<input class="settings-input" id="settings-preset-thinking" type="number" value="' + (preset.thinkingBudgetTokens ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>Max Output Tokens</label>',
    '<input class="settings-input" id="settings-preset-max-tokens" type="number" value="' + (preset.maxTokens ?? '') + '" placeholder="' + (isZh ? '留空自动计算' : 'Leave empty for auto') + '">',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + (isZh ? '含思考内容的总输出上限。留空时框架会根据思考预算自动推算' : 'Total output cap incl. thinking. Auto-calculated from thinking budget when empty') + '</div>',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Temperature</label>',
    '<input class="settings-input" id="settings-preset-temperature" type="number" step="0.1" min="0" max="2" value="' + (preset.temperature ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '上下文长度' : 'Context Length') + '</label>',
    '<input class="settings-input" id="settings-preset-context-length" type="number" value="' + (preset.contextLength ?? '') + '" placeholder="200000">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '压缩阈值' : 'Compress Threshold') + '</label>',
    '<input class="settings-input" id="settings-preset-compress-ratio" type="number" min="1" max="100" value="' + (preset.compressRatio ?? 80) + '" placeholder="80">',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + (isZh ? '上下文占用达到此比例时触发压缩 (1-100%)' : 'Trigger compression at this context usage (1-100%)') + '</div>',
    '</div>',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? 'Count Token 路径' : 'Count Token Path') + '</label>',
    '<input class="settings-input" id="settings-preset-count-token-path" type="text" value="' + escapeHtml(preset.countTokenPath || '') + '" placeholder="/v1/messages/count_tokens">',
    '</div>',
    /* Custom Headers Section */
    '<div class="settings-field">',
    '<label>' + (isZh ? '自定义请求头' : 'Custom Headers') + '</label>',
    '<div id="settings-headers-container">',
    (Array.isArray(preset.customHeaders) ? preset.customHeaders : []).map(function(h, i) {
      return createSettingsHeaderRowHTML(i, h.key || '', h.value || '', h.valueMode || 'static', isZh);
    }).join(''),
    '</div>',
    '<button class="settings-btn settings-btn-secondary" type="button" style="align-self:flex-start;margin-top:4px;" onclick="addSettingsHeaderRow()">+ ' + (isZh ? '添加 Header' : 'Add Header') + '</button>',
    '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">' + (isZh ?
      'UUID v4 / 随机数模式会在每次 API 请求时自动生成新值' :
      'UUID v4 / random mode generates a new value on each API request') + '</div>',
    '</div>',
    '<div class="settings-actions">',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSettingsEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="saveSettingsPreset(' + editIdx + ')">' + (isZh ? '保存' : 'Save') + '</button>',
    '</div>',
    '</div>',
  ].join('');
}

function createSettingsHeaderRowHTML(idx, key, value, mode, isZh) {
  var isDynamic = mode === 'uuid' || mode === 'random';
  var modeOptions = [
    '<option value="static"' + (mode === 'static' ? ' selected' : '') + '>' + (isZh ? '固定值' : 'Static') + '</option>',
    '<option value="uuid"' + (mode === 'uuid' ? ' selected' : '') + '>UUID v4</option>',
    '<option value="random"' + (mode === 'random' ? ' selected' : '') + '>' + (isZh ? '随机数' : 'Random') + '</option>',
  ].join('');
  return [
    '<div data-header-row style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">',
    '<input class="settings-input" data-header-key type="text" value="' + escapeHtml(key) + '" placeholder="' + (isZh ? 'Header 名' : 'Header name') + '" style="flex:1;min-width:0;">',
    '<select class="settings-input" data-header-mode style="width:90px;flex-shrink:0;" onchange="onSettingsHeaderModeChange(this)">' + modeOptions + '</select>',
    '<input class="settings-input" data-header-value type="text" value="' + escapeHtml(value) + '" placeholder="' + (isDynamic ? '(auto)' : (isZh ? 'Header 值' : 'Header value')) + '" style="flex:1;min-width:0;' + (isDynamic ? 'opacity:0.4;' : '') + '"' + (isDynamic ? ' disabled' : '') + '>',
    '<button type="button" onclick="this.closest(\'[data-header-row]\').remove()" style="background:none;border:none;cursor:pointer;padding:6px;color:var(--text-secondary);flex-shrink:0;" title="' + (isZh ? '删除' : 'Delete') + '">',
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    '</button>',
    '</div>',
  ].join('');
}

window.addSettingsHeaderRow = function() {
  var container = document.getElementById('settings-headers-container');
  if (!container) return;
  var isZh = currentLanguage === 'zh';
  container.insertAdjacentHTML('beforeend', createSettingsHeaderRowHTML(container.children.length, '', '', 'static', isZh));
};

window.onSettingsHeaderModeChange = function(select) {
  var row = select.closest('[data-header-row]');
  var valueInput = row ? row.querySelector('[data-header-value]') : null;
  if (!valueInput) return;
  var isDynamic = select.value === 'uuid' || select.value === 'random';
  var isZh = currentLanguage === 'zh';
  valueInput.disabled = isDynamic;
  valueInput.placeholder = isDynamic ? '(auto)' : (isZh ? 'Header 值' : 'Header value');
  valueInput.style.opacity = isDynamic ? '0.4' : '';
};

function addSettingsPreset() {
  const presets = window.ClawFW.settingsData?.presets || [];
  presets.push({
    _isNew: true,
    name: '',
    provider: 'anthropic',
    apiSurface: 'chat',
    model: '',
    baseUrl: '',
    apiKey: '',
    thinkingBudgetTokens: null,
    maxTokens: null,
    temperature: null,
    contextLength: null,
    compressRatio: 80,
    customHeaders: [],
  });
  window.ClawFW.settingsData = window.ClawFW.settingsData || {};
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = presets.length - 1;
  renderSettingsOverlay();
}

function editSettingsPreset(idx) {
  window.ClawFW.settingsEditing = idx;
  renderSettingsOverlay();
}

function cancelSettingsEdit() {
  const presets = window.ClawFW.settingsData?.presets || [];
  const editing = window.ClawFW.settingsEditing;
  if (editing !== null && presets[editing]?._isNew) {
    presets.splice(editing, 1);
  }
  window.ClawFW.settingsEditing = null;
  renderSettingsOverlay();
}

async function deleteSettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  presets.splice(idx, 1);
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = null;
  await saveSettingsConfig();
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('settings-preset-apikey');
  const eyeIcon = document.getElementById('apikey-eye-icon');
  const eyeOffIcon = document.getElementById('apikey-eye-off-icon');

  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon) eyeIcon.style.display = 'none';
    if (eyeOffIcon) eyeOffIcon.style.display = 'block';
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.style.display = 'block';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
  }
}

async function saveSettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  const el = (id) => document.getElementById(id);
  const thinkingRaw = el('settings-preset-thinking')?.value?.trim();
  const maxTokensRaw = el('settings-preset-max-tokens')?.value?.trim();
  const tempRaw = el('settings-preset-temperature')?.value?.trim();
  const contextLengthRaw = el('settings-preset-context-length')?.value?.trim();
  const compressRatioRaw = el('settings-preset-compress-ratio')?.value?.trim();
  const countTokenPathRaw = el('settings-preset-count-token-path')?.value?.trim();
  // 收集自定义请求头
  const customHeaders = [];
  const headerContainer = document.getElementById('settings-headers-container');
  if (headerContainer) {
    headerContainer.querySelectorAll('[data-header-row]').forEach(function(row) {
      const key = row.querySelector('[data-header-key]')?.value?.trim();
      const value = row.querySelector('[data-header-value]')?.value?.trim();
      const mode = row.querySelector('[data-header-mode]')?.value || 'static';
      if (key) customHeaders.push({ key, value: value || '', valueMode: mode });
    });
  }
  const preset = {
    name: (el('settings-preset-name')?.value || '').trim(),
    providerName: presets[idx]?.providerName || '',
    provider: (el('settings-preset-provider')?.value || 'anthropic').trim().replace(/^openai-responses$/, 'openai'),
    apiSurface: (el('settings-preset-provider')?.value || 'anthropic').trim() === 'openai-responses' ? 'responses' : 'chat',
    model: (el('settings-preset-model')?.value || '').trim(),
    baseUrl: (el('settings-preset-baseurl')?.value || '').trim(),
    apiKey: (el('settings-preset-apikey')?.value || '').trim(),
    thinkingBudgetTokens: thinkingRaw !== '' ? parseInt(thinkingRaw, 10) || null : null,
    maxTokens: maxTokensRaw !== '' ? parseInt(maxTokensRaw, 10) || null : null,
    temperature: tempRaw !== '' ? parseFloat(tempRaw) || null : null,
    contextLength: contextLengthRaw !== '' ? parseInt(contextLengthRaw, 10) || null : null,
    compressRatio: compressRatioRaw !== '' ? Math.max(1, Math.min(100, parseInt(compressRatioRaw, 10) || 80)) : 80,
    countTokenPath: countTokenPathRaw || null,
    customHeaders,
  };
  presets[idx] = preset;
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = null;
  await saveSettingsConfig();
}

async function applySettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  const preset = presets[idx];
  if (!preset) return;
  const config = window.ClawFW.settingsData?.config || { defaultModel: {}, agent: {} };
  const defaultModel = {
    provider: preset.provider || 'anthropic',
    apiSurface: preset.apiSurface || 'chat',
    model: preset.model || '',
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
  };
  if (preset.thinkingBudgetTokens != null) {
    defaultModel.thinkingBudgetTokens = preset.thinkingBudgetTokens;
  }
  if (preset.maxTokens != null) {
    defaultModel.maxTokens = preset.maxTokens;
  }
  config.defaultModel = defaultModel;
  if (preset.temperature != null) {
    config.agent = config.agent || {};
    config.agent.temperature = preset.temperature;
  }
  try {
    const resp = await fetch('/protoclaw/model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, presets }),
    });
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
    renderSettingsOverlay();
    // Refresh session data to reflect updated model config
    var _agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    if (_agent && _agent.id) {
      try {
        var freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(_agent.id));
        if (freshRes.ok) { _agent.workspace_sessions = await freshRes.json(); }
      } catch {}
    }
    if (typeof updateChatContextBar === 'function') { updateChatContextBar(); }
  } catch (error) {
    console.error('Failed to save model config:', error);
  }
}

async function saveSettingsConfig() {
  const config = window.ClawFW.settingsData?.config || { defaultModel: {}, agent: {} };
  const presets = window.ClawFW.settingsData?.presets || [];
  try {
    const resp = await fetch('/protoclaw/model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, presets }),
    });
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
    renderSettingsOverlay();
    // Refresh session data to reflect updated model config
    var _agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    if (_agent && _agent.id) {
      try {
        var freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(_agent.id));
        if (freshRes.ok) { _agent.workspace_sessions = await freshRes.json(); }
      } catch {}
    }
    if (typeof updateChatContextBar === 'function') { updateChatContextBar(); }
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

// ── window 导出 ──────────────────────────────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.openUsageInfo = openUsageInfo;
window.closeUsageInfo = closeUsageInfo;
window.loadUsageInfoData = loadUsageInfoData;
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;
