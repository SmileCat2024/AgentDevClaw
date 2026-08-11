import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

import { GROUP_CHATS_ROOT } from '../../shared/constants.js';
import { sanitizeSessionFragment } from '../../shared/string-helpers.js';
import { normalizeGroupChatMembers } from './pure-functions.js';

const CHAT_SNAPSHOT = Symbol('group-chat-snapshot');

/**
 * 群聊文件存储工厂。接受 rootDir 参数，便于测试注入临时目录。
 * @param {string} rootDir — 群聊文件存储根目录
 * @param {object} [hooks] — 可选钩子，目前支持 onWrite(chatId)
 * @returns {object} data layer 方法集
 */
export function createGroupChatDataLayer(rootDir, hooks = {}) {
  const writeChains = new Map();

  async function ensureDir() {
    await fs.mkdir(rootDir, { recursive: true });
  }

  function getGroupChatPath(chatId) {
    return path.join(rootDir, `${sanitizeSessionFragment(chatId)}.json`);
  }

  async function readGroupChat(chatId) {
    const filePath = getGroupChatPath(chatId);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const chat = JSON.parse(raw);
      chat.members = normalizeGroupChatMembers(chat.members);
      Object.defineProperty(chat, CHAT_SNAPSHOT, {
        value: raw,
        configurable: true,
      });
      return chat;
    } catch {
      return null;
    }
  }

  function withWriteLock(chatId, operation) {
    const key = sanitizeSessionFragment(chatId);
    const previous = writeChains.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    writeChains.set(key, next);
    return next.finally(() => {
      if (writeChains.get(key) === next) writeChains.delete(key);
    });
  }

  async function writeGroupChatUnlocked(chat) {
    await ensureDir();
    const filePath = getGroupChatPath(chat.id);
    chat.updatedAt = Date.now();
    // Write to a unique temp file before rename so a process crash cannot leave
    // a partial chat file behind.
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(chat, null, 2);
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, filePath);
    Object.defineProperty(chat, CHAT_SNAPSHOT, {
      value: serialized,
      configurable: true,
    });
    if (typeof hooks.onWrite === 'function') hooks.onWrite(chat.id);
    return chat;
  }

  async function writeGroupChat(chat) {
    return withWriteLock(chat.id, async () => {
      const current = await readGroupChat(chat.id);
      const snapshot = chat?.[CHAT_SNAPSHOT];
      if (current && snapshot && current[CHAT_SNAPSHOT] !== snapshot) {
        throw new Error(`Stale group chat write rejected: ${chat.id}`);
      }
      return writeGroupChatUnlocked(chat);
    });
  }

  async function listGroupChats() {
    await ensureDir();
    const entries = await fs.readdir(rootDir);
    const chats = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.annotations.json')) continue;
      try {
        const raw = await fs.readFile(path.join(rootDir, entry), 'utf8');
        const chat = JSON.parse(raw);
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

  async function updateGroupChat(chatId, mutator) {
    return withWriteLock(chatId, async () => {
      const chat = await readGroupChat(chatId);
      if (!chat) return null;
      const result = await mutator(chat);
      if (result === null) return null;
      await writeGroupChatUnlocked(chat);
      return result;
    });
  }

  async function appendGroupChatMessage(chatId, message) {
    return updateGroupChat(chatId, (chat) => {
      if (!Array.isArray(chat.messages)) chat.messages = [];
      chat.messages.push(message);
      return chat;
    });
  }

  async function updateMessageRouting(chatId, messageId, routingUpdate) {
    return updateGroupChat(chatId, (chat) => {
      if (!Array.isArray(chat.messages)) return null;
      const msg = chat.messages.find((m) => m.id === messageId);
      if (!msg) return null;
      msg.routing = { ...(msg.routing || {}), ...routingUpdate };
      return msg;
    });
  }

  async function updateMessageFields(chatId, messageId, fieldUpdate) {
    return updateGroupChat(chatId, (chat) => {
      if (!Array.isArray(chat.messages)) return null;
      const msg = chat.messages.find((m) => m.id === messageId);
      if (!msg) return null;
      Object.assign(msg, fieldUpdate);
      return msg;
    });
  }

  async function deleteGroupChatFile(chatId) {
    return withWriteLock(chatId, async () => {
      try {
        await fs.unlink(getGroupChatPath(chatId));
        return true;
      } catch {
        return false;
      }
    });
  }

  return {
    ensureDir,
    getGroupChatPath,
    readGroupChat,
    writeGroupChat,
    updateGroupChat,
    listGroupChats,
    appendGroupChatMessage,
    updateMessageRouting,
    updateMessageFields,
    deleteGroupChatFile,
  };
}

/**
 * 读取所有群聊，返回侧栏分组所需的精简数据。
 *
 * 每个群聊提取 admin session ID（chat.sessions['work-group:admin']），
 * 用于前端建立 sessionId → chatId/chatName 的反向映射，将 work-group
 * 的子运行时按群聊分组显示。
 *
 * 独立于 setupGroupChatRoutes 闭包，可在模块级直接 import。
 *
 * @returns {Promise<Array<{id: string, name: string, adminSessionId: string|null}>>}
 */
export async function getGroupChatsForSidebar() {
  try {
    const entries = await fs.readdir(GROUP_CHATS_ROOT);
    const result = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.annotations.json')) continue;
      try {
        const raw = await fs.readFile(path.join(GROUP_CHATS_ROOT, entry), 'utf8');
        const chat = JSON.parse(raw);
        if (chat.archived) continue;
        result.push({
          id: chat.id,
          name: chat.name || chat.id,
          adminSessionId: chat.sessions?.['work-group:admin'] || null,
        });
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}
