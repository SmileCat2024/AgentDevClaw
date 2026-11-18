/**
 * P2 项目 / 装配批（B1a + B1b + B5 + 桥收敛）独立回归：已迁 ESM 的生产者不再被
 * 本批消费方经 window 调用；纯 ESM 状态窗面收敛为命名导出；classic 消费方归零
 * 的桥键已注销。
 *
 * 扫描口径（不是窄正则）：用 espree 解析真实 AST（与 scripts/check-frontend-globals.mjs
 * 同一 parser 来源与 parse 配置：`{ ecmaVersion: 'latest', sourceType }`，模块解析
 * 失败时按 script 重试一次）——不引入新的解析器依赖。覆盖
 *   window.x / window?.x / window['x'] / window["x"] / `const { x } = window` /
 *   单级别名（`const w = window; w.x`）/ 点号前空格（`window . x`）/
 *   `window.ClawFW.x`（含可选链与计算成员）
 * 解析不了的文件直接判红（不静默跳过）。
 *
 * 依赖说明：espree 由 eslint（devDependency）带入，scripts/check-frontend-globals.mjs
 * 已用它做同类扫描，本用例复用同一来源，不新增依赖。动态计算键（`window[key]`、
 * `window[expr]`）不当作静态键——只有字面量计算成员才算静态路径。
 *
 * 覆盖：
 *   1. 消费面：本批 17 个授权文件对「已迁 ESM 键 + 已注销桥键」零 window 访问。
 *   2. 撤桥净数：project-data / ph-search-locate / session-list-render / trim-page /
 *      debug-overview 里 classic 消费归零的 9 个键——全 public 零 window 访问，
 *      且非 owner 文件的出现只允许是 `import { <key> }`。
 *   3. 纯 ESM 状态键（phSurfaceViewProjectId / phSessionMove / phSearch /
 *      phTopicGroups）的 ClawFW 窗面撤除：静态零引用 + 动态 window 缺失。
 *   4. phProjectEntities：classic sidebar-render 窗面保留；ESM 侧只走命名同源面。
 *   5. 保留桥的必要性抽查：仍有 classic 消费方的键仍注册桥键；claw-select /
 *      input-model-switcher / navigation-core 的窗面（classic / 插件仍读）保留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as espreeModule from 'espree';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const REPO = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(REPO, 'public');
const MOD = (name) => path.join(PUBLIC, 'src', 'modules', name);
const source = (name) => readFileSync(MOD(name), 'utf8');

/** 本批授权改动面（源码）。 */
const BATCH_FILES = [
  'feature-config.js',
  'session-list-render.js',
  'assembly-actions.js',
  'assembly-data.js',
  'workspace-blocks.js',
  'p2-w2-10-workspace-docset.js',
  'session-dialogs.js',
  'trim-page.js',
  'dir-config-dialog.js',
  'session-mutation.js',
  'project-data.js',
  'ph-project-actions.js',
  'ph-session-list.js',
  'ph-session-move.js',
  'ph-search-locate.js',
  'ctx-menu-handlers.js',
  'debug-overview.js',
];

/**
 * 已注销桥键（classic 消费方归零；消费方全部为 ESM 直接 import）：
 *   project-data: getFeatureCreatorProjects / getAgentCreatorProjects /
 *                 hasWorkspaceSessions / applyManagedPrebuiltAgent
 *   ph-search-locate: phSearchLocatePrepare / phSearchLocateAfterOpen
 *   session-list-render: phConversationArchived
 *   trim-page: openTrimPage
 *   debug-overview: closeRepositoryPackageDetails
 */
const RETIRED_BRIDGE_KEYS = [
  'getFeatureCreatorProjects', 'getAgentCreatorProjects',
  'hasWorkspaceSessions', 'applyManagedPrebuiltAgent',
  'phSearchLocatePrepare', 'phSearchLocateAfterOpen',
  'phConversationArchived', 'openTrimPage', 'closeRepositoryPackageDetails',
];

/** 仍注册桥键的键（classic 消费方仍在，抽查桥不误删）。 */
const RETAINED_BRIDGE_KEYS = {
  'project-data.js': ['getPathLeaf', 'getAgentWorkspaceState', 'updateAgentRecord', 'canEnterWorkspaceChat',
    'resolveSidebarChildProjectGroup', 'getPhBrowsingTarget', 'getPhSessionOwnershipParams',
    'ensurePhProjectEntitiesLoaded'],
  'session-list-render.js': ['renderWorkspaceSessionList', 'onPhSessionDragStart'],
  'debug-overview.js': ['openRepositoryPackageDetails', 'renderStructurePanel', 'renderMonitorPanel'],
};

/** 已撤的纯 ESM 状态键：ClawFW 命名空间上不得再出现。 */
const ESM_ONLY_CLAW_KEYS = ['phSurfaceViewProjectId', 'phSessionMove', 'phSearch', 'phTopicGroups'];

/** ESM 侧仍可经 window 访问的已迁键（保留桥 + 插件/classic 仍在读）不在本文件管辖。 */
const ESM_ONLY_RESERVED_CLAW_KEY = 'phProjectEntities';

// ── AST 扫描器 ────────────────────────────────────────────────────

function walk(node, cb, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, cb, parent);
    return;
  }
  if (typeof node.type === 'string') cb(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walk(node[key], cb, node);
  }
}

/**
 * 解析一份源码，返回：
 *   accesses: [{ path, write, line }] —— window 根成员访问（含别名 / 解构展开）
 *   imports : Set<string>            —— import 引入的标识符名
 *   ids     : Set<string>            —— 出现过的裸标识符名
 *   parseError: string | null
 */
const espreeParse = espreeModule.parse;

/** 与门禁脚本同款 parse：先按 ESM 解，失败再按 classic script 重试。 */
function parseSource(sourceText) {
  try {
    return espreeParse(sourceText, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (error) {
    try {
      return espreeParse(sourceText, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch {
      throw error; // 两个形态都解析不了：把模块解析错误抛给调用方判红
    }
  }
}

function analyze(sourceText) {
  let ast;
  try {
    ast = parseSource(sourceText);
  } catch (error) {
    return { accesses: [], imports: new Set(), ids: new Set(), parseError: error.message };
  }

  const imports = new Set();
  const ids = new Set();
  // 别名表：标识符名 → 被别名的静态路径（const w = window → 'window'，
  // const fw = window.ClawFW → 'window.ClawFW'）。用 Map 才能保住后者，
  // 否则 `fw.phSearch` 会被错算成 `window.phSearch` 而漏掉 ClawFW 键。
  const aliases = new Map([['window', 'window']]);
  const accesses = [];
  const lineOf = (node) => sourceText.slice(0, node.start).split('\n').length;
  /** 静态属性名：只有非计算的标识符 / 字面量计算成员才算静态键。 */
  const propName = (node) => {
    if (!node) return null;
    if (node.computed) return node.property?.type === 'Literal' && typeof node.property.value === 'string'
      ? node.property.value
      : null; // 动态计算键（window[key] / window[expr]）不当作静态键
    return node.property?.type === 'Identifier' ? node.property.name : null;
  };
  const pathOf = (node, depth = 0) => {
    if (!node || depth > 8) return null;
    if (node.type === 'ChainExpression') return pathOf(node.expression, depth + 1);
    if (node.type === 'Identifier') return aliases.get(node.name) ?? null;
    if (node.type === 'MemberExpression') {
      const base = pathOf(node.object, depth + 1);
      const key = propName(node);
      return base && key ? `${base}.${key}` : null;
    }
    return null;
  };

  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) {
        if (spec.local?.name) imports.add(spec.local.name);
        const imported = spec.imported?.name ?? spec.imported?.value;
        if (imported) imports.add(imported);
      }
    }
    if (node.type === 'Identifier') ids.add(node.name);
    if (node.type === 'VariableDeclarator' && node.init) {
      // 单级别名：const w = window / const fw = window.ClawFW（含可选链）
      const initPath = pathOf(node.init);
      if (initPath && node.id.type === 'Identifier') aliases.set(node.id.name, initPath);
    }
  });

  walk(ast, (node, parent) => {
    if (node.type === 'MemberExpression') {
      const dotted = pathOf(node);
      if (dotted?.startsWith('window.')) {
        const isWrite = parent
          && ((parent.type === 'AssignmentExpression' && parent.left === node)
            || parent.type === 'UpdateExpression'
            || (parent.type === 'UnaryExpression' && parent.operator === 'delete'));
        accesses.push({ path: dotted, write: Boolean(isWrite), line: lineOf(node) });
      }
    }
    // const { a, b } = window 解构：展开成 window.a / window.b
    if (node.type === 'VariableDeclarator' && node.init && node.id.type === 'ObjectPattern') {
      const basePath = pathOf(node.init);
      if (basePath?.startsWith('window')) {
        for (const prop of node.id.properties) {
          if (prop.type !== 'Property') continue;
          const key = prop.key?.name ?? prop.key?.value;
          if (key) accesses.push({ path: `${basePath}.${key}`, write: false, line: lineOf(prop) });
        }
      }
    }
  });

  return { accesses, imports, ids, parseError: null };
}

function listPublicSources(dir = PUBLIC, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'assets' || entry.name === 'node_modules') continue;
      listPublicSources(full, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 提到某个键名的文件（先做低成本文本预筛，再 AST 精判）。 */
function filesMentioning(key) {
  const word = new RegExp(`\\b${key}\\b`);
  return listPublicSources().filter((file) => word.test(readFileSync(file, 'utf8')));
}

function isEsm(text) {
  return /^\s*(?:import|export)\s/m.test(text);
}

// ── 0. 扫描器自检（证明「坏形态必红」而不是只靠断言文案） ────────────

test('扫描器自检：window 六种形态 + 别名/解构/ClawFW 必命中，正常 import 与动态键不误报', () => {
  const cases = [
    // [源码, 期望静态路径, 是否应命中]
    ['window.x(k)', 'window.x', true],
    ['window?.x(k)', 'window.x', true],
    ["window['x'](k)", 'window.x', true],
    ['window . x;', 'window.x', true],
    ['const { x } = window; x();', 'window.x', true],
    ['const w = window; w.x();', 'window.x', true],
    // ClawFW 别名：必须保成 window.ClawFW.x（旧 Set 实现会错算成 window.x 而漏键）
    ['const fw = window.ClawFW; fw.x;', 'window.ClawFW.x', true],
    ["const fw = window.ClawFW; fw?.['x'];", 'window.ClawFW.x', true],
    ['const { x } = window.ClawFW;', 'window.ClawFW.x', true],
    // 正常 import 形态：不是 window 访问，不得误报
    ["import { x } from './x.js'; x();", 'window.x', false],
    ["import { x as y } from './x.js'; y();", 'window.x', false],
    // 动态计算键：不是静态键，不得当作 window.x
    ['const key = "x"; window[key];', 'window.x', false],
    ['const key = "x"; window?.ClawFW[key];', 'window.ClawFW.x', false],
  ];
  for (const [src, expectedPath, shouldHit] of cases) {
    const { accesses, parseError } = analyze(src);
    assert.equal(parseError, null, `样例应可解析：${src}`);
    const hit = accesses.some((access) => access.path === expectedPath);
    assert.equal(hit, shouldHit, `${shouldHit ? '应命中' : '不应误报'} ${expectedPath} ← ${src}`);
  }
  // 解析不了就是红（不静默放行）
  assert.notEqual(analyze('export function (').parseError, null, '不可解析源码必须判红');
  // 写点识别：赋值算写、读算读
  const writes = analyze('window.x = 1; const y = window.x;');
  assert.deepEqual(writes.accesses.map((a) => a.write).sort(), [false, true]);
});

// ── 1. 消费面：本批文件对已迁键零 window 访问 ──────────────────────

test('消费面（AST）：本批 17 文件对已迁 ESM 键与已注销桥键零 window 访问', () => {
  const keys = [...RETIRED_BRIDGE_KEYS, 'getAgentWorkspaceState', 'updateAgentRecord', 'getPathLeaf',
    'ensurePhProjectEntitiesLoaded', 'getPhBrowsingTarget', 'canEnterWorkspaceChat',
    'getWorkspaceSessionById', 'closeCompactMenu', 'openRepositoryPackageDetails',
    'getPhSurfaceViewProjectId', 'setPhSurfaceViewProjectId', 'getThinkingEffortOptions'];
  const offenders = [];
  for (const file of BATCH_FILES) {
    const { accesses, parseError } = analyze(source(file));
    assert.equal(parseError, null, `${file} 应可被 espree 解析：${parseError}`);
    for (const access of accesses) {
      const leaf = access.path.split('.').at(-1);
      const isClawCfm = access.path === `window.ClawFW.${leaf}`;
      const isDirect = access.path === `window.${leaf}`;
      if (!(isClawCfm || isDirect)) continue;
      // project-data 是 phProjectEntities 的 owner：初始化行（写 + 右侧 `||` 读）与
      // 命名面派生读都在这里，是唯一允许出现该 window 路径的 ESM 文件
      if (file === 'project-data.js' && access.path === 'window.ClawFW.phProjectEntities') continue;
      if (keys.includes(leaf) || ESM_ONLY_CLAW_KEYS.includes(leaf)) {
        offenders.push(`${file}:${access.line} ${access.write ? 'W' : 'R'} ${access.path}`);
      }
      if (leaf === ESM_ONLY_RESERVED_CLAW_KEY) {
        offenders.push(`${file}:${access.line} ${access.write ? 'W' : 'R'} ${access.path}（ESM 侧应走命名面）`);
      }
    }
  }
  assert.deepEqual(offenders, [], `window 残留（AST 口径，含 ?. / [] / 解构 / 别名 / ClawFW）：\n${offenders.join('\n')}`);
});

// ── 2. 撤桥净数：9 键全 public 零 window 访问 + 非 owner 只有 import ──

test('撤桥（AST × 全 public）：9 个零消费键无 window 访问，非 owner 只以 import 出现', () => {
  const failures = [];
  for (const key of RETIRED_BRIDGE_KEYS) {
    for (const file of filesMentioning(key)) {
      const rel = path.relative(REPO, file);
      const text = readFileSync(file, 'utf8');
      const { accesses, imports, ids, parseError } = analyze(text);
      assert.equal(parseError, null, `${rel} 应可被 espree 解析：${parseError}`);
      // (a) 任何形态的 window 访问都不允许
      for (const access of accesses) {
        if (access.path === `window.${key}` || access.path === `window.ClawFW.${key}`) {
          failures.push(`${rel}:${access.line} ${access.write ? 'W' : 'R'} ${access.path}`);
        }
      }
      // 注释 / 纯字符串里的提及不是消费（AST 口径：只看标识符）
      if (!ids.has(key)) continue;
      // (b) classic 文件（无 import/export）不得再以裸标识符引用这个键
      if (!isEsm(text)) failures.push(`${rel}: classic 文件仍以裸标识符引用 ${key}`);
      // (c) ESM 文件要么是本键 owner（定义它），要么以 import 引入
      const defines = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${key}\\b|(?:export\\s+)?(?:const|let|var)\\s+${key}\\b`).test(text);
      if (!defines && !imports.has(key)) failures.push(`${rel}: ESM 引用 ${key} 但未 import`);
    }
  }
  assert.deepEqual(failures, [], `撤桥后仍有残留消费：\n${failures.join('\n')}`);
});

// ── 3. 纯 ESM 状态键的 ClawFW 窗面撤除（静态） ─────────────────────

test('状态窗面（AST × 全 public）：phSurfaceViewProjectId / phSessionMove / phSearch / phTopicGroups 无 ClawFW 引用', () => {
  const failures = [];
  for (const key of ESM_ONLY_CLAW_KEYS) {
    for (const file of filesMentioning(key)) {
      const rel = path.relative(REPO, file);
      const { accesses, parseError } = analyze(readFileSync(file, 'utf8'));
      assert.equal(parseError, null, `${rel} 应可被 espree 解析：${parseError}`);
      for (const access of accesses) {
        if (access.path === `window.ClawFW.${key}`) {
          failures.push(`${rel}:${access.line} ${access.write ? 'W' : 'R'} ${access.path}`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `ClawFW 窗面未撤干净：\n${failures.join('\n')}`);
});

// ── 4. phProjectEntities：classic 窗面保留、ESM 只走命名同源面 ──────

test('phProjectEntities：ESM 侧只走命名面（含已迁 ESM 的 sidebar-render）', () => {
  const sidebar = source('sidebar-render.js');
  // P4 T2 起 sidebar-render 已是 ESM，但它仍只经**桥键**读实体缓存
  // （`window.phProjectEntities`，project-data 注册的访问器）；具名 import 会把
  // project-data → session-ui 的整条图拉进侧栏域模块相，故保留桥读。
  assert.equal(/\(window\.ClawFW\?\.phProjectEntities\?\.projects/.test(sidebar), false,
    'ESM 侧不得直接读 window.ClawFW 的实体缓存面');
  assert.match(sidebar, /\(window\.phProjectEntities\?\.projects/, '侧栏签名经桥键读同一对象');

  const data = source('project-data.js');
  assert.match(data, /window\.ClawFW\.phProjectEntities = window\.ClawFW\.phProjectEntities \|\| \{/,
    'owner 在求值时点初始化 window 键');
  assert.match(data, /export const phProjectEntities = window\.ClawFW\.phProjectEntities;/,
    'ESM 命名面取自同一对象（求值时点同源）');

  // ESM 模块不得再 window 读实体缓存（除 owner 的初始化写）
  const offenders = [];
  for (const file of filesMentioning('phProjectEntities')) {
    const rel = path.relative(REPO, file);
    const text = readFileSync(file, 'utf8');
    if (!isEsm(text)) continue;
    const { accesses } = analyze(text);
    if (rel.endsWith(path.join('modules', 'project-data.js'))) continue; // owner 初始化/派生点
    for (const access of accesses) {
      if (access.path !== 'window.ClawFW.phProjectEntities') continue;
      offenders.push(`${rel}:${access.line} ${access.write ? 'W' : 'R'}`);
    }
  }
  assert.deepEqual(offenders, [], `ESM 侧仍 window 读实体缓存：\n${offenders.join('\n')}`);
});

// ── 5. 保留桥与生产者窗面（防止误删） ─────────────────────────────

test('保留桥键仍注册：classic 消费方未迁的键不得被顺手删掉', () => {
  for (const [file, keys] of Object.entries(RETAINED_BRIDGE_KEYS)) {
    const text = source(file);
    for (const key of keys) {
      assert.match(text, new RegExp(`defineKey\\('${file.replace(/\.js$/, '')}', '${key}'`),
        `${file} 应仍为 ${key} 注册桥键`);
    }
  }
  // 生产方窗面（classic / 插件仍读）保留
  assert.match(source('claw-select.js'), /window\.ClawSelect = \{/);
  assert.match(source('input-model-switcher.js'), /window\.ClawFW\.getThinkingEffortOptions = getThinkingEffortOptions;/);
  assert.match(source('navigation-core.js'), /window\.NavigationCore = /);
  // launchAssemblyInstance 仍由 app-ui 经 window 消费 → 桥/窗面不得删
  const appUi = readFileSync(path.join(PUBLIC, 'src', 'app-ui.js'), 'utf8');
  assert.match(appUi, /window\.launchAssemblyInstance\b/, 'app-ui 仍经 window 调 launchAssemblyInstance');
});

// ── 6. 动态：状态 owner 与窗面缺席 ────────────────────────────────

test('动态：状态 owner 生效、ClawFW 纯 ESM 键缺席、保留桥可达', async () => {
  const elements = new Map();
  const makeElement = () => ({
    innerHTML: '', textContent: '', value: '', disabled: false,
    style: {}, dataset: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, insertBefore() {},
    remove() {}, focus() {}, querySelector: () => null, querySelectorAll: () => [],
    getAttribute: () => null, setAttribute() {}, closest: () => null,
  });
  const documentStub = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {}, innerHTML: '' },
    documentElement: { style: {} },
    readyState: 'complete',
  };
  await withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      sandbox.run(`
        window.getCurrentAgentRecord = () => null;
        window.renderCurrentMainView = () => {};
        window.createAgentSnapshotLoaderHost = () => ({ state: {} });
        window.createRuntimeSwitchHost = () => ({ state: {} });
        window.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        window.createAgentCallStatesHost = () => ({ state: {} });
        window.createSessionViewCommitHost = () => ({ state: {} });
        window.createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
        window.createWorkspaceSurfaceHost = () => ({ state: {} });
        window.createPollCoordinatorHost = () => ({
          run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
        });
      `);
    },
    globals: {
      document: documentStub,
      fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
      console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    },
  }, async (c) => {
    const projectData = await c.load('public/src/modules/project-data.js');
    // classic 读方读 window；ESM 读同一对象（求值时点同源）——变异经两侧可见
    assert.equal(projectData.phProjectEntities, c.window.ClawFW.phProjectEntities);
    projectData.phProjectEntities.projects = [{ id: 'prj_live', name: 'Live', archived: false }];
    assert.equal(c.window.ClawFW.phProjectEntities.projects.length, 1, '同源：ESM 写可见于 window 侧');
    projectData.phProjectEntities.projects = [];

    // 撤桥：9 个零消费键在 window 上不存在
    for (const key of RETIRED_BRIDGE_KEYS) {
      assert.equal(Object.getOwnPropertyDescriptor(c.window, key), undefined, `${key} 的桥应已注销`);
    }
    // 保留桥：classic 消费方仍在的键可达
    assert.equal(c.window.getAgentWorkspaceState, projectData.getAgentWorkspaceState);
    assert.equal(c.window.updateAgentRecord, projectData.updateAgentRecord);

    const sessionList = await c.load('public/src/modules/ph-session-list.js');
    for (const key of ['phSurfaceViewProjectId', 'phSessionMove', 'phSearch', 'phTopicGroups']) {
      assert.equal(Object.prototype.hasOwnProperty.call(c.window.ClawFW, key), false, `ClawFW.${key} 窗面应已撤`);
    }
    assert.equal(sessionList.getPhSurfaceViewProjectId(), null, '初值无覆盖');
    sessionList.setPhSurfaceViewProjectId('prj_remote_1');
    assert.equal(sessionList.getPhSurfaceViewProjectId(), 'prj_remote_1');
    sessionList.setPhSurfaceViewProjectId(null);
    assert.equal(sessionList.getPhSurfaceViewProjectId(), null, '空值即清除');

    const move = await c.load('public/src/modules/ph-session-move.js');
    assert.equal(move.phSessionMove.selectMode, false);
    move.phToggleSessionSelectMode();
    assert.equal(move.phSessionMove.selectMode, true, '状态 owner 即命名导出对象');
    move.phToggleSessionSelectMode();

    // 搜索状态袋与话题分组是模块私有/命名导出，window 侧不复制
    assert.equal(typeof sessionList._phSearch, 'object');
    assert.equal(c.window.ClawFW.phSearch, undefined);

    // 保留桥：debug-overview 的 open... 仍可达（classic app-ui 读），close... 已注销
    const overview = await c.load('public/src/modules/debug-overview.js');
    assert.equal(c.window.openRepositoryPackageDetails, overview.openRepositoryPackageDetails);
    assert.equal(c.window.closeRepositoryPackageDetails, undefined);
  });
});
