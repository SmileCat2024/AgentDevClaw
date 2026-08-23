/**
 * Mirror-style LLM tuning shared by server-side in-process summary calls
 * (ticket 008) and the title/recap mirror scripts.
 *
 * Moved from scripts/mirror-runtime.js so server code does not import
 * from scripts/ (scripts importing server/ is the sanctioned direction).
 */

export function tuneMirrorLLM(llm, maxTokens, { forceMaxTokens = false } = {}) {
  if (!llm || typeof llm !== 'object') return;

  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingEffort')) {
      llm.thinkingEffort = undefined;
    }
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
      llm.thinkingBudgetTokens = undefined;
    }
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingKeepTurns')) {
      llm.thinkingKeepTurns = 0;
    }
  } catch {}

  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'providerOptions')) {
      const providerOptions = llm.providerOptions;
      if (providerOptions && typeof providerOptions === 'object') {
        const nextOptions = { ...providerOptions };
        delete nextOptions.reasoning;
        delete nextOptions.reasoning_effort;
        delete nextOptions.thinking;
        llm.providerOptions = nextOptions;
      }
    }
  } catch {}

  try {
    if (forceMaxTokens || Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
      const current = Number(llm.maxTokens);
      llm.maxTokens = forceMaxTokens
        ? maxTokens
        : Number.isFinite(current) && current > 0
          ? Math.min(current, maxTokens)
          : maxTokens;
    }
  } catch {}
}
