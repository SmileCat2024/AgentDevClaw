import path from 'path';
import { existsSync, readFileSync, promises as fs } from 'fs';

import { GROUP_CHATS_ROOT, VIEWER_ORIGIN, AGENTS_ROOT } from '../shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, log } from '../shared/string-helpers.js';
import { managedAgents, getManagedRuntimeKey, listAgentRuntimes, getAgentRuntime } from '../shared/agent-access.js';
import { readSessionIndex, readSessionIndexSync } from '../shared/session-access.js';
import { resolveSessionModelInfo } from './model-config.js';
import { getRuntimeExecutionState } from '../runtime-call-envelope.js';

export function setupGroupChatRoutes(app, express, ctx) {
  const {
    collectIdentities,
    requireAgentLight,
    createPrebuiltSession,
    waitForManagedRuntimeReady,
    startManagedAgent,
    stopManagedAgent,
    discoverAgents,
    readViewerJson,
  } = ctx;

// ── Group Chat Data Layer ──────────────────────────────────────────

/**
 * 群聊文件存储。每个群聊一个 JSON 文件，消息 append-only（routing 字段除外可更新）。
 * 文件路径：~/.agentdev/AgentDevClaw/group-chats/<chatId>.json
 */

async function ensureGroupChatsDir() {
  await fs.mkdir(GROUP_CHATS_ROOT, { recursive: true });
}

function getGroupChatPath(chatId) {
  return path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.json`);
}

async function listGroupChats() {
  await ensureGroupChatsDir();
  const entries = await fs.readdir(GROUP_CHATS_ROOT);
  const chats = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.annotations.json')) continue;
    try {
      const raw = await fs.readFile(path.join(GROUP_CHATS_ROOT, entry), 'utf8');
      const chat = JSON.parse(raw);
      // 列表只返回摘要，不包含消息
      chats.push({
        id: chat.id,
        name: chat.name,
        workDir: chat.workDir || null,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        memberCount: normalizeGroupChatMembers(chat.members).length,
        messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
        lastMessage: Array.isArray(chat.messages) && chat.messages.length > 0
          ? {
              text: (chat.messages[chat.messages.length - 1].text || '').slice(0, 100),
              from: chat.messages[chat.messages.length - 1].from,
              timestamp: chat.messages[chat.messages.length - 1].timestamp,
            }
          : null,
        archived: chat.archived || false,
      });
    } catch {}
  }
  chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return chats;
}

async function readGroupChat(chatId) {
  const filePath = getGroupChatPath(chatId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const chat = JSON.parse(raw);
    chat.members = normalizeGroupChatMembers(chat.members);
    return chat;
  } catch {
    return null;
  }
}

async function writeGroupChat(chat) {
  await ensureGroupChatsDir();
  const filePath = getGroupChatPath(chat.id);
  chat.updatedAt = Date.now();
  await fs.writeFile(filePath, JSON.stringify(chat, null, 2), 'utf8');
  return chat;
}

async function deleteGroupChatFile(chatId) {
  const filePath = getGroupChatPath(chatId);
  let deleted = false;
  try {
    await fs.unlink(filePath);
    deleted = true;
  } catch {}
  // 清理 annotations 文件
  try {
    await fs.unlink(_annotationsFilePath(chatId));
  } catch {}
  // 清理数据目录（GROUP.md 等）
  try {
    await fs.rm(getGroupChatDataDir(chatId), { recursive: true, force: true });
  } catch {}
  return deleted;
}

// ── Group Chat Resources (文件附件) ────────────────────────────────

const RESOURCE_ALLOWED_EXTS = new Set(['.md', '.txt', '.json']);

/**
 * 获取群聊资源目录路径。需要 chat.workDir 已设置。
 */
function getResourcesDir(chat) {
  if (!chat.workDir) return null;
  return path.join(chat.workDir, '.agentdev', 'resources');
}

/**
 * 校验并规范化资源文件名。
 * 返回 { ok, name, error }。
 */
function validateResourceName(rawName) {
  if (!rawName || typeof rawName !== 'string') return { ok: false, error: 'name required' };
  const name = rawName.trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > 100) return { ok: false, error: 'name too long (max 100)' };
  if (/[\/\\]/.test(name) || name.includes('..')) return { ok: false, error: 'invalid name' };
  // 如果没有合法扩展名，默认加 .md
  const ext = path.extname(name).toLowerCase();
  if (!RESOURCE_ALLOWED_EXTS.has(ext)) {
    return { ok: true, name: name + '.md' };
  }
  return { ok: true, name };
}

/**
 * 向群聊追加一条消息（append-only）。
 * 返回更新后的群聊对象。
 */
async function appendGroupChatMessage(chatId, message) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;
  if (!Array.isArray(chat.messages)) chat.messages = [];
  chat.messages.push(message);
  await writeGroupChat(chat);
  return chat;
}

/**
 * 更新群聊中某条消息的 routing 状态。
 */
async function updateMessageRouting(chatId, messageId, routingUpdate) {
  const chat = await readGroupChat(chatId);
  if (!chat || !Array.isArray(chat.messages)) return null;
  const msg = chat.messages.find((m) => m.id === messageId);
  if (!msg) return null;
  msg.routing = { ...(msg.routing || {}), ...routingUpdate };
  await writeGroupChat(chat);
  return msg;
}

/**
 * 将时间范围字符串转为毫秒。
 */
function parseMemoryRange(range) {
  switch (range) {
    case '1d': return 86400000;
    case '3d': return 86400000 * 3;
    case '1w': return 86400000 * 7;
    case 'all': return Infinity;
    default: return 86400000 * 3;
  }
}

/**
 * 从框架 session index 中读取上下文使用量（token 数）。
 * 框架已经在 tokenUsage.lastRequestUsage 中记录了最近一次请求的 token 消耗。
 */
async function getSessionContextUsage(workspaceId, sessionId) {
  try {
    const index = await readSessionIndex(workspaceId);
    const record = (index.sessions || []).find((s) => s.id === sessionId);
    if (!record?.tokenUsage) return { contextTokens: 0, available: false };
    const lastReq = record.tokenUsage.lastRequestUsage || null;
    const contextTokens = lastReq?.totalTokens || lastReq?.inputTokens || 0;
    return { contextTokens, available: contextTokens > 0 };
  } catch {
    return { contextTokens: 0, available: false };
  }
}

/**
 * 格式化管理员上下文中的会话标识（含 ID）。
 * 同一身份可能有多个同名会话，或会话被改名，因此必须附带短 ID 以消歧。
 * @param {string|null} title - 会话标题
 * @param {string|null} sessionId - 会话 ID
 * @returns {string} 形如 ' [会话:修复Bug #a1b2c3d4]'，无信息时返回空字符串
 */
/**
 * 管理员派遣消息的会话标注：管理员向某会话派发了任务，需标注目标。
 * 与 formatSessionLabel 的区别：语义不同——管理员不"属于"该会话，而是"派遣到"该会话。
 */
function formatDispatchTarget(title, sessionId) {
  if (!title && !sessionId) return '';
  const shortId = sessionId ? sessionId.slice(-8) : '';
  if (title && shortId) return ` → 派遣到会话「${title} #${shortId}」`;
  if (title) return ` → 派遣到会话「${title}」`;
  if (shortId) return ` → 派遣到会话「#${shortId}」`;
  return '';
}

function formatSessionLabel(title, sessionId) {
  if (!title && !sessionId) return '';
  const shortId = sessionId ? sessionId.slice(-8) : '';
  if (title && shortId) return ` [会话:${title} #${shortId}]`;
  if (title) return ` [会话:${title}]`;
  if (shortId) return ` [会话:#${shortId}]`;
  return '';
}

/**
 * 组装群聊记忆：按 memoryRange 提取消息摘要，作为 agent 上下文的「视图」。
 * 这是长线记忆的基础——从一个不可能全塞进上下文的完整记录中提取 agent 需要的部分。
 */
async function composeGroupMemory(chat, range, options = {}) {
  const now = Date.now();
  const rangeMs = parseMemoryRange(range);
  const allIdentities = await collectIdentities();

  // 按时间范围过滤
  const since = rangeMs === Infinity ? 0 : now - rangeMs;
  const recentMessages = (chat.messages || []).filter(
    (m) => (m.timestamp || 0) >= since && m.kind !== 'event'
  );

  // 合并批注（仅管理员注入路径）
  let annotations = {};
  if (options.includeAnnotations) {
    annotations = await readAnnotations(chat.id);
  }

  // 组装摘要行
  const lines = recentMessages.map((m) => {
    const identityInfo = allIdentities.find((i) => i.identityRef === m.from);
    const from = m.from === 'user' ? '用户' : (identityInfo?.displayName || m.from);
    const time = new Date(m.timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const text = m.text || '';

    // 会话标识：管理员派遣 vs agent 回复语义不同
    // 管理员 → 派遣到某会话；agent 回复 → 标注回复来源会话
    const sessionLabel = m.from === 'work-group:admin'
      ? formatDispatchTarget(m.routing?.targetSessionTitle, m.routing?.targetSessionId)
      : formatSessionLabel(m.routing?.targetSessionTitle, m.routing?.targetSessionId);

    let suffix = '';
    if (annotations[m.id]) {
      const annTime = new Date(annotations[m.id].timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      suffix = `  [批注 ${annTime}] ${annotations[m.id].text}`;
    }

    return `[${time}] ${from}${sessionLabel}：${text}${suffix}`;
  });

  return {
    name: chat.name,
    chatId: chat.id,
    summary: lines.join('\n'),
    messageCount: recentMessages.length,
  };
}

/**
 * 将群记忆格式化为可注入 session 的 prompt 文本。
 */
function formatGroupInfoBlock(chat) {
  const lines = [
    '─── 群聊基本信息 ───',
    `群聊名称：${chat.name || '(未命名)'}`,
    `群聊ID：${chat.id}`,
  ];
  if (chat.createdAt) {
    const created = new Date(chat.createdAt).toLocaleString('zh-CN');
    lines.push(`创建时间：${created}`);
  }
  lines.push(`当前时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

function formatMemoryRange(range) {
  const map = { '1d': '近1天', '3d': '近3天', '1w': '近1周', all: '全部历史' };
  return map[range] || '近3天';
}

function formatGroupMemoryPrompt(memory, range) {
  const parts = [];
  if (memory.summary) {
    const rangeLabel = formatMemoryRange(range);
    parts.push(
      `─── 群聊记录（${rangeLabel}，共${memory.messageCount}条）───`,
      memory.summary,
    );
  }
  return parts.join('\n');
}

/**
 * 格式化 catch-up 增量消息：身份被唤醒时，补上它离开后错过的群聊变化。
 * 这是通用的上下文完整性保证——任何身份被派发时都适用。
 *
 * @param {Array} messages - 增量消息数组（已排除当前消息）
 * @param {Array} allIdentities - collectIdentities() 结果
 * @param {string} chatId - 群聊 ID
 * @param {string} chatName - 群聊名称
 * @returns {string|null} 格式化后的 catch-up 文本，无内容时返回 null
 */
function formatCatchUpPrompt(messages, allIdentities, chatId, chatName) {
  if (!messages || messages.length === 0) return null;

  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    // 事件消息（task_started 等）：让管理员知道哪些派发已经发生
    if (m.kind === 'event' && m.event) {
      const evtName = m.event.identityName || m.event.identityRef || '';
      const evtSession = formatSessionLabel(m.event.sessionTitle, m.event.sessionId);
      if (m.event.type === 'task_started') {
        return `[${time}] [系统事件] ${evtName}${evtSession} 已开始处理`;
      }
      return `[${time}] [系统事件] ${evtName}${evtSession}：${m.event.type}`;
    }

    const identityInfo = allIdentities.find((i) => i.identityRef === m.from);
    const from = m.from === 'user' ? '用户' : (identityInfo?.displayName || m.from);
    const text = m.text || '';

    // 会话标识：管理员派遣 vs agent 回复语义不同
    const sessionLabel = m.from === 'work-group:admin'
      ? formatDispatchTarget(m.routing?.targetSessionTitle, m.routing?.targetSessionId)
      : formatSessionLabel(m.routing?.targetSessionTitle, m.routing?.targetSessionId);

    // 批注：附加到消息行尾部，供管理员参考
    let suffix = '';
    if (m._annotation) {
      const annTime = new Date(m._annotation.timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      suffix = `  [批注 ${annTime}] ${m._annotation.text}`;
    }

    // 附件摘要：显示附件数量和名称
    let attachmentInfo = '';
    if (Array.isArray(m.attachments) && m.attachments.length > 0) {
      const attNames = m.attachments.map(a => a.name).join(', ');
      attachmentInfo = `  [附件: ${attNames}]`;
    }

    return `[${time}] ${from}${sessionLabel}：${text}${suffix}${attachmentInfo}`;
  });

  return [
    `─── 你未读的群聊消息（共${messages.length}条）───`,
    ...lines,
  ].join('\n');
}

/**
 * Per-chat 互斥锁：串行化管理员 session 解析。
 * 防止并发调用（@admin + plan 模式通知 + activity 通知）同时创建多个 admin session。
 * key = `${chatId}:admin`, value = Promise chain
 */
const _gcAdminLocks = new Map();

function withAdminSessionLock(chatId, fn) {
  const key = `${chatId}:admin`;
  const prev = _gcAdminLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _gcAdminLocks.set(key, next.catch(() => {}));
  return next;
}

/**
 * 在覆盖 chat.sessions[identityRef] 之前，将旧 session ID 记录到 adminSessionHistory。
 * 仅对管理员生效，用于追踪滚动/重启产生的历史 session。
 */
function _recordAdminSessionHistory(chat, identityRef) {
  if (identityRef !== 'work-group:admin') return;
  const oldSid = chat.sessions?.[identityRef];
  if (!oldSid) return;
  if (!Array.isArray(chat.adminSessionHistory)) chat.adminSessionHistory = [];
  if (!chat.adminSessionHistory.includes(oldSid)) {
    chat.adminSessionHistory.push(oldSid);
  }
}

/**
 * 为群聊中的某个 identity 解析或创建 session。
 * - persistent: 首次创建，后续复用
 * - one-shot: 总是创建新的
 * 返回 { sessionId, isNew }
 *
 * 管理员（work-group:admin）的解析会自动加互斥锁，
 * 保证同一群聊同一时刻只有一个 admin session 被创建/解析。
 */
async function resolveGroupChatSession(chatId, identityRef, sessionModel, options = {}) {
  // 管理员：通过互斥锁串行化，防止并发创建多个 session
  if (identityRef === 'work-group:admin') {
    return withAdminSessionLock(chatId, () => _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options));
  }
  return _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options);
}

async function _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options = {}) {
  const chat = await readGroupChat(chatId);
  if (!chat) throw new Error(`Group chat not found: ${chatId}`);

  const workspaceId = identityRef.split(':')[0];

  // 查找身份显示名
  const allIdentities = await collectIdentities();
  const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
  const displayName = identityInfo?.displayName || identityRef.split(':')[1] || 'Agent';
  // 管理员会话使用「群聊名 · 管理员」格式；其他身份由 dispatch title 或 createPrebuiltSession 默认规则决定
  const isAdmin = identityRef === 'work-group:admin';
  const adminSessionTitle = isAdmin ? `${chat.name || '群聊'} · ${displayName}` : null;
  const explicitTitle = (typeof options.title === 'string' && options.title.trim()) || null;

  // one-shot: 总是创建新 session
  if (sessionModel === 'one-shot') {
    const agent = await requireAgentLight(workspaceId);
    const taskTitle = explicitTitle || adminSessionTitle;
    const session = await createPrebuiltSession(agent.id, {
      sessionType: 'exploration',
      ...(taskTitle ? { taskTitle } : {}),
    });
    return { sessionId: session.id, isNew: true };
  }

  // 指定会话：管理员或用户通过 targetSessionId 精准路由
  if (options.targetSessionId) {
    const index = await readSessionIndex(workspaceId);
    const found = index.sessions.find((s) => s.id === options.targetSessionId);
    if (found) {
      // 更新群聊会话映射，使后续默认派发也走这个会话
      _recordAdminSessionHistory(chat, identityRef);
      chat.sessions[identityRef] = found.id;
      await writeGroupChat(chat);
      return { sessionId: found.id, isNew: false };
    }
    // 指定的 targetSessionId 不存在 → 明确报错，不静默降级
    throw new Error(`指定的会话 ${options.targetSessionId} 不存在，请用 gc_sessions 确认可用会话`);
  }

  // 强制新会话
  if (options.forceNew) {
    const agent = await requireAgentLight(workspaceId);
    const taskTitle = explicitTitle || adminSessionTitle;
    const session = await createPrebuiltSession(agent.id, taskTitle ? { taskTitle } : {});
    _recordAdminSessionHistory(chat, identityRef);
    chat.sessions[identityRef] = session.id;
    await writeGroupChat(chat);
    return { sessionId: session.id, isNew: true };
  }

  // persistent: 检查映射
  if (!chat.sessions) chat.sessions = {};
  const existing = chat.sessions[identityRef];
  if (existing) {
    // 验证 session 是否仍存在于 index 中
    const index = await readSessionIndex(workspaceId);
    const found = index.sessions.find((s) => s.id === existing);
    if (found) {
      // 管理员：检查上下文是否超限，超限则滚动到新 session
      if (identityRef === 'work-group:admin') {
        const mem = chat.adminMemory || { limitMode: 'tokens', tokenLimit: 100000, ratioLimit: 80 };
        const { contextTokens, available } = await getSessionContextUsage(workspaceId, existing);
        if (available) {
          let exceeded = false;
          if (mem.limitMode === 'ratio') {
            // 按比例：contextTokens / contextLength > ratioLimit%
            const ratioVal = mem.ratioLimit ?? mem.limitValue ?? 80;
            const modelInfo = await resolveSessionModelInfo(workspaceId, 'default');
            const contextLength = modelInfo?.contextLength || 200000;
            exceeded = contextTokens / contextLength > ratioVal / 100;
          } else {
            // 按 token 数
            const tokenVal = mem.tokenLimit ?? mem.limitValue ?? 100000;
            exceeded = contextTokens >= tokenVal;
          }
          if (!exceeded) {
            return { sessionId: existing, isNew: false };
          }
          // 超限 → 先停止旧 runtime，再 fall through 创建新 session
          log('GroupChat', `admin session ${existing} context exceeded (${contextTokens} tokens), rolling to new session`);
          try {
            await stopManagedAgent(workspaceId, existing);
            log('GroupChat', `stopped old admin runtime ${existing} before rolling`);
          } catch (err) {
            log('GroupChat', `failed to stop old admin runtime ${existing}: ${err.message}`, 'warn');
          }
        } else {
          // 无用量数据（首次/刚创建）
          // 检查是否为 admin_restart 创建的待初始化 session
          if (chat.adminNeedsContextInit === existing) {
            chat.adminNeedsContextInit = null;
            await writeGroupChat(chat);
            log('GroupChat', `admin session ${existing} marked for context init, returning isNew=true`);
            return { sessionId: existing, isNew: true };
          }
          return { sessionId: existing, isNew: false };
        }
      } else {
        return { sessionId: existing, isNew: false };
      }
    }
    // session 不存在了（可能被删除），重建
  }

  // 创建新 session 并存储映射
  const agent = await requireAgentLight(workspaceId);
  const taskTitle = explicitTitle || adminSessionTitle;
  const session = await createPrebuiltSession(agent.id, taskTitle ? { taskTitle } : {});
  _recordAdminSessionHistory(chat, identityRef);
  chat.sessions[identityRef] = session.id;
  await writeGroupChat(chat);
  return { sessionId: session.id, isNew: true };
}

/**
 * 处理附件内容，实现渐进式加载。
 * 如果附件内容超过指定行数，只显示前N行并添加提示信息。
 * @param {Array} attachments - 附件数组
 * @param {Object} chat - 群聊对象，用于构建本地文件路径
 * @param {number} maxLines - 最大显示行数，默认50
 * @returns {Array} 处理后的附件数组
 */
function processAttachmentsForInjection(attachments, chat = null, maxLines = 50) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }
  
  return attachments.map(att => {
    const content = att.content || '';
    const lines = content.split('\n');
    
    if (lines.length <= maxLines) {
      return att;
    }
    
    // 截断内容，只显示前maxLines行
    const truncatedContent = lines.slice(0, maxLines).join('\n');
    const totalLines = lines.length;
    const remainingLines = totalLines - maxLines;
    
    // 构建本地文件路径
    let resourceLink = '';
    if (chat && att.name) {
      const resDir = getResourcesDir(chat);
      if (resDir) {
        const localPath = path.join(resDir, att.name);
        resourceLink = `\n\n完整内容请查看本地文件: ${localPath}`;
      }
    }
    
    // 添加提示信息
    const hint = `\n\n... [内容已截断] 共 ${totalLines} 行，已显示前 ${maxLines} 行，还有 ${remainingLines} 行未显示。${resourceLink}`;
    const fullContent = truncatedContent + hint;
    
    return {
      ...att,
      content: fullContent,
      truncated: true,
      originalLineCount: totalLines,
      displayedLines: maxLines,
    };
  });
}

/**
 * 构建发送给 agent 的 prompt：消息正文 + 链接引用。
 * 附件不再拼入文本，而是通过 attachments 字段独立传递。
 */
function composeDispatchPrompt(chatName, message, chatId) {
  // 群聊上下文已通过 contextText (system block) 独立注入，
  // 附件通过 attachments 字段独立传递，不再混入用户消息文本
  const parts = [];
  parts.push(message.text || '');
  if (Array.isArray(message.links) && message.links.length > 0) {
    parts.push('\n参考链接：');
    for (const link of message.links) {
      const desc = link.description ? ` — ${link.description}` : '';
      parts.push(`- ${link.url}${desc}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * 为被派发的 agent 构建群聊 system 上下文块。
 * 让 agent 知道自己处于群聊中、发送者是谁、回复会被同步回群聊。
 */
function buildGroupDispatchSystemMessage(chat, message, allIdentities) {
  const chatName = chat?.name || '(未命名群聊)';

  // 解析发送者身份
  let senderRole;
  let senderName;
  if (message.from === 'user') {
    senderRole = '用户';
    senderName = '用户';
  } else if (message.from === 'work-group:admin') {
    senderRole = '群管理员';
    senderName = '管理员';
  } else {
    const identityInfo = allIdentities.find((i) => i.identityRef === message.from);
    senderRole = identityInfo?.displayName || message.from;
    senderName = senderRole;
  }

  const lines = [
    `本会话同时被 AgentDevClaw 中群聊「${chatName}」关联管理。下方紧跟的一条用户消息由群聊中的${senderName}（${senderRole}）发送`,
    '',
  ];

  lines.push(
    `当前时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '你的本轮的最后一次回复将自动同步到群聊中，群管理员和用户都能看到。',
  );

  return lines.join('\n');
}

// ── Group Chat Bridge: inbox + writeback ───────────────────────────

const gcInboxQueue = new Map();       // runtimeKey → message[]
const gcInboxPendingPolls = new Map(); // runtimeKey → callback

/**
 * 向 gc inbox 投递一条消息，唤醒等待的 long-poll。
 */
function enqueueGcInbox(runtimeKey, msg) {
  // If a long-poll is waiting, deliver directly via callback WITHOUT
  // also pushing to the queue.  Pushing to the queue AND delivering via
  // callback causes the same message to be returned again on the next
  // poll (double-delivery bug).
  const cb = gcInboxPendingPolls.get(runtimeKey);
  if (cb) {
    gcInboxPendingPolls.delete(runtimeKey);
    cb(msg);
    return;
  }
  if (!gcInboxQueue.has(runtimeKey)) gcInboxQueue.set(runtimeKey, []);
  gcInboxQueue.get(runtimeKey).push(msg);
}

app.get('/protoclaw/gc/inbox', async (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const timeoutMs = Math.min(Number(req.query.timeout) || 25, 30) * 1000;
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);

  const queue = gcInboxQueue.get(runtimeKey);
  if (queue && queue.length > 0) {
    return res.json(queue.shift());
  }

  const timer = setTimeout(() => {
    gcInboxPendingPolls.delete(runtimeKey);
    res.status(204).end();
  }, timeoutMs);

  gcInboxPendingPolls.set(runtimeKey, (msg) => {
    clearTimeout(timer);
    gcInboxPendingPolls.delete(runtimeKey);
    res.json(msg);
  });
});

app.post('/protoclaw/gc/writeback', express.json(), async (req, res, next) => {
  try {
    const { chatId, identityRef, response, error, sessionId: reqSessionId } = req.body || {};
    if (!chatId || !identityRef) {
      return res.status(400).json({ error: 'chatId and identityRef required' });
    }

    const text = error
      ? `执行出错: ${error}`
      : (response || '(无回复)');

    // 回写消息携带 session 信息，供前端显示会话标签和跳转
    // sessionId 从请求体获取（由 agent 子进程通过 bridge 传入）
    const workspaceId = identityRef.split(':')[0];
    const wbSessionId = reqSessionId || null;
    let wbSessionTitle = wbSessionId;
    if (wbSessionId) {
      try {
        const idx = await readSessionIndex(workspaceId);
        const rec = idx.sessions.find((s) => s.id === wbSessionId);
        if (rec) wbSessionTitle = rec.title || rec.taskTitle || wbSessionId;
      } catch {}
    }

    await appendGroupChatMessage(chatId, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      from: identityRef,
      text,
      mentions: [],
      links: [],
      kind: error ? 'text' : 'text',
      timestamp: Date.now(),
      routing: wbSessionId ? {
        status: 'completed',
        targetSessionId: wbSessionId,
        targetSessionTitle: wbSessionTitle,
        targetWorkspaceId: workspaceId,
        targetIdentityRef: identityRef,
        completedAt: Date.now(),
      } : null,
    });
    log('GroupChat', `writeback from ${identityRef} to chat ${chatId}`);

    // 规划模式下，通知管理员 agent 完成了回复
    const wbChat = await readGroupChat(chatId);
    if (wbChat && (wbChat.initiativeMode || 'assist') === 'plan' && identityRef !== 'work-group:admin') {
      const wbMessage = {
        id: `wb-${Date.now()}`,
        from: identityRef,
        text,
        kind: 'text',
        timestamp: Date.now(),
        // 携带 session 信息，使管理员通知能区分同一身份的不同会话
        routing: wbSessionId ? { targetSessionTitle: wbSessionTitle, targetSessionId: wbSessionId } : null,
      };
      notifyAdminForActivity(chatId, wbMessage, wbChat).catch((err) => {
        log('GroupChat', `admin activity notify (writeback) failed: ${err.message}`, 'warn');
      });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * 群聊控制 API：中断/暂停/恢复指定 identity 的会话。
 *
 * 流程：
 * 1. 根据 chatId + identityRef 找到对应的 runtime
 * 2. 获取 viewerAgentId
 * 3. 调用 ViewerWorker 的 interrupt API
 * 4. 通过 gc/writeback 写入状态消息到群聊
 */
app.post('/protoclaw/gc/control', express.json(), async (req, res, next) => {
  try {
    const { chatId, identityRef, sessionId, action } = req.body || {};
    if (!chatId || !identityRef || !action) {
      return res.status(400).json({ error: 'chatId, identityRef, and action required' });
    }

    if (!['interrupt'].includes(action)) {
      return res.status(400).json({ error: 'action must be interrupt' });
    }

    const workspaceId = identityRef.split(':')[0];
    // 优先使用传入的 sessionId，否则回退到从群聊配置查找
    const resolvedSessionId = sessionId || resolveGroupChatSessionSync(chatId, identityRef);

    if (!resolvedSessionId) {
      return res.status(404).json({ error: 'No active session found for this identity' });
    }

    const runtime = getAgentRuntime(workspaceId, resolvedSessionId);
    if (!runtime) {
      return res.status(404).json({ error: 'Runtime not found' });
    }

    const viewerAgentId = runtime.viewerAgentId;
    if (!viewerAgentId) {
      return res.status(404).json({ error: 'Runtime has no viewerAgentId' });
    }

    // 调用 ViewerWorker 的 interrupt API
    const interruptRes = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!interruptRes.ok) {
      const errText = await interruptRes.text().catch(() => 'unknown error');
      return res.status(502).json({ error: `Interrupt failed: ${errText}` });
    }

    log('GroupChat', `control action=${action} for ${identityRef} in chat ${chatId}`);
    res.json({ ok: true, action, viewerAgentId });
  } catch (error) {
    next(error);
  }
});

/**
 * 同步解析群聊 session（无 async）。
 * 用于 gc/control 等需要快速查找的场景。
 */
function resolveGroupChatSessionSync(chatId, identityRef) {
  try {
    const chat = readGroupChatSync(chatId);
    if (chat?.sessions?.[identityRef]) {
      return chat.sessions[identityRef];
    }
  } catch {}

  // 从 runtime 中查找
  const workspaceId = identityRef.split(':')[0];
  for (const [runtimeKey, runtime] of managedAgents.entries()) {
    if (runtimeKey.startsWith(`${workspaceId}::`) && runtime.process?.exitCode === null) {
      return runtimeKey.split('::')[1];
    }
  }
  return null;
}

/**
 * 同步读取群聊配置（用于快速查找）。
 */
function readGroupChatSync(chatId) {
  const chatPath = path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.json`);
  if (!existsSync(chatPath)) return null;
  try {
    return JSON.parse(readFileSync(chatPath, 'utf8'));
  } catch {
    return null;
  }
}

function getUsageContextTokens(tokenUsage) {
  const lastReq = tokenUsage?.lastRequestUsage || null;
  if (Number.isFinite(lastReq?.inputTokens) && lastReq.inputTokens > 0) return lastReq.inputTokens;
  if (Number.isFinite(lastReq?.totalTokens) && lastReq.totalTokens > 0) return lastReq.totalTokens;
  if (Number.isFinite(tokenUsage?.totalTokens) && tokenUsage.totalTokens > 0) return tokenUsage.totalTokens;
  return null;
}

async function getRuntimeExecSnapshot(agentId, sessionId) {
  const runtime = getAgentRuntime(agentId, sessionId);
  const alive = !!(runtime?.process && runtime.process.exitCode === null && !runtime.stopped);
  if (!alive) {
    return {
      status: 'offline',
      viewerAgentId: null,
      queueLength: 0,
      lastActiveAt: null,
      workdir: null,
    };
  }

  let callActive = false;
  if (runtime.viewerAgentId) {
    try {
      const notif = await readViewerJson(`/api/agents/${encodeURIComponent(runtime.viewerAgentId)}/notification`);
      callActive = notif?.callActive === true;
    } catch {}
  }

  const rtKey = getManagedRuntimeKey(agentId, sessionId);
  const execState = getRuntimeExecutionState(rtKey);
  return {
    status: callActive ? 'running' : (execState.queueLength > 0 ? 'queued' : 'idle'),
    viewerAgentId: runtime.viewerAgentId || null,
    queueLength: execState.queueLength || 0,
    lastActiveAt: execState.lastActiveAt || null,
    workdir: runtime.workspaceDir || null,
  };
}

async function buildGroupChatAwareness(chatId) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const allIdentities = await collectIdentities();
  const identityInfoByRef = new Map(allIdentities.map((i) => [i.identityRef, i]));
  const identityRefs = new Set();

  const isAdminIdentity = (identityRef) => identityRef === 'work-group:admin';

  for (const member of (chat.members || [])) {
    if (!member?.identityRef || member.identityRef === 'user' || isAdminIdentity(member.identityRef)) continue;
    identityRefs.add(member.identityRef);
  }
  for (const ref of Object.keys(chat.sessions || {})) {
    if (ref && ref !== 'user' && !isAdminIdentity(ref)) identityRefs.add(ref);
  }
  for (const msg of (chat.messages || [])) {
    const ref = msg?.routing?.targetIdentityRef;
    if (ref && ref !== 'user' && !isAdminIdentity(ref)) identityRefs.add(ref);
  }
  for (const imp of (chat.importedSessions || [])) {
    if (!imp?.workspaceId) continue;
    const memberIdentity = (chat.members || [])
      .find((m) => m.identityRef && m.identityRef.startsWith(`${imp.workspaceId}:`));
    const identityRef = memberIdentity?.identityRef || `${imp.workspaceId}:main`;
    if (!isAdminIdentity(identityRef)) identityRefs.add(identityRef);
  }

  const latestRoutingBySession = new Map();
  for (const msg of (chat.messages || [])) {
    const r = msg?.routing;
    if (!r?.targetIdentityRef || !r?.targetSessionId) continue;
    const key = `${r.targetIdentityRef}:${r.targetSessionId}`;
    const existing = latestRoutingBySession.get(key);
    if (!existing || (msg.timestamp || 0) >= (existing.messageTimestamp || 0)) {
      latestRoutingBySession.set(key, {
        status: r.status || null,
        error: r.error || null,
        messageId: msg.id || null,
        messageTimestamp: msg.timestamp || null,
        dispatchedAt: r.dispatchedAt || null,
        completedAt: r.completedAt || null,
      });
    }
  }

  const identities = [];
  const totals = {
    identities: 0,
    sessions: 0,
    running: 0,
    queued: 0,
    idle: 0,
    offline: 0,
    thresholdReached: 0,
    pendingRoutes: 0,
    deliveredRoutes: 0,
  };

  for (const identityRef of Array.from(identityRefs).sort()) {
    const workspaceId = identityRef.split(':')[0];
    const info = identityInfoByRef.get(identityRef) || null;
    const sessionIds = new Set();

    const activeSessionId = chat.sessions?.[identityRef] || null;
    if (activeSessionId) sessionIds.add(activeSessionId);
    for (const msg of (chat.messages || [])) {
      const r = msg?.routing;
      if (r?.targetIdentityRef === identityRef && r.targetSessionId) sessionIds.add(r.targetSessionId);
    }
    for (const imp of (chat.importedSessions || [])) {
      if (imp?.workspaceId === workspaceId && imp.sessionId) sessionIds.add(imp.sessionId);
    }

    let index = { sessions: [] };
    try {
      index = readSessionIndexSync(workspaceId);
    } catch {}
    const metaMap = new Map((index.sessions || []).map((s) => [s.id, s]));

    const sessions = [];
    for (const sid of Array.from(sessionIds)) {
      const meta = metaMap.get(sid) || {};
      const sessionType = cleanSessionText(meta.sessionType) || 'main';
      const modelInfo = await resolveSessionModelInfo(workspaceId, sessionType);
      const tokenUsage = meta.tokenUsage || null;
      const contextTokens = getUsageContextTokens(tokenUsage);
      const contextLength = Number.isFinite(meta.contextLength) && meta.contextLength > 0
        ? meta.contextLength : (Number.isFinite(modelInfo.contextLength) && modelInfo.contextLength > 0
        ? modelInfo.contextLength : null);
      const compressRatio = Number.isFinite(meta.compressRatio) && meta.compressRatio > 0
        ? meta.compressRatio : (Number.isFinite(modelInfo.compressRatio) && modelInfo.compressRatio > 0
        ? modelInfo.compressRatio : 80);
      const contextUsagePct = (contextTokens && contextLength)
        ? Math.round(contextTokens / contextLength * 100)
        : null;
      const runtime = await getRuntimeExecSnapshot(workspaceId, sid);
      const routing = latestRoutingBySession.get(`${identityRef}:${sid}`) || null;
      const status = runtime.status;
      if (status === 'running') totals.running++;
      else if (status === 'queued') totals.queued++;
      else if (status === 'idle') totals.idle++;
      else totals.offline++;
      if (contextUsagePct != null && contextUsagePct >= compressRatio) totals.thresholdReached++;
      if (routing?.status === 'pending') totals.pendingRoutes++;
      if (routing?.status === 'delivered') totals.deliveredRoutes++;

      sessions.push({
        sessionId: sid,
        title: meta.title || meta.taskTitle || sid,
        isActive: sid === activeSessionId,
        sessionType,
        createdAt: meta.createdAt || null,
        updatedAt: meta.updatedAt || meta.createdAt || null,
        savedAt: typeof meta.savedAt === 'number' ? meta.savedAt : null,
        messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : null,
        modelName: cleanSessionText(meta.modelName) || modelInfo.modelName || '',
        contextLength,
        compressRatio,
        contextTokens,
        contextUsagePct,
        tokenUsage: tokenUsage ? {
          inputTokens: tokenUsage.inputTokens || 0,
          outputTokens: tokenUsage.outputTokens || 0,
          totalTokens: tokenUsage.totalTokens || 0,
          lastRequestUsage: tokenUsage.lastRequestUsage || null,
        } : null,
        runtimeStatus: status,
        execQueueLength: runtime.queueLength,
        execLastActiveAt: runtime.lastActiveAt,
        viewerAgentId: runtime.viewerAgentId,
        workdir: runtime.workdir || cleanSessionText(meta.openDirectory) || null,
        routing,
      });
    }

    sessions.sort((left, right) => {
      if (left.runtimeStatus === 'running' && right.runtimeStatus !== 'running') return -1;
      if (right.runtimeStatus === 'running' && left.runtimeStatus !== 'running') return 1;
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });

    const aggregateStatus = sessions.some((s) => s.runtimeStatus === 'running') ? 'running'
      : sessions.some((s) => s.runtimeStatus === 'queued') ? 'queued'
      : sessions.some((s) => s.runtimeStatus === 'idle') ? 'idle'
      : 'offline';
    identities.push({
      identityRef,
      workspaceId,
      displayName: info?.displayName || identityRef,
      description: info?.description || '',
      sessionModel: info?.sessionModel || 'persistent',
      aggregateStatus,
      sessions,
    });
    totals.sessions += sessions.length;
  }

  totals.identities = identities.length;
  return {
    chat: {
      id: chat.id,
      name: chat.name || '',
      messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
      updatedAt: chat.updatedAt || null,
    },
    totals,
    identities,
  };
}

/**
 * 群聊运行时状态查询 API。
 * 返回完整会话池中每个会话的运行状态（running/idle/offline）。
 *
 * 数据来源：
 * 1. chat.sessions 映射（持久会话）
 * 2. chat.messages 消息路由（派发产生的会话，含已完成的）
 * 3. chat.importedSessions（从外部引入的会话）
 *
 * 前端态势感知面板轮询此接口获取实时会话池状态。
 */
app.get('/protoclaw/gc/runtime_status', async (req, res, next) => {
  try {
    const chatId = req.query.chatId;
    if (!chatId) {
      return res.status(400).json({ error: 'chatId required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const allIdentities = await collectIdentities();
    const identityDisplayName = (ref) => {
      const info = allIdentities.find((i) => i.identityRef === ref);
      return info?.displayName || ref.split(':')[1] || ref;
    };

    // 收集会话池中所有会话（去重 key = identityRef:sessionId）
    const sessionMap = new Map();

    // Source 1: chat.sessions 映射（持久会话）
    for (const [identityRef, sessionId] of Object.entries(chat.sessions || {})) {
      if (identityRef === 'work-group:admin') continue;
      if (!sessionId) continue;
      const workspaceId = identityRef.split(':')[0];
      const key = `${identityRef}:${sessionId}`;
      sessionMap.set(key, {
        identityRef,
        sessionId,
        workspaceId,
        displayName: identityDisplayName(identityRef),
        lastActivity: 0,
      });
    }

    // Source 2: 消息路由（含已完成和 failed 会话——不再排除 failed，
    // 因为 routing.status 由旧版 trackGroupChatDispatch 维护，经常误标 failed，
    // 实际运行时状态以 runtime 查询结果为准）
    for (const msg of (chat.messages || [])) {
      const r = msg.routing;
      if (!r || !r.targetSessionId) continue;
      if (r.targetIdentityRef === 'work-group:admin') continue;
      const key = `${r.targetIdentityRef}:${r.targetSessionId}`;
      const existing = sessionMap.get(key);
      if (!existing || (msg.timestamp || 0) > (existing.lastActivity || 0)) {
        sessionMap.set(key, {
          identityRef: r.targetIdentityRef,
          sessionId: r.targetSessionId,
          workspaceId: r.targetWorkspaceId || r.targetIdentityRef.split(':')[0],
          displayName: identityDisplayName(r.targetIdentityRef),
          lastActivity: msg.timestamp || 0,
        });
      }
    }

    // Source 3: 导入的外部会话
    for (const imp of (chat.importedSessions || [])) {
      if (!imp.sessionId || !imp.workspaceId) continue;
      // 导入会话可能没有 identityRef，用 workspaceId 找匹配的群成员身份
      const memberIdentity = (chat.members || [])
        .find((m) => m.identityRef && m.identityRef.startsWith(imp.workspaceId + ':'));
      const identityRef = memberIdentity?.identityRef || `${imp.workspaceId}:main`;
      const key = `${identityRef}:${imp.sessionId}`;
      if (!sessionMap.has(key)) {
        sessionMap.set(key, {
          identityRef,
          sessionId: imp.sessionId,
          workspaceId: imp.workspaceId,
          displayName: imp.workspaceName || identityDisplayName(identityRef),
          lastActivity: imp.importedAt || 0,
        });
      }
    }

    // 对每个会话查实际运行时状态
    const results = [];
    for (const s of sessionMap.values()) {
      const runtimeKey = getManagedRuntimeKey(s.workspaceId, s.sessionId);
      const runtime = managedAgents.get(runtimeKey);

      if (!runtime || runtime.process?.exitCode !== null || runtime.stopped) {
        results.push({
          identityRef: s.identityRef,
          sessionId: s.sessionId,
          workspaceId: s.workspaceId,
          displayName: s.displayName,
          status: 'offline',
          viewerAgentId: null,
          lastActivity: s.lastActivity,
        });
        continue;
      }

      const viewerAgentId = runtime.viewerAgentId || null;
      let isRunning = false;

      if (viewerAgentId) {
        try {
          // 使用 /notification API 而非 /running：
          // /running 在进程存活时永远返回 {running:true}（仅检查 UDS socket 连通），
          // 不反映是否有 call 正在执行。
          // /notification 的 callActive 字段由 call.start/call.finish 事件维护，
          // 能准确反映会话是否真正处于调用中。
          const notif = await readViewerJson(
            `/api/agents/${encodeURIComponent(viewerAgentId)}/notification`
          );
          isRunning = notif?.callActive === true;
        } catch {}
      }

      results.push({
        identityRef: s.identityRef,
        sessionId: s.sessionId,
        workspaceId: s.workspaceId,
        displayName: s.displayName,
        status: isRunning ? 'running' : 'idle',
        viewerAgentId,
        lastActivity: s.lastActivity,
      });
    }

    res.json({ sessions: results });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId/awareness', async (req, res, next) => {
  try {
    const awareness = await buildGroupChatAwareness(req.params.chatId);
    if (!awareness) return res.status(404).json({ error: 'Group chat not found' });
    res.json(awareness);
  } catch (error) {
    next(error);
  }
});

/**
 * Level 1 mention 派发：将群聊消息发送到目标 agent 的 session。
 *
 * 流程：
 * 1. 解析 mention → workspaceId
 * 2. 找到或启动 agent runtime
 * 3. 等待 runtime ready
 * 4. 通过 gc inbox 投递消息（GroupChatBridgeFeature 轮询消费）
 * 5. 更新 routing.status = "delivered"
 * 6. 后台跟踪 agent 完成状态 → "completed" / "failed"
 */
/**
 * 管理员上下文完整性保证（基础语义）。
 *
 * 这是管理员被唤醒时的唯一上下文准备通道。所有向管理员投递消息的路径
 * —— dispatchToIdentity（直接派发 / execute 模式）、
 *    notifyAdminForActivity（plan 模式动态通知）、
 *    notifyAdminForObservation（plan 模式观察通知）——
 * 都必须经过此函数。
 *
 * 保证三条不变量：
 * 1. catch-up：管理员离开后错过的群聊消息全部补全
 * 2. 群记忆：新 session 时注入历史摘要
 * 3. 水位线：lastActiveAt 在每次调用后正确推进
 *
 * 函数内部读取最新群聊状态（避免调用方传入 stale 对象），计算后写回。
 *
 * @param {string} chatId - 群聊 ID
 * @param {Array}  allIdentities - collectIdentities() 结果（避免重复调用）
 * @param {number} currentMessageTimestamp - 触发本次唤醒的消息时间戳（catch-up 上界）
 * @param {string} currentMessageId - 触发本次唤醒的消息 ID（排除自身）
 * @param {boolean} isNew - 管理员 session 是否为本次新建
 * @param {boolean} [includeCurrentMessage=false] - 是否将触发消息本身纳入 catch-up
 *        （非 @admin 直达场景需要 true，使触发消息内容进入 system-reminder 而非 user 块）
 * @returns {string|null} 合并后的上下文前缀文本（群记忆 + catch-up），无内容时返回 null
 */
async function prepareAdminContext(chatId, allIdentities, currentMessageTimestamp, currentMessageId, isNew, includeCurrentMessage = false) {
  const identityRef = 'work-group:admin';
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const sections = [];

  // ── 新 session：群聊基本信息 + GROUP.md + 群记忆 ──
  // 这些是静态/半静态背景，只在 session 首次注入，避免每轮重复污染
  if (isNew) {
    // 群聊基本信息
    sections.push(formatGroupInfoBlock(chat));

    // GROUP.md
    try {
      const mdPath = path.join(GROUP_CHATS_ROOT, chatId, 'GROUP.md');
      const mdContent = await fs.readFile(mdPath, 'utf-8');
      if (mdContent && mdContent.trim()) {
        sections.push(`─── 群聊背景 ───\n${mdContent}`);
        log('GroupChat', `GROUP.md injected (${mdContent.length} chars) for new admin session`);
      }
    } catch {
      // GROUP.md 不存在或不可读，跳过
    }

    // 群记忆（近期消息摘要，标注时间范围）
    const mem = chat.adminMemory || { range: '3d' };
    const range = mem.range || '3d';
    const groupMemory = await composeGroupMemory(chat, range, { includeAnnotations: true });
    groupMemory.chatId = chatId;
    const memoryPrompt = formatGroupMemoryPrompt(groupMemory, range);
    if (memoryPrompt) {
      sections.push(memoryPrompt);
      log('GroupChat', `group memory pre-injected for new admin session (${groupMemory.messageCount} messages, range=${range})`);
    }
  }

  // ── catch-up：补上管理员离开后错过的全部群聊消息（含事件消息）──
  // 首轮（新 session 且无历史水位线）跳过 catch-up，群记忆已覆盖历史
  if (!chat.lastActiveAt) chat.lastActiveAt = {};
  const lastActive = chat.lastActiveAt[identityRef] || 0;
  if (!(isNew && lastActive === 0)) {
    const catchUpMessages = (chat.messages || []).filter(
      (m) => {
        if ((m.timestamp || 0) <= lastActive) return false;
        // includeCurrentMessage=true 时，触发消息本身纳入 catch-up（进入 system-reminder），
        // 使 user 块只需承载事件通知而非原始内容
        if (includeCurrentMessage) return true;
        if ((m.timestamp || 0) >= (currentMessageTimestamp || Date.now())) return false;
        if (m.id === currentMessageId) return false;
        return true;
      }
    );
    if (catchUpMessages.length > 0) {
      // 合并批注到 catch-up 消息（仅管理员注入）
      const annotations = await readAnnotations(chatId);
      if (Object.keys(annotations).length > 0) {
        catchUpMessages.forEach((m) => {
          if (annotations[m.id]) m._annotation = annotations[m.id];
        });
      }
      const catchUpPrompt = formatCatchUpPrompt(catchUpMessages, allIdentities, chatId, chat.name);
      if (catchUpPrompt) {
        sections.push(catchUpPrompt);
        log('GroupChat', `catch-up merged into admin context: ${catchUpMessages.length} messages`);
      }
    }
  }

  // ── 推进水位线 ──
  chat.lastActiveAt[identityRef] = currentMessageTimestamp || Date.now();
  await writeGroupChat(chat);

  return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * 确保 work-group admin runtime 已启动。
 * 统一管理员 runtime 的启动入口，供所有 admin 通知路径调用。
 * 返回 runtime 对象（已 ready），失败时抛异常。
 */
async function ensureAdminRuntime(chatId, sessionId) {
  let runtime = getAgentRuntime('work-group', sessionId);
  if (runtime?.process && runtime.process.exitCode === null && !runtime.stopped) {
    return runtime;
  }

  const agent = await requireAgentLight('work-group');
  log('GroupChat', `starting work-group admin session=${sessionId} for chat=${chatId}`);
  await startManagedAgent(agent, sessionId, {
    extraEnv: { PROTOCLAW_GC_CHAT_ID: chatId },
  });
  runtime = await waitForManagedRuntimeReady('work-group', 30000, sessionId);
  if (!runtime) throw new Error('Admin runtime failed to become ready within 30s');
  return runtime;
}

/**
 * 核心派发逻辑：将消息投递到指定 identity 的 session。
 * 负责 session 解析、runtime 启动、gc inbox 投递、状态跟踪。
 */
async function dispatchToIdentity(chatId, message, chat, identityRef, composedPrompt, sessionOptions = {}, opts = {}) {
  const workspaceId = identityRef.split(':')[0];
  log('GroupChat', `dispatching message ${message.id} to ${workspaceId} (${identityRef}) sessionOpts=${JSON.stringify(sessionOptions)}`);

  // 1. 解析 identity 的 sessionModel
  const allIdentities = await collectIdentities();
  const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
  const sessionModel = identityInfo?.sessionModel || 'persistent';

  // 2. 解析或创建 session（传入 sessionOptions）
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, identityRef, sessionModel, sessionOptions);
  log('GroupChat', `resolved session ${sessionId} (isNew=${isNew}) for ${identityRef}`);

  // 3. 找到或启动指定 session 的 runtime
  let runtime = getAgentRuntime(workspaceId, sessionId);
  const isAlive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;

  if (!isAlive) {
    try {
      const agent = await requireAgentLight(workspaceId);
      log('GroupChat', `starting agent ${workspaceId} session=${sessionId} for dispatch`);
      await startManagedAgent(agent, sessionId);
      runtime = await waitForManagedRuntimeReady(workspaceId, 30000, sessionId);
      if (!runtime) {
        throw new Error('Agent runtime failed to become ready within 30s');
      }
    } catch (err) {
      log('GroupChat', `failed to start agent: ${err.message}`, 'error');
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: `Failed to start agent: ${err.message}`,
        completedAt: Date.now(),
      });
      return;
    }
  }

  // 4. 确保 runtime ready
  if (!runtime.viewerAgentId) {
    const ready = await waitForManagedRuntimeReady(workspaceId, 15000, sessionId);
    if (!ready?.id) {
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: 'Agent runtime not ready (no viewerAgentId)',
        completedAt: Date.now(),
      });
      return;
    }
    runtime = getAgentRuntime(workspaceId, sessionId);
  }

  const viewerAgentId = runtime?.viewerAgentId;
  if (!viewerAgentId) {
    await updateMessageRouting(chatId, message.id, {
      status: 'failed',
      error: 'No viewerAgentId available',
      completedAt: Date.now(),
    });
    return;
  }

  // 5. 上下文完整性：
  // - 管理员：catch-up + 群记忆 + GROUP.md + 群聊基本信息
  // - 被派发 agent：群聊 system 上下文块（交代群聊背景、发送者身份、回复可见性）
  // 这些内容通过 contextText 分离传递，bridge 在 CallStart 时注入为 system 消息，
  // 而不是混入用户消息。
  const runtimeKey = getManagedRuntimeKey(workspaceId, sessionId);

  let fullPrompt = composedPrompt;
  let contextText = null;

  if (identityRef === 'work-group:admin') {
    contextText = await prepareAdminContext(
      chatId, allIdentities,
      message.timestamp || Date.now(), message.id, isNew,
      opts.includeCurrentMessage || false,
    );
  } else {
    // 被派发的 agent：注入群聊 system 上下文块
    contextText = buildGroupDispatchSystemMessage(chat, message, allIdentities);
  }

  // 6. 通过 gc inbox 投递实际消息（context 通过 contextText 字段分离传递）
  // 附件作为独立字段传递，不再混入用户消息文本
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
  enqueueGcInbox(runtimeKey, {
    id: message.id,
    text: fullPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: identityRef,
    attachments: processedAttachments,
    textInCatchUp: opts.includeCurrentMessage || false,
  });
  log('GroupChat', `message ${message.id} enqueued to gc inbox for ${workspaceId}/${sessionId}`);

  // 6. 更新 routing 状态（含 sessionTitle 供 dispatch 卡片展示）
  // 查找 session 标题用于展示
  let resolvedSessionTitle = sessionId;
  try {
    const idx = await readSessionIndex(workspaceId);
    const rec = idx.sessions.find((s) => s.id === sessionId);
    if (rec) resolvedSessionTitle = rec.title || rec.taskTitle || sessionId;
  } catch {}

  await updateMessageRouting(chatId, message.id, {
    status: 'delivered',
    targetSessionId: sessionId,
    targetSessionTitle: resolvedSessionTitle,
    dispatchedAt: Date.now(),
  });

  // 6.5. 追加"任务已启动"事件卡片（以 agent 身份发送，便于追踪）
  // 管理员自身不需要 task_started 卡片——它是协调者，不是执行者
  // 管理员发起的 dispatch 已经有 dispatch 卡片传达了完整信息，不再追加冗余事件
  if (identityRef !== 'work-group:admin' && message.from !== 'work-group:admin') {
    await appendGroupChatMessage(chatId, {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      from: identityRef,
      text: '',
      kind: 'event',
      event: {
        type: 'task_started',
        identityRef,
        identityName: identityInfo?.displayName || workspaceId,
        sessionId,
        sessionTitle: resolvedSessionTitle,
        workspaceId,
      },
      mentions: [],
      links: [],
      timestamp: Date.now(),
      routing: null,
    });
    log('GroupChat', `event card appended: task_started for ${identityRef} in ${chatId}`);
  }

  // 6.6. 规划模式下不再单独通知 task_started 事件
  // plan 模式的通知已在 dispatchGroupChatMessage 的 plan 分支合并投递
  // （notifyAdminWithPrompt 包含了"@了X + X已开始处理"的完整信息）

  // 7. 后台跟踪完成状态
  trackGroupChatDispatch(chatId, message.id, workspaceId, viewerAgentId);

  return { sessionId, sessionTitle: resolvedSessionTitle, isNew, workspaceId, viewerAgentId };
}

/**
 * 群聊消息派发入口。
 * 根据群的主动性模式决定路由策略：
 * - assist: 直接派发到目标 agent
 * - plan: 直接派发 + 通知管理员观察
 * - execute: 转发给管理员协调
 */
async function dispatchGroupChatMessage(chatId, message, sessionOptions = {}) {
  const routing = message.routing;
  if (!routing || !routing.targetWorkspaceId) return;

  const chat = await readGroupChat(chatId);
  const chatName = chat?.name || '';
  const initiativeMode = chat?.initiativeMode || 'assist';
  const autonomyMode = chat?.autonomyMode || 'auto';
  const targetIdentityRef = routing.targetIdentityRef;
  const targetIsAdmin = targetIdentityRef === 'work-group:admin';

  // @管理员 → 始终直接派发给管理员
  if (targetIsAdmin) {
    const prompt = composeDispatchPrompt(chatName, message, chatId);
    await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
    return;
  }

  // 管理员发出的派发消息 → 直接到达目标，不再经过模式路由。
  // 否则在 execute 模式下，admin dispatch → 新消息 → 又路由回 admin → 无限循环。
  if (message.from === 'work-group:admin') {
    const prompt = composeDispatchPrompt(chatName, message, chatId);
    await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
    return;
  }

  switch (initiativeMode) {
    case 'execute': {
      // 执行模式：转发给管理员协调
      log('GroupChat', `execute mode: routing to admin for ${message.id}`);
      const allIdentities = await collectIdentities();
      const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
      const targetName = targetInfo?.displayName || targetIdentityRef;

      // user 块仅保留事件通知，用户原话由 catch-up（含触发消息）注入 system-reminder
      const coordinatorPrompt = `用户 @了 ${targetName}`;

      // 更新 routing 目标为管理员
      await updateMessageRouting(chatId, message.id, {
        targetIdentityRef: 'work-group:admin',
        targetWorkspaceId: 'work-group',
        routedByMode: 'execute',
      });
      await dispatchToIdentity(chatId, message, chat, 'work-group:admin', coordinatorPrompt, {}, { includeCurrentMessage: true });
      break;
    }

    case 'plan': {
      // 规划模式：直接派发 + 单一通知管理员
      const prompt = composeDispatchPrompt(chatName, message, chatId);
      const dispatchResult = await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);

      // 异步通知管理员（合并：观察 + 任务启动信息，一次 call 搞定）
      const allIdentities = await collectIdentities();
      const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
      const targetName = targetInfo?.displayName || targetIdentityRef;

      // user 块：仅保留事件通知，用户原话由 catch-up（含触发消息）注入 system-reminder
      let observationText = `用户 @了 ${targetName}`;

      // 附件摘要：显示附件数量和名称
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        const attNames = message.attachments.map(a => a.name).join(', ');
        observationText += `  [附件: ${attNames}]`;
      }

      // system 层：派发状态，与 gc_dispatch 工具返回的信息丰富度保持一致
      let systemNote;
      if (dispatchResult) {
        const action = dispatchResult.isNew
          ? `创建了新会话「${dispatchResult.sessionTitle}」`
          : `复用已有会话「${dispatchResult.sessionTitle}」`;
        systemNote = [
          '─── 自动派发状态 ───',
          `目标：${targetName}（${targetIdentityRef}）`,
          `操作：${action}`,
          `sessionId: ${dispatchResult.sessionId}`,
          `消息 ID: ${message.id}`,
          `系统已自动将此消息派发给 ${targetName}，你不需要重复派发。`,
        ].join('\n');
      } else {
        systemNote = [
          '─── 自动派发状态 ───',
          `目标：${targetName}（${targetIdentityRef}）`,
          `状态：会话启动可能失败，请关注。`,
          `消息 ID: ${message.id}`,
        ].join('\n');
      }

      notifyAdminWithPrompt(chatId, message, chat, observationText, systemNote).catch((err) => {
        log('GroupChat', `admin observation notify failed: ${err.message}`, 'warn');
      });
      break;
    }

    case 'assist':
    default: {
      // 辅助模式：直接派发
      const prompt = composeDispatchPrompt(chatName, message, chatId);
      await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
      break;
    }
  }
}

/**
 * 统一管理员通知通道：向管理员投递一条自定义 prompt（合并到一次 call）。
 * 内部调用 prepareAdminContext 保证 catch-up + 群记忆完整性。
 * 用于替代 notifyAdminForObservation，避免产生多次碎片化 call。
 */
async function notifyAdminWithPrompt(chatId, message, chat, promptText, systemNote) {
  const allIdentities = await collectIdentities();

  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `notifyAdminWithPrompt: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  let contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
  );

  // systemNote 作为 system 层辅助信息注入，与 catch-up / 群记忆并列，
  // 避免辅助性内容混入 user 块导致模型困惑。
  if (systemNote) {
    contextText = contextText
      ? `${systemNote}\n\n${contextText}`
      : systemNote;
  }

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);

  enqueueGcInbox(runtimeKey, {
    id: `obs-${message.id}`,
    text: promptText,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
    attachments: processedAttachments,
    textInCatchUp: true,
  });
  log('GroupChat', `notifyAdminWithPrompt enqueued for admin`);
}

/**
 * 规划模式下，通知管理员观察群内活动。
 * 不创建 routing，只投递一条观察消息到管理员的 gc inbox。
 */
async function notifyAdminForObservation(chatId, message, chat, targetIdentityRef) {
  const chatName = chat?.name || '';
  const allIdentities = await collectIdentities();
  const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
  const targetName = targetInfo?.displayName || targetIdentityRef;

  let observationText = `[观察] 用户 @了 ${targetName}：${message.text || ''}`;
  
  // 附件摘要：显示附件数量和名称
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attNames = message.attachments.map(a => a.name).join(', ');
    observationText += `  [附件: ${attNames}]`;
  }
  
  const observationPrompt = [
    observationText,
    '',
    `系统已将此消息派发给 ${targetName}，会话已启动。你不需要重复派发。`,
  ].join('\n');

  // 确保管理员 runtime 存在
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `admin observation: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  // 上下文完整性：经统一通道补全 catch-up + 群记忆（含触发消息本身）
  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
  enqueueGcInbox(runtimeKey, {
    id: `obs-${message.id}`,
    text: observationPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
    attachments: processedAttachments,
    textInCatchUp: true,
  });
  log('GroupChat', `observation notify enqueued for admin`);
}

/**
 * 规划模式下，通知管理员观察一般群聊活动（非 @mention 消息）。
 * 用于纯讨论消息、agent 回复等。
 */
async function notifyAdminForActivity(chatId, message, chat) {
  const chatName = chat?.name || '';
  const allIdentities = await collectIdentities();
  const senderInfo = allIdentities.find((i) => i.identityRef === message.from);
  const senderName = message.from === 'user'
    ? '用户'
    : (senderInfo?.displayName || message.from);

  let activityDesc;
  const sessionLabel = formatSessionLabel(message.routing?.targetSessionTitle, message.routing?.targetSessionId);
  if (message.kind === 'event') {
    const evtSession = formatSessionLabel(message.event?.sessionTitle, message.event?.sessionId);
    activityDesc = `系统事件：${message.event?.identityName || ''}${evtSession} 已开始处理`;
  } else if (message.from === 'user') {
    activityDesc = `用户发送了消息`;
  } else {
    activityDesc = `${senderName}${sessionLabel} 回复了`;
  }

  // 附件摘要：显示附件数量和名称
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attNames = message.attachments.map(a => a.name).join(', ');
    activityDesc += `  [附件: ${attNames}]`;
  }

  // user 块仅保留事件通知，原始内容由 catch-up（含触发消息）注入 system-reminder
  const activityPrompt = activityDesc;

  // 确保管理员 runtime 存在
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `admin activity: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  // 上下文完整性：经统一通道补全 catch-up + 群记忆（含触发消息本身）
  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
  enqueueGcInbox(runtimeKey, {
    id: `act-${message.id}`,
    text: activityPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
    attachments: processedAttachments,
    textInCatchUp: true,
  });
  log('GroupChat', `activity notify enqueued for admin: ${activityDesc.slice(0, 50)}`);
}

/**
 * 后台跟踪 agent 是否完成处理。
 * 通过 ViewerWorker /running 端点检测 agent 运行状态变化。
 * 当 agent 从 running → idle 时，标记消息为 completed。
 * Agent 回复通过 GroupChatBridgeFeature 的 CallFinish piggyback 写回群聊。
 */
function trackGroupChatDispatch(chatId, messageId, workspaceId, viewerAgentId) {
  let wasRunning = false;
  const startTime = Date.now();
  const TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟超时

  const interval = setInterval(async () => {
    // 超时保护
    if (Date.now() - startTime > TIMEOUT_MS) {
      clearInterval(interval);
      await updateMessageRouting(chatId, messageId, {
        status: 'failed',
        error: 'Agent call timeout (15min)',
        completedAt: Date.now(),
      });
      return;
    }

    try {
      // 检查 runtime 是否还活着
      const runtime = getAgentRuntime(workspaceId);
      if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
        if (wasRunning) {
          // Agent 曾经运行过，现在进程已退出
          clearInterval(interval);
          await updateMessageRouting(chatId, messageId, {
            status: 'completed',
            completedAt: Date.now(),
          });
        }
        return;
      }

      // 检查 ViewerWorker 的 running 状态
      const currentViewerId = runtime.viewerAgentId || viewerAgentId;
      const res = await fetch(
        `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(currentViewerId)}/running`
      );
      if (!res.ok) return;
      const data = await res.json();
      const isRunning = data.running === true || data.callActive === true;

      if (isRunning) {
        wasRunning = true;
      } else if (wasRunning) {
        // Agent 曾在运行，现在空闲 → 完成
        clearInterval(interval);
        await updateMessageRouting(chatId, messageId, {
          status: 'completed',
          completedAt: Date.now(),
        });
        log('GroupChat', `message ${messageId} completed`);
      }
    } catch {
      // 网络错误等，继续重试
    }
  }, 3000);
}

// ── Group Chat CRUD API ────────────────────────────────────────────

app.get('/protoclaw/group_chats', async (_req, res, next) => {
  try {
    const chats = await listGroupChats();
    res.json({ chats });
  } catch (error) {
    next(error);
  }
});

function normalizeGroupChatMembers(members) {
  const result = [];
  const seen = new Set();
  const add = (member) => {
    const ref = member?.identityRef;
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    result.push(member);
  };
  add({ identityRef: 'user', role: 'human' });
  add({ identityRef: 'work-group:admin', role: 'admin' });
  if (Array.isArray(members)) {
    for (const member of members) {
      if (!member || member.identityRef === 'user' || member.identityRef === 'work-group:admin') continue;
      add({ identityRef: member.identityRef, role: member.role || 'agent' });
    }
  }
  return result;
}

app.post('/protoclaw/group_chats', express.json(), async (req, res, next) => {
  try {
    const { name, workDir, members } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chat = {
      id: chatId,
      name,
      workDir: workDir || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      members: normalizeGroupChatMembers(members),
      messages: [],
      sessions: {},
      initiativeMode: 'assist',
      autonomyMode: 'auto',
      adminMemory: { range: '3d', limitMode: 'tokens', tokenLimit: 100000, ratioLimit: 80 },
      lastActiveAt: {},
    };
    await writeGroupChat(chat);
    res.status(201).json(chat);
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const { name, workDir, members, initiativeMode, autonomyMode, adminMemory, archived } = req.body || {};
    if (name !== undefined) chat.name = name;
    if (workDir !== undefined) chat.workDir = workDir || null;
    if (Array.isArray(members)) chat.members = normalizeGroupChatMembers(members);
    if (typeof initiativeMode === 'string') chat.initiativeMode = initiativeMode;
    if (typeof autonomyMode === 'string') chat.autonomyMode = autonomyMode;
    if (typeof archived === 'boolean') chat.archived = archived;
    if (adminMemory && typeof adminMemory === 'object') {
      const prev = chat.adminMemory || {};
      chat.adminMemory = {
        range: adminMemory.range || '3d',
        limitMode: adminMemory.limitMode || 'tokens',
        tokenLimit: typeof adminMemory.tokenLimit === 'number'
          ? adminMemory.tokenLimit
          : (typeof prev.tokenLimit === 'number' ? prev.tokenLimit
            : (typeof adminMemory.limitValue === 'number' ? adminMemory.limitValue
              : (typeof prev.limitValue === 'number' ? prev.limitValue : 100000))),
        ratioLimit: typeof adminMemory.ratioLimit === 'number'
          ? adminMemory.ratioLimit
          : (typeof prev.ratioLimit === 'number' ? prev.ratioLimit : 80),
      };
    }

    await writeGroupChat(chat);
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId', async (req, res, next) => {
  try {
    const deleted = await deleteGroupChatFile(req.params.chatId);
    if (!deleted) return res.status(404).json({ error: 'Group chat not found' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat GROUP.md API ────────────────────────────────────────
// GROUP.md 存放在群聊独立数据目录 group-chats/<chatId>/GROUP.md，
// 不依赖 workDir，避免同 workDir 多群聊共用污染。

function getGroupChatDataDir(chatId) {
  return path.join(GROUP_CHATS_ROOT, chatId);
}

app.get('/protoclaw/group_chats/:chatId/group_md', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const mdPath = path.join(getGroupChatDataDir(req.params.chatId), 'GROUP.md');
    try {
      const content = await fs.readFile(mdPath, 'utf-8');
      res.json({ content, exists: true });
    } catch {
      res.json({ content: '', exists: false });
    }
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/group_md', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    const dataDir = getGroupChatDataDir(req.params.chatId);
    await fs.mkdir(dataDir, { recursive: true });
    const mdPath = path.join(dataDir, 'GROUP.md');
    await fs.writeFile(mdPath, content, 'utf-8');
    res.json({ ok: true, path: mdPath });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Resources API ───────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/resources', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resources = [];

    // ── GROUP.md 虚拟条目（始终置顶） ──
    try {
      const mdPath = path.join(getGroupChatDataDir(req.params.chatId), 'GROUP.md');
      const mdContent = await fs.readFile(mdPath, 'utf-8');
      const mdStat = await fs.stat(mdPath);
      const previewLines = mdContent.split('\n').map(l => l.trim()).filter(l => l).slice(0, 3).join('\n');
      resources.push({
        name: 'GROUP.md',
        isGroupMd: true,
        size: mdStat.size,
        mtime: mdStat.mtimeMs,
        ext: 'md',
        preview: previewLines,
      });
    } catch {
      // GROUP.md 不存在时也显示虚拟条目（空内容）
      resources.push({
        name: 'GROUP.md',
        isGroupMd: true,
        size: 0,
        mtime: 0,
        ext: 'md',
        preview: '',
      });
    }

    // ── 资源文件 ──
    const resDir = getResourcesDir(chat);
    if (resDir) {
      try {
        await fs.mkdir(resDir, { recursive: true });
        const entries = await fs.readdir(resDir);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (!RESOURCE_ALLOWED_EXTS.has(ext)) continue;
          try {
            const filePath = path.join(resDir, entry);
            const stat = await fs.stat(filePath);
            // 提取前两行非空内容作为预览
            let preview = '';
            try {
              const raw = await fs.readFile(filePath, 'utf-8');
              preview = raw.split('\n').map(l => l.trim()).filter(l => l).slice(0, 2).join('\n');
              if (preview.length > 200) preview = preview.slice(0, 200) + '...';
            } catch {}
            resources.push({
              name: entry,
              size: stat.size,
              mtime: stat.mtimeMs,
              ext: ext.slice(1),
              preview,
            });
          } catch {}
        }
      } catch {}
    }

    // 资源文件按 mtime 降序（GROUP.md 虚拟条目已在最前面，保持不动）
    const groupMdEntry = resources.shift();
    const fileEntries = resources.sort((a, b) => b.mtime - a.mtime);
    res.json({ resources: [groupMdEntry, ...fileEntries] });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId/resources/:name', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const filePath = path.join(resDir, validation.name);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const stat = await fs.stat(filePath);
      res.json({ name: validation.name, content, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/resources/:name', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    await fs.mkdir(resDir, { recursive: true });
    const filePath = path.join(resDir, validation.name);
    await fs.writeFile(filePath, content, 'utf8');
    const stat = await fs.stat(filePath);
    res.json({ ok: true, name: validation.name, size: stat.size });
  } catch (error) {
    next(error);
  }
});

// ── 自动命名创建：POST /resources ──
// 服务端生成 note-MMDD-HHmm.md 格式的文件名，避免重名。
app.post('/protoclaw/group_chats/:chatId/resources', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    await fs.mkdir(resDir, { recursive: true });

    // 生成 note-MMDD-HHmm.md
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    let name = `note-${stamp}.md`;
    // 防止同一分钟内重名
    let suffix = 2;
    while (true) {
      try {
        await fs.access(path.join(resDir, name));
        name = `note-${stamp}-${suffix}.md`;
        suffix++;
      } catch {
        break;
      }
    }

    const content = (req.body && typeof req.body.content === 'string') ? req.body.content : '';
    const filePath = path.join(resDir, name);
    await fs.writeFile(filePath, content, 'utf8');
    const stat = await fs.stat(filePath);
    res.json({ ok: true, name, size: stat.size });
  } catch (error) {
    next(error);
  }
});

// ── 重命名：POST /resources/:name/rename ──
app.post('/protoclaw/group_chats/:chatId/resources/:name/rename', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { newName } = req.body || {};
    const nameValidation = validateResourceName(newName);
    if (!nameValidation.ok) return res.status(400).json({ error: nameValidation.error });

    const oldPath = path.join(resDir, validation.name);
    const newPath = path.join(resDir, nameValidation.name);

    // 检查原文件存在
    try {
      await fs.access(oldPath);
    } catch {
      return res.status(404).json({ error: 'Resource not found' });
    }
    // 检查目标文件不存在（防止覆盖）
    try {
      await fs.access(newPath);
      return res.status(409).json({ error: 'A file with that name already exists' });
    } catch {
      // 目标不存在，可以重命名
    }

    await fs.rename(oldPath, newPath);
    res.json({ ok: true, oldName: validation.name, newName: nameValidation.name });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId/resources/:name', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const filePath = path.join(resDir, validation.name);
    try {
      await fs.unlink(filePath);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (error) {
    next(error);
  }
});

// ── Group Chat WorkDir Scan API ─────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/workdir_scan', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    if (!chat.workDir) return res.json({ workDir: null, entries: [], keyFiles: {} });

    const workDir = chat.workDir;
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '__pycache__', '.next', 'build', '.svelte-kit', 'coverage', '.turbo', '.nuxt', 'target', 'vendor']);
    const KEY_FILE_NAMES = ['package.json', 'README.md', 'README', 'CLAUDE.md', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', 'docker-compose.yml', '.env.example', 'tsconfig.json', 'requirements.txt'];

    // Scan top-level directory
    const entries = [];
    const dirItems = await fs.readdir(workDir, { withFileTypes: true });
    for (const item of dirItems) {
      if (item.name.startsWith('.') && item.name !== '.env.example' && item.name !== '.agentdev') continue;
      if (IGNORE_DIRS.has(item.name)) continue;
      entries.push({
        type: item.isDirectory() ? 'dir' : 'file',
        name: item.name,
      });
    }

    // Read key files
    const keyFiles = {};
    for (const fname of KEY_FILE_NAMES) {
      const fpath = path.join(workDir, fname);
      try {
        const stat = await fs.stat(fpath);
        if (!stat.isFile()) continue;
        const raw = await fs.readFile(fpath, 'utf-8');
        // Truncate large files
        keyFiles[fname] = raw.length > 4000 ? raw.slice(0, 4000) + '\n...(truncated)' : raw;
      } catch {
        // File doesn't exist, skip
      }
    }

    // Also scan second-level directories (names only, for structure awareness)
    const subDirs = entries.filter(e => e.type === 'dir');
    for (const dir of subDirs) {
      const dirPath = path.join(workDir, dir.name);
      try {
        const subItems = await fs.readdir(dirPath, { withFileTypes: true });
        const subNames = subItems
          .filter(i => !i.name.startsWith('.') && !IGNORE_DIRS.has(i.name))
          .slice(0, 15)
          .map(i => `${i.isDirectory() ? '[D]' : '[F]'} ${i.name}`);
        if (subNames.length > 0) {
          entries.push({ type: 'subdir_listing', name: `${dir.name}/`, children: subNames });
        }
      } catch {
        // Permission denied or other error, skip
      }
    }

    res.json({ workDir, entries, keyFiles });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Messages API ────────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/messages', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const messages = (chat.messages || []).slice(offset, offset + limit);

    res.json({
      messages,
      total: (chat.messages || []).length,
      offset,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats/:chatId/messages', express.json(), async (req, res, next) => {
  try {
    const { text, mentions, links, from, kind, attachments } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });

    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const messageFrom = from || 'user';

    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId: chat.id,
      from: messageFrom,
      text,
      mentions: Array.isArray(mentions) ? mentions : [],
      links: Array.isArray(links) ? links.filter((l) => l && l.url) : [],
      attachments: Array.isArray(attachments) ? attachments.filter((a) => a && a.name) : [],
      kind: kind || 'text',
      timestamp: Date.now(),
      routing: null,
    };

    // 任何带 mention 的消息都初始化 routing（user 和 admin 派发均可）
    if (message.mentions.length > 0) {
      const firstMention = message.mentions[0];
      const targetRef = firstMention.identityRef || null;
      // 防止 admin 向自己派发（反馈循环）
      if (targetRef && targetRef !== messageFrom) {
        message.routing = {
          status: 'pending',
          targetIdentityRef: targetRef,
          targetWorkspaceId: targetRef.split(':')[0] || null,
          targetSessionId: null,
          dispatchedAt: null,
          completedAt: null,
          error: null,
        };
      }
    }

    await appendGroupChatMessage(chat.id, message);

    // 异步派发（不阻塞响应）——任何带 routing 的消息触发
    let resolvedSession = null;
    if (message.routing) {
      // sessionOptions 从 first mention 中提取（前端放在 mention 对象内发送）
      const firstMention = message.mentions[0] || {};
      let sessionOptions = {};
      if (firstMention.targetSessionId) sessionOptions.targetSessionId = firstMention.targetSessionId;
      if (firstMention.forceNew) sessionOptions.forceNew = true;
      if (firstMention.title && typeof firstMention.title === 'string' && firstMention.title.trim()) sessionOptions.title = firstMention.title.trim();

      // 管理员派发：同步预解析会话，返回 sessionId/title/isNew 供工具反馈
      if (messageFrom === 'work-group:admin') {
        try {
          const targetRef = message.routing.targetIdentityRef;
          const allIdentities = await collectIdentities();
          const targetInfo = allIdentities.find((i) => i.identityRef === targetRef);
          const sessionModel = targetInfo?.sessionModel || 'persistent';
          const { sessionId: preSid, isNew: preNew } = await resolveGroupChatSession(
            chat.id, targetRef, sessionModel, sessionOptions
          );
          // 查找会话标题
          let preTitle = preSid;
          try {
            const wsId = targetRef.split(':')[0];
            const idx = await readSessionIndex(wsId);
            const rec = idx.sessions.find((s) => s.id === preSid);
            if (rec) preTitle = rec.title || rec.taskTitle || preSid;
          } catch {}
          resolvedSession = { sessionId: preSid, sessionTitle: preTitle, isNew: preNew };
          // 覆盖 sessionOptions：用预解析的 sessionId 作为 targetSessionId，
          // 避免异步 dispatch 重复创建会话
          sessionOptions = { targetSessionId: preSid };
        } catch (resolveErr) {
          return res.status(400).json({ error: resolveErr.message || '会话解析失败' });
        }
      }

      dispatchGroupChatMessage(chat.id, message, sessionOptions).catch((err) => {
        console.error(`[GroupChat] dispatch failed for ${message.id}:`, err);
      });
    } else if ((chat.initiativeMode || 'assist') === 'plan' && messageFrom !== 'work-group:admin') {
      // 规划模式：观察所有非 admin 的非 @mention 消息
      notifyAdminForActivity(chat.id, message, chat).catch((err) => {
        log('GroupChat', `admin activity notify failed: ${err.message}`, 'warn');
      });
    }

    res.status(201).json(resolvedSession ? { ...message, resolvedSession } : message);
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Sessions API ────────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/sessions/:identityRef', async (req, res, next) => {
  try {
    const { chatId, identityRef } = req.params;
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const workspaceId = identityRef.split(':')[0];
    const sessionModel = (await collectIdentities()).find((i) => i.identityRef === identityRef)?.sessionModel || 'persistent';
    const activeSessionId = chat.sessions?.[identityRef] || null;

    // 获取该 workspace 的全部会话
    const index = await readSessionIndex(workspaceId);

    // 群内会话：被 chat.sessions 映射引用的 session
    // 使用精确 identityRef 匹配（非 workspace 前缀），避免其他身份的 session 混入
    const chatSessionIds = new Set(
      Object.entries(chat.sessions || {})
        .filter(([ref]) => ref === identityRef)
        .map(([, sid]) => sid)
    );

    // 管理员：将历史 session（滚动前的旧 session）也纳入群内会话
    if (identityRef === 'work-group:admin' && Array.isArray(chat.adminSessionHistory)) {
      for (const sid of chat.adminSessionHistory) chatSessionIds.add(sid);
    }

    // 消息路由中出现的 session 也属于群内会话（覆盖 one-shot / 指定会话派发）
    for (const msg of (chat.messages || [])) {
      const r = msg.routing;
      if (r && r.targetIdentityRef === identityRef && r.targetSessionId) {
        chatSessionIds.add(r.targetSessionId);
      }
    }

    // 已引入的外部会话也属于群内会话池
    for (const imp of (chat.importedSessions || [])) {
      if (imp.workspaceId === workspaceId && imp.sessionId) {
        chatSessionIds.add(imp.sessionId);
      }
    }

    const inChatSessions = index.sessions
      .filter((s) => chatSessionIds.has(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title || s.taskTitle || '未命名',
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || s.createdAt,
        isActive: s.id === activeSessionId,
      }));

    // 外部会话：不在群内映射中的会话（取最近 20 条）
    const externalSessions = index.sessions
      .filter((s) => !chatSessionIds.has(s.id))
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        title: s.title || s.taskTitle || '未命名',
        updatedAt: s.updatedAt || s.createdAt,
      }));

    res.json({
      identityRef,
      sessionModel,
      activeSessionId,
      inChatSessions,
      externalSessions,
    });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Admin Status API ─────────────────────────────────

/**
 * 计算管理员会话的健康状态。
 * 统一 healthRatio 语义：0 = 空，1.0 = 到达上限（触发滚动），>1.0 = 已超限。
 */
async function getAdminStatus(chatId) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const identityRef = 'work-group:admin';
  const workspaceId = 'work-group';
  const sessionId = chat.sessions?.[identityRef] || null;

  if (!sessionId) {
    return {
      online: false,
      sessionId: null,
      sessionTitle: null,
      contextTokens: 0,
      contextLimit: null,
      limitMode: (chat.adminMemory?.limitMode || 'tokens'),
      tokenLimit: (chat.adminMemory?.tokenLimit ?? chat.adminMemory?.limitValue ?? 100000),
      ratioLimit: (chat.adminMemory?.ratioLimit ?? 80),
      healthRatio: 0,
      healthStatus: 'unknown',
    };
  }

  // 判断 runtime 是否存活
  const runtime = getAgentRuntime(workspaceId, sessionId);
  const online = !!(runtime?.process && runtime.process.exitCode === null && !runtime.stopped);

  // 获取上下文用量
  const { contextTokens, available } = await getSessionContextUsage(workspaceId, sessionId);

  // 获取 session 标题
  let sessionTitle = null;
  try {
    const index = await readSessionIndex(workspaceId);
    const record = index.sessions.find((s) => s.id === sessionId);
    sessionTitle = record?.title || record?.taskTitle || null;
  } catch { /* ignore */ }

  const mem = chat.adminMemory || { limitMode: 'tokens', tokenLimit: 100000, ratioLimit: 80 };
  let healthRatio = 0;
  let contextLimit = null;

  if (mem.limitMode === 'ratio') {
    const ratioVal = mem.ratioLimit ?? mem.limitValue ?? 80;
    const modelInfo = await resolveSessionModelInfo(workspaceId, 'default');
    const contextLength = modelInfo?.contextLength || 200000;
    contextLimit = Math.floor(contextLength * ratioVal / 100);
    if (available && contextLength > 0) {
      const actualRatio = contextTokens / contextLength;
      const limitRatio = ratioVal / 100;
      healthRatio = limitRatio > 0 ? actualRatio / limitRatio : 0;
    }
  } else {
    const tokenVal = mem.tokenLimit ?? mem.limitValue ?? 100000;
    contextLimit = tokenVal;
    if (available && tokenVal > 0) {
      healthRatio = contextTokens / tokenVal;
    }
  }

  let healthStatus = 'healthy';
  if (!available || healthRatio === 0) {
    healthStatus = 'unknown';
  } else if (healthRatio >= 1.0) {
    healthStatus = 'critical';
  } else if (healthRatio >= 0.8) {
    healthStatus = 'warning';
  }

  return {
    online,
    sessionId,
    sessionTitle,
    contextTokens,
    contextLimit,
    limitMode: mem.limitMode || 'tokens',
    tokenLimit: mem.tokenLimit ?? mem.limitValue ?? 100000,
    ratioLimit: mem.ratioLimit ?? 80,
    healthRatio,
    healthStatus,
  };
}

app.get('/protoclaw/group_chats/:chatId/admin_status', async (req, res, next) => {
  try {
    const status = await getAdminStatus(req.params.chatId);
    if (!status) return res.status(404).json({ error: 'Group chat not found' });
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats/:chatId/admin_restart', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const identityRef = 'work-group:admin';

    // 整个 stop + create 流程在锁内完成，防止并发 dispatch 在 stop 后重启旧 runtime
    const { oldSessionId, newSessionId } = await withAdminSessionLock(chatId, async () => {
      const chat = await readGroupChat(chatId);
      if (!chat) throw new Error('Group chat not found');

      const oldSid = chat.sessions?.[identityRef] || null;

      // 1. 停止旧 runtime（如果存在）
      if (oldSid) {
        log('GroupChat', `admin restart: stopping old session ${oldSid}`);
        await stopManagedAgent('work-group', oldSid);
      }

      // 2. 强制新建 session（更新 chat.sessions 映射 + 记录历史）
      const result = await _resolveGroupChatSessionInner(
        chatId, identityRef, 'persistent', { forceNew: true }
      );
      log('GroupChat', `admin restart: created new session ${result.sessionId}`);

      // 3. 标记新 session 需要完整上下文初始化
      //    后续消息派发时 _resolveGroupChatSessionInner 检测到此标记，
      //    返回 isNew=true，触发 prepareAdminContext 完整注入
      const chatForMark = await readGroupChat(chatId);
      chatForMark.adminNeedsContextInit = result.sessionId;
      await writeGroupChat(chatForMark);

      return { oldSessionId: oldSid, newSessionId: result.sessionId };
    });

    // 3. 启动新 runtime（必须在锁外执行，ensureAdminRuntime 会等待 READY）
    if (newSessionId) {
      log('GroupChat', `admin restart: starting runtime for new session ${newSessionId}`);
      try {
        await ensureAdminRuntime(chatId, newSessionId);
      } catch (err) {
        log('GroupChat', `admin restart: runtime start failed: ${err.message}`, 'warn');
      }
    }

    // 4. 返回最新状态
    const status = await getAdminStatus(req.params.chatId);
    res.json({ ...status, restartedFromSession: oldSessionId });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Session Pool (External Import) API ─────────────────

/**
 * 跨所有 workspace 搜索会话，用于"引入到群聊会话池"。
 * 排除已引入的 session 和已在 chat.sessions 映射中的 session。
 */
app.get('/protoclaw/group_chats/:chatId/search_sessions', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const q = (req.query.q || '').trim().toLowerCase();
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 已在会话池中的 session ID 集合（包括 chat.sessions 映射和已引入的）
    const pooledIds = new Set([
      ...Object.values(chat.sessions || {}).filter(Boolean),
      ...(chat.importedSessions || []).map((s) => s.sessionId),
    ]);

    const agents = await discoverAgents(AGENTS_ROOT);
    const results = [];

    for (const agent of agents) {
      if (agent.enabled === false || agent.launchMode === 'ui-only') continue;
      // 只搜索当前有运行中 runtime 的 agent（排除 group chat 自身）
      if (agent.id === 'work-group') continue;
      const runtimes = listAgentRuntimes(agent.id);
      const hasRunning = runtimes.some((rt) => rt?.process && rt.process.exitCode === null && !rt.stopped);
      if (!hasRunning) continue;
      let index;
      try {
        index = await readSessionIndex(agent.id);
      } catch {
        continue;
      }

      for (const session of index.sessions) {
        if (session.archived) continue;
        if (pooledIds.has(session.id)) continue;

        const title = session.title || session.taskTitle || '未命名';
        const searchText = [title, session.goal, session.taskTitle]
          .filter(Boolean).join(' ').toLowerCase();

        // 无关键词时返回所有（前端限制数量）；有关键词时模糊匹配
        if (q && !searchText.includes(q)) continue;

        results.push({
          workspaceId: agent.id,
          workspaceName: agent.name || agent.id,
          sessionId: session.id,
          title,
          updatedAt: session.updatedAt || session.createdAt,
          sessionType: session.sessionType || null,
        });
      }
    }

    // 按更新时间降序
    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    res.json({ sessions: results.slice(0, 50) });
  } catch (error) {
    next(error);
  }
});

/**
 * 引入一个外部 session 到群聊会话池。
 */
app.post('/protoclaw/group_chats/:chatId/import_session', express.json(), async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const { workspaceId, sessionId } = req.body;
    if (!workspaceId || !sessionId) {
      return res.status(400).json({ error: 'workspaceId and sessionId are required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 验证 session 存在
    let sessionTitle = null;
    try {
      const index = await readSessionIndex(workspaceId);
      const record = index.sessions.find((s) => s.id === sessionId);
      if (!record) return res.status(404).json({ error: 'Session not found' });
      sessionTitle = record.title || record.taskTitle || '未命名';
    } catch {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 初始化 importedSessions 数组
    if (!Array.isArray(chat.importedSessions)) chat.importedSessions = [];

    // 避免重复引入
    const exists = chat.importedSessions.find(
      (s) => s.workspaceId === workspaceId && s.sessionId === sessionId
    );
    if (exists) {
      return res.json({ imported: chat.importedSessions });
    }

    // 获取 workspace 名称
    const agents = await discoverAgents(AGENTS_ROOT);
    const agentInfo = agents.find((a) => a.id === workspaceId);

    chat.importedSessions.push({
      workspaceId,
      sessionId,
      title: sessionTitle,
      workspaceName: agentInfo?.name || workspaceId,
      importedAt: Date.now(),
    });

    await writeGroupChat(chat);
    log('GroupChat', `imported session ${sessionId} from ${workspaceId} into chat ${chatId}`);

    res.json({ imported: chat.importedSessions });
  } catch (error) {
    next(error);
  }
});

/**
 * 移除已引入的外部 session。
 */
app.delete('/protoclaw/group_chats/:chatId/import_session', express.json(), async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const { workspaceId, sessionId } = req.body;
    if (!workspaceId || !sessionId) {
      return res.status(400).json({ error: 'workspaceId and sessionId are required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    if (Array.isArray(chat.importedSessions)) {
      chat.importedSessions = chat.importedSessions.filter(
        (s) => !(s.workspaceId === workspaceId && s.sessionId === sessionId)
      );
      await writeGroupChat(chat);
    }

    res.json({ imported: chat.importedSessions || [] });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Annotations API ──────────────────────────────────

function _annotationsFilePath(chatId) {
  return path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.annotations.json`);
}

async function readAnnotations(chatId) {
  try {
    const raw = await fs.readFile(_annotationsFilePath(chatId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAnnotations(chatId, annotations) {
  await ensureGroupChatsDir();
  await fs.writeFile(_annotationsFilePath(chatId), JSON.stringify(annotations, null, 2), 'utf8');
}

app.get('/protoclaw/group_chats/:chatId/annotations', async (req, res, next) => {
  try {
    const annotations = await readAnnotations(req.params.chatId);
    res.json({ annotations });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/annotations/:messageId', express.json(), async (req, res, next) => {
  try {
    const { chatId, messageId } = req.params;
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const annotations = await readAnnotations(chatId);
    annotations[messageId] = {
      text: text.trim(),
      timestamp: Date.now(),
      author: 'user',
    };
    await writeAnnotations(chatId, annotations);
    res.json({ success: true, annotation: annotations[messageId] });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId/annotations/:messageId', async (req, res, next) => {
  try {
    const { chatId, messageId } = req.params;
    const annotations = await readAnnotations(chatId);
    delete annotations[messageId];
    await writeAnnotations(chatId, annotations);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── End Group Chat API ─────────────────────────────────────────────

}
