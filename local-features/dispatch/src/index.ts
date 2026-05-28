/**
 * ClawDispatchFeature - Agent 侧调度消息接收器
 *
 * 长轮询 Claw server 取调度消息，收到后调用 agent.onCall(text)，
 * 结果 POST 回 Claw。模式与 WeixinBot 一致。
 */

import type { AgentFeature } from 'agentdev';

interface DispatchMessage {
  id: string;
  scheduleId?: string;
  text: string;
}

export class ClawDispatchFeature implements AgentFeature {
  readonly name = 'claw-dispatch';

  private agentRef: any = null;
  private abortController = new AbortController();
  private processingLock = Promise.resolve();
  private started = false;

  async onDestroy(): Promise<void> {
    this.abortController.abort();
  }

  async startDispatchLoop(agent: any): Promise<void> {
    if (this.started) return;
    this.agentRef = agent;
    this.started = true;
    this.runLoop().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error('[ClawDispatch] loop crashed:', err);
      }
    });
  }

  private async runLoop(): Promise<void> {
    const serverOrigin = process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    const agentId = process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'unknown';
    const sessionId = process.env.PROTOCLAW_PREBUILT_SESSION_ID || '';

    console.log(`[ClawDispatch] polling as agentId=${agentId}, sessionId=${sessionId || '(none)'}`);
    while (!this.abortController.signal.aborted) {
      try {
        const params = new URLSearchParams({ agentId, timeout: '25' });
        if (sessionId) params.set('sessionId', sessionId);
        const url = `${serverOrigin}/protoclaw/dispatch/poll?${params.toString()}`;
        const response = await fetch(url, { signal: this.abortController.signal });

        if (response.status === 200) {
          const msg: DispatchMessage = await response.json();
          if (msg && msg.text) {
            await this.processingLock;
            this.processingLock = this.handleMessage(msg, serverOrigin);
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

  private async handleMessage(msg: DispatchMessage, serverOrigin: string): Promise<void> {
    try {
      console.log(`[ClawDispatch] received dispatch: ${msg.id} (${msg.text.slice(0, 40)}...)`);
      const result = await this.agentRef.onCall(msg.text);
      console.log(`[ClawDispatch] onCall completed for ${msg.id}`);

      await fetch(`${serverOrigin}/protoclaw/dispatch/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: msg.id,
          scheduleId: msg.scheduleId || null,
          response: typeof result === 'string' ? result : '',
        }),
      }).catch((err) => {
        console.error('[ClawDispatch] failed to post response:', err);
      });
    } catch (err) {
      console.error('[ClawDispatch] onCall error:', err);
      await fetch(`${serverOrigin}/protoclaw/dispatch/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: msg.id,
          scheduleId: msg.scheduleId || null,
          error: err instanceof Error ? err.message : String(err),
        }),
      }).catch(() => {});
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
