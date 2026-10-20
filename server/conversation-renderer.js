/**
 * 对话渲染器 — 将 Message[] 渲染为自包含 HTML 文件
 *
 * 设计目标：
 * - 质量对标 viewer-html.ts 的前端渲染，不缩水
 * - 自包含：所有 CSS 内联，仅 marked.js 通过 CDN 引入（降级为纯文本 fallback）
 * - Mobile-first：适配手机浏览器打开
 * - 按 turn 分组：每轮用户交互可折叠
 *
 * Message 结构参考：
 *   role: 'user' | 'assistant' | 'system' | 'tool'
 *   content: string
 *   turn?: number
 *   toolCallId?: string         // tool 结果消息关联的 toolCall.id
 *   toolCalls?: ToolCall[]       // assistant 消息携带的工具调用
 *   reasoning?: string           // 思考内容
 *   usage?: { inputTokens, outputTokens }
 *
 * ToolCall 结构：
 *   id: string
 *   name: string
 *   arguments: Record<string, any>
 */

import { marked } from 'marked';
import { CONVERSATION_CSS } from './conversation-renderer-styles.js';

// marked 配置
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ── 工具函数 ──────────────────────────────────────────────

function escapeHtml(text) {
  if (text == null) return '';
  const str = String(text);
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}

function parseToolResult(content) {
  try {
    const json = JSON.parse(content);
    if (json && typeof json === 'object' && 'success' in json && 'result' in json) {
      let data = json.result;
      if (typeof data === 'string') {
        try {
          if (data.trim().startsWith('"') || data.trim().startsWith('{') || data.trim().startsWith('[')) {
            const parsed = JSON.parse(data);
            data = parsed;
          }
        } catch {
          // Not a JSON string, keep as is
        }
      }
      return { success: json.success, data: data };
    }
    return { success: true, data: content };
  } catch {
    return { success: true, data: content };
  }
}

const TOOL_DISPLAY_NAMES = {
  run_shell_command: 'Bash',
  bash: 'Bash',
  read_file: 'Read File',
  read: 'Read',
  write_file: 'Write File',
  write: 'Write',
  edit: 'Edit',
  list_directory: 'List',
  ls: 'LS',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'Web',
  websearch: 'Web Search',
  calculator: 'Calc',
  invoke_skill: 'Skill',
  spawn_agent: 'Spawn Agent',
  agent_spawn: 'Spawn Agent',
  agent_list: 'List Agents',
  agent_send: 'Send to Agent',
  agent_close: 'Close Agent',
  upload_attachment: 'Upload',
  im_overview: 'IM Overview',
  im_browse: 'IM Browse',
  im_connect_line: 'Connect Line',
  im_disconnect_line: 'Disconnect Line',
  task_create: 'Task Create',
  task_list: 'Task List',
  task_update: 'Task Update',
  task_clear: 'Task Clear',
  user_input: 'User Input',
};

function getToolDisplayName(toolName) {
  return TOOL_DISPLAY_NAMES[toolName] || toolName || 'Unknown';
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    return marked.parse(text);
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

function formatToolError(data) {
  const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
}

function truncateForPreview(text, maxLen = 200) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

// ── 消息渲染 ──────────────────────────────────────────────

/**
 * 构建 toolCallId → { name, arguments } 的查找索引
 */
function buildToolCallIndex(messages) {
  const index = new Map();
  for (const m of messages) {
    if (m.toolCalls) {
      for (const call of m.toolCalls) {
        index.set(call.id, { name: call.name, arguments: call.arguments });
      }
    }
  }
  return index;
}

/**
 * 渲染一个紧凑的工具调用块（call + result 合并，默认折叠）
 * 折叠时只显示一行：图标 + 工具名 + 状态
 */
function renderCompactToolBlock(call, resultMsg) {
  const displayName = getToolDisplayName(call.name);
  const argsJson = JSON.stringify(call.arguments, null, 2);

  let statusIcon = '·';
  let statusClass = 'pending';
  let resultHtml = '';

  if (resultMsg) {
    const { success, data } = parseToolResult(resultMsg.content);
    if (success) {
      statusIcon = '✓';
      statusClass = 'ok';
    } else {
      statusIcon = '✗';
      statusClass = 'fail';
    }

    if (!success) {
      resultHtml = `<div class="tool-block-section tool-block-result"><div class="tool-block-label">结果</div>${formatToolError(data)}</div>`;
    } else {
      const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      resultHtml = `<div class="tool-block-section tool-block-result"><div class="tool-block-label">结果</div><pre class="bash-output">${escapeHtml(truncateForPreview(displayData, 5000))}</pre></div>`;
    }
  }

  // 参数预览：如果是单参数且值简短，直接显示在 summary 里
  const argKeys = Object.keys(call.arguments || {});
  let argPreview = '';
  if (argKeys.length === 1) {
    const val = String(call.arguments[argKeys[0]] ?? '');
    if (val.length <= 80) {
      argPreview = `<span class="tool-block-arg-preview">${escapeHtml(truncateForPreview(val, 80))}</span>`;
    }
  }

  return `<details class="tool-block">
  <summary class="tool-block-bar">
    <span class="tool-block-status ${statusClass}">${statusIcon}</span>
    <span class="tool-block-name">${escapeHtml(displayName)}</span>
    ${argPreview}
  </summary>
  <div class="tool-block-detail">
    <div class="tool-block-section">
      <div class="tool-block-label">参数</div>
      <pre class="tool-block-json">${escapeHtml(argsJson)}</pre>
    </div>
    ${resultHtml}
  </div>
</details>`;
}

function renderAssistantMessage(msg, toolResults) {
  let innerContent = '';

  // Reasoning block (collapsible)
  if (msg.reasoning) {
    innerContent += `
      <details class="reasoning-block">
        <summary class="reasoning-header">
          <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
          <span>思考过程</span>
        </summary>
        <div class="reasoning-content markdown-body">${renderMarkdown(msg.reasoning)}</div>
      </details>`;
  }

  // Content — 这是 agent 的核心输出，视觉强调
  if (msg.content) {
    if (msg.content.startsWith('[Error:') || msg.content.startsWith('[API Error:')) {
      innerContent += `<div class="tool-error">${escapeHtml(msg.content)}</div>`;
    } else {
      innerContent += `<div class="assistant-text markdown-body">${renderMarkdown(msg.content)}</div>`;
    }
  }

  // Tool calls — 紧凑折叠块，call+result 合并
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    innerContent += '<div class="tool-block-group">';
    for (const call of msg.toolCalls) {
      const resultMsg = toolResults?.get(call.id);
      innerContent += renderCompactToolBlock(call, resultMsg);
    }
    innerContent += '</div>';
  }

  return `
      <div class="message-row assistant">
        <div class="message-meta">
          <div class="role-badge">assistant</div>
        </div>
        <div class="message-content">${innerContent}
        </div>
      </div>`;
}

function renderUserMessage(msg) {
  return `
      <div class="message-row user">
        <div class="message-meta">
          <div class="role-badge">user</div>
        </div>
        <div class="message-content markdown-body">${renderMarkdown(msg.content)}</div>
      </div>`;
}

function renderSystemMessage(msg) {
  const isLong = msg.content.includes('\n') || msg.content.length > 80;

  if (isLong) {
    // 长系统消息：折叠，只显示预览
    const firstLine = msg.content.split('\n').find(l => l.trim()) || '';
    const preview = truncateForPreview(firstLine.replace(/^#+\s*/, ''), 60);
    return `
      <div class="message-row system">
        <div class="message-meta">
          <div class="role-badge">system</div>
        </div>
        <details class="system-collapse">
          <summary>${escapeHtml(preview)}</summary>
          <div class="message-content markdown-body system-long-content">${renderMarkdown(msg.content)}</div>
        </details>
      </div>`;
  }

  return `
      <div class="message-row system">
        <div class="message-meta">
          <div class="role-badge">system</div>
        </div>
        <div class="message-content markdown-body">${renderMarkdown(msg.content)}</div>
      </div>`;
}

// ── Turn 分组 ─────────────────────────────────────────────

/**
 * 将 messages 按 turn 分组。
 *
 * 规则：
 * - turn 字段相同 → 同一组
 * - turn 字段缺失（undefined/null）→ 继承最近一条消息的 turn，归入当前组
 *   这是框架在对话中途注入 system reminder 的常见情况（如 todo 提醒）
 */
function groupByTurn(messages) {
  const groups = [];
  let currentGroup = null;
  let lastTurn = 0;

  for (const msg of messages) {
    let turn = msg.turn;

    // undefined / null turn：继承当前 turn 上下文
    if (turn === undefined || turn === null) {
      turn = lastTurn;
    }

    lastTurn = turn;

    if (currentGroup && turn === currentGroup.turn) {
      currentGroup.messages.push(msg);
    } else {
      currentGroup = {
        turn,
        messages: [msg],
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

/**
 * 为轮组分配面向读者的连续编号：含 user 消息的组从 1 起递增（#1/#2/…）。
 * 原始 turn 值（插话场景可能为小数、可能跳号）不外露到导出内容。
 */
function assignUserTurnNumbers(turnGroups) {
  let seq = 0;
  for (const g of turnGroups) {
    g.userTurn = g.messages.some(m => m.role === 'user') ? ++seq : null;
  }
  return turnGroups;
}

function renderTurnGroup(group, groupIndex, toolCallIndex, callTimestamps, turnGroupCount) {
  // 收集 tool 结果，按 toolCallId 索引，供 assistant 消息合并使用
  const toolResults = new Map();
  for (const msg of group.messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      toolResults.set(msg.toolCallId, msg);
    }
  }

  const parts = [];
  let hasUserMessage = false;

  for (const msg of group.messages) {
    if (msg.role === 'user') {
      hasUserMessage = true;
      parts.push(renderUserMessage(msg));
    } else if (msg.role === 'assistant') {
      parts.push(renderAssistantMessage(msg, toolResults));
    } else if (msg.role === 'system') {
      parts.push(renderSystemMessage(msg));
    }
    // tool 消息不再独立渲染，已合并到 assistant 的 tool-block 中
  }

  // 找到用户消息作为摘要标题
  const userMsg = group.messages.find(m => m.role === 'user');
  const titleText = userMsg
    ? truncateForPreview(userMsg.content.replace(/\n/g, ' '), 80)
    : `Turn ${group.turn}`;

  // 时间戳
  let timeLabel = '';
  if (callTimestamps) {
    const ts = callTimestamps.get(group.turn);
    if (ts) {
      timeLabel = new Date(ts).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    }
  }

  const isInteractive = hasUserMessage;

  if (isInteractive) {
    return `
    <details class="turn-group" ${groupIndex === turnGroupCount - 1 ? 'open' : ''}>
      <summary class="turn-summary">
        <span class="turn-number">#${group.userTurn}</span>
        <span class="turn-title">${escapeHtml(titleText)}</span>
        ${timeLabel ? `<span class="turn-time">${escapeHtml(timeLabel)}</span>` : ''}
      </summary>
      <div class="turn-body">
      ${parts.join('')}
      </div>
    </details>`;
  } else {
    // 没有 user 消息的组（通常是初始 system prompt）不折叠
    return `<div class="turn-group static"><div class="turn-body">${parts.join('')}</div></div>`;
  }
}

// ── 导出过滤 ──────────────────────────────────────────────

/**
 * HTML / Markdown 导出共用的消息过滤。
 *
 * - lastNCalls：只保留最近 N 轮（与既有语义一致）
 * - includeDetails：false 时仅保留 user / assistant 的纯正文——
 *   剔除 system 消息与 tool 结果消息，并剥离 assistant 消息上的
 *   reasoning（思考过程）与 toolCalls（工具调用）。
 */
function applyExportFilters(messages, { lastNCalls = null, includeDetails = true } = {}) {
  let filtered = messages;

  if (lastNCalls != null && lastNCalls > 0) {
    const turns = [...new Set(messages.map(m => m.turn).filter(t => t != null))].sort((a, b) => a - b);
    const recentTurns = new Set(turns.slice(-lastNCalls));
    filtered = filtered.filter(m => m.turn != null && recentTurns.has(m.turn));
  }

  if (!includeDetails) {
    filtered = filtered
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => (m.role === 'assistant' && (m.reasoning || m.toolCalls))
        ? { ...m, reasoning: undefined, toolCalls: undefined }
        : m);
  }

  return filtered;
}

// ── 主渲染函数 ─────────────────────────────────────────────

function renderConversationHtml(messages, options = {}) {
  const {
    title = '对话记录',
    agentId = '',
    sessionId = '',
    lastNCalls = null,
    includeDetails = true,
    callTimestamps = null, // Map<turn, number(ms)> from usageStats.calls
  } = options;

  const filteredMessages = applyExportFilters(messages, { lastNCalls, includeDetails });

  const toolCallIndex = buildToolCallIndex(filteredMessages);
  // 轮组内无 user/assistant/system 消息时（如 includeDetails=false 过滤后只剩
  // 空 system 组）整组跳过，避免产出空分节
  const turnGroups = assignUserTurnNumbers(groupByTurn(filteredMessages)
    .filter(g => g.messages.some(m => ['user', 'assistant', 'system'].includes(m.role))));

  // 统计信息
  const stats = {
    totalMessages: filteredMessages.length,
    userTurns: turnGroups.filter(g => g.messages.some(m => m.role === 'user')).length,
    toolCalls: filteredMessages.filter(m => m.role === 'tool').length,
    chars: filteredMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0),
  };

  const groupHtml = turnGroups.map((g, i) => renderTurnGroup(g, i, toolCallIndex, callTimestamps, turnGroups.length)).join('\n');

  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${CONVERSATION_CSS}
</style>
</head>
<body>
<div class="conversation-doc">

  <!-- 头部信息 -->
  <header class="conv-header">
    <h1 class="conv-title">${escapeHtml(title)}</h1>
    <div class="conv-meta">
      ${agentId ? `<span>Agent: ${escapeHtml(agentId)}</span>` : ''}
      ${sessionId ? `<span>Session: ${escapeHtml(sessionId.slice(-12))}</span>` : ''}
      <span>${stats.userTurns} 轮对话 · ${stats.totalMessages} 条消息 · ${stats.toolCalls} 次工具调用</span>
      <span>${escapeHtml(timestamp)}</span>
    </div>
  </header>

  <!-- 消息区域 -->
  <main class="chat-container">
${groupHtml}
  </main>

</div>
</body>
</html>`;
}

// ── Markdown 渲染 ─────────────────────────────────────────

/** 代码块围栏：内容本身含 ``` 时升级为四反引号，避免截断 */
function mdFenceWrap(content, lang = '') {
  const text = String(content ?? '');
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** 引用块：逐行加 "> " 前缀（空行为 ">"） */
function mdBlockquote(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

function renderToolBlockMarkdown(call, resultMsg) {
  const displayName = getToolDisplayName(call.name);
  const argsJson = JSON.stringify(call.arguments, null, 2);

  let statusIcon = '·';
  let resultSection = '';
  if (resultMsg) {
    const { success, data } = parseToolResult(resultMsg.content);
    statusIcon = success ? '✓' : '✗';
    const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    resultSection = `\n结果：\n\n${mdFenceWrap(truncateForPreview(displayData, 5000))}\n`;
  }

  return `**工具调用 · ${displayName}** ${statusIcon}\n\n参数：\n\n${mdFenceWrap(argsJson, 'json')}\n${resultSection}`;
}

/**
 * 将 Message[] 渲染为 Markdown 文档，结构与 HTML 导出镜像：
 * 文档头（标题 + 元信息）→ 按 turn 分节 → 消息正文。
 * user / assistant 的 content 本身就是 Markdown，原样透传。
 */
function renderConversationMarkdown(messages, options = {}) {
  const {
    title = '对话记录',
    agentId = '',
    sessionId = '',
    lastNCalls = null,
    includeDetails = true,
    callTimestamps = null,
  } = options;

  const filteredMessages = applyExportFilters(messages, { lastNCalls, includeDetails });
  const turnGroups = assignUserTurnNumbers(groupByTurn(filteredMessages)
    .filter(g => g.messages.some(m => ['user', 'assistant', 'system'].includes(m.role))));

  const stats = {
    totalMessages: filteredMessages.length,
    userTurns: turnGroups.filter(g => g.messages.some(m => m.role === 'user')).length,
    toolCalls: filteredMessages.filter(m => m.role === 'tool').length,
    chars: filteredMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0),
  };

  // 标题去掉换行，防止注入额外标题层级
  const safeTitle = String(title).replace(/[\r\n]+/g, ' ').trim() || '对话记录';
  const out = [];
  out.push(`# ${safeTitle}`);
  out.push('');
  const metaLines = [];
  if (agentId) metaLines.push(`Agent: ${agentId}`);
  if (sessionId) metaLines.push(`Session: ${sessionId.slice(-12)}`);
  metaLines.push(`${stats.userTurns} 轮对话 · ${stats.totalMessages} 条消息 · ${stats.toolCalls} 次工具调用`);
  metaLines.push(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  out.push(mdBlockquote(metaLines.join('  \n')));
  out.push('');

  for (const group of turnGroups) {
    const renderable = group.messages.filter(m => ['user', 'assistant', 'system'].includes(m.role));

    // 含用户输入的轮组以连续编号作节标题；无 user 的组（初始 system prompt）无标题
    const userMsg = group.messages.find(m => m.role === 'user');
    if (userMsg) {
      const titleText = truncateForPreview(userMsg.content.replace(/\n/g, ' '), 80);
      out.push(`## #${group.userTurn} ${titleText}`);

      if (callTimestamps) {
        const ts = callTimestamps.get(group.turn);
        if (ts) {
          out.push('');
          out.push(`*${new Date(ts).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
          })}*`);
        }
      }
    }
    out.push('');

    // tool 结果按 toolCallId 索引，合并进 assistant 消息的工具调用块
    const toolResults = new Map();
    for (const msg of group.messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        toolResults.set(msg.toolCallId, msg);
      }
    }

    for (const msg of renderable) {
      if (msg.role === 'user') {
        out.push('**user**');
        out.push('');
        out.push(msg.content || '');
        out.push('');
      } else if (msg.role === 'assistant') {
        if (msg.reasoning) {
          out.push(mdBlockquote(`**思考过程**\n\n${msg.reasoning}`));
          out.push('');
        }
        if (msg.content) {
          out.push('**assistant**');
          out.push('');
          out.push(msg.content);
          out.push('');
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const call of msg.toolCalls) {
            out.push(renderToolBlockMarkdown(call, toolResults.get(call.id)));
            out.push('');
          }
        }
        // 无正文也无工具调用的 assistant 消息（仅 reasoning 且被过滤时）跳过空节
      } else if (msg.role === 'system') {
        out.push(mdBlockquote(`**系统提醒**\n\n${msg.content}`));
        out.push('');
      }
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export {
  renderConversationHtml,
  renderConversationMarkdown,
  applyExportFilters,
  groupByTurn,
  parseToolResult,
  escapeHtml,
  getToolDisplayName,
  buildToolCallIndex,
  formatToolError,
  TOOL_DISPLAY_NAMES,
};
