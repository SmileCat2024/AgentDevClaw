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

  it('renders chart and sparkline as inline svg with palette colors, legend, and hover titles', () => {
    const dom = createDomHarness();
    const ctx = createFrontendSandbox({ document: dom.document });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Dev stats',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['bar', 'line', 'spark'] },
        bar: {
          type: 'Chart',
          props: {
            chartType: 'bar',
            labels: ['W31', 'W32', 'W33'],
            series: [
              { label: 'Claw', values: [48, 20, 137] },
              { label: 'Adv', values: [11, 9, 68], tone: 'success' },
            ],
            unit: 'commits',
          },
          children: [],
        },
        line: {
          type: 'Chart',
          props: { chartType: 'line', labels: ['a', 'b', 'c'], series: [{ label: 'S', values: [1, 2, 3] }] },
          children: [],
        },
        spark: { type: 'Sparkline', props: { values: [1, 3, 2, 5] }, children: [] },
      },
    };

    const root = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);

    // Bar chart: legend reflects both series; one rect per data point.
    const barChart = dom.findAll(root, '.gen-ui-chart')[0];
    const legendItems = dom.findAll(barChart, '.gen-ui-chart-legend-item');
    assert.equal(legendItems.length, 2);
    const legendLabel = legendItems[0].children.map((child) => child.textContent).join('');
    assert.equal(legendLabel.includes('Claw'), true);
    const bars = dom.findAll(barChart, '.gen-ui-chart-bar');
    assert.equal(bars.length, 6);
    // Bars are filled with per-series vertical gradients (defs stop colors carry the palette).
    assert.equal(bars[0].attributes.fill, 'url(#gen-ui-chart-grad-1-0)', 'bar fill references its series gradient');
    assert.equal(bars[3].attributes.fill, 'url(#gen-ui-chart-grad-1-1)', 'second series references its own gradient');
    const barSvg = dom.findAll(barChart, '.gen-ui-chart-svg')[0];
    assert.equal(barSvg.attributes.viewBox, '0 0 400 220');
    const barDefs = barSvg.children.find((child) => child.tagName === 'DEFS');
    const gradients = barDefs.children.filter((child) => child.tagName === 'LINEARGRADIENT');
    assert.equal(gradients.length, 2);
    const stops = gradients[1].children.filter((child) => child.tagName === 'STOP');
    assert.equal(stops[0].attributes['stop-color'], '#22a06b', 'gradient stop uses the series palette color');
    assert.equal(stops[1].attributes['stop-opacity'], '0.6', 'gradient fades toward the baseline');
    assert.equal(Number(bars[0].attributes.rx) <= 3, true, 'bar corner radius stays subtle');
    assert.equal(Number(bars[0].attributes.width) <= 28, true, 'bar width is capped on sparse groups');
    assert.equal(bars[0].children[0].textContent, 'W31 · Claw: 48 commits');

    // Line chart: one polyline plus one hoverable point per label.
    // Note: the harness selector matches class/id/data-attr only — find
    // SVG children by tag name instead of descendant selectors.
    const lineChart = dom.findAll(root, '.gen-ui-chart')[1];
    assert.equal(dom.findAll(lineChart, '.gen-ui-chart-legend-item').length, 0, 'single series hides the legend by default');
    const lineSvg = dom.findAll(lineChart, '.gen-ui-chart-svg')[0];
    const polylines = lineSvg.children.filter((child) => child.tagName === 'POLYLINE');
    assert.equal(polylines.length, 1);
    const points = dom.findAll(lineChart, '.gen-ui-chart-point');
    assert.equal(points.length, 3);
    assert.equal(points[2].children[0].textContent, 'c · S: 3');

    // Sparkline: area fill plus endpoint dot with a min/max/last title.
    const sparkline = dom.findAll(root, '.gen-ui-sparkline')[0];
    const sparkSvg = dom.findAll(sparkline, '.gen-ui-sparkline-svg')[0];
    assert.equal(sparkSvg.attributes.viewBox, '0 0 120 32');
    assert.equal(sparkSvg.children.some((child) => child.tagName === 'PATH'), true, 'area fill path exists');
    assert.equal(sparkSvg.children.filter((child) => child.tagName === 'POLYLINE').length, 1);
    const sparkDot = sparkSvg.children.find((child) => child.tagName === 'CIRCLE');
    assert.equal(sparkDot.children[0].textContent, 'min 1 / max 5 / last 5');
  });

  it('degrades chart and sparkline rendering gracefully on missing or degenerate data', () => {
    const dom = createDomHarness();
    const ctx = createFrontendSandbox({ document: dom.document });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Degenerate charts',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['empty', 'flat', 'tiny'] },
        empty: { type: 'Chart', props: { chartType: 'bar', labels: [], series: [] }, children: [] },
        flat: {
          type: 'Chart',
          props: { chartType: 'line', labels: ['a', 'b'], series: [{ label: 'Flat', values: [7, 7] }] },
          children: [],
        },
        tiny: { type: 'Sparkline', props: { values: [42] }, children: [] },
      },
    };

    const root = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);

    const empty = dom.findAll(root, '.gen-ui-chart')[0];
    assert.equal(empty.classList.contains('gen-ui-error'), true);

    // All-equal values: domain is clamped so ticks and geometry stay finite.
    const flat = dom.findAll(root, '.gen-ui-chart')[1];
    const flatSvg = dom.findAll(flat, '.gen-ui-chart-svg')[0];
    assert.equal(flatSvg.attributes.viewBox, '0 0 400 220');
    assert.equal(dom.findAll(flat, '.gen-ui-chart-point').length, 2);

    // Single sparkline value: placeholder keeps the declared size, no line.
    const tiny = dom.findAll(root, '.gen-ui-sparkline')[0];
    const tinySvg = dom.findAll(tiny, '.gen-ui-sparkline-svg')[0];
    assert.equal(tinySvg.children.some((child) => child.tagName === 'POLYLINE'), false);
    assert.equal(tinySvg.attributes.height, '32');
  });

  it('redraws the chart at the real container width so svg text stays at pixel size', () => {
    const dom = createDomHarness();
    class FakeResizeObserver {
      constructor(cb) { FakeResizeObserver.instances.push(this); this.cb = cb; }
      observe() {}
      disconnect() {}
      trigger(width) { this.cb([{ contentRect: { width } }]); }
    }
    FakeResizeObserver.instances = [];
    const ctx = createFrontendSandbox({ document: dom.document, ResizeObserver: FakeResizeObserver });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Adaptive chart',
      root: 'root',
      elements: {
        root: { type: 'Chart', props: {
          chartType: 'bar',
          labels: ['W28', 'W29', 'W30', 'W31', 'W32', 'W33', 'W34', 'W35'],
          series: [{ label: 'Commits', values: [55, 41, 58, 10, 48, 20, 137, 165] }],
          unit: 'commits',
          showValues: true,
        }, children: [] },
      },
    };

    const root = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);
    const chart = dom.findAll(root, '.gen-ui-chart')[0];

    // 首版以 400 兜底宽度绘制。
    const svgBefore = dom.findAll(chart, '.gen-ui-chart-svg')[0];
    assert.equal(svgBefore.attributes.viewBox, '0 0 400 220');

    // 容器测量完成后按真实宽度重绘：viewBox 1:1 映射像素，字号不再被等比放大。
    FakeResizeObserver.instances[0].trigger(720);
    const svgAfter = dom.findAll(chart, '.gen-ui-chart-svg')[0];
    assert.equal(svgAfter.attributes.viewBox, '0 0 720 220');
    assert.equal(dom.findAll(chart, '.gen-ui-chart-bar').length, 8, 'redraw keeps all bars');
    assert.equal(dom.findAll(chart, '.gen-ui-chart-value-label').length, 8, 'redraw keeps value labels');

    // 头部行：单系列无图例，但 unit 展示在右侧。
    const head = dom.findAll(chart, '.gen-ui-chart-head')[0];
    assert.equal(dom.findAll(chart, '.gen-ui-chart-legend-item').length, 0);
    assert.equal(dom.findAll(head, '.gen-ui-chart-unit')[0].textContent, 'commits');
  });

  it('formats y-axis ticks with thousands separators for large values', () => {
    const dom = createDomHarness();
    const ctx = createFrontendSandbox({ document: dom.document });
    ctx.loadSource('public/src/modules/generative-ui-renderer.js');
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Tick formatting',
      root: 'root',
      elements: {
        root: { type: 'Chart', props: {
          chartType: 'line',
          labels: ['a', 'b'],
          series: [{ label: 'LOC', values: [10000, 20000] }],
        }, children: [] },
      },
    };

    const root = ctx.run(`window.renderGenUISpec(${JSON.stringify(spec)}, {}, {})`);
    const tickTexts = dom.findAll(root, '.gen-ui-chart-tick').map((t) => t.textContent);
    assert.equal(tickTexts.includes('20,000'), true, `ticks: ${tickTexts.join(', ')}`);
    assert.equal(tickTexts.includes('10,000'), true, `ticks: ${tickTexts.join(', ')}`);
  });
});
