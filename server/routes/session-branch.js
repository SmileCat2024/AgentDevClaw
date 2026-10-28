import { createHash } from 'node:crypto';

export function sessionSnapshotRevision(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function invalidBoundary(message) {
  return Object.assign(new Error(message), { code: 'branch_boundary_unavailable', status: 409, statusCode: 409 });
}

/** Copy a complete persisted boundary; never mix cut messages with pre-call state. */
export function buildBranchSnapshot(source, cutMsgIndexEnd, { sessionId, live = false } = {}) {
  const runtime = source?.runtime || {};
  const context = runtime.context || {};
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const length = cutMsgIndexEnd + 1;
  if (!Number.isInteger(cutMsgIndexEnd) || length <= 0 || length > messages.length) {
    throw invalidBoundary('分支点已失效，请重新打开分支预览。');
  }
  const checkpoints = Array.isArray(source.rollbackHistory) ? source.rollbackHistory : [];
  const checkpoint = checkpoints.find(cp => cp.kind === 'context-boundary'
    ? cp.contextBoundary?.messagesLength === length
    : cp.runtime?.context?.messages?.length === length);
  let state;
  let branchContext;
  if (checkpoint?.kind === 'context-boundary') {
    const boundary = checkpoint.contextBoundary;
    if (boundary.generation !== context.generation
      || boundary.enrichedMessagesLength > (context.enrichedMessages?.length || 0)) {
      throw invalidBoundary('历史分支点与当前快照不一致，请选择其他完整轮次。');
    }
    state = checkpoint.runtimeState;
    branchContext = { ...context, messages: messages.slice(0, length),
      enrichedMessages: (context.enrichedMessages || []).slice(0, boundary.enrichedMessagesLength),
      sequence: boundary.sequence };
  } else if (checkpoint?.runtime?.context) {
    state = checkpoint.runtime;
    branchContext = state.context;
    if (JSON.stringify(branchContext.messages) !== JSON.stringify(messages.slice(0, length))) {
      throw invalidBoundary('历史分支点与当前快照不一致，请选择其他完整轮次。');
    }
  } else if (length === messages.length
    && (runtime.callState === 'idle' || (runtime.callState == null && !live))) {
    state = runtime;
    branchContext = context;
  } else {
    throw invalidBoundary('该分支点尚无完整快照，不能复制执行中的半轮状态；请等待本轮结束或选择已有检查点的历史轮次。');
  }
  if (!state || !Number.isFinite(state.callIndex)) throw invalidBoundary('分支点缺少可恢复的运行状态。');
  return {
    ...source, sessionId, savedAt: Date.now(),
    runtime: { ...state, context: branchContext, callState: 'idle' },
    rollbackHistory: checkpoints.filter(cp => cp.callIndex <= state.callIndex),
    // Named checkpoints keep meaning within the branched history; beyond the cut
    // they would dangle — same boundary policy as rollbackHistory.
    namedCheckpoints: (Array.isArray(source?.namedCheckpoints) ? source.namedCheckpoints : [])
      .filter(cp => typeof cp?.sourceCallIndex === 'number' && cp.sourceCallIndex <= state.callIndex),
  };
}
