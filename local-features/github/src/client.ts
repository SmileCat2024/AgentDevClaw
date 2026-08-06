/**
 * GitHub API Client — 封装 REST v3 和 GraphQL v4 调用
 *
 * 所有请求通过单一 client 出口，统一注入认证头、处理 rate limit 和错误格式化。
 * 不依赖任何外部 SDK，仅使用全局 fetch。
 */

const DEFAULT_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubClientConfig {
  token: string;
  apiBaseUrl?: string;
}

export class GitHubClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly graphqlUrl: string;

  constructor(config: GitHubClientConfig) {
    this.token = config.token;
    const base = (config.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, '');
    this.apiBase = base;
    this.graphqlUrl = base === DEFAULT_API_BASE
      ? 'https://api.github.com/graphql'
      : `${base}/graphql`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...extra,
    };
  }

  // ── REST v3 ──────────────────────────────────────────────

  async get<T = any>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.request<T>('GET', url);
  }

  async post<T = any>(path: string, body?: unknown): Promise<T> {
    const url = this.apiBase + path;
    return this.request<T>('POST', url, body);
  }

  async patch<T = any>(path: string, body?: unknown): Promise<T> {
    const url = this.apiBase + path;
    return this.request<T>('PATCH', url, body);
  }

  async put<T = any>(path: string, body?: unknown): Promise<T> {
    const url = this.apiBase + path;
    return this.request<T>('PUT', url, body);
  }

  async delete<T = any>(path: string): Promise<T> {
    const url = this.apiBase + path;
    return this.request<T>('DELETE', url);
  }

  /**
   * 获取非 JSON 响应（如 Actions job logs），跟随重定向，返回纯文本。
   */
  async fetchRawText(path: string): Promise<string> {
    const resp = await fetch(this.apiBase + path, {
      headers: this.headers(),
      redirect: 'follow',
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`GitHub API ${resp.status}: ${body.slice(0, 500)}`);
    }
    return resp.text();
  }

  // ── GraphQL v4 ───────────────────────────────────────────

  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const resp = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });

    const data = await resp.json() as any;

    if (!resp.ok) {
      throw this.formatHttpError(resp, data);
    }

    if (data.errors && data.errors.length > 0) {
      const messages = data.errors.map((e: any) => e.message).join('; ');
      throw new Error(`GitHub GraphQL errors: ${messages}`);
    }

    return data.data as T;
  }

  // ── 内部方法 ─────────────────────────────────────────────

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const base = this.apiBase + path;
    if (!params) return base;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const resp = await fetch(url, init);

    // 204 No Content
    if (resp.status === 204) return undefined as T;

    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      throw this.formatHttpError(resp, data);
    }

    return data as T;
  }

  private formatHttpError(resp: Response, data: any): Error {
    const remaining = resp.headers.get('x-ratelimit-remaining');
    const reset = resp.headers.get('x-ratelimit-reset');

    if (resp.status === 401 || resp.status === 403) {
      if (remaining === '0') {
        const resetSec = reset ? parseInt(reset, 10) : 0;
        const resetTime = resetSec ? new Date(resetSec * 1000).toLocaleTimeString() : 'unknown';
        return new Error(`GitHub API rate limit exceeded. Resets at ${resetTime}.`);
      }
      if (resp.status === 401) {
        return new Error('GitHub authentication failed. Check your token or run "gh auth login".');
      }
      const msg = data?.message || 'Forbidden';
      return new Error(`GitHub API 403: ${msg}`);
    }

    if (resp.status === 404) {
      return new Error(`GitHub API 404: Not found — ${data?.message || 'the requested resource does not exist or you lack permission.'}`);
    }

    const msg = data?.message || resp.statusText;
    const errors = data?.errors;
    const detail = errors
      ? Array.isArray(errors)
        ? errors.map((e: any) => typeof e === 'string' ? e : e.message || JSON.stringify(e)).join('; ')
        : JSON.stringify(errors)
      : '';
    return new Error(`GitHub API ${resp.status}: ${msg}${detail ? ` (${detail})` : ''}`);
  }
}
