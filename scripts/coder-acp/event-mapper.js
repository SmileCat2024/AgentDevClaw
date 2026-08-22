/**
 * thread 事件 → ACP session/update 映射（ticket 019，设计 §7）
 *
 * 纯函数模块：输入 thread 事件（GET /protoclaw/threads/:id/events 返回的
 * `{ ...event, eventId, receivedAt }` 形状），输出 ACP SessionUpdate 对象
 * 数组与终态信号。不依赖 SDK / HTTP，由 session-manager 在轮询循环中调用。
 *
 * 映射表：
 *   item.completed(type=agent_message) → agent_message_chunk（整段发送，不切分）
 *   item.completed(type=reasoning)     → agent_thought_chunk（codex-acp 风格，
 *                                        client 渲染 thinking 折叠区）
 *   item.started(type=tool_call)       → tool_call（status: in_progress）
 *   item.completed(type=tool_call)     → tool_call_update（failed→failed 其余→completed）
 *   turn.completed / turn.failed / turn.cancelled → 终态（不产生 update；
 *                                        completed/failed 附带 event.usage 供
 *                                        PromptResponse 使用）
 *   turn.started / thread.started → 不映射
 *   未知事件类型 → 忽略（不产生 update，不报错）
 *
 * 缺失字段规则（设计 §7：runtime 经 reportSessionItemsForTurn 批量写事件，
 * 字段天然不齐）：
 *   - 缺 item.id → 生成稳定 fallback ID `tool:<name>:<turn>:<seq>`（per mapper 递增）
 *   - 只有 completed 没有 started 的 tool → 先补发最小 tool_call（in_progress，
 *     不带 rawInput）再发 tool_call_update
 *   - rawInput / rawOutput 缺失时省略字段，不构造假值；任意字符串不强转结构化 JSON
 *
 * eventId 去重（二线防御，设计 §9.1：防重复不防丢失，权威修复在 017）：
 * 事件携带 eventId 且已在 knownEventIds（基线或本 prompt 已处理）中 → 跳过。
 */

/**
 * kind 最小分类（设计 §7 / Q18）。
 * @param {string} toolName
 * @returns {'execute'|'read'|'edit'|'search'|'other'}
 */
export function classifyToolKind(toolName) {
  const name = String(toolName || '');
  if (['bash', 'shell', 'exec', 'powershell'].includes(name)) return 'execute';
  if (name.startsWith('lsp_') || ['read', 'glob', 'grep'].includes(name)) return 'read';
  if (['write', 'edit'].includes(name)) return 'edit';
  if (name.includes('web') || name.includes('search')) return 'search';
  return 'other';
}

/**
 * 事件顶层 turn 提取（turn.* 事件在顶层；item.* 事件在 item 内）。
 * @param {object} event
 * @returns {number}
 */
function eventTurn(event) {
  if (typeof event?.turn === 'number') return event.turn;
  if (typeof event?.item?.turn === 'number') return event.item.turn;
  return 0;
}

/**
 * 创建一个 prompt 生命周期的映射上下文。
 *
 * @param {Iterable<string>} baselineKnownEventIds prompt 投递前已存在的事件
 *   eventId 集合（设计 §9.3 基线排除主判定）
 */
export function createPromptEventMapper(baselineKnownEventIds = []) {
  const knownEventIds = new Set(baselineKnownEventIds);
  const seenToolCallIds = new Set();
  /**
   * 稳定 fallback ID（设计 §7）：`tool:<name>:<turn>:<seq>`，seq 按
   * (name, turn) 计数。completed 无 id 时复用该 (name, turn) 最近分配的
   * seq——同 turn 同名工具串行执行，最近的即本次调用，使 started /
   * completed 在缺失 id 时仍能配对（先补发的最小 tool_call 亦同）。
   */
  const fallbackCounters = new Map();
  const fallbackLastSeq = new Map();

  function nextFallbackSeq(key) {
    const seq = (fallbackCounters.get(key) || 0) + 1;
    fallbackCounters.set(key, seq);
    fallbackLastSeq.set(key, seq);
    return seq;
  }

  /** item.id 缺失时生成稳定 fallback；否则原样返回。 */
  function resolveToolCallId(item, { forCompleted = false } = {}) {
    if (typeof item?.id === 'string' && item.id) return item.id;
    const name = item?.tool || 'unknown';
    const turn = eventTurn({ item });
    const key = `${name}:${turn}`;
    if (forCompleted && fallbackLastSeq.has(key)) {
      return `tool:${name}:${turn}:${fallbackLastSeq.get(key)}`;
    }
    return `tool:${name}:${turn}:${nextFallbackSeq(key)}`;
  }

  /**
   * 映射一批事件（一轮轮询的增量）。
   *
   * @param {Array<object>} events
   * @returns {{
   *   updates: Array<object>,
   *   terminal: null | { kind: 'completed'|'failed'|'cancelled', turn: number|null,
   *     error?: object, usage?: object|null },
   *   duplicatesSkipped: number,
   * }}
   */
  function mapBatch(events) {
    const updates = [];
    let terminal = null;
    let duplicatesSkipped = 0;

    for (const event of Array.isArray(events) ? events : []) {
      // eventId 去重：携带 eventId 且已见过 → 跳过（018 起事件必带 eventId，
      // 缺失时不做去重直接处理）
      if (event?.eventId !== undefined) {
        if (knownEventIds.has(event.eventId)) {
          duplicatesSkipped += 1;
          continue;
        }
        knownEventIds.add(event.eventId);
      }

      const item = event?.item;
      switch (event?.type) {
        case 'item.completed': {
          if (item?.type === 'agent_message') {
            updates.push({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: String(item.text ?? '') },
              ...(typeof item.id === 'string' && item.id ? { messageId: item.id } : {}),
            });
          } else if (item?.type === 'tool_call') {
            const toolCallId = resolveToolCallId(item, { forCompleted: true });
            // 只有 completed 没有 started 的 tool：先补发最小 tool_call
            if (!seenToolCallIds.has(toolCallId)) {
              updates.push({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: String(item.tool || 'unknown'),
                name: String(item.tool || 'unknown'),
                kind: classifyToolKind(item.tool),
                status: 'in_progress',
              });
              seenToolCallIds.add(toolCallId);
            }
            const rawOutput = item.result !== undefined
              ? item.result
              : (item.error !== undefined ? item.error : undefined);
            updates.push({
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: item.status === 'failed' ? 'failed' : 'completed',
              ...(rawOutput !== undefined ? { rawOutput } : {}),
            });
          } else if (item?.type === 'reasoning') {
            // reasoning → agent_thought_chunk（codex-acp 风格）：client 渲染
            // thinking 折叠区；空文本跳过（不产生空 chunk）
            const thought = String(item.text ?? '');
            if (thought) {
              updates.push({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: thought },
                ...(typeof item.id === 'string' && item.id ? { messageId: item.id } : {}),
              });
            }
          }
          break;
        }
        case 'item.started': {
          if (item?.type === 'tool_call') {
            const toolCallId = resolveToolCallId(item);
            updates.push({
              sessionUpdate: 'tool_call',
              toolCallId,
              title: String(item.tool || 'unknown'),
              name: String(item.tool || 'unknown'),
              kind: classifyToolKind(item.tool),
              status: 'in_progress',
              ...(item.arguments !== undefined ? { rawInput: item.arguments } : {}),
            });
            seenToolCallIds.add(toolCallId);
          }
          break;
        }
        case 'turn.completed': {
          terminal = { kind: 'completed', turn: event.turn ?? null, usage: event.usage ?? null };
          break;
        }
        case 'turn.failed': {
          terminal = { kind: 'failed', turn: event.turn ?? null, error: event.error ?? null, usage: event.usage ?? null };
          break;
        }
        case 'turn.cancelled': {
          terminal = { kind: 'cancelled', turn: event.turn ?? null, error: event.error ?? null };
          break;
        }
        // thread.started / turn.started / reasoning item / 未知事件：不映射
        default:
          break;
      }

      if (terminal) break;
    }

    return { updates, terminal, duplicatesSkipped };
  }

  return { mapBatch };
}
