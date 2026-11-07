import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 模型设置编辑表单「思考强度」下拉与协议下拉的回归测试。
 *
 * 历史事故（d9783e39）：populateThinkingEffortOptions 从 window 导出收敛为
 * 模块级 const，但渲染尾部的两处调用点仍写 window.populateThinkingEffortOptions，
 * `typeof === 'function'` 守卫静默失败——下拉渲染成空壳（无任何选项），且保存时
 * select.value 恒为空、fallback 也找不到 option，thinkingEffort 被写回 null，
 * 表现为「思考强度加载不出来 + 自动保存成不开启思考」。
 *
 * 本测试走真实用户路径（edit action → renderSettingsOverlay）锁定：
 *   - 思考强度下拉按协议填充选项，且当前值处于选中态；
 *   - 自定义模型的协议下拉只提供 OpenAI / Anthropic 两族协议（OpenCode 与
 *     OpenAI Auth 有专门配置页，不再出现在自定义表单）。
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
    readyState: 'complete',
  };
  trackingDocument.elements = elements;
  return trackingDocument;
}

function createSettingsSandbox() {
  const trackingDocument = createTrackingDocument();
  const ctx = createFrontendSandbox({
    document: trackingDocument,
    // renderModelCatalogSettingsOverlay 无条件求值的语音配置依赖（生产由
    // speech-config-cache.js 提供；此处按非语音 tab 的取值注入）
    getClawSpeechModelConfig: () => null,
    getClawSpeechPresets: () => [],
    refreshOAuthStatus: () => {},
  });
  // 分发器必须先于任何经 ClawFW.actions 注册动作的模块装载（生产加载顺序第一位）
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/oauth-flow.js');
  ctx.loadSource('public/src/modules/model-settings.js');
  ctx.run('window.ClawFW = window.ClawFW || {}');
  return { ctx, trackingDocument };
}

function seedCustomPreset(ctx, overrides = {}) {
  ctx.run(`window.ClawFW.settingsData = ${JSON.stringify({
    config: { defaultModel: {}, agent: {} },
    presets: [{
      name: '回归用模型',
      provider: 'anthropic',
      apiSurface: 'chat',
      model: 'claude-test',
      thinkingEffort: 'high',
      ...overrides,
    }],
    connections: { opencode: { hasApiKey: false, tier: 'zen' } },
  })}`);
  ctx.run('window.ClawFW.settingsOpen = true');
  ctx.run('window.ClawFW.settingsTab = \'custom\'');
}

/** 真实用户路径：点击预设卡片的「编辑」→ editSettingsPreset → renderSettingsOverlay */
async function openEditForm(ctx) {
  await ctx.run('window.ClawFW.actions.invoke(\'modelSettings.editPreset\', { dataset: {} }, null, 0)');
}

describe('模型设置编辑表单渲染', () => {
  it('编辑预设时思考强度下拉被填充选项且当前值选中（d9783e39 回归）', async () => {
    const { ctx, trackingDocument } = createSettingsSandbox();
    seedCustomPreset(ctx);
    await openEditForm(ctx);

    assert.equal(ctx.run('window.ClawFW.settingsEditing'), 0, '编辑态已建立');
    const select = trackingDocument.elements.get('settings-preset-thinking-effort');
    assert.ok(select, '思考强度下拉已渲染');
    // 修复前：populate 调用走 window.* 守卫静默失败，innerHTML 恒为空串
    assert.ok(select.innerHTML.length > 0, '思考强度下拉选项已填充（不能是空壳）');
    assert.ok(select.innerHTML.includes('<option value="high" selected'), '当前值 high 处于选中态');
    // anthropic 协议专属档位，证明按协议分档生效
    assert.ok(select.innerHTML.includes('<option value="max"'), 'anthropic 档位集合含 max');
  });

  it('openai 协议预设使用 openai 档位集合', async () => {
    const { ctx, trackingDocument } = createSettingsSandbox();
    seedCustomPreset(ctx, { provider: 'openai', thinkingEffort: 'medium' });
    await openEditForm(ctx);

    const select = trackingDocument.elements.get('settings-preset-thinking-effort');
    assert.ok(select.innerHTML.includes('<option value="medium" selected'), '当前值 medium 选中');
    assert.ok(select.innerHTML.includes('<option value="minimal"'), 'openai 档位集合含 minimal');
    assert.ok(!select.innerHTML.includes('<option value="max"'), 'openai 档位不含 anthropic 的 max');
  });

  it('自定义模型协议下拉只提供 OpenAI / Anthropic 两族协议', async () => {
    const { ctx, trackingDocument } = createSettingsSandbox();
    seedCustomPreset(ctx);
    await openEditForm(ctx);

    const hostHtml = trackingDocument.elements.get('settings-overlay-host').innerHTML;
    assert.ok(hostHtml.includes('id="settings-preset-provider"'), '协议下拉存在');
    for (const option of ['value="anthropic"', 'value="openai"', 'value="openai-responses"']) {
      assert.ok(hostHtml.includes('<option ' + option), '协议下拉提供 ' + option);
    }
    // OpenCode 与 OpenAI Auth 有专门配置页，不再出现在自定义表单
    assert.ok(!hostHtml.includes('<option value="opencode"'), '协议下拉不含 OpenCode');
    assert.ok(!hostHtml.includes('<option value="openai-oauth"'), '协议下拉不含 OpenAI Auth (OAuth)');
  });
});
