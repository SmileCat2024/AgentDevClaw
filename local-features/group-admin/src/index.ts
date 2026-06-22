/**
 * GroupAdminFeature - 群聊管理员工具集
 *
 * 提供群聊状态查看、消息读取、任务派发、摘要写入等工具。
 * 所有工具通过 HTTP API 调用 Claw server。
 */
import type { AgentFeature, Tool } from 'agentdev';

const SERVER_ORIGIN = process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 1420}`;

export class GroupAdminFeature implements AgentFeature {
  readonly name = 'group-admin';

  private async apiGet(path: string): Promise<any> {
    const res = await fetch(`${SERVER_ORIGIN}${path}`);
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
    return res.json();
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const res = await fetch(`${SERVER_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
    return res.json();
  }

  getTools(): Tool[] {
    return [
      {
        name: 'gc_overview',
        description: '查看所有群聊的概览，包括群名、成员、消息数、最近活动',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const data = await this.apiGet('/protoclaw/group_chats');
          const chats = data.chats || [];
          const lines = chats.map((c: any) => {
            return `【${c.name}】(id: ${c.id})\n  成员数: ${c.memberCount}, 消息数: ${c.messageCount}\n  最近: ${c.lastMessage?.text || '(无)'}`;
          });
          return { success: true, text: lines.join('\n\n') || '暂无群聊' };
        },
      },
      {
        name: 'gc_messages',
        description: '读取指定群聊的最近消息',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            limit: { type: 'number', description: '消息数量，默认 20' },
          },
          required: ['chatId'],
        },
        execute: async (args: any) => {
          const { chatId, limit } = args || {};
          if (!chatId) return { error: 'chatId is required' };
          const reqLimit = limit || 20;
          const data = await this.apiGet(
            `/protoclaw/group_chats/${encodeURIComponent(chatId)}/messages?limit=${reqLimit}`
          );
          const msgs = data.messages || [];
          const lines = msgs.map((m: any) => {
            const routing = m.routing ? ` [${m.routing.status}]` : '';
            return `[${new Date(m.timestamp).toLocaleString()}] ${m.from}: ${m.text}${routing}`;
          });
          return { success: true, text: lines.join('\n') || '暂无消息' };
        },
      },
      {
        name: 'gc_dispatch',
        description: '向指定群聊中的 Agent 派发任务',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            text: { type: 'string', description: '任务描述' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
          },
          required: ['chatId', 'text', 'identityRef'],
        },
        execute: async (args: any) => {
          const { chatId, text, identityRef } = args || {};
          if (!chatId || !text || !identityRef) {
            return { error: 'chatId, text, identityRef are required' };
          }
          // 禁止向自己派发（防止反馈循环）
          if (identityRef === 'work-group:admin') {
            return { error: '不能向管理员自身派发任务' };
          }
          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(chatId)}/messages`,
            {
              text,
              from: 'work-group:admin',
              mentions: [{ identityRef }],
              kind: 'dispatch',
            }
          );
          return { success: true, text: `已派发任务到 ${identityRef}，消息 ID: ${msg.id}` };
        },
      },
      {
        name: 'gc_summary',
        description: '向指定群聊写入一条工作摘要',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            text: { type: 'string', description: '摘要内容' },
          },
          required: ['chatId', 'text'],
        },
        execute: async (args: any) => {
          const { chatId, text } = args || {};
          if (!chatId || !text) {
            return { error: 'chatId and text are required' };
          }
          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(chatId)}/messages`,
            {
              text,
              from: 'work-group:admin',
              kind: 'summary',
            }
          );
          return { success: true, text: `摘要已写入，消息 ID: ${msg.id}` };
        },
      },
      {
        name: 'gc_reply',
        description: '向群聊发送一条消息。你的对话默认不会出现在群聊中，需要发消息时必须调用此工具。',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            text: { type: 'string', description: '消息内容' },
          },
          required: ['chatId', 'text'],
        },
        execute: async (args: any) => {
          const { chatId, text } = args || {};
          if (!chatId || !text) {
            return { error: 'chatId and text are required' };
          }
          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(chatId)}/messages`,
            {
              text,
              from: 'work-group:admin',
              mentions: [],
            }
          );
          return { success: true, text: `消息已发送，消息 ID: ${msg.id}` };
        },
      },
      {
        name: 'gc_status',
        description: '查看所有可用身份及其运行状态',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const data = await this.apiGet('/protoclaw/identities');
          const ids = data.identities || [];
          const lines = ids.map((i: any) => {
            return `${i.displayName} (${i.identityRef})\n  ${i.description || ''}\n  session: ${i.sessionModel}`;
          });
          return { success: true, text: lines.join('\n\n') || '暂无可用身份' };
        },
      },
    ];
  }
}
