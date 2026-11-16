// Global maintenance precedes the focused/no-focus branch exactly as before.
export function createPollCycle(host) {
  async function runPollCycle() {
    try {
      if (host.switching()) { host.schedule(host.fastInterval()); return; }
      if (!host.sseActive() && host.now() - host.lastChoiceCheck() > 3000) {
        host.setChoiceCheck(host.now());
        host.checkChoices().catch(error => host.warn(error));
      }
      host.refreshRemote();
      if (Object.keys(host.templates()).length === 0 && host.now() - host.lastTemplateReload() > 3000) {
        host.setTemplateReload(host.now());
        await host.reloadTemplates();
      }
      if (!host.runtimeId()) {
        await host.noFocus();
        host.schedule(host.interval());
        return;
      }
      await host.runtime();
    } catch (error) {
      host.warn('Polling failed, keeping last known connection state:', error);
      host.schedule(host.interval());
    }
  }
  return { runPollCycle };
}
