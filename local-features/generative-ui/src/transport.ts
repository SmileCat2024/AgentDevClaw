/**
 * HttpSurfaceTransport — Agent → Claw Server 的 HTTP 传输层
 *
 * 通过 fetch 调用 Claw Server 的 Surface API。
 * 可替换为假 Transport 用于测试。
 */

import type {
  UISurfaceUpsertInput,
  UISurfaceRecord,
  UISurfaceSummary,
  CloseResult,
  SurfaceTransport,
} from './types.js';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';

const DEFAULT_TIMEOUT_MS = 5000;

export class HttpSurfaceTransport implements SurfaceTransport {
  private origin: string;

  constructor(origin: string) {
    this.origin = origin.replace(/\/+$/, '');
  }

  private async _fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    // 组合外部 signal
    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    try {
      return await fetch(`${this.origin}${path}`, {
        ...init,
        headers: internalAuthHeaders((init.headers as Record<string, string>) || {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async upsert(agentId: string, input: UISurfaceUpsertInput, signal?: AbortSignal): Promise<UISurfaceRecord> {
    const { surfaceId, spec, expectedRevision, presentation } = input;

    const res = await this._fetch(
      `/protoclaw/agents/${encodeURIComponent(agentId)}/ui-surfaces/${encodeURIComponent(surfaceId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, expectedRevision, presentation }),
      },
      signal,
    );

    const data = await res.json();

    if (!data.ok) {
      const err = new Error(data.message || `upsert failed: ${data.code}`);
      (err as any).code = data.code;
      (err as any).statusCode = res.status;
      throw err;
    }

    // 返回完整 record 需要再 GET
    // 但 PUT 返回的是摘要，为了省一次请求，用返回的信息 + input 构造一个轻量 record
    return {
      agentId,
      surfaceId: data.surface.surfaceId,
      revision: data.surface.revision,
      status: data.surface.status,
      spec,
      contentHash: '',
      createdAt: 0,
      updatedAt: Date.now(),
      presentation: { open: presentation?.open || 'if-empty' },
    };
  }

  async get(agentId: string, surfaceId: string, signal?: AbortSignal): Promise<UISurfaceRecord | null> {
    const res = await this._fetch(
      `/protoclaw/agents/${encodeURIComponent(agentId)}/ui-surfaces/${encodeURIComponent(surfaceId)}`,
      { method: 'GET' },
      signal,
    );

    if (res.status === 404) return null;

    const data = await res.json();

    if (!data.ok) {
      const err = new Error(data.message || `get failed: ${data.code}`);
      (err as any).code = data.code;
      throw err;
    }

    return {
      agentId,
      surfaceId: data.surface.surfaceId,
      revision: data.surface.revision,
      status: data.surface.status,
      spec: data.surface.spec,
      contentHash: '',
      createdAt: 0,
      updatedAt: data.surface.updatedAt,
      presentation: { open: 'if-empty' },
    };
  }

  async list(agentId: string, signal?: AbortSignal): Promise<UISurfaceSummary[]> {
    const res = await this._fetch(
      `/protoclaw/agents/${encodeURIComponent(agentId)}/ui-surfaces`,
      { method: 'GET' },
      signal,
    );

    const data = await res.json();
    return data.surfaces || [];
  }

  async close(agentId: string, surfaceId: string, expectedRevision?: number, signal?: AbortSignal): Promise<CloseResult> {
    const query = expectedRevision !== undefined ? `?expectedRevision=${expectedRevision}` : '';
    const res = await this._fetch(
      `/protoclaw/agents/${encodeURIComponent(agentId)}/ui-surfaces/${encodeURIComponent(surfaceId)}${query}`,
      { method: 'DELETE' },
      signal,
    );

    const data = await res.json();

    if (!data.ok) {
      const err = new Error(data.message || `close failed: ${data.code}`);
      (err as any).code = data.code;
      throw err;
    }

    return {
      ok: true,
      alreadyClosed: data.alreadyClosed || false,
      surfaceId,
    };
  }
}
