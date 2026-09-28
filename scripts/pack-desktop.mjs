#!/usr/bin/env node
// 桌面打包 staging 组装：产出可独立运行的发布树（dist/desktop-staging），
// 作为 tauri bundler 的输入。消解组装链两大缺口（docs/plans/
// 2026-09-26-desktop-packaging-prerequisites.md）：
//   D1（开发态 lock 污染）：staging 不携带开发 package-lock，现场干净解析；
//   D2（依赖未发布框架 API）：@agentdevjs/* 一律 vendor 化——相邻 AgentDev
//     仓库构建后各包 npm pack 出 tgz，staging 以 file:vendor/*.tgz 实体安装
//     （npm 对 tgz 无 junction 语义，与 registry 实体等价）。
//
// 组装步骤：框架构建 → 工作区现状导出 → 18 包 tgz + 声明改写
// （根 dependencies 与 features/* 子包的 core devDep）→ 干净 install →
// 构建 local-features / features → 无损瘦身（剥离构建期依赖）→ 拷贝
// node.exe → 隔离端口冒烟（health ready → POST shutdown → 进程退出）。
//
// staging 必须位于本仓库内部深层目录：features 构建的 linkLocalCore 与
// check-agentdev-local 都按 <root>/../AgentDev 探测相邻框架仓库，staging
// 在 dist/ 下时该探测必然落空，vendor 副本不被本地 junction 劫持。
//
// 用法：
//   npm run pack:desktop                            # 完整组装（含框架仓库构建）
//   npm run pack:desktop -- --skip-framework-build  # 复用相邻仓库现有 dist
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';
import { killProcessTree } from '../server/shared/process-tree.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const frameworkRoot = resolve(process.env.AGENTDEV_LOCAL_PATH || join(root, '..', 'AgentDev'));
const stagingDir = join(root, 'dist', 'desktop-staging');
const cacheDir = join(root, 'dist', 'pack-cache');
const IS_WIN = process.platform === 'win32';
const SKIP_FRAMEWORK_BUILD = process.argv.includes('--skip-framework-build');

// 运行时 pinned：产物可复现（不随打包机现场版本漂移）。升级时改这里，
// 并同步验证 node 与 npm 的引擎兼容（npm 11.x 要求 node ^20.17 || >=22.9）。
const PINNED_NODE_VERSION = '24.19.0';
const PINNED_NPM_VERSION = '11.17.0';

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

// 工作区现状导出（替代 git archive）：清单 = 已跟踪文件（以工作区内容为准，
// 已删除的跳过）+ 未被 .gitignore 排除的未跟踪文件。node_modules / 开发
// lock / dist 等 ignore 内容天然不进包（staging 自身在 dist/ 下，无自拷风险）。
function exportWorkingTree(destDir) {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(`[pack:desktop] git ls-files 失败: ${res.stderr}`);
    process.exit(1);
  }
  const files = res.stdout.toString('utf8').split('\0').filter(Boolean);
  let copied = 0;
  for (const rel of files) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied += 1;
  }
  if (copied === 0) {
    console.error('[pack:desktop] 工作区导出结果为空，疑似不在仓库根执行');
    process.exit(1);
  }
  log(`源码树导出: ${copied} 个文件（工作区现状，含未提交改动）`);
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

  // 2. staging：导出工作区现状（未提交改动与未跟踪新文件直接进包，不与 git 较劲）
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  log(`staging: ${stagingDir}`);
  exportWorkingTree(stagingDir);

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
  // vendor digest 清单：provisioner 的 dependency hash 以此为框架来源输入，
  // 同版本 tgz 重打包（字节变化）时环境缓存正确失效
  const manifest = {};
  for (const [name, info] of versions) {
    const digest = createHash('sha256').update(readFileSync(join(vendorDir, info.tgz))).digest('hex');
    manifest[name] = { version: info.version, tgz: `vendor/${info.tgz}`, sha256: digest };
  }
  writeFileSync(join(vendorDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`vendor/manifest.json 已生成（${versions.size} 包 digest 清单）`);

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
  assertVendorEntities(stagingDir, agentdevDeps, versions);

  // 8. Claw 本地构建（local-features + features）
  runShell('npm run build:local-features', stagingDir, 'local-features 构建');
  runShell('npm run build:features', stagingDir, 'features 构建');

  // 9. 无损瘦身：剥离纯构建期依赖（dist 已产出，发布树只读永不重建）。
  //    冒烟在 pruned 树上执行，剥离破坏运行时会被当场抓获。
  for (const name of FEATURE_DIRS) {
    rmSync(join(stagingDir, 'features', name, 'node_modules'), { recursive: true, force: true });
  }
  log('已删除 features/*/node_modules（构建期依赖，~200MB）');
  // typescript 声明在 dependencies 但只服务于本地构建：从声明移除后经
  // npm prune 一并清出（extraneous），devDependencies 同批清除。
  const builtPkgPath = join(stagingDir, 'package.json');
  const builtPkg = JSON.parse(readFileSync(builtPkgPath, 'utf8'));
  if (builtPkg.dependencies?.typescript) {
    delete builtPkg.dependencies.typescript;
    writeFileSync(builtPkgPath, JSON.stringify(builtPkg, null, 2) + '\n');
  }
  runShell('npm prune --omit=dev --no-audit --no-fund', stagingDir, 'prune 构建期依赖');
  assertVendorEntities(stagingDir, agentdevDeps, versions);

  // 10. 运行时 pinned 分发（node + npm，下载缓存在 dist/pack-cache，首次联网后离线可重跑）。
  //     npm 落 runtime/npm/（registry tgz 原生结构，bin/npm-cli.js 为入口），
  //     provisioner 以 process.execPath + npm-cli.js 调用，用户机器无需系统 npm。
  const runtimeDir = join(stagingDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const nodeBin = await provisionPinnedNode(runtimeDir);
  await provisionPinnedNpm(runtimeDir);

  // 11. 隔离端口冒烟：bundled node 直启 supervisor → health ready → shutdown → 退出
  await smoke(stagingDir, nodeBin);

  log('staging 组装完成');
}

// vendor 实体自检：@agentdevjs/* 必须是实体目录（非 junction）且版本与 tgz 一致
function assertVendorEntities(stagingDir, agentdevDeps, versions) {
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
}

// pinned 运行时下载（缓存在 dist/pack-cache；首次联网，之后离线可重跑）
async function downloadToFile(url, dest, label) {
  if (existsSync(dest)) {
    log(`缓存命中: ${label}`);
    return;
  }
  log(`下载 ${label}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} 下载失败: HTTP ${res.status} ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function provisionPinnedNode(runtimeDir) {
  if (!IS_WIN) {
    console.error('[pack:desktop] 当前仅支持 Windows 打包目标（node dist 单 exe）；其他平台需扩展下载源');
    process.exit(1);
  }
  const cached = join(cacheDir, `node-v${PINNED_NODE_VERSION}-win-x64.exe`);
  await downloadToFile(
    `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/win-x64/node.exe`,
    cached,
    `node v${PINNED_NODE_VERSION}`,
  );
  const nodeBin = join(runtimeDir, 'node.exe');
  copyFileSync(cached, nodeBin);
  log(`node runtime: v${PINNED_NODE_VERSION} (pinned) -> runtime/node.exe`);
  return nodeBin;
}

// 用 Node 内置 zlib 解 tgz（不用 tar CLI：MSYS tar 把 D:\ 的冒号当远程主机，
// Windows bsdtar 又不支持 --force-local，跨 shell 环境不可靠）。npm 官方 tgz
// 只含文件与目录（无 symlink/hardlink），遇到其他条目类型直接报错。
import { createGunzip } from 'zlib';

async function gunzipFileToBuffer(file) {
  const { createReadStream } = await import('fs');
  return await new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(file)
      .pipe(createGunzip())
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

function untarBufferToDir(buffer, destDir, { strip = 0 } = {}) {
  let offset = 0;
  let longName = null;
  let written = 0;
  const destAbs = resolve(destDir);
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    let name = longName ?? header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    longName = null;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/[\0 ]/g, '');
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { // GNU 长名：内容是下一个条目的真实名字
      longName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (!name || name === '.' || name === './') continue;
    if (strip > 0) name = name.split('/').slice(strip).join('/');
    if (!name) continue;
    const target = resolve(destDir, name);
    if (target !== destAbs && !target.startsWith(destAbs + '\\') && !target.startsWith(destAbs + '/')) {
      throw new Error(`tar 条目越界: ${name}`);
    }
    if (type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer.subarray(dataStart, dataStart + size));
      written++;
      continue;
    }
    throw new Error(`npm tgz 含不支持的条目类型 "${type}"（${name}）；需扩展解包器`);
  }
  if (written === 0) throw new Error('tar 解包结果为空');
  return written;
}

async function provisionPinnedNpm(runtimeDir) {
  const cached = join(cacheDir, `npm-${PINNED_NPM_VERSION}.tgz`);
  await downloadToFile(
    `https://registry.npmjs.org/npm/-/npm-${PINNED_NPM_VERSION}.tgz`,
    cached,
    `npm ${PINNED_NPM_VERSION}`,
  );
  const npmDir = join(runtimeDir, 'npm');
  rmSync(npmDir, { recursive: true, force: true });
  mkdirSync(npmDir, { recursive: true });
  const files = untarBufferToDir(await gunzipFileToBuffer(cached), npmDir, { strip: 1 });
  if (!existsSync(join(npmDir, 'bin', 'npm-cli.js'))) {
    throw new Error('npm tgz 结构异常：解包后缺少 bin/npm-cli.js（tgz 内应为 package/ 前缀）');
  }
  log(`npm runtime: ${PINNED_NPM_VERSION} (pinned) -> runtime/npm/（${files} 个文件）`);
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function smoke(staging, nodeBin) {
  const port = await findFreePort();
  const viewerPort = await findFreePort();
  log(`冒烟启动（隔离端口 ${port}/${viewerPort}）`);
  const smokeData = join(staging, '.smoke-data');
  rmSync(smokeData, { recursive: true, force: true });
  const child = spawn(nodeBin, ['scripts/run-supervised.js'], {
    cwd: staging,
    env: {
      ...process.env,
      PORT: String(port),
      AGENTDEV_VIEWER_PORT: String(viewerPort),
      AGENTDEV_UDS_PATH: `\\\\.\\pipe\\agentdev-viewer-smoke-${process.pid}`,
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
        const res = await fetch(`http://127.0.0.1:${port}/protoclaw/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) { ready = true; break; }
      } catch { /* 启动期未就绪，继续等 */ }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`health 未就绪\n--- supervisor 输出（尾 2000 字）---\n${out.slice(-2000)}`);
    log('health ready');

    await fetch(`http://127.0.0.1:${port}/protoclaw/shutdown`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}` },
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
