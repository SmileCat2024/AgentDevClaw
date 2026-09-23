import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const appUiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');

describe('right panel registry', () => {
  it('registers panels and filters by all declared context dimensions', () => {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/right-panel-registry.js');

    ctx.run(`
      window.ClawPanels.register('chat-tools', {
        title: 'Chat tools',
        when: { surfaces: ['chat'], agentIds: ['programming-helper'] },
        render: () => 'chat'
      });
      window.ClawPanels.register('group-tools', {
        title: 'Group tools',
        when: { agentIds: ['work-group'] },
        render: () => 'group'
      });
      window.ClawPanels.register('global-tools', {
        title: 'Global tools',
        render: () => 'global'
      });
    `);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run(`window.ClawPanels.getAvailable({ surface: 'chat', agentId: 'programming-helper' }).map(({ id }) => id)`))),
      ['chat-tools', 'global-tools'],
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run(`window.ClawPanels.getAvailable({ surface: 'workspace', agentId: 'work-group' }).map(({ id }) => id)`))),
      ['group-tools', 'global-tools'],
    );
  });

  it('rejects duplicate IDs rather than silently replacing a panel', () => {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/right-panel-registry.js');
    ctx.run(`window.ClawPanels.register('stable-id', { title: 'First', render: () => '' })`);

    assert.throws(
      () => ctx.run(`window.ClawPanels.register('stable-id', { title: 'Second', render: () => '' })`),
      /already registered/,
    );
    assert.equal(ctx.run(`window.ClawPanels.get('stable-id').title`), 'First');
  });

  it('treats absent context values as non-matching for constrained panels', () => {
    const ctx = createFrontendSandbox();
    ctx.loadSource('public/src/modules/right-panel-registry.js');
    ctx.run(`window.ClawPanels.register('agent-only', {
      title: 'Agent only', when: { agentIds: ['work-group'] }, render: () => ''
    })`);

    assert.deepEqual(
      JSON.parse(JSON.stringify(ctx.run(`window.ClawPanels.getAvailable({ surface: 'workspace' }).map(({ id }) => id)`))),
      [],
    );
  });

  it('declares chat panels and work-group panels through the host registry', () => {
    const registrations = sourceBetween(
      appUiSource,
      "registerFeaturePanel('workspace'",
      '// Sidebar Toggle + narrow-width drawer backdrop',
    );
    assert.match(registrations, /when: \{ surfaces: \['chat'\] \}/);
    assert.match(registrations, /when: \{ agentIds: \['work-group'\] \}/);

    const resourceModule = fs.readFileSync(new URL('../public/src/modules/resources-viewer.js', import.meta.url), 'utf8');
    assert.match(resourceModule, /window\.registerFeaturePanel\('resources'/);
    assert.match(resourceModule, /window\.registerFeaturePanel\('viewer'/);
  });

  it('filters the rail from registered panel availability and closes an unavailable active panel', () => {
    const rendering = sourceBetween(
      appUiSource,
      'function renderCurrentMainView(',
      '  ensureChatViewportObservers();',
    );
    assert.match(rendering, /window\.ClawPanels\.getAvailable/);
    assert.match(rendering, /availablePanelIds\.has\(panelId\)/);
    assert.match(rendering, /activePanelBecameUnavailable/);
    assert.match(rendering, /renderFeaturePanel\(\)/);
  });
});
