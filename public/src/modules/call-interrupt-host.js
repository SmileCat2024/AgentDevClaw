// Late-bound adapter over the classic call-interrupt sync owner in app-core.js.
// The owner registers the four KernelState bridge keys; this module never
// initializes, claims, or re-registers anything. Classic consumers keep using
// the same accessors, so ESM and classic share one policy instance.

export function getNotificationCallStartedAt(...args) {
  return window.getNotificationCallStartedAt(...args);
}

export function markInterruptPending(...args) {
  return window.markInterruptPending(...args);
}

export function isInterruptSuppressed(...args) {
  return window.isInterruptSuppressed(...args);
}

export function clearInterruptSuppression(...args) {
  return window.clearInterruptSuppression(...args);
}
