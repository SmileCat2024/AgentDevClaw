/**
 * stream-draft-logic.js — 流式语音识别与输入框草稿的合成规则（纯函数，无 DOM）
 *
 * 裁决模型（ASR 改写权 vs 用户编辑权的冲突消解）：
 * - 录音前用户已有的文字：ASR 永不触碰，识别文本只出现在尾部活跃段。
 * - 活跃段（当前识别段，activeText）：
 *   - 用户未编辑（value 仍以 activeText 结尾）→ ASR 拥有整体改写权，
 *     包括回退修正（同音字等），保证识别质量；
 *   - 用户编辑过（删字/改字/在段内或段后插入）→ 该段"转正"为普通文本，
 *     ASR 永久放弃回收，后续识别降级为在用户当前光标处追加前缀增量。
 * - 已固化段（committed 后）：立即转正，ASR 不再回头改写。
 *
 * 代价（有意取舍）：用户编辑过活跃段后，ASR 对该段的修正能力被冻结，
 * 残留错字由用户自行修正——用户意图优先于识别质量。
 */

// 流式 ASR 的瞬态句读：说话停顿时解码会先给段尾收一个句读
// （"内容"→"内容。"），后续块带上更多音频后又改写成续句（"内容，然后"）。
// replace-tail 路径整段刷新，振荡自然收敛；insert 路径（用户已编辑）无法
// 回收已插入字符，若不处理，每个中间态句读都会被永久冻结——表现为
// "。，"叠加与满屏句号碎片。故 insert 增量降级为纯内容增量：
// 全句读增量丢弃，前导句读剥离（句读留给 replace-tail 的模型原文与用户）。
const STREAM_PUNCT_CHARS = '。，、！？；：…—·,.!?;:';

function streamCommonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * 计算一次流式事件（partial/committed/final 的新段文本）对输入框的变更计划。
 *
 * @param {string} value      输入框当前值
 * @param {number} selStart   用户当前选区起点（=光标位置）
 * @param {number} selEnd     用户当前选区终点
 * @param {string} activeText 上次事件后的活跃段文本
 * @param {string} newText    本次事件的段文本
 * @returns {object}
 *   { kind: 'replace-tail', value, caret }  活跃段未被动过：整段替换，光标到新末尾
 *   { kind: 'insert', delta, start, end }   用户编辑过：在用户选区处插入剥离前导
 *                                           句读后的前缀增量
 *   { kind: 'noop' }                        无内容增量（ASR 回退 / 纯瞬态句读），不动输入框
 */
function planStreamDraftMutation(value, selStart, selEnd, activeText, newText) {
  if (activeText.length === 0 || value.endsWith(activeText)) {
    const keep = value.slice(0, value.length - activeText.length);
    return { kind: 'replace-tail', value: keep + newText, caret: keep.length + newText.length };
  }
  const common = streamCommonPrefixLen(activeText, newText);
  let delta = newText.slice(common);
  let lead = 0;
  while (lead < delta.length && STREAM_PUNCT_CHARS.indexOf(delta[lead]) !== -1) lead++;
  delta = delta.slice(lead);
  if (!delta) return { kind: 'noop' };
  return { kind: 'insert', delta, start: selStart, end: selEnd };
}

/**
 * 取消录音时尽力移除本次语音写入的文本。
 *
 * @returns {string|null} 移除后的输入框值；无法精确定位语音文本（用户已深度
 *   编辑）时返回 null —— 调用方保留输入框现状，宁可少删不可误删用户内容。
 */
function planStreamDraftCancel(value, committedText, activeText) {
  const full = committedText + activeText;
  if (full && value.endsWith(full)) {
    return value.slice(0, value.length - full.length);
  }
  if (activeText && value.endsWith(activeText)) {
    return value.slice(0, value.length - activeText.length);
  }
  return null;
}
