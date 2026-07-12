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
import type { AgentFeature, Tool, DecisionResult } from 'agentdev';
import { CallStart, StepStart, StepFinish, Decision } from 'agentdev';

const SERVER_ORIGIN = process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 1420}`;

export class GroupAdminFeature implements AgentFeature {
  readonly name = 'group-admin';
  readonly description = '以工作线程为核心观察群聊态势、派发增量指令并跟踪执行结果。';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  /** 每多少轮 call 注入一次身份提醒 */
  private static readonly REMINDER_INTERVAL = 1;
  /** 每多少 step 注入一次身份提醒（call 内） */
  private static readonly STEP_REMINDER_INTERVAL = 3;
  private callCount = 0;
  private stepCount = 0;

  /** 当 gc_reply / gc_dispatch 以 done=true 或 gc_stop 执行后置位，@StepFinish 检查后消费 */
  private stopRequested = false;

  /** 当 Agent 尝试无工具调用结束时置位，@StepStart 注入提醒后消费 */
  private stopReminderPending = false;

  /** 当前管理员绑定的群聊 ID（启动时从环境变量注入） */
  private get chatId(): string {
    return process.env.PROTOCLAW_GC_CHAT_ID || '';
  }

  @CallStart
  async injectIdentityReminder(ctx: any): Promise<void> {
    // [已悬置] 身份提醒改由系统提示词 + gc_stop 强制约定兜底，不再反复注入
    return;
  }

  @StepStart
  async injectStepReminder(ctx: any): Promise<void> {
    this.stepCount++;

    // 优先处理停止提醒：上一轮 Agent 尝试无工具调用结束，强制要求使用工具
    if (this.stopReminderPending) {
      this.stopReminderPending = false;
      if (ctx?.context) {
        ctx.context.add({
          role: 'system',
          content:
            '[流程提醒] 你刚才尝试直接结束对话，但这不被允许。\n' +
            '- 如果你要结束本轮对话，必须调用 gc_stop 工具。\n' +
            '- 如果你有话要对群里说，必须使用 gc_reply 工具（并设置 done=true 表示发送后结束）。\n' +
            '- 如果你要继续已有工作，使用 gc_dispatch_thread；开始全新工作使用 gc_start_thread（并设置 done=true 表示派发后结束）。\n' +
            '- gc_dispatch 仅保留给明确 session 的兼容场景。\n' +
            '不要直接输出文本而不调用任何工具。',
        });
      }
      return;
    }

    // [已悬置] 常规身份提醒不再注入，由系统提示词 + gc_stop 强制约定兜底
    return;
  }

  @StepFinish
  async checkStopRequest(ctx: any): Promise<DecisionResult> {
    // Case 1: Agent 显式请求停止（gc_stop 或 done=true）
    if (this.stopRequested) {
      this.stopRequested = false;
      return Decision.Deny;
    }

    // Case 2: 无工具调用且未显式停止 — 强制继续，注入提醒
    const toolCallsCount = ctx?.toolCallsCount ?? 0;
    if (toolCallsCount === 0) {
      this.stopReminderPending = true;
      return Decision.Approve;
    }

    // Case 3: 有工具调用，正常流程
    return Decision.Continue;
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

  private async fetchThreadSituation(): Promise<any> {
    return this.apiGet(`/protoclaw/gc/session_threads?chatId=${encodeURIComponent(this.chatId)}`);
  }

  private threadTitle(thread: any): string {
    return thread?.threadTitle || thread?.activeHeadTitle || '未命名工作';
  }

  private formatThreadSituation(data: any, status = 'all'): string {
    const totals = data?.totals || {};
    const allThreads = Array.isArray(data?.threads) ? data.threads : [];
    const threads = status === 'all'
      ? allThreads
      : allThreads.filter((thread: any) => thread.workStatus === status);
    const lines = [
      `工作现场：运行中 ${totals.running || 0}；进行中 ${totals.active || 0}；已完成 ${totals.completed || 0}；历史 ${totals.history || 0}`,
    ];
    if (threads.length === 0) {
      lines.push(status === 'all' ? '当前还没有工作线程。' : `没有 ${status} 状态的工作线程。`);
      return lines.join('\n');
    }

    const runtimeLabels: Record<string, string> = {
      running: '运行中', queued: '排队中', idle: '空闲可继续', offline: '未运行可继续', unavailable: '不可用',
    };
    const workLabels: Record<string, string> = {
      active: '进行中', completed: '已完成', history: '历史', attention: '需关注',
    };
    for (const thread of threads) {
      const summary = thread.taskSummary || {};
      const taskText = summary.total > 0
        ? `Task ${summary.completed || 0}/${summary.total}`
        : 'Task 尚未建立';
      const contextText = thread.contextUsage
        ? `上下文 ${thread.contextUsage.percent || 0}%`
        : '上下文未知';
      const latest = String(thread.latestMessage?.text || '').replace(/\s+/g, ' ').trim();
      lines.push(
        '',
        `[${workLabels[thread.workStatus] || thread.workStatus} · ${runtimeLabels[thread.runtimeStatus] || thread.runtimeStatus}] ${thread.identityName} · ${this.threadTitle(thread)}`,
        `  threadRef: ${thread.threadRef}`,
        `  head: ${thread.lineageHeadId}`,
        `  ${taskText}；${contextText}；${thread.canDispatch ? '可派发' : '不可派发'}`,
      );
      if (latest) lines.push(`  最近：${latest.length > 220 ? `${latest.slice(0, 220)}…` : latest}`);
    }
    return lines.join('\n');
  }

  private async dispatchToAgent(args: any): Promise<any> {
    const { text, identityRef, title, targetSessionId, forceNew, openDirectory, done } = args || {};
    if (!text || !identityRef || !title?.trim()) {
      return { error: 'text, identityRef, title 都是必填项' };
    }
    if (identityRef === 'work-group:admin') {
      return { error: '不能向管理员自身派发任务' };
    }
    const mentionObj: any = { identityRef, title: title.trim() };
    if (targetSessionId) mentionObj.targetSessionId = targetSessionId;
    if (forceNew) mentionObj.forceNew = true;
    if (openDirectory?.trim()) mentionObj.openDirectory = openDirectory.trim();

    try {
      const msg = await this.apiPost(
        `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/messages`,
        { text, from: 'work-group:admin', mentions: [mentionObj], kind: 'dispatch' },
      );
      if (done) this.stopRequested = true;
      const resolved = msg.resolvedSession;
      if (msg.pendingApproval) {
        const sessionInfo = resolved
          ? `\n预解析目标: ${resolved.sessionTitle}（${resolved.sessionId}）`
          : '';
        return {
          success: true,
          text: `派发请求已创建，等待群内用户审批。\n目标: ${identityRef}${sessionInfo}\n消息 ID: ${msg.id}`,
          pendingApproval: true,
          messageId: msg.id,
          identityRef,
          ...(resolved ? { sessionId: resolved.sessionId, sessionTitle: resolved.sessionTitle } : {}),
        };
      }

      const situation = await this.fetchThreadSituation().catch(() => null);
      if (resolved) {
        const action = resolved.isNew
          ? `创建了新工作「${resolved.sessionTitle}」`
          : `指令已进入「${resolved.sessionTitle}」的当前上下文`;
        return {
          success: true,
          text: `已派发到 ${identityRef}，${action}。\nsessionId: ${resolved.sessionId}\n消息 ID: ${msg.id}${situation ? `\n\n派发后的工作现场:\n${this.formatThreadSituation(situation)}` : ''}`,
          sessionId: resolved.sessionId,
          sessionTitle: resolved.sessionTitle,
          isNew: resolved.isNew,
          threads: situation,
        };
      }
      return {
        success: true,
        text: `已派发任务到 ${identityRef}，消息 ID: ${msg.id}${situation ? `\n\n派发后的工作现场:\n${this.formatThreadSituation(situation)}` : ''}`,
        threads: situation,
      };
    } catch (err: any) {
      return { error: `派发失败: ${err.message || err}` };
    }
  }

  getTools(): Tool[] {
    return [
      {
        name: 'gc_overview',
        description: '查看当前群聊概览和工作现场。包含群基本信息、最近活动，以及按工作线程组织的当前态势。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const chat = await this.apiGet(`/protoclaw/group_chats/${encodeURIComponent(this.chatId)}`);
          const awareness = await this.fetchAwareness().catch(() => null);
          const threadSituation = await this.fetchThreadSituation().catch(() => null);
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
          if (threadSituation) {
            lines.push('', this.formatThreadSituation(threadSituation));
          }
          return { success: true, text: lines.join('\n'), threads: threadSituation };
        },
      },
      {
        name: 'gc_messages',
        description: '读取当前群聊的最近消息（含路由状态和会话标题）。超长消息会被截断，可通过 messageId 参数查看完整内容。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '消息数量，默认 20' },
            messageId: { type: 'string', description: '可选。指定消息 ID 时返回该消息的完整内容（不截断），用于查看被截断的超长消息。' },
          },
        },
        execute: async (args: any) => {
          const { limit, messageId } = args || {};

          // 单条查询模式：返回完整内容（不截断）
          if (messageId) {
            const data = await this.apiGet(
              `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/messages?messageId=${encodeURIComponent(messageId)}`
            );
            if (!data.message) return { error: '消息未找到' };
            const m = data.message;
            const time = new Date(m.timestamp).toLocaleString();
            const routeInfo = m.routing?.status
              ? ` [${m.routing.status}${m.routing.targetSessionTitle ? ` → ${m.routing.targetSessionTitle}` : m.routing.targetSessionId ? ` → ${m.routing.targetSessionId.slice(0, 16)}` : ''}]`
              : '';
            return { success: true, text: `[${time}] ${m.from}${routeInfo}\n\n${m.text}` };
          }

          // 列表模式：超长消息截断
          const reqLimit = limit || 20;
          const data = await this.apiGet(
            `/protoclaw/group_chats/${encodeURIComponent(this.chatId)}/messages?limit=${reqLimit}`
          );
          const msgs = data.messages || [];
          const lines = msgs.map((m: any) => {
            const routeInfo = m.routing?.status
              ? ` [${m.routing.status}${m.routing.targetSessionTitle ? ` → ${m.routing.targetSessionTitle}` : m.routing.targetSessionId ? ` → ${m.routing.targetSessionId.slice(0, 16)}` : ''}]`
              : '';
            // 截断超长消息
            const rawText: string = m.text || '';
            if (rawText.length <= 800) {
              return `[${new Date(m.timestamp).toLocaleString()}] ${m.from}: ${rawText}${routeInfo}`;
            }
            const cut = rawText.slice(0, 800);
            const lastNl = cut.lastIndexOf('\n');
            const displayText = (lastNl > 400 ? cut.slice(0, lastNl) : cut).trimEnd();
            return `[${new Date(m.timestamp).toLocaleString()}] ${m.from}: ${displayText}${routeInfo}\n[已截断，原文 ${rawText.length} 字符。使用 gc_messages 查看 messageId: ${m.id} 的完整内容]`;
          });
          return { success: true, text: lines.join('\n') || '暂无消息' };
        },
      },
      {
        name: 'gc_thread_overview',
        description: '查看当前群聊的工作现场。按工作线程列出进行中、已完成和历史工作，并包含运行状态、Task 进度、上下文用量和最近消息。做进度判断或派发前优先调用。',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['all', 'active', 'completed', 'history', 'attention'], description: '可选筛选；默认 all。' },
          },
        },
        execute: async (args: any) => {
          try {
            const data = await this.fetchThreadSituation();
            const status = args?.status || 'all';
            return { success: true, text: this.formatThreadSituation(data, status), ...data };
          } catch (err: any) {
            return { error: `获取工作现场失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_thread_detail',
        description: '查看一条工作线程的详细情况，包括当前 head、全部 Task、最近消息和会话脉络。只有需要判断下一步、验收或追溯分叉时使用。',
        parameters: {
          type: 'object',
          properties: {
            threadRef: { type: 'string', description: '来自 gc_thread_overview 的稳定工作线程引用。' },
          },
          required: ['threadRef'],
        },
        execute: async (args: any) => {
          const threadRef = args?.threadRef;
          if (!threadRef) return { error: 'threadRef is required' };
          try {
            const data = await this.apiGet(
              `/protoclaw/gc/thread_detail?chatId=${encodeURIComponent(this.chatId)}&threadRef=${encodeURIComponent(threadRef)}`
            );
            const thread = data.thread;
            const lines = [this.formatThreadSituation({
              totals: { [thread.workStatus]: 1, running: thread.runtimeStatus === 'running' ? 1 : 0 },
              threads: [thread],
            })];
            const tasks = Array.isArray(thread.tasks) ? thread.tasks : [];
            lines.push('', `Task 详情（${thread.taskSummary?.completed || 0}/${thread.taskSummary?.total || 0}）：`);
            if (tasks.length === 0) lines.push('  尚未建立 Task。');
            for (const task of tasks) {
              const icon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○';
              lines.push(`  ${icon} ${task.activeForm || task.subject || '(未命名)'}`);
            }
            if ((thread.lineage || []).length > 1) {
              lines.push('', '会话脉络：');
              for (const node of thread.lineage) {
                const reason = node.reason ? ` ← ${node.reason}` : '';
                lines.push(`  ${node.sessionTitle || '未命名'} #${String(node.sessionId || '').slice(-8)}${reason}`);
              }
            }
            return { success: true, text: lines.join('\n'), thread };
          } catch (err: any) {
            return { error: `获取工作线程详情失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_dispatch_thread',
        description: '向一条已有工作线程的当前 head 派发增量指令。不要传 sessionId；系统会根据 threadRef 定位最新 head。运行中或排队中的线程不会重复派发。',
        parameters: {
          type: 'object',
          properties: {
            threadRef: { type: 'string', description: '目标工作线程引用，来自 gc_thread_overview。' },
            text: { type: 'string', description: '本次增量要求；目标 Agent 能看到该线程已有上下文。' },
            done: { type: 'boolean', description: '设为 true 表示派发后结束本轮管理员对话。' },
          },
          required: ['threadRef', 'text', 'done'],
        },
        execute: async (args: any) => {
          const { threadRef, text, done } = args || {};
          if (!threadRef || !text) return { error: 'threadRef 和 text 都是必填项' };
          try {
            const situation = await this.fetchThreadSituation();
            const thread = (situation.threads || []).find((item: any) => item.threadRef === threadRef);
            if (!thread) return { error: '工作线程不存在，请重新调用 gc_thread_overview' };
            if (!thread.canDispatch) return { error: `工作线程「${this.threadTitle(thread)}」当前不可派发` };
            if (thread.runtimeStatus === 'running' || thread.runtimeStatus === 'queued') {
              return { error: `工作线程「${this.threadTitle(thread)}」正在${thread.runtimeStatus === 'running' ? '运行' : '排队'}，不要重复派发；如需停止请使用 gc_interrupt_thread` };
            }
            const result = await this.dispatchToAgent({
              text,
              identityRef: thread.identityRef,
              title: this.threadTitle(thread),
              targetSessionId: thread.lineageHeadId,
              done,
            });
            return { ...result, threadRef };
          } catch (err: any) {
            return { error: `线程派发失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_start_thread',
        description: '为某个 Agent 开始一项全新的工作线程。只有用户明确提出新工作、新方向或重新开始时使用；已有工作的续作请使用 gc_dispatch_thread。',
        parameters: {
          type: 'object',
          properties: {
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main。' },
            title: { type: 'string', description: '新工作的简短标题，20 字以内。' },
            text: { type: 'string', description: '完整、独立的新工作要求。' },
            openDirectory: { type: 'string', description: '可选的新会话项目目录。' },
            done: { type: 'boolean', description: '设为 true 表示创建并派发后结束本轮管理员对话。' },
          },
          required: ['identityRef', 'title', 'text', 'done'],
        },
        execute: async (args: any) => this.dispatchToAgent({ ...args, forceNew: true }),
      },
      {
        name: 'gc_interrupt_thread',
        description: '中断一条正在运行的工作线程。系统根据 threadRef 精确定位当前 head，不影响同一 Agent 的其他线程。',
        parameters: {
          type: 'object',
          properties: {
            threadRef: { type: 'string', description: '要中断的工作线程引用。' },
          },
          required: ['threadRef'],
        },
        execute: async (args: any) => {
          const threadRef = args?.threadRef;
          if (!threadRef) return { error: 'threadRef is required' };
          try {
            const situation = await this.fetchThreadSituation();
            const thread = (situation.threads || []).find((item: any) => item.threadRef === threadRef);
            if (!thread) return { error: '工作线程不存在，请重新调用 gc_thread_overview' };
            if (thread.runtimeStatus !== 'running' && thread.runtimeStatus !== 'queued') {
              return { error: `工作线程「${this.threadTitle(thread)}」当前没有在运行` };
            }
            await this.apiPost('/protoclaw/gc/control', {
              chatId: this.chatId,
              identityRef: thread.identityRef,
              sessionId: thread.lineageHeadId,
              action: 'interrupt',
            });
            return { success: true, text: `已中断工作线程「${this.threadTitle(thread)}」`, threadRef, sessionId: thread.lineageHeadId };
          } catch (err: any) {
            return { error: `中断失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_dispatch',
        description: '兼容性的会话级派发工具。已有工作优先使用 gc_dispatch_thread，新工作优先使用 gc_start_thread；只有明确知道目标 session 时才直接使用本工具。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '任务描述（要清晰完整地说明任务要求，因为被派发的 Agent 没有群聊上下文）' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
            title: { type: 'string', description: '会话标题。创建新会话时用此标题命名；复用已有会话时忽略。必填。' },
            targetSessionId: { type: 'string', description: '可选。指定目标 Agent 的具体会话 ID。传入后将任务路由到该会话。先用 gc_sessions 查看可用会话。' },
            forceNew: { type: 'boolean', description: '可选。设为 true 时强制创建全新会话。默认 false（复用最近会话）。' },
            openDirectory: { type: 'string', description: '可选。新会话的项目目录（绝对路径）。仅创建新会话时生效，复用已有会话时忽略。不传则使用群聊绑定的工作目录。' },
            done: { type: 'boolean', description: '设为 true 表示这是本轮最后一步操作，工具执行完后将直接结束本次对话。当你已完成派发且无需进一步操作时设为 true。设为 false 表示还会继续后续操作。' },
          },
          required: ['text', 'identityRef', 'title', 'done'],
        },
        execute: async (args: any) => this.dispatchToAgent(args),
      },
      {
        name: 'gc_reply',
        description: '向群聊发送一条消息。你的对话默认不会出现在群聊中，需要发消息时必须调用此工具。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '消息内容' },
            done: { type: 'boolean', description: '设为 true 表示这是本轮最后一步操作，工具执行完后将直接结束本次对话。当你已发送回复且无需进一步操作时设为 true。设为 false 表示还会继续后续操作。' },
          },
          required: ['text', 'done'],
        },
        execute: async (args: any) => {
          const { text, done } = args || {};
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
          if (done) this.stopRequested = true;
          return { success: true, text: `消息已成功发送到群聊（ID: ${msg.id}）。该消息已展示给群内用户，无需重复发送。` };
        },
      },
      {
        name: 'gc_sessions',
        description: '底层诊断工具：查看某个 Agent 的原始会话列表。日常判断和派发应优先使用 gc_thread_overview / gc_dispatch_thread。',
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
      {
        name: 'gc_session_threads',
        description: 'gc_thread_overview 的兼容别名。返回当前群聊按工作线程组织的工作现场。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          try {
            const data = await this.fetchThreadSituation();
            return { success: true, text: this.formatThreadSituation(data), ...data };
          } catch (err: any) {
            return { error: `获取工作线程失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_session_tasks',
        description: '查看指定会话的任务列表。需要先用 gc_session_threads 或 gc_sessions 查看 sessionId。返回每个任务的标题和状态（completed/in_progress/pending）。',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: '工作空间 ID，如 programming-helper' },
            sessionId: { type: 'string', description: '会话 ID' },
          },
          required: ['agentId', 'sessionId'],
        },
        execute: async (args: any) => {
          const { agentId, sessionId } = args || {};
          if (!agentId || !sessionId) {
            return { error: 'agentId 和 sessionId 都是必填项' };
          }
          try {
            const data = await this.apiGet(
              `/protoclaw/gc/session_tasks?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`
            );
            const tasks = data.tasks || [];
            const summary = data.summary || {};
            const statusIcons: Record<string, string> = {
              completed: '✓',
              in_progress: '◐',
              pending: '○',
              deleted: '✗',
            };
            const lines = tasks.map((t: any) => {
              const icon = statusIcons[t.status] || '?';
              return `  ${icon} ${t.subject || '(未命名)'}`;
            });
            const header = tasks.length > 0
              ? `会话 ${sessionId} 的任务 (${summary.completed || 0}/${summary.total || 0} 完成)：`
              : `会话 ${sessionId} 尚未建立 Task。`;
            const context = data.contextUsage
              ? `上下文: ${data.contextUsage.percent || 0}% (${this.formatNumber(data.contextUsage.usedTokens || 0)}/${this.formatNumber(data.contextUsage.contextLength || 0)})`
              : '上下文: 未知';
            const latest = String(data.latestMessage?.text || '').replace(/\s+/g, ' ').trim();
            return {
              success: true,
              text: [header, ...lines, context, ...(latest ? [`最近消息: ${latest}`] : [])].join('\n'),
              tasks,
              summary,
              contextUsage: data.contextUsage || null,
              latestMessage: data.latestMessage || null,
            };
          } catch (err: any) {
            return { error: `获取任务列表失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_session_summary',
        description: '查看指定会话的摘要信息（标题、创建时间、项目目录等）。',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: '工作空间 ID，如 programming-helper' },
            sessionId: { type: 'string', description: '会话 ID' },
          },
          required: ['agentId', 'sessionId'],
        },
        execute: async (args: any) => {
          const { agentId, sessionId } = args || {};
          if (!agentId || !sessionId) {
            return { error: 'agentId 和 sessionId 都是必填项' };
          }
          try {
            const data = await this.apiGet(
              `/protoclaw/gc/session_summary?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`
            );
            const lines = [
              `标题: ${data.title || '(未命名)'}`,
              `创建: ${data.createdAt ? new Date(data.createdAt).toLocaleString('zh-CN') : '未知'}`,
              `更新: ${data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-CN') : '未知'}`,
              `项目目录: ${data.openDirectory || '未设置'}`,
              `类型: ${data.sessionType || 'normal'}`,
            ];
            return { success: true, text: lines.join('\n'), session: data };
          } catch (err: any) {
            return { error: `获取会话摘要失败: ${err.message || err}` };
          }
        },
      },
      {
        name: 'gc_stop',
        description: '主动结束本轮对话。当你已完成所有必要的回复、派发或操作，确认无需再进行任何后续动作时，调用此工具。调用后会立即结束当前会话轮次，不会继续执行下一步。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          this.stopRequested = true;
          return { success: true, text: '本轮对话即将结束。' };
        },
      },
    ];
  }
}
