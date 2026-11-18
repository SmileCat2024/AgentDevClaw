/**
 * script 标签清单防线（Phase C 收尾面 + ESM 迁移 R4 入口纪律）。
 *
 * classic src 标签三道断言：
 * 1. 死标签——index.html 全部 src 引用的本地文件必须存在（/vendor/* 例外：
 *    server.js vendorMounts 运行时从 node_modules 挂载，非 public/ 静态资产）；
 * 2. ratchet——src 标签总数只减不增，基线 .script-tags-baseline.json；
 *    历次迁移（插件化 + Phase C 各批）删模块时同步删标签已形成事实纪律，
 *    本防线把回潮（新增静态预载）变成测试期拦截；
 * 3. 悬置域清单——悬置工作空间（work-group / flow）与转入
 *    大工程（qqbot 线程化 / home 小组件）的标签集合固化：只许整体删除
 *    （随各自工程重做消亡），不许以任何形式新增。
 *
 * module 入口登记（ESM 迁移 plan R4）：
 * 4. index.html 的 <script type="module" ...> 入口必须逐条登记在 MODULE_ENTRIES
 *    （src 路径数组），双向一致：清单外标签报错（module 入口的首次执行时机 =
 *    首个 import 它的模块执行时，改变装载时序，必须有意识登记），登记路径在
 *    标签中不存在也报错（入口删除时同步注销登记，不许留悬置清单项）。
 *
 * 5. classic 标签不得装载 ESM 语法文件：classic script 顶层出现 import/export
 *    语句会在解析期直接 SyntaxError（整条脚本不执行，页面静默残废）。判定走
 *    `vm.Script` 真实编译而不是正则——注释、字符串里的 import/export 字样不会
 *    误报，`import()` 动态导入是合法 classic 语法也不会被拦。文件转为 ESM 后
 *    必须从 index.html 删除 classic 标签，改由 module 入口 import（P2 批次收口
 *    在 modules/p2-entry.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

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
  // 调度面（dispatch-console 工作空间已删除；dispatch-actions 仍被 IM 工作空间
  // 的 im-ui 消费，dispatch-ui 的表单路径已不可达，随 IM 重做一并处理）
  './src/modules/dispatch-ui.js',
  './src/modules/dispatch-actions.js',
  // flow（悬置）
  './flow-editor.js',
  // home（转门户小组件工程）
  './src/modules/home-dashboard.js',
];

// module 入口逐条登记；入口删除时同步注销。路径忽略 ./ 前缀。
const MODULE_ENTRIES = [
  './src/app-core.js',
  './src/modules/auth-client.js',
  './src/modules/i18n-environment-state.js',
  './src/modules/toast-notify.js',
  './src/modules/panel-layout-state.js',
  './src/modules/session-view-storage.js',
  './src/modules/session-view-identity-state.js',
  './src/modules/agent-store-state.js',
  './src/modules/render-entry-state.js',
  './src/modules/orchestration-state.js',
  // P4 T3 收尾：编排域（app-main）迁 ESM。位置在 kernel-entry **之前**——后者图
  // 内的 12 个宿主模块在求值期取本入口提供的 createXHost 工厂（原 classic 解析相
  // 时序的等价表达）。挪动位置即改动时序，必须与本清单一并复核。
  './src/app-main.js',
  './src/modules/kernel-entry.js',
  './src/modules/markdown-utils.js',
  // P4 时序切换：首屏渲染链（applyTheme → applyLanguage → 主视图）的 ESM 入口。
  // 必须保持为 index.html 最后一条 module 标签（它晚于其余入口求值）。
  './src/modules/boot.js',
];

// 由已登记的 module 入口经 static import 带入的生产装载入口（不在 index.html
// 里占标签）。R4 同样适用：它们的首次执行时机由 import 边决定，改装载链就是
// 改时序，所以必须显式登记；登记项必须真被某个登记入口 import，且文件是 ESM
// 语法。P2 消费方批次收口在 p2-entry.js（原 69 条 classic 标签删于此）。
// P4 T5 收尾：p2-entry / p4-entry 已合并进 kernel-entry，本清单清空。
// 若将来再拆出整批入口文件，在这里登记（门禁会核对「被某个入口 import」且「确实是 ESM」）。
const MODULE_ENTRY_IMPORTS = [];

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

/** 登记入口文件的 static side-effect / 具名 import 目标（相对路径解析后）。 */
function importTargets(file) {
  const source = readFileSync(file, 'utf8');
  const specs = [...source.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith('.'));
  // `file` is an OS path, while the import specifier is a POSIX-style URL
  // path. Resolve the specifier with the host path module so Windows drive
  // letters and separators compare canonically with `entryFiles`.
  return specs.map((spec) => path.resolve(path.dirname(file), spec));
}

test('装载入口登记：必须真被登记 module 入口 import，且文件是 ESM 语法', async () => {
  const entryFiles = MODULE_ENTRIES.map((entry) => path.join(ROOT, 'public', normPath(entry)));
  const stale = [];
  const notEsm = [];
  for (const entryImport of MODULE_ENTRY_IMPORTS) {
    const target = path.join(ROOT, 'public', normPath(entryImport));
    if (!entryFiles.some((file) => importTargets(file).includes(target))) {
      stale.push(entryImport);
      continue;
    }
    try {
      new vm.Script(readFileSync(target, 'utf8'), { filename: target });
      notEsm.push(entryImport);
    } catch {
      // classic 相编译失败 = 文件确实含 ESM 语法，符合预期
    }
  }
  assert.deepEqual(
    stale,
    [],
    `登记的装载入口没有被任何 module 入口 import：${stale.join(', ')}——装载链已改变，需同步注销或补 import 边`,
  );
  assert.deepEqual(
    notEsm,
    [],
    `登记的装载入口不含 ESM 语法：${notEsm.join(', ')}——它应是被 import 的 ESM 模块，不是 classic 脚本`,
  );
});

test('首屏渲染入口 boot.js 是最后一条 module 标签（P4 时序切换）', async () => {
  // boot 触发 applyTheme → applyLanguage → 侧栏 / 面板 / 主视图的同步渲染；
  // 首屏链会触达其余 module 入口经桥注册的键，因此它必须晚于全部入口求值。
  const tags = await readModuleTags();
  assert.ok(tags.length > 0, 'index.html 应有 module 入口');
  assert.equal(
    normPath(tags[tags.length - 1]),
    'src/modules/boot.js',
    `最后一条 module 标签应是 boot.js（实际 ${tags[tags.length - 1]}）——首屏渲染链不能抢在其余入口之前`,
  );
});

test('module 入口必须静态非 async（async 绕过 DOMContentLoaded 等待）', async () => {
  const html = await readFile(HTML, 'utf8');
  const moduleTags = [...html.matchAll(/<script\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\btype=["']module["']/.test(tag));
  const asyncEntries = moduleTags.filter((tag) => /\basync\b/.test(tag));
  assert.deepEqual(
    asyncEntries,
    [],
    `出现 async module 入口：${asyncEntries.join(' | ')}——认证初始化（auth-client 等 `
      + 'DOMContentLoaded）与首屏时序依赖"静态非 async 模块早于 DOMContentLoaded 求值"，'
      + 'async 入口会让入口求值越过该等待（plan R4）',
  );
});

async function readClassicTags() {
  const moduleTags = new Set(await readModuleTags());
  return (await readTags()).filter((tag) => !moduleTags.has(tag));
}

test('classic 标签不得装载 ESM 语法文件（classic 相解析即 SyntaxError）', async () => {
  const failures = [];
  for (const tag of await readClassicTags()) {
    const norm = normPath(tag);
    if (norm.startsWith(VENDOR_PREFIX) || /^https?:/.test(norm)) continue;
    const file = path.join(ROOT, 'public', norm);
    if (!existsSync(file)) continue; // 死标签由上面的存在性断言负责
    try {
      new vm.Script(readFileSync(file, 'utf8'), { filename: file });
    } catch (error) {
      failures.push(`${tag}: ${String(error.message).split('\n')[0]}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `classic 标签装到了含 import/export 的文件：${failures.join(' | ')}——文件转 ESM 后必须删除 classic 标签，`
      + '改由 module 入口 import（P2 批次收口在 modules/p2-entry.js）',
  );
});

test('ESM 语法判定口径：真实 import/export 拦截，注释 / 字符串 / 动态 import 不误报', () => {
  const compiles = (source) => {
    try {
      new vm.Script(source, { filename: 'probe-classic.js' });
      return true;
    } catch {
      return false;
    }
  };
  // 反向取证：这两类正是 classic 相会炸的写法
  assert.equal(compiles("import './dependency.js';"), false);
  assert.equal(compiles('const value = 1;\nexport { value };'), false);
  // 不误报：注释、字符串字面量、动态 import() 都是合法 classic 语法
  assert.equal(compiles('// import "./dependency.js";\nconst value = 1;'), true);
  assert.equal(compiles('const hint = "export const value = 1";'), true);
  assert.equal(compiles("const lazy = import('./dependency.js');"), true);
});
