const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log(msg.text()));
  await page.goto('http://127.0.0.1:1420', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const origRun = window.runWorkspaceAction;
    window.runWorkspaceAction = async (...args) => {
      console.log('DBG run before', JSON.stringify({ currentAgentId, currentRuntimeAgentId, currentWorkspaceTab, args }));
      const result = await origRun(...args);
      console.log('DBG run after', JSON.stringify({ currentAgentId, currentRuntimeAgentId, currentWorkspaceTab }));
      return result;
    };
    const origSwitch = window.switchAgent;
    window.switchAgent = async (...args) => {
      console.log('DBG switch before', JSON.stringify({ currentAgentId, currentRuntimeAgentId, currentWorkspaceTab, args }));
      const result = await origSwitch(...args);
      console.log('DBG switch after', JSON.stringify({ currentAgentId, currentRuntimeAgentId, currentWorkspaceTab }));
      return result;
    };
  });
  const item = page.locator('#prebuilt-agent-list .agent-item').filter({ has: page.locator('.agent-name', { hasText: 'Feature 创建者' }) }).first();
  await item.click();
  await page.waitForTimeout(1000);
  const action = await page.getByRole('button', { name: '进入对话', exact: true }).first().getAttribute('data-workspace-action');
  await page.evaluate(async (a) => { await window.runWorkspaceAction(a); }, action);
  await page.waitForTimeout(5000);
  console.log('FINAL', await page.evaluate(() => JSON.stringify({ currentAgentId, currentRuntimeAgentId, currentWorkspaceTab })));
  await browser.close();
})();
