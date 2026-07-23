import path from 'path';

import { readSessionIndex } from '../../shared/session-access.js';

export const RESOURCE_ALLOWED_EXTS = new Set(['.md', '.txt', '.json']);

/**
 * 获取群聊资源目录路径。需要 chat.workDir 已设置。
 */
export function getResourcesDir(chat) {
  if (!chat.workDir) return null;
  return path.join(chat.workDir, '.agentdev', 'resources');
}

/**
 * 校验并规范化资源文件名。
 * 返回 { ok, name, error }。
 */
export function validateResourceName(rawName) {
  if (!rawName || typeof rawName !== 'string') return { ok: false, error: 'name required' };
  const name = rawName.trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > 100) return { ok: false, error: 'name too long (max 100)' };
  if (/[/\\]/.test(name) || name.includes('..')) return { ok: false, error: 'invalid name' };
  // 如果没有合法扩展名，默认加 .md
  const ext = path.extname(name).toLowerCase();
  if (!RESOURCE_ALLOWED_EXTS.has(ext)) {
    return { ok: true, name: name + '.md' };
  }
  return { ok: true, name };
}

/**
 * 将时间范围字符串转为毫秒。
 */
export function parseMemoryRange(range) {
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
export async function getSessionContextUsage(workspaceId, sessionId) {
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
export function formatDispatchTarget(title, sessionId) {
  if (!title && !sessionId) return '';
  const shortId = sessionId ? sessionId.slice(-8) : '';
  if (title && shortId) return ` → 派遣到会话「${title} #${shortId}」`;
  if (title) return ` → 派遣到会话「${title}」`;
  if (shortId) return ` → 派遣到会话「#${shortId}」`;
  return '';
}

export function formatSessionLabel(title, sessionId) {
  if (!title && !sessionId) return '';
  const shortId = sessionId ? sessionId.slice(-8) : '';
  if (title && shortId) return ` [会话:${title} #${shortId}]`;
  if (title) return ` [会话:${title}]`;
  if (shortId) return ` [会话:#${shortId}]`;
  return '';
}

/**
 * 格式化会话生命周期事件为人类可读的描述文本。
 *
 * 被 formatCatchUpPrompt 和 notifyAdminForActivity 共用，
 * 确保无论 admin 是实时收到还是 catch-up 补齐，看到的描述一致。
 *
 * @param {object} event — 消息的 event 字段
 * @returns {string} 格式化后的描述，供直接注入上下文或显示
 */
export function formatSessionLifecycleEvent(event) {
  const evtName = event.identityName || '';
  const threadName = event.threadTitle || event.sessionTitle || event.fromSessionTitle || '';
  const subject = threadName ? `${evtName} · 工作线程「${threadName}」` : evtName;
  const reason = event.reason || '';

  // ── 纯归档（无新会话）──
  if (event.type === 'session_archived') {
    const label = formatSessionLabel(event.sessionTitle, event.sessionId);
    return `${subject}${label} 已归档，不再接收新任务`;
  }
  if (event.type === 'session_unarchived') {
    const label = formatSessionLabel(event.sessionTitle, event.sessionId);
    return `${subject}${label} 已取消归档，可以继续接收任务`;
  }

  // ── 会话变更（创建了新会话）──
  const fromLabel = formatSessionLabel(event.fromSessionTitle, event.fromSessionId);
  const toLabel = formatSessionLabel(event.sessionTitle, event.toSessionId);

  const reasonLabels = {
    branch: '创建分支',
    summary: '摘要交接',
    trim: '精简历史',
  };
  const reasonLabel = reasonLabels[reason] || '变更';

  // 操作详情（trim 附带轮次信息）
  let detail = '';
  if (reason === 'trim' && event.trimCutRounds != null) {
    detail = `（精简 ${event.trimCutRounds} 轮）`;
  }

  // 归档后缀
  const archiveSuffix = event.archived ? '，原会话已归档' : '';

  if (event.threadDisposition === 'new_thread') {
    return `${subject}已派生为新的并行工作：\n  操作：${reasonLabel}${detail}${archiveSuffix}\n  来源会话：「${event.fromSessionTitle || '未命名'} #${(event.fromSessionId || '').slice(-8)}」${event.archived ? '→ 已归档' : '（仍可查看）'}\n  新线程入口：「${event.sessionTitle || '未命名'} #${(event.toSessionId || '').slice(-8)}」`;
  }

  return `${subject}上下文已交接：\n  操作：${reasonLabel}${detail}${archiveSuffix}\n  原会话：「${event.fromSessionTitle || '未命名'} #${(event.fromSessionId || '').slice(-8)}」${event.archived ? '→ 已归档' : '（仍可查看）'}\n  当前入口：「${event.sessionTitle || '未命名'} #${(event.toSessionId || '').slice(-8)}」`;
}

/**
 * 组装群聊记忆：按 memoryRange 提取消息摘要，作为 agent 上下文的「视图」。
 * 这是长线记忆的基础——从一个不可能全塞进上下文的完整记录中提取 agent 需要的部分。
 *
 * @param {object} chat — 群聊对象
 * @param {string} range — 时间范围
 * @param {object} [options] — 选项
 * @param {boolean} [options.includeAnnotations] — 是否包含批注
 * @param {Function} [options.collectIdentities] — 注入的身份收集函数
 * @param {Function} [options.readAnnotations] — 注入的批注读取函数
 */
export async function composeGroupMemory(chat, range, options = {}) {
  const now = Date.now();
  const rangeMs = parseMemoryRange(range);
  const allIdentities = await options.collectIdentities();

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

    // 截断超长消息：只保留头部摘要，完整内容通过 gc_messages(messageId) 查看
    const { text: displayText, truncated, originalLength } = truncateMessageText(m.text || '');
    const truncNotice = truncated
      ? `\n[已截断，原文 ${originalLength} 字符。使用 gc_messages 查看 messageId: ${m.id} 的完整内容]`
      : '';

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

    return `[${time}] ${from}${sessionLabel}：${displayText}${truncNotice}${suffix}`;
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
export function formatGroupInfoBlock(chat) {
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

export function formatMemoryRange(range) {
  const map = { '1d': '近1天', '3d': '近3天', '1w': '近1周', all: '全部历史' };
  return map[range] || '近3天';
}

export function formatGroupMemoryPrompt(memory, range) {
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

// ── 超长消息截断 ────────────────────────────────────────────────────

/**
 * 单条消息在 catch-up / gc_messages 列表中的截断阈值（字符）。
 * 超过此值的消息只保留头部摘要，完整内容通过 gc_messages(messageId) 查询。
 */
export const GC_MSG_TRUNCATE_THRESHOLD = 800;

/**
 * 截断超长消息文本，在最近的换行边界截断以避免破坏 markdown 结构。
 *
 * @param {string} text - 原始消息文本
 * @param {number} [threshold=GC_MSG_TRUNCATE_THRESHOLD] - 截断阈值
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
export function truncateMessageText(text, threshold = GC_MSG_TRUNCATE_THRESHOLD) {
  if (!text || text.length <= threshold) {
    return { text: text || '', truncated: false, originalLength: text?.length || 0 };
  }
  // 向前回溯到最近的换行，避免截断在行中间
  let cut = threshold;
  const minCut = Math.floor(threshold * 0.5);
  while (cut > minCut && text[cut] !== '\n') cut--;
  return {
    text: text.slice(0, cut).trimEnd(),
    truncated: true,
    originalLength: text.length,
  };
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
export function formatCatchUpPrompt(messages, allIdentities, chatId, chatName) {
  if (!messages || messages.length === 0) return null;

  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    // 事件消息（task_started 等）：让管理员知道哪些派发已经发生
    if (m.kind === 'event' && m.event) {
      if (m.event.type === 'task_started') {
        const evtName = m.event.identityName || m.event.identityRef || '';
        const evtSession = formatSessionLabel(m.event.sessionTitle, m.event.sessionId);
        return `[${time}] [系统事件] ${evtName}${evtSession} 已开始处理`;
      }
      if (m.event.type === 'session_continued' || m.event.type === 'session_archived' || m.event.type === 'session_unarchived') {
        return `[${time}] [系统事件] ${formatSessionLifecycleEvent(m.event)}`;
      }
      if (m.event.type === 'task_completed') {
        const evtName = m.event.identityName || m.event.identityRef || '';
        const threadTitle = m.event.threadTitle || m.event.sessionTitle || '未命名工作';
        const taskTitle = m.event.taskTitle || '';
        return `[${time}] [系统事件] ${evtName} · 工作线程「${threadTitle}」Task 完成：${taskTitle}`;
      }
      const evtName = m.event.identityName || m.event.identityRef || '';
      const evtSession = formatSessionLabel(m.event.sessionTitle, m.event.sessionId);
      return `[${time}] [系统事件] ${evtName}${evtSession}：${m.event.type}`;
    }

    // 待审批派发：让管理员知道审批状态
    if (m.kind === 'dispatch_pending') {
      const targetRef = m.mentions?.[0]?.identityRef || m.routing?.targetIdentityRef;
      const targetInfo = allIdentities.find((i) => i.identityRef === targetRef);
      const targetName = targetInfo?.displayName || targetRef;
      const senderInfo = allIdentities.find((i) => i.identityRef === m.from);
      const senderName = m.from === 'user' ? '用户' : (senderInfo?.displayName || m.from);
      const approvalStatus = m.approval?.status || 'pending';
      const statusLabel = approvalStatus === 'approved'
        ? '[已批准]'
        : approvalStatus === 'rejected'
          ? '[已拒绝]'
          : '[待审批]';
      return `[${time}] ${senderName} [审批派发 → ${targetName}] ${statusLabel}：${m.text || ''}`;
    }

    const identityInfo = allIdentities.find((i) => i.identityRef === m.from);
    const from = m.from === 'user' ? '用户' : (identityInfo?.displayName || m.from);

    // 截断超长消息：只保留头部摘要，完整内容通过 gc_messages(messageId) 查看
    const { text: displayText, truncated, originalLength } = truncateMessageText(m.text || '');
    const truncNotice = truncated
      ? `\n[已截断，原文 ${originalLength} 字符。使用 gc_messages 查看 messageId: ${m.id} 的完整内容]`
      : '';

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

    return `[${time}] ${from}${sessionLabel}：${displayText}${truncNotice}${suffix}${attachmentInfo}`;
  });

  return [
    `─── 你未读的群聊消息（共${messages.length}条）───`,
    ...lines,
  ].join('\n');
}

export function processAttachmentsForInjection(attachments, chat = null, maxLines = 50) {
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
/**
 * 为被派发的 agent 构建群聊 system 上下文块。
 * 让 agent 知道自己处于群聊中、发送者是谁、回复会被同步回群聊。
 */
export function buildGroupDispatchSystemMessage(chat, message, allIdentities) {
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
