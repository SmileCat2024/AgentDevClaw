#!/usr/bin/env node

/**
 * claw - AgentDevClaw 子代理调度 CLI（面向 agent）
 *
 * 三种实体：
 *   Exploration（探索记录）— 裸 spawn 产生，完成后锁定，不可变
 *   Sub-agent（子代理对话）— 从探索记录派生，可 resume
 *   Summary（摘要）— 探索记录的附属品，由 compact 生成
 *
 * 命令体系：
 *   claw                                   状态概览
 *   claw spawn --goal <text>               启动探索对话（裸，无父上下文）
 *   claw spawn <exp-id...> --goal <text>   从探索记录启动子代理
 *   claw explorations                      列出探索记录（领域概览卡片）
 *   claw subs                              列出子代理对话（目标、状态、领域）
 *   claw show <id>                         查看探索记录内容或子代理最终输出
 *   claw compact <exploration-id>          对探索记录生成摘要
 *   claw resume <sub-id> --msg <text>      在子代理对话上追加指令
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

function getExplorations() {
  const index = readSessionIndex();
  return index.sessions.filter(s => {
    const st = cleanText(s.sessionType);
    if (st === 'exploration') return true;
    // Legacy: clean one-shot sessions
    if (st === 'sub' && s.metadata?.clean === true) return true;
    if (st === 'sub' && s.metadata?.sourceSessionId?.startsWith('__protoclaw-clean-')) return true;
    return false;
  });
}

function getSubs() {
  const index = readSessionIndex();
  return index.sessions.filter(s => {
    const st = cleanText(s.sessionType);
    if (st === 'sub' && s.metadata?.clean === true) return false;
    if (st === 'sub' && s.metadata?.sourceSessionId?.startsWith('__protoclaw-clean-')) return false;
    if (st === 'sub' && s.metadata?.resumeMode === 'one-shot') return true;
    return false;
  });
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

function loadFinalOutput(sessionId) {
  const detail = loadSessionDetail(sessionId);
  if (!detail) return null;
  const messages = detail.messages;
  const lastAssistant = [...messages].reverse().find(
    m => m && m.role === 'assistant' && typeof m.content === 'string'
  );
  return lastAssistant?.content || null;
}

function findHandoffSummary(sessionId) {
  if (!sessionId) return null;
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
    summaryText: cleanText(best.sourceSummary),
    importantFiles: Array.isArray(best.compactOutput?.importantFiles)
      ? best.compactOutput.importantFiles : [],
    importantSkills: Array.isArray(best.compactOutput?.importantSkills)
      ? best.compactOutput.importantSkills : [],
    seedMessages: Array.isArray(best.seedMessages) ? best.seedMessages : [],
    stats: best.stats || {},
    sessionTimestamp: best.sessionTimestamp || null,
    gitMeta: best.gitMeta || null,
  };
}

function hasSummary(sessionId) {
  return findHandoffSummary(sessionId) !== null;
}

// --- Commands ---

function cmdOverview() {
  const state = readWorkspaceState();
  const explorations = getExplorations();
  const subs = getSubs();
  const openDir = cleanText(state.openDirectory);

  console.log('AgentDevClaw  子代理调度工具');
  console.log('');

  if (openDir) {
    console.log(`  工作目录: ${openDir}`);
  }

  console.log(`  探索记录: ${explorations.length} 份`);
  console.log(`  子代理对话: ${subs.length} 个`);
  console.log('');
  console.log('  claw explorations          列出探索记录');
  console.log('  claw subs                  列出子代理对话');
  console.log('  claw spawn --goal <text>    启动探索对话');
  console.log('  claw compact <exp-id>       对探索记录生成摘要');
  console.log('  claw resume <sub-id> --msg  续接子代理对话');
}

function cmdExplorations() {
  const explorations = getExplorations();

  if (explorations.length === 0) {
    console.log('暂无探索记录');
    console.log('使用 claw spawn --goal "探索XX" 启动探索');
    return;
  }

  console.log(`探索记录 (${explorations.length} 份)`);
  console.log('');

  for (const record of explorations) {
    const shortId = record.id.length > 30 ? `...${record.id.slice(-24)}` : record.id;
    const goal = cleanText(record.goal) || '(无目标)';
    const domains = Array.isArray(record.domains) && record.domains.length > 0
      ? record.domains.join(', ')
      : '';
    const locked = record.status === 'locked' ? '已锁定' : '运行中';
    const date = formatDate(record.updatedAt || record.createdAt);

    console.log(`  ${shortId}`);
    console.log(`    ${truncate(goal, 80)}`);
    const handoff = findHandoffSummary(record.id);
    if (handoff?.summaryText) {
      const files = handoff.importantFiles || [];
      if (files.length > 0) {
        const filePreview = files.slice(0, 4).map(f => f.split('/').pop() || f).join(', ');
        console.log(`    探索了: ${truncate(filePreview, 100)}${files.length > 4 ? ` 等${files.length}个文件` : ''}`);
      } else {
        // Fallback: extract key findings from exploration summary section 2
        const findings = handoff.summaryText.match(/(?:2\.\s*关键发现与结论|关键技术概念|核心技术)[：:]\s*\n([\s\S]*?)(?=\n\d+\.|$)/);
        if (findings) {
          console.log(`    ${truncate(findings[1].replace(/\n/g, ' ').trim(), 120)}`);
        } else {
          console.log(`    (有摘要)`);
        }
      }
    } else {
      console.log(`    (无摘要)`);
    }
    if (domains) console.log(`    领域: ${domains}`);
    // Use sessionTimestamp from handoff if available (actual conversation time)
    const displayDate = handoff?.sessionTimestamp
      ? formatDate(handoff.sessionTimestamp)
      : date;
    const gitInfo = handoff?.gitMeta
      ? ` · ${handoff.gitMeta.branch || '?'}@${handoff.gitMeta.commitHash || '?'}`
      : '';
    console.log(`    ${locked} · ${displayDate}${gitInfo}`);
    console.log('');
  }
}

function cmdSubs() {
  const subs = getSubs();

  if (subs.length === 0) {
    console.log('暂无子代理对话');
    console.log('使用 claw spawn <exp-id> --goal "任务目标" 启动子代理');
    return;
  }

  console.log(`子代理对话 (${subs.length} 个)`);
  console.log('');

  for (const record of subs) {
    const shortId = record.id.length > 30 ? `...${record.id.slice(-24)}` : record.id;
    const goal = cleanText(record.goal) || '(无目标)';
    const domains = Array.isArray(record.domains) && record.domains.length > 0
      ? record.domains.join(', ')
      : '';
    const sourceExplorations = Array.isArray(record.metadata?.sourceExplorationIds)
      ? record.metadata.sourceExplorationIds.join(', ')
      : '';
    const date = formatDate(record.updatedAt || record.createdAt);

    console.log(`  ${shortId}`);
    console.log(`    ${truncate(goal, 80)}`);
    if (domains) console.log(`    领域: ${domains}`);
    if (sourceExplorations) console.log(`    来源: ${sourceExplorations}`);
    console.log(`    ${date}`);
    console.log('');
  }
}

function cmdShow(sessionId) {
  if (!sessionId) {
    console.error('用法: claw show <exploration-id | sub-id>');
    process.exit(1);
  }

  const index = readSessionIndex();
  const record = index.sessions.find(s => s.id === sessionId);

  if (!record) {
    console.error(`未找到会话: ${sessionId}`);
    process.exit(1);
  }

  const sessionType = cleanText(record.sessionType);
  const isExploration = sessionType === 'exploration' || record.metadata?.clean === true;
  const goal = cleanText(record.goal) || '(无目标)';

  if (isExploration) {
    console.log(`探索记录 · ${sessionId}`);
    console.log(`目标: ${goal}`);
    console.log(`状态: ${record.status === 'locked' ? '已锁定' : '运行中'}`);
    if (Array.isArray(record.domains) && record.domains.length > 0) {
      console.log(`领域: ${record.domains.join(', ')}`);
    }

    const handoff = findHandoffSummary(sessionId);
    console.log(`摘要: ${handoff?.summaryText ? '已生成' : '未生成（claw compact 生成）'}`);

    if (handoff?.sessionTimestamp) {
      console.log(`对话时间: ${formatDate(handoff.sessionTimestamp)}`);
    } else {
      console.log(`创建: ${formatDate(record.createdAt)}`);
    }

    if (handoff?.gitMeta) {
      const gm = handoff.gitMeta;
      console.log(`Git: ${gm.branch || '?'} @ ${gm.commitHash || '?'}${gm.isDirty ? ' (有未提交变更)' : ''} - ${truncate(gm.commitMessage || '', 60)}`);
    }

    const detail = loadSessionDetail(sessionId);
    if (detail) {
      console.log(`消息: ${detail.messageCount} 条`);
    }

    // Show final output (agent's actual response)
    const finalOutput = loadFinalOutput(sessionId);
    if (finalOutput) {
      console.log('');
      console.log('--- 探索结果 ---');
      console.log(finalOutput);
      console.log('--- 结束 ---');
    }

    // Show handoff summary if available
    if (handoff?.summaryText) {
      console.log('');
      console.log('--- 摘要 ---');
      console.log(handoff.summaryText);
    }
  } else {
    // Sub-agent
    console.log(`子代理对话 · ${sessionId}`);
    console.log(`目标: ${goal}`);
    if (Array.isArray(record.metadata?.sourceExplorationIds)) {
      console.log(`来源探索: ${record.metadata.sourceExplorationIds.join(', ')}`);
    }
    if (Array.isArray(record.domains) && record.domains.length > 0) {
      console.log(`领域: ${record.domains.join(', ')}`);
    }
    console.log(`创建: ${formatDate(record.createdAt)}`);
    console.log(`更新: ${formatDate(record.updatedAt)}`);

    const detail = loadSessionDetail(sessionId);
    if (detail) {
      console.log(`消息: ${detail.messageCount} 条`);
    }

    // Show final output
    const finalOutput = loadFinalOutput(sessionId);
    if (finalOutput) {
      console.log('');
      console.log('--- 最终输出 ---');
      console.log(finalOutput);
      console.log('--- 结束 ---');
    }
  }
}

async function cmdCompact(sessionId) {
  if (!sessionId) {
    console.error('用法: claw compact <exploration-id>');
    process.exit(1);
  }

  const index = readSessionIndex();
  const record = index.sessions.find(s => s.id === sessionId);
  if (!record) {
    console.error(`未找到会话: ${sessionId}`);
    process.exit(1);
  }

  const sessionType = cleanText(record.sessionType);
  if (sessionType !== 'exploration' && record.metadata?.clean !== true) {
    console.error(`只能对探索记录执行 compact（当前类型: ${sessionType}）`);
    process.exit(1);
  }

  console.log(`正在压缩探索记录 ${sessionId} ...`);

  const agentDir = 'prebuilt-agents/official/programming-helper';
  const projectRoot = resolve(join(import.meta.dirname ?? '.', '..'));

  try {
    const resultPath = join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);
    const args = [
      join(projectRoot, 'scripts', 'run-compact-mirror.js'),
      agentDir,
      'programming-helper',
      sessionId,
      JSON.stringify({ sessionType: 'exploration' }),
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
    if (!result?.ok) {
      console.error('压缩失败: 未生成有效结果');
      process.exit(1);
    }

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

    // Persist handoff via server API
    console.log('正在保存摘要...');
    try {
      const exportResp = await fetch(`${SERVER_URL}/protoclaw/context_handoffs/summary_export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          summaryText: result.summaryText,
          rawResponse: result.rawResponse || '',
          importantFiles: result.importantFiles || [],
          importantSkills: result.importantSkills || [],
          fileRanges: result.fileRanges || {},
          sessionTimestamp: result.sessionTimestamp || null,
          gitMeta: result.gitMeta || null,
        }),
      });
      if (!exportResp.ok) {
        const errBody = await exportResp.text();
        console.error(`  摘要保存失败: ${exportResp.status} ${errBody}`);
        process.exit(1);
      }
      const exportResult = await exportResp.json();
      if (exportResult.handoffPath) {
        console.log(`  摘要已保存: ${exportResult.handoffPath}`);
      }
    } catch (exportErr) {
      console.error(`  摘要保存失败: ${exportErr.message}`);
      process.exit(1);
    }

    console.log('');
    console.log('摘要:');
    console.log(result.summaryText);
  } catch (error) {
    console.error('压缩失败:', error.message || error);
    process.exit(1);
  }
}

async function cmdSpawn(positional, mode, goal, blocking) {
  const isExploration = positional.length === 0;

  if (!goal) {
    if (isExploration) {
      console.error('用法: claw spawn --goal "探索目标" [--blocking]');
    } else {
      console.error('用法: claw spawn <exploration-id...> --goal "任务目标" [--blocking]');
    }
    process.exit(1);
  }

  if (isExploration) {
    // --- Exploration spawn ---
    console.log(`正在启动探索对话...`);
    console.log(`目标: ${goal}`);
    if (blocking) {
      console.log('(等待探索完成，可能需要几分钟)...');
      console.log('');
    }
  } else {
    // --- Sub-agent spawn ---
    // Validate that all positional args are exploration IDs
    const index = readSessionIndex();
    for (const expId of positional) {
      const record = index.sessions.find(s => s.id === expId);
      if (!record) {
        console.error(`未找到探索记录: ${expId}`);
        process.exit(1);
      }
    }
    console.log(`正在从 ${positional.length} 个探索记录启动子代理...`);
    console.log(`目标: ${goal}`);
    if (blocking) {
      console.log('(等待子代理完成，可能需要几分钟)...');
      console.log('');
    }
  }

  try {
    const requestBody = {
      goal,
      explorationIds: isExploration ? [] : positional,
    };

    const response = await fetch(`${SERVER_URL}/protoclaw/spawn_one_shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const result = data.result;
    const sessionType = data.session?.sessionType || (isExploration ? 'exploration' : 'sub');

    if (result.ok) {
      if (isExploration) {
        console.log('探索完成');
      } else {
        console.log('子代理执行完成');
      }
      console.log(`  会话 ID: ${data.session.id}`);
      console.log(`  类型: ${sessionType}`);
      console.log(`  耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log('');
      if (result.response) {
        console.log('--- 执行结果 ---');
        console.log(result.response);
        console.log('--- 结束 ---');
      }
    } else {
      console.error(`${isExploration ? '探索' : '子代理'}执行失败`);
      console.error(`  会话 ID: ${data.session.id}`);
      console.error(`  耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
      console.error(`  错误: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error('无法连接到 AgentDevClaw 服务（请先运行 npm start）');
    } else {
      console.error(`执行失败: ${error.message}`);
    }
    process.exit(1);
  }
}

async function cmdResume(sessionId, message) {
  if (!sessionId || !message) {
    console.error('用法: claw resume <sub-id> --msg "追加指令"');
    process.exit(1);
  }

  // Validate it's a sub-agent session
  const index = readSessionIndex();
  const record = index.sessions.find(s => s.id === sessionId);
  if (!record) {
    console.error(`未找到会话: ${sessionId}`);
    process.exit(1);
  }
  const sessionType = cleanText(record.sessionType);
  if (sessionType === 'exploration' || record.metadata?.clean === true) {
    console.error('探索记录已锁定，无法 resume（只能 resume 子代理对话）');
    process.exit(1);
  }

  console.log(`正在续接子代理 ${sessionId} ...`);
  console.log(`追加指令: ${message}`);
  console.log('(等待子代理完成，可能需要几分钟)...');
  console.log('');

  try {
    const response = await fetch(`${SERVER_URL}/protoclaw/resume_sub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const result = data.result;

    if (result.ok) {
      console.log('子代理续接完成');
      console.log(`  耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log('');
      if (result.response) {
        console.log('--- 执行结果 ---');
        console.log(result.response);
        console.log('--- 结束 ---');
      }
    } else {
      console.error('子代理续接失败');
      console.error(`  耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
      console.error(`  错误: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error('无法连接到 AgentDevClaw 服务（请先运行 npm start）');
    } else {
      console.error(`续接失败: ${error.message}`);
    }
    process.exit(1);
  }
}

// --- Arg parsing ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || '';
  let mode = '';
  let goal = '';
  let message = '';
  let blocking = false;
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1];
      i++;
    } else if (args[i] === '--goal' && args[i + 1]) {
      goal = args[i + 1];
      i++;
    } else if (args[i] === '--msg' && args[i + 1]) {
      message = args[i + 1];
      i++;
    } else if (args[i] === '--blocking' || args[i] === '--wait') {
      blocking = true;
    } else if (!args[i].startsWith('-')) {
      positional.push(args[i]);
    }
  }

  return { command, mode, goal, message, blocking, positional };
}

// --- Main ---

async function main() {
  const { command, mode, goal, message, blocking, positional } = parseArgs(process.argv);

  switch (command) {
    case '':
      cmdOverview();
      break;
    case 'explorations':
    case 'exp':
      cmdExplorations();
      break;
    case 'subs':
    case 'sub':
      if (positional.length > 0) {
        cmdShow(positional[0]);
      } else {
        cmdSubs();
      }
      break;
    case 'show':
    case 'get':
      cmdShow(positional[0] || '');
      break;
    case 'compact':
    case 'compress':
      await cmdCompact(positional[0] || '');
      break;
    case 'spawn':
      await cmdSpawn(positional, mode, goal, blocking);
      break;
    case 'resume':
      await cmdResume(positional[0] || '', message);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log('claw - AgentDevClaw 子代理调度 CLI');
      console.log('');
      console.log('实体:');
      console.log('  Exploration（探索记录）— 裸 spawn 产生，完成后锁定，不可变');
      console.log('  Sub-agent（子代理对话）— 从探索记录派生，可 resume');
      console.log('  Summary（摘要）— 探索记录的附属品，由 compact 生成');
      console.log('');
      console.log('命令:');
      console.log('  claw                                   状态概览');
      console.log('  claw spawn --goal <text> [--blocking]  启动探索对话');
      console.log('  claw spawn <exp-id...> --goal <text>   从探索记录启动子代理');
      console.log('  claw explorations                      列出探索记录');
      console.log('  claw subs                              列出子代理对话');
      console.log('  claw show <id>                         查看探索/子代理详情');
      console.log('  claw compact <exp-id>                  对探索记录生成摘要');
      console.log('  claw resume <sub-id> --msg <text>      续接子代理对话');
      break;
    default:
      console.error(`未知命令: ${command}`);
      console.error('运行 claw help 查看可用命令');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
