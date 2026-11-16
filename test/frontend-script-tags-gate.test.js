/**
 * script 标签清单防线（Phase C 收尾面 + ESM 迁移 R4 入口纪律）。
 *
 * classic src 标签三道断言：
 * 1. 死标签——index.html 全部 src 引用的本地文件必须存在（/vendor/* 例外：
 *    server.js vendorMounts 运行时从 node_modules 挂载，非 public/ 静态资产）；
 * 2. ratchet——src 标签总数只减不增，基线 .script-tags-baseline.json；
 *    历次迁移（插件化 + Phase C 各批）删模块时同步删标签已形成事实纪律，
 *    本防线把回潮（新增静态预载）变成测试期拦截；
 * 3. 悬置域清单——悬置工作空间（work-group / flow / dispatch-console）与转入
 *    大工程（qqbot 线程化 / home 小组件）的标签集合固化：只许整体删除
 *    （随各自工程重做消亡），不许以任何形式新增。
 *
 * module 入口登记（ESM 迁移 plan R4）：
 * 4. index.html 的 <script type="module" ...> 入口必须逐条登记在 MODULE_ENTRIES
 *    （src 路径数组），双向一致：清单外标签报错（module 入口的首次执行时机 =
 *    首个 import 它的模块执行时，改变装载时序，必须有意识登记），登记路径在
 *    标签中不存在也报错（入口删除时同步注销登记，不许留悬置清单项）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = path.join(ROOT, 'public/index.html');
const BASELINE = path.join(ROOT, '.script-tags-baseline.json');

// server.js vendorMounts 运行时挂载的包资产（核对存在性时跳过文件系统检查）
const VENDOR_PREFIX = 'vendor/';

const SUSPENDED_TAGS = [
  // work-group（悬置）
  './src/modules/wg-annotations.js',
  './src/modules/wg-context-menu.js',
  './src/modules/wg-core.js',
  './src/modules/wg-popover.js',
  './src/modules/wg-settings-panel.js',
  './src/modules/wg-state.js',
  './src/modules/wg-threads-panel.js',
  './src/modules/wg-voice-input.js',
  './src/modules/resources-viewer.js', // 依赖 WorkGroupUI，随 work-group 悬置
  // qqbot（转线程化工程，界面随重做消亡）
  './src/modules/im-ui.js',
  './src/modules/im-actions.js',
  // dispatch-console（悬置）
  './src/modules/dispatch-ui.js',
  './src/modules/dispatch-actions.js',
  // flow（悬置）
  './flow-editor.js',
  // home（转门户小组件工程）
  './src/modules/home-dashboard.js',
];

// module 入口逐条登记；入口删除时同步注销。路径忽略 ./ 前缀。
const MODULE_ENTRIES = [
  './src/modules/i18n-environment-state.js',
  './src/modules/panel-layout-state.js',
  './src/modules/session-view-storage.js',
  './src/modules/agent-store-state.js',
  './src/modules/render-entry-state.js',
  './src/modules/orchestration-state.js',
];

function scriptSources(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
}

async function readTags() {
  return scriptSources(await readFile(HTML, 'utf8'));
}

test('src 清单覆盖 module/defer 标签，不依赖属性顺序或引号类型', () => {
  assert.deepEqual(scriptSources(`
    <script src="classic.js"></script>
    <script type="module" src="module.js"></script>
    <script defer src='vendor.js'></script>
    <script src='last.js' type='module'></script>
    <script>const text = 'inline';</script>
  `), ['classic.js', 'module.js', 'vendor.js', 'last.js']);
});

// module 标签匹配与属性顺序无关（type 在 src 前后均命中）
const MODULE_TAG_RE = /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/g;

async function readModuleTags() {
  const html = await readFile(HTML, 'utf8');
  return [...html.matchAll(MODULE_TAG_RE)].map((m) => m[1]);
}

const normPath = (p) => p.replace(/^\.\//, '');

test('全部 src 引用的本地文件存在（vendor 运行时挂载除外）', async () => {
  const tags = await readTags();
  assert.ok(tags.length > 0, 'index.html 应含 script src 标签');
  const missing = tags.filter((tag) => {
    const norm = tag.replace(/^\.\//, '');
    if (norm.startsWith(VENDOR_PREFIX) || /^https?:/.test(norm)) return false;
    return !existsSync(path.join(ROOT, 'public', norm));
  });
  assert.deepEqual(missing, [], `指向已删除模块的死标签必须清出 index.html`);
});

test('src 标签总数只减不增（基线 ratchet）', async () => {
  const tags = await readTags();
  const update = process.env.SCRIPT_TAGS_UPDATE_BASELINE === '1';
  if (update || !existsSync(BASELINE)) {
    await writeFile(BASELINE, JSON.stringify({ count: tags.length }, null, 2) + '\n');
    return;
  }
  const { count } = JSON.parse(await readFile(BASELINE, 'utf8'));
  assert.ok(
    tags.length <= count,
    `src 标签 ${tags.length} 超出基线 ${count}：新增模块装载应走 ClawHost 插件（plugin-manifest 登记），不是静态预载`,
  );
});

test('悬置域标签集合固化：只许整体删除，不许新增', async () => {
  const tags = await readTags();
  const suspended = tags.filter((t) => SUSPENDED_TAGS.includes(t));
  // 悬置域现存标签必须是固化清单的子集（整体删除放行）
  const unexpected = suspended.filter((t) => !SUSPENDED_TAGS.includes(t));
  assert.deepEqual(unexpected, []);
  // 固化清单里的前缀不许出现清单外的新变体（如新增 wg-*.js）
  const suspendedPrefixes = ['wg-', 'im-', 'dispatch-', 'flow-', 'home-dashboard'];
  const outside = tags.filter(
    (t) =>
      suspendedPrefixes.some((p) => path.basename(t).startsWith(p)) &&
      !SUSPENDED_TAGS.includes(t),
  );
  assert.deepEqual(outside, [], `悬置/大工程域出现新标签：${outside.join(', ')}——这些域不新增静态装载`);
});

test('module 入口逐条登记：清单外 module 标签报错（plan R4）', async () => {
  const tags = await readModuleTags();
  const registered = new Set(MODULE_ENTRIES.map(normPath));
  const unregistered = tags.filter((t) => !registered.has(normPath(t)));
  assert.deepEqual(
    unregistered,
    [],
    `出现未登记的 module 入口：${unregistered.join(', ')}——新增 module 入口必须在 MODULE_ENTRIES 有意识登记（plan R4）`,
  );
});

test('module 入口双向一致：登记了但标签不存在也报错', async () => {
  const tags = new Set((await readModuleTags()).map(normPath));
  const stale = MODULE_ENTRIES.filter((e) => !tags.has(normPath(e)));
  assert.deepEqual(
    stale,
    [],
    `MODULE_ENTRIES 登记的入口在 index.html 中不存在：${stale.join(', ')}——入口标签已删除时应同步注销登记`,
  );
});
