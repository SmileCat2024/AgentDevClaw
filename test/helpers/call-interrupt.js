/**
 * Classic call-interrupt owner accessor.
 *
 * The production policy instance is created by the bootstrap IIFE in
 * public/src/app-core.js and exposed through four KernelState bridge keys.
 * This helper no longer builds a second instance; it only verifies the real
 * owner is installed in the given sandbox and returns its production methods.
 */
export function installCallInterruptState(context) {
  const policy = {
    getNotificationCallStartedAt: context.getNotificationCallStartedAt,
    markInterruptPending: context.markInterruptPending,
    isInterruptSuppressed: context.isInterruptSuppressed,
    clearInterruptSuppression: context.clearInterruptSuppression,
  };
  for (const [name, fn] of Object.entries(policy)) {
    if (typeof fn !== 'function') {
      throw new Error(`[test] classic call-interrupt owner missing: ${name}`);
    }
  }
  return policy;
}
