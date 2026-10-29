/* global window, document, currentRuntimeAgentId: writable, focusedAgentId: writable, allAgents: writable,
  applySessionViewPatch, updateNotificationStatus, resolveInputSurfaceMode, readInputSurfaceModeState,
  readCurrentSessionViewState, isChatSurfaceActive */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Isolated UI integration: real composer, notifications, submission and interrupt
// modules; controlled transport only. Never connects to an existing Claw instance.
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  const errors = [];
  const writes = [];
  let rejectInput = false;
  page.on('pageerror', (error) => errors.push(error.message));
  const html = (await fs.readFile('public/index.html', 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  await page.route('http://claw.test/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      return route.fulfill({ contentType: 'application/json',
        status: path.endsWith('/input') && rejectInput ? 404 : 200,
        body: JSON.stringify(path.endsWith('/input') && rejectInput
          ? { error: 'Request not found or expired' } : { success: true }) });
    }
    if (path.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  async function mount() {
    for (const name of ['base', 'layout', 'components', 'app-chat-input']) {
      await page.addStyleTag({ content: await fs.readFile(`public/styles/${name}.css`, 'utf8') });
    }
    await page.addScriptTag({ content: await fs.readFile('node_modules/marked/lib/marked.umd.js', 'utf8') });
    for (const name of ['app-core', 'modules/markdown-utils', 'modules/session-view-state']) {
      await page.addScriptTag({ content: await fs.readFile(`public/src/${name}.js`, 'utf8') });
    }
    await page.evaluate(() => {
      currentRuntimeAgentId = 'wakeup-runtime'; focusedAgentId = 'fixture';
      allAgents = [{ id: 'fixture', source: 'prebuilt', runtime_session_id: 'wakeup-runtime',
        active_workspace_session_id: 'session-1' }];
      window.t = (key) => key;
      window.isChatSurfaceActive = () => true;
      window.normalizeAgentIdentity = (id) => String(id || '').trim();
      window._getSessionInputCacheKey = () => 'fixture/session-1';
      window.setInterval = () => 0;
      for (const name of ['setCurrentHookInspector', 'setCurrentOverviewSnapshot', 'setCurrentTodoPlan',
        'renderAgentList', '_markAgentCallStartedForNotify', '_clearRecapForNewMessage',
        '_requestNotifyPermission', 'updateInputModelSwitcher', 'updateThinkingEffortSwitcher',
        'notifyChatViewportMutation', 'beginFollowLatestEntryWindow', 'requestFollowLatest',
        '_injectPendingVoiceResult', '_renderRecapHint', 'poll']) window[name] = () => {};
      window.runWithSuppressedChatViewportObservers = (fn) => fn();
      window._shouldPreserveVoiceInputForRender = () => false;
      window.isChoiceInputRequest = () => false;
      window.isChoiceInputConsumed = () => false;
      window.isChoiceInputRejected = () => false;
      window._voiceRecording = false; window._voiceStopping = false; window._voiceTranscribing = false;
      window._voicePendingSend = false; window._rollbackDialogOpen = false; window._recapPendingTrigger = false;
      window._partialCompactInFlight = false; window._partialCompactRuntimeId = null;
      window._partialCompactContextKey = null; window._compactTimerInterval = null;
      window.ClawToast = { show: (toast) => { window.lastToast = toast; } };
      window.ClawFW = { pushOptimisticUserEcho: (echo) => { window.lastEcho = echo; } };
    });
    for (const name of ['persistent-input', 'input-helpers', 'input-composer', 'input-render', 'runtime-status']) {
      await page.addScriptTag({ content: await fs.readFile(`public/src/modules/${name}.js`, 'utf8') });
    }
    await page.evaluate(() => {
      window.ensureChatRuntimeIndicator = () => {};
      window.getInputSurfaceMode = (requests = readCurrentSessionViewState().inputRequests) =>
        resolveInputSurfaceMode(readInputSurfaceModeState(requests, isChatSurfaceActive()));
      // Identity changes intentionally clear old session data; hydrate the lease
      // only after establishing the selected session, as the real loader does.
      applySessionViewPatch({ identity: { agentId: 'fixture', sessionId: 'session-1' } });
      applySessionViewPatch({ connected: true, inputRequests: [{ requestId: 'waiting-lease' }] });
    });
  }
  const running = { callActive: true, runtime: { callActive: true, callStartedAt: 100 } };
  const waiting = { callActive: false, runtime: { callActive: false,
    lastOutcome: { status: 'continued', reason: 'suspended' } } };
  const notify = (payload) => page.evaluate((value) => updateNotificationStatus(value), payload);
  const button = page.locator('.persistent-action-btn');
  const stopVisible = () => button.locator('.icon-stop').isVisible();

  await page.goto('http://claw.test/');
  await mount();
  await notify(waiting);
  assert.equal(await stopVisible(), false, 'waiting keeps send');
  await notify(running);
  assert.equal(await stopVisible(), true, 'background wakeup displays interrupt');
  await button.click();
  assert.equal(writes.at(-1).path, '/api/agents/wakeup-runtime/interrupt');
  assert.equal(await button.getAttribute('aria-busy'), 'true');
  await notify(running);
  assert.equal(await button.evaluate((el) => el.classList.contains('is-interrupting')), true);
  await notify({ callActive: false, state: { type: 'call.finish', timestamp: 200,
    data: { status: 'cancelled', reason: 'interrupted' } }, runtime: { callActive: false } });
  assert.equal(await stopVisible(), false);

  // Reload from a fresh DOM while the backend is already running, with a lease
  // snapshot arriving independently of notification state.
  await page.reload();
  await mount();
  await notify(running);
  assert.equal(await stopVisible(), true, 'reload restores running control with a text lease');
  rejectInput = true;
  await page.locator('.user-input-textarea').fill('follow-up while running');
  await button.click();
  try {
    await page.waitForFunction(() => window.lastToast?.status === 'error', null, { timeout: 1500 });
  } catch (error) {
    throw new Error(JSON.stringify({ writes, errors, state: await page.evaluate(() => ({
      toast: window.lastToast, value: document.querySelector('.user-input-textarea').value,
      button: document.getElementById('persistent-action-btn').outerHTML,
    })) }), { cause: error });
  }
  assert.equal(writes.at(-1).path, '/api/agents/wakeup-runtime/input');
  assert.equal(writes.at(-1).body.response.text, 'follow-up while running');
  assert.equal(await page.locator('.user-input-textarea').inputValue(), 'follow-up while running');
  assert.equal(await page.evaluate(() => window.lastEcho ?? null), null);
  await page.waitForFunction(() => !document.getElementById('persistent-action-btn').classList.contains('is-sending'));
  assert.equal(await stopVisible(), true, 'failed submission restores running control');

  rejectInput = false;
  await button.click();
  await page.waitForFunction(() => document.querySelector('.user-input-textarea').value === '');
  assert.equal(await page.evaluate(() => window.lastEcho.text), 'follow-up while running');
  assert.equal(writes.filter((write) => write.path.endsWith('/input')).length, 2, 'one rejected attempt and one retry');
  assert.deepEqual(errors, []);
  console.log('PASS waiting → background wakeup → interrupt; reload during call; rejected input preserved with error; successful retry');
} finally {
  await browser.close();
}
