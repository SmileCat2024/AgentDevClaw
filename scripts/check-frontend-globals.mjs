#!/usr/bin/env node
// 前端全局暴露门禁（ratchet 模式，与 check-import-cycles.mjs 同构）：
// 扫描 public/ 下 classic script 的全局暴露面，与 .frontend-globals-baseline.json
// 对比。暴露键分两层，门禁强度不同：
//
//   state（新增 → exit 1）：顶层 var/let/const 声明、window._* 下划线键赋值。
//     对应 AGENTS.md「全局状态区只减不增」纪律的机器化——新增前端状态必须放
//     modules 局部作用域，跨模块共享走 window.ClawFW。
//   behavior（新增 → 提示不阻塞，台账留痕）：顶层 function/class 声明、
//     window.*（非下划线）赋值。无模块系统下顶层函数挂全局是当前合法的跨文件
//     调用形态；随各域 ESM 化/注册表化从基线消退。
//
// 两层新增都要求显式 --update-baseline 固化，区别只在是否阻塞 pretest。
// window.ClawFW 下划线键直写由 eslint.config.js 的 no-restricted-syntax
// （error + ratchet warn 清单）治理，本脚本不重复。
//
// 用法：
//   node scripts/check-frontend-globals.mjs                  检查（新增 state → exit 1）
//   node scripts/check-frontend-globals.mjs --update-baseline   显式固化/修剪基线
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import * as espreeModule from 'espree';

const espreeParse = espreeModule.parse;

export const projectRoot = resolve(import.meta.dirname, '..');
const BASELINE_PATH = join(projectRoot, '.frontend-globals-baseline.json');

const SCAN_IGNORE_DIRS = new Set(['node_modules', 'vendor', 'dist']);

// ── 纯函数（test/check-frontend-globals.test.js 直接复用） ─────────────

/**
 * 解析单个源文件，返回分层暴露键集合。
 * state：顶层 var/let/const 声明名、window._* 赋值键。
 * behavior：顶层 function/class 声明名、window.*（非下划线）赋值键。
 * IIFE/函数体内的声明不算顶层；window 赋值任意深度都算（模块 API 挂载
 * 的主流形态就是 IIFE 内部 window.x = …）。
 */
export function collectGlobalsFromSource(source) {
  const ast = espreeParse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const state = new Set();
  const behavior = new Set();

  const windowKey = (node) => {
    // 只记 window 的直接键（window.x / window["x"]）。更长的属性链
    //（window.a.b = …）不记：首键 a 的暴露由 window.a = … 整体赋值语句
    // 本身记录，与 ClawFW.someHelper 不单独展开同理。
    if (node.type !== 'MemberExpression') return null;
    if (node.object.type !== 'Identifier' || node.object.name !== 'window') return null;
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
    if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
      return node.property.value;
    }
    return '<computed>';
  };

  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'AssignmentExpression') {
      const key = windowKey(node.left);
      if (key) (key.startsWith('_') ? state : behavior).add(key);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);

  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier') state.add(decl.id.name);
      }
    } else if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') {
      if (stmt.id) behavior.add(stmt.id.name);
    }
  }
  return { state: [...state].sort(), behavior: [...behavior].sort() };
}

/** 递归收集扫描域内的 .js 文件：public/src 整树 + public 根直接文件。 */
export function listFrontendFiles(rootDir) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SCAN_IGNORE_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(join(dir, entry.name));
      }
    }
  };
  const srcDir = join(rootDir, 'public', 'src');
  if (statSync(srcDir).isDirectory()) visit(srcDir);
  const pubDir = join(rootDir, 'public');
  for (const entry of readdirSync(pubDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(join(pubDir, entry.name));
  }
  return out.map((f) => relative(rootDir, f).split('\\').join('/')).sort();
}

/** 汇总所有文件的分层暴露键。无暴露的文件不占位。 */
export function collectAllGlobals(rootDir, files) {
  const result = {};
  for (const rel of files) {
    const source = readFileSync(join(rootDir, rel), 'utf8');
    const { state, behavior } = collectGlobalsFromSource(source);
    if (state.length > 0 || behavior.length > 0) result[rel] = { state, behavior };
  }
  return result;
}

/**
 * 对比基线与当前暴露面，按层分别汇总新增与消失。
 * 返回 { addedState, addedBehavior, removed }，每项为 { file, key }。
 * 基线中没有的文件（新文件）所有键计为新增。
 */
export function compareWithBaseline(baseline, current) {
  const addedState = [];
  const addedBehavior = [];
  const removed = [];

  for (const [file, { state, behavior }] of Object.entries(current)) {
    const base = baseline[file];
    const baseState = new Set(base?.state ?? []);
    const baseBehavior = new Set(base?.behavior ?? []);
    for (const key of state) if (!baseState.has(key)) addedState.push({ file, key });
    for (const key of behavior) if (!baseBehavior.has(key)) addedBehavior.push({ file, key });
  }
  for (const [file, base] of Object.entries(baseline)) {
    const cur = current[file];
    for (const key of base.state ?? []) if (!cur?.state?.includes(key)) removed.push({ file, key });
    for (const key of base.behavior ?? []) if (!cur?.behavior?.includes(key)) removed.push({ file, key });
  }
  return { addedState, addedBehavior, removed };
}

// ── CLI ──────────────────────────────────────────────────────────────

const updateBaseline = process.argv.includes('--update-baseline');
// 基线文件不存在仅在首次固化时合法，否则视为损坏直接报错退出。
let baseline = {};
if (existsSync(BASELINE_PATH)) {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} else if (!updateBaseline) {
  console.error(`[check-frontend-globals] 基线文件缺失：${relative(projectRoot, BASELINE_PATH)}`);
  console.error('首次使用请运行 node scripts/check-frontend-globals.mjs --update-baseline');
  process.exit(1);
}

const files = listFrontendFiles(projectRoot);
const current = collectAllGlobals(projectRoot, files);
const { addedState, addedBehavior, removed } = compareWithBaseline(baseline, current);

if (updateBaseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
  const count = (layer) => Object.values(current).reduce((n, f) => n + f[layer].length, 0);
  console.log(`[check-frontend-globals] 基线已更新：${Object.keys(current).length} 个文件，` +
    `state ${count('state')} 键 / behavior ${count('behavior')} 键。`);
  process.exit(0);
}

let failed = false;
if (addedState.length > 0) {
  failed = true;
  console.error('[check-frontend-globals] 新增全局状态（禁止）：新增前端状态放所属 modules 文件的局部作用域，');
  console.error('跨模块共享经 window.ClawFW。确属必要请显式运行 --update-baseline 并在提交说明中写明理由。');
  for (const { file, key } of addedState) console.error(`  +state   ${file}  →  ${key}`);
}
if (addedBehavior.length > 0) {
  console.log('[check-frontend-globals] 新增全局行为暴露（台账提示，不阻塞；随 ESM 化/注册表化应避免）：');
  for (const { file, key } of addedBehavior) console.log(`  +behavior ${file}  →  ${key}`);
}
if (removed.length > 0) {
  console.log(`[check-frontend-globals] ${removed.length} 个存量键已消失（好趋势），建议 --update-baseline 修剪基线：`);
  for (const { file, key } of removed.slice(0, 10)) console.log(`  -  ${file}  ${key}`);
  if (removed.length > 10) console.log(`  …共 ${removed.length} 项`);
}
if (failed) process.exit(1);
console.log(`[check-frontend-globals] 通过：${files.length} 个文件，state 层无新增。`);
