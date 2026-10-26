/**
 * 用户消息时间分隔线（会话时间线）。
 *
 * 数据源：viewer /messages 响应携带的 timestamps 平行元表（wire Message
 * 本身不带时间，enriched 侧 timestamp 经 push 协议平行投影）。数据层在各
 * 取数点（probe cycle / 初始加载）把时间合并进消息对象副本（_ts 字段），
 * 渲染层按"与上一条带时间锚的用户消息间隔 > 阈值，或首条用户消息"出线。
 *
 * 无时间锚（旧 runtime / 旧会话数据 / 乐观回显）静默不显示。
 */

// 分隔线触发阈值：与上一条用户消息的最小时间间隔
var TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

// 乐观回显预判的保守余量：预渲染分隔线要求间隔超过 GAP + 本值。
// 服务端入列时间恒晚于用户按下发送的本地时刻（发送延迟 + 消费排队），
// 加上常见的本机时钟偏差，两侧判定在阈值附近可能不一致。预判从严，
// 不一致只会退化为"分隔线随真实消息晚一点出现"（现状行为），绝不
// 出现"预渲染后又被真实行判定撤回"的反向跳动。
var ECHO_SEPARATOR_SLACK_MS = 30 * 1000;

/**
 * 把 timestamps 平行表合并进消息对象副本（_ts 字段）。
 *
 * 表缺失 / 长度失配（旧 runtime 未推送时间数据）时原样返回消息数组，
 * 渲染层按"无时间锚"降级（不显示时间线）。已在位的相同 _ts 不重拷贝，
 * 保持消息对象引用稳定（供各处浅比较 / 缓存使用）。
 */
function attachMessagesTimestamps(messages, timestamps) {
  if (!Array.isArray(messages) || !Array.isArray(timestamps)
    || timestamps.length !== messages.length) {
    return messages;
  }
  return messages.map(function (msg, i) {
    var ts = timestamps[i];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) ts = null;
    if (ts === null || msg && typeof msg === 'object' && msg._ts === ts) return msg;
    return Object.assign({}, msg, { _ts: ts });
  });
}

/**
 * 判断 index 处消息是否应渲染时间分隔线；应渲染时返回时间戳，否则 null。
 *
 * 语义：仅用户消息；向前找最近一条用户消息——
 *   - 不存在（首条用户消息）→ 显示
 *   - 存在且带 _ts → 间隔 > 阈值才显示
 *   - 存在但无 _ts（旧数据）→ 不显示（无锚可比较，避免误导性间隔）
 *
 * gapMs 可选（默认 TIME_SEPARATOR_GAP_MS），供乐观回显预判复用语义。
 */
function resolveUserTimeSeparator(messages, index, gapMs) {
  var gap = typeof gapMs === 'number' ? gapMs : TIME_SEPARATOR_GAP_MS;
  var msg = messages[index];
  if (!msg || msg.role !== 'user' || typeof msg._ts !== 'number') return null;
  for (var i = index - 1; i >= 0; i--) {
    var prev = messages[i];
    if (!prev || prev.role !== 'user') continue;
    if (typeof prev._ts !== 'number') return null;
    return (msg._ts - prev._ts) > gap ? msg._ts : null;
  }
  return msg._ts;
}

/**
 * 乐观回显（optimistic user echo）的分隔线预判：发送瞬间消息尚无服务端
 * _ts，用本地时钟 nowMs 近似。判定语义与 resolveUserTimeSeparator 完全
 * 一致（虚拟追加一条 _ts=nowMs 的用户消息求值），仅阈值加保守余量。
 *
 * 返回应显示的时间戳（nowMs），不应显示时返回 null。真实消息回流后由
 * 正常渲染路径的分隔线接管，预渲染元素随回显气泡一并移除。
 */
function resolveEchoTimeSeparator(messages, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  var msgs = Array.isArray(messages) ? messages : [];
  return resolveUserTimeSeparator(
    msgs.concat([{ role: 'user', _ts: nowMs }]),
    msgs.length,
    TIME_SEPARATOR_GAP_MS + ECHO_SEPARATOR_SLACK_MS
  );
}

/**
 * 本地化时间文案：时段前缀 + 时分；跨天带日期，非当年带年份。
 *
 * 时段：凌晨 0–6 / 上午 6–12 / 下午 12–18 / 晚上 18–24。时钟：凌晨用
 * 24 小时数字（"凌晨 0:05"），其余用 12 小时制（"下午 3:24"、"晚上 11:00"）。
 */
function formatChatTimestamp(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  var hh = d.getHours();
  var mm = String(d.getMinutes()).padStart(2, '0');
  var period = hh < 6 ? '凌晨' : hh < 12 ? '上午' : hh < 18 ? '下午' : '晚上';
  var clock = hh < 6 ? hh : (hh % 12 || 12);
  var timePart = period + ' ' + clock + ':' + mm;
  var sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return timePart;
  var datePart = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() === now.getFullYear()
    ? datePart + ' ' + timePart
    : d.getFullYear() + '年' + datePart + ' ' + timePart;
}

/**
 * 分隔线 html（两侧横线 + 低对比度文字）。时间格式化失败时返回空串。
 * extraClass 可选（如乐观回显预渲染的标记类），追加到基础类后。
 */
function renderTimeSeparatorHtml(ts, extraClass) {
  var text = formatChatTimestamp(ts);
  if (!text) return '';
  var cls = 'time-separator'
    + (extraClass ? ' ' + String(extraClass).replace(/[^a-z0-9_-]/gi, '') : '');
  return '<div class="' + cls + '"><span>' + escapeHtml(text) + '</span></div>';
}

/**
 * 渲染包装：index 处消息应出线时在行 html 前插入分隔线，否则原样返回。
 * 非用户消息直接透传，调用方无需预判角色。
 */
function prependTimeSeparatorHtml(messages, index, rowHtml) {
  var ts = resolveUserTimeSeparator(messages, index);
  if (ts === null) return rowHtml;
  return renderTimeSeparatorHtml(ts) + rowHtml;
}
