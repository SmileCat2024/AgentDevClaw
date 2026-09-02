#!/usr/bin/env node
// 发布态切换：把 package.json 中的 `file:../AgentDev/packages/*` 本地依赖
// 改写为 npm registry semver 依赖（@agentdevjs/* 已发布 npm），随后自动执行
// npm install + npm run build，切换完成即处于可启动状态。
//
// 与 agentdev:local 的关系：
//   - 本脚本改写依赖声明（file: -> semver），是形态切换的正向通道；
//   - agentdev:local 不改声明，只做 node_modules 手工 junction，用于发布态下
//     临时调试本地源码。注意：npm install 不会冲掉"恰好满足声明"的链接
//     （链接目标 package.json 的版本匹配 exact pin 即视为已安装），残留链接
//     必须经本脚本清理——切换前会先摘除 @agentdevjs/* 下的全部链接再安装。
//
// 版本来源：优先取 npm registry 各包的最新发布版（dist-tags.latest）；取不到
// （离线 / 包未发布）时回退读相邻 AgentDev 仓库各包的 version 并明示日志；
// --version 显式指定优先于一切。声明一律写精确版本（exact pin，不带 range
// 前缀）：框架锁步包永远同版本同批发布，消费端只取确定存在的版本，杜绝
// range 漂移解析出错位组合。
// features/ 下被预制 agent 源码引用的子包（见 prebuilt-feature-dirs.mjs）
// 对 @agentdevjs/core 的 devDependency 同步对齐到目标版本，避免框架发版后
// 子包构建类型停留在旧版。
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const pkgPath = join(projectRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const agentdevRoot = resolve(projectRoot, '..', 'AgentDev');
const flagIdx = process.argv.indexOf('--version');
const explicitVersion = flagIdx >= 0 ? process.argv[flagIdx + 1] : null;

// 包名 ≠ 目录名的特例（npm 包名与 packages/ 目录不一致）
const PACKAGE_DIR_OVERRIDES = { '@agentdevjs/rokid-bot': 'rokid-feature' };

// 相邻仓库对应包的 version（回退来源）
function localVersionOf(name) {
  const dir = PACKAGE_DIR_OVERRIDES[name] ?? name.slice('@agentdevjs/'.length);
  const localPkg = join(agentdevRoot, 'packages', dir, 'package.json');
  if (existsSync(localPkg)) {
    const v = JSON.parse(readFileSync(localPkg, 'utf8')).version;
    if (typeof v === 'string') return v;
  }
  return null;
}

// registry 最新发布版（npm view <name> version）。网络失败 / 包不存在返回 null。
function registryVersionOf(name) {
  const r = IS_WIN
    ? spawnSync(`npm view ${name} version`, { cwd: projectRoot, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['view', name, 'version'], { cwd: projectRoot, encoding: 'utf8' });
  const v = String(r.stdout ?? '').trim();
  return r.status === 0 && /^[\w.+-]+$/.test(v) ? v : null;
}

// 目标版本：显式 --version 优先；否则 registry 最新发布版；取不到时回退相邻
// 仓库 version 并明示日志。全部无法解析时返回 null，调用方保留原声明——
// 绝不写出一个未经确认的猜测版本。
function resolveVersion(name) {
  if (explicitVersion) return explicitVersion;
  const fromRegistry = registryVersionOf(name);
  if (fromRegistry) return fromRegistry;
  const fromLocal = localVersionOf(name);
  if (fromLocal) {
    console.log(`[agentdev:published] ${name}: registry 版本不可得（离线或未发布），回退相邻仓库版本 ${fromLocal}`);
    return fromLocal;
  }
  return null;
}

const IS_WIN = process.platform === 'win32';
function runNpm(args, cwd = projectRoot) {
  console.log(`[agentdev:published] > npm ${args.join(' ')}`);
  const r = IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`[agentdev:published] npm ${args.join(' ')} 失败，请手动执行排查。`);
    process.exit(r.status ?? 1);
  }
}

// 全部 @agentdevjs/* 依赖：声明一律改写为解析到的目标版本（registry 最新，
// 回退相邻仓库）。框架锁步包四包同版本；生态包不参与锁步、各自独立版本，
// 逐包解析即可对齐。exact 声明同时强制 lock 重解析：升级批次的包
// （如 0.1.0 → 0.1.1）在 pull + npm install 后必然生效，不会停留在
// lock 钉住的旧版。
const AGENTDEV_DEPS = Object.keys(pkg.dependencies || {}).filter((name) => name.startsWith('@agentdevjs/'));

let changed = 0;
const skipped = [];
for (const name of AGENTDEV_DEPS) {
  const spec = pkg.dependencies[name];
  const version = resolveVersion(name);
  if (version === null) {
    skipped.push(`${name}=${spec ?? '(缺声明)'}`);
    continue;
  }
  if (spec === version) continue;
  console.log(`[agentdev:published] ${name}: ${spec} -> ${version}`);
  pkg.dependencies[name] = version;
  changed += 1;
}
if (changed > 0) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
else console.log('[agentdev:published] 根声明已是发布态（semver）。');
if (skipped.length) {
  console.log(`[agentdev:published] 无法解析目标版本，保留原声明：${skipped.join(', ')}`);
}

// features/ 子包的 core devDep 对齐框架版本
const coreVersion = resolveVersion('@agentdevjs/core');
for (const name of FEATURE_DIRS) {
  const subPkgPath = join(projectRoot, 'features', name, 'package.json');
  if (!existsSync(subPkgPath)) continue;
  const subPkg = JSON.parse(readFileSync(subPkgPath, 'utf8'));
  const spec = subPkg.devDependencies?.['@agentdevjs/core'];
  if (coreVersion === null) {
    console.log(`[agentdev:published] features/${name}: 无法解析 core 目标版本，保留 ${spec ?? '(缺声明)'}`);
    continue;
  }
  if (typeof spec === 'string' && spec !== coreVersion) {
    console.log(`[agentdev:published] features/${name}: @agentdevjs/core ${spec} -> ${coreVersion}`);
    subPkg.devDependencies['@agentdevjs/core'] = coreVersion;
    writeFileSync(subPkgPath, JSON.stringify(subPkg, null, 2) + '\n');
  }
}

// 发布态自检：四个框架包必须是同一精确版本（exact pin），否则切换不算完成
const FRAMEWORK_PKGS = ['@agentdevjs/core', '@agentdevjs/llm', '@agentdevjs/viewer', '@agentdevjs/mcp'];
const declared = FRAMEWORK_PKGS.map((name) => pkg.dependencies?.[name]);
if (declared.some((spec) => typeof spec !== 'string') || new Set(declared).size !== 1) {
  console.error(
    `[agentdev:published] 框架包声明不是统一精确版本：` +
      FRAMEWORK_PKGS.map((name, i) => `${name}=${declared[i] ?? '(缺声明)'}`).join(', ')
  );
  process.exit(1);
}
console.log(`[agentdev:published] 框架包声明自检通过：${declared[0]}`);

// 切换前清理：npm install 不会替换"恰好满足声明"的链接（链接目标版本匹配
// exact pin 即视为已安装），发布态安装前必须显式摘除 @agentdevjs/* 下的
// 全部本地链接，否则旧链接会穿透安装继续存活。只摘链接本身，不动相邻仓库。
const scopeDir = join(projectRoot, 'node_modules', '@agentdevjs');
for (const name of AGENTDEV_DEPS) {
  const p = join(scopeDir, name.slice('@agentdevjs/'.length));
  let st;
  try {
    st = lstatSync(p);
  } catch {
    continue;
  }
  if (st.isSymbolicLink()) {
    rmSync(p, { recursive: true, force: true });
    console.log(`[agentdev:published] 已摘除本地链接 node_modules/${name}`);
  }
}

runNpm(['install', '--no-audit', '--no-fund']);

// 安装后自检：每个 @agentdevjs/* 依赖必须是 registry 实体目录，且安装版本与
// 声明一致。任一不满足即切换失败，如实报错并给出手动修复路径。
const installProblems = [];
for (const name of AGENTDEV_DEPS) {
  const p = join(scopeDir, name.slice('@agentdevjs/'.length));
  const declaredSpec = pkg.dependencies[name];
  let installed;
  try {
    const isLink = lstatSync(p).isSymbolicLink();
    if (isLink) {
      installProblems.push(`${name} 仍是本地链接（应为 registry 实体目录）`);
      continue;
    }
    installed = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version;
  } catch (e) {
    installProblems.push(`${name} 未安装或缺少 package.json（${e.message}）`);
    continue;
  }
  if (declaredSpec !== installed) {
    installProblems.push(`${name} 声明 ${declaredSpec} 与安装版本 ${installed} 不一致`);
  }
}
if (installProblems.length) {
  console.error('[agentdev:published] 安装自检未通过：\n  ' + installProblems.join('\n  '));
  console.error('[agentdev:published] 请手动执行 rm -rf node_modules && npm install 后重试排查。');
  process.exit(1);
}
console.log(`[agentdev:published] 安装自检通过（${AGENTDEV_DEPS.length} 包均为 registry 版且与声明一致）`);

runNpm(['run', 'build']);
console.log('[agentdev:published] 完成：发布态就绪。');
