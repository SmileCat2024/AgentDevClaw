/**
 * Rail panels golden test — Phase C「右栏面板实现去全局化」的行为钉子。
 *
 * 钉什么：注册表里的面板全集与每个面板的元数据（when / label /
 * description / preserveOnReRender / title 双语）。注册代码搬家（中央注册
 * → 模块自注册）不许改变这份快照；增删面板或改元数据必须显式更新金样本。
 *
 * 刻意不钉注册顺序：三个消费方全部按 id 查找，不按注册顺序消费——
 * renderCurrentMainView 用 getAvailable 做可见性过滤（Set 成员判断）、
 * rail-customize 的清单成员判断与 label/description 元数据读取都是按 id。
 * 边栏按钮顺序来自 index.html 静态标记 + localStorage 配置
 * （rail-customize.js 的 CUSTOMIZABLE_PANEL_ORDER），与注册顺序无关。
 * 因此模块自注册导致的注册顺序变化不是用户可见行为变化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

function readModule(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
}

/**
 * 注册面住址登记：每个面板的注册代码住在哪个文件、如何提取与执行。
 * Phase C 迁移只改这里的住址（注册代码从 app-ui 中央块搬进实现模块时，
 * 在此登记新住址），金样本断言本身不变。
 */
const REGISTRATION_HOMES = [
  {
    id: 'app-ui 中央注册',
    file: 'public/src/app-ui.js',
    start: "registerFeaturePanel('workspace'",
    end: '// Sidebar Toggle + narrow-width drawer backdrop',
    prefix: 'registerFeaturePanel = window.registerFeaturePanel = (id, panel) => window.ClawPanels.register(id, panel);',
    suffix: '',
  },
  {
    id: 'resources-viewer 自注册',
    file: 'public/src/modules/resources-viewer.js',
    start: 'function registerResourcesViewerPanels()',
    end: '// window 导出',
    prefix: 'registerFeaturePanel = window.registerFeaturePanel = (id, panel) => window.ClawPanels.register(id, panel);',
    suffix: 'registerResourcesViewerPanels();',
  },
  {
    id: 'annotations 自注册',
    file: 'public/src/modules/annotations.js',
    start: "window.ClawHost.panels.register('annotations'",
    end: 'window.ClawAnnotations = {',
    prefix: '',
    suffix: '',
  },
  {
    id: 'genui 自注册',
    file: 'public/src/modules/generative-ui-panel.js',
    start: "window.ClawHost.panels.register('genui'",
    end: 'window.GenUIPanel = {',
    prefix: '',
    suffix: '',
  },
  {
    id: 'git 自注册',
    file: 'public/src/modules/git-panel.js',
    start: "window.ClawHost.panels.register('git'",
    end: '})();',
    prefix: '',
    suffix: '',
  },
  {
    id: 'bg 自注册',
    file: 'public/src/modules/bg-panel.js',
    start: "window.ClawHost.panels.register('bg'",
    end: '// 启动徽标轮询',
    prefix: '',
    suffix: '',
  },
  {
    id: 'session-controls 自注册',
    file: 'public/src/modules/session-controls-panel.js',
    start: "window.ClawHost.panels.register('session-controls'",
    end: '}());',
    prefix: '',
    suffix: '',
  },
];

/** 在沙箱里执行全部注册面，返回序列化后的注册表快照。 */
function captureRegistrySnapshot() {
  const ctx = createFrontendSandbox({ t: (key) => `t:${key}` });
  ctx.loadSource('public/src/modules/claw-host.js');
  ctx.loadSource('public/src/modules/right-panel-registry.js');

  for (const home of REGISTRATION_HOMES) {
    const block = sourceBetween(readModule(home.file), home.start, home.end);
    ctx.run(home.prefix + block + home.suffix);
  }

  return JSON.parse(ctx.run(`
    (() => {
      const panels = window.ClawPanels.getAll();
      const titles = (lang) => { currentLanguage = lang; return panels.map(p => String(p.title())); };
      const zh = titles('zh');
      const en = titles('en');
      return JSON.stringify(panels.map((p, i) => ({
        id: p.id,
        when: p.when,
        label: p.label ?? null,
        description: p.description ?? null,
        preserveOnReRender: p.preserveOnReRender === true,
        renderIsFunction: typeof p.render === 'function',
        titleZh: zh[i],
        titleEn: en[i],
      })));
    })()
  `));
}

const byId = (a, b) => a.id.localeCompare(b.id);

test('rail panel registry matches the golden snapshot', () => {
  const actual = captureRegistrySnapshot().sort(byId);
  assert.deepEqual(actual, [...GOLDEN_SNAPSHOT].sort(byId));
});

test('every rail button in index.html maps to a registered panel', () => {
  const html = readModule('public/index.html');
  const buttonIds = [...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(buttonIds.length > 0, 'index.html should contain rail panel buttons');

  const registered = new Set(captureRegistrySnapshot().map((p) => p.id));
  const orphans = buttonIds.filter((id) => !registered.has(id));
  assert.deepEqual(orphans, [], 'rail buttons pointing at unregistered panels would be dead UI');
});

const GOLDEN_SNAPSHOT = [
  { id: 'workspace', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '文件结构', en: 'Structure' }, description: { zh: '项目文件树', en: 'Project file tree' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_structure', titleEn: 't:panel_structure' },
  { id: 'plan', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '计划', en: 'Plan' }, description: { zh: '任务与计划列表', en: 'Tasks and plan list' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_plan', titleEn: 't:panel_plan' },
  { id: 'git', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '源代码管理', en: 'Source Control' }, description: { zh: 'Git 状态与操作', en: 'Git status and actions' }, preserveOnReRender: false, renderIsFunction: true, titleZh: '源代码管理', titleEn: 'Source Control' },
  { id: 'bg', when: { agentIds: ['programming-helper'], surfaces: ['chat'] }, label: { zh: '后台任务', en: 'Background' }, description: { zh: 'bash_bg 后台任务实时状态', en: 'Live bash_bg task status' }, preserveOnReRender: true, renderIsFunction: true, titleZh: '后台任务', titleEn: 'Background' },
  { id: 'annotations', when: { agentIds: ['programming-helper'], surfaces: ['chat'] }, label: { zh: '标注', en: 'Annotations' }, description: { zh: '对话内容高亮标注', en: 'Highlights on conversation text' }, preserveOnReRender: true, renderIsFunction: true, titleZh: '标注', titleEn: 'Annotations' },
  { id: 'monitor', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '监控', en: 'Monitor' }, description: { zh: '运行状态监控', en: 'Runtime status monitor' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_monitor', titleEn: 't:panel_monitor' },
  { id: 'hooks', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '功能', en: 'Features' }, description: { zh: 'Feature 功能面板', en: 'Feature panel' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_features', titleEn: 't:panel_features' },
  { id: 'inspector', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '反向钩子', en: 'Reverse Hooks' }, description: { zh: 'Hook 检查器', en: 'Hook inspector' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_reverse_hooks', titleEn: 't:panel_reverse_hooks' },
  { id: 'logs', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '日志', en: 'Logs' }, description: { zh: '运行日志', en: 'Runtime logs' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_logs', titleEn: 't:panel_logs' },
  { id: 'preflight', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '装配预检', en: 'Preflight' }, description: null, preserveOnReRender: false, renderIsFunction: true, titleZh: '装配预检', titleEn: '装配预检' },
  { id: 'mcp', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: 'MCP', en: 'MCP' }, description: { zh: 'MCP 服务端', en: 'MCP servers' }, preserveOnReRender: false, renderIsFunction: true, titleZh: 't:panel_mcp', titleEn: 't:panel_mcp' },
  { id: 'genui', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '交互页面', en: 'Interactive Pages' }, description: { zh: 'UI 交互页面', en: 'Interactive UI pages' }, preserveOnReRender: true, renderIsFunction: true, titleZh: '交互页面', titleEn: '交互页面' },
  { id: 'session-controls', when: { agentIds: null, surfaces: ['chat'] }, label: { zh: '会话控制', en: 'Session Controls' }, description: { zh: 'API 重试与输出风格', en: 'API retries and output styles' }, preserveOnReRender: false, renderIsFunction: true, titleZh: '会话控制', titleEn: 'Session Controls' },
  { id: 'settings', when: { agentIds: ['work-group'], surfaces: null }, label: { zh: '群聊设置', en: 'Group Settings' }, description: null, preserveOnReRender: false, renderIsFunction: true, titleZh: '群聊设置', titleEn: '群聊设置' },
  { id: 'threads', when: { agentIds: ['work-group'], surfaces: null }, label: { zh: '工作线程', en: 'Work Threads' }, description: null, preserveOnReRender: false, renderIsFunction: true, titleZh: '工作线程', titleEn: '工作线程' },
  { id: 'resources', when: { agentIds: ['work-group'], surfaces: null }, label: { zh: '资料', en: 'Resources' }, description: { zh: '群聊共享资料文件', en: 'Shared resource files' }, preserveOnReRender: false, renderIsFunction: true, titleZh: '资料', titleEn: '资料' },
  { id: 'viewer', when: { agentIds: ['work-group'], surfaces: null }, label: { zh: '文档', en: 'Documents' }, description: { zh: '群聊文档查看', en: 'Document viewer' }, preserveOnReRender: false, renderIsFunction: true, titleZh: '文档', titleEn: '文档' },
];
