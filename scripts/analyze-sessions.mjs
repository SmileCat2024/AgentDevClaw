#!/usr/bin/env node
/**
 * 编程小助手会话数据统计分析
 * 遍历所有 session JSON，统计上下文组成、token使用、工具调用等
 */
import fs from 'fs';
import path from 'path';

const SESSIONS_DIR = 'C:/Users/zty20/.agentdev/AgentDevClaw/workspaces/programming-helper/sessions';

// ---- 工具函数 ----
function strLen(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (typeof v === 'number') return String(v).length;
  try { return JSON.stringify(v).length; } catch { return 0; }
}

// 从 tool 消息的 content 中提取实际结果文本长度
function toolResultLen(content) {
  if (typeof content !== 'string') return strLen(content);
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.result === 'string') return parsed.result.length;
    if (parsed && typeof parsed.error === 'string') return parsed.error.length;
    return content.length; // fallback
  } catch {
    return content.length;
  }
}

// ---- 主统计 ----
const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('session-') && f.endsWith('.json'));
console.log(`Found ${files.length} session files\n`);

// 全局累加器
const acc = {
  // 内容长度（字符数）
  contentLens: { system: 0, user: 0, assistantText: 0, toolResult: 0, thinking: 0, toolCallReq: 0 },
  // token
  totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
  // 工具调用统计
  toolCallCounts: {},        // toolName -> count
  toolCallLens: {},          // toolName -> total result chars
  totalToolCalls: 0,
  // 会话级
  sessionCount: 0,
  sessionMsgCounts: [],
  sessionTurnCounts: [],
  sessionTotalLens: [],      // 每个会话的内容总长度
  sessionInputTokens: [],
  sessionOutputTokens: [],
  // 模型分布
  modelCounts: {},
  // 最大的几个会话
  largestSessions: [],
  // 工具调用 vs 非工具 的 assistant 消息数
  assistantMsgs: 0,
  assistantWithTools: 0,
  assistantPureText: 0,
  // 每轮工具调用次数分布
  toolsPerTurn: {},
  // 错误工具调用
  toolErrors: 0,
  // 版本对比
  versionStats: {}, // version -> { count, totalSize, totalMsgs, totalTurns, totalContentLen, totalInputTok }
};

let errors = 0;

for (let fi = 0; fi < files.length; fi++) {
  const file = files[fi];
  const filepath = path.join(SESSIONS_DIR, file);
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    const d = JSON.parse(raw);

    const rt = d.runtime || {};
    const ctx = rt.context || {};
    const msgs = ctx.messages || [];
    const usage = (rt.usageStats && rt.usageStats.totalUsage) || {};

    acc.sessionCount++;
    acc.sessionMsgCounts.push(msgs.length);

    // 最大 turn
    let maxTurn = 0;

    // token 统计
    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    acc.totalInputTokens += inTok;
    acc.totalOutputTokens += outTok;
    acc.totalCacheReadTokens += usage.cacheReadTokens || 0;
    acc.totalCacheCreationTokens += usage.cacheCreationTokens || 0;
    acc.sessionInputTokens.push(inTok);
    acc.sessionOutputTokens.push(outTok);

    // 模型
    const model = d.modelName || 'unknown';
    acc.modelCounts[model] = (acc.modelCounts[model] || 0) + 1;

    let sessionTotalLen = 0;

    // 逐消息统计
    for (const m of msgs) {
      const role = m.role || 'unknown';
      const turn = m.turn || 0;
      if (turn > maxTurn) maxTurn = turn;

      if (role === 'system') {
        const l = strLen(m.content);
        acc.contentLens.system += l;
        sessionTotalLen += l;
      } else if (role === 'user') {
        const l = strLen(m.content);
        acc.contentLens.user += l;
        sessionTotalLen += l;
      } else if (role === 'assistant') {
        acc.assistantMsgs++;
        const textLen = strLen(m.content);
        acc.contentLens.assistantText += textLen;
        sessionTotalLen += textLen;

        // thinking
        if (m.thinkingBlocks && Array.isArray(m.thinkingBlocks)) {
          for (const tb of m.thinkingBlocks) {
            const tl = strLen(tb.thinking);
            acc.contentLens.thinking += tl;
            sessionTotalLen += tl;
          }
        } else if (m.reasoning) {
          const tl = strLen(m.reasoning);
          acc.contentLens.thinking += tl;
          sessionTotalLen += tl;
        }

        // tool calls（请求）
        if (m.toolCalls && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          acc.assistantWithTools++;
          for (const tc of m.toolCalls) {
            acc.totalToolCalls++;
            const tname = tc.name || 'unknown';
            acc.toolCallCounts[tname] = (acc.toolCallCounts[tname] || 0) + 1;
            // tool call 请求的参数长度（作为请求占用）
            const reqLen = strLen(tc.arguments) + strLen(tc.name);
            acc.contentLens.toolCallReq += reqLen;
            sessionTotalLen += reqLen;
          }
        } else if (textLen > 0) {
          acc.assistantPureText++;
        }
      } else if (role === 'tool') {
        const rl = toolResultLen(m.content);
        acc.contentLens.toolResult += rl;
        sessionTotalLen += rl;

        // 按 toolCallId 关联工具名（如果有）
        // 从前一个 assistant 消息的 toolCalls 查找
        const tcid = m.toolCallId;
        if (tcid) {
          // 记录每个工具的结果长度
          // 简化：标记为 generic tool result
        }

        // 检查错误
        if (typeof m.content === 'string') {
          try {
            const p = JSON.parse(m.content);
            if (p && (p.success === false || p.error)) acc.toolErrors++;
          } catch {}
        }
      }
    }

    acc.sessionTurnCounts.push(maxTurn + 1);
    acc.sessionTotalLens.push(sessionTotalLen);

    // 版本对比统计
    const ver = 'v' + (d.version || '?');
    const fileSize = Buffer.byteLength(raw, 'utf8');
    if (!acc.versionStats[ver]) acc.versionStats[ver] = { count: 0, totalSize: 0, totalMsgs: 0, totalTurns: 0, totalContentLen: 0, totalInputTok: 0 };
    const vs = acc.versionStats[ver];
    vs.count++;
    vs.totalSize += fileSize;
    vs.totalMsgs += msgs.length;
    vs.totalTurns += (maxTurn + 1);
    vs.totalContentLen += sessionTotalLen;
    vs.totalInputTok += inTok;

    if (sessionTotalLen > 100000) {
      acc.largestSessions.push({ file, len: sessionTotalLen, msgs: msgs.length, turns: maxTurn + 1, inTok, outTok });
    }
  } catch (e) {
    errors++;
  }
}

// ---- 工具结果长度：第二轮扫描关联工具名 ----
// 用 toolCallId -> toolName 映射
const toolResultLensByName = {};
for (let fi = 0; fi < files.length; fi++) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, files[fi]), 'utf8'));
    const msgs = (d.runtime?.context?.messages) || [];
    // 建立 id->name 映射
    const idMap = {};
    for (const m of msgs) {
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (tc.id) idMap[tc.id] = tc.name || 'unknown';
        }
      }
    }
    for (const m of msgs) {
      if (m.role === 'tool' && m.toolCallId) {
        const tname = idMap[m.toolCallId] || 'unknown';
        const rl = toolResultLen(m.content);
        toolResultLensByName[tname] = (toolResultLensByName[tname] || 0) + rl;
      }
    }
  } catch {}
}

// ---- 输出报告 ----
function pct(part, total) {
  return total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '0%';
}
function fmt(n) { return n.toLocaleString('en-US'); }

const totalContentLen = Object.values(acc.contentLens).reduce((a, b) => a + b, 0);

console.log('========================================================');
console.log('  编程小助手会话数据统计报告');
console.log('========================================================\n');

console.log('【1. 总览】');
console.log(`  会话总数:          ${fmt(acc.sessionCount)}`);
console.log(`  解析失败:          ${errors}`);
console.log(`  总消息数:          ${fmt(acc.sessionMsgCounts.reduce((a, b) => a + b, 0))}`);
console.log(`  总内容长度(字符):  ${fmt(totalContentLen)} (~${(totalContentLen / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  总工具调用次数:    ${fmt(acc.totalToolCalls)}`);
console.log(`  总输入 Token:      ${fmt(acc.totalInputTokens)}`);
console.log(`  总输出 Token:      ${fmt(acc.totalOutputTokens)}`);
console.log(`  总缓存读取 Token:  ${fmt(acc.totalCacheReadTokens)}`);

console.log('\n【2. 上下文长度占比（按内容类型）】');
console.log('  ┌─────────────────────────────────────────┬──────────────┬──────────┐');
console.log('  │ 内容类型                                │ 字符数       │ 占比     │');
console.log('  ├─────────────────────────────────────────┼──────────────┼──────────┤');
const rows = [
  ['System Prompt (系统提示词)', acc.contentLens.system],
  ['User Input (用户输入)', acc.contentLens.user],
  ['Assistant Text (助手文本回复)', acc.contentLens.assistantText],
  ['Thinking/Reasoning (思考)', acc.contentLens.thinking],
  ['Tool Call Request (工具调用请求)', acc.contentLens.toolCallReq],
  ['Tool Result (工具返回结果)', acc.contentLens.toolResult],
];
for (const [label, val] of rows) {
  console.log(`  │ ${label.padEnd(39)} │ ${fmt(val).padStart(12)} │ ${pct(val, totalContentLen).padStart(8)} │`);
}
console.log('  └─────────────────────────────────────────┴──────────────┴──────────┘');

const toolRelatedLen = acc.contentLens.toolResult + acc.contentLens.toolCallReq;
const thinkingRelatedLen = acc.contentLens.thinking;
console.log(`\n  → 工具相关内容合计 (请求+结果): ${fmt(toolRelatedLen)} = ${pct(toolRelatedLen, totalContentLen)}`);
console.log(`  → 思考内容合计:                ${fmt(thinkingRelatedLen)} = ${pct(thinkingRelatedLen, totalContentLen)}`);
console.log(`  → 非工具/非思考的对话内容:     ${fmt(totalContentLen - toolRelatedLen - thinkingRelatedLen)} = ${pct(totalContentLen - toolRelatedLen - thinkingRelatedLen, totalContentLen)}`);

console.log('\n【3. Token 使用统计】');
const totalAllTokens = acc.totalInputTokens + acc.totalOutputTokens;
console.log(`  总 Token (input+output): ${fmt(totalAllTokens)}`);
console.log(`    其中输入: ${fmt(acc.totalInputTokens)} (${pct(acc.totalInputTokens, totalAllTokens)})`);
console.log(`    其中输出: ${fmt(acc.totalOutputTokens)} (${pct(acc.totalOutputTokens, totalAllTokens)})`);
console.log(`  缓存读取 Token: ${fmt(acc.totalCacheReadTokens)} (缓存命中率 ${pct(acc.totalCacheReadTokens, acc.totalInputTokens)} of input)`);
console.log(`  实际计费输入 (input - cacheRead): ${fmt(acc.totalInputTokens - acc.totalCacheReadTokens)}`);

// 会话级 token 分布
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] + s[mid]) / 2);
}
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(s.length * p);
  return s[idx];
}
console.log(`\n  每会话输入 Token:`);
console.log(`    中位数: ${fmt(median(acc.sessionInputTokens))}, 平均: ${fmt(Math.round(acc.sessionInputTokens.reduce((a, b) => a + b, 0) / acc.sessionInputTokens.length))}`);
console.log(`    P75: ${fmt(percentile(acc.sessionInputTokens, 0.75))}, P90: ${fmt(percentile(acc.sessionInputTokens, 0.90))}, P99: ${fmt(percentile(acc.sessionInputTokens, 0.99))}`);
console.log(`    最大: ${fmt(Math.max(...acc.sessionInputTokens))}`);

console.log('\n【4. 工具调用频率 Top 20】');
const sortedTools = Object.entries(acc.toolCallCounts).sort((a, b) => b[1] - a[1]);
console.log('  ┌────────────────────────────────┬──────────┬──────────┬──────────────┐');
console.log('  │ 工具名称                        │ 调用次数 │ 占比     │ 平均结果长度 │');
console.log('  ├────────────────────────────────┼──────────┼──────────┼──────────────┤');
for (const [name, cnt] of sortedTools.slice(0, 20)) {
  const avgLen = acc.toolCallCounts[name] > 0 ? Math.round((toolResultLensByName[name] || 0) / cnt) : 0;
  console.log(`  │ ${(name||'').padEnd(30)} │ ${fmt(cnt).padStart(8)} │ ${pct(cnt, acc.totalToolCalls).padStart(8)} │ ${fmt(avgLen).padStart(12)} │`);
}
console.log('  └────────────────────────────────┴──────────┴──────────┴──────────────┘');
console.log(`  工具调用失败/错误次数: ${fmt(acc.toolErrors)}`);

console.log('\n【5. 会话规模分布】');
console.log(`  消息数:  中位数 ${median(acc.sessionMsgCounts)}, 平均 ${Math.round(acc.sessionMsgCounts.reduce((a, b) => a + b, 0) / acc.sessionMsgCounts.length)}, 最大 ${Math.max(...acc.sessionMsgCounts)}`);
console.log(`           P75 ${percentile(acc.sessionMsgCounts, 0.75)}, P90 ${percentile(acc.sessionMsgCounts, 0.90)}`);
console.log(`  轮次数:  中位数 ${median(acc.sessionTurnCounts)}, 平均 ${(acc.sessionTurnCounts.reduce((a, b) => a + b, 0) / acc.sessionTurnCounts.length).toFixed(1)}, 最大 ${Math.max(...acc.sessionTurnCounts)}`);
console.log(`  内容长度(字符): 中位数 ${fmt(median(acc.sessionTotalLens))}, 平均 ${fmt(Math.round(acc.sessionTotalLens.reduce((a, b) => a + b, 0) / acc.sessionTotalLens.length))}`);

console.log(`\n  Assistant 消息: ${fmt(acc.assistantMsgs)} (含工具调用: ${fmt(acc.assistantWithTools)} ${pct(acc.assistantWithTools, acc.assistantMsgs)}, 纯文本: ${fmt(acc.assistantPureText)})`);

console.log('\n【6. 模型分布】');
const sortedModels = Object.entries(acc.modelCounts).sort((a, b) => b[1] - a[1]);
for (const [model, cnt] of sortedModels) {
  console.log(`  ${model.padEnd(35)} ${fmt(cnt).padStart(8)} 会话  (${pct(cnt, acc.sessionCount)})`);
}

console.log('\n【7. 内容最长的 10 个会话】');
acc.largestSessions.sort((a, b) => b.len - a.len);
console.log('  ┌──────────────────────────────────────────┬──────────────┬──────┬──────┬────────────┐');
console.log('  │ Session                                  │ 内容字符数   │ 消息 │ 轮次 │ 输入Token  │');
console.log('  ├──────────────────────────────────────────┼──────────────┼──────┼──────┼────────────┤');
for (const s of acc.largestSessions.slice(0, 10)) {
  console.log(`  │ ${s.file.slice(0, 40).padEnd(40)} │ ${fmt(s.len).padStart(12)} │ ${String(s.msgs).padStart(4)} │ ${String(s.turns).padStart(4)} │ ${fmt(s.inTok).padStart(10)} │`);
}
console.log('  └──────────────────────────────────────────┴──────────────┴──────┴──────┴────────────┘');

console.log('\n【8. Session 格式版本对比 (v1 vs v2 存储效率)】');
const verEntries = Object.entries(acc.versionStats).sort((a, b) => a[0].localeCompare(b[0]));
console.log('  ┌──────┬──────────┬────────────┬──────────────┬──────────────────┬────────────────┬──────────────────┐');
console.log('  │ 版本 │ 会话数   │ 总大小     │ 平均文件大小 │ 每条消息平均字节 │ 每轮平均字节   │ 每会话平均消息数 │');
console.log('  ├──────┼──────────┼────────────┼──────────────┼──────────────────┼────────────────┼──────────────────┤');
for (const [ver, vs] of verEntries) {
  const avgSize = Math.round(vs.totalSize / vs.count);
  const bytesPerMsg = Math.round(vs.totalSize / vs.totalMsgs);
  const bytesPerTurn = Math.round(vs.totalSize / vs.totalTurns);
  const avgMsgs = (vs.totalMsgs / vs.count).toFixed(1);
  console.log(`  │ ${ver.padEnd(4)} │ ${fmt(vs.count).padStart(8)} │ ${(vs.totalSize/1024/1024).toFixed(1).padStart(6)} MB │ ${fmt(avgSize).padStart(12)} │ ${fmt(bytesPerMsg).padStart(16)} │ ${fmt(bytesPerTurn).padStart(14)} │ ${avgMsgs.padStart(16)} │`);
}
console.log('  └──────┴──────────┴────────────┴──────────────┴──────────────────┴────────────────┴──────────────────┘');

// 如果有 v1 和 v2，计算效率对比
const v1 = acc.versionStats['v1'];
const v2 = acc.versionStats['v2'];
if (v1 && v2) {
  const v1BytesPerMsg = v1.totalSize / v1.totalMsgs;
  const v2BytesPerMsg = v2.totalSize / v2.totalMsgs;
  const improvement = ((1 - v2BytesPerMsg / v1BytesPerMsg) * 100).toFixed(1);
  console.log(`\n  → 每条消息存储开销: v1=${fmt(Math.round(v1BytesPerMsg))} bytes → v2=${fmt(Math.round(v2BytesPerMsg))} bytes`);
  console.log(`  → v2 相比 v1 存储效率: ${improvement > 0 ? '节省' : '增加'} ${Math.abs(improvement)}%`);
  const v1BytesPerTurn = v1.totalSize / v1.totalTurns;
  const v2BytesPerTurn = v2.totalSize / v2.totalTurns;
  const improvementTurn = ((1 - v2BytesPerTurn / v1BytesPerTurn) * 100).toFixed(1);
  console.log(`  → 每轮存储开销: v1=${fmt(Math.round(v1BytesPerTurn))} bytes → v2=${fmt(Math.round(v2BytesPerTurn))} bytes`);
  console.log(`  → v2 相比 v1 (按轮次): ${improvementTurn > 0 ? '节省' : '增加'} ${Math.abs(improvementTurn)}%`);
}

console.log('\n========================================================');
console.log('  统计完成');
console.log('========================================================');
