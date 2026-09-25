const STATES = Object.freeze({
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

export function createServiceLifecycle() {
  let state = STATES.STARTING;
  let shutdownPromise = null;

  return {
    getState() {
      return state;
    },

    markReady() {
      if (state !== STATES.STARTING) {
        throw new Error(`Cannot mark service ready from state: ${state}`);
      }
      state = STATES.READY;
    },

    markFailed() {
      if (state === STATES.STARTING) state = STATES.FAILED;
    },

    shutdown(cleanup) {
      if (shutdownPromise) return shutdownPromise;
      if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
      state = STATES.STOPPING;
      shutdownPromise = Promise.resolve()
        .then(cleanup)
        .finally(() => {
          state = STATES.STOPPED;
        });
      return shutdownPromise;
    },
  };
}

export { STATES as SERVICE_STATES };
