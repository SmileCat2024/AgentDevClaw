/**
 * Tests for public/src/modules/template-engine.js（P2 真实 ESM 图路线）
 *
 * 装载路线：classic 相跑 index.html 的先行脚本整条链（`prepareClassicSandbox`：
 * 分发器 / i18n / app-core / runtime-status / session-view-state / sidebar-render /
 * app-ui / app-main，boot 体由 BOOT_NEUTRALIZER 挡在永不 resolve 的 auth gate 后），
 * markdown-utils 的 escapeHtml / renderer 是模块自身实现（vendor 的 marked 由用例
 * 补齐）。宿主工厂因此是生产实现本身：模板引擎静态链上的
 * `createP2BootstrapSessionSwitchHost` 与 `createP2BootstrapSidebarRenderHost`
 * 都由真链提供，不在测试里复刻。模板引擎本身经 `withEngineCase`（withP2EsmCase +
 * console 账本）+ `c.load` 真实 import，每个用例一张独立模块图。
 *
 * 覆盖的公开行为（原用例一一对应，断言强度不变）：
 *   - parseToolResult (JSON 工具结果解析与回退)
 *   - getToolDisplayName (TOOL_NAMES 查表)
 *   - applyTemplate 的字符串模板插值分支（{{placeholder}} 替换）
 *   - 回退模板的错误渲染（`getToolRenderTemplate().result(data, false)`）
 *   - 代码行号压缩与截断展开（renderJsonHighlight + 分发器动作
 *     templates.expandTruncated）
 *   - 后台模板预热的重建判据
 *
 * 预热判据用真实数据面驱动，不 patch 模块内部函数：模板缓存只由真实加载写
 * 入（内置 json 模板 / FEATURE_TEMPLATE_MAP 指向的真实 import URL），"加载
 * 失败回退到内置 JSON"由指向必然抛错的模块 URL 触发真实 catch 分支。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const SESSION_VIEW_STORAGE = 'public/src/modules/session-view-storage.js';
const ORCHESTRATION_STATE = 'public/src/modules/orchestration-state.js';
const RENDER_ENTRY_STATE = 'public/src/modules/render-entry-state.js';
const TEMPLATE_ENGINE = 'public/src/modules/template-engine.js';

/** vendor 桩：markdown-utils 在求值期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

/**
 * classic 相：index.html 先行脚本整链（`prepareClassicSandbox` 的
 * BOOT_NEUTRALIZER 把首屏 boot 挡在 auth gate 后）。escapeHtml / renderer 由
 * markdown-utils 自身持有（原 classic bootstrap 已并入），用例只补 vendor 的 marked。
 */
function loadClassicBootstrap(sandbox) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  prepareClassicSandbox(sandbox);
}

/** loadTemplate 的 catch 分支声明的那条日志（生产原文），唯一允许的噪音。 */
const TEMPLATE_IMPORT_FAILED_WARN = /加载模板失败/;

/**
 * 每个用例一份 console 账本：`globals` 同时注入 vm 沙箱与主 realm，所以 classic
 * 相与 ESM 图里的裸 `console` 都落在同一对象上。log / info / debug 静音，
 * warn / error 记账。
 */
function createCaseConsole() {
  const warnings = [];
  const errors = [];
  return {
    warnings,
    errors,
    console: {
      ...console,
      log() {},
      info() {},
      debug() {},
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
  };
}

/**
 * 一个用例 = 一条真实 classic 链 + 一张真实 ESM 图 + 一份 console 账本。
 *
 * 收尾断言（与 test/p2-template-summary-imports.test.js 同口径）：非预期 warn 与
 * 任何 error 一律失败；故意失败用例用 `allowedWarnings` 声明它触发的那条日志，
 * 且该日志必须恰好出现一次——多一条少一条都说明噪音账目与生产行为对不上。
 */
async function withEngineCase(fn, { allowedWarnings = [] } = {}) {
  const noise = createCaseConsole();
  const value = await withP2EsmCase(
    { classic: loadClassicBootstrap, globals: { console: noise.console } },
    fn,
  );
  const unexpected = noise.warnings
    .filter((args) => !allowedWarnings.some((pattern) => pattern.test(String(args[0]))));
  assert.deepEqual(unexpected, [], '不得产生非预期 console.warn');
  assert.deepEqual(noise.errors, [], '不得产生任何 console.error');
  for (const pattern of allowedWarnings) {
    const hits = noise.warnings.filter((args) => pattern.test(String(args[0])));
    assert.equal(hits.length, 1, `故意失败用例应恰好产生一次 /${pattern.source}/ 日志`);
  }
  return value;
}

/**
 * 装载模板引擎及其真实静态依赖（同一 case 内共享同一代实例）。
 * TOOL_NAMES 与消息/运行时状态都写进 ESM owner，引擎经 import 读同一份。
 */
async function loadTemplateEngine(c, toolNames = {}) {
  const storage = await c.load(SESSION_VIEW_STORAGE);
  storage.setToolNames(toolNames);
  const orchestration = await c.load(ORCHESTRATION_STATE);
  const renderEntry = await c.load(RENDER_ENTRY_STATE);
  const engine = await c.load(TEMPLATE_ENGINE);
  return { engine, storage, orchestration, renderEntry };
}

/** 一份必然抛错的模板模块 URL：触发 loadTemplate 的真实 catch → 内置回退。 */
const BROKEN_TEMPLATE_URL = 'data:text/javascript,throw new Error("template unavailable")';
/** 一份可加载的模板模块 URL：真实 import 成功并写入模板缓存。 */
const WORKING_TEMPLATE_URL = 'data:text/javascript,export default { call: () => "ok", result: () => "ok" }';
/** 同一 URL 在本进程内解析为同一模块实例，用于断言缓存命中的是它。 */
const workingTemplate = await import(WORKING_TEMPLATE_URL);

function setFeatureTemplateMap(c, map) {
  // app-core 已把该键注册为 agent-loader 域桥键；ESM 装载后 setter 转发进
  // agent-loader-host 的 live binding（FEATURE_TEMPLATE_MAP）。
  c.window.FEATURE_TEMPLATE_MAP = map;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('template-engine: background warmup', () => {
  function createWarmupHarness(c, { engine, storage, renderEntry }) {
    const renders = [];
    c.read("currentRuntimeAgentId = 'runtime-a'");
    storage.setCurrentMessages([{ role: 'tool', content: 'result' }]);
    renderEntry.setLastRenderedChatSig('rendered');
    c.window.renderCurrentMainView = () => renders.push('render');
    return { engine, storage, renderEntry, renders };
  }

  it('skips a full rebuild when templates are already cached', async () => {
    await withEngineCase(async (c) => {
      const { engine, renders, renderEntry, storage } = createWarmupHarness(c, await loadTemplateEngine(c));
      // 第一轮：消息里没有工具条目 → 模板加载完成也不重建（同时把 cached 写入缓存）
      setFeatureTemplateMap(c, { cached: WORKING_TEMPLATE_URL });
      storage.setCurrentMessages([]);
      engine.warmTemplatesInBackground(['cached'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, []);

      // 第二轮：条件全都满足，但模板已在缓存里 → missing 为空 → 跳过重建
      storage.setCurrentMessages([{ role: 'tool', content: 'result' }]);
      engine.warmTemplatesInBackground(['cached'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, []);
      assert.equal(renderEntry._lastRenderedChatSig, 'rendered');
    });
  });

  it('does not rebuild an empty conversation after a template loads', async () => {
    await withEngineCase(async (c) => {
      const { engine, renders, renderEntry, storage } = createWarmupHarness(c, await loadTemplateEngine(c));
      setFeatureTemplateMap(c, { cached: WORKING_TEMPLATE_URL });
      storage.setCurrentMessages([]);
      engine.warmTemplatesInBackground(['cached'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, []);
      assert.equal(renderEntry._lastRenderedChatSig, 'rendered');

      // 模板确实进了缓存：工具渲染配置选中它时拿到的是该模块的导出函数，
      // 而不是内置 json 回退（未缓存时才会回退，同模块同 URL 即同一实例）。
      storage.setToolRenderConfigs({ probe: { render: { call: 'cached', result: 'cached' } } });
      const picked = engine.getToolRenderTemplate('probe');
      assert.equal(picked.call, workingTemplate.default.call);
      assert.equal(picked.result, workingTemplate.default.result);
    });
  });

  it('does not rebuild a conversation without tool messages', async () => {
    await withEngineCase(async (c) => {
      const { engine, renders, renderEntry, storage } = createWarmupHarness(c, await loadTemplateEngine(c));
      storage.setCurrentMessages([{ role: 'user', content: 'hello' }]);
      engine.warmTemplatesInBackground(['json'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, []);
      assert.equal(renderEntry._lastRenderedChatSig, 'rendered');
    });
  });

  it('rebuilds history once when a new template replaces the JSON fallback', async () => {
    await withEngineCase(async (c) => {
      const { engine, renders, renderEntry, storage } = createWarmupHarness(c, await loadTemplateEngine(c));
      // 先让 cached 模板真实进缓存（此时消息为空，不触发重建）
      setFeatureTemplateMap(c, { cached: WORKING_TEMPLATE_URL });
      storage.setCurrentMessages([]);
      engine.warmTemplatesInBackground(['cached'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, []);

      // 有工具消息时 warm 一个仍未缓存的 json → 真实模板可用 → 重建一次
      storage.setCurrentMessages([{ role: 'tool', content: 'result' }]);
      engine.warmTemplatesInBackground(['cached', 'json'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, ['render']);
      assert.equal(renderEntry._lastRenderedChatSig, '');
    });
  });

  it('does not rebuild after a missing template falls back to JSON', async () => {
    await withEngineCase(async (c) => {
      const { engine, renders, renderEntry } = createWarmupHarness(c, await loadTemplateEngine(c));
      // 模板模块 import 抛错 → loadTemplate 的 catch 分支回退内置 JSON 且不写缓存
      setFeatureTemplateMap(c, { missing: BROKEN_TEMPLATE_URL });
      engine.warmTemplatesInBackground(['missing'], 'runtime-a');
      await settle();
      assert.deepEqual(renders, []);
      assert.equal(renderEntry._lastRenderedChatSig, 'rendered');
      // 本用例是唯一的故意失败路径：允许的日志恰是 catch 分支那一条
    }, { allowedWarnings: [TEMPLATE_IMPORT_FAILED_WARN] });
  });

  it('discards a warmup after switching runtimes', async () => {
    await withEngineCase(async (c) => {
      const { engine, renders, renderEntry } = createWarmupHarness(c, await loadTemplateEngine(c));
      engine.warmTemplatesInBackground(['json'], 'runtime-a');
      // 预热在飞期间切换 runtime：回调必须按代次与 runtime 双重判定丢弃
      c.read("currentRuntimeAgentId = 'runtime-b'");
      await settle();
      assert.deepEqual(renders, []);
      assert.equal(renderEntry._lastRenderedChatSig, 'rendered');
    });
  });
});

describe('template-engine: code line numbers', () => {
  it('feature Read markup keeps source offsets and nested highlighting without duplicate number spans', async () => {
    await withEngineCase(async (c) => {
      const { engine } = await loadTemplateEngine(c);
      const html = '<div class="code-read-container">'
        + '<div class="code-read-line"><span class="code-read-line-num">201</span><span class="code-read-content"><span class="hljs-keyword">const</span> x<span class="hljs-punctuation">;</span></span></div>'
        + '<div class="code-read-line"><span class="code-read-line-num">202</span><span class="code-read-content">&lt;tag&gt;</span></div></div>';
      const rendered = engine.applyTemplate((data) => data, html);
      assert.ok(rendered.includes('data-line="201"><span class="hljs-keyword">const</span> x;</div>'));
      assert.ok(rendered.includes('data-line="202">&lt;tag&gt;</div>'));
      assert.ok(!rendered.includes('code-read-line-num'));
      assert.ok(!rendered.includes('code-read-content'));
    });
  });

  it('fallback lines and truncated expansion retain fixed, continuous numbers', async () => {
    await withEngineCase(async (c) => {
      const { engine } = await loadTemplateEngine(c);
      const data = Array.from({ length: 262 }, (_, i) => 'line ' + i).join('\n');
      const html = engine.renderJsonHighlight(data);
      assert.ok(html.includes('data-line="200"'));
      assert.ok(!html.includes('data-line="201"'));
      const id = html.match(/data-expand-id="([^"]+)"/)[1];
      const container = { innerHTML: '' };
      const el = { getAttribute: () => id, closest: () => container };
      // 展开入口是分发器动作（模板上 data-action="templates.expandTruncated"）
      assert.equal(typeof c.window.ClawFW.actions.invoke('templates.expandTruncated', el), 'boolean');
      assert.ok(container.innerHTML.includes('data-line="201"'));
      assert.ok(container.innerHTML.includes('data-line="262"'));
      assert.equal((container.innerHTML.match(/code-read-line"/g) || []).length, 262);
    });
  });
});

// ── parseToolResult ────────────────────────────────────────────────

describe('template-engine: parseToolResult', () => {
  async function parse(input) {
    return withEngineCase(async (c) => {
      const { engine } = await loadTemplateEngine(c);
      return engine.parseToolResult(input);
    });
  }

  it('parses valid JSON with success and result fields', async () => {
    const result = await parse(JSON.stringify({ success: true, result: 'hello' }));
    assert.equal(result.success, true);
    assert.equal(result.data, 'hello');
  });

  it('parses failed result', async () => {
    const result = await parse(JSON.stringify({ success: false, result: 'error message' }));
    assert.equal(result.success, false);
    assert.equal(result.data, 'error message');
  });

  it('unwraps double-encoded JSON string result', async () => {
    const inner = JSON.stringify({ key: 'value' });
    const result = await parse(JSON.stringify({ success: true, result: inner }));
    assert.equal(result.success, true);
    assert.equal(result.data.key, 'value');
  });

  it('unwraps double-encoded JSON array string result', async () => {
    const inner = JSON.stringify([1, 2, 3]);
    const result = await parse(JSON.stringify({ success: true, result: inner }));
    assert.equal(result.success, true);
    assert.equal(result.data.length, 3);
    assert.equal(result.data[0], 1);
    assert.equal(result.data[2], 3);
  });

  it('returns content as-is for non-JSON string', async () => {
    const result = await parse('plain text');
    assert.equal(result.success, true);
    assert.equal(result.data, 'plain text');
  });

  it('returns content as-is for JSON without success/result fields', async () => {
    const input = JSON.stringify({ foo: 'bar' });
    const result = await parse(input);
    assert.equal(result.success, true);
    assert.equal(result.data, input);
  });

  it('returns content as-is for JSON with only success field', async () => {
    const input = JSON.stringify({ success: true });
    const result = await parse(input);
    assert.equal(result.success, true);
    assert.equal(result.data, input);
  });

  it('returns content as-is for JSON with only result field', async () => {
    const input = JSON.stringify({ result: 'data' });
    const result = await parse(input);
    assert.equal(result.success, true);
    assert.equal(result.data, input);
  });

  it('returns content as-is for JSON primitive (number)', async () => {
    const result = await parse('42');
    assert.equal(result.success, true);
    assert.equal(result.data, '42');
  });

  it('handles empty string input', async () => {
    const result = await parse('');
    assert.equal(result.success, true);
    assert.equal(result.data, '');
  });

  it('preserves non-JSON string result (not double-encoded)', async () => {
    const result = await parse(JSON.stringify({ success: true, result: 'not json' }));
    assert.equal(result.success, true);
    assert.equal(result.data, 'not json');
  });

  it('preserves string result that starts with { but is invalid JSON', async () => {
    const result = await parse(JSON.stringify({ success: true, result: '{invalid json' }));
    // The inner JSON.parse fails, so data stays as the original string
    assert.equal(result.success, true);
    assert.equal(result.data, '{invalid json');
  });
});

// ── getToolDisplayName ─────────────────────────────────────────────

describe('template-engine: getToolDisplayName', () => {
  async function displayName(toolNames, toolName) {
    return withEngineCase(async (c) => {
      const { engine } = await loadTemplateEngine(c, toolNames);
      return engine.getToolDisplayName(toolName);
    });
  }

  it('returns mapped display name when tool is in TOOL_NAMES', async () => {
    const names = { read: 'Read File', bash: 'Run Command' };
    assert.equal(await displayName(names, 'read'), 'Read File');
    assert.equal(await displayName(names, 'bash'), 'Run Command');
  });

  it('returns original toolName when not in TOOL_NAMES', async () => {
    assert.equal(await displayName({ read: 'Read File' }, 'unknown_tool'), 'unknown_tool');
  });

  it('returns "Tool" for null input', async () => {
    assert.equal(await displayName({}, null), 'Tool');
  });

  it('returns "Tool" for undefined input', async () => {
    assert.equal(await displayName({}, undefined), 'Tool');
  });

  it('returns "Tool" for empty string', async () => {
    assert.equal(await displayName({}, ''), 'Tool');
  });

  it('returns "Tool" for falsy 0', async () => {
    assert.equal(await displayName({}, 0), 'Tool');
  });

  it('works with empty TOOL_NAMES map', async () => {
    assert.equal(await displayName({}, 'any_tool'), 'any_tool');
  });
});

// ── interpolateTemplate（经 applyTemplate 的字符串模板分支）───────────

describe('template-engine: interpolateTemplate', () => {
  async function interpolate(template, data) {
    return withEngineCase(async (c) => {
      const { engine } = await loadTemplateEngine(c);
      return engine.applyTemplate(template, data);
    });
  }

  it('replaces single placeholder', async () => {
    assert.equal(await interpolate('Hello {{name}}!', { name: 'World' }), 'Hello World!');
  });

  it('replaces multiple placeholders', async () => {
    assert.equal(await interpolate('{{a}} and {{b}}', { a: '1', b: '2' }), '1 and 2');
  });

  it('preserves placeholder when key is missing from data', async () => {
    assert.equal(await interpolate('Hello {{name}}', {}), 'Hello {{name}}');
  });

  it('preserves placeholder when key value is undefined', async () => {
    assert.equal(await interpolate('{{x}}', { x: undefined }), '{{x}}');
  });

  it('converts non-string values to string', async () => {
    assert.equal(await interpolate('{{n}}', { n: 42 }), '42');
    assert.equal(await interpolate('{{b}}', { b: true }), 'true');
  });

  it('handles templates with no placeholders', async () => {
    assert.equal(await interpolate('no placeholders here', {}), 'no placeholders here');
  });

  it('handles underscore in placeholder key', async () => {
    assert.equal(await interpolate('{{file_name}}', { file_name: 'test.js' }), 'test.js');
  });

  it('handles numeric in placeholder key', async () => {
    assert.equal(await interpolate('{{item123}}', { item123: 'value' }), 'value');
  });
});

// ── formatError（经回退模板的失败分支）──────────────────────────────

describe('template-engine: formatError', () => {
  /** 未注册渲染配置的工具一律落到内置 JSON 模板：失败分支即 formatError。 */
  async function renderFailure(data) {
    return withEngineCase(async (c) => {
      const { engine } = await loadTemplateEngine(c);
      const fallback = engine.getToolRenderTemplate('__unregistered__').result;
      return engine.applyTemplate(fallback, data, false);
    });
  }

  it('formats string error with escaping', async () => {
    const result = await renderFailure('something failed');
    assert.ok(result.includes('tool-error'));
    assert.ok(result.includes('something failed'));
  });

  it('formats object error as JSON', async () => {
    const result = await renderFailure({ code: 500, message: 'oops' });
    assert.ok(result.includes('tool-error'));
    // JSON quotes are escaped by escapeHtml
    assert.ok(result.includes('code'));
    assert.ok(result.includes('500'));
    assert.ok(result.includes('oops'));
  });

  it('escapes HTML in error text (XSS prevention)', async () => {
    const result = await renderFailure('<script>alert(1)</script>');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });

  it('includes SVG icon element', async () => {
    const result = await renderFailure('err');
    assert.ok(result.includes('<svg'));
  });
});
