/**
 * overview-data.js — Overview 数据规范化模块（从 app-ui.js 域 K-a 提取）
 *
 * 包含：
 *   - shortenSourcePath: 缩短源文件路径（纯工具函数）
 *   - FULL_HOOK_LIFECYCLE_ORDER: hook 生命周期顺序常量
 *   - getHookInspectorSignature / getOverviewSignature: JSON 签名（去重用）
 *   - getEmptyOverviewSnapshot: 空 overview 模板
 *   - normalizeRuntimeSnapshot / normalizeOverviewSnapshot: runtime & overview 快照规范化
 *   - normalizeHookInspector: hook inspector 快照规范化
 *   - setCurrentHookInspector / setCurrentOverviewSnapshot / setCurrentLogs: 全局状态 setter
 *
 * 依赖（全局变量，声明于 app-core.js）：
 *   - currentHookInspector, currentHookInspectorSignature
 *   - currentOverviewSnapshot, currentOverviewSignature
 *   - currentLogs, currentLogsSignature
 *   - selectedFeatureName
 */

function shortenSourcePath(value) {
  if (!value) return '';
  const normalized = String(value).replace(/\\/g, '/');
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
  const agentdevIndex = normalized.lastIndexOf('/AgentDev/');
  if (agentdevIndex >= 0) return normalized.slice(agentdevIndex + 10);
  return normalized;
}

const FULL_HOOK_LIFECYCLE_ORDER = [
  'AgentInitiate',
  'AgentDestroy',
  'CallStart',
  'CallFinish',
  'StepStart',
  'StepFinish',
  'ToolUse',
  'ToolFinished',
  'ToolResultTransform',
];

function getHookInspectorSignature(snapshot) {
  return JSON.stringify(snapshot || { lifecycleOrder: [], features: [], hooks: [] });
}

function getEmptyOverviewSnapshot() {
  return {
    updatedAt: 0,
    context: {
      messageCount: 0,
      charCount: 0,
      toolCallCount: 0,
      turnCount: 0,
    },
    usageStats: {
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      calls: [],
      totalRequests: 0,
      totalCacheHitRequests: 0,
      lastRequestUsage: null,
    },
    runtime: {
      stage: 'idle',
      callActive: false,
      charCount: 0,
      thinkingChars: 0,
      contentChars: 0,
      toolCallCount: 0,
      activeToolNames: [],
      activeToolCount: 0,
      callStartedAt: 0,
      stageStartedAt: 0,
      updatedAt: 0,
      lastErrorType: null,
      lastErrorMessage: null,
    },
    modelName: '',
    presetName: '',
    thinkingEffort: null,
    contextLength: null,
    compressRatio: null,
  };
}

function normalizeRuntimeSnapshot(snapshot) {
  return {
    stage: typeof snapshot?.stage === 'string' ? snapshot.stage : 'idle',
    callActive: snapshot?.callActive === true,
    charCount: typeof snapshot?.charCount === 'number' ? snapshot.charCount : 0,
    thinkingChars: typeof snapshot?.thinkingChars === 'number' ? snapshot.thinkingChars : 0,
    contentChars: typeof snapshot?.contentChars === 'number' ? snapshot.contentChars : 0,
    toolCallCount: typeof snapshot?.toolCallCount === 'number' ? snapshot.toolCallCount : 0,
    activeToolNames: Array.isArray(snapshot?.activeToolNames) ? snapshot.activeToolNames.map((item) => String(item || '')).filter(Boolean) : [],
    activeToolCount: typeof snapshot?.activeToolCount === 'number' ? snapshot.activeToolCount : 0,
    callStartedAt: typeof snapshot?.callStartedAt === 'number' ? snapshot.callStartedAt : 0,
    stageStartedAt: typeof snapshot?.stageStartedAt === 'number' ? snapshot.stageStartedAt : 0,
    retryAttempt: typeof snapshot?.retryAttempt === 'number' ? snapshot.retryAttempt : undefined,
    maxRetries: typeof snapshot?.maxRetries === 'number' ? snapshot.maxRetries : undefined,
    nextRetryDelayMs: typeof snapshot?.nextRetryDelayMs === 'number' ? snapshot.nextRetryDelayMs : undefined,
    updatedAt: typeof snapshot?.updatedAt === 'number' ? snapshot.updatedAt : 0,
    lastErrorType: typeof snapshot?.lastErrorType === 'string' ? snapshot.lastErrorType : null,
    lastErrorMessage: typeof snapshot?.lastErrorMessage === 'string' ? snapshot.lastErrorMessage : null,
    lastOutcome: snapshot?.lastOutcome && typeof snapshot.lastOutcome === 'object' ? snapshot.lastOutcome : null,
  };
}

function normalizeOverviewSnapshot(snapshot) {
  const empty = getEmptyOverviewSnapshot();
  if (!snapshot || typeof snapshot !== 'object') {
    return empty;
  }

  return {
    updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
    context: {
      messageCount: typeof snapshot.context?.messageCount === 'number' ? snapshot.context.messageCount : 0,
      charCount: typeof snapshot.context?.charCount === 'number' ? snapshot.context.charCount : 0,
      toolCallCount: typeof snapshot.context?.toolCallCount === 'number' ? snapshot.context.toolCallCount : 0,
      turnCount: typeof snapshot.context?.turnCount === 'number' ? snapshot.context.turnCount : 0,
    },
    usageStats: {
      totalUsage: {
        inputTokens: typeof snapshot.usageStats?.totalUsage?.inputTokens === 'number' ? snapshot.usageStats.totalUsage.inputTokens : 0,
        outputTokens: typeof snapshot.usageStats?.totalUsage?.outputTokens === 'number' ? snapshot.usageStats.totalUsage.outputTokens : 0,
        totalTokens: typeof snapshot.usageStats?.totalUsage?.totalTokens === 'number' ? snapshot.usageStats.totalUsage.totalTokens : 0,
        cacheCreationTokens: typeof snapshot.usageStats?.totalUsage?.cacheCreationTokens === 'number' ? snapshot.usageStats.totalUsage.cacheCreationTokens : 0,
        cacheReadTokens: typeof snapshot.usageStats?.totalUsage?.cacheReadTokens === 'number' ? snapshot.usageStats.totalUsage.cacheReadTokens : 0,
        reasoningTokens: typeof snapshot.usageStats?.totalUsage?.reasoningTokens === 'number' ? snapshot.usageStats.totalUsage.reasoningTokens : 0,
        audioTokens: typeof snapshot.usageStats?.totalUsage?.audioTokens === 'number' ? snapshot.usageStats.totalUsage.audioTokens : 0,
      },
      calls: Array.isArray(snapshot.usageStats?.calls) ? snapshot.usageStats.calls.map((call) => ({
        ...call,
        cacheHitRequests: typeof call?.cacheHitRequests === 'number' ? call.cacheHitRequests : 0,
      })) : [],
      totalRequests: typeof snapshot.usageStats?.totalRequests === 'number' ? snapshot.usageStats.totalRequests : 0,
      totalCacheHitRequests: typeof snapshot.usageStats?.totalCacheHitRequests === 'number' ? snapshot.usageStats.totalCacheHitRequests : 0,
      lastRequestUsage: snapshot.usageStats?.lastRequestUsage || null,
    },
    runtime: normalizeRuntimeSnapshot(snapshot.runtime),
    modelName: typeof snapshot.modelName === 'string' ? snapshot.modelName : '',
    presetName: typeof snapshot.presetName === 'string' ? snapshot.presetName : '',
    thinkingEffort: typeof snapshot.thinkingEffort === 'string' ? snapshot.thinkingEffort : null,
    contextLength: typeof snapshot.contextLength === 'number' && snapshot.contextLength > 0 ? snapshot.contextLength : null,
    compressRatio: typeof snapshot.compressRatio === 'number' && snapshot.compressRatio > 0 ? snapshot.compressRatio : null,
  };
}

function getOverviewSignature(snapshot) {
  return JSON.stringify(normalizeOverviewSnapshot(snapshot));
}

function normalizeHookInspector(snapshot) {
  const raw = snapshot || { lifecycleOrder: [], features: [], hooks: [] };
  const hookMap = new Map((raw.hooks || []).map(group => [group.lifecycle, group]));
  return {
    lifecycleOrder: FULL_HOOK_LIFECYCLE_ORDER.slice(),
    features: (raw.features || []).map(feature => ({
      ...feature,
      tools: feature.tools || [],
    })),
    hooks: FULL_HOOK_LIFECYCLE_ORDER.map((lifecycle) => {
      const existing = hookMap.get(lifecycle);
      if (existing) return existing;
      // 空桶 kind 推导与框架侧 deriveKindForLifecycle 保持一致（三原语命名）
      return {
        lifecycle,
        kind: lifecycle === 'ToolUse' || lifecycle === 'StepFinish'
          ? 'guard'
          : lifecycle === 'ToolResultTransform' ? 'transform' : 'observe',
        entries: [],
      };
    }),
    standaloneTools: raw.standaloneTools || undefined,
  };
}

function setCurrentHookInspector(snapshot) {
  const normalized = normalizeHookInspector(snapshot);
  currentHookInspector = normalized;
  currentHookInspectorSignature = getHookInspectorSignature(normalized);
  if (selectedFeatureName && !normalized.features.some(feature => feature.name === selectedFeatureName)) {
    selectedFeatureName = null;
  }
}

function setCurrentOverviewSnapshot(snapshot) {
  const normalized = normalizeOverviewSnapshot(snapshot);
  currentOverviewSnapshot = normalized;
  currentOverviewSignature = getOverviewSignature(normalized);
}

function setCurrentLogs(logs) {
  currentLogs = Array.isArray(logs) ? logs : [];
  currentLogsSignature = JSON.stringify({
    count: currentLogs.length,
    last: currentLogs.length > 0 ? currentLogs[currentLogs.length - 1].id : null,
  });
}
