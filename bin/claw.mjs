#!/usr/bin/env node

/**
 * claw - AgentDevClaw CLI
 *
 * 命令体系：
 *   claw                         状态概览
 *   claw ls [--dir <path>]       列出编程小助手的会话
 *   claw sessions                同 claw ls（别名）
 *   claw show <session>          显示会话详情
 *   claw compact <session>       对会话执行上下文压缩
 *   claw summaries [--dir <path>] 列出可用的领域摘要
 *   claw summary-show <session>  显示某会话的完整领域摘要
 *   claw seed <session...> [--mode full|summary] [--with-summary <session>] [--json]
 *                                构建子代理上下文注入种子
 *   claw spawn <session...> [--mode full|summary] [--with-summary <session>] [--goal <text>]
 *                                从指定会话的上下文启动新会话
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const SERVER_URL = process.env.PROTOCLAW_SERVER_URL || 'http://127.0.0.1:1420';

const USER_DATA_ROOT = join(os.homedir(), '.agentdev', 'AgentDevClaw');
const WORKSPACES_ROOT = join(USER_DATA_ROOT, 'workspaces');
const PROGRAMMING_HELPER_DIR = join(WORKSPACES_ROOT, 'programming-helper');
const SESSIONS_DIR = join(PROGRAMMING_HELPER_DIR, 'sessions');
const HANDOFFS_DIR = join(USER_DATA_ROOT, 'context-handoffs', 'programming-helper');

// --- Helpers ---

function sanitizeFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeDir(dir) {
  if (!dir) return '';
  return dir.replace(/\\/g, '/').toLowerCase();
}

function resolveDir(inputDir) {
  if (!inputDir) return '';
  const resolved = resolve(inputDir);
  return existsSync(resolved) ? resolved : '';
}

function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function truncate(text, maxLen = 120) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '…';
}

// --- Data readers ---

function readWorkspaceState() {
  return readJson(join(PROGRAMMING_HELPER_DIR, 'state.json')) || { forms: {}, openDirectory: '' };
}

function readSessionIndex() {
  const index = readJson(join(SESSIONS_DIR, 'index.json'));
  if (!index) return { activeSessionId: null, sessions: [] };
  const sessions = Array.isArray(index.sessions)
    ? index.sessions.filter(s => s && s.id && s.id !== 'legacy')
    : [];
  return { activeSessionId: index.activeSessionId, sessions };
}

function loadSessionDetail(sessionId) {
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readJson(filePath);
  if (!raw) return null;

  const messages = Array.isArray(raw?.runtime?.context?.messages)
    ? raw.runtime.context.messages
    : [];
  const lastMessage = [...messages].reverse().find(
    m => m && typeof m.content === 'string' && m.role !== 'system'
  );

  return {
    id: sessionId,
    savedAt: raw.savedAt,
    messageCount: messages.length,
    lastMessage: lastMessage?.content
      ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 200)
      : '',
    messages,
  };
}

function getProjectName(openDirectory) {
  if (!openDirectory) return '';
  const normalized = openDirectory.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

/**
 * 扫描所有 handoff 文件，返回摘要索引条目数组。
 * 每个条目对应一个 session 的最新 handoff。
 */
function scanHandoffSummaries() {
  if (!existsSync(HANDOFFS_DIR)) return [];

  let files;
  try {
    files = readdirSync(HANDOFFS_DIR)
      .filter(name => name.startsWith('handoff-') && name.endsWith('.json'))
      .map(name => join(HANDOFFS_DIR, name))
      .filter(filePath => statSync(filePath).isFile());
  } catch {
    return [];
  }

  const bySession = new Map();

  for (const filePath of files) {
    const handoff = readJson(filePath);
    if (!handoff || !handoff.sourceSessionId) continue;

    const sessionId = handoff.sourceSessionId;
    const existing = bySession.get(sessionId);
    const createdAt = handoff.createdAt || '';

    // Keep the latest handoff per session
    if (!existing || createdAt > (existing.handoffCreatedAt || '')) {
      bySession.set(sessionId, {
        sessionId,
        handoffId: handoff.handoffId || '',
        handoffPath: filePath,
        handoffCreatedAt: createdAt,
        mode: handoff.mode || '',
        openDirectory: cleanText(handoff.sourceRecord?.openDirectory),
        title: cleanText(handoff.sourceRecord?.title || handoff.sourceRecord?.taskTitle),
        goal: cleanText(handoff.sourceRecord?.goal),
        summaryText: cleanText(handoff.sourceSummary),
        summaryPreview: truncate(cleanText(handoff.sourceSummary), 120),
        importantFiles: Array.isArray(handoff.compactOutput?.importantFiles)
          ? handoff.compactOutput.importantFiles
          : [],
        importantSkills: Array.isArray(handoff.compactOutput?.importantSkills)
          ? handoff.compactOutput.importantSkills
          : [],
        seedMessages: Array.isArray(handoff.seedMessages) ? handoff.seedMessages : [],
        stats: handoff.stats || {},
      });
    }
  }

  return [...bySession.values()].sort((a, b) =>
    String(b.handoffCreatedAt || '').localeCompare(String(a.handoffCreatedAt || ''))
  );
}

/**
 * 查找指定 session 的 handoff 摘要条目。
 */
function findHandoffSummary(sessionId) {
  if (!sessionId) return null;

  // Try direct file scan to find the latest handoff for this session
  if (!existsSync(HANDOFFS_DIR)) return null;

  let files;
  try {
    files = readdirSync(HANDOFFS_DIR)
      .filter(name => name.startsWith('handoff-') && name.endsWith('.json'))
      .map(name => join(HANDOFFS_DIR, name))
      .filter(filePath => statSync(filePath).isFile());
  } catch {
    return null;
  }

  let best = null;
  let bestPath = '';
  for (const filePath of files) {
    const handoff = readJson(filePath);
    if (!handoff || handoff.sourceSessionId !== sessionId) continue;
    const createdAt = handoff.createdAt || '';
    if (!best || createdAt > (best.createdAt || '')) {
      best = handoff;
      bestPath = filePath;
    }
  }

  if (!best) return null;

  return {
    sessionId,
    handoffId: best.handoffId || '',
    handoffPath: bestPath,
    handoffCreatedAt: best.createdAt || '',
    mode: best.mode || '',
    openDirectory: cleanText(best.sourceRecord?.openDirectory),
    title: cleanText(best.sourceRecord?.title || best.sourceRecord?.taskTitle),
    goal: cleanText(best.sourceRecord?.goal),
    summaryText: cleanText(best.sourceSummary),
    summaryPreview: truncate(cleanText(best.sourceSummary), 120),
    importantFiles: Array.isArray(best.compactOutput?.importantFiles)
      ? best.compactOutput.importantFiles
      : [],
    importantSkills: Array.isArray(best.compactOutput?.importantSkills)
      ? best.compactOutput.importantSkills
      : [],
    seedMessages: Array.isArray(best.seedMessages) ? best.seedMessages : [],
    stats: best.stats || {},
  };
}

// --- Commands: existing ---

function cmdOverview() {
  const state = readWorkspaceState();
  const index = readSessionIndex();
  const openDir = cleanText(state.openDirectory);

  console.log('AgentDevClaw');
  console.log('');

  if (openDir) {
    console.log(`  编程小助手 · 工作目录: ${openDir}`);
  } else {
    console.log('  编程小助手 · 尚未设置工作目录');
  }

  const sessionCount = index.sessions.length;
  const activeId = index.activeSessionId;
  const summaries = scanHandoffSummaries();

  if (sessionCount === 0) {
    console.log('  暂无对话记录');
  } else {
    console.log(`  ${sessionCount} 个对话${activeId ? `，当前活跃: ${activeId}` : ''}`);
  }

  if (summaries.length > 0) {
    console.log(`  ${summaries.length} 份领域摘要`);
  }

  console.log('');
  console.log('  用法:');
  console.log('    claw ls               列出对话记录');
  console.log('    claw summaries        列出领域摘要');
  console.log('    claw show <session>   查看对话详情');
  console.log('    claw seed <session>   构建上下文注入种子');
  console.log('    claw spawn <session>  从历史上下文启动新会话');
  console.log('    claw compact <session> 压缩对话上下文');
}

function cmdList(filterDir) {
  const state = readWorkspaceState();
  const index = readSessionIndex();
  const workspaceDir = cleanText(state.openDirectory);
  const normalizedFilter = filterDir ? normalizeDir(filterDir) : '';

  const sessions = index.sessions
    .map(record => {
      const sessionOpenDir = cleanText(record.openDirectory)
        || (workspaceDir && !record.openDirectory ? workspaceDir : '');
      return { ...record, resolvedOpenDir: sessionOpenDir };
    })
    .filter(s => {
      if (!normalizedFilter) return true;
      return normalizeDir(s.resolvedOpenDir) === normalizedFilter;
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const header = filterDir
    ? `编程小助手 · ${filterDir}`
    : (workspaceDir ? `编程小助手 · ${workspaceDir}` : '编程小助手');

  console.log(header);

  if (sessions.length === 0) {
    console.log('');
    console.log(normalizedFilter ? '  该目录下暂无对话记录' : '  暂无对话记录');
    return;
  }

  console.log(`${sessions.length} 个对话`);
  console.log('');

  const activeId = index.activeSessionId;

  for (const session of sessions) {
    const title = cleanText(session.title) || session.id;
    const msgCount = Number(session.messageCount ?? 0);
    const date = formatDate(session.updatedAt);
    const active = session.id === activeId ? ' ← 当前' : '';
    const dir = session.resolvedOpenDir && !filterDir
      ? `  [${session.resolvedOpenDir}]`
      : '';

    const id = session.id;
    const shortId = id.length > 30 ? `...${id.slice(-24)}` : id;

    console.log(`  ${shortId}  ${title}  ${msgCount}条消息  ${date}${active}${dir}`);
  }
}

function cmdShow(sessionId) {
  if (!sessionId) {
    console.error('用法: claw show <session-id>');
    process.exit(1);
  }

  const index = readSessionIndex();
  const record = index.sessions.find(s => s.id === sessionId);
  const detail = loadSessionDetail(sessionId);

  if (!record && !detail) {
    console.error(`未找到会话: ${sessionId}`);
    process.exit(1);
  }

  const title = cleanText(record?.title) || '(无标题)';
  const openDir = cleanText(record?.openDirectory) || cleanText(readWorkspaceState().openDirectory) || '';
  const taskTitle = cleanText(record?.taskTitle);
  const goal = cleanText(record?.goal);

  console.log(`会话 ${sessionId}`);
  console.log(`标题: ${title}`);
  if (taskTitle && taskTitle !== title) console.log(`任务: ${taskTitle}`);
  if (goal) console.log(`目标: ${goal}`);
  if (openDir) console.log(`目录: ${openDir}`);
  if (detail) {
    console.log(`消息: ${detail.messageCount} 条`);
    console.log(`更新: ${formatDate(detail.savedAt ? new Date(detail.savedAt).toISOString() : record?.updatedAt)}`);
    if (detail.lastMessage) {
      console.log('');
      console.log('最后消息:');
      console.log(`  ${detail.lastMessage}`);
    }
  } else {
    console.log(`创建: ${formatDate(record?.createdAt)}`);
    console.log(`更新: ${formatDate(record?.updatedAt)}`);
    console.log('(会话文件不可读)');
  }
}

function cmdCompact(sessionId) {
  if (!sessionId) {
    console.error('用法: claw compact <session-id>');
    process.exit(1);
  }

  const index = readSessionIndex();
  const record = index.sessions.find(s => s.id === sessionId);
  if (!record) {
    console.error(`未找到会话: ${sessionId}`);
    process.exit(1);
  }

  console.log(`正在压缩会话 ${sessionId} ...`);

  const agentDir = 'prebuilt-agents/official/programming-helper';
  const projectRoot = resolve(join(import.meta.dirname ?? '.', '..'));

  try {
    const resultPath = join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);
    const args = [
      join(projectRoot, 'scripts', 'run-compact-mirror.js'),
      agentDir,
      'programming-helper',
      sessionId,
      '{}',
      resultPath,
    ];

    const output = execFileSync('node', args, {
      cwd: projectRoot,
      timeout: 120000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (output) {
      process.stderr.write(output);
    }

    const result = readJson(resultPath);
    if (result?.ok) {
      console.log('压缩完成');
      console.log(`  摘要长度: ${cleanText(result.summaryText).length} 字符`);
      if (Array.isArray(result.importantFiles) && result.importantFiles.length > 0) {
        console.log('  重要文件:');
        for (const f of result.importantFiles) {
          console.log(`    - ${f}`);
        }
      }
      if (Array.isArray(result.importantSkills) && result.importantSkills.length > 0) {
        console.log('  涉及技能:');
        for (const s of result.importantSkills) {
          console.log(`    - ${s}`);
        }
      }
      console.log('');
      console.log('摘要:');
      console.log(result.summaryText);
    } else {
      console.error('压缩失败: 未生成有效结果');
      process.exit(1);
    }
  } catch (error) {
    console.error('压缩失败:', error.message || error);
    process.exit(1);
  }
}

// --- Commands: summaries ---

function cmdSummaries(filterDir) {
  const allSummaries = scanHandoffSummaries();
  const normalizedFilter = filterDir ? normalizeDir(filterDir) : '';

  const filtered = normalizedFilter
    ? allSummaries.filter(s => normalizeDir(s.openDirectory) === normalizedFilter)
    : allSummaries;

  if (filtered.length === 0) {
    console.log(normalizedFilter ? '该目录下暂无领域摘要' : '暂无领域摘要（使用 claw compact <session> 生成）');
    return;
  }

  // Group by project directory
  const byProject = new Map();
  for (const entry of filtered) {
    const dir = entry.openDirectory || '(未知目录)';
    const projectName = getProjectName(dir);
    if (!byProject.has(dir)) {
      byProject.set(dir, { name: projectName, dir, entries: [] });
    }
    byProject.get(dir).entries.push(entry);
  }

  for (const [, project] of byProject) {
    console.log(`${project.name}  (${project.dir})`);
    console.log(`${project.entries.length} 份摘要`);
    console.log('');

    for (const entry of project.entries) {
      const shortId = entry.sessionId.length > 30 ? `...${entry.sessionId.slice(-24)}` : entry.sessionId;
      const date = formatDate(entry.handoffCreatedAt);
      const title = entry.title || '(无标题)';

      console.log(`  ${shortId}`);
      console.log(`    ${title}  ${date}`);

      if (entry.summaryPreview) {
        console.log(`    ${entry.summaryPreview}`);
      }

      if (entry.importantFiles.length > 0) {
        const files = entry.importantFiles.slice(0, 3).map(f => {
          const segs = f.replace(/\\/g, '/').split('/');
          return segs[segs.length - 1] || f;
        }).join(', ');
        const suffix = entry.importantFiles.length > 3 ? ` +${entry.importantFiles.length - 3}` : '';
        console.log(`    文件: ${files}${suffix}`);
      }

      console.log('');
    }
  }

  console.log(`共 ${filtered.length} 份摘要`);
}

// --- Commands: summary-show ---

function cmdSummaryShow(sessionId) {
  if (!sessionId) {
    console.error('用法: claw summary-show <session-id>');
    process.exit(1);
  }

  const entry = findHandoffSummary(sessionId);
  if (!entry) {
    console.error(`未找到会话 ${sessionId} 的摘要（请先用 claw compact 生成）`);
    process.exit(1);
  }

  console.log(`领域摘要 · ${sessionId}`);
  console.log(`标题: ${entry.title || '(无标题)'}`);
  if (entry.openDirectory) console.log(`目录: ${entry.openDirectory}`);
  if (entry.goal) console.log(`目标: ${entry.goal}`);
  console.log(`模式: ${entry.mode}`);
  console.log(`生成时间: ${formatDate(entry.handoffCreatedAt)}`);

  if (entry.importantFiles.length > 0) {
    console.log('');
    console.log('重要文件:');
    for (const f of entry.importantFiles) {
      console.log(`  - ${f}`);
    }
  }

  if (entry.importantSkills.length > 0) {
    console.log('');
    console.log('涉及技能:');
    for (const s of entry.importantSkills) {
      console.log(`  - ${s}`);
    }
  }

  if (entry.summaryText) {
    console.log('');
    console.log('--- 摘要 ---');
    console.log(entry.summaryText);
  } else {
    console.log('');
    console.log('(无摘要文本)');
  }
}

// --- Commands: seed ---

/**
 * 构建注入种子。
 *
 * 用法：
 *   claw seed <session> --mode full           全量注入（handoff seedMessages）
 *   claw seed <session> --mode summary         摘要注入
 *   claw seed <s1> <s2> --mode summary         多摘要组合
 *   claw seed <s1> --mode full --with-summary <s2>  全量+摘要杂交
 *   --json                                   JSON 输出（便于程序消费）
 */
function cmdSeed(sessionIds, mode, withSummarySessionId, jsonOutput) {
  if (!sessionIds || sessionIds.length === 0) {
    console.error('用法: claw seed <session-id...> [--mode full|summary] [--with-summary <session>] [--json]');
    process.exit(1);
  }

  const resolvedMode = mode || 'summary';
  if (resolvedMode !== 'full' && resolvedMode !== 'summary') {
    console.error(`不支持的模式: ${resolvedMode}（可选: full, summary）`);
    process.exit(1);
  }

  const parts = [];

  // Primary sessions
  for (const sid of sessionIds) {
    const entry = findHandoffSummary(sid);
    if (!entry) {
      console.error(`未找到会话 ${sid} 的摘要`);
      process.exit(1);
    }

    if (resolvedMode === 'full') {
      if (entry.seedMessages.length > 0 && entry.mode === 'trim-transcript') {
        // Trim transcript: actual folded dialogue — preserve as-is for full context
        parts.push({
          source: sid,
          mode: 'full',
          messages: entry.seedMessages,
        });
      } else if (entry.seedMessages.length > 0) {
        // Summary handoff: rewrite with knowledge-injection framing
        parts.push({
          source: sid,
          mode: 'full',
          messages: [buildSummarySeedMessage(entry)],
        });
      } else {
        parts.push({
          source: sid,
          mode: 'summary-fallback',
          messages: [buildSummarySeedMessage(entry)],
        });
      }
    } else {
      parts.push({
        source: sid,
        mode: 'summary',
        messages: [buildSummarySeedMessage(entry)],
      });
    }
  }

  // --with-summary hybrid injection
  if (withSummarySessionId) {
    const extra = findHandoffSummary(withSummarySessionId);
    if (!extra) {
      console.error(`未找到会话 ${withSummarySessionId} 的摘要`);
      process.exit(1);
    }
    parts.push({
      source: withSummarySessionId,
      mode: 'supplementary-summary',
      messages: [buildSummarySeedMessage(extra)],
    });
  }

  // Build final output
  const allMessages = [];
  for (const part of parts) {
    for (const msg of part.messages) {
      allMessages.push(msg);
    }
  }

  if (allMessages.length === 0) {
    console.error('无法生成注入种子：没有可用的消息');
    process.exit(1);
  }

  if (jsonOutput) {
    const output = {
      mode: resolvedMode,
      sessionCount: sessionIds.length,
      supplementarySession: withSummarySessionId || null,
      parts: parts.map(p => ({
        source: p.source,
        mode: p.mode,
        messageCount: p.messages.length,
      })),
      seedMessages: allMessages,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Human-readable output: just the content that would be injected
    for (const msg of allMessages) {
      if (msg.role === 'system') {
        console.log(msg.content);
      } else {
        console.log(`[${msg.role}] ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`);
      }
      console.log('');
    }
  }
}

/**
 * 构建"知识注入"语气的 seed message（区别于"会话续接"语气）。
 */
function buildSummarySeedMessage(entry) {
  const lines = [];

  lines.push(`## 来自历史会话的领域知识`);
  lines.push('');
  lines.push(`以下是从之前的工作会话中提取的领域知识摘要，供你在执行任务时参考。`);
  lines.push('');

  if (entry.title) {
    lines.push(`原始任务: ${entry.title}`);
  }
  if (entry.openDirectory) {
    lines.push(`工作目录: ${entry.openDirectory}`);
  }
  if (entry.goal) {
    lines.push(`任务目标: ${entry.goal}`);
  }

  lines.push('');

  if (entry.summaryText) {
    lines.push('### 摘要内容');
    lines.push('');
    lines.push(entry.summaryText);
  }

  if (entry.importantFiles.length > 0) {
    lines.push('');
    lines.push('### 关键文件');
    for (const f of entry.importantFiles) {
      lines.push(`- ${f}`);
    }
  }

  return {
    role: 'system',
    content: lines.join('\n'),
    turn: 0,
  };
}

// --- Commands: spawn ---

/**
 * 从指定会话的上下文启动新的子代理会话。
 *
 * 流程：
 *   1. 查找源会话的 handoff 文件
 *   2. 单 session full 模式：直接使用已有 handoff
 *   3. 多 session 或 summary 模式：构建合成 handoff 写入磁盘
 *   4. 调 server API 创建新 session + 启动 runtime
 *   5. 新会话出现在 GUI 中，可直接交互
 */
async function cmdSpawn(sessionIds, mode, goal, withSummarySessionId) {
  if (!sessionIds || sessionIds.length === 0) {
    console.error('用法: claw spawn <session-id> [--mode full|summary] [--with-summary <session>] [--goal <text>]');
    process.exit(1);
  }

  const resolvedMode = mode || 'full';

  // Find handoff for primary session
  const primarySessionId = sessionIds[0];
  const primaryEntry = findHandoffSummary(primarySessionId);
  if (!primaryEntry) {
    console.error(`未找到会话 ${primarySessionId} 的 handoff（请先用 claw compact 生成）`);
    process.exit(1);
  }

  let handoffPath;

  const canReuseHandoff = sessionIds.length === 1
    && resolvedMode === 'full'
    && !withSummarySessionId
    && primaryEntry.mode === 'trim-transcript'
    && primaryEntry.handoffPath;

  if (canReuseHandoff) {
    // Single session, full mode, handoff already has real dialogue: reuse directly
    handoffPath = primaryEntry.handoffPath;
  } else {
    // All other cases: build synthetic handoff (reads raw session for full mode)
    handoffPath = buildSyntheticHandoff(sessionIds, resolvedMode, goal, withSummarySessionId);
  }

  const sourceDesc = withSummarySessionId
    ? `${primarySessionId}(full) + ${withSummarySessionId}(summary)`
    : (sessionIds.length === 1 ? primarySessionId : sessionIds.length + ' 个会话');
  console.log(`正在从 ${sourceDesc} 的上下文启动新会话...`);

  try {
    const response = await fetch(`${SERVER_URL}/protoclaw/context_handoffs/compacted_resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffPath, goal: goal || undefined }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    const newSession = result.session;

    console.log('');
    console.log('新会话已创建并启动');
    console.log(`  会话 ID: ${newSession.id}`);
    console.log(`  标题: ${newSession.title || '(无标题)'}`);
    if (newSession.openDirectory) {
      console.log(`  目录: ${newSession.openDirectory}`);
    }
    console.log('');
    console.log('可在 AgentDevClaw 界面中继续对话');
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error('无法连接到 AgentDevClaw 服务（请先运行 npm start）');
    } else {
      console.error(`启动失败: ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * 构建合成 handoff 文件，用于多 session 组合、summary 模式、或杂交模式的 spawn。
 */
function buildSyntheticHandoff(sessionIds, mode, goal, withSummarySessionId) {
  const seedMessages = [];
  const importantFiles = [];
  const importantSkills = [];
  let sourceSummary = '';
  let primaryEntry = null;

  // Phase 1: primary session(s)
  for (let i = 0; i < sessionIds.length; i++) {
    const entry = findHandoffSummary(sessionIds[i]);
    if (!entry) {
      console.error(`未找到会话 ${sessionIds[i]} 的 handoff`);
      process.exit(1);
    }
    if (i === 0) primaryEntry = entry;

    if (mode === 'full') {
      // full 模式：直接读取原始 session 文件的完整对话历史
      const detail = loadSessionDetail(sessionIds[i]);
      const rawMessages = detail?.messages || [];
      if (rawMessages.length > 0) {
        for (const msg of rawMessages) {
          seedMessages.push({
            role: msg.role || 'system',
            content: msg.content || '',
            ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
            ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
          });
        }
      } else if (entry.seedMessages.length > 0) {
        // fallback: 用 handoff 的 seed messages
        seedMessages.push(...entry.seedMessages);
      } else {
        seedMessages.push(buildSummarySeedMessage(entry));
      }
    } else {
      seedMessages.push(buildSummarySeedMessage(entry));
    }

    if (entry.summaryText) {
      sourceSummary += (sourceSummary ? '\n\n---\n\n' : '') + entry.summaryText;
    }

    for (const f of entry.importantFiles) {
      if (!importantFiles.includes(f)) importantFiles.push(f);
    }
    for (const s of entry.importantSkills) {
      if (!importantSkills.includes(s)) importantSkills.push(s);
    }
  }

  // Phase 2: supplementary summary (--with-summary hybrid)
  if (withSummarySessionId) {
    const extra = findHandoffSummary(withSummarySessionId);
    if (!extra) {
      console.error(`未找到会话 ${withSummarySessionId} 的 handoff`);
      process.exit(1);
    }
    // Build a supplementary-summary seed message with distinct framing
    const supplementaryMsg = {
      role: 'system',
      content: `## 补充上下文（来自会话 ${withSummarySessionId}）\n\n以下是从另一个工作会话中提取的领域知识摘要，作为补充参考。\n\n${extra.summaryText || ''}`,
      turn: 0,
    };
    seedMessages.push(supplementaryMsg);

    if (extra.summaryText) {
      sourceSummary += '\n\n---\n\n[补充] ' + extra.summaryText;
    }
    for (const f of extra.importantFiles) {
      if (!importantFiles.includes(f)) importantFiles.push(f);
    }
    for (const s of extra.importantSkills) {
      if (!importantSkills.includes(s)) importantSkills.push(s);
    }
  }

  const syntheticHandoff = {
    schemaVersion: 1,
    handoffId: `handoff-${Date.now()}-spawn-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    mode: mode === 'full' ? 'trim-transcript' : 'summarized-nine-section',
    summaryShape: mode === 'full' ? 'trim-transcript-v1' : 'claude-nine-section-v1',
    seedKind: mode === 'full' ? 'message-replay' : 'summary-message',
    sourceAgentId: 'programming-helper',
    sourceSessionId: sessionIds[0],
    sourceRecord: {
      title: goal || primaryEntry?.title || 'CLI spawn',
      openDirectory: primaryEntry?.openDirectory || '',
      goal: goal || primaryEntry?.goal || '',
      taskTitle: goal || primaryEntry?.title || 'CLI spawn',
    },
    sourceSummary,
    seedMessages,
    compactOutput: {
      importantFiles,
      importantSkills,
      fileRanges: {},
    },
    stats: {
      spawnedFrom: sessionIds,
      ...(withSummarySessionId ? { supplementaryFrom: withSummarySessionId, hybrid: true } : {}),
      synthetic: true,
    },
  };

  // Ensure handoffs directory exists
  if (!existsSync(HANDOFFS_DIR)) {
    mkdirSync(HANDOFFS_DIR, { recursive: true });
  }

  const filePath = join(HANDOFFS_DIR, `${syntheticHandoff.handoffId}.json`);
  writeFileSync(filePath, JSON.stringify(syntheticHandoff, null, 2), 'utf8');

  return filePath;
}

// --- Arg parsing ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || '';
  let filterDir = '';
  let mode = '';
  let jsonOutput = false;
  let withSummarySessionId = '';
  let goal = '';
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--dir' || args[i] === '-d') && args[i + 1]) {
      filterDir = args[i + 1];
      i++;
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1];
      i++;
    } else if (args[i] === '--with-summary' && args[i + 1]) {
      withSummarySessionId = args[i + 1];
      i++;
    } else if (args[i] === '--goal' && args[i + 1]) {
      goal = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (!args[i].startsWith('-')) {
      positional.push(args[i]);
    }
  }

  return { command, filterDir, mode, jsonOutput, withSummarySessionId, goal, positional };
}

// --- Main ---

function main() {
  const { command, filterDir, mode, jsonOutput, withSummarySessionId, goal, positional } = parseArgs(process.argv);

  switch (command) {
    case '':
      cmdOverview();
      break;
    case 'ls':
    case 'list':
    case 'sessions':
      cmdList(resolveDir(filterDir));
      break;
    case 'show':
    case 'get':
      cmdShow(positional[0] || '');
      break;
    case 'compact':
    case 'compress':
      cmdCompact(positional[0] || '');
      break;
    case 'summaries':
      cmdSummaries(resolveDir(filterDir));
      break;
    case 'summary-show':
    case 'summary':
      cmdSummaryShow(positional[0] || '');
      break;
    case 'seed':
      cmdSeed(positional, mode, withSummarySessionId, jsonOutput);
      break;
    case 'spawn':
    case 'resume':
      cmdSpawn(positional, mode, goal, withSummarySessionId);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log('claw - AgentDevClaw CLI');
      console.log('');
      console.log('用法:');
      console.log('  claw                         显示状态概览');
      console.log('  claw ls [--dir <path>]       列出编程小助手的对话记录');
      console.log('  claw show <session-id>       查看对话详情');
      console.log('  claw compact <session-id>    压缩对话上下文');
      console.log('  claw summaries [--dir <path>] 列出可用的领域摘要');
      console.log('  claw summary-show <session>  显示某会话的完整领域摘要');
      console.log('  claw seed <session...> [--mode full|summary] [--with-summary <session>] [--json]');
      console.log('                               构建子代理上下文注入种子');
      console.log('  claw spawn <session> [--mode full|summary] [--with-summary <session>] [--goal <text>]');
      console.log('                               从历史上下文启动新会话');
      break;
    default:
      console.error(`未知命令: ${command}`);
      console.error('运行 claw help 查看可用命令');
      process.exit(1);
  }
}

main();
