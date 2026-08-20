/**
 * 无头模式会话事件渲染器
 *
 * 供 run-plain-agent.js / run-one-shot-agent.js 共用，把框架会话事件流
 * （session-events，codex exec 风格）渲染为两种输出形态：
 *
 * - JSONL：每行一个 JSON 事件写 stdout（机器消费，管道安全）
 * - human：codex exec 风格的人类可读行写 stderr（给人看）
 *
 * 对齐 codex exec 的输出契约：human 模式下过程信息（reasoning、工具执行、
 * 回复）全部走 stderr，stdout 保持干净；JSONL 模式下 stdout 只承载事件流。
 */

import { subscribeSessionEvents, emitSessionEvent } from 'agentdev';

/**
 * 订阅会话事件流并渲染输出。
 *
 * @param {object} options
 * @param {'jsonl'|'human'} options.format jsonl 写 stdout；human 写 stderr
 * @param {string} options.threadId thread.started 使用的线程标识（sessionId）
 * @param {object} [options.streams] 可注入的输出流（默认 process.stdout/stderr）
 * @returns {() => void} 退订函数
 */
// 工具结果在 JSONL 事件里的截断上限。事件流是推送渠道不是全量存储：
// 完整结果已在会话落盘（thread.started 的 threadId 即 sessionId，可回查），
// stdout 只承载摘要，避免 read 等大结果工具把管道刷成几 MB。
const JSONL_RESULT_LIMIT = 1000;

/**
 * 截断 JSONL 事件中的工具结果，超限时替换为 preview 并标记。
 * @param {import('agentdev').SessionEvent} event
 * @returns {import('agentdev').SessionEvent}
 */
export function formatSessionEventJsonl(event) {
  return truncateEventForJsonl(event);
}

function truncateEventForJsonl(event) {
  if (event.type !== 'item.completed' || event.item.type !== 'tool_call') return event;
  const item = event.item;
  if (typeof item.result === 'string' && item.result.length > JSONL_RESULT_LIMIT) {
    return {
      ...event,
      item: {
        ...item,
        result: item.result.slice(0, JSONL_RESULT_LIMIT),
        resultTruncated: true,
        fullLength: item.result.length,
      },
    };
  }
  return event;
}

export function attachSessionEventOutput({ format, threadId, streams }) {
  const stdout = streams?.stdout ?? process.stdout;
  const stderr = streams?.stderr ?? process.stderr;

  const writeJsonl = (event) => {
    stdout.write(JSON.stringify(truncateEventForJsonl(event)) + '\n');
  };

  const unsubscribe = subscribeSessionEvents((event) => {
    if (format === 'jsonl') {
      writeJsonl(event);
    } else {
      for (const line of renderSessionEventHuman(event)) {
        stderr.write(line + '\n');
      }
    }
  });

  emitSessionEvent({ type: 'thread.started', threadId });
  if (format === 'jsonl') {
    // thread.started 已通过订阅者写出；human 模式不渲染 thread 级事件
  } else {
    stderr.write(`session: ${threadId}\n`);
  }

  return unsubscribe;
}

/**
 * 发射致命错误事件（装配失败等框架事件流覆盖不到的场景）。
 * @param {string} message
 */
export function emitFatalSessionError(message) {
  emitSessionEvent({ type: 'error', message });
}

/**
 * 把单个会话事件渲染为 human 可读行（无 ANSI 转义，纯文本）。
 * 风格对齐 codex exec：reasoning 淡化、工具带状态、回复以 agent: 开头。
 * @param {import('agentdev').SessionEvent} event
 * @returns {string[]}
 */
export function renderSessionEventHuman(event) {
  switch (event.type) {
    case 'turn.started':
      return [];
    case 'turn.completed': {
      const usage = event.usage;
      return usage
        ? [`tokens: input=${usage.inputTokens} output=${usage.outputTokens}`]
        : [];
    }
    case 'turn.cancelled': {
      // 生命周期信号（guard 轮换 / 宿主中断），非执行失败
      const reason = event.error?.message || event.error?.reason || 'interrupted';
      return [`cancelled: ${reason}`];
    }
    case 'turn.failed': {
      // error: TurnFailure { message, reason?, category?, statusCode?, retryable? }
      const parts = ['failed:'];
      if (event.error.reason) parts.push(`[${event.error.reason}]`);
      if (event.error.category) parts.push(`(${event.error.category}${event.error.retryable ? ', retryable' : ''})`);
      parts.push(event.error.message);
      return [parts.join(' ')];
    }
    case 'error':
      return [`error: ${event.message}`];
    case 'item.started': {
      if (event.item.type === 'tool_call') {
        const argsPreview = formatArgumentsPreview(event.item.arguments);
        return [`tool: ${event.item.tool}${argsPreview ? ` ${argsPreview}` : ''}`];
      }
      return [];
    }
    case 'item.completed': {
      const item = event.item;
      if (item.type === 'reasoning') {
        return indentLines(item.text, '  ');
      }
      if (item.type === 'agent_message') {
        return ['', `agent:`, ...indentLines(item.text, '  ')];
      }
      if (item.type === 'tool_call') {
        if (item.status === 'completed') {
          const preview = formatResultPreview(item.result);
          return preview ? [`  succeeded: ${preview}`] : ['  succeeded'];
        }
        return [`  failed: ${item.error ?? 'unknown error'}`];
      }
      return [];
    }
    default:
      return [];
  }
}

function indentLines(text, prefix) {
  const trimmed = String(text ?? '').trimEnd();
  if (!trimmed) return [];
  return trimmed.split('\n').map((line) => prefix + line);
}

function formatArgumentsPreview(args) {
  if (args === undefined || args === null) return '';
  try {
    const json = typeof args === 'string' ? args : JSON.stringify(args);
    const oneLine = String(json).replace(/\s+/g, ' ');
    return oneLine.length > 80 ? oneLine.slice(0, 77) + '...' : oneLine;
  } catch {
    return '';
  }
}

function formatResultPreview(result) {
  if (result === undefined || result === null) return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > 120 ? oneLine.slice(0, 117) + '...' : oneLine;
}
