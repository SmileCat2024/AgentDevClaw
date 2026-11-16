import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const DOMAIN = 'render-entry';
const MODULE = 'public/src/modules/render-entry-state.js';
const INITIAL = {
  activeFeaturePanel: null,
  currentWorkspaceTab: null,
  shouldAnimateWorkspaceSurface: true,
  lastRenderedWorkspaceHtml: '',
  lastRenderedWorkspaceScrollKey: '',
  workspaceSurfaceScrollSaveRaf: 0,
  _lastRenderedChatSig: '',
  currentWorkspaceArtifactDetail: null,
  currentWorkspaceDocsetDetail: null,
  currentProjectDocsetOpen: false,
  currentProjectRequirementEdit: null,
  currentProjectDocsetPage: 'requirement',
  unitModePreferences: {},
};

async function setup() {
  const cleanup = installBrowserStubs();
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  for (const [key, value] of Object.entries(INITIAL)) window.KernelState.defineKey(DOMAIN, key, value);
  return { cleanup };
}

function cleanupKeys() {
  for (const key of Object.keys(INITIAL)) delete window[key];
  delete window.KernelState;
}

test('render-entry claim absorbs early state and preserves object references', async () => {
  const { cleanup } = await setup();
  try {
    const artifact = { id: 'artifact-1' };
    const preferences = { studio: 'home' };
    window.currentWorkspaceArtifactDetail = artifact;
    window.unitModePreferences = preferences;
    window.activeFeaturePanel = 'workspace';

    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    assert.strictEqual(module.currentWorkspaceArtifactDetail, artifact);
    assert.strictEqual(module.unitModePreferences, preferences);
    assert.equal(module.activeFeaturePanel, 'workspace');
  } finally {
    cleanupKeys();
    cleanup();
  }
});

test('render-entry state is live across classic and ESM writes, including object replacements', async () => {
  const { cleanup } = await setup();
  try {
    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    window.activeFeaturePanel = 'plan';
    assert.equal(module.activeFeaturePanel, 'plan');
    module.setCurrentWorkspaceTab('assembly');
    assert.equal(window.currentWorkspaceTab, 'assembly');

    const timer = setTimeout(() => {}, 10000);
    try {
      window.workspaceSurfaceScrollSaveRaf = timer;
      assert.strictEqual(module.workspaceSurfaceScrollSaveRaf, timer);
      const detail = { revision: 2 };
      module.setCurrentWorkspaceDocsetDetail(detail);
      assert.strictEqual(window.currentWorkspaceDocsetDetail, detail);
      const preferences = { coder: 'threads' };
      window.unitModePreferences = preferences;
      assert.strictEqual(module.unitModePreferences, preferences);
      module.setLastRenderedWorkspaceHtml('<main>ready</main>');
      assert.equal(window.lastRenderedWorkspaceHtml, '<main>ready</main>');
    } finally {
      clearTimeout(timer);
    }
  } finally {
    cleanupKeys();
    cleanup();
  }
});
