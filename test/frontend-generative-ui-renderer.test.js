import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { createDomHarness } from './helpers/dom-harness.js';

function makeSpec() {
  return {
    schemaVersion: 1,
    catalogVersion: 'v1',
    title: 'Deployment settings',
    root: 'root',
    elements: {
      root: { type: 'Stack', props: { gap: 'md' }, children: ['title', 'limit', 'details', 'environment', 'enabled', 'mode', 'submit-filtered', 'submit-all'] },
      title: { type: 'TextInput', props: { name: 'title', label: 'Title' }, children: [] },
      limit: { type: 'NumberInput', props: { name: 'limit', label: 'Limit' }, children: [] },
      details: { type: 'Textarea', props: { name: 'details', label: 'Details' }, children: [] },
      environment: { type: 'Select', props: { name: 'environment', label: 'Environment', options: [{ value: 'dev', label: 'Development' }, { value: 'prod', label: 'Production' }] }, children: [] },
      enabled: { type: 'Checkbox', props: { name: 'enabled', label: 'Enabled' }, children: [] },
      mode: { type: 'RadioGroup', props: { name: 'mode', label: 'Mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, children: [] },
      'submit-filtered': { type: 'Button', props: { label: 'Save title', actionId: 'filtered' }, children: [] },
      'submit-all': { type: 'Button', props: { label: 'Save all', actionId: 'all' }, children: [] },
    },
    initialValues: {
      title: 'Initial title',
      limit: 12,
      details: 'Already configured',
      environment: 'prod',
      enabled: true,
      mode: 'safe',
    },
    actions: {
      filtered: { intent: 'submit', label: 'Save title', includeFields: ['title', 'enabled', 'mode'] },
      all: { intent: 'submit', label: 'Save all' },
    },
  };
}

describe('Generative UI renderer submission values', () => {
  it('submits untouched initialValues and current control values, not only dirty overrides', () => {
    const dom = createDomHarness();
    const submissions = [];
    const ctx = createFrontendSandbox({
      document: dom.document,
      captureSubmit: (actionId, fields) => submissions.push({ actionId, fields }),
    });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = JSON.stringify(makeSpec());
    const root = ctx.run(`window.renderGenUISpec(${spec}, window.__viewState = {}, {
      onSubmit: (actionId, _action, fields) => captureSubmit(actionId, fields)
    })`);

    const buttons = dom.findAll(root, '.gen-ui-button');
    const nativeSelect = dom.findAll(root, '.gen-ui-select')[0];
    assert.equal(nativeSelect.classList.contains('settings-input'), true);
    assert.equal(nativeSelect.dataset.genUiSelect, 'true');
    assert.equal(nativeSelect.dataset.clawSelect, 'true');
    buttons[0].dispatch('click');
    assert.deepEqual(JSON.parse(JSON.stringify(submissions[0])), {
      actionId: 'filtered',
      fields: { title: 'Initial title', enabled: true, mode: 'safe' },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.run('window.__viewState'))), {});

    const textInput = dom.findAll(root, '.gen-ui-input').find((element) => element.type === 'text');
    const numberInput = dom.findAll(root, '.gen-ui-input').find((element) => element.type === 'number');
    textInput.value = 'Edited title';
    textInput.dispatch('input');
    numberInput.value = '';
    numberInput.dispatch('input');
    buttons[1].dispatch('click');

    assert.deepEqual(JSON.parse(JSON.stringify(submissions[1])), {
      actionId: 'all',
      fields: {
        title: 'Edited title',
        limit: null,
        details: 'Already configured',
        environment: 'prod',
        enabled: true,
        mode: 'safe',
      },
    });
  });

  it('renders the first extension batch, preserves its value types, and gates confirmed actions', () => {
    const dom = createDomHarness();
    const submissions = [];
    const confirmations = [];
    const ctx = createFrontendSandbox({
      document: dom.document,
      captureSubmit: (actionId, fields) => submissions.push({ actionId, fields }),
      captureConfirmation: (actionId, action, fields, execute) => confirmations.push({ actionId, action, fields, execute }),
    });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Release controls',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['alert', 'progress', 'code', 'date', 'volume', 'notify', 'density', 'apply'] },
        alert: { type: 'Alert', props: { variant: 'warning', title: 'Review before release', description: 'A confirmation is required.' }, children: [] },
        progress: { type: 'Progress', props: { label: 'Readiness', value: 65 }, children: [] },
        code: { type: 'CodeBlock', props: { title: 'Preview', language: 'json', code: '{"safe": true}' }, children: [] },
        date: { type: 'DateInput', props: { name: 'releaseDate', label: 'Release date' }, children: [] },
        volume: { type: 'Slider', props: { name: 'rollout', label: 'Rollout', min: 0, max: 100, step: 5 }, children: [] },
        notify: { type: 'Switch', props: { name: 'notify', label: 'Notify subscribers', description: 'Send a release notification.' }, children: [] },
        density: {
          type: 'SegmentedControl',
          props: { name: 'density', label: 'Density', options: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }] },
          children: [],
        },
        apply: { type: 'Button', props: { label: 'Apply release', actionId: 'apply' }, children: [] },
      },
      initialValues: { releaseDate: '2026-08-05', rollout: 25, notify: true, density: 'comfortable' },
      actions: {
        apply: {
          intent: 'submit',
          label: 'Apply release',
          confirm: { title: 'Apply this release?', description: 'The rollout settings will be sent to the Agent.', confirmLabel: 'Apply' },
        },
      },
    };
    const root = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, window.__expandedViewState = {}, {
      onSubmit: (actionId, _action, fields) => captureSubmit(actionId, fields),
      onConfirm: (actionId, action, fields, execute) => captureConfirmation(actionId, action, fields, execute)
    })`);

    assert.equal(dom.findAll(root, '.gen-ui-alert').length, 1);
    assert.equal(dom.findAll(root, '.gen-ui-progress-indicator')[0].style.width, '65%');
    assert.equal(dom.findAll(root, '.gen-ui-code-block').length, 1);
    assert.equal(dom.findAll(root, '.gen-ui-date-input')[0].value, '2026-08-05');
    assert.equal(dom.findAll(root, '.gen-ui-slider')[0].value, 25);
    assert.equal(dom.findAll(root, '.gen-ui-switch-input')[0].checked, true);
    assert.equal(dom.findAll(root, '.gen-ui-segmented-option')[0].classList.contains('is-selected'), true);

    const date = dom.findAll(root, '.gen-ui-date-input')[0];
    const slider = dom.findAll(root, '.gen-ui-slider')[0];
    const toggle = dom.findAll(root, '.gen-ui-switch-input')[0];
    date.value = '2026-09-01';
    date.dispatch('input');
    slider.value = '40';
    slider.dispatch('input');
    toggle.checked = false;
    toggle.dispatch('change');
    dom.findAll(root, '.gen-ui-segmented-option')[1].dispatch('click');
    dom.findAll(root, '.gen-ui-button')[0].dispatch('click');

    assert.equal(submissions.length, 0, 'confirmation must run before dispatch');
    assert.equal(confirmations.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(confirmations[0].fields)), {
      releaseDate: '2026-09-01',
      rollout: 40,
      notify: false,
      density: 'compact',
    });
    confirmations[0].execute();
    assert.deepEqual(JSON.parse(JSON.stringify(submissions[0])), {
      actionId: 'apply',
      fields: {
        releaseDate: '2026-09-01',
        rollout: 40,
        notify: false,
        density: 'compact',
      },
    });
  });

  it('places carousel navigation below the viewport instead of overlaying slide content', () => {
    const dom = createDomHarness();
    const ctx = createFrontendSandbox({ document: dom.document });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Carousel navigation',
      root: 'root',
      elements: {
        root: { type: 'Carousel', props: {}, children: ['first', 'second'] },
        first: { type: 'Text', props: { content: 'First slide' }, children: [] },
        second: { type: 'Text', props: { content: 'Second slide' }, children: [] },
      },
    };

    const carousel = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);
    const viewport = dom.findAll(carousel, '.gen-ui-carousel-viewport')[0];
    const navigation = dom.findAll(carousel, '.gen-ui-carousel-navigation')[0];
    const buttons = dom.findAll(carousel, '.gen-ui-carousel-btn');

    assert.equal(navigation.parentNode, carousel);
    assert.notEqual(navigation.parentNode, viewport);
    assert.equal(dom.findAll(navigation, '.gen-ui-carousel-position')[0].textContent, '1 / 2');
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[1].disabled, false);
  });

  it('hides inactive tab panels even when they are layout containers', () => {
    const dom = createDomHarness();
    const ctx = createFrontendSandbox({ document: dom.document });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Tab visibility',
      root: 'tabs',
      elements: {
        tabs: { type: 'Tabs', props: { items: [{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }] }, children: ['first', 'second'] },
        first: { type: 'Stack', props: {}, children: ['firstText'] },
        second: { type: 'Stack', props: {}, children: ['secondText'] },
        firstText: { type: 'Text', props: { content: 'First content' }, children: [] },
        secondText: { type: 'Text', props: { content: 'Second content' }, children: [] },
      },
    };

    const tabs = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);
    const panels = dom.findAll(tabs, '.gen-ui-tab-panel');
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[1].hidden, true);
    dom.findAll(tabs, '.gen-ui-tab-button')[1].dispatch('click');
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[1].hidden, false);
  });

  it('wraps rows by default and gives grids an overflow-safe column template for the narrow side panel', () => {
    const dom = createDomHarness();
    const ctx = createFrontendSandbox({ document: dom.document });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Narrow panel layout',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['row', 'grid'] },
        row: { type: 'Row', props: {}, children: ['first', 'second'] },
        first: { type: 'TextInput', props: { name: 'first', label: 'First field' }, children: [] },
        second: { type: 'TextInput', props: { name: 'second', label: 'Second field' }, children: [] },
        grid: { type: 'Grid', props: { columns: 2 }, children: ['third', 'fourth'] },
        third: { type: 'Text', props: { content: 'Third' }, children: [] },
        fourth: { type: 'Text', props: { content: 'Fourth' }, children: [] },
      },
    };

    const root = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);
    const row = dom.findAll(root, '.gen-ui-row')[0];
    const grid = dom.findAll(root, '.gen-ui-grid')[0];
    assert.equal(row.style.flexWrap, 'wrap');
    assert.equal(grid.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  });
});
