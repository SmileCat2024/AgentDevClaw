import { createChatLoading } from './chat-loading.js';
import { _chatLoadingSession, _chatLoadingTimeout, setChatLoadingSession, setChatLoadingTimeout } from './orchestration-state.js';

const loading = createChatLoading({
  loading: () => _chatLoadingSession,
  timer: () => _chatLoadingTimeout,
  setLoading: setChatLoadingSession,
  setTimer: setChatLoadingTimeout,
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: id => window.clearTimeout(id),
  render: () => { if (typeof window.renderCurrentMainView === 'function') window.renderCurrentMainView(); },
});
export const { beginChatLoadingSession, clearChatLoadingSession } = loading;
window.KernelState.defineKey('chat-loading', 'beginChatLoadingSession', beginChatLoadingSession);
window.KernelState.defineKey('chat-loading', 'clearChatLoadingSession', clearChatLoadingSession);
window.KernelState.claim('chat-loading', {
  get: key => loading[key],
  set: (key, value) => { loading[key] = value; },
});
