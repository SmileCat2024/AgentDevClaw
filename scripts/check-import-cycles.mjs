#!/usr/bin/env node
// import 循环依赖检查（ratchet 模式）：扫描仓库内有静态 import 边的代码域，检测
// 值级循环依赖。存量环固化为基线指纹豁免，新增环直接报错——架构约束靠脚本拦截，
// 不靠记性（参考 ZCode .architecture-baseline.json 的增量治理模式）。
//
// 只跟踪仓库内相对路径导入（./ ../）；裸包名（node:、@agentdevjs/* 等）不进图。
// 只报告值级循环：`import type` 语句编译后消失，相互引用类型是 TS 项目的正常
// 形态，不构成运行期风险；混合具名导入（`import { type A, b }`）按值边处理。
// 动态 import('...') 与 export-from 也算边（运行期执行依赖）。
//
// 扫描域：server/、scripts/、prebuilt-agents/、local-features/（ts，排除 dist）、
// bin/。public/src 不在列——它是 <script> 顺序加载 + 全局共享模式，没有静态
// import 图，无从检测（其治理由 ESLint ClawFW 下划线键规则承担）。
//
// 用法：
//   node scripts/check-import-cycles.mjs                 检查（新增环 → exit 1）
//   node scripts/check-import-cycles.mjs --update-baseline   显式固化/修剪基线
import { promises as fs } from 'fs';
import { statSync } from 'fs';
import { join, resolve, dirname, relative, sep } from 'path';
import { pathToFileURL } from 'url';

export const projectRoot = resolve(import.meta.dirname, '..');
const BASELINE_PATH = join(projectRoot, '.import-cycles-baseline.json');

const SCAN_ROOTS = ['server', 'scripts', 'prebuilt-agents', 'local-features', 'bin'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const SCAN_IGNORE_DIRS = new Set(['node_modules', 'dist', '.agentdev', 'skills', '.git']);

// ── 纯函数（test/check-import-cycles.test.js 直接复用） ─────────────────

/** 剥离行注释行，避免注释里的 import 语句污染图。块注释罕见于 import 区，接受漏网。 */
function stripCommentLines(source) {
  return source.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 解析一段源码中的 import 边。返回 [{ specifier, kind }]：
 * kind = 'value'（静态值导入 / 副作用导入 / export-from / 动态字面量 import）
 *      | 'type'（仅 import type 语句，不构成运行期边，调用方应忽略）
 */
export function parseImportEdges(source) {
  const text = stripCommentLines(source);
  const edges = [];
  const seen = new Set();
  const push = (specifier, kind) => {
    const key = `${kind}:${specifier}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ specifier, kind });
    }
  };

  // import [type] clause from 'spec' / import 'spec'（副作用）。
  // 子句约束 [^;'"]*? 阻止跨语句吞噬：否则 import './side.js'; export { a } from 'x'
  // 会被当作一条 from 语句，副作用导入丢失。
  const importRe =
    /import\s+(type\b)?([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(importRe)) {
    if (m[4] !== undefined) push(m[4], 'value'); // 副作用导入
    else push(m[3], m[1] ? 'type' : 'value');
  }

  // export { x } from / export * from；export type {...} from 为纯类型再导出，跳过
  const exportRe = /export\s+(type\s+)?(?:\{[^}]*\}|\*)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(exportRe)) {
    if (!m[1]) push(m[2], 'value');
  }

  // 动态 import('literal')：字面量才可静态解析，模板串/变量无法跟踪
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(dynamicRe)) {
    push(m[1], 'value');
  }
  return edges;
}

/** 相对导入候选路径：覆盖无扩展名、目录 index、TS NodeNext 的 .js→.ts 后缀风格。 */
function candidatePaths(base) {
  const list = [base];
  if (base.endsWith('.js')) list.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  if (base.endsWith('.mjs')) list.push(base.slice(0, -4) + '.mts');
  if (base.endsWith('.cjs')) list.push(base.slice(0, -4) + '.cts');
  if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(base)) {
    list.push(base + '.ts', base + '.tsx', base + '.js', base + '.mjs');
  }
  list.push(
    join(base, 'index.ts'), join(base, 'index.tsx'),
    join(base, 'index.js'), join(base, 'index.mjs'),
  );
  return list;
}

/**
 * 解析 fromFile 中的相对 specifier，返回目标文件的绝对路径；解析失败或指向
 * 仓库外（如 ../AgentDev 框架仓库）返回 null。
 */
export function resolveRelativeSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const base = resolve(dirname(fromFile), specifier);
  if (relative(projectRoot, base).startsWith('..')) return null;
  for (const candidate of candidatePaths(base)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 候选不存在，继续
    }
  }
  return null;
}

/**
 * 从邻接表（file → Set<file>）找所有循环强连通分量。
 * 返回 SCC 成员数组（size > 1 的环，或 import 自身的自环节点）。
 */
export function findCyclicSccs(graph) {
  const indexCounter = { next: 0 };
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const sccs = [];

  const strongConnect = (v) => {
    indices.set(v, indexCounter.next);
    lowlinks.set(v, indexCounter.next);
    indexCounter.next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || graph.get(v)?.has(v)) sccs.push(component);
    }
  };

  for (const v of graph.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }
  return sccs;
}

/** 环指纹：成员相对仓库根的 posix 路径排序后 join，与成员在环内的顺序无关。 */
export function cycleFingerprint(cycleMembers) {
  return cycleMembers
    .map((f) => relative(projectRoot, f).split(sep).join('/'))
    .sort()
    .join('|');
}

/** 基线 diff：新增环（报错依据）与已消失环（可从基线修剪）。 */
export function diffCycles(currentFingerprints, baselineFingerprints) {
  const current = new Set(currentFingerprints);
  const baseline = new Set(baselineFingerprints);
  return {
    added: [...current].filter((f) => !baseline.has(f)),
    resolved: [...baseline].filter((f) => !current.has(f)),
  };
}

// ── 文件扫描与图构建 ──────────────────────────────────────────────────────

async function collectSourceFiles(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 域目录不存在（如 bin/ 特定布局变化）直接跳过
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SCAN_IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(full, out);
    } else if (SCAN_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(full);
    }
  }
}

async function buildGraph() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    await collectSourceFiles(join(projectRoot, root), files);
  }
  const graph = new Map();
  for (const file of files) graph.set(file, new Set());
  let unresolved = 0;
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const { specifier, kind } of parseImportEdges(source)) {
      if (kind !== 'value') continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue; // 裸包名不进图
      const target = resolveRelativeSpecifier(file, specifier);
      if (target && graph.has(target)) {
        graph.get(file).add(target);
      } else if (target) {
        // 指向构建产物（local-features/dist、features/）是装配层的正常形态：
        // 源文件已在图内，dist 内部边不重复跟踪。其余图外目标才是扫描盲区。
        const rel = relative(projectRoot, target).split(sep).join('/');
        if (!rel.startsWith('local-features/dist/') && !rel.startsWith('features/')) unresolved += 1;
      } else {
        unresolved += 1;
      }
    }
  }
  return { graph, fileCount: files.length, unresolved };
}

// ── CLI（import 本模块复用纯函数时不会触发） ────────────────────────────

async function readBaseline() {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, 'utf8'));
  } catch {
    return { version: 1, cycles: [] };
  }
}

function describeCycle(members, graph) {
  // 从最小路径成员出发，沿环内边走一圈，输出 a -> b -> a 链
  const start = [...members].sort()[0];
  const inCycle = new Set(members);
  const chain = [start];
  let current = start;
  for (;;) {
    const next = [...graph.get(current)].filter((f) => inCycle.has(f)).sort()[0];
    if (!next || next === start || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  const short = (f) => relative(projectRoot, f).split(sep).join('/');
  return `${chain.map(short).join(' -> ')} -> ${short(start)}`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) await main();

async function main() {
  const updateBaseline = process.argv.includes('--update-baseline');
  const { graph, fileCount, unresolved } = await buildGraph();
  const sccs = findCyclicSccs(graph);
  const current = sccs.map((members) => cycleFingerprint(members)).sort();
  const baseline = await readBaseline();
  const { added, resolved } = diffCycles(current, baseline.cycles ?? []);

  const sccByFingerprint = new Map(sccs.map((members) => [cycleFingerprint(members), members]));

  if (updateBaseline) {
    await fs.writeFile(
      BASELINE_PATH,
      `${JSON.stringify({ version: 1, cycles: current }, null, 2)}\n`,
      'utf8',
    );
    console.log(
      `[import-cycles] 基线已更新：${current.length} 个存量环固化，` +
        `${resolved.length} 个环移出基线。下次检查起，新增环将直接报错。`,
    );
    process.exit(0);
  }

  console.log(
    `[import-cycles] 扫描 ${fileCount} 个源文件，` +
      `值级循环 ${current.length} 个（基线豁免 ${current.length - added.length}，新增 ${added.length}）。` +
      `${unresolved ? `\n[import-cycles] 警告：${unresolved} 个相对导入无法解析或指向扫描域外，请检查扫描根配置。` : ''}`,
  );

  if (added.length > 0) {
    console.error(`\n[import-cycles] 发现新增值级循环依赖（error）：`);
    for (const fingerprint of added) {
      const members = sccByFingerprint.get(fingerprint);
      console.error(`  - ${describeCycle(members, graph)}`);
    }
    console.error(
      `\n循环依赖的模块在加载顺序上脆弱、重构时互相牵连。请拆出共享层或改用 type-only 导入；` +
        `\n若确认接受该存量环，运行 npm run check:cycles -- --update-baseline 显式固化。`,
    );
    process.exit(1);
  }

  if (resolved.length > 0) {
    console.log(
      `[import-cycles] ${resolved.length} 个基线环已消失，运行 ` +
        `npm run check:cycles -- --update-baseline 修剪基线。`,
    );
  }
}
