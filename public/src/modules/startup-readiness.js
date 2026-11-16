// Use the original unwrapped transport, including the non-HTTP desktop fallback.
export function createViewerReadiness(host) {
  return async function waitForViewerReady(timeoutMs = 15000) {
    const startedAt = host.now();
    while (host.now() - startedAt < timeoutMs) {
      try {
        const response = await host.fetch(host.url(), { cache: 'no-store' });
        if (response.ok) return true;
      } catch {
        // Startup tolerates temporary Viewer unavailability within this deadline.
      }
      await host.wait(300);
    }
    return false;
  };
}
