#!/usr/bin/env node
// 发布态切换：把 package.json 中的 `file:../AgentDev/packages/*` 本地依赖
// 改写为 npm registry semver 依赖（@agentdevjs/* 已发布 npm），随后自动执行
// npm install + npm run build，切换完成即处于可启动状态。
//
// 与 agentdev:local 的关系：
//   - 本脚本改写依赖声明（file: -> semver），是形态切换的正向通道；
//   - agentdev:local 不改声明，只做 node_modules 手工 junction，用于
//     发布态下临时调试本地源码（npm install 会将其冲回 registry 版）。
//
// 版本来源：优先读相邻 AgentDev 仓库各包的 version（即刚发布的内容）；
// 相邻仓库不在时用 --version 显式指定。声明一律写精确版本（exact pin，
// 不带 range 前缀）：框架锁步包永远同版本同批发布，消费端只取确定存在的
// 版本，杜绝 range 漂移解析出错位组合。
// features/ 下被预制 agent 源码引用的子包（见 prebuilt-feature-dirs.mjs）
// 对 @agentdevjs/core 的 devDependency 同步对齐到目标版本，避免框架发版后
// 子包构建类型停留在旧版。
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

// 目标版本：显式 --version 优先；否则读相邻仓库对应包的 version。
// 无法解析（目录缺失 / 无 version 字段）时返回 null，调用方保留原声明——
// 绝不写出一个未经确认的猜测版本。
function versionOf(name) {
  if (explicitVersion) return explicitVersion;
  const dir = PACKAGE_DIR_OVERRIDES[name] ?? name.slice('@agentdevjs/'.length);
  const localPkg = join(agentdevRoot, 'packages', dir, 'package.json');
  if (existsSync(localPkg)) {
    const v = JSON.parse(readFileSync(localPkg, 'utf8')).version;
    if (typeof v === 'string') return v;
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

// 全部 @agentdevjs/* 依赖：声明一律改写为相邻仓库对应包的精确版本。
// 包名去掉 scope 即 packages/ 目录名。框架锁步包四包同版本；生态包不参与
// 锁步、各自独立版本，逐包读取即可对齐——未重发的包写 exact 旧版本，
// 与 registry 一致，无副作用。exact 声明同时强制 lock 重解析：升级批次的
// 包（如 0.1.0 → 0.1.1）在 pull + npm install 后必然生效，不会停留在
// lock 钉住的旧版。
const AGENTDEV_DEPS = Object.keys(pkg.dependencies || {}).filter((name) => name.startsWith('@agentdevjs/'));

let changed = 0;
const skipped = [];
for (const name of AGENTDEV_DEPS) {
  const spec = pkg.dependencies[name];
  const version = versionOf(name);
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
  console.log(`[agentdev:published] 相邻仓库无法解析版本，保留原声明：${skipped.join(', ')}`);
}

// features/ 子包的 core devDep 对齐框架版本
const coreVersion = versionOf('@agentdevjs/core');
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

runNpm(['install', '--no-audit', '--no-fund']);
runNpm(['run', 'build']);
console.log('[agentdev:published] 完成：发布态就绪。');
