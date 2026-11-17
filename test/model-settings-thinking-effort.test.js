import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * 模型设置编辑表单「思考强度」下拉与协议下拉的回归测试。
 *
 * 历史事故（d9783e39）：populateThinkingEffortOptions 从 window 导出收敛为
 * 模块级 const，但渲染尾部的两处调用点仍写 window.populateThinkingEffortOptions，
 * `typeof === 'function'` 守卫静默失败——下拉渲染成空壳（无任何选项），且保存时
 * select.value 恒为空、fallback 也找不到 option，thinkingEffort 被写回 null，
 * 表现为「思考强度加载不出来 + 自动保存成不开启思考」。
 *
 * 本测试走真实用户路径（data-action="modelSettings.editPreset" → 分发器 →
 * editSettingsPreset → renderSettingsOverlay）锁定：
 *   - 思考强度下拉按协议填充选项，且当前值处于选中态；
 *   - 自定义模型的协议下拉只提供 OpenAI / Anthropic 两族协议（OpenCode 与
 *     OpenAI Auth 有专门配置页，不再出现在自定义表单）。
 *
 * 装载路线（ESM 迁移配方第三节）：真实 import + 最小 window/document 桩。
 * 语音配置缓存、OAuth 流程、分发器都装载真实现——旧沙箱里靠注入
 * getClawSpeechModelConfig / refreshOAuthStatus 桩维持的路径已不再需要。
 */

/** 按 id 持久化的追踪型 DOM stub：记录 innerHTML 写入，可断言渲染产物 */
function createTrackingDocument() {
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    type: 'text',
  });
  const trackingDocument = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      const element = elements.get(id);
      // 浏览器行为：innerHTML 赋值后，按 id 取到的元素带 HTML 源里声明的
      // data-* 属性（如思考强度下拉的 data-current / data-provider）。
      // stub 没有解析器，这里对已记录的 innerHTML 做属性级提取来模拟。
      if (!element._datasetHydrated) {
        for (const [, host] of elements) {
          const tagMatch = host.innerHTML.match(new RegExp('<[a-z]+\\b[^>]*\\bid="' + id + '"[^>]*>', 'i'));
          if (tagMatch) {
            for (const attr of tagMatch[0].matchAll(/data-([a-z-]+)="([^"]*)"/gi)) {
              const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
              if (!(key in element.dataset)) element.dataset[key] = attr[2];
            }
            break;
          }
        }
        element._datasetHydrated = true;
      }
      return element;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElement(''),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    activeElement: null,
    readyState: 'complete',
  };
  trackingDocument.elements = elements;
  return trackingDocument;
}

async function withSettingsHarness(fn) {
  const trackingDocument = createTrackingDocument();
  // 服务端载荷：seedCustomPreset 只换「服务端给什么」，设置面板经 openSettings
  // 的真实读取链（GET /protoclaw/model_config）取得设置数据（不再借宿 window.ClawFW）。
  const server = { config: { defaultModel: {}, agent: {} }, presets: [] };
  return withP2EsmCase({
    globals: {
      document: trackingDocument,
      fetch: async (url) => {
        if (String(url) === '/protoclaw/model_config') {
          return { ok: true, json: async () => ({ config: server.config, presets: server.presets }) };
        }
        return { ok: true, json: async () => ({}) };
      },
    },
    classic: (sandbox) => {
      sandbox.run('window.__clawAuthReady = new Promise(() => {}); applyTheme = () => {}; applyLanguage = () => {};'
        + 'ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };');
      prepareClassicSandbox(sandbox);
      sandbox.KernelState.defineKey('markdown-utils', 'escapeHtml', (value) => String(value ?? ''));
    },
  }, async (c) => {
    const module = await c.load('public/src/modules/model-settings.js');
    return fn({
      trackingDocument,
      module,
      server,
      settle: () => new Promise((resolve) => { setImmediate(resolve); }),
    });
  });
}

/** 真实用户路径打开设置面板：服务端载荷 → openSettings → 渲染（设置态归模块私有） */
async function seedCustomPreset(h, overrides = {}) {
  h.server.config = { defaultModel: {}, agent: {} };
  h.server.presets = [{
    name: '回归用模型',
    provider: 'anthropic',
    apiSurface: 'chat',
    model: 'claude-test',
    thinkingEffort: 'high',
    ...overrides,
  }];
  window.ClawFW.settingsTab = 'custom';
  await h.module.openSettings();
}

/** 真实用户路径：点击预设卡片的「编辑」→ editSettingsPreset → renderSettingsOverlay */
async function openEditForm(h) {
  const { invoke } = window.ClawFW.actions;
  const result = invoke('modelSettings.editPreset', { dataset: {} }, { type: 'click' }, 0);
  await h.settle();
  return result;
}

describe('模型设置编辑表单渲染', () => {
  it('编辑预设时思考强度下拉被填充选项且当前值选中（d9783e39 回归）', async () => {
    await withSettingsHarness(async (h) => {
      await seedCustomPreset(h);
      await openEditForm(h);

      // 编辑态已建立（设置态归模块私有，按渲染产物断言：编辑索引 0 的保存按钮）
      const overlayHtml = h.trackingDocument.elements.get('settings-overlay-host').innerHTML;
      assert.ok(overlayHtml.includes('data-args="[0]"'), '编辑态已建立（编辑索引 0）');
      const select = h.trackingDocument.elements.get('settings-preset-thinking-effort');
      assert.ok(select, '思考强度下拉已渲染');
      // 修复前：populate 调用走 window.* 守卫静默失败，innerHTML 恒为空串
      assert.ok(select.innerHTML.length > 0, '思考强度下拉选项已填充（不能是空壳）');
      assert.ok(select.innerHTML.includes('<option value="high" selected'), '当前值 high 处于选中态');
      // anthropic 协议专属档位，证明按协议分档生效
      assert.ok(select.innerHTML.includes('<option value="max"'), 'anthropic 档位集合含 max');
    });
  });

  it('openai 协议预设使用 openai 档位集合', async () => {
    await withSettingsHarness(async (h) => {
      await seedCustomPreset(h, { provider: 'openai', thinkingEffort: 'medium' });
      await openEditForm(h);

      const select = h.trackingDocument.elements.get('settings-preset-thinking-effort');
      assert.ok(select.innerHTML.includes('<option value="medium" selected'), '当前值 medium 选中');
      assert.ok(select.innerHTML.includes('<option value="minimal"'), 'openai 档位集合含 minimal');
      assert.ok(!select.innerHTML.includes('<option value="max"'), 'openai 档位不含 anthropic 的 max');
    });
  });

  it('自定义模型协议下拉只提供 OpenAI / Anthropic 两族协议', async () => {
    await withSettingsHarness(async (h) => {
      await seedCustomPreset(h);
      await openEditForm(h);

      const hostHtml = h.trackingDocument.elements.get('settings-overlay-host').innerHTML;
      assert.ok(hostHtml.includes('id="settings-preset-provider"'), '协议下拉存在');
      for (const option of ['value="anthropic"', 'value="openai"', 'value="openai-responses"']) {
        assert.ok(hostHtml.includes('<option ' + option), '协议下拉提供 ' + option);
      }
      // OpenCode 与 OpenAI Auth 有专门配置页，不再出现在自定义表单
      assert.ok(!hostHtml.includes('<option value="opencode"'), '协议下拉不含 OpenCode');
      assert.ok(!hostHtml.includes('<option value="openai-oauth"'), '协议下拉不含 OpenAI Auth (OAuth)');
    });
  });
});
