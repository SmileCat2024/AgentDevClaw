#!/usr/bin/env node
/**
 * Claw 聚合构建：一次 build 完成当前依赖形态下所需的全部本地构建。
 *
 * 依赖形态判定（package.json 中 @agentdev/core 的值）：
 *   - 开发态（file:../AgentDev/packages/*）：node_modules 是 junction，
 *     链接可能被 npm install 冲掉，框架 dist 需现场构建。
 *     必做：check:agentdev（校验/修复 18 条链接）+ 相邻框架仓库构建
 *           + build:local-features + build:features
 *   - 发布态（semver，如 ^0.1.0）：node_modules 是 npm 安装的正式包，
 *     自带 dist，不存在链接与本地框架源码。
 *     只做：build:local-features + build:features
 *
 * 之后 `npm start` 就是纯净启动（prestart 只做轻量校验）。
 */
import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';

// 依赖形态：开发态(file:)为 true，发布态(semver)为 false
let IS_DEV = true;
try {
  execSync('node scripts/is-dev-mode.mjs', { cwd: root, stdio: 'ignore' });
} catch {
  IS_DEV = false;
}

function runNpm(args, cwd = root, label) {
  console.log(`\n=== ${label} ===\n> npm ${args.join(' ')}`);
  const res = IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`[build] 失败（${label}）`);
    process.exit(res.status ?? 1);
  }
}

try {
  if (IS_DEV) {
    // 开发态：node_modules 是 junction，需校验/修复链接 + 构建框架
    execSync('node scripts/check-agentdev-local.mjs', { cwd: root, stdio: 'inherit' });

    const sibling = resolve(process.env.AGENTDEV_LOCAL_PATH || join(root, '..', 'AgentDev'));
    if (existsSync(join(sibling, 'package.json'))) {
      console.log(`\n[build] 开发态：检测到相邻 AgentDev 框架仓库 ${sibling}，构建框架`);
      runNpm(['run', 'build'], sibling, '框架仓库构建');
    } else {
      console.warn(`[build] 开发态：未检测到相邻 AgentDev 框架仓库（${sibling}）`);
      console.warn('[build] check:agentdev 已给出修复指引；框架 dist 缺失时请先构建。');
    }
  } else {
    // 发布态：npm 正式包自带 dist，无需链接/框架构建
    console.log('[build] 发布态：@agentdev/* 为 npm 正式包，跳过链接修复与框架构建');
  }

  // 两种形态都必须构建的 Claw 本地部分
  runNpm(['run', 'build:local-features'], root, 'local-features 构建');
  runNpm(['run', 'build:features'], root, 'features 构建');

  console.log('\n[build] 全部构建完成。可以直接 npm start。');
} catch (err) {
  console.error(`\n[build] 构建失败：${err.message}`);
  process.exit(1);
}