import { createSessionViewCommit } from './session-view-commit.js';
import { createSessionViewCommitHost } from './session-view-state.js';
import * as identity from './session-view-identity-state.js';
import * as orchestration from './orchestration-state.js';

// 宿主工厂改具名 import（P4 T2 批次）：session-view-state 已进模块相，而本文件是
// kernel-entry 的首条 import——`window.createSessionViewCommitHost()` 在这个时点必然
// 读到 undefined（会话视图域正是经这条边被拉进图的）。原先的 window 抓取依赖
// 「classic 相先注册」的装载序，转换后不再成立。
const policy = createSessionViewCommit({
  ...createSessionViewCommitHost(),
  messagesRevision: () => identity._sessionViewMessagesRevision,
  inputRequestsRevision: () => identity._sessionViewInputRequestsRevision,
  switchEpoch: () => orchestration._switchEpoch,
  generation: () => identity._sessionViewGeneration,
  runtimeId: () => String(orchestration.currentRuntimeAgentId || '').trim(),
  modelRuntimeId: () => identity._sessionViewModelRuntimeId,
});
export const { isSessionViewMessagesCurrent, isSessionViewInputRequestsCurrent,
  isSessionViewTokenCurrent, commitSessionViewState, commitSessionViewPatch } = policy;
window.KernelState.defineKey('session-view-commit', 'isSessionViewInputRequestsCurrent', isSessionViewInputRequestsCurrent);
window.KernelState.defineKey('session-view-commit', 'isSessionViewTokenCurrent', isSessionViewTokenCurrent);
window.KernelState.defineKey('session-view-commit', 'commitSessionViewState', commitSessionViewState);
window.KernelState.defineKey('session-view-commit', 'commitSessionViewPatch', commitSessionViewPatch);
window.KernelState.claim('session-view-commit', {
  get: (key) => policy[key],
  set: (key, value) => { policy[key] = value; },
});
