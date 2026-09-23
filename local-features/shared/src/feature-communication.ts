import { internalAuthHeaders } from './internal-auth.js';

export interface FeatureCommunicationTarget {
  agentId: string;
  sessionId: string;
  featureId: string;
  channelId: string;
}

export class FeatureCommunicationClient {
  constructor(private readonly serverOrigin: string, private readonly target: FeatureCommunicationTarget) {}

  private async post(path: string, body: unknown): Promise<Record<string, any>> {
    const origin = this.serverOrigin.endsWith('/') ? this.serverOrigin.slice(0, -1) : this.serverOrigin;
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      throw Object.assign(new Error(payload?.error || payload?.code || `HTTP ${response.status}`), { code: payload?.code, status: response.status });
    }
    return payload;
  }

  publishSnapshot(data: unknown): Promise<Record<string, any>> {
    return this.post('/protoclaw/feature-comms/publish', { ...this.target, kind: 'snapshot', data });
  }

  publishEvent(eventType: string, data: unknown): Promise<Record<string, any>> {
    return this.post('/protoclaw/feature-comms/publish', { ...this.target, kind: 'event', eventType, data });
  }

}
