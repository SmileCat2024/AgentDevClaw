/**
 * 对话导出渲染测试 — includeDetails 保真度过滤 + Markdown 渲染器
 *
 * 覆盖：
 * - applyExportFilters：includeDetails=false 仅保留 user/assistant 纯正文
 *   （剥 system/tool 消息与 assistant 的 reasoning/toolCalls）
 * - renderConversationHtml：默认全量保真（IM export_conversation 共用链路）
 * - renderConversationMarkdown：镜像 HTML 的分轮结构与内容映射；
 *   含思考过程引用块、工具调用代码块、系统提醒引用块；围栏升级防截断
 * - 内容净化：轮次编号对读者连续化（原始 turn 值可为小数/跳号，不外露）、
 *   token 用量角标不渲染、无 user 轮组无 Turn 标题
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderConversationHtml,
  renderConversationMarkdown,
  applyExportFilters,
} from '../server/conversation-renderer.js';

const MESSAGES = [
  { role: 'system', content: 'you are a helpful agent', turn: 0 },
  { role: 'user', content: '帮我看看这个项目', turn: 1 },
  {
    role: 'assistant',
    content: '好的，我先列一下目录。',
    reasoning: '用户要看项目结构，先 ls',
    toolCalls: [{ id: 'c1', name: 'ls', arguments: { path: '.' } }],
    turn: 1,
  },
  { role: 'tool', content: JSON.stringify({ success: true, result: 'a\nb' }), toolCallId: 'c1', turn: 1 },
  { role: 'system', content: '[reminder] todo list changed', turn: 1 },
  { role: 'assistant', content: '目录里有 a 和 b。', turn: 1 },
];

test('applyExportFilters: includeDetails=false 只留 user/assistant 纯正文', () => {
  const filtered = applyExportFilters(MESSAGES, { includeDetails: false });
  assert.deepEqual(filtered.map(m => m.role), ['user', 'assistant', 'assistant']);
  for (const m of filtered) {
    assert.equal(m.reasoning, undefined);
    assert.equal(m.toolCalls, undefined);
  }
});

test('applyExportFilters: 默认 includeDetails=true 原样保留', () => {
  const filtered = applyExportFilters(MESSAGES);
  assert.equal(filtered.length, MESSAGES.length);
  assert.ok(filtered.some(m => m.role === 'system'));
  assert.ok(filtered.some(m => m.toolCalls));
});

test('renderConversationHtml: includeDetails=false 剔除工具/系统/思考', () => {
  const html = renderConversationHtml(MESSAGES, { includeDetails: false });
  assert.ok(html.includes('帮我看看这个项目'));
  assert.ok(html.includes('目录里有 a 和 b。'));
  // 断言结构标记而非裸类名：CONVERSATION_CSS 里天然含 .tool-block 等选择器
  assert.ok(!html.includes('class="message-row system"'));
  assert.ok(!html.includes('<details class="tool-block"'));
  assert.ok(!html.includes('class="reasoning-block"'));
  // 纯 system 轮组（turn 0）被过滤后不再产出空的 static 分节
  assert.ok(!html.includes('turn-group static'));
});

test('renderConversationHtml: 默认全量保真不变（IM 契约）', () => {
  const html = renderConversationHtml(MESSAGES);
  assert.ok(html.includes('class="reasoning-block"'));
  assert.ok(html.includes('<details class="tool-block"'));
  assert.ok(html.includes('class="message-row system"'));
  assert.ok(html.includes('turn-group static'));
});

test('renderConversationMarkdown: 全量保真包含分轮结构与工具/思考/系统', () => {
  const md = renderConversationMarkdown(MESSAGES, { title: '会话标题', agentId: 'a1', sessionId: 'sess-abcdef123456' });
  assert.ok(md.startsWith('# 会话标题'));
  assert.ok(md.includes('> Agent: a1'));
  assert.ok(md.includes('> Session: abcdef123456'));
  assert.ok(md.includes('## #1'));
  assert.ok(md.includes('**user**'));
  assert.ok(md.includes('**assistant**'));
  assert.ok(md.includes('> **思考过程**'));
  assert.ok(md.includes('用户要看项目结构，先 ls'));
  assert.ok(md.includes('**工具调用 · LS** ✓'));
  assert.ok(md.includes('```json'));
  assert.ok(md.includes('结果：'));
  assert.ok(md.includes('> **系统提醒**'));
});

test('renderConversationMarkdown: includeDetails=false 仅纯对话', () => {
  const md = renderConversationMarkdown(MESSAGES, { includeDetails: false });
  assert.ok(md.includes('**user**'));
  assert.ok(md.includes('帮我看看这个项目'));
  assert.ok(md.includes('目录里有 a 和 b。'));
  assert.ok(!md.includes('思考过程'));
  assert.ok(!md.includes('工具调用 ·'));
  assert.ok(!md.includes('系统提醒'));
  assert.ok(!md.includes('```json'));
});

test('renderConversationMarkdown: 内容含三反引号时围栏升级防截断', () => {
  const messages = [
    { role: 'user', content: 'q', turn: 1 },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'echo "```"' } }],
      turn: 1,
    },
  ];
  const md = renderConversationMarkdown(messages);
  assert.ok(md.includes('````json'));
});

test('renderConversationMarkdown: 标题换行被压平，不注入标题层级', () => {
  const md = renderConversationMarkdown([{ role: 'user', content: 'hi', turn: 1 }], {
    title: '标题一\n## 标题二',
  });
  assert.ok(md.startsWith('# 标题一 ## 标题二'));
});

test('renderConversation: 轮次编号对读者连续化，原始 turn 值（小数/跳号）不外露', () => {
  const messages = [
    { role: 'user', content: '第一问', turn: 1 },
    { role: 'assistant', content: '第一答', turn: 1 },
    { role: 'user', content: '中途插话', turn: 1.5 },
    { role: 'assistant', content: '插话之答', turn: 1.5 },
    { role: 'user', content: '第三问', turn: 3 },
    { role: 'assistant', content: '第三答', turn: 3 },
  ];
  const md = renderConversationMarkdown(messages);
  assert.ok(md.includes('## #1 第一问'));
  assert.ok(md.includes('## #2 中途插话'));
  assert.ok(md.includes('## #3 第三问'));
  assert.ok(!md.includes('#1.5'));
  const html = renderConversationHtml(messages);
  assert.ok(html.includes('#2</span>'));
  assert.ok(!html.includes('#1.5'));
});

test('renderConversation: 工程痕迹不进入导出内容（token 用量、Turn 字样）', () => {
  const messages = [
    { role: 'system', content: 'you are an agent', turn: 0 },
    { role: 'user', content: 'q', turn: 1 },
    { role: 'assistant', content: 'a', usage: { inputTokens: 10, outputTokens: 20 }, turn: 1 },
  ];
  const html = renderConversationHtml(messages);
  assert.ok(!html.includes('class="token-info"'));
  assert.ok(!html.includes('↑10'));
  const md = renderConversationMarkdown(messages);
  assert.ok(!md.includes('Turn '));
});
