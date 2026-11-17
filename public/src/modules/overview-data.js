/**
 * overview-data.js — Overview 数据规范化模块（从 app-ui.js 域 K-a 提取）
 *
 * 包含：
 *   - shortenSourcePath: 缩短源文件路径（纯工具函数）
 *   - FULL_HOOK_LIFECYCLE_ORDER: hook 生命周期顺序常量
 *   - getHookInspectorSignature / getOverviewSignature: JSON 签名（去重用）
 *   - getEmptyOverviewSnapshot: 空 overview 模板
 *   - extractMessagesProbe: 提取 /overview 响应上的消息增量探测字段（ADR-0012）
 *   - normalizeRuntimeSnapshot / normalizeOverviewSnapshot: runtime & overview 快照规范化
 *   - normalizeHookInspector: hook inspector 快照规范化
 *   - setCurrentHookInspector / setCurrentOverviewSnapshot: 全局状态 setter
 *
 * ESM（P2 迁移）：快照状态 owner 已迁 session-view-storage（inspector / overview
 * 及其签名，直接 import 读写）；日志与 feature 选择仍在 classic 首屏边界
 * （app-core 顶层 let），经 p2-bootstrap-debug-panel 适配模块成对读写，不持副本。
 * 仍 classic 的 window 可达函数（normalizeSessionModelState）晚绑定调用。
 * 仍有 classic 消费方的入口经 KernelState 桥键（overview-data 域）提供，
 * 文件尾部统一注册。
 */

import {
  setCurrentHookInspector as setHookInspectorSnapshot,
  setCurrentHookInspectorSignature,
  setCurrentOverviewSnapshot as setOverviewSnapshot,
  setCurrentOverviewSignature,
} from './session-view-storage.js';
import { debugPanel } from './p2-bootstrap-debug-panel.js';

export function shortenSourcePath(value) {
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

export function getHookInspectorSignature(snapshot) {
  return JSON.stringify(snapshot || { lifecycleOrder: [], features: [], hooks: [] });
}

export function getEmptyOverviewSnapshot() {
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
    // 桥接期：定义于 session-view-state（会话视图域收敛时移除）
    ...window.normalizeSessionModelState(null),
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

// ADR-0012：消息增量探测的合法变更分类。ViewerWorker 在推送时刻算好挂在
// /overview 响应上，前端按分类决定取数方式（零请求 / ?since / ?tail=1 / 全量）。
const MESSAGE_PROBE_CHANGE_KINDS = new Set(['append', 'tail', 'rewrite']);

/**
 * Extract the messages probe (ADR-0012) from a raw /overview response body.
 *
 * The probe never travels through normalizeOverviewSnapshot — it is read
 * separately here by the poll data path and stays out of the view snapshot.
 * Returns null when the probe is absent or malformed (poll falls back to a
 * full /messages fetch in that case).
 */
export function extractMessagesProbe(snapshot) {
  const raw = snapshot && typeof snapshot === 'object' ? snapshot._messagesProbe : null;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (!Number.isInteger(raw.count) || raw.count < 0) {
    return null;
  }
  if (raw.changeKind !== null && !MESSAGE_PROBE_CHANGE_KINDS.has(raw.changeKind)) {
    return null;
  }
  return {
    // seq（ADR-0012 v2）：同步版本号，真实变更时单调递增。前端与已应用
    // 的 seq 对账决定是否取数——缺失（旧 viewer）按 0 处理，行为退化为
    // "count 变化才取数"，仍是安全的。
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
    count: raw.count,
    changeKind: raw.changeKind,
    sinceIndex: Number.isInteger(raw.sinceIndex) && raw.sinceIndex >= 0 ? raw.sinceIndex : null,
    fakeFullBytes: typeof raw.fakeFullBytes === 'number' && raw.fakeFullBytes >= 0 ? raw.fakeFullBytes : 0,
  };
}

// normalizeOverviewSnapshot builds the view snapshot field by field, so
// unknown payload keys such as _messagesProbe are dropped by construction:
// the probe is extracted separately via extractMessagesProbe() at the poll
// data-fetch site and never enters the view snapshot — which also keeps
// getOverviewSignature() identical with and without the probe attached.
export function normalizeOverviewSnapshot(snapshot) {
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
    // 桥接期：定义于 session-view-state（会话视图域收敛时移除）
    ...window.normalizeSessionModelState(snapshot),
  };
}

export function getOverviewSignature(snapshot) {
  return JSON.stringify(normalizeOverviewSnapshot(snapshot));
}

export function normalizeHookInspector(snapshot) {
  const raw = snapshot || { lifecycleOrder: [], features: [], hooks: [] };
  const hookMap = new Map((raw.hooks || []).map(group => [group.lifecycle, group]));
  return {
    lifecycleOrder: FULL_HOOK_LIFECYCLE_ORDER.slice(),
    features: (raw.features || []).map(feature => ({
      ...feature,
      tools: feature.tools || [],
      skills: Array.isArray(feature.skills) ? feature.skills.filter(skill => skill
        && typeof skill.name === 'string' && typeof skill.path === 'string'
        && Number.isInteger(skill.root) && skill.root >= 0
        && !skill.path.startsWith('/') && !skill.path.includes('\\') && !/^[A-Za-z]:/.test(skill.path)
        && !skill.path.split('/').some(part => /^[A-Za-z]:/.test(part))
        && !skill.path.split('/').some(part => part === '..' || part === '.' || !part)).map(skill => ({
        name: skill.name,
        description: typeof skill.description === 'string' ? skill.description : '',
        path: skill.path,
        root: skill.root,
      })) : [],
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

export function setCurrentHookInspector(snapshot) {
  const normalized = normalizeHookInspector(snapshot);
  setHookInspectorSnapshot(normalized);
  setCurrentHookInspectorSignature(getHookInspectorSignature(normalized));
  if (debugPanel.selectedFeatureName
      && !normalized.features.some(feature => feature.name === debugPanel.selectedFeatureName)) {
    debugPanel.selectedFeatureName = null;
  }
}

export function setCurrentOverviewSnapshot(snapshot) {
  const normalized = normalizeOverviewSnapshot(snapshot);
  setOverviewSnapshot(normalized);
  setCurrentOverviewSignature(getOverviewSignature(normalized));
}

// 日志快照写入（setCurrentLogs）不在本模块：它的唯一实现是 classic app-core 的
// 同名同步函数（currentLogs / currentLogsSignature 的物理 owner）。日志面板的
// onOpen 入口在首屏 classic 相就可点，写入口必须在 classic 相同步可用，因此
// 不迁到这里，也不上桥（不保留双实现）。

// ── 兼容桥（KernelState，overview-data 域）─────────────────────────────────────
// 仍有 classic 消费方的入口逐键上桥：
//   getHookInspectorSignature  ← app-main.js（metadata commit host.hookSignature）
//   getEmptyOverviewSnapshot   ← session-view-state.js（applySessionViewPatch 身份变化）
//                                / app-main.js / app-ui.js（debug-overview 已 import 本模块）
//   extractMessagesProbe       ← app-main.js（消息 probe host.probe）
//   normalizeOverviewSnapshot  ← app-main.js（overview 提交）
//   getOverviewSignature       ← app-main.js（overview 签名）
//   normalizeHookInspector     ← app-main.js（inspector 提交）
//   setCurrentHookInspector    ← session-view-state.js（applySessionViewPatch）
//   setCurrentOverviewSnapshot ← session-view-state.js（applySessionViewPatch）
//   shortenSourcePath          ← debug-features-hooks.js（feature 卡片/详情/条目来源，3 处裸调用；
//                                该文件仍是 classic，不能按“已 import”判断为零消费）
// FULL_HOOK_LIFECYCLE_ORDER / normalizeRuntimeSnapshot 只在本文件内使用，不上桥。
const compatibility = {
  shortenSourcePath,
  getHookInspectorSignature,
  getEmptyOverviewSnapshot,
  extractMessagesProbe,
  normalizeOverviewSnapshot,
  getOverviewSignature,
  normalizeHookInspector,
  setCurrentHookInspector,
  setCurrentOverviewSnapshot,
};
window.KernelState.defineKey('overview-data', 'shortenSourcePath', shortenSourcePath);
window.KernelState.defineKey('overview-data', 'getHookInspectorSignature', getHookInspectorSignature);
window.KernelState.defineKey('overview-data', 'getEmptyOverviewSnapshot', getEmptyOverviewSnapshot);
window.KernelState.defineKey('overview-data', 'extractMessagesProbe', extractMessagesProbe);
window.KernelState.defineKey('overview-data', 'normalizeOverviewSnapshot', normalizeOverviewSnapshot);
window.KernelState.defineKey('overview-data', 'getOverviewSignature', getOverviewSignature);
window.KernelState.defineKey('overview-data', 'normalizeHookInspector', normalizeHookInspector);
window.KernelState.defineKey('overview-data', 'setCurrentHookInspector', setCurrentHookInspector);
window.KernelState.defineKey('overview-data', 'setCurrentOverviewSnapshot', setCurrentOverviewSnapshot);
window.KernelState.claim('overview-data', {
  get: (key) => compatibility[key],
  set: (key, value) => { compatibility[key] = value; },
});
