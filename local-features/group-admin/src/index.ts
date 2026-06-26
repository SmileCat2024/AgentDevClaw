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
import { CallStart } from 'agentdev';

const SERVER_ORIGIN = process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 1420}`;

export class GroupAdminFeature implements AgentFeature {
  readonly name = 'group-admin';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  /** 每多少轮 call 注入一次身份提醒 */
  private static readonly REMINDER_INTERVAL = 3;
  private callCount = 0;

  @CallStart
  async injectIdentityReminder(ctx: any): Promise<void> {
    this.callCount++;
    if (this.callCount % GroupAdminFeature.REMINDER_INTERVAL !== 0) return;
    if (!ctx?.context) return;

    ctx.context.add({
      role: 'system',
      content:
        '[管理员身份提醒] 你是群聊管理员，处理具体业务并不是你的核心职责。\n' +
        '- 你的所有对话默认只有你能看到。要让群里用户看到回复，必须调用 gc_reply 发送到群里。\n' +
        '- 其他 Agent 看不到群聊，也不会主动响应群聊内容。用户说的话、Agent 的回复，它们都看不到。除非你通过 gc_dispatch 派发任务过去。',
    });
  }

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
            const routeInfo = m.routing?.status
              ? ` [${m.routing.status}${m.routing.targetSessionTitle ? ` → ${m.routing.targetSessionTitle}` : m.routing.targetSessionId ? ` → ${m.routing.targetSessionId.slice(0, 16)}` : ''}]`
              : '';
            return `[${new Date(m.timestamp).toLocaleString()}] ${m.from}: ${m.text}${routeInfo}`;
          });
          return { success: true, text: lines.join('\n') || '暂无消息' };
        },
      },
      {
        name: 'gc_dispatch',
        description: '向指定群聊中的 Agent 派发任务。默认复用该 Agent 在群内的最近会话。',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            text: { type: 'string', description: '任务描述（要清晰完整地说明任务要求，因为被派发的 Agent 没有群聊上下文）' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
            title: { type: 'string', description: '新会话标题。仅当 forceNew 为 true 时有效且必填；复用已有会话时此字段会被忽略。' },
            targetSessionId: { type: 'string', description: '可选。指定目标 Agent 的具体会话 ID。传入后将任务路由到该会话。先用 gc_sessions 查看可用会话。' },
            forceNew: { type: 'boolean', description: '可选。设为 true 时强制创建全新会话。默认 false（复用最近会话）。' },
          },
          required: ['chatId', 'text', 'identityRef'],
        },
        execute: async (args: any) => {
          const { chatId, text, identityRef, title, targetSessionId, forceNew } = args || {};
          if (!chatId || !text || !identityRef) {
            return { error: 'chatId, text, identityRef are required' };
          }
          // 禁止向自己派发（防止反馈循环）
          if (identityRef === 'work-group:admin') {
            return { error: '不能向管理员自身派发任务' };
          }
          // forceNew 时强制要求 title
          if (forceNew && (!title || !title.trim())) {
            return {
              error: '新建会话时必须指定 title（会话标题），请补充 title 参数后重试。' +
                '\n标题要求：精简反映会话主题，20字以内，不要使用引号或标点，避免"处理问题""继续任务"等空泛措辞。' +
                '\n示例：gc_dispatch({ ..., forceNew: true, title: "修复登录页面 Bug" })',
            };
          }
          const body: any = {
            text,
            from: 'work-group:admin',
            mentions: [{ identityRef }],
            kind: 'dispatch',
          };
          if (targetSessionId) body.targetSessionId = targetSessionId;
          if (forceNew) body.forceNew = true;
          // 仅新建会话时传递 title，复用已有会话时忽略
          if (forceNew && title?.trim()) body.title = title.trim();

          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(chatId)}/messages`,
            body
          );

          let routeInfo = '默认会话';
          if (forceNew) routeInfo = `全新会话「${title.trim()}」`;
          else if (targetSessionId) routeInfo = `会话 ${targetSessionId.slice(0, 20)}`;

          return { success: true, text: `已派发任务到 ${identityRef} → ${routeInfo}，消息 ID: ${msg.id}` };
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
          return { success: true, text: `消息已成功发送到群聊（ID: ${msg.id}）。该消息已展示给群内用户，无需重复发送。如无其他操作需要执行，可结束本轮回复。` };
        },
      },
      {
        name: 'gc_sessions',
        description: '查看群聊中某个 Agent 的会话列表，包括群内会话（被映射的）和外部会话。用于决定 gc_dispatch 使用哪个会话。',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
          },
          required: ['chatId', 'identityRef'],
        },
        execute: async (args: any) => {
          const { chatId, identityRef } = args || {};
          if (!chatId || !identityRef) {
            return { error: 'chatId and identityRef are required' };
          }
          try {
            const data = await this.apiGet(
              `/protoclaw/group_chats/${encodeURIComponent(chatId)}/sessions/${encodeURIComponent(identityRef)}`
            );
            const lines = [
              `${identityRef} 的会话列表（模式: ${data.sessionModel}，当前活跃: ${data.activeSessionId || '无'}）`,
              '',
            ];

            if (data.inChatSessions?.length > 0) {
              lines.push('── 群内会话 ──');
              for (const s of data.inChatSessions) {
                const tag = s.isActive ? ' [当前]' : '';
                const time = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '';
                lines.push(` ${s.title}${tag} (id: ${s.id}) ${time}`);
              }
              lines.push('');
            }

            if (data.externalSessions?.length > 0) {
              lines.push('── 外部会话 ──');
              for (const s of data.externalSessions) {
                const time = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '';
                lines.push(` ${s.title} (id: ${s.id}) ${time}`);
              }
            }

            return { success: true, text: lines.join('\n') };
          } catch (err: any) {
            return { error: `获取会话列表失败: ${err.message || err}` };
          }
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
        description: '保存 GROUP.md 群聊背景文档。GROUP.md 是群聊的静态背景，会在管理员新会话首次启动时作为背景上下文注入（类似 CLAUDE.md 的角色）。更新后需要重启管理员会话才能生效。',
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
      {
        name: 'gc_interrupt',
        description: '中断指定群聊中正在运行的 Agent 会话。用于停止正在执行的任务。',
        parameters: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
          },
          required: ['chatId', 'identityRef'],
        },
        execute: async (args: any) => {
          const { chatId, identityRef } = args || {};
          if (!chatId || !identityRef) {
            return { error: 'chatId and identityRef are required' };
          }
          try {
            const result = await this.apiPost('/protoclaw/gc/control', {
              chatId,
              identityRef,
              action: 'interrupt',
            });
            return { success: true, text: `已中断 ${identityRef} 的会话` };
          } catch (err: any) {
            return { error: `中断失败: ${err.message || err}` };
          }
        },
      },
    ];
  }
}
