/**
 * Mirror-style LLM tuning shared by server-side in-process summary calls
 * (ticket 008) and the title/recap mirror scripts.
 *
 * Moved from scripts/mirror-runtime.js so server code does not import
 * from scripts/ (scripts importing server/ is the sanctioned direction).
 */

/**
 * 镜像类调用（摘要 / 标题 / recap）不需要思考输出。思考控制参数各厂商
 * 支持形态不一：anthropic 协议有原生的 thinking.disabled 字段，可显式关闭
 * （大上下文摘要对思考型模型可省去数分钟的隐性思考）；openai 系端点对
 * effort:'none' 的接受度因网关/模型而异，维持不传参交由厂商默认。
 */
export function tuneMirrorLLM(llm, maxTokens, { forceMaxTokens = false, protocol } = {}) {
  if (!llm || typeof llm !== 'object') return;

  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingEffort')) {
      llm.thinkingEffort = protocol === 'anthropic' ? 'none' : undefined;
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
