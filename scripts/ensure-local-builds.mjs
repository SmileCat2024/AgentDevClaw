#!/usr/bin/env node
// 保证 local-features、features/* 与（开发态）相邻框架仓库的编译产物
// （gitignored 的 dist）可用且不过时。
//
// 触发重编译的条件（满足其一）：
//   1. dist 不存在（全新克隆 / 老用户从未构建）；
//   2. 源码树中任一文件比 dist 中最新文件更新（git pull / git checkout
//      会刷新源码 mtime，天然命中）。
//
// 背景：prebuilt agent 按源码路径 import local-features/dist 与
// features/*/dist（见各 agent.js 顶层 import），这些 dist 不入库也不随
// npm install 产生。没有本模块时，git pull + npm install + npm start
// 的升级路径会加载陈旧 dist 或直接 import 失败。
//
// 开发态还覆盖相邻框架仓库：node_modules/@agentdevjs/* 链接解析到
// AgentDev/packages/*/dist，git pull 框架仓库不会触发任何重建，服务会
// 静默跑在陈旧框架代码上（历史事故：模型热切换、超时语义更新不生效）。
// 检测到被消费的框架包过时，只构建该包及依赖它的包；
// 发布态 dist 由 npm registry 安装，跳过检查。
//
// 由 preflight.mjs（prestart/predev）调用；也可独立运行。
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';
import { isDevForm, siblingAgentdevPath, PACKAGE_MAP, probe } from './check-agentdev-local.mjs';

const root = resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';

// Windows 上 npm 是 npm.cmd 批处理，必须经 shell 调用（与 build-features.mjs 同约定）。
function runNpm(args, cwd = root) {
  return IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
}

// 目录树内（排除 skip 中的名字）所有文件的最新 mtime；目录不存在返回 0。
function newestMtime(dir, skip = new Set(['node_modules'])) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() ? skip.has(e.name) : false) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else max = Math.max(max, statSync(p).mtimeMs);
    }
  }
  return max;
}

// 一个可编译单元是否需要重建：源码树（排除产物目录）比 dist 新即过时。
// dist 不存在时视为过时（返回 true），由调用方触发构建补齐。
function isStale(srcDir, distDir) {
  const srcNewest = newestMtime(srcDir, new Set(['node_modules', 'dist']));
  const distNewest = newestMtime(distDir, new Set(['node_modules']));
  return srcNewest > distNewest;
}

// 相邻框架仓库是否有被消费的包需要重建。清单用 PACKAGE_MAP（与
// check-agentdev-local 的链接/安装校验同源）：Claw 运行时不消费的包
// （如 deprecated 的 audit-feature）不参与判定——它们的 dist 陈旧与否
// 与启动正确性无关，纳入只会带来与消费面无关的启动期全量构建。
function frameworkBuildPlan(frameworkRoot) {
  if (!existsSync(join(frameworkRoot, 'package.json'))) return [];
  const packages = new Map();
  const stale = new Set();
  for (const [name, dir] of Object.entries(PACKAGE_MAP)) {
    const packageDir = join(frameworkRoot, 'packages', dir);
    // 缺少包目录由 check-agentdev-local 报告，构建计划无法修复。
    if (!existsSync(packageDir)) continue;
    const manifestPath = join(packageDir, 'package.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(dep => dep.startsWith('@agentdevjs/'))
      .map(dep => dep.slice('@agentdevjs/'.length));
    packages.set(name, { deps });
    // probe 捕获入口或声明缺失；mtime 捕获源码更新。
    if (probe(packageDir, name).status !== 'ok' || isStale(packageDir, join(packageDir, 'dist'))) {
      stale.add(name);
    }
  }

  // 上游接口变化后，下游构建产物也要更新。只扩展到真正声明了依赖的包。
  const needed = new Set(stale);
  let changed;
  do {
    changed = false;
    for (const [name, { deps }] of packages) {
      if (!needed.has(name) && deps.some(dep => needed.has(dep))) {
        needed.add(name);
        changed = true;
      }
    }
  } while (changed);

  const ordered = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name) || !needed.has(name)) return;
    visited.add(name);
    for (const dep of packages.get(name)?.deps ?? []) visit(dep);
    ordered.push(`@agentdevjs/${name}`);
  }
  for (const name of packages.keys()) visit(name);
  return ordered;
}

function frameworkBuildNeeded(frameworkRoot) {
  return frameworkBuildPlan(frameworkRoot).length > 0;
}

function ensure(desc, check, buildScript, cwd = root) {
  if (!check()) return false;
  console.log(`[ensure-builds] ${desc} 缺失或过时，执行 ${buildScript} ...`);
  const r = runNpm(['run', buildScript], cwd);
  if (r.error || r.status !== 0) {
    if (buildScript === 'build' && cwd !== root) {
      console.error(`[ensure-builds] 框架构建失败，请进入 ${cwd} 排查（若刚 git pull，先 npm install 再 npm run build）。`);
    } else {
      console.error(`[ensure-builds] ${buildScript} 失败，请手动执行排查。`);
    }
    process.exit(r.status ?? 1);
  }
  return true;
}

function ensureFrameworkBuild() {
  // 框架 dist 必须先于 local-features：后者的类型检查解析框架 dist 的 d.ts，
  // 链接指向陈旧 dist 时会把过时类型编进 local-feature 产物。
  if (!isDevForm()) return false;
  const sibling = siblingAgentdevPath();
  if (!existsSync(join(sibling, 'package.json'))) return false;
  const plan = frameworkBuildPlan(sibling);
  if (!plan.length) return false;
  console.log(`[ensure-builds] AgentDev 需要构建：${plan.join(', ')}`);
  const args = ['run', 'build', ...plan.flatMap(name => ['-w', name])];
  const r = runNpm(args, sibling);
  if (r.error || r.status !== 0) {
    console.error(`[ensure-builds] 框架增量构建失败，请进入 ${sibling} 排查。`);
    process.exit(r.status ?? 1);
  }
  return true;
}

function ensureClawBuilds() {
  const builtLf = ensure(
    'local-features/dist',
    () => isStale(join(root, 'local-features'), join(root, 'local-features', 'dist')),
    'build:local-features'
  );
  const staleFeatures = FEATURE_DIRS.filter((n) =>
    isStale(join(root, 'features', n), join(root, 'features', n, 'dist'))
  );
  let builtFeat = false;
  if (staleFeatures.length) {
    console.log(`[ensure-builds] 需要构建的 feature：${staleFeatures.join(', ')}`);
    const r = runNpm(['run', 'build:features', '--', `--only=${staleFeatures.join(',')}`]);
    if (r.error || r.status !== 0) {
      console.error('[ensure-builds] build:features 失败，请手动执行排查。');
      process.exit(r.status ?? 1);
    }
    builtFeat = true;
  }
  return { builtLf, builtFeat };
}

function main() {
  const frameworkOnly = process.argv.includes('--framework-only');
  const clawOnly = process.argv.includes('--claw-only');
  if (frameworkOnly && clawOnly) {
    console.error('[ensure-builds] --framework-only 与 --claw-only 不能同时使用。');
    process.exit(1);
  }

  const builtFramework = clawOnly ? false : ensureFrameworkBuild();
  if (frameworkOnly) {
    if (!builtFramework) console.log('[ensure-builds] AgentDev 框架 dist 均为最新，跳过编译。');
    return;
  }

  const { builtLf, builtFeat } = ensureClawBuilds();
  if (!builtFramework && !builtLf && !builtFeat) console.log('[ensure-builds] 本地构建产物均为最新，跳过编译。');
}

// CLI 守卫：仅直接执行时运行主流程；被测试 / 其他脚本 import 时只暴露纯逻辑。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

export { newestMtime, isStale, frameworkBuildNeeded, frameworkBuildPlan };
