/**
 * trim-ratio-core.js — 统一精简页面：比例模式切点计算核心（DOM 无关纯函数）
 *
 * 数据面：GET /protoclaw/session_trim_preview 响应顶层 messages[]（服务端
 * buildSessionTrimMessagePreview 投影，index 与引擎 rawMessages 索引严格
 * 对齐）。所有函数只读该投影数组，不发起请求、不触碰 DOM，滑杆拖动时
 * 全部本地重算。
 *
 * 切点语义：cutIndex = 保留区第一条消息的全局索引，提交时映射为
 * preservedMsgRanges = [[cutIndex, lastIndex]]（单条尾区间）。精简区为
 * [0, cutIndex)，引擎在其上执行折叠变换。
 *
 * 折叠残留估算对齐框架 trim-transcript 引擎（assistantToolCallMode /
 * toolMessageMode = 'fold'，foldConsecutiveToolActivity = true）：
 *   - 精简区内 user / assistant 的对话文本保留（估算取 contentCharCount）
 *   - 工具活动折叠为注记 "[Folded tool activity]\nassistant tool calls: s1; s2 ×N"
 *     （同名摘要去重计数 ×N；摘要为引擎括号格式 read(a.js)，服务端投影已按
 *     该格式生成，本模块直接拼接）
 *   - 连续工具块被对话文本（user / 有文本 assistant / system）打断时分段出注记
 *   - 纯工具 assistant（无文本）不打断工具块
 * 已知偏差（UI 读数标注「估算」）：不含 keepRecentSkillInvokes 技能保护与
 * 摘要生成长度；maxFoldedToolChars 只作用于引擎 args 截断（默认关闭），不影响。
 *
 * 挂载：window.TrimRatioCore（typeof window 守卫；测试经 frontend-vm 沙箱加载）。
 */
(function () {
  'use strict';

  // 引擎 flushPendingToolFold 的注记前缀（trim-transcript.ts lines 数组拼接）
  var FOLD_NOTE_PREFIX = '[Folded tool activity]\nassistant tool calls: ';

  function normalizeMessages(messages) {
    return Array.isArray(messages) ? messages : [];
  }

  function totalCharCount(messages, preambleCharCount) {
    var total = typeof preambleCharCount === 'number' && Number.isFinite(preambleCharCount)
      ? preambleCharCount : 0;
    var msgs = normalizeMessages(messages);
    for (var i = 0; i < msgs.length; i++) {
      total += (msgs[i] && typeof msgs[i].charCount === 'number') ? msgs[i].charCount : 0;
    }
    return total;
  }

  /**
   * 全部安全切点（升序）。切点 c 安全 ⇔ 精简区 [0, c) 内无悬空 tool_use——
   * 扫描维护 pending 工具 id 集合：assistant.toolCalls[].id 计入、
   * role=tool 消息的 toolCallId 配对清除，集合清零处即安全。
   * 无 id 的调用对无法判定配对，按不悬空处理（宽松）。
   *
   * 每个候选标注 roundBoundary：msgs[c]?.role === 'user'（保留区从轮头
   * 开始）。cutIndex = msgs.length（全精简）在尾部 pending 清零时同样安全。
   *
   * @returns {Array<{cutIndex: number, roundBoundary: boolean}>}
   */
  function safeCutCandidates(messages) {
    var msgs = normalizeMessages(messages);
    var candidates = [];
    var pending = {};
    var pendingCount = 0;
    var push = function (cutIndex) {
      var next = msgs[cutIndex];
      candidates.push({
        cutIndex: cutIndex,
        roundBoundary: !!(next && typeof next === 'object' && next.role === 'user'),
      });
    };
    push(0);
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (var t = 0; t < m.toolCalls.length; t++) {
          var tc = m.toolCalls[t];
          if (tc && typeof tc.id === 'string' && tc.id && !pending[tc.id]) {
            pending[tc.id] = true;
            pendingCount += 1;
          }
        }
      }
      if (m.role === 'tool' && typeof m.toolCallId === 'string' && m.toolCallId && pending[m.toolCallId]) {
        delete pending[m.toolCallId];
        pendingCount -= 1;
      }
      if (pendingCount === 0) push(i + 1);
    }
    return candidates;
  }

  /**
   * 引擎 deduplicateToolCallSummaries：同名摘要计数，>1 输出 "s ×N"。
   */
  function foldNoteLength(summaries) {
    var counts = {};
    var order = [];
    for (var i = 0; i < summaries.length; i++) {
      var s = summaries[i];
      if (Object.prototype.hasOwnProperty.call(counts, s)) counts[s] += 1;
      else { counts[s] = 1; order.push(s); }
    }
    var parts = [];
    for (var j = 0; j < order.length; j++) {
      parts.push(counts[order[j]] > 1 ? order[j] + ' ×' + counts[order[j]] : order[j]);
    }
    return FOLD_NOTE_PREFIX.length + parts.join('; ').length;
  }

  /**
   * 精简区 [0, cutIndex) 的折叠残留估算（字符）。分派对齐引擎：
   * user → flush 后保留文本；有文本 assistant → flush 后保留文本、calls 入
   * 折叠；纯工具 assistant → 不 flush、calls 入折叠；tool → 入折叠不留文本；
   * system / 脏消息 → flush（打断工具块）但不保留（includeSystemMessages=false）。
   * 区尾未 flush 的 pending 强制结算（引擎循环后 flushPendingToolFold）。
   */
  function estimateFoldResidue(messages, cutIndex) {
    var msgs = normalizeMessages(messages);
    var end = Math.min(Math.max(Math.floor(cutIndex) || 0, 0), msgs.length);
    var residue = 0;
    var pendingSummaries = [];
    var flush = function () {
      if (pendingSummaries.length === 0) return;
      residue += foldNoteLength(pendingSummaries);
      pendingSummaries = [];
    };
    for (var i = 0; i < end; i++) {
      var m = msgs[i];
      if (!m || typeof m !== 'object') continue;
      var contentChars = typeof m.contentCharCount === 'number' ? m.contentCharCount : 0;
      if (m.role === 'user') {
        flush();
        residue += contentChars;
      } else if (m.role === 'assistant') {
        var calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        for (var t = 0; t < calls.length; t++) {
          if (calls[t] && typeof calls[t].summary === 'string' && calls[t].summary) {
            pendingSummaries.push(calls[t].summary);
          }
        }
        if (!(contentChars === 0 && calls.length > 0)) flush();
        residue += contentChars;
      } else if (m.role === 'system') {
        flush();
      }
      // role='tool' 与空 role：引擎丢弃/折叠，不 flush、不贡献
    }
    flush();
    return residue;
  }

  /**
   * 任意切点（含非安全位，调用方 UI 侧约束）的精简后估算总长：
   * 前言 + 残留([0,c)) + 保留区原样体积([c,n))。
   */
  function keptCharCount(messages, preambleCharCount, cutIndex) {
    var msgs = normalizeMessages(messages);
    var c = Math.min(Math.max(Math.floor(cutIndex) || 0, 0), msgs.length);
    var kept = typeof preambleCharCount === 'number' && Number.isFinite(preambleCharCount)
      ? preambleCharCount : 0;
    kept += estimateFoldResidue(msgs, c);
    for (var i = c; i < msgs.length; i++) {
      kept += (msgs[i] && typeof msgs[i].charCount === 'number') ? msgs[i].charCount : 0;
    }
    return kept;
  }

  /**
   * 比例 → 切点。预算 = ratio × 总长；在安全切点中找保留最多的满足者
   * （cutIndex 最小的 kept(c) ≤ 预算），两级优先：
   *   1) 轮边界候选中找——切线落轮头，语义干净；
   *   2) 轮边界全超（单轮体量过大等）放宽到全部安全候选——切线入轮内。
   *
   * 帕累托过滤（单调保证）：kept(c) 随 c 增大总趋势递减，但折叠残留随
   * 切割量增长，会催生「切得更多反而保留不减」的坏切点（典型：切过
   * 微型工具对后新折叠注记反超其原样体积，切到轮头反而更长）。头→尾
   * 扫描维护 runningMin，kept ≥ 已见最小保留的候选剔除，过滤后 kept
   * 关于 cutIndex 严格递减，切点随比例增大单调上移；两级轮边界偏好不
   * 变——被滤掉的轮头本来就是「切了不省」的无效切点，引擎真去切结果
   * 反而更长。
   *
   * 连全精简（最小保留）都无法达标（前言占比过高）时返回最小保留候选并
   * 标记 unmet。
   *
   * @param {number} ratio 0..1
   * @returns {{cutIndex: number, unmet: boolean}}
   */
  function ratioToCut(messages, preambleCharCount, ratio) {
    var msgs = normalizeMessages(messages);
    var total = totalCharCount(msgs, preambleCharCount);
    var budget = Math.max(Math.min(ratio, 1), 0) * total;
    var candidates = safeCutCandidates(msgs);
    var keptByCut = {};
    var keptFor = function (c) {
      if (!Object.prototype.hasOwnProperty.call(keptByCut, c)) {
        keptByCut[c] = keptCharCount(msgs, preambleCharCount, c);
      }
      return keptByCut[c];
    };
    var pareto = [];
    var minKept = Infinity;
    for (var k = 0; k < candidates.length; k++) {
      var kept = keptFor(candidates[k].cutIndex);
      if (kept < minKept) {
        pareto.push({ cutIndex: candidates[k].cutIndex, roundBoundary: candidates[k].roundBoundary, kept: kept });
        minKept = kept;
      }
    }
    var i;
    for (i = 0; i < pareto.length; i++) {
      if (pareto[i].roundBoundary && pareto[i].kept <= budget) {
        return { cutIndex: pareto[i].cutIndex, unmet: false };
      }
    }
    for (i = 0; i < pareto.length; i++) {
      if (pareto[i].kept <= budget) {
        return { cutIndex: pareto[i].cutIndex, unmet: false };
      }
    }
    return { cutIndex: pareto.length > 0 ? pareto[pareto.length - 1].cutIndex : 0, unmet: true };
  }

  /**
   * 切点 → 实际保留比例（0..1）。点击消息「设为切点」后反写滑动条数值用。
   */
  function cutToRatio(messages, preambleCharCount, cutIndex) {
    var total = totalCharCount(messages, preambleCharCount);
    if (total <= 0) return 0;
    return keptCharCount(messages, preambleCharCount, cutIndex) / total;
  }

  /**
   * 读数块数据：保留/释放比例、保留消息数、估算字符（右栏实时展示）。
   */
  function computeReadout(messages, preambleCharCount, cutIndex) {
    var msgs = normalizeMessages(messages);
    var c = Math.min(Math.max(Math.floor(cutIndex) || 0, 0), msgs.length);
    var total = totalCharCount(msgs, preambleCharCount);
    var kept = keptCharCount(msgs, preambleCharCount, c);
    return {
      totalCharCount: total,
      keptCharCount: kept,
      keptPercent: total > 0 ? kept / total : 0,
      releasedPercent: total > 0 ? 1 - kept / total : 0,
      keptMessageCount: msgs.length - c,
      foldedMessageCount: c,
    };
  }

  var api = {
    safeCutCandidates: safeCutCandidates,
    estimateFoldResidue: estimateFoldResidue,
    keptCharCount: keptCharCount,
    ratioToCut: ratioToCut,
    cutToRatio: cutToRatio,
    computeReadout: computeReadout,
  };
  if (typeof window !== 'undefined') window.TrimRatioCore = api;
})();
