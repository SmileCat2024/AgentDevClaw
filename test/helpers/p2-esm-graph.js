/**
 * p2-esm-graph.js — 前端 ESM 依赖图的 case 级命名空间（真实 import 路线）。
 *
 * 为什么需要：esm-module-loader 的 `loadModuleOnce` 只给**入口文件**唯一
 * query，静态 import 解析到无 query 的规范 URL，因此依赖模块在整个测试进程
 * 里只执行一次。对 P2 跨批测试这是两种污染：
 *   - 模块级状态（i18n 语言、`_fceSeq` 之类）跨 case 复用；
 *   - 桥键 `defineKey` / `claim` 在依赖模块里只发生一次，第二个 case 的
 *     入口重新执行会撞 "桥键重复注册" 或把 claim 留在上一个 case 的 window。
 *
 * 做法：用 `node:module` 的 `registerHooks`（Node ≥ 22.15，同步 resolve 钩子）
 * 在 case 激活期间给**仓库前端模块图**的每个解析结果追加同一个 case query。
 * 同一个 case 内所有模块共享同一份 query，所以：
 *   - 入口与静态依赖落在同一代实例上，跨模块状态照常共享；
 *   - 静态循环（A→B→A）的每一跳解析到同一 URL，循环仍合法闭合——
 *     query 是「每 case 一个」，不是「每次 import 一个」，不会把 A 拆成多代；
 *   - 下一个 case 换 query，整张图重新实例化（含依赖），与上一 case 互不可见。
 * 不做任何源码变换：import/export 原样交给 Node，图的语法合法性由 Node 判定。
 *
 * 作用域只有两处（纯路径前缀，不看文件内容）：
 *   - `public/`：产品前端 ESM 图；
 *   - `test/helpers/p2-esm-fixture-`：本套 helper 的 fixture（循环/状态共享的最小图，
 *     用于证明 query 语义，不碰业务源码）。
 * 其它路径（node: 内建、test runner、node_modules）一律原样返回。
 *
 * API（p2-esm-case.js 使用，一般测试不直接调用）：
 *   beginCaseGraph(caseId) / endCaseGraph(caseId)
 *     全局同一时刻只允许一个激活的 case；由 p2-esm-case 的互斥闸保证。
 */
import module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CASE_QUERY_KEY = 'p2esm-case';

const SCOPED_PREFIXES = [
  pathToFileURL(path.join(REPO_ROOT, 'public') + path.sep).href,
  // fixture：本套 helper 的 `p2-esm-fixture-*` 文件（循环/状态 owner 用例）；
  // 不含 p2-esm-case / p2-esm-graph 自身，避免 case 内动态 import 到第二份 helper。
  pathToFileURL(path.join(REPO_ROOT, 'test', 'helpers', 'p2-esm-fixture-')).href,
];

let activeCaseId = null;
let hooksInstalled = false;

function isScoped(rawUrl) {
  return SCOPED_PREFIXES.some((prefix) => rawUrl.startsWith(prefix));
}

/** 给 URL 追加本 case 的 query；已有本键（如父模块已带）则保持原样。 */
function withCaseQuery(rawUrl, caseId) {
  const url = new URL(rawUrl);
  if (url.searchParams.has(CASE_QUERY_KEY)) return url.href;
  url.searchParams.set(CASE_QUERY_KEY, caseId);
  return url.href;
}

function ensureHooks() {
  if (hooksInstalled) return;
  if (typeof module.registerHooks !== 'function') {
    throw new Error(
      'p2-esm-graph: 需要 node:module 的 registerHooks（Node ≥ 22.15）；当前 '
      + `${process.version} 不支持，无法建立 case 级 ESM 图隔离`,
    );
  }
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const caseId = activeCaseId;
      if (!caseId || typeof resolved.url !== 'string') return resolved;
      if (!isScoped(resolved.url)) return resolved;
      return { ...resolved, url: withCaseQuery(resolved.url, caseId) };
    },
  });
  hooksInstalled = true;
}

export function beginCaseGraph(caseId) {
  ensureHooks();
  if (activeCaseId !== null) {
    throw new Error(`p2-esm-graph: case 图未清理就再次激活（当前 ${activeCaseId}，新 ${caseId}）`);
  }
  activeCaseId = String(caseId);
}

export function endCaseGraph(caseId) {
  if (activeCaseId === String(caseId)) activeCaseId = null;
}

/** 诊断/断言用：当前激活的 case id，未激活为 null。 */
export function activeCaseGraph() {
  return activeCaseId;
}
