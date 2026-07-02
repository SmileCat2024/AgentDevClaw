/**
 * GroupChatBridgeFeature - 群聊桥接 Feature
 *
 * 完全照搬 ClawDispatchFeature 的双模式注入 + CallFinish piggyback 机制，
 * 换成群聊语义：
 *
 * - 轮询 /protoclaw/gc/inbox 获取群聊派发的消息
 * - Agent 空闲时通过 CallArbiter 起新 call 执行
 * - Agent 忙时 buffer，@StepStart 注入为 system-reminder
 * - @CallFinish 时取 ctx.response，POST /protoclaw/gc/writeback 写回群聊
 */

import type { AgentFeature } from 'agentdev';
import { CallStart, CallFinish, StepStart } from 'agentdev';

interface GcMessage {
  id: string;
  text: string;
  contextText?: string | null;
  gcChatId: string;
  gcIdentityRef: string;
  attachments?: Array<{ name: string; content: string }>;
  /** text 的内容是否已包含在 contextText（catch-up）中。
   *  非 @admin 直达场景为 true（catch-up 含触发消息），@admin 直达为 false。
   *  busy 路径据此决定是否跳过 text 注入。 */
  textInCatchUp?: boolean;
}

export class GroupChatBridgeFeature implements AgentFeature {
  readonly name = 'group-chat-bridge';

  private agentRef: any = null;
  private arbiterRef: any = null;
  private abortController = new AbortController();
  private started = false;

  // ── Step 级注入状态 ──
  private callActive = false;
  private pendingBuffer: GcMessage[] = [];
  private injectedThisCall: GcMessage[] = [];

  // ── 空闲时收到消息的上下文前缀（群记忆 / catch-up）──
  // 在 CallStart 时注入为 system-reminder，不混入用户消息
  private pendingContext: string | null = null;

  // ── 待注入的附件列表 ──
  // 在 CallStart 时作为独立的 system-reminder 块注入
  private pendingAttachments: Array<{ name: string; content: string }> = [];

  // ── 消息去重 ──
  private processedIds = new Set<string>();

  // ── 管理员模式：不自动 writeback，需要显式 gc_reply ──
  private suppressAutoWriteback = false;

  async onDestroy(): Promise<void> {
    this.abortController.abort();
  }

  // ========== Hooks ==========

  @CallStart
  async onCallStartHook(ctx: any): Promise<void> {
    this.callActive = true;
    this.injectedThisCall = [];

    // 空闲路径下收到的上下文（群记忆 / catch-up）在 CallStart 注入，
    // 出现在用户消息之前，让 agent 以 system 消息形式感知环境背景。
    if (this.pendingContext && ctx?.context) {
      ctx.context.add({
        role: 'system',
        content: this.pendingContext,
      });
      console.log('[GroupChatBridge] injected context at CallStart');
      this.pendingContext = null;
    }

    // 注入待处理的附件作为独立的 system-reminder 块
    if (this.pendingAttachments.length > 0 && ctx?.context) {
      const attachmentContent = this.pendingAttachments
        .map((att) => `--- ${att.name} ---\n${att.content}`)
        .join('\n\n');
      
      ctx.context.add({
        role: 'system',
        content: `附件内容：\n${attachmentContent}`,
      });
      console.log(`[GroupChatBridge] injected ${this.pendingAttachments.length} attachment(s) at CallStart`);
      this.pendingAttachments = [];
    }
  }

  @StepStart
  async onStepStartHook(ctx: any): Promise<void> {
    if (this.pendingBuffer.length === 0 && this.pendingAttachments.length === 0) return;

    const messages = this.pendingBuffer.splice(0);
    const content = messages
      .map((msg) => {
        // busy 路径：注入新的水位线（catch-up system-reminder）
        // 非 @admin 场景：catch-up 已含触发消息完整内容，text 只是事件通知，跳过
        // @admin 直达场景：catch-up 不含触发消息，text 是用户原话，需要保留
        if (msg.contextText) {
          if (msg.textInCatchUp) {
            return msg.contextText;
          }
          return msg.contextText + '\n\n' + msg.text;
        }
        return msg.text;
      })
      .join('\n\n');

    // 注入消息内容
    if (content) {
      ctx.context.add({
        role: 'system',
        content,
      });
      this.injectedThisCall.push(...messages);
      console.log(
        `[GroupChatBridge] injected ${messages.length} message(s) at step ${ctx.step}`,
      );
    }

    // 注入附件作为独立的 system 块
    if (this.pendingAttachments.length > 0 && ctx?.context) {
      const attachmentContent = this.pendingAttachments
        .map((att) => `--- ${att.name} ---\n${att.content}`)
        .join('\n\n');
      
      ctx.context.add({
        role: 'system',
        content: `附件内容：\n${attachmentContent}`,
      });
      console.log(`[GroupChatBridge] injected ${this.pendingAttachments.length} attachment(s) at step ${ctx.step}`);
      this.pendingAttachments = [];
    }
  }

  @CallFinish
  async onCallFinishHook(ctx: any): Promise<void> {
    this.callActive = false;

    const serverOrigin =
      process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';

    // 管理员模式：不自动 writeback
    if (!this.suppressAutoWriteback) {
      const response: string = ctx.response || '';

      // Piggyback：用本轮 call 的最终 response 回写所有已注入的消息
      for (const msg of this.injectedThisCall) {
        console.log(`[GroupChatBridge] piggyback writeback for ${msg.id}`);
        await this.postWriteback(serverOrigin, msg, response, null);
      }
    } else {
      console.log('[GroupChatBridge] suppressAutoWriteback: skipping writeback');
    }
    this.injectedThisCall = [];

    // Buffer 中残留的消息 → fallback 到 arbiter
    const leftover = this.pendingBuffer.splice(0);
    for (const msg of leftover) {
      this.dispatchViaArbiter(msg, serverOrigin).catch((err) => {
        console.error(`[GroupChatBridge] leftover dispatch failed for ${msg.id}:`, err);
      });
    }
  }

  // ========== Polling ==========

  async startBridgeLoop(agent: any, arbiter?: any): Promise<void> {
    if (this.started) return;
    this.agentRef = agent;
    this.arbiterRef = arbiter || null;
    this.started = true;

    // 管理员 agent 不自动 writeback —— 需要显式调用 gc_reply 工具
    const agentId = process.env.PROTOCLAW_PREBUILT_AGENT_ID || '';
    this.suppressAutoWriteback = agentId === 'work-group';

    this.runLoop().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error('[GroupChatBridge] loop crashed:', err);
      }
    });
  }

  private async runLoop(): Promise<void> {
    const serverOrigin =
      process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    const agentId = process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'unknown';
    const sessionId = process.env.PROTOCLAW_PREBUILT_SESSION_ID || '';

    console.log(
      `[GroupChatBridge] polling as agentId=${agentId}, sessionId=${sessionId || '(none)'}`,
    );
    while (!this.abortController.signal.aborted) {
      try {
        const params = new URLSearchParams({ agentId, timeout: '25' });
        if (sessionId) params.set('sessionId', sessionId);
        const url = `${serverOrigin}/protoclaw/gc/inbox?${params.toString()}`;
        const response = await fetch(url, {
          signal: this.abortController.signal,
        });

        if (response.status === 200) {
          const msg: GcMessage = await response.json();
          if (msg && msg.text) {
            // 去重：跳过已处理的消息
            if (this.processedIds.has(msg.id)) {
              continue;
            }
            this.processedIds.add(msg.id);
            // 防止 Set 无限增长：保留最近 200 条
            if (this.processedIds.size > 200) {
              const first = this.processedIds.values().next().value;
              if (first) this.processedIds.delete(first);
            }
            await this.handleMessage(msg, serverOrigin);
          }
        } else if (response.status === 204) {
          // no message, continue polling
        }
      } catch (err: any) {
        if (this.abortController.signal.aborted) break;
        await this.sleep(3000);
      }
    }
  }

  private async handleMessage(
    msg: GcMessage,
    serverOrigin: string,
  ): Promise<void> {
    if (this.callActive) {
      // 活跃 call 期间 → 缓存，等 @StepStart 注入
      this.pendingBuffer.push(msg);
      console.log(
        `[GroupChatBridge] buffered for step injection: ${msg.id} (${msg.text.slice(0, 40)}...)`,
      );
      return;
    }

    // 空闲 → 分离上下文，存储待 CallStart 注入为 system-reminder
    if (msg.contextText) {
      this.pendingContext = msg.contextText;
    }
    
    // 处理附件：将附件添加到待注入列表
    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      this.pendingAttachments.push(...msg.attachments);
      console.log(`[GroupChatBridge] queued ${msg.attachments.length} attachment(s) for injection`);
    }
    
    console.log(`[GroupChatBridge] idle, dispatching via arbiter: ${msg.id}`);
    await this.dispatchViaArbiter(msg, serverOrigin);
  }

  // ========== Arbiter fallback（空闲时起新 call）==========

  private async dispatchViaArbiter(
    msg: GcMessage,
    serverOrigin: string,
  ): Promise<void> {
    try {
      let result = '';
      let error: string | null = null;

      if (this.arbiterRef && typeof this.arbiterRef.enqueue === 'function') {
        const entry = this.arbiterRef.enqueue({
          source: 'group-chat',
          sourceRef: msg.id,
          text: msg.text,
        });
        const finished = await this.arbiterRef.waitForCompletion(entry.id);
        result = finished.result || '';
        if (finished.status === 'failed') {
          error = finished.error || 'unknown error';
        }
      } else {
        console.warn(
          '[GroupChatBridge] no arbiter available, falling back to direct onCall',
        );
        const onCallResult = await this.agentRef.onCall(msg.text);
        result = typeof onCallResult === 'string' ? onCallResult : '';
      }

      if (error) {
        console.error(
          `[GroupChatBridge] arbiter call failed for ${msg.id}: ${error}`,
        );
        // 中断时不额外回写：模型自身会返回中断通知
        if (!this.isInterruptError(error) && !this.suppressAutoWriteback) {
          await this.postWriteback(serverOrigin, msg, null, error);
        }
      } else {
        console.log(`[GroupChatBridge] arbiter call completed for ${msg.id}`);
        if (!this.suppressAutoWriteback) {
          await this.postWriteback(serverOrigin, msg, result, null);
        }
      }
    } catch (err) {
      console.error('[GroupChatBridge] dispatchViaArbiter error:', err);
      // 中断时不额外回写：模型自身会返回中断通知
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!this.isInterruptError(errMsg) && !this.suppressAutoWriteback) {
        await this.postWriteback(serverOrigin, msg, null, errMsg);
      }
    }
  }

  /**
   * 检测是否为中断错误。
   */
  private isInterruptError(error: string): boolean {
    return error.includes('Interrupted by user') ||
           error.includes('interrupt') ||
           error.includes('aborted');
  }

  // ========== HTTP helpers ==========

  private async postWriteback(
    serverOrigin: string,
    msg: GcMessage,
    response: string | null,
    error: string | null,
  ): Promise<void> {
    const payload: any = {
      chatId: msg.gcChatId,
      identityRef: msg.gcIdentityRef,
      sessionId: process.env.PROTOCLAW_PREBUILT_SESSION_ID || '',
    };
    if (error) {
      payload.error = error;
    } else {
      payload.response = response || '';
    }
    await fetch(`${serverOrigin}/protoclaw/gc/writeback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error('[GroupChatBridge] failed to post writeback:', err);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
