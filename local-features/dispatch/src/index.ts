/**
 * ClawDispatchFeature - Agent 侧调度消息接收器
 *
 * 长轮询 Claw server 取调度消息，收到后通过 CallArbiter 入队执行，
 * 等待完成后将结果 POST 回 Claw。
 *
 * 不再直接调用 agent.onCall()，所有调用通过 arbiter 串行化。
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
  private arbiterRef: any = null;
  private abortController = new AbortController();
  private started = false;

  async onDestroy(): Promise<void> {
    this.abortController.abort();
  }

  async startDispatchLoop(agent: any, arbiter?: any): Promise<void> {
    if (this.started) return;
    this.agentRef = agent;
    this.arbiterRef = arbiter || null;
    this.started = true;
    // Report initial idle status so on-idle triggers can fire immediately
    const serverOrigin = process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    await this.reportStatus(serverOrigin, 'idle');
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

  private async handleMessage(msg: DispatchMessage, serverOrigin: string): Promise<void> {
    console.log(`[ClawDispatch] received dispatch: ${msg.id} (${msg.text.slice(0, 40)}...)`);

    try {
      let result = '';
      let error: string | null = null;

      if (this.arbiterRef && typeof this.arbiterRef.enqueue === 'function') {
        // Route through CallArbiter — serialized with all other call sources
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
        // Fallback: direct onCall (legacy path when arbiter not available)
        console.warn('[ClawDispatch] no arbiter available, falling back to direct onCall');
        const onCallResult = await this.agentRef.onCall(msg.text);
        result = typeof onCallResult === 'string' ? onCallResult : '';
      }

      if (error) {
        console.error(`[ClawDispatch] arbiter call failed for ${msg.id}: ${error}`);
        await this.postRespond(serverOrigin, msg, null, error);
      } else {
        console.log(`[ClawDispatch] arbiter call completed for ${msg.id}`);
        await this.postRespond(serverOrigin, msg, result, null);
      }

      // Report idle status for event-driven triggers
      await this.reportStatus(serverOrigin, 'idle');
    } catch (err) {
      console.error('[ClawDispatch] handleMessage error:', err);
      await this.postRespond(serverOrigin, msg, null, err instanceof Error ? err.message : String(err));
    }
  }

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

  private async reportStatus(serverOrigin: string, status: string): Promise<void> {
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
      this.abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
