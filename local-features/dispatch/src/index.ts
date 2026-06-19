/**
 * ClawDispatchFeature - Agent 侧调度消息接收器
 *
 * 长轮询 Claw server 取调度消息，支持两种注入模式：
 *
 * 1. Step 级注入（活跃 call 期间）：
 *    消息缓存到内部 buffer，在 @StepStart 时以 system-reminder 注入到当前 context。
 *    @CallFinish 时用本轮 call 的最终 response 顺带给 Claw server 回报。
 *
 * 2. Call 级注入（空闲时 fallback）：
 *    Agent 无活跃 call 时，通过 CallArbiter 起新 call 执行（兼容旧行为）。
 */

import type { AgentFeature } from 'agentdev';
import { CallStart, CallFinish, StepStart } from 'agentdev';

interface DispatchMessage {
  id: string;
  scheduleId?: string;
  text: string;
}

export class ClawDispatchFeature implements AgentFeature {
  readonly name = 'claw-dispatch';

  private agentRef: any = null;
  private arbiterRef: any = null;
  private abortController = new AbortController();
  private started = false;

  // ── Step 级注入状态 ──
  private callActive = false;
  private pendingBuffer: DispatchMessage[] = [];
  private injectedThisCall: DispatchMessage[] = [];

  async onDestroy(): Promise<void> {
    this.abortController.abort();
  }

  // ========== Hooks ==========

  @CallStart
  async onCallStartHook(): Promise<void> {
    this.callActive = true;
    this.injectedThisCall = [];
  }

  @StepStart
  async onStepStartHook(ctx: any): Promise<void> {
    if (this.pendingBuffer.length === 0) return;

    const messages = this.pendingBuffer.splice(0);
    const content = messages
      .map((msg) => msg.text)
      .join('\n\n');

    ctx.context.add({
      role: 'system',
      content: `<system-reminder>\n${content}\n</system-reminder>`,
    });

    this.injectedThisCall.push(...messages);
    console.log(
      `[ClawDispatch] injected ${messages.length} dispatch message(s) at step ${ctx.step}`,
    );
  }

  @CallFinish
  async onCallFinishHook(ctx: any): Promise<void> {
    this.callActive = false;

    const serverOrigin =
      process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    const response: string = ctx.response || '';

    // Piggyback：用本轮 call 的最终 response 回报所有已注入的消息
    for (const msg of this.injectedThisCall) {
      console.log(`[ClawDispatch] piggyback respond for ${msg.id}`);
      await this.postRespond(serverOrigin, msg, response, null);
    }
    this.injectedThisCall = [];

    // Buffer 中残留的消息（call 结束前来不及注入）→ fallback 到 arbiter
    const leftover = this.pendingBuffer.splice(0);
    for (const msg of leftover) {
      this.dispatchViaArbiter(msg, serverOrigin).catch((err) => {
        console.error(`[ClawDispatch] leftover dispatch failed for ${msg.id}:`, err);
      });
    }

    await this.reportStatus(serverOrigin, 'idle');
  }

  // ========== Polling ==========

  async startDispatchLoop(agent: any, arbiter?: any): Promise<void> {
    if (this.started) return;
    this.agentRef = agent;
    this.arbiterRef = arbiter || null;
    this.started = true;
    // Report initial idle status so on-idle triggers can fire immediately
    const serverOrigin =
      process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    await this.reportStatus(serverOrigin, 'idle');
    this.runLoop().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error('[ClawDispatch] loop crashed:', err);
      }
    });
  }

  private async runLoop(): Promise<void> {
    const serverOrigin =
      process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    const agentId = process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'unknown';
    const sessionId = process.env.PROTOCLAW_PREBUILT_SESSION_ID || '';

    console.log(
      `[ClawDispatch] polling as agentId=${agentId}, sessionId=${sessionId || '(none)'}`,
    );
    while (!this.abortController.signal.aborted) {
      try {
        const params = new URLSearchParams({ agentId, timeout: '25' });
        if (sessionId) params.set('sessionId', sessionId);
        const url = `${serverOrigin}/protoclaw/dispatch/poll?${params.toString()}`;
        const response = await fetch(url, {
          signal: this.abortController.signal,
        });

        if (response.status === 200) {
          const msg: DispatchMessage = await response.json();
          if (msg && msg.text) {
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
    msg: DispatchMessage,
    serverOrigin: string,
  ): Promise<void> {
    if (this.callActive) {
      // 活跃 call 期间 → 缓存，等 @StepStart 注入
      this.pendingBuffer.push(msg);
      console.log(
        `[ClawDispatch] buffered for step injection: ${msg.id} (${msg.text.slice(0, 40)}...)`,
      );
      return;
    }

    // 空闲 → fallback 到 arbiter（起新 call）
    console.log(`[ClawDispatch] idle, dispatching via arbiter: ${msg.id}`);
    await this.dispatchViaArbiter(msg, serverOrigin);
    await this.reportStatus(serverOrigin, 'idle');
  }

  // ========== Arbiter fallback（空闲时起新 call）==========

  private async dispatchViaArbiter(
    msg: DispatchMessage,
    serverOrigin: string,
  ): Promise<void> {
    try {
      let result = '';
      let error: string | null = null;

      if (this.arbiterRef && typeof this.arbiterRef.enqueue === 'function') {
        const entry = this.arbiterRef.enqueue({
          source: 'dispatch',
          sourceRef: msg.scheduleId || '',
          text: msg.text,
        });
        const finished = await this.arbiterRef.waitForCompletion(entry.id);
        result = finished.result || '';
        if (finished.status === 'failed') {
          error = finished.error || 'unknown error';
        }
      } else {
        console.warn(
          '[ClawDispatch] no arbiter available, falling back to direct onCall',
        );
        const onCallResult = await this.agentRef.onCall(msg.text);
        result = typeof onCallResult === 'string' ? onCallResult : '';
      }

      if (error) {
        console.error(
          `[ClawDispatch] arbiter call failed for ${msg.id}: ${error}`,
        );
        await this.postRespond(serverOrigin, msg, null, error);
      } else {
        console.log(`[ClawDispatch] arbiter call completed for ${msg.id}`);
        await this.postRespond(serverOrigin, msg, result, null);
      }
    } catch (err) {
      console.error('[ClawDispatch] dispatchViaArbiter error:', err);
      await this.postRespond(
        serverOrigin,
        msg,
        null,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ========== HTTP helpers ==========

  private async postRespond(
    serverOrigin: string,
    msg: DispatchMessage,
    response: string | null,
    error: string | null,
  ): Promise<void> {
    const payload: any = {
      id: msg.id,
      scheduleId: msg.scheduleId || null,
    };
    if (error) {
      payload.error = error;
    } else {
      payload.response = response || '';
    }
    await fetch(`${serverOrigin}/protoclaw/dispatch/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error('[ClawDispatch] failed to post response:', err);
    });
  }

  private async reportStatus(
    serverOrigin: string,
    status: string,
  ): Promise<void> {
    const agentId = process.env.PROTOCLAW_PREBUILT_AGENT_ID || '';
    const sessionId = process.env.PROTOCLAW_PREBUILT_SESSION_ID || '';
    if (!agentId) return;
    await fetch(`${serverOrigin}/protoclaw/dispatch/agent_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId: sessionId || null, status }),
    }).catch(() => {});
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
