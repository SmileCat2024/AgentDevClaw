#!/usr/bin/env node
// 构建 features/ 下被预制 agent 按源码路径引用的 feature 包。
// 这些包的 dist 不入库（gitignore），也不在 local-features/tsconfig.json 覆盖范围内，
// 必须在 prestart 现场构建；新增此类 feature 时把目录名登记进 prebuilt-feature-dirs.mjs。
//
// 依赖形态：子包对 @agentdevjs/core 的声明固定为 semver（形态无关）。
// 构建时按"相邻框架仓库可用性"自动分流（与声明形态无关，覆盖 file: 开发态
// 与 agentdev:local 调试态）：相邻 core 已检出且已构建（dist 存在）时，把
// install 得到的 registry 副本替换为指向它的 junction（与 agentdev:local 同一
// 模式），使构建解析到本地最新类型——使用未发布框架 API 的 feature 因此可以
// 直接运行。无可用的相邻仓库时保持 registry 版本；此时依赖未发布 API 的
// feature 构建失败属预期（等待框架发版）。
// 版本守卫：根声明为发布态时，仅当相邻 core 版本高于声明版本（本地是下一版
// 预览）才链接；本地仓库落后或持平于 registry 时保持 registry 版，避免陈旧
// 本地副本劫持 feature 的 core 解析、与根安装的 registry 版分裂成两份副本。
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';

const root = resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';

// Windows 上 npm 是 npm.cmd 批处理，必须经 shell 调用；
// 此时传 args 数组会触发 Node DEP0190，因此统一拼成命令字符串（参数均为常量，无注入面）。
function runNpm(args, cwd) {
  return IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
}

function runStep(name, dir, label, args) {
  console.log(`[build:features] features/${name}: ${label}`);
  const r = runNpm(args, dir);
  if (r.error || r.status !== 0) {
    console.error(`[build:features] features/${name} ${label} 失败${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(r.status ?? 1);
  }
}

// 相邻框架 core 的可用性分流（与声明形态无关，覆盖 file: 开发态与 agentdev:local 调试态）：
//   已检出且已构建（dist/index.d.ts 存在）-> 把子包 install 得到的 registry 版 core
//     替换为指向它的 junction（与 agentdev:local 同一模式），构建解析到本地最新类型，
//     使用未发布框架 API 的 feature 因此可以直接运行；
//   已检出但未构建 -> 先在框架仓库自动编译 core（仅 core，够子包类型解析即可）；
//   未检出（纯发布环境）-> 保持 registry 版本，依赖未发布 API 的 feature 构建失败属预期。
const LOCAL_CORE_DIR = join(root, '..', 'AgentDev', 'packages', 'core');

// 语义化版本解析，无法解析时返回 null
function semverOf(text) {
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

// 本地 core 是否应替换 registry 副本：根开发态（file:）一律链接（feature 跟随
// 本地框架）；发布态下仅当本地版本高于声明版本时链接（预览未发布 API）。
function shouldLinkLocalCore(featureDir) {
  const subPkg = JSON.parse(readFileSync(join(featureDir, 'package.json'), 'utf8'));
  const spec = subPkg.devDependencies?.['@agentdevjs/core'] ?? subPkg.dependencies?.['@agentdevjs/core'];
  if (typeof spec === 'string' && spec.startsWith('file:')) return { link: true };
  if (typeof spec !== 'string') return { link: true }; // 缺声明时保持旧行为
  let local = null;
  let declared;
  try {
    local = semverOf(JSON.parse(readFileSync(join(LOCAL_CORE_DIR, 'package.json'), 'utf8')).version);
  } catch { /* 相邻包异常，走保持 registry 分支 */ }
  declared = semverOf(spec);
  if (!local || !declared) return { link: true };
  return { link: local > declared, localVersion: local.join('.'), declaredVersion: declared.join('.') };
}

function linkLocalCore(name, featureDir) {
  const dest = join(featureDir, 'node_modules', '@agentdevjs', 'core');
  if (!existsSync(LOCAL_CORE_DIR)) {
    console.log(`[build:features] features/${name}: 未检出相邻框架仓库，@agentdevjs/core 使用 registry 版`);
    return;
  }
  const guard = shouldLinkLocalCore(featureDir);
  if (!guard.link) {
    console.log(`[build:features] features/${name}: 相邻框架 core（${guard.localVersion}）不高于声明的 registry 版本（${guard.declaredVersion}），保持 registry 版`);
    // npm install 不会主动冲掉已存在的 junction，需显式移除并重装回 registry 副本
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
      rmSync(dest, { recursive: true, force: true });
      runStep(name, featureDir, '恢复 registry 版 core', ['install', '--no-audit', '--no-fund']);
    }
    return;
  }
  if (!existsSync(join(LOCAL_CORE_DIR, 'dist', 'index.d.ts'))) {
    console.log(`[build:features] features/${name}: 相邻框架 core 未构建，自动编译 AgentDev @agentdevjs/core ...`);
    runStep(name, LOCAL_CORE_DIR, '构建框架 core', ['run', 'build', '-w', '@agentdevjs/core']);
  }
  try {
    if (existsSync(dest) && realpathSync(dest) === realpathSync(LOCAL_CORE_DIR)) return; // 已是本地链接
  } catch { /* dest 异常，重建 */ }
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(LOCAL_CORE_DIR, dest, IS_WIN ? 'junction' : 'dir');
  console.log(`[build:features] features/${name}: @agentdevjs/core -> 本地框架仓库`);
}

for (const name of FEATURE_DIRS) {
  const dir = join(root, 'features', name);
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`[build:features] 未找到 features/${name}/package.json`);
    process.exit(1);
  }
  runStep(name, dir, 'npm install', ['install', '--no-audit', '--no-fund']);
  linkLocalCore(name, dir);
  runStep(name, dir, 'npm run build', ['run', 'build']);
}
console.log('[build:features] 完成');
