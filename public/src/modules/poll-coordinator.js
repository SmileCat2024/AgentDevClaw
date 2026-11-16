// One owner for the recursive timer chain. Repeated refresh requests during a
// cycle coalesce into one immediate follow-up, including when that cycle fails.
export function createPollCoordinator(host) {
  let timerId = null;
  let cycleInFlight = null;
  let immediateRequested = false;

  function schedulePoll(delayMs = host.fastInterval()) {
    if (timerId !== null) host.clearTimeout(timerId);
    timerId = host.setTimeout(() => {
      timerId = null;
      poll();
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function poll() {
    if (cycleInFlight) {
      immediateRequested = true;
      return cycleInFlight;
    }
    if (timerId !== null) {
      host.clearTimeout(timerId);
      timerId = null;
    }
    const cycle = host.run();
    cycleInFlight = cycle;
    try {
      return await cycle;
    } finally {
      if (cycleInFlight === cycle) cycleInFlight = null;
      if (immediateRequested) {
        immediateRequested = false;
        schedulePoll(0);
      }
    }
  }

  return { poll, schedulePoll };
}
