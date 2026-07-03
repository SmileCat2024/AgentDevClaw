/**
 * advclaw update — GitHub Release 自动更新模块
 *
 * 数据源：GitHub Releases API（公开仓库，匿名可读，60 次/小时限频）
 * 更新策略：git fetch --tags → git checkout <release-tag> → npm install → build local-features
 * 配置持久化：<projectRoot>/.advclaw-config.json（已加入 .gitignore）
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── 常量 ────────────────────────────────────────────────────────

const GITHUB_OWNER = 'SmileCat2024';
const GITHUB_REPO = 'AgentDevClaw';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const CONFIG_FILE = '.advclaw-config.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const DEFAULT_CONFIG = { autoUpdateCheck: true };

// ── 配置读写 ────────────────────────────────────────────────────

export function loadConfig() {
  const p = join(PROJECT_ROOT, CONFIG_FILE);
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  writeFileSync(join(PROJECT_ROOT, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
}

// ── 版本比较 ────────────────────────────────────────────────────

function parseSemver(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
}

function isNewer(remoteTag, localVersion) {
  const r = parseSemver(remoteTag);
  const l = parseSemver(localVersion);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

// ── 获取本地版本 ────────────────────────────────────────────────

function getLocalVersion() {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// ── 查询 GitHub 最新 Release ────────────────────────────────────

async function fetchLatestRelease() {
  const resp = await fetch(RELEASES_API, {
    headers: {
      'User-Agent': 'advclaw',
      'Accept': 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (resp.status === 404) return null; // 没有 release
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
  return resp.json();
}

// ── 检查更新（不执行更新）────────────────────────────────────

/**
 * @returns {{ hasUpdate: boolean, latestTag: string, latestVersion: string, localVersion: string, releaseNotes: string|null } | null}
 *   null 表示检查失败（网络错误等）
 */
export async function checkForUpdate() {
  const localVersion = getLocalVersion();
  let release;
  try {
    release = await fetchLatestRelease();
  } catch {
    return null;
  }
  if (!release) {
    return { hasUpdate: false, latestTag: null, latestVersion: null, localVersion, releaseNotes: null };
  }
  const latestTag = release.tag_name;
  const hasUpdate = isNewer(latestTag, localVersion);
  return {
    hasUpdate,
    latestTag,
    latestVersion: latestTag.replace(/^v/, ''),
    localVersion,
    releaseNotes: hasUpdate ? (release.body || null) : null,
    htmlUrl: release.html_url || null,
  };
}

// ── 执行更新 ────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: opts.silent ? 'pipe' : 'inherit',
      shell: process.platform === 'win32',
      ...opts,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`));
    });
    child.on('error', reject);
  });
}

async function performUpdate(latestTag) {
  // 1. fetch tags
  console.log(`  → git fetch origin --tags`);
  await run('git', ['fetch', 'origin', '--tags', '-f']);

  // 2. checkout release tag
  console.log(`  → git checkout ${latestTag}`);
  await run('git', ['checkout', latestTag]);

  // 3. install dependencies
  console.log(`  → npm install`);
  await run('npm', ['install']);

  // 4. build local features
  console.log(`  → npm run build:local-features`);
  await run('npm', ['run', 'build:local-features']);
}

// ── 命令入口 ────────────────────────────────────────────────────

export async function cmdUpdate(args) {
  const checkOnly = args.includes('--check') || args.includes('-c');

  console.log('advclaw update — 正在检查最新版本...');
  const info = await checkForUpdate();

  if (info === null) {
    console.error('  ✗ 无法连接 GitHub，请检查网络后重试');
    process.exit(1);
  }

  console.log(`  当前版本: v${info.localVersion}`);

  if (!info.latestTag) {
    console.log('  GitHub 上暂无 Release');
    return;
  }

  console.log(`  最新版本: v${info.latestVersion}`);

  if (!info.hasUpdate) {
    console.log('  ✓ 已是最新版本');
    return;
  }

  if (checkOnly) {
    console.log(`\n  发现新版本 v${info.latestVersion}！运行 advclaw update 执行更新。`);
    if (info.htmlUrl) console.log(`  Release 详情: ${info.htmlUrl}`);
    return;
  }

  console.log(`\n  开始更新到 v${info.latestVersion}...`);

  // 检查本地是否有未提交的修改
  try {
    const status = execSync('git status --porcelain', { cwd: PROJECT_ROOT, encoding: 'utf8' });
    if (status.trim()) {
      console.error('  ✗ 检测到本地有未提交的修改，请先 stash 或 commit 后再更新：');
      console.error(status.trim());
      process.exit(1);
    }
  } catch {
    // git 不可用时继续（降级为仅提示）
  }

  try {
    await performUpdate(info.latestTag);
    console.log(`\n  ✓ 更新完成！当前版本: v${info.latestVersion}`);
  } catch (err) {
    console.error(`\n  ✗ 更新失败: ${err.message}`);
    console.error('  你可以手动执行: git fetch --tags && git checkout ' + info.latestTag);
    process.exit(1);
  }
}

// ── 后台检测（启动时调用，非阻塞）────────────────────────────

export async function backgroundCheck() {
  const config = loadConfig();
  if (!config.autoUpdateCheck) return;
  if (process.env.ADVCLAW_NO_UPDATE_CHECK === '1') return;

  const info = await checkForUpdate();
  if (info && info.hasUpdate) {
    const lineWidth = 52;
    const line = '─'.repeat(lineWidth);
    console.log('');
    console.log('\x1b[36m' + line + '\x1b[0m');
    console.log(`\x1b[1m\x1b[36m  ↻ 发现新版本 v${info.latestVersion}\x1b[0m` +
                `  (当前 v${info.localVersion})`);
    console.log(`\x1b[90m  运行 \x1b[33madvclaw update\x1b[90m 进行更新\x1b[0m`);
    if (info.htmlUrl) console.log(`\x1b[90m  ${info.htmlUrl}\x1b[0m`);
    console.log('\x1b[36m' + line + '\x1b[0m');
    console.log('');
  }
}
