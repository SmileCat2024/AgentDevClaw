/**
 * 对话渲染器 CSS — 纯样式字符串
 *
 * 从 viewer-html.ts 提取核心样式，适配 mobile-first 自包含文件。
 * 无任何逻辑，仅导出 CSS 字符串供 conversation-renderer.js 消费。
 */

const CONVERSATION_CSS = `
:root {
  --bg-color: #000000;
  --surface: #0a0a0a;
  --surface-2: #111;
  --text-primary: #ededed;
  --text-secondary: #888;
  --text-muted: #555;
  --border-color: #222;
  --border-light: #333;
  --user-msg-bg: #1a1a1a;
  --tool-msg-bg: #050505;
  --accent: #ededed;
  --accent-soft: rgba(255,255,255,0.04);
  --accent-border: #444;
  --success: #3fb950;
  --error: #f85149;
  --code-bg: #0d0d0d;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

/* 隐藏滚动条但保留滚动 */
::-webkit-scrollbar { width: 0; height: 0; }
* { scrollbar-width: none; -ms-overflow-style: none; }

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
  color: var(--text-primary);
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
  gap: 14px;
}

/* ── Turn 分组 ── */
.turn-group {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface);
}
.turn-group[open] { background: var(--surface); }

.turn-summary {
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
  background: var(--surface-2);
  list-style: none;
  border-bottom: 1px solid var(--border-color);
}
.turn-summary::-webkit-details-marker { display: none; }
.turn-summary::before {
  content: '▶';
  font-size: 9px;
  transition: transform 0.2s;
  color: var(--text-muted);
  flex-shrink: 0;
}
.turn-group[open] > .turn-summary::before {
  transform: rotate(90deg);
}
.turn-group[open] > .turn-summary {
  border-bottom: 1px solid var(--border-color);
}
.turn-group:not([open]) > .turn-summary {
  border-bottom: none;
}
.turn-number {
  font-weight: 700;
  color: var(--accent);
  font-size: 12px;
  flex-shrink: 0;
}
.turn-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.turn-time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.turn-body {
  padding: 4px 0 16px;
}

.turn-group.static {
  border: none;
  border-radius: 0;
  background: transparent;
}
.turn-group.static .turn-body {
  padding: 0;
}

/* ── 消息行 ── */
.message-row {
  padding: 10px 16px 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.message-row:last-child {
  padding-bottom: 0;
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
  border: 1px solid var(--border-light);
}
.message-row.user .role-badge { color: var(--text-primary); border-color: var(--border-light); }
.message-row.assistant .role-badge { color: var(--success); border-color: rgba(63,185,80,0.3); }
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
  color: var(--text-primary);
}
.markdown-body h1 { font-size: 1.4em; }
.markdown-body h2 { font-size: 1.25em; }
.markdown-body h3 { font-size: 1.1em; }
.markdown-body ul, .markdown-body ol { margin-bottom: 10px; padding-left: 24px; }
.markdown-body li { margin-bottom: 4px; }
.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", "Source Code Pro", Consolas, monospace;
  font-size: 0.875em;
  background: var(--code-bg);
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
.markdown-body a { color: var(--accent); text-decoration: none; }
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
  background: var(--surface-2);
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
  border-left: 2px solid var(--border-light);
  padding-left: 14px;
  background: var(--accent-soft);
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

/* ── Assistant Text (核心输出，视觉强调) ── */
.assistant-text {
  font-size: 15px;
  line-height: 1.7;
  padding: 6px 0 8px 14px;
  border-left: 3px solid var(--accent-border);
  margin-left: -2px;
}

/* ── Tool Block (紧凑折叠，call+result 合并) ── */
.tool-block-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.tool-block {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  background: var(--tool-msg-bg);
}
.tool-block-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  color: var(--text-secondary);
}
.tool-block-bar::-webkit-details-marker { display: none; }
.tool-block-bar::before {
  content: '▸';
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.tool-block[open] > .tool-block-bar { border-bottom: 1px solid var(--border-color); }
.tool-block[open] > .tool-block-bar::before { content: '▾'; }
.tool-block-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}
.tool-block-status.ok { background: rgba(63,185,80,0.15); color: var(--success); }
.tool-block-status.fail { background: rgba(248,81,73,0.15); color: var(--error); }
.tool-block-status.pending { background: rgba(136,136,136,0.1); color: var(--text-muted); }
.tool-block-name {
  color: var(--text-primary);
  font-weight: 600;
  flex-shrink: 0;
}
.tool-block-arg-preview {
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}
.tool-block-detail { padding: 0; }
.tool-block-section { padding: 8px 12px; }
.tool-block-section + .tool-block-section {
  border-top: 1px solid var(--border-color);
}
.tool-block-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.tool-block-json {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
.tool-block-result .bash-output {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", "Source Code Pro", Consolas, monospace;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  font-size: 12px;
  max-height: 300px;
  overflow-y: auto;
}

/* ── Tool Error ── */
.tool-error {
  background: rgba(248,81,73,0.08);
  border: 1px solid rgba(248,81,73,0.25);
  color: var(--error);
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
  .tool-block-result .bash-output { max-height: 250px; }
}
`;

export { CONVERSATION_CSS };
