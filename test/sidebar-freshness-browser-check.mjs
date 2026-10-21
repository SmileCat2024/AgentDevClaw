/* global window, document, agentList, allAgents, renderSidebarChildItems, collectRuntimeEntriesForPrebuilt, renderAgentList, ctxRenameSession, threadFacts, refreshThreads */
// Isolated Chromium check of real sidebar rendering, inline editing and thread commits.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="agent-list"></div>');
  await page.evaluate(() => {
    Object.assign(window, {
      currentLanguage: 'zh', focusedAgentId: null, currentRuntimeAgentId: null,
      allAgents: [], currentMessages: [],
      pendingPrebuiltAgentIds: new Set(), restartingRuntimeIds: new Set(),
      _recentlyFinishedRuntimes: new Set(), _agentCallActive: new Map(),
      agentList: document.getElementById('agent-list'),
      externalAgentList: document.createElement('div'), externalGroup: document.createElement('div'), externalCount: document.createElement('div'),
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
      getParentAgentId: (agent) => agent.parent_id,
      getActiveSessionId: (agent) => agent.active_workspace_session_id,
      toEpochMs: (value) => Date.parse(value || '') || 0,
      groupConnectedAgents: () => ({ external: [] }),
      updateCurrentAgentChrome() {}, renderCurrentMainView() {},
      isRuntimeItemActive: () => false,
      escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
      t: (key) => key,
      lastRenderedWorkspaceHtml: '',
    });
    window.ClawSidebarLayout = {
      isInteracting: () => false, signature: () => 'fixture',
      render() { agentList.innerHTML = renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0], allAgents), allAgents[0].id); },
    };
    window.threadFacts = [];
    window.fetch = async (_url, options) => ({ ok: true, json: async () => options?.method === 'PUT'
      ? { ok: true, title: JSON.parse(options.body).title, sessionDelta: { revision: 2, upsert: [{ id: 's1', title: JSON.parse(options.body).title }] } }
      : { threads: window.threadFacts } });
  });
  for (const name of ['project-data', 'session-ui', 'sidebar-operations', 'runtime-status', 'thread-store', 'sidebar-render', 'ctx-menu-items']) {
    await page.addScriptTag({ content: await fs.readFile(`public/src/modules/${name}.js`, 'utf8') });
  }
  await page.evaluate(() => {
    window.allAgents = [
      { id: 'programming-helper', source: 'prebuilt', workspace_sessions: { revision: 1, sessions: [{ id: 's1', title: 'Old' }] } },
      { id: 'r1', runtime_session_id: 'r1', source: 'child', parent_id: 'programming-helper', active_workspace_session_id: 's1', active_workspace_session_title: 'Old', connected: true },
    ];
    renderAgentList();
    ctxRenameSession({ ns: 'programming-helper', id: 'r1', sessionId: 's1' });
  });
  const input = page.locator('.agent-name-edit-input');
  await input.fill('Saved title');
  await page.evaluate(() => { allAgents[1].connected = false; renderAgentList(); });
  assert.equal(await input.inputValue(), 'Saved title', 'background update must preserve editing DOM');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('.agent-name')?.textContent === 'Saved title');
  await page.evaluate(() => renderAgentList());
  assert.equal(await page.locator('.agent-name').textContent(), 'Saved title');
  console.log('PASS Enter rename and background refresh preserve the saved title in real DOM');

  await page.evaluate(async () => {
    allAgents[0].id = 'coder';
    allAgents[1].parent_id = 'coder';
    window.threadFacts = [{ threadId: 't1', agentId: 'coder', headSessionId: 's1', sessionIds: ['s1'], title: 'Thread', status: 'open', lifeState: 'executing', headRuntimeRunning: true }];
    await refreshThreads(true);
    window.allAgents = [allAgents[0]];
    renderAgentList();
  });
  assert.equal(await page.locator('.agent-runtime-item.disconnected').count(), 1);
  await page.evaluate(async () => {
    window.threadFacts = [{ ...threadFacts[0], archivedAt: 1, lifeState: 'archived', headRuntimeRunning: false }];
    await refreshThreads(true);
  });
  assert.equal(await page.locator('.agent-runtime-item').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS archive fact commit removes the ghost without navigation or a page refresh');
} finally {
  await browser.close();
}
