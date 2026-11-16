// Called only after the existing authentication promise settles. First paint
// and foreground listeners remain installed synchronously by classic bootstrap.
export function createApplicationStartup(host) {
  async function startApplication() {
    await host.waitViewer();
    const templatesLoaded = await host.loadTemplates();
    await host.loadAgents();
    await host.consumeDesktopOpen();
    if (!templatesLoaded) {
      host.log('[Viewer] Retrying to load feature templates after agent loaded...');
      await host.reloadTemplates();
    }
    await host.loadMcp(false);
    host.poll();
  }
  return { startApplication };
}
