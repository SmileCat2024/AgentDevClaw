/**
 * GroupAdminFeature - 群聊管理员工具集
 *
 * 提供群聊状态查看、消息读取、任务派发、摘要写入等工具。
 * 所有工具通过 HTTP API 调用 Claw server。
 *
 * 管理员与群聊一一绑定，chatId 从环境变量 PROTOCLAW_GC_CHAT_ID 自动获取，
 * 管理员无需（也无法）手动传入 chatId。
 * 所有工具的数据范围严格限制在当前群聊，不暴露其他群聊信息。
 *
 * 内嵌 skill: generate-group-md — 引导管理员生成 GROUP.md 群聊背景文档。
 */
import { fileURLToPath } from 'url';
import type { AgentFeature, Tool } from 'agentdev';
import { CallStart, StepStart } from 'agentdev';

const SERVER_ORIGIN = process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 1420}`;

export class GroupAdminFeature implements AgentFeature {
  readonly name = 'group-admin';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  /** 每多少轮 call 注入一次身份提醒 */
  private static readonly REMINDER_INTERVAL = 1;
  /** 每多少 step 注入一次身份提醒（call 内） */
  private static readonly STEP_REMINDER_INTERVAL = 3;
  private callCount = 0;
  private stepCount = 0;

  /** 当前管理员绑定的群聊 ID（启动时从环境变量注入） */
  private get chatId(): string {
    return process.env.PROTOCLAW_GC_CHAT_ID || '';
  }

  @CallStart
  async injectIdentityReminder(ctx: any): Promise<void> {
    this.callCount++;
    this.stepCount = 0; // 跨 call 重置 step 计数
    if (this.callCount % GroupAdminFeature.REMINDER_INTERVAL !== 0) return;
    if (!ctx?.context) return;

    ctx.context.add({
      role: 'system',
      content:
        '[管理员身份提醒] 你是群聊管理员，处理具体业务并不是你的核心职责。\n' +
        '- 你的所有对话默认只有你能看到。要让群里用户看到回复，必须调用 gc_reply 发送到群里。\n' +
        '- 其他 Agent 看不到群聊，也不会主动响应群聊内容。用户说的话、Agent 的回复，它们都看不到。除非你通过 gc_dispatch 派发任务过去。\n' +
        '- 管理多个会话时，优先依据 gc_overview/gc_status/gc_sessions 和 gc_dispatch 返回的态势信息；回复或继续派发时反复核对 identityRef、sessionId、运行状态、模型和上下文用量。',
    });
  }

  @StepStart
  async injectStepReminder(ctx: any): Promise<void> {
    this.stepCount++;
    if (this.stepCount % GroupAdminFeature.STEP_REMINDER_INTERVAL !== 0) return;
    if (!ctx?.context) return;

    ctx.context.add({
      role: 'system',
      content:
        '[管理员身份提醒] 你是群聊管理员，处理具体业务并不是你的核心职责。\n' +
        '- 你的所有对话默认只有你能看到。要让群里用户看到回复，必须调用 gc_reply 发送到群里。\n' +
        '- 其他 Agent 看不到群聊，也不会主动响应群聊内容。用户说的话、Agent 的回复，它们都看不到。除非你通过 gc_dispatch 派发任务过去。\n' +
        '- 管理多个会话时，优先依据 gc_overview/gc_status/gc_sessions 和 gc_dispatch 返回的态势信息；回复或继续派发时反复核对 identityRef、sessionId、运行状态、模型和上下文用量。',
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
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `API ${path} failed: ${res.status}`);
    }
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

  private statusLabel(status: string): string {
    if (status === 'running') return '运行中';
    if (status === 'queued') return '排队中';
    if (status === 'idle') return '空闲';
    return '离线';
  }

  private formatNumber(value: any): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return '?';
    return n.toLocaleString('zh-CN');
  }

  private formatSessionLine(session: any): string {
    const title = session?.title || '未命名';
    const sessionId = session?.sessionId || session?.id || '';
    const status = this.statusLabel(session?.runtimeStatus || session?.status || 'offline');
    const model = session?.modelName || '未知模型';
    const ctxTokens = session?.contextTokens;
    const ctxLength = session?.contextLength;
    const ctxPct = session?.contextUsagePct != null ? `${session.contextUsagePct}%` : '?';
    const ctx = ctxTokens && ctxLength
      ? `${this.formatNumber(ctxTokens)}/${this.formatNumber(ctxLength)} (${ctxPct})`
      : `? (${ctxPct})`;
    const threshold = session?.compressRatio != null ? `${session.compressRatio}%` : '?';
    const warn = session?.contextUsagePct != null && session?.compressRatio != null
      && session.contextUsagePct >= session.compressRatio ? '，已到压缩阈值' : '';
    const route = session?.routing?.status ? `，路由: ${session.routing.status}` : '';
    const active = session?.isActive ? '，当前会话' : '';
    return `  - [${status}] ${title}${active}\n    sessionId: ${sessionId}\n    模型: ${model}；上下文: ${ctx}；压缩阈值: ${threshold}${warn}${route}`;
  }

  private formatAwarenessText(data: any, options: { focusIdentityRef?: string; focusSessionId?: string } = {}): string {
    const totals = data?.totals || {};
    const lines = [
      `群聊态势: 会话 ${totals.sessions ?? 0} 个；运行中 ${totals.running ?? 0}；排队 ${totals.queued ?? 0}；空闲 ${totals.idle ?? 0}；离线 ${totals.offline ?? 0}`,
    ];
    if ((totals.pendingRoutes || 0) > 0 || (totals.deliveredRoutes || 0) > 0) {
      lines.push(`路由: pending ${totals.pendingRoutes || 0}；delivered ${totals.deliveredRoutes || 0}`);
    }

    const identities = Array.isArray(data?.identities) ? data.identities : [];
    for (const identity of identities) {
      if (options.focusIdentityRef && identity.identityRef !== options.focusIdentityRef) continue;
      const sessions = Array.isArray(identity.sessions) ? identity.sessions : [];
      const shown = options.focusSessionId
        ? sessions.filter((s: any) => s.sessionId === options.focusSessionId)
        : sessions;
      lines.push('');
      lines.push(`${identity.displayName || identity.identityRef} (${identity.identityRef}) - ${this.statusLabel(identity.aggregateStatus || 'offline')}，会话 ${sessions.length} 个`);
      if (shown.length === 0) {
        lines.push('  （暂无群内会话）');
      } else {
        for (const session of shown) {
          lines.push(this.formatSessionLine(session));
        }
      }
    }
    return lines.join('\n');
  }

  private async fetchAwareness(): Promise<any> {
    return this.apiGet(`/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/awareness`);
  }

  getTools(): Tool[] {
    return [
      {
        name: 'gc_overview',
        description: '查看当前群聊的概览和会话态势，包括每个 Agent 的会话 ID、运行状态、模型、上下文用量和压缩阈值。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const chat = await this.apiGet(`/protoclaw/group_chats/${encodeURIComponent(this.chatId)}`);
          const awareness = await this.fetchAwareness().catch(() => null);
          const members = (chat.members || [])
            .map((m: any) => {
              const name = m.identityRef === 'user' ? '用户' : m.identityRef;
              return `  - ${name} (${m.role || 'member'})`;
            })
            .join('\n');
          const lines = [
            `【${chat.name || '(未命名)'}】`,
            `消息数: ${(chat.messages || []).length}`,
            `成员:`,
            members || '  (无)',
          ];
          // 最近活动
          const msgs = (chat.messages || []).filter((m: any) => m.kind !== 'event');
          if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            lines.push(`最近消息: [${new Date(last.timestamp).toLocaleString()}] ${last.from}: ${(last.text || '').slice(0, 80)}`);
          }
          if (awareness) {
            lines.push('');
            lines.push(this.formatAwarenessText(awareness));
          }
          return { success: true, text: lines.join('\n') };
        },
      },
      {
        name: 'gc_messages',
        description: '读取当前群聊的最近消息（含路由状态和会话标题）',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '消息数量，默认 20' },
          },
        },
        execute: async (args: any) => {
          const { limit } = args || {};
          const reqLimit = limit || 20;
          const data = await this.apiGet(
            `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/messages?limit=${reqLimit}`
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
        description: '向群内某个 Agent 派发任务。默认复用该 Agent 在群内的最近会话。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '任务描述（要清晰完整地说明任务要求，因为被派发的 Agent 没有群聊上下文）' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
            title: { type: 'string', description: '会话标题。创建新会话时用此标题命名；复用已有会话时忽略。必填。' },
            targetSessionId: { type: 'string', description: '可选。指定目标 Agent 的具体会话 ID。传入后将任务路由到该会话。先用 gc_sessions 查看可用会话。' },
            forceNew: { type: 'boolean', description: '可选。设为 true 时强制创建全新会话。默认 false（复用最近会话）。' },
          },
          required: ['text', 'identityRef', 'title'],
        },
        execute: async (args: any) => {
          const { text, identityRef, title, targetSessionId, forceNew } = args || {};
          if (!text || !identityRef || !title?.trim()) {
            return { error: 'text, identityRef, title 都是必填项' };
          }
          // 禁止向自己派发（防止反馈循环）
          if (identityRef === 'work-group:admin') {
            return { error: '不能向管理员自身派发任务' };
          }
          const body: any = {
            text,
            from: 'work-group:admin',
            mentions: [{ identityRef }],
            kind: 'dispatch',
          };
          if (targetSessionId) body.targetSessionId = targetSessionId;
          if (forceNew) body.forceNew = true;
          if (title?.trim()) body.title = title.trim();

          try {
            const msg = await this.apiPost(
              `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/messages`,
              body
            );

            // 从响应中提取会话信息
            const resolved = msg.resolvedSession;
            if (resolved) {
              const action = resolved.isNew
                ? `创建了新会话「${resolved.sessionTitle}」`
                : `复用已有会话「${resolved.sessionTitle}」`;
              const awareness = await this.fetchAwareness().catch(() => null);
              const awarenessText = awareness
                ? '\n\n派发后的最新态势:\n' + this.formatAwarenessText(awareness)
                : '';
              return {
                success: true,
                text: `已派发任务到 ${identityRef}，${action}。\nsessionId: ${resolved.sessionId}\n消息 ID: ${msg.id}${awarenessText}`,
                sessionId: resolved.sessionId,
                sessionTitle: resolved.sessionTitle,
                isNew: resolved.isNew,
                awareness,
              };
            }

            const awareness = await this.fetchAwareness().catch(() => null);
            return {
              success: true,
              text: `已派发任务到 ${identityRef}，消息 ID: ${msg.id}` + (awareness ? `\n\n派发后的最新态势:\n${this.formatAwarenessText(awareness)}` : ''),
              awareness,
            };
          } catch (err: any) {
            return { error: `派发失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_reply',
        description: '向群聊发送一条消息。你的对话默认不会出现在群聊中，需要发消息时必须调用此工具。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '消息内容' },
          },
          required: ['text'],
        },
        execute: async (args: any) => {
          const { text } = args || {};
          if (!text) {
            return { error: 'text is required' };
          }
          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/messages`,
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
        description: '查看群内某个 Agent 的会话列表（仅群内会话池）。用于决定 gc_dispatch 使用哪个会话。',
        parameters: {
          type: 'object',
          properties: {
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
          },
          required: ['identityRef'],
        },
        execute: async (args: any) => {
          const { identityRef } = args || {};
          if (!identityRef) {
            return { error: 'identityRef is required' };
          }
          try {
            const data = await this.apiGet(
              `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/sessions/${encodeURIComponent(identityRef)}`
            );
            const awareness = await this.fetchAwareness().catch(() => null);
            if (awareness) {
              const text = this.formatAwarenessText(awareness, { focusIdentityRef: identityRef });
              return { success: true, text, awareness };
            }
            const lines = [
              `${identityRef} 的群内会话列表（模式: ${data.sessionModel}，当前活跃: ${data.activeSessionId || '无'}）`,
              '',
            ];

            if (data.inChatSessions?.length > 0) {
              for (const s of data.inChatSessions) {
                const tag = s.isActive ? ' [当前]' : '';
                const time = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '';
                lines.push(` ${s.title}${tag} (id: ${s.id}) ${time}`);
              }
            } else {
              lines.push('（暂无群内会话）');
            }

            return { success: true, text: lines.join('\n') };
          } catch (err: any) {
            return { error: `获取会话列表失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_status',
        description: '查看所有可用身份及其会话态势，包括会话 ID、运行状态、模型、上下文用量和压缩阈值。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const data = await this.apiGet('/protoclaw/identities');
          const awareness = await this.fetchAwareness().catch(() => null);
          const ids = data.identities || [];
          const lines = ids.map((i: any) => {
            return `${i.displayName} (${i.identityRef})\n  ${i.description || ''}\n  session: ${i.sessionModel}`;
          });
          const awarenessText = awareness ? `\n\n${this.formatAwarenessText(awareness)}` : '';
          return { success: true, text: (lines.join('\n\n') || '暂无可用身份') + awarenessText, awareness };
        },
      },
      {
        name: 'gc_scan_workdir',
        description: '扫描群聊工作目录的结构和关键文件内容，用于了解项目背景。返回目录树和关键文件（如 package.json、README.md、CLAUDE.md 等）的摘要。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            const data = await this.apiGet(
              `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/workdir_scan`
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
            content: { type: 'string', description: 'GROUP.md 的完整 markdown 内容' },
          },
          required: ['content'],
        },
        execute: async (args: any) => {
          const { content } = args || {};
          if (typeof content !== 'string') {
            return { error: 'content is required' };
          }
          try {
            const result = await this.apiPut(
              `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/group_md`,
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
        description: '中断群聊中正在运行的 Agent 会话。用于停止正在执行的任务。',
        parameters: {
          type: 'object',
          properties: {
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
          },
          required: ['identityRef'],
        },
        execute: async (args: any) => {
          const { identityRef } = args || {};
          if (!identityRef) {
            return { error: 'identityRef is required' };
          }
          try {
            await this.apiPost('/protoclaw/gc/control', {
              chatId: this.chatId,
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
