#!/usr/bin/env node
// 桌面打包 staging 组装：产出可独立运行的发布树（dist/desktop-staging），
// 作为 tauri bundler 的输入。消解组装链两大缺口（docs/plans/
// 2026-09-26-desktop-packaging-prerequisites.md）：
//   D1（开发态 lock 污染）：staging 不携带开发 package-lock，现场干净解析；
//   D2（依赖未发布框架 API）：@agentdevjs/* 一律 vendor 化——相邻 AgentDev
//     仓库构建后各包 npm pack 出 tgz，staging 以 file:vendor/*.tgz 实体安装
//     （npm 对 tgz 无 junction 语义，与 registry 实体等价）。
//
// 组装步骤：框架构建 → git archive 干净源码树 → 18 包 tgz + 声明改写
// （根 dependencies 与 features/* 子包的 core devDep）→ 干净 install →
// 构建 local-features / features → 拷贝 node.exe → 隔离端口冒烟
// （health ready → POST shutdown → 进程退出）。
//
// staging 必须位于本仓库内部深层目录：features 构建的 linkLocalCore 与
// check-agentdev-local 都按 <root>/../AgentDev 探测相邻框架仓库，staging
// 在 dist/ 下时该探测必然落空，vendor 副本不被本地 junction 劫持。
//
// 用法：
//   npm run pack:desktop                            # 完整组装（含框架仓库构建）
//   npm run pack:desktop -- --skip-framework-build  # 复用相邻仓库现有 dist
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';
import { killProcessTree } from '../server/shared/process-tree.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const frameworkRoot = resolve(process.env.AGENTDEV_LOCAL_PATH || join(root, '..', 'AgentDev'));
const stagingDir = join(root, 'dist', 'desktop-staging');
const IS_WIN = process.platform === 'win32';
const SKIP_FRAMEWORK_BUILD = process.argv.includes('--skip-framework-build');

// 包名 ≠ 目录名的特例（与 use-agentdev-published.mjs 保持一致）
const PACKAGE_DIR_OVERRIDES = { '@agentdevjs/rokid-bot': 'rokid-feature' };

function log(msg) { console.log(`[pack:desktop] ${msg}`); }

function runShell(command, cwd, label) {
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (r.error || r.status !== 0) {
    console.error(`[pack:desktop] ${label}失败: ${command}${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(r.status ?? 1);
  }
}

function tgzFileName(name, version) {
  return `agentdevjs-${name.slice('@agentdevjs/'.length)}-${version}.tgz`;
}

async function main() {
  if (!existsSync(join(frameworkRoot, 'package.json'))) {
    console.error(`[pack:desktop] 未找到框架仓库: ${frameworkRoot}（可用 AGENTDEV_LOCAL_PATH 指定）`);
    process.exit(1);
  }

  // 1. 框架仓库构建（产出全部包 dist；--skip-framework-build 复用现有 dist）
  if (!SKIP_FRAMEWORK_BUILD) {
    log(`构建框架仓库 ${frameworkRoot}`);
    runShell('npm run build', frameworkRoot, '框架仓库构建');
  } else {
    log('跳过框架仓库构建（--skip-framework-build）');
  }

  // 2. 干净 staging：git archive 只带已提交内容（开发 lock 与未提交改动天然排除）
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  log(`staging: ${stagingDir}`);
  runShell(`git archive HEAD | tar -x -C dist/desktop-staging`, root, '源码树导出');

  // 3. 依赖清单（来自 staging 的根声明，与开发树同源）
  const stagingPkgPath = join(stagingDir, 'package.json');
  const stagingPkg = JSON.parse(readFileSync(stagingPkgPath, 'utf8'));
  const agentdevDeps = Object.keys(stagingPkg.dependencies || {}).filter((n) => n.startsWith('@agentdevjs/'));
  if (agentdevDeps.length === 0) {
    console.error('[pack:desktop] 根声明中没有 @agentdevjs/* 依赖，疑似组装源异常');
    process.exit(1);
  }

  // 4. 各包 npm pack 进 staging/vendor，同时收集实际版本
  const vendorDir = join(stagingDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  const versions = new Map();
  for (const name of agentdevDeps) {
    const dir = join(frameworkRoot, 'packages', PACKAGE_DIR_OVERRIDES[name] ?? name.slice('@agentdevjs/'.length));
    if (!existsSync(join(dir, 'package.json'))) {
      console.error(`[pack:desktop] 框架仓库缺少包目录: ${dir}`);
      process.exit(1);
    }
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    runShell(`npm pack --pack-destination "${vendorDir}"`, dir, `打包 ${name}`);
    const expected = tgzFileName(name, version);
    if (!existsSync(join(vendorDir, expected))) {
      console.error(`[pack:desktop] vendor 缺少 ${expected}（实际: ${readdirSync(vendorDir).join(', ')}）`);
      process.exit(1);
    }
    versions.set(name, { version, tgz: expected });
    log(`${name}@${version} -> vendor/${expected}`);
  }

  // 5. 根声明改写为 vendor tgz + 移除开发 lock
  for (const name of agentdevDeps) {
    stagingPkg.dependencies[name] = `file:vendor/${versions.get(name).tgz}`;
  }
  writeFileSync(stagingPkgPath, JSON.stringify(stagingPkg, null, 2) + '\n');
  rmSync(join(stagingDir, 'package-lock.json'), { force: true });

  // 6. features/* 子包的 core devDep 同步指向 vendor tgz：子包独立 npm install，
  //    semver 声明会从 registry 解析回已发布旧版（D2 在子包层复现），
  //    file: 指向 vendor tgz 保证与根同一份 core。
  const coreTgz = versions.get('@agentdevjs/core').tgz;
  for (const name of FEATURE_DIRS) {
    const subPkgPath = join(stagingDir, 'features', name, 'package.json');
    if (!existsSync(subPkgPath)) continue;
    const subPkg = JSON.parse(readFileSync(subPkgPath, 'utf8'));
    if (subPkg.devDependencies?.['@agentdevjs/core']) {
      subPkg.devDependencies['@agentdevjs/core'] = `file:../../vendor/${coreTgz}`;
      writeFileSync(subPkgPath, JSON.stringify(subPkg, null, 2) + '\n');
      log(`features/${name}: @agentdevjs/core -> vendor/${coreTgz}`);
    }
  }

  // 7. 干净安装 + 实体自检（无 junction、版本与 tgz 一致）
  runShell('npm install --no-audit --no-fund', stagingDir, 'staging 安装');
  const scopeDir = join(stagingDir, 'node_modules', '@agentdevjs');
  const problems = [];
  for (const name of agentdevDeps) {
    const p = join(scopeDir, name.slice('@agentdevjs/'.length));
    try {
      if (statSync(p).isSymbolicLink()) { problems.push(`${name} 是链接（应为实体）`); continue; }
      const installed = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version;
      if (installed !== versions.get(name).version) {
        problems.push(`${name} 安装版本 ${installed} != vendor ${versions.get(name).version}`);
      }
    } catch (e) {
      problems.push(`${name} 未安装（${e.message}）`);
    }
  }
  if (problems.length) {
    console.error('[pack:desktop] 实体自检未通过:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  log(`实体自检通过（${agentdevDeps.length} 包均为 vendor 实体）`);

  // 8. Claw 本地构建（local-features + features）
  runShell('npm run build:local-features', stagingDir, 'local-features 构建');
  runShell('npm run build:features', stagingDir, 'features 构建');

  // 9. Node 运行时随包分发（打包机当前 node；正式发布应改 pinned 下载）
  const runtimeDir = join(stagingDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const nodeBin = join(runtimeDir, IS_WIN ? 'node.exe' : 'node');
  copyFileSync(process.execPath, nodeBin);
  log(`node runtime: ${process.version} -> runtime/`);

  // 10. 隔离端口冒烟：bundled node 直启 supervisor → health ready → shutdown → 退出
  await smoke(stagingDir, nodeBin);

  log('staging 组装完成');
}

async function smoke(staging, nodeBin) {
  log('冒烟启动（隔离端口 1421/2027）');
  const smokeData = join(staging, '.smoke-data');
  rmSync(smokeData, { recursive: true, force: true });
  const child = spawn(nodeBin, ['scripts/run-supervised.js'], {
    cwd: staging,
    env: {
      ...process.env,
      PORT: '1421',
      AGENTDEV_VIEWER_PORT: '2027',
      AGENTDEV_UDS_PATH: '\\\\.\\pipe\\agentdev-viewer-smoke',
      AGENTDEV_DATA_DIR: smokeData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  try {
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('http://127.0.0.1:1421/protoclaw/health', { signal: AbortSignal.timeout(1500) });
        if (res.ok) { ready = true; break; }
      } catch { /* 启动期未就绪，继续等 */ }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`health 未就绪\n--- supervisor 输出（尾 2000 字）---\n${out.slice(-2000)}`);
    log('health ready');

    await fetch('http://127.0.0.1:1421/protoclaw/shutdown', {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    if (code === null) throw new Error(`冒烟进程未在 15s 内退出\n--- supervisor 输出（尾 2000 字）---\n${out.slice(-2000)}`);
    if (code !== 0) throw new Error(`冒烟进程退出码 ${code}\n--- supervisor 输出（尾 2000 字）---\n${out.slice(-2000)}`);
    log(`冒烟通过（退出码 ${code}）`);
  } finally {
    // 失败兜底：不留残留进程
    if (child.exitCode === null) {
      await killProcessTree(child.pid);
      await exited;
    }
    rmSync(smokeData, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`[pack:desktop] ${err.message}`); process.exit(1); });
