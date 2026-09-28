import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function sandbox(result) {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/workspace-actions.js');
  ctx.run('var currentLanguage = "zh";');
  ctx.invoke = async () => result;
  return ctx;
}

describe('Studio new conversation directory selection', () => {
  it('opens the existing directory picker before the first conversation', async () => {
    const ctx = sandbox({ path: 'D:\\projects\\feature-a' });
    const action = await ctx.run('resolveStudioSessionDirectory({ id: "agent-studio", workspace_state: { openDirectory: "" } }, { type: "create_session" })');
    assert.equal(action.openDirectory, 'D:\\projects\\feature-a');
  });

  it('cancelling the picker does not create a directory-less session', async () => {
    const ctx = sandbox({ path: '', cancelled: true });
    assert.equal(await ctx.run('resolveStudioSessionDirectory({ id: "agent-studio" }, { type: "create_session" })'), null);
  });

  it('reuses a selected project, including the Continue action, without opening the picker', async () => {
    const ctx = sandbox({ path: '' });
    const current = { type: 'create_session', openDirectory: '/projects/existing' };
    const action = await ctx.run('resolveStudioSessionDirectory({ id: "agent-studio" }, { type: "create_session", openDirectory: "/projects/existing" })');
    assert.equal(action.openDirectory, current.openDirectory);
  });

  it('asks again for a new conversation instead of reusing the last workspace directory', async () => {
    const ctx = sandbox({ path: '/projects/another' });
    const next = await ctx.run('resolveStudioSessionDirectory({ id: "agent-studio", workspace_state: { openDirectory: "/projects/last" } }, { type: "create_session" })');
    assert.equal(next.openDirectory, '/projects/another');
  });
});
