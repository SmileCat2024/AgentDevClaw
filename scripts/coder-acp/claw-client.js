/**
 * Claw HTTP client — adapter 到 Claw server 的唯一通道（ticket 019）
 *
 * 本机 HTTP（默认 http://127.0.0.1:1420，CLAW_ACP_BASE_URL 可配），只依赖
 * 全局 fetch，不依赖 Express / 框架（ADR-0004：adapter 与 server 之间只允许
 * 本机 HTTP 契约）。
 *
 * 消费的端点契约：
 *   POST /protoclaw/acp/coder/sessions                    018 原子创建
 *   POST /protoclaw/acp/coder/sessions/:id/interrupt      018 精确中断
 *   POST /protoclaw/threads/:threadId/commands            prompt 投递（现有）
 *   GET  /protoclaw/threads/:threadId/events?after=N      事件增量读取（现有）
 *
 * 错误归一为两种：
 *   ClawUnreachableError — 网络层失败（server 未启动 / 连接被拒）
 *   ClawHttpError        — server 有响应但状态非 2xx（body 原样保留）
 * 由调用方（session-manager）映射到 ACP 错误 taxonomy。
 */

export class ClawUnreachableError extends Error {
  constructor(cause) {
    super(`cannot reach Claw server: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ClawUnreachableError';
    this.cause = cause;
  }
}

export class ClawHttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {object|null} body 尽力解析的响应体
   */
  constructor(status, body) {
    super(body?.message || `Claw server returned HTTP ${status}`);
    this.name = 'ClawHttpError';
    this.status = status;
    this.body = body;
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function errorFields(error) {
  return {
    errorName: error?.name,
    errorMessage: error?.message,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] 默认 CLAW_ACP_BASE_URL 或 http://127.0.0.1:1420
 * @param {typeof fetch} [options.fetchImpl] 测试注入
 * @param {number} [options.requestTimeoutMs] 单请求超时，默认 10s
 */
export function createClawClient(options = {}) {
  const baseUrl = (options.baseUrl ?? process.env.CLAW_ACP_BASE_URL ?? 'http://127.0.0.1:1420').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const trace = options.trace;

  const describeBody = (body) => {
    if (body === undefined) return undefined;
    if (!trace) return undefined;
    return trace.includeContent
      ? trace.safe(body)
      : { keys: body && typeof body === 'object' ? Object.keys(body) : [], type: typeof body };
  };

  /**
   * @param {string} method
   * @param {string} path
   * @param {object|undefined} body
   * @returns {Promise<{status: number, body: object}>}
   */
  async function requestJson(method, path, body, context = {}) {
    const startedAt = Date.now();
    trace?.record('claw.http.start', {
      ...context,
      method,
      path,
      body: describeBody(body),
    });
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      trace?.record('claw.http.error', {
        ...context,
        method,
        path,
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
        errorCode: 'CLAW_SERVER_UNREACHABLE',
      }, { level: 'error', force: true });
      throw new ClawUnreachableError(error);
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    const httpFields = {
      ...context,
      method,
      path,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      businessErrorCode: parsed?.code,
      errorCode: parsed?.code,
      response: describeBody(parsed),
    };
    trace?.record(response.ok ? 'claw.http.response' : 'claw.http.error', httpFields,
      response.ok ? {} : { level: 'error', force: true });
    if (!response.ok) {
      throw new ClawHttpError(response.status, parsed);
    }
    return { status: response.status, body: parsed ?? {} };
  }

  return {
    baseUrl,

    /** 018 原子创建：{ clawSessionId, threadId, viewerAgentId, cwd } */
    async createCoderSession(cwd, context = {}) {
      const { body } = await requestJson('POST', '/protoclaw/acp/coder/sessions', {
        agentId: 'coder',
        cwd,
      }, { ...context, cwd });
      return body;
    },

    /** prompt 投递（kind 固定 user_message，source 固定 acp）。 */
    async appendUserMessage(threadId, { text, idempotencyKey }, context = {}) {
      const { body } = await requestJson(
        'POST',
        `/protoclaw/threads/${encodeURIComponent(threadId)}/commands`,
        { kind: 'user_message', text, source: 'acp', idempotencyKey },
        { ...context, threadId },
      );
      return body;
    },

    /** 事件增量读取：{ events: [{...event, eventId, receivedAt}], cursor } */
    async getThreadEvents(threadId, after, context = {}) {
      const normalizedAfter = Math.max(0, Number(after) || 0);
      const { body } = await requestJson(
        'GET',
        `/protoclaw/threads/${encodeURIComponent(threadId)}/events?after=${normalizedAfter}`,
        undefined,
        { ...context, threadId, after: normalizedAfter },
      );
      return body;
    },

    /** 018 精确中断。404（runtime 已结束）以 ClawHttpError 形式返回。 */
    async interruptSession(clawSessionId, context = {}) {
      const { body } = await requestJson(
        'POST',
        `/protoclaw/acp/coder/sessions/${encodeURIComponent(clawSessionId)}/interrupt`,
        undefined,
        { ...context, clawSessionId },
      );
      return body;
    },
  };
}
