/**
 * Runtime Partial Compact / Rollback — extracted from run-prebuilt-agent.js.
 *
 * Contains:
 *  - Partial compact ("从此处压缩", from a specific call index)
 *  - Rollback to a specific call
 *  - Input response handler (routes rollback / partial-compact actions)
 *
 * The factory receives a mutable context object whose `agent` property is
 * populated later by the main runtime. `postJson` and `sessionStore`
 * are stable values available at factory call time.
 */

import { createTool } from '@agentdevjs/core';
import { buildClaudeCompactPrompt, stripCompactAnalysis, scanFilesAndSkills } from '../server/context-continuity/claude-compact-prompts.js';

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const PARTIAL_COMPACT_BOUNDARY_MARKER = '[PARTIAL_COMPACT_START]';

// 摘要模型的结构化输出通道：约定「所有摘要内容只能经此工具返回」，execute 为
// no-op（此工具从不真正执行，仅作为 LLM 输出 schema 与结果载体）。
const RECORD_COMPACTION_CONTEXT_TOOL = createTool({
  name: 'record_compaction_context',
  description: 'Record the summary, important files and skills for context handoff. This is the ONLY output method — put ALL content into this tool call, do not write summary as plain text.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'The complete summary text. For exploration sessions: three-section format (goals, findings, important files). For regular sessions: nine-section format. Must not be empty.',
      },
      important_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths that are important for continuing the task.',
      },
      important_skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Skill names that were used and are important for continuing the task.',
      },
    },
    required: ['summary'],
  },
  execute: async () => ({ ok: true }),
}, new URL(import.meta.url).pathname);

/**
 * @param {object} ctx - mutable runtime context
 * @param {string} ctx.agentId
 * @param {string|null} ctx.sessionId
 * @param {number} ctx.PREBUILT_AGENT_MAX_TOKENS_CAP
 * @param {object|null} ctx.agent - set during main()
 * @param {object} ctx.sessionStore
 * @param {function} ctx.postJson - POST JSON helper bound to SERVER_ORIGIN
 */
export function createSummaryHandlers(ctx) {
  let compactSummaryInFlight = false;

  function tuneSummaryLLM(llm) {
    if (!llm || typeof llm !== 'object') return () => {};
    const restore = new Map();
    const remember = (key) => {
      if (Object.prototype.hasOwnProperty.call(llm, key)) {
        restore.set(key, llm[key]);
      }
    };
    remember('thinkingEffort');
    remember('thinkingBudgetTokens');
    remember('maxTokens');
    try {
      if (Object.prototype.hasOwnProperty.call(llm, 'thinkingEffort')) {
        llm.thinkingEffort = undefined;
      }
    } catch {}
    try {
      if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
        llm.thinkingBudgetTokens = undefined;
      }
    } catch {}
    try {
      if (Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
        const current = Number(llm.maxTokens);
        llm.maxTokens = Number.isFinite(current) && current > 0 ? Math.min(current, ctx.PREBUILT_AGENT_MAX_TOKENS_CAP) : ctx.PREBUILT_AGENT_MAX_TOKENS_CAP;
      }
    } catch {}
    return () => {
      for (const [key, value] of restore.entries()) {
        try { llm[key] = value; } catch {}
      }
    };
  }

  function shouldPreserveSummaryTools(agentInstance) {
    const modelName = cleanValue(
      agentInstance?.getSystemContext?.()?.SYSTEM_CURRENT_MODEL
      || agentInstance?._systemContext?.SYSTEM_CURRENT_MODEL
      || '',
    ).toLowerCase();
    return modelName.includes('claude');
  }

  function buildPartialCompactSummaryContent(summaryText, { messagesSummarized = 0, feedback = '' } = {}) {
    return [
      '## 已压缩的后续对话摘要',
      '',
      '此消息不是新的用户请求；它是系统在执行"从此处压缩"后注入的连续性摘要。',
      '它替代了从所选用户消息开始、到压缩前为止的对话内容。上方较早消息已按原文保留。',
      '继续工作时，请同时参考上方保留的原文和下面的摘要；不要重新回复被摘要的历史用户消息，除非摘要中的"当前工作"或"待办事项"要求继续执行。',
      '',
      messagesSummarized > 0 ? `被摘要消息数：${messagesSummarized}` : '',
      feedback ? `用户压缩说明：${feedback}` : '',
      '',
      summaryText,
    ].filter(Boolean).join('\n');
  }

  /**
   * Generate a summary for only a subset of messages (partial compact).
   * The summarizer sees retained context plus an explicit boundary marker so it
   * can explain how the compacted tail relates to the preserved prefix.
   * @param {Array} allMessages - complete messages before partial compact
   * @param {number} pivotMsgIndex - first message that will be summarized
   * @param {string} feedback - optional user-provided extra instructions
   */
  async function generatePartialInProcessSummary(allMessages, pivotMsgIndex, feedback = '') {
    const agent = ctx.agent;
    const rawMessages = Array.isArray(allMessages) ? allMessages : [];
    const safePivot = Math.max(0, Math.min(Number(pivotMsgIndex) || 0, rawMessages.length));
    const messagesToSummarize = rawMessages.slice(safePivot);
    const prompt = buildClaudeCompactPrompt({
      additionalInstructions: feedback,
      partial: true,
    });
    const messages = rawMessages.map((message, index) => ({
      role: message.role,
      content: typeof message?.content === 'string' ? message.content : '',
      turn: Number.isFinite(message?.turn) ? Number(message.turn) : index,
      toolCallId: message?.toolCallId,
      toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls : undefined,
      reasoning: typeof message?.reasoning === 'string' ? message.reasoning : undefined,
      thinkingBlocks: Array.isArray(message?.thinkingBlocks) ? message.thinkingBlocks : undefined,
    }));
    messages.splice(safePivot, 0, {
      role: 'system',
      content: [
        PARTIAL_COMPACT_BOUNDARY_MARKER,
        '上方消息会按原文保留，仅作为理解背景。',
        '下方消息是本次"从此处压缩"需要摘要并替换的内容。',
      ].join('\n'),
      turn: Number.isFinite(rawMessages[safePivot]?.turn) ? Number(rawMessages[safePivot].turn) : safePivot,
    });
    messages.push({
      role: 'user',
      content: prompt,
      turn: typeof agent?._callIndex === 'number' ? Number(agent._callIndex) + 1 : messages.length,
    });

    // 摘要工具集：Claude 系模型保留全部工具，其余只给结构化输出通道。
    const toolRegistry = typeof agent?.getTools === 'function' ? agent.getTools() : null;
    const allTools = toolRegistry?.getAll?.() || [];
    let tools = shouldPreserveSummaryTools(agent) ? allTools : [];
    if (!tools.includes(RECORD_COMPACTION_CONTEXT_TOOL)) {
      tools = [RECORD_COMPACTION_CONTEXT_TOOL, ...tools];
    }
    const restoreLLM = tuneSummaryLLM(agent?.llm);
    try {
      console.log(`[ProtoClaw Runtime] 开始部分摘要压缩 messages=${messages.length} tools=${tools.length}`);
      const response = await agent.llm.chat(messages, tools, { noStream: true });
      if (response?.stopReason === 'max_tokens') {
        throw new Error('摘要因 max_tokens 限制被截断（stopReason=max_tokens），拒绝接受不完整结果');
      }
      const rawResponse = typeof response?.content === 'string' ? response.content : '';
      const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      if (toolCalls.some(tc => tc?.name !== 'record_compaction_context')) {
        throw new Error('摘要模型错误地触发了工具调用');
      }
      const compactCall = toolCalls.find(tc => tc?.name === 'record_compaction_context');

      let importantFiles = [];
      let importantSkills = [];
      let summaryText = '';

      if (compactCall && compactCall.arguments) {
        const args = typeof compactCall.arguments === 'string'
          ? (() => { try { return JSON.parse(compactCall.arguments); } catch { return {}; } })()
          : compactCall.arguments;
        summaryText = typeof args.summary === 'string' ? args.summary.trim() : '';
        importantFiles = Array.isArray(args.important_files)
          ? args.important_files.filter(f => typeof f === 'string')
          : [];
        importantSkills = Array.isArray(args.important_skills)
          ? args.important_skills.filter(s => typeof s === 'string')
          : [];
      }

      if (!summaryText) {
        summaryText = stripCompactAnalysis(rawResponse);
      }

      if (!summaryText.trim()) {
        throw new Error('摘要模型返回了空结果');
      }
      const { fileRanges } = scanFilesAndSkills(messagesToSummarize);
      return {
        rawResponse,
        summaryText,
        importantFiles,
        importantSkills,
        fileRanges,
      };
    } finally {
      restoreLLM();
    }
  }

  async function rollbackToCallAndSave(callIndex, { draftInput } = {}) {
    const agent = ctx.agent;
    if (typeof agent?.rollbackToCall !== 'function') {
      console.warn('[ProtoClaw Runtime] 当前 Agent 不支持 rollbackToCall');
      return { ok: false, draftInput: '' };
    }

    // Diagnostic: log checkpoint state before attempting rollback
    const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
    const cpIndices = checkpoints.map(cp => cp.callIndex);
    const agentCallIndex = typeof agent?._callIndex === 'number' ? agent._callIndex : 'unknown';
    const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
    const msgs = context?.getAll?.() || [];
    const userTurns = msgs.filter(m => m.role === 'user').map(m => m.turn);
    console.log(`[ProtoClaw Runtime] rollbackToCallAndSave 诊断: callIndex=${callIndex} _callIndex=${agentCallIndex} checkpoints=[${cpIndices.join(',')}] userTurns=[${userTurns.join(',')}] msgs=${msgs.length}`);

    let result;
    try {
      result = await agent.rollbackToCall(callIndex);
      console.log(`[ProtoClaw Runtime] rollbackToCall 成功: callIndex=${callIndex}`);
    } catch (error) {
      console.error(`[ProtoClaw Runtime] rollbackToCall 失败: callIndex=${callIndex} checkpoints=[${cpIndices.join(',')}] — ${error.message}`);
      throw error;
    }
    const nextDraftInput = typeof draftInput === 'string'
      ? draftInput
      : (typeof result?.draftInput === 'string' ? result.draftInput : '');

    if (ctx.sessionId) {
      await agent.saveSession(ctx.sessionId, ctx.sessionStore);
      console.log(`[ProtoClaw Runtime] 已回滚到 call ${callIndex}`);
    }

    return { ok: true, draftInput: nextDraftInput };
  }

  /**
   * Trigger partial compaction in-session: summarize messages from the given callIndex
   * onward, roll back to that call, inject the summary as a system reminder message,
   * and save the same session. No new session is created.
   */
  async function triggerPartialCompact(callIndex, feedback = '') {
    if (compactSummaryInFlight) {
      console.warn('[ProtoClaw Runtime] 已有 compact summary 正在进行，本次请求已忽略。');
      return;
    }
    if (!ctx.sessionId) {
      console.warn('[ProtoClaw Runtime] 当前 runtime 未绑定 session，无法触发 partial compact。');
      return;
    }

    compactSummaryInFlight = true;
    try {
      const agent = ctx.agent;
      const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
      const rawMessages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
      if (rawMessages.length === 0) {
        throw new Error('当前上下文为空，无法生成摘要');
      }

      // Find pivot message index by callIndex (counting user turns)
      let pivotMsgIndex = -1;
      let userTurnCount = 0;
      for (let i = 0; i < rawMessages.length; i++) {
        if (rawMessages[i].role === 'user') {
          const turn = Number.isFinite(rawMessages[i].turn) ? Number(rawMessages[i].turn) : userTurnCount;
          if (turn === callIndex) {
            pivotMsgIndex = i;
            break;
          }
          userTurnCount++;
        }
      }
      // Fallback: use message index-based heuristic
      if (pivotMsgIndex < 0) {
        let count = 0;
        for (let i = 0; i < rawMessages.length; i++) {
          if (rawMessages[i].role === 'user') {
            if (count === callIndex) {
              pivotMsgIndex = i;
              break;
            }
            count++;
          }
        }
      }

      if (pivotMsgIndex < 0) {
        throw new Error(`找不到 callIndex=${callIndex} 对应的消息位置`);
      }

      const messagesToSummarize = rawMessages.slice(pivotMsgIndex);
      if (messagesToSummarize.length === 0) {
        throw new Error('没有需要压缩的消息');
      }

      console.log(`[ProtoClaw Runtime] 部分压缩: pivot=${pivotMsgIndex} summarize=${messagesToSummarize.length} keep=${pivotMsgIndex}`);

      // 1. Generate summary BEFORE rolling back (so we don't lose the messages)
      const summaryResult = await generatePartialInProcessSummary(rawMessages, pivotMsgIndex, feedback);

      const keptMessages = rawMessages.slice(0, pivotMsgIndex);
      const summaryContent = buildPartialCompactSummaryContent(summaryResult.summaryText, {
        messagesSummarized: messagesToSummarize.length,
        feedback,
      });

      // 2. Roll back via the exact same helper used by "回退到此轮".
      const rollback = await rollbackToCallAndSave(callIndex, { draftInput: '' });
      if (!rollback.ok) {
        return;
      }

      // 3. Inject summary as system reminder.
      // After rollback, the context already has the correct kept prefix in both
      // messages and enrichedMessages. We append the summary via addSystemMessage
      // (which syncs both arrays) instead of ctx.restore({ enrichedMessages: [] })
      // which would wipe enrichedMessages and break Feature queries.
      const ctxObj = typeof agent?.getContext === 'function' ? agent.getContext() : null;
      if (!ctxObj) {
        throw new Error('无法获取上下文');
      }

      const restoredCallIndex = typeof agent._callIndex === 'number' ? Number(agent._callIndex) : callIndex - 1;
      const reminderTurn = Math.max(0, restoredCallIndex + 1);

      // Verify the rollback produced the expected prefix; if not, fall back to
      // explicit restore (with rebuilt enrichedMessages from post-rollback state).
      const postRollbackMessages = ctxObj.getAll();
      if (postRollbackMessages.length === keptMessages.length) {
        ctxObj.addSystemMessage(summaryContent, reminderTurn, 'partial-compact');
      } else {
        console.warn(`[ProtoClaw Runtime] 部分压缩: 回滚后消息数 (${postRollbackMessages.length}) 与预期 (${keptMessages.length}) 不一致，使用显式 restore`);
        const postRollbackEnriched = typeof ctxObj.getAllEnriched === 'function' ? ctxObj.getAllEnriched() : [];
        const finalMessages = [...keptMessages, {
          role: 'system', content: summaryContent, turn: reminderTurn,
        }];
        ctxObj.restore({ version: 2, messages: finalMessages, enrichedMessages: postRollbackEnriched, sequence: postRollbackEnriched.length });
      }

      // 4. Save and sync final state.
      await agent.saveSession(ctx.sessionId, ctx.sessionStore);
      agent['pushToDebug']?.(ctxObj.getAll());
      agent['pushInspectorSnapshot']?.();
      console.log(`[ProtoClaw Runtime] 部分压缩已回退并注入 system reminder: before=${rawMessages.length} after=${ctxObj.getAll().length} reminderTurn=${reminderTurn}`);
      console.log(`[ProtoClaw Runtime] 部分压缩完成 (in-session): callIndex=${callIndex}`);
    } catch (error) {
      console.error('[ProtoClaw Runtime] 部分压缩失败:', error);
    } finally {
      compactSummaryInFlight = false;
    }
  }

  async function handleInputResponse(userInput, response) {
    if (!response) {
      return { kind: 'continue' };
    }

    if (response.kind === 'text') {
      const text = response.text ?? '';
      const images = Array.isArray(response.payload?.images)
        ? response.payload.images.filter((img) => img && typeof img === 'object')
        : [];
      const capabilityActivations = Array.isArray(response.payload?.capabilityActivations)
        ? response.payload.capabilityActivations.filter((a) => typeof a === 'string' && a)
        : [];
      if (!text && images.length === 0) {
        return { kind: 'continue' };
      }
      if (text === '/exit') {
        return { kind: 'exit' };
      }
      return {
        kind: 'text',
        text: text || ' ',
        ...(images.length > 0 ? { images } : {}),
        ...(capabilityActivations.length > 0 ? { capabilityActivations } : {}),
      };
    }

    if (response.kind === 'action' && response.actionId === 'rollback_to_call') {
      const callIndex = response.payload?.callIndex;
      if (typeof callIndex !== 'number') {
        console.warn('[ProtoClaw Runtime] rollback_to_call 缺少有效的 callIndex');
        return { kind: 'continue' };
      }

      const result = await rollbackToCallAndSave(callIndex, {
        draftInput: typeof response.payload?.draftInput === 'string'
          ? response.payload.draftInput
          : undefined,
      });
      if (result.ok && typeof userInput.setNextDraftInput === 'function') {
        userInput.setNextDraftInput(result.draftInput);
      }
      return { kind: 'continue' };
    }

    if (response.kind === 'action' && response.actionId === 'compact_from_call') {
      const callIndex = response.payload?.callIndex;
      if (typeof callIndex !== 'number') {
        console.warn('[ProtoClaw Runtime] compact_from_call 缺少有效的 callIndex');
        return { kind: 'continue' };
      }

      const feedback = typeof response.payload?.feedback === 'string' ? response.payload.feedback : '';
      await triggerPartialCompact(callIndex, feedback);
      return { kind: 'continue' };
    }

    console.warn('[ProtoClaw Runtime] 收到未处理的输入动作:', response.actionId ?? response.kind);
    return { kind: 'continue' };
  }

  return {
    handleInputResponse,
    rollbackToCallAndSave,
  };
}
