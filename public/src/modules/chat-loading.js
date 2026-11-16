// The loading indicator has a bounded lifetime even when no messages arrive.
export function createChatLoading(host) {
  function beginChatLoadingSession() {
    host.setLoading(true);
    if (host.timer()) host.clearTimeout(host.timer());
    host.setTimer(host.setTimeout(() => {
      host.setLoading(false);
      host.setTimer(null);
      host.render();
    }, 10000));
  }
  function clearChatLoadingSession() {
    if (!host.loading() && !host.timer()) return;
    host.setLoading(false);
    if (host.timer()) {
      host.clearTimeout(host.timer());
      host.setTimer(null);
    }
  }
  return { beginChatLoadingSession, clearChatLoadingSession };
}
