// Isolated browser fixture; no real user data or credentials.
import { promises as fs } from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.env.AGENTDEV_DATA_DIR || '.tmp/history-search-preview');
const dir = path.join(root, 'workspaces/programming-helper');
await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
// Opening stored history needs an LLM instance but makes no model call.
await fs.writeFile(path.join(root, 'default.json'), JSON.stringify({ defaultModel: {
  model: 'search-preview-no-calls', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'isolated-preview-not-a-real-key',
} }));
const cwd = path.resolve('.');
const sessions = [];
for (let i = 0; i < 26; i++) {
  const id = `session-preview-${i}`;
  const messages = [
    { role: 'system', content: 'You help with programming.' },
    { role: 'user', content: '我们之前讨论过搜索列表的信息层级。我想用 MCP 找回那次对话，同时能看到我当时问了什么。' },
    { role: 'assistant', content: 'MCP 搜索结果保留标题和时间，用原文片段恢复语境。列表内不添加嵌套卡片，展开后直接阅读上下文。\n\n这里保留了一段较长的说明，用于核对搜索结果展开后的可读性与行距。' },
    { role: 'user', content: 'MCP 的结果需要支持归档筛选。能保留浏览位置吗？' },
    { role: 'assistant', content: '可以，返回搜索后保留关键词、筛选与展开位置。' },
  ];
  const title = i === 0 ? 'MCP 搜索列表的信息层级与长标题换行体验验证' : `历史对话片段预览 ${i}`;
  await fs.writeFile(path.join(dir, 'sessions', id + '.json'), JSON.stringify({ version: 1, agentName: '智能编码空间', runtime: { context: { messages } } }));
  const st = await fs.stat(path.join(dir, 'sessions', id + '.json'));
  sessions.push({ id, title, openDirectory: cwd, archived: i % 3 === 0, todo: i === 1, updatedAt: new Date(Date.UTC(2026, 9, 21, 0, i)).toISOString(), createdAt: '2026-10-01T00:00:00.000Z', messageCount: messages.length, fileMtimeMs: st.mtimeMs });
}
await fs.writeFile(path.join(dir, 'sessions/index.json'), JSON.stringify({ revision: 1, activeSessionId: null, sessions }));
await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ openDirectory: cwd, phProjects: [{ openDirectory: cwd }] }));
console.log(root);
