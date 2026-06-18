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
  task_get: 'Task Get',
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

function renderToolCallCard(call) {
  const displayName = getToolDisplayName(call.name);
  const argsJson = JSON.stringify(call.arguments, null, 2);
  return `
        <div class="tool-call-container">
          <div class="tool-header">
            <span class="tool-header-name">${escapeHtml(displayName)}</span>
          </div>
          <div class="tool-content">
            <details class="tool-args-details">
              <summary>参数</summary>
              <pre class="tool-args-json">${escapeHtml(argsJson)}</pre>
            </details>
          </div>
        </div>`;
}

function renderToolResult(msg, toolCallIndex) {
  const toolCallId = msg.toolCallId;
  const meta = toolCallIndex.get(toolCallId) || {};
  const displayName = getToolDisplayName(meta.name);
  const { success, data } = parseToolResult(msg.content);

  let bodyHtml;
  if (!success) {
    bodyHtml = formatToolError(data);
  } else {
    const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    bodyHtml = `<pre class="bash-output">${escapeHtml(truncateForPreview(displayData, 5000))}</pre>`;
  }

  return `
      <div class="message-row tool">
        <div class="message-meta">
          <div class="role-badge">tool</div>
        </div>
        <div class="message-content tool-result-wrapper">
          <div class="tool-result-header">
            <span class="status-dot ${success ? 'success' : 'error'}"></span>
            <span>${escapeHtml(displayName)}</span>
          </div>
          <div class="tool-result-body">${bodyHtml}</div>
        </div>
      </div>`;
}

function renderAssistantMessage(msg) {
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

  // Content
  if (msg.content) {
    if (msg.content.startsWith('[Error:') || msg.content.startsWith('[API Error:')) {
      innerContent += `<div class="tool-error">${escapeHtml(msg.content)}</div>`;
    } else {
      innerContent += `<div class="markdown-body assistant-content">${renderMarkdown(msg.content)}</div>`;
    }
  }

  // Tool calls
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      innerContent += renderToolCallCard(call);
    }
  }

  return `
      <div class="message-row assistant">
        <div class="message-meta">
          <div class="role-badge">assistant</div>
          ${msg.usage ? `<span class="token-info">↑${msg.usage.inputTokens} ↓${msg.usage.outputTokens}</span>` : ''}
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

function renderTurnGroup(group, groupIndex, toolCallIndex) {
  const parts = [];
  let hasUserMessage = false;

  for (const msg of group.messages) {
    if (msg.role === 'user') {
      hasUserMessage = true;
      parts.push(renderUserMessage(msg));
    } else if (msg.role === 'assistant') {
      parts.push(renderAssistantMessage(msg));
    } else if (msg.role === 'tool') {
      parts.push(renderToolResult(msg, toolCallIndex));
    } else if (msg.role === 'system') {
      parts.push(renderSystemMessage(msg));
    }
  }

  // 找到用户消息作为摘要标题
  const userMsg = group.messages.find(m => m.role === 'user');
  const titleText = userMsg
    ? truncateForPreview(userMsg.content.replace(/\n/g, ' '), 80)
    : `Turn ${group.turn}`;

  const isInteractive = hasUserMessage;

  if (isInteractive) {
    return `
    <details class="turn-group" ${groupIndex === 0 ? 'open' : ''}>
      <summary class="turn-summary">
        <span class="turn-number">#${group.turn}</span>
        <span class="turn-title">${escapeHtml(titleText)}</span>
      </summary>
      ${parts.join('')}
    </details>`;
  } else {
    // 没有 user 消息的组（通常是初始 system prompt）不折叠
    return `<div class="turn-group static">${parts.join('')}</div>`;
  }
}

// ── 主渲染函数 ─────────────────────────────────────────────

function renderConversationHtml(messages, options = {}) {
  const {
    title = '对话记录',
    agentId = '',
    sessionId = '',
    lastNCalls = null,
  } = options;

  // 过滤：最近 N 轮
  let filteredMessages = messages;
  if (lastNCalls != null && lastNCalls > 0) {
    const turns = [...new Set(messages.map(m => m.turn).filter(t => t != null))].sort((a, b) => a - b);
    const recentTurns = new Set(turns.slice(-lastNCalls));
    filteredMessages = messages.filter(m => m.turn != null && recentTurns.has(m.turn));
  }

  const toolCallIndex = buildToolCallIndex(filteredMessages);
  const turnGroups = groupByTurn(filteredMessages);

  // 统计信息
  const stats = {
    totalMessages: filteredMessages.length,
    userTurns: turnGroups.filter(g => g.messages.some(m => m.role === 'user')).length,
    toolCalls: filteredMessages.filter(m => m.role === 'tool').length,
    chars: filteredMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0),
  };

  const groupHtml = turnGroups.map((g, i) => renderTurnGroup(g, i, toolCallIndex)).join('\n');

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

// ── CSS ───────────────────────────────────────────────────
// 从 viewer-html.ts 提取核心样式，适配 mobile-first 自包含文件

const CONVERSATION_CSS = `
:root {
  --bg-color: #0d1117;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #484f58;
  --border-color: #30363d;
  --user-msg-bg: #1c2128;
  --tool-msg-bg: #161b22;
  --hover-bg: #21262d;
  --success-color: #3fb950;
  --error-color: #f85149;
  --accent-blue: #58a6ff;
  --code-bg: #161b22;
  --reasoning-bg: rgba(255,255,255,0.03);
  --reasoning-border: #30363d;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
  background-color: var(--bg-color);
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.conversation-doc {
  max-width: 820px;
  margin: 0 auto;
  padding: 20px 16px 80px;
}

/* ── 头部 ── */
.conv-header {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}
.conv-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 8px;
}
.conv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* ── 消息容器 ── */
.chat-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Turn 分组 ── */
.turn-group {
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(255,255,255,0.01);
}
.turn-group[open] { background: rgba(255,255,255,0.015); }

.turn-summary {
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
  background: rgba(255,255,255,0.03);
  list-style: none;
}
.turn-summary::-webkit-details-marker { display: none; }
.turn-summary::before {
  content: '▶';
  font-size: 10px;
  transition: transform 0.2s;
  color: var(--text-muted);
}
.turn-group[open] > .turn-summary::before {
  transform: rotate(90deg);
}
.turn-number {
  font-weight: 700;
  color: var(--accent-blue);
  font-size: 12px;
  flex-shrink: 0;
}
.turn-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turn-group.static {
  border: none;
  border-radius: 0;
  background: transparent;
}

/* ── 消息行 ── */
.message-row {
  padding: 0 16px;
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.turn-group.static > .message-row:first-child {
  padding-top: 0;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}
.role-badge {
  font-weight: 700;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
}
.message-row.user .role-badge { color: var(--accent-blue); border-color: rgba(88,166,255,0.4); }
.message-row.assistant .role-badge { color: #3fb950; border-color: rgba(63,185,80,0.4); }
.message-row.tool .role-badge { color: var(--text-secondary); }
.message-row.system .role-badge { color: var(--text-muted); }

.token-info {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
  font-size: 10px;
  color: var(--text-muted);
}

.message-content {
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: break-word;
}

/* ── User ── */
.message-row.user .message-content {
  background-color: var(--user-msg-bg);
  max-width: 85%;
  align-self: flex-end;
  border-bottom-right-radius: 2px;
}
.message-row.user { align-items: flex-end; }
.message-row.user .message-meta { justify-content: flex-end; }

/* ── Assistant ── */
.message-row.assistant .message-content {
  background: transparent;
  padding: 0;
  width: 100%;
}

.assistant-content {
  margin-bottom: 8px;
}

/* ── System ── */
.message-row.system {
  align-items: center;
}
.message-row.system .message-content {
  background: transparent;
  border: 1px dashed var(--border-color);
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  max-width: 90%;
}

/* 长系统消息折叠 */
.system-collapse {
  width: 100%;
}
.system-collapse > summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 6px 12px;
  background: transparent;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  user-select: none;
  list-style: none;
  text-align: center;
}
.system-collapse > summary::-webkit-details-marker { display: none; }
.system-collapse > summary::before {
  content: '▶ ';
  font-size: 9px;
  color: var(--text-muted);
}
.system-collapse[open] > summary::before {
  content: '▼ ';
}
.system-collapse[open] > summary {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.system-long-content {
  text-align: left;
  border: 1px dashed var(--border-color);
  border-top: none;
  border-radius: 0 0 6px 6px;
  font-size: 12px;
  max-height: 400px;
  overflow-y: auto;
}

/* ── Markdown ── */
.markdown-body {
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.65;
}
.markdown-body p { margin-bottom: 10px; }
.markdown-body p:last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin-top: 18px;
  margin-bottom: 10px;
  font-weight: 700;
}
.markdown-body h1 { font-size: 1.4em; }
.markdown-body h2 { font-size: 1.25em; }
.markdown-body h3 { font-size: 1.1em; }
.markdown-body ul, .markdown-body ol { margin-bottom: 10px; padding-left: 24px; }
.markdown-body li { margin-bottom: 4px; }
.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", "Source Code Pro", Consolas, monospace;
  font-size: 0.875em;
  background: rgba(255,255,255,0.08);
  padding: 2px 6px;
  border-radius: 4px;
}
.markdown-body pre {
  background: var(--code-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  margin-bottom: 12px;
  font-size: 13px;
}
.markdown-body pre code {
  background: transparent;
  padding: 0;
  font-size: inherit;
}
.markdown-body blockquote {
  border-left: 3px solid var(--border-color);
  padding-left: 14px;
  margin-bottom: 12px;
  color: var(--text-secondary);
}
.markdown-body a { color: var(--accent-blue); text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
  font-size: 13px;
}
.markdown-body th, .markdown-body td {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
}
.markdown-body th {
  background: var(--hover-bg);
  font-weight: 600;
  text-align: left;
}
.markdown-body img { max-width: 100%; border-radius: 8px; }
.markdown-body hr {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 16px 0;
}

/* ── Reasoning ── */
.reasoning-block {
  margin-bottom: 12px;
  border-left: 2px solid var(--reasoning-border);
  padding-left: 14px;
  background: var(--reasoning-bg);
  border-radius: 0 4px 4px 0;
}
.reasoning-header {
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  user-select: none;
  list-style: none;
}
.reasoning-header::-webkit-details-marker { display: none; }
.reasoning-header::before {
  content: '▶';
  font-size: 9px;
  transition: transform 0.2s;
}
.reasoning-block[open] > .reasoning-header::before {
  transform: rotate(90deg);
}
.reasoning-icon { transition: transform 0.2s; }
.reasoning-content {
  padding-bottom: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ── Tool Call ── */
.tool-call-container {
  margin-top: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  background: var(--tool-msg-bg);
}
.tool-header {
  background: var(--hover-bg);
  padding: 6px 12px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}
.tool-header-name {
  color: var(--text-primary);
  font-weight: 600;
}
.tool-content {
  padding: 10px 12px;
  font-size: 13px;
}
.tool-args-details {
  font-size: 12px;
}
.tool-args-details > summary {
  cursor: pointer;
  color: var(--text-secondary);
  padding: 2px 0;
  user-select: none;
}
.tool-args-details > summary::before {
  content: '▶ ';
  font-size: 9px;
}
.tool-args-details[open] > summary::before {
  content: '▼ ';
}
.tool-args-json {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  margin-top: 6px;
  margin-bottom: 0;
}

/* ── Tool Result ── */
.tool-result-wrapper {
  padding: 0 !important;
  overflow: hidden;
}
.tool-result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--hover-bg);
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-bottom: none;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.success {
  background: var(--success-color);
  box-shadow: 0 0 4px rgba(63,185,80,0.4);
}
.status-dot.error {
  background: var(--error-color);
  box-shadow: 0 0 4px rgba(248,81,73,0.4);
}
.tool-result-body {
  background: var(--tool-msg-bg);
  border: 1px solid var(--border-color);
  border-top: none;
  padding: 10px 12px;
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
  font-size: 13px;
}
.bash-output {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", "Source Code Pro", Consolas, monospace;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  font-size: 12px;
}

/* ── Tool Error ── */
.tool-error {
  background: rgba(248,81,73,0.1);
  border: 1px solid rgba(248,81,73,0.3);
  color: #ff7b72;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
}

/* ── Mobile ── */
@media (max-width: 600px) {
  .conversation-doc { padding: 12px 8px 60px; }
  .conv-title { font-size: 17px; }
  .message-content { font-size: 14px; }
  .message-row.user .message-content { max-width: 92%; }
  .markdown-body pre { font-size: 12px; padding: 10px; }
  .tool-result-body { max-height: 300px; }
}
`;

export {
  renderConversationHtml,
  groupByTurn,
  parseToolResult,
  escapeHtml,
  getToolDisplayName,
  TOOL_DISPLAY_NAMES,
};
