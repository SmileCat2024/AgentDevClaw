/**
 * 测试脚本：加载历史对话，渲染为 HTML，检查质量
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { renderConversationHtml } from '../server/conversation-renderer.js';

const SESSIONS_DIR = path.join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions');

// 选两个有代表性的 session
const tests = [
  {
    label: 'rich-6turns',
    file: 'qqbot/session-1780763823053-ccaca0.json',
    agentId: 'qqbot',
  },
  {
    label: 'large-244msgs',
    file: 'qqbot/session-1780567037460-ab4a6e.json',
    agentId: 'qqbot',
  },
  {
    label: 'recent-3turns',
    file: 'qqbot/session-1780763823053-ccaca0.json',
    agentId: 'qqbot',
    lastNCalls: 2,
  },
];

const outDir = path.join(os.tmpdir(), 'conv-render-test');
fs.mkdirSync(outDir, { recursive: true });

for (const test of tests) {
  const sessionPath = path.join(SESSIONS_DIR, test.file);
  const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const messages = raw?.runtime?.context?.messages || [];

  const html = renderConversationHtml(messages, {
    title: `${test.agentId} 对话记录 (${test.label})`,
    agentId: test.agentId,
    sessionId: path.basename(test.file, '.json'),
    lastNCalls: test.lastNCalls ?? null,
  });

  const outPath = path.join(outDir, `conversation-${test.label}.html`);
  fs.writeFileSync(outPath, html, 'utf8');

  const stat = fs.statSync(outPath);
  const filteredCount = test.lastNCalls
    ? messages.filter(m => {
        const turns = [...new Set(messages.map(m => m.turn).filter(t => t != null))].sort((a, b) => a - b);
        const recent = new Set(turns.slice(-test.lastNCalls));
        return m.turn != null && recent.has(m.turn);
      }).length
    : messages.length;

  console.log(`[${test.label}]`);
  console.log(`  Source: ${test.file}`);
  console.log(`  Messages: ${filteredCount} (from ${messages.length})`);
  console.log(`  Output: ${outPath}`);
  console.log(`  Size: ${(stat.size / 1024).toFixed(1)} KB`);
  console.log('');
}

console.log('All outputs in:', outDir);
