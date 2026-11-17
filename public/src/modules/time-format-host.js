import { createTimeFormat } from './time-format.js';
import { getCurrentLanguage } from './i18n-environment-state.js';

const formatters = createTimeFormat(getCurrentLanguage);
export const { formatWorkspaceDate, formatRelativeTime, getTimeGroupLabel,
  getSessionRecencyClass, getSessionShortTime } = formatters;
window.KernelState.defineKey('time-format', 'formatWorkspaceDate', formatWorkspaceDate);
window.KernelState.defineKey('time-format', 'formatRelativeTime', formatRelativeTime);
window.KernelState.claim('time-format', {
  get: (key) => formatters[key],
  set: (key, value) => { formatters[key] = value; },
});
