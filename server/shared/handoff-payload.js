/**
 * Handoff 内容解析 — runtime 侧消费端唯一实现。
 *
 * run-prebuilt-agent.js 与 run-one-shot-agent.js 原各自内联一份
 * parseHandoffContent，语义已经漂移（seed 消息归一化差异 + 字段读取
 * 各写一份）；本模块收敛为单一实现。字段读取覆盖三种包形态：
 *   - summarized-nine-section（compact 链）：compactOutput.* 优先
 *   - trim-transcript-with-summary（trim / thread 接力）：appendedSummary.*
 *   - 纯文本：整体作为 sourceSummary
 *
 * appendedSummary 回退修复了 trim-with-summary 包在 runtime 消费端的
 * 字段断链（此前只有 compactOutput.* 被读取，接力的 successor 拿不到
 * 摘要正文与 importantFiles）。
 */

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : null;
}

function pickObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * @param {string} raw - handoff 包 JSON / 摘要纯文本
 * @param {string} sourceLabel - 错误信息定位标签（env 名或文件路径）
 * @param {{ rawTextFallback?: boolean }} [options]
 *   payload env 直传摘要文本时 true：解析失败按原文收敛为 sourceSummary，
 *   不抛错（PROTOCLAW_HANDOFF_PAYLOAD 语义）；文件路径形态保持抛错。
 */
export function parseHandoffContent(raw, sourceLabel, { rawTextFallback = false } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return { sourceSummary: parsed, seedMessages: [] };
    }
    if (parsed && typeof parsed === 'object') {
      const seedMessages = Array.isArray(parsed.seedMessages)
        ? parsed.seedMessages
            .filter((message) => {
              if (!message || typeof message !== 'object') return false;
              const role = typeof message.role === 'string' ? message.role.trim() : '';
              if (!role) return false;
              const hasContent = message.content != null && message.content !== '';
              const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
              const hasToolCallId = typeof message.toolCallId === 'string' && message.toolCallId !== '';
              return hasContent || hasToolCalls || hasToolCallId;
            })
            .map((message) => ({
              ...message,
              role: message.role.trim(),
              turn: Number.isFinite(message.turn) ? Number(message.turn) : null,
            }))
        : [];
      // 摘要正文优先 appendedSummary（trim-with-summary 包的真实摘要；
      // 顶层 sourceSummary 在该形态下只是 Task/Goal 概览头）
      const sourceSummary = cleanValue(
        parsed.appendedSummary?.summaryText
        || parsed.sourceSummary
        || parsed.summaryText
        || parsed.summary
        || parsed.handoffSummary
        || parsed.text,
      );
      const featureContinuity = parsed.featureContinuity && typeof parsed.featureContinuity === 'object'
        ? parsed.featureContinuity
        : null;
      // appendix：摘要包可附带的用户最近输入提醒块（不改 seed 骨架，由 runtime
      // 经 HandoffSeedFeature 的 appendix 通道以 system reminder 注入）。
      const appendixContent = cleanValue(parsed.appendix?.content);
      const appendix = appendixContent
        ? { kind: cleanValue(parsed.appendix?.kind) || 'recent-user-input', content: appendixContent }
        : null;
      // branch 注入包（ADR-0034 §4.1）：只有 mode/sourceSessionId/featureContinuity，
      // 无摘要与种子消息——有 continuity 载荷即视为合法包。
      if (seedMessages.length === 0 && !sourceSummary && !featureContinuity) {
        throw new Error('missing seedMessages/sourceSummary');
      }
      return {
        packageId: cleanValue(parsed.packageId || parsed.handoffId),
        sourceSessionId: cleanValue(parsed.sourceSessionId),
        sourceSummary,
        seedMessages,
        mode: cleanValue(parsed.mode),
        policy: parsed.policy && typeof parsed.policy === 'object' ? parsed.policy : {},
        importantFiles: pickStringList(parsed.compactOutput?.importantFiles)
          ?? pickStringList(parsed.appendedSummary?.importantFiles)
          ?? [],
        importantSkills: pickStringList(parsed.compactOutput?.importantSkills)
          ?? pickStringList(parsed.appendedSummary?.importantSkills)
          ?? [],
        fileRanges: pickObject(parsed.compactOutput?.fileRanges)
          ?? pickObject(parsed.appendedSummary?.fileRanges)
          ?? {},
        featureContinuity,
        appendix,
      };
    }
  } catch (error) {
    if (rawTextFallback) {
      return { sourceSummary: text, seedMessages: [] };
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      throw new Error(`解析 handoff 内容失败 (${sourceLabel}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { sourceSummary: text, seedMessages: [] };
}

/**
 * handoff 包的 seed 装配参数（runtime 侧唯一构造点）。
 *
 * appendix（当前用于纯摘要档的「最近用户输入」）以框架既有通道注入，
 * 与 seed 同事务、排在 seed 与文件/技能重载块之后，不计入 seed 账目。
 */
export function buildHandoffSeedConfig(handoff) {
  return {
    handoff,
    ...(handoff?.appendix?.content ? { appendix: { content: handoff.appendix.content } } : {}),
  };
}
