#!/usr/bin/env node
// 发布产物打包：把相邻 AgentDev 仓库的生态 feature 包构建 + npm pack，
// 产出的 tgz 统一写入 resources/features/，供 Feature Repository UI 与
// 独立消费方安装。开发模式不依赖本脚本——开发态经 package.json 的
// file:../AgentDev/packages/* junction 直接消费源码包。
//
// 用法：
//   npm run pack:features                 # 打包全部生态包
//   npm run pack:features shell-feature   # 只打包指定包（可多个，空格分隔）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'fs';
import { resolve, join, basename, dirname } from 'path';
import { spawnSync } from 'child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const frameworkRoot = resolve(process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
const outDir = join(projectRoot, 'resources', 'features');

// Claw 依赖的生态包清单（目录名）。与 package.json 的 file:../AgentDev/packages/*
// 声明一一对应；rokid-bot 包的目录名是 rokid-feature（包名 @agentdev/rokid-bot）。
const ECO_PACKAGES = [
  'audio-feedback-feature',
  'audit-feature',
  'feishu-bot',
  'image-reader-feature',
  'memory-feature',
  'plugin-compat-feature',
  'qqbot-feature',
  'rokid-feature',
  'shell-feature',
  'tts-feature',
  'visual-feature',
  'websearch-feature',
  'wecom-bot',
  'weixin-bot',
];

const only = process.argv.slice(2);
if (only.length > 0) {
  const unknown = only.filter((name) => !ECO_PACKAGES.includes(name));
  if (unknown.length > 0) {
    console.error(`[pack:features] 未知包名: ${unknown.join(', ')}`);
    console.error(`[pack:features] 可选: ${ECO_PACKAGES.join(', ')}`);
    process.exit(1);
  }
}

if (!existsSync(join(frameworkRoot, 'package.json'))) {
  console.error(`[pack:features] 未找到框架仓库: ${frameworkRoot}`);
  console.error('[pack:features] 可通过 AGENTDEV_LOCAL_PATH 指定框架仓库路径');
  process.exit(1);
}
if (!existsSync(outDir)) {
  console.error(`[pack:features] 输出目录不存在: ${outDir}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  // Windows 上 npm 是 npm.cmd 批处理，必须经 shell 调用；
  // 此时传 args 数组会触发 Node DEP0190，因此统一拼成命令字符串（参数均为常量，无注入面）。
  const isWin = process.platform === 'win32';
  const r = isWin
    ? spawnSync(`${cmd} ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`[pack:features] 命令失败: ${cmd} ${args.join(' ')}（cwd=${cwd}）${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(r.status ?? 1);
  }
}

let packed = 0;
const skipped = [];
for (const name of ECO_PACKAGES) {
  if (only.length > 0 && !only.includes(name)) continue;
  const pkgDir = join(frameworkRoot, 'packages', name);
  if (!existsSync(join(pkgDir, 'package.json'))) {
    skipped.push(name);
    continue;
  }

  // 构建（无 build 脚本的包跳过）
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.scripts?.build) {
    run('npm', ['run', 'build'], pkgDir);
  }

  // pack 到临时目录再搬运，避免包目录里残留 tgz
  const tmpOut = join(pkgDir, '.pack-tmp');
  rmSync(tmpOut, { recursive: true, force: true });
  mkdirSync(tmpOut, { recursive: true });
  try {
    run('npm', ['pack', '--pack-destination', tmpOut], pkgDir);
    const [file] = readdirSync(tmpOut);
    const src = join(tmpOut, file);
    const dest = join(outDir, basename(file));
    rmSync(dest, { force: true });
    try {
      renameSync(src, dest);
    } catch {
      // rename 跨盘会失败（EXDEV），回退为复制
      copyFileSync(src, dest);
      rmSync(src, { force: true });
    }
    packed += 1;
    console.log(`[pack:features] ${pkg.name}@${pkg.version} -> resources/features/${basename(file)}`);
  } finally {
    rmSync(tmpOut, { recursive: true, force: true });
  }
}

if (skipped.length > 0 && only.length === 0) {
  console.warn(`[pack:features] 跳过（框架仓库中不存在）: ${skipped.join(', ')}`);
}
console.log(`[pack:features] 完成：${packed} 个包已更新到 resources/features/`);
