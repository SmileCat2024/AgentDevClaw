#!/usr/bin/env node
// AgentDevClaw 桌面安装包构建：自研 SFX 安装器（取代 Tauri NSIS 模板）。
//
// 产物布局（desktop-installer/src/payload.rs 的读取契约）：
//   [cargo 编译的安装器 exe] [payload.zip] [u64 LE zip 长度] [8B 魔数 ACLAWSET]
//
// payload.zip 内部结构（Rust 解压直接落 <安装目录>）：
//   agentdev-claw-desktop.exe          ← desktop/target/release 主壳 exe
//   app/...                            ← dist/desktop-staging 全树
//   （对齐 NSIS 时代布局：主 exe 在根、resources 映射 app/，升级无缝）
//
// 流程：
//   1. 版本同步（根 package.json → desktop 与 desktop-installer 的声明文件）
//   2. pack:desktop 组装 staging
//   3. cargo tauri build --no-bundle 编主壳 exe
//   4. cargo build --release 编安装器（增量缓存，安装器代码不变则秒过）
//   5. 组 payload-root（app/ = staging + 主 exe）→ bsdtar 打 zip
//   6. 拼接 exe + zip + 长度 + 魔数 → bundle/setup/AgentDevClaw_<ver>_x64-setup.exe
//   7. --selfcheck 自检（安装器读自身尾部校验 zip 完整性）
//
// --payload-only：跳过 2-4，复用现有 staging 与编译产物只重拼（文件锁
// 重试场景，对应旧 --bundle-only 语义）。

import { spawn } from 'node:child_process';
import {
  closeSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopDir = join(root, 'desktop');
const installerCrate = join(root, 'desktop-installer');
const stagingDir = join(root, 'dist', 'desktop-staging');
const payloadRoot = join(root, 'dist', 'desktop-payload');
const desktopRelease = join(desktopDir, 'target', 'release');
const installerExe = join(installerCrate, 'target', 'release', 'agentdev-claw-setup.exe');
const outputDir = join(desktopRelease, 'bundle', 'setup');
const zipPath = join(root, 'dist', 'payload.zip');
const SFX_MAGIC = Buffer.from('ACLAWSET', 'ascii');

const payloadOnly = process.argv.includes('--payload-only');

let installerName = '';
let installerPath = '';

function run(command, args, cwd, capture = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (capture) {
      for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream.on('data', chunk => {
          destination.write(chunk);
          output = (output + chunk.toString()).slice(-16_384);
        });
      }
    }
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code: code ?? 1, output }));
  });
}

async function requireRun(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} 失败（退出码 ${result.code}）`);
}

function isExecutable(path) {
  try {
    const info = statSync(path);
    if (info.size < 1_000_000) return false;
    const fd = openSync(path, 'r');
    try {
      const signature = Buffer.alloc(2);
      return readSync(fd, signature, 0, 2, 0) === 2 && signature.toString() === 'MZ';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// 版本唯一来源是根 package.json：构建前同步进四处声明（desktop 与
// desktop-installer 的 tauri.conf.json / Cargo.toml），发版只改一处。
// desktop-installer 的 CARGO_PKG_VERSION 是安装器 UI 展示的目标版本，
// 必须与产品版本一致。
function syncVersions() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  const syncJson = dir => {
    const configPath = join(dir, 'tauri.conf.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.version !== version) {
      console.log(`${configPath} 版本已同步：${config.version} -> ${version}`);
      config.version = version;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    }
  };
  const syncCargo = dir => {
    const cargoPath = join(dir, 'Cargo.toml');
    const cargo = readFileSync(cargoPath, 'utf8');
    // 只替换 [package] 的首行 version 声明；依赖行是内联表，不会被 ^version 命中
    const current = cargo.match(/^version = ".*"$/m)?.[0];
    if (current !== `version = "${version}"`) {
      if (!current) throw new Error(`${cargoPath} 中未找到 package version，无法同步版本`);
      writeFileSync(cargoPath, cargo.replace(/^version = ".*"$/m, `version = "${version}"`));
      console.log(`${cargoPath} 版本已同步：${current} -> ${version}`);
    }
  };

  syncJson(desktopDir);
  syncCargo(desktopDir);
  syncJson(installerCrate);
  syncCargo(installerCrate);
  return version;
}

// payload-root：app/ = staging 全树 + 主 exe 在根。直接复制（staging 是
// 抛弃型中间产物，复制几百 MB 在本地 SSD 上数秒；不用 junction——bsdtar
// 对目录联接的打包行为不保证展开为普通目录条目）。
function buildPayloadRoot() {
  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(join(payloadRoot, 'app'), { recursive: true });
  cpSync(stagingDir, join(payloadRoot, 'app'), { recursive: true });
  copyFileSync(
    join(desktopRelease, 'agentdev-claw-desktop.exe'),
    join(payloadRoot, 'agentdev-claw-desktop.exe'),
  );
}

// bsdtar（Windows 10 1803+ 自带）按 -f 扩展名打 zip。比 PowerShell
// Compress-Archive 快一个数量级（node_modules 数万小文件场景）。
// 必须显式用 System32 的 bsdtar：PATH 里若有 msys GNU tar（git bash 环境
// spawn 解析到它），会把 "D:\..." 的 -f 归档当成远程主机语法
// （"Cannot connect to D"），且 GNU tar 根本不支持创建 zip。
const BSDTAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
async function packPayloadZip() {
  if (!existsSync(BSDTAR)) throw new Error(`未找到系统 bsdtar：${BSDTAR}（要求 Windows 10 1803+）`);
  rmSync(zipPath, { force: true });
  await requireRun(BSDTAR, ['-a', '-cf', zipPath, '-C', payloadRoot, '.'], root);
  return statSync(zipPath).size;
}

// 拼接 SFX 到目标路径。目标被占用（Windows 文件锁）时另存唯一名并返回
// 实际路径（对齐旧 NSIS 恢复语义：保留旧文件、不丢新产物）。
function assembleSfx(destination, { exe = installerExe, zip = zipPath } = {}) {
  const temporary = `${destination}.partial`;
  rmSync(temporary, { force: true });
  const zipBytes = statSync(zip).size;
  const fd = openSync(temporary, 'w');
  try {
    for (const source of [exe, zip]) {
      const buf = readFileSync(source);
      writeSync(fd, buf, 0, buf.length);
    }
    const tail = Buffer.alloc(16);
    tail.writeBigUInt64LE(BigInt(zipBytes), 0);
    SFX_MAGIC.copy(tail, 8);
    writeSync(fd, tail, 0, 16);
  } finally {
    closeSync(fd);
  }
  try {
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
    return destination;
  } catch {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const recovered = destination.replace(/-setup\.exe$/, `-recovered-${stamp}-${process.pid}-setup.exe`);
    renameSync(temporary, recovered);
    console.warn(`固定名称的安装包被占用，本次安装包另存为：${recovered}`);
    return recovered;
  }
}

// 自检（node 侧等价校验，与安装器 --selfcheck 同布局同语义）：release 安装器
// manifest 为 requireAdministrator（desktop-installer/build.rs），非提升的构建
// 进程直接 spawn 安装器会 EACCES。自检要证明的是"拼接产物尾部携带完整可解析
// 的 zip"：先按 SFX 布局（exe + zip + u64LE 长度 + ACLAWSET）校验尾部自洽，
// 再用系统 bsdtar 解析（zip 规范允许前置数据，self-extracting 形态原生支持），
// 与安装器 Rust 侧 ZipArchive::new 成功打开的语义等价，且无需提权。
async function selfcheck(exePath) {
  const st = statSync(exePath);
  const tail = Buffer.alloc(16);
  const fd = openSync(exePath, 'r');
  try {
    if (readSync(fd, tail, 0, 16, st.size - 16) !== 16) throw new Error('安装包尾部不完整（小于 16 字节布局）。');
  } finally {
    closeSync(fd);
  }
  const magic = tail.toString('ascii', 8, 16);
  if (magic !== SFX_MAGIC.toString('ascii')) {
    throw new Error(`自检失败：尾部魔数不符（期望 ${SFX_MAGIC.toString('ascii')}，实得 ${magic}）。`);
  }
  const zipBytes = Number(tail.readBigUInt64LE(0));
  if (zipBytes <= 0 || st.size - 16 - zipBytes <= 0) {
    throw new Error(`自检失败：payload 长度字段非法（${zipBytes} 字节）。`);
  }
  // 静默收集列表输出（仅判断可解析，列表有数万行不透传刷屏）
  const list = await new Promise((resolvePromise, reject) => {
    const child = spawn(BSDTAR, ['-tf', exePath], { cwd: outputDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let tailOutput = '';
    child.stdout.on('data', chunk => { tailOutput = (tailOutput + chunk.toString()).slice(-1024); });
    child.stderr.on('data', chunk => { tailOutput = (tailOutput + chunk.toString()).slice(-1024); });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code: code ?? 1, tailOutput }));
  });
  if (list.code !== 0 || !list.tailOutput.trim()) {
    throw new Error(`安装包自检失败：zip 解析未通过（退出码 ${list.code}）${list.tailOutput ? `：${list.tailOutput.trim()}` : ''}`);
  }
  console.log(`自检通过：payloadBytes=${zipBytes}，zip 完整可解析（bsdtar 列表 OK）。`);
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('桌面安装包目前仅支持在 Windows x64 上构建。');
  }
  if (process.argv.slice(2).some(arg => arg !== '--payload-only')) {
    throw new Error('仅支持可选参数 --payload-only。');
  }

  const version = syncVersions();
  installerName = `AgentDevClaw_${version}_x64-setup.exe`;
  installerPath = join(outputDir, installerName);
  mkdirSync(outputDir, { recursive: true });

  if (payloadOnly) {
    if (!existsSync(installerExe) || !existsSync(join(desktopRelease, 'agentdev-claw-desktop.exe')) || !existsSync(zipPath)) {
      throw new Error('缺少已编译的安装器/桌面 exe 或 payload.zip，无法只重拼安装包。请先完整构建一次。');
    }
    console.log('复用现有编译产物与 payload.zip，只重拼安装包。');
  } else {
    // pack:desktop 导出工作区现状（含未提交改动）。编译与拼装分开，
    // 拼装阶段遇到文件锁时可用 --payload-only 恢复，无需重新组装和编译。
    await requireRun('cmd.exe', ['/d', '/s', '/c', 'npm run pack:desktop'], root);
    await requireRun('cargo', ['tauri', 'build', '--no-bundle'], desktopDir);
    console.log(`桌面 exe 已生成：${join(desktopRelease, 'agentdev-claw-desktop.exe')}`);
    await requireRun('cargo', ['build', '--release'], installerCrate);
    console.log(`安装器已生成：${installerExe}`);
    buildPayloadRoot();
    const zipSize = await packPayloadZip();
    console.log(`payload.zip 已生成：${zipPath}（${(zipSize / 1024 / 1024).toFixed(1)} MB）`);
  }

  if (!isExecutable(installerExe)) {
    throw new Error('未找到有效的安装器 exe（desktop-installer/target/release/agentdev-claw-setup.exe）。');
  }

  const finalPath = assembleSfx(installerPath);
  if (!isExecutable(finalPath)) {
    throw new Error('安装包拼接失败：产物缺失或不是有效 exe。');
  }
  console.log(`安装包已生成：${finalPath}（${(statSync(finalPath).size / 1024 / 1024).toFixed(1)} MB）`);

  await selfcheck(finalPath);

  // payload-root 是抛弃型中间产物；payload.zip 保留供 --payload-only 快速重拼
  rmSync(payloadRoot, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { isExecutable, assembleSfx };
