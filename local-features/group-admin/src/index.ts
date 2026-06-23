/**
 * GroupAdminFeature - 群聊管理员工具集
 *
 * 提供群聊状态查看、消息读取、任务派发、摘要写入等工具。
 * 所有工具通过 HTTP API 调用 Claw server。
 *
 * 内嵌 skill: generate-group-md — 引导管理员生成 GROUP.md 群聊背景文档。
 */
import { fileURLToPath } from 'url';
import type { AgentFeature, Tool } from 'agentdev';

const SERVER_ORIGIN = process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 1420}`;

export class GroupAdminFeature implements AgentFeature {
  readonly name = 'group-admin';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

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

  private async apiPut(path: string, body: any): Promise<any> {
    const res = await fetch(`${SERVER_ORIGIN}${path}`, {
      method: 'PUT',
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
      {
        name: 'gc_scan_workdir',
        description: '扫描群聊工作目录的结构和关键文件内容，用于了解项目背景。返回目录树和关键文件（如 package.json、README.md、CLAUDE.md 等）的摘要。',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
          },
          required: ['chatId'],
        },
        execute: async (args: any) => {
          const { chatId } = args || {};
          if (!chatId) return { error: 'chatId is required' };
          try {
            const data = await this.apiGet(
              `/protoclaw/group_chats/${encodeURIComponent(chatId)}/workdir_scan`
            );
            if (!data.workDir) {
              return { error: '该群聊未设置工作目录' };
            }
            const treeLines = (data.entries || []).map((e: any) => {
              if (e.type === 'subdir_listing') {
                const children = (e.children || []).map((c: string) => `      ${c}`).join('\n');
                return `  [DIR] ${e.name}\n${children}`;
              }
              const prefix = e.type === 'dir' ? '[DIR]' : '[FILE]';
              return `  ${prefix} ${e.name}`;
            });
            const fileSections = Object.entries(data.keyFiles || {}).map(
              ([name, content]: [string, any]) => {
                return `--- ${name} ---\n${typeof content === 'string' ? content.slice(0, 3000) : JSON.stringify(content, null, 2)}`;
              }
            );
            const text = [
              `工作目录: ${data.workDir}`,
              '',
              '目录结构:',
              ...treeLines,
              '',
              '关键文件:',
              ...fileSections,
            ].join('\n');
            return { success: true, text };
          } catch (err: any) {
            return { error: `扫描工作目录失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_save_group_md',
        description: '保存 GROUP.md 内容到群聊的工作目录。GROUP.md 是群聊的静态背景文档，会在每次管理员启动时作为系统上下文注入。',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            content: { type: 'string', description: 'GROUP.md 的完整 markdown 内容' },
          },
          required: ['chatId', 'content'],
        },
        execute: async (args: any) => {
          const { chatId, content } = args || {};
          if (!chatId || typeof content !== 'string') {
            return { error: 'chatId and content are required' };
          }
          try {
            const result = await this.apiPut(
              `/protoclaw/group_chats/${encodeURIComponent(chatId)}/group_md`,
              { content }
            );
            return { success: true, text: `GROUP.md 已保存到 ${result.path}` };
          } catch (err: any) {
            return { error: `保存 GROUP.md 失败: ${err.message || err}` };
          }
        },
      },
    ];
  }
}
