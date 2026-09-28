#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopDir = join(root, 'desktop');
const releaseDir = join(desktopDir, 'target', 'release');
const installerDir = join(releaseDir, 'bundle', 'nsis');
const nsisOutput = join(releaseDir, 'nsis', 'x64', 'nsis-output.exe');
const config = JSON.parse(readFileSync(join(desktopDir, 'tauri.conf.json'), 'utf8'));
const installerName = `${config.productName}_${config.version}_x64-setup.exe`;
const installerPath = join(installerDir, installerName);
const bundleOnly = process.argv.includes('--bundle-only');

function run(command, args, cwd, capture = false) {
  return new Promise((resolve, reject) => {
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
    child.on('close', code => resolve({ code: code ?? 1, output }));
  });
}

async function requireRun(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} 失败（退出码 ${result.code}）`);
}

function freshExecutable(path, startedAt) {
  try {
    const info = statSync(path);
    if (info.size < 1_000_000 || info.mtimeMs < startedAt - 2_000) return false;
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

async function recoverInstaller(startedAt, { source = nsisOutput, directory = installerDir, name = installerName } = {}) {
  if (!freshExecutable(source, startedAt)) return null;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const recoveredName = name.replace(/-setup\.exe$/, `-recovered-${stamp}-${process.pid}-setup.exe`);
  const destination = join(directory, recoveredName);
  const temporary = `${destination}.partial`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      copyFileSync(source, temporary, constants.COPYFILE_EXCL);
      if (statSync(temporary).size !== statSync(source).size) throw new Error('复制后文件大小不一致');
      renameSync(temporary, destination);
      return destination;
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* 文件可能被扫描器暂时占用 */ }
      if (attempt === 4) console.error(`已生成的 NSIS 安装器复制失败：${error.message}`);
      else await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('桌面安装包目前仅支持在 Windows x64 上构建。');
  }
  if (process.argv.slice(2).some(arg => arg !== '--bundle-only')) {
    throw new Error('仅支持可选参数 --bundle-only。');
  }

  if (bundleOnly) {
    if (!existsSync(join(releaseDir, 'agentdev-claw-desktop.exe')) || !existsSync(join(root, 'dist', 'desktop-staging'))) {
      throw new Error('缺少已编译的桌面 exe 或 staging，无法只重试安装包。请先完整构建一次。');
    }
    console.log('复用现有 staging 和桌面 exe，只重试 NSIS 安装包。');
  } else {
    // pack:desktop 导出工作区现状（含未提交改动）。编译与安装包生成分开，
    // NSIS 末尾遇到文件锁时可用 --bundle-only 恢复，无需重新组装和编译。
    await requireRun('cmd.exe', ['/d', '/s', '/c', 'npm run pack:desktop'], root);
    await requireRun('cargo', ['tauri', 'build', '--no-bundle'], desktopDir);
    console.log(`桌面 exe 已生成：${join(releaseDir, 'agentdev-claw-desktop.exe')}`);
  }

  const bundleStartedAt = Date.now();
  const result = await run('cargo', ['tauri', 'bundle', '--bundles', 'nsis'], desktopDir, true);
  if (result.code === 0 && freshExecutable(installerPath, bundleStartedAt)) {
    console.log(`安装包已生成：${installerPath}`);
    return;
  }

  // Tauri/NSIS 先生成 nsis-output.exe，最后才改名覆盖固定名称的安装包。
  // 若覆盖时遇到 Windows 文件锁，把已完成的安装包另存为唯一文件名。
  if (result.code !== 0 && /os error 32|另一个程序正在使用此文件|being used by another process/i.test(result.output)) {
    const recovered = await recoverInstaller(bundleStartedAt);
    if (recovered) {
      console.warn(`固定名称的安装包可能被占用，已保留旧文件并另存本次安装包：${recovered}`);
      return;
    }
  }

  console.error('安装包生成失败；已保留 staging 和桌面 exe。重试命令：构建桌面安装包.cmd --bundle-only');
  throw new Error(result.code === 0 ? 'Tauri 命令完成，但未找到本次生成的 NSIS 安装包。' : `Tauri bundle 失败（退出码 ${result.code}）。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { freshExecutable, recoverInstaller };
