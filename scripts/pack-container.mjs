#!/usr/bin/env node
// [pack:container] 按 agent 构建 runtime 镜像（ADR-0037 M5 修订：依赖最小化）。
//
// 一 agent 一镜像：镜像内容 = 该 agent 的运行闭包——run-prebuilt-agent.js 宿主
// 闭包 + 该 agent 的 agent.js 闭包（含其引用的 local-features / features 子包）
// + bare import 依赖的递归闭包（按 package.json 声明展开）。不再产出"全 agent
// 全依赖"的全局镜像：容器里跑谁，就只带谁需要的依赖。
//
// 依赖来源 = 本地树（构建零 npm install / registry 耦合）：
//   - @agentdevjs/* 开发态是 Windows junction：经相邻框架仓库 npm pack 实体化
//     （本地操作，无网络）；发布态 / 桌面安装树已是实体，直接复制（npm 仲裁
//     出的包内嵌套 node_modules 原样保留）。
//   - 开发态特有的版本分叉（框架包声明 ^4 而根占位 6.x）按 npm 语义把框架
//     实测版本嵌套复制进包私有 node_modules。
//   - 平台绑定依赖（native 二进制）：闭包内检出后，宿主侧补容器架构的 Linux
//     子包（npm pack，需网络或本地缓存）——纯 JS 闭包整个流程零联网。
//
// 镜像 tag：主 tag agentdev-claw-runtime:<agentId>（容器后端按 agent 选用，
// CLAW_RUNTIME_CONTAINER_IMAGE 保留为显式整体覆盖）；副 tag
// <agentId>-<版本>-<git短hash>[-dirty] 与 OCI revision label 供产品层做运行
// 时版本核对——版本对齐归产品层职责，不经构建耦合。
//
// 用法：
//   npm run pack:container                                  # 全部 prebuilt agent
//   npm run pack:container -- --agent=programming-helper    # 指定（可重复）
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { spawnSync } from 'child_process';
import { isBuiltin } from 'module';
import { fileURLToPath } from 'url';
import { PACKAGE_DIR_OVERRIDES, tgzFileName, gunzipFileToBuffer, untarBufferToDir } from './pack-tgz-lib.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const frameworkRoot = resolve(process.env.AGENTDEV_LOCAL_PATH || join(root, '..', 'AgentDev'));
// base 镜像版本与 scripts/pack-desktop.mjs 的 PINNED_NODE_VERSION 同轨，
// 升级时两处（外加 container/base.Dockerfile）同步。
const BASE_TAG = 'agentdev-claw-base:24.19.0';
const RUNTIME_REPO = 'agentdev-claw-runtime';
const HOST_ENTRY = join(root, 'scripts', 'run-prebuilt-agent.js');
// 共享 tgz 缓存：npm pack 产物同一次构建跨 agent 复用（每个包只 pack 一次）
const tgzCache = join(tmpdir(), `pack-container-tgz-${process.pid}`);

function log(msg) { console.log(`[pack:container] ${msg}`); }

function fail(msg) {
  console.error(`[pack:container] ${msg}`);
  process.exit(1);
}

function runShell(command, cwd, label) {
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (r.error || r.status !== 0) {
    fail(`${label}失败: ${command}${r.error ? `: ${r.error.message}` : ''}`);
  }
}

function runCapture(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}

function ensureDocker() {
  const version = runCapture('docker', ['version', '--format', '{{.Server.Version}}']);
  if (version === null) {
    fail('Docker 守护进程不可用（docker version 失败）。请启动 Docker Desktop 后重试。');
  }
  const arch = runCapture('docker', ['version', '--format', '{{.Server.Arch}}']);
  // npm 平台子包命名（x64/arm64）与 Go 架构名（amd64/arm64）的映射。
  const npmArch = { amd64: 'x64', arm64: 'arm64', x86_64: 'x64' }[arch];
  if (!npmArch) fail(`未支持的容器架构: ${arch}（当前支持 amd64/x64、arm64）`);
  log(`Docker 守护进程就绪（server ${version}，容器架构 ${arch}）`);
  return npmArch;
}

function ensureBase() {
  const existing = runCapture('docker', ['image', 'inspect', BASE_TAG, '--format', '{{.Id}}']);
  if (existing !== null) {
    log(`base 镜像就绪: ${BASE_TAG}（${existing.slice(0, 19)}）`);
    return;
  }
  log('base 镜像缺失，开始预烘焙（需网络：拉 node:24.19.0-slim + Debian 源；仅此一次，此后纯 JS 构建不再联网）。离线环境可在他机构建后 docker save / docker load 导入。');
  runShell(`docker build -f container/base.Dockerfile -t ${BASE_TAG} container/`, root, 'base 镜像构建');
}

function resolveAgentdevjsDeps() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const names = Object.keys(pkg.dependencies || {}).filter((n) => n.startsWith('@agentdevjs/'));
  if (names.length === 0) fail('根声明中没有 @agentdevjs/* 依赖，疑似源码树异常');
  return { names, version: pkg.version };
}

// 安装形态探测：开发态（@agentdevjs junction）/ 实体（发布态 registry 实体、
// 桌面安装树 vendor 实体）。构建器只依赖"一棵能跑的树"，形态差异全部在此适配。
function detectInstallForm(names) {
  const firstPkgDir = join(root, 'node_modules', '@agentdevjs', names[0].slice('@agentdevjs/'.length));
  return existsSync(firstPkgDir) && lstatSync(firstPkgDir).isSymbolicLink() ? 'dev' : 'entity';
}

// 本地 dist 策略（形态感知）：
//   开发态——总是重建（tsc / 子包构建均增量，保证镜像内 dist 与当前源码一致）；
//   实体形态（发布 / 桌面树）——跳过重建：dist 是安装产物本身即权威。
function ensureLocalDist(form) {
  if (form === 'entity') {
    if (!existsSync(join(root, 'local-features', 'dist', 'index.js'))) {
      fail('实体形态但 local-features/dist 缺失——安装树不完整。');
    }
    log('实体形态：dist 为安装产物，跳过重建');
    return;
  }
  runShell('npm run build:local-features', root, 'local-features 构建');
  runShell('npm run build:features', root, 'features 构建');
}

// ============= import 闭包（相对文件 + bare 依赖说明符） =============

function resolveLocalSpec(fromFile, spec) {
  const base = dirname(fromFile);
  for (const cand of [spec, spec + '.js', spec + '/index.js', spec + '.mjs']) {
    const t = resolve(base, cand);
    if (existsSync(t) && !t.includes('\\node_modules\\') && !t.includes('/node_modules/')) return t;
  }
  return null;
}

const SPEC_PATTERNS = [
  String.raw`from\s+['"]([^'"]+)['"]`,
  String.raw`import\(\s*['"]([^'"]+)['"]\s*\)`,
  String.raw`import\s+['"]([^'"]+)['"]`,
  String.raw`require\(\s*['"]([^'"]+)['"]\s*\)`,
];

function packageNameOf(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

// 收集入口的相对 import 闭包（静态 / 动态 / require 字面量）+ 全部 bare 依赖
// 说明符。正则按文件重建：带 g 标志的正则对象有 lastIndex 状态，跨文件复用
// 会污染扫描位置（实测坑，见旧全局构建）。行注释先剥离，降低误报面。
function collectClosure(entries) {
  const seen = new Set();
  const files = [];
  const bare = new Set();
  function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    const src = readFileSync(file, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const ps of SPEC_PATTERNS) {
      const re = new RegExp(ps, 'g');
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          const t = resolveLocalSpec(file, spec);
          if (t) walk(t);
        } else if (!spec.startsWith('/') && !isBuiltin(spec)) {
          bare.add(packageNameOf(spec));
        }
      }
    }
  }
  entries.forEach(walk);
  return { files, bare };
}

// prebuilt-agents/<tier>/<name>/agent.js 两层布局
function discoverAgents() {
  const found = [];
  const paRoot = join(root, 'prebuilt-agents');
  for (const tier of readdirSync(paRoot, { withFileTypes: true })) {
    if (!tier.isDirectory()) continue;
    for (const name of readdirSync(join(paRoot, tier.name), { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      if (existsSync(join(paRoot, tier.name, name.name, 'agent.js'))) {
        found.push({ id: name.name, tier: tier.name, dir: join(paRoot, tier.name, name.name) });
      }
    }
  }
  return found;
}

function selectAgents(discovered) {
  const wanted = process.argv
    .filter((a) => a.startsWith('--agent='))
    .map((a) => a.slice('--agent='.length).trim())
    .filter(Boolean);
  if (wanted.length === 0) return discovered;
  const known = new Set(discovered.map((a) => a.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) fail(`未知 agent: ${unknown.join(', ')}（可用: ${[...known].join(', ')}）`);
  return discovered.filter((a) => wanted.includes(a.id));
}

// ============= bare 依赖闭包展开（package.json 声明驱动） =============

function readPkgSafe(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 依赖定位：优先 Claw 本地树，开发态缺的在框架仓库（框架包的传递依赖不在
// Claw 根声明里，运行时靠 junction realpath 穿到框架仓库解析，镜像内此路不存在）。
function findInstalledDir(dep) {
  for (const base of [join(root, 'node_modules'), join(frameworkRoot, 'node_modules')]) {
    const p = join(base, dep);
    if (existsSync(join(p, 'package.json'))) return p;
  }
  return null;
}

function extractMajor(rangeOrVersion) {
  const m = /^[^0-9]*?(\d+)(?:[.\s]|$)/.exec(String(rangeOrVersion || '').trim());
  return m ? Number(m[1]) : null;
}

// 从 bare 说明符集合递归展开依赖闭包。
//   deps      —— 有序唯一包名集合（镜像 node_modules 的内容清单）
//   triples   —— (dep, from, range) 全集，native 检测复用
//   conflicts —— 开发态分叉：@agentdevjs 包声明的依赖 major 与根安装 major 不
//                一致（根的 openai@6 会劫持框架 llm 声明的 ^4，实测容器内 SDK
//                6.x 对新事件 assertNever、模型调用全灭）；仲裁 = 框架实测版本
//                嵌套复制进包私有 node_modules，与 npm 冲突解析行为一致。实体
//                形态不仲裁——npm 安装树已带正确嵌套，原样复制即可。
function expandDepGraph(bareNames, form) {
  const triples = [];
  const seenPairs = new Set();
  const seenDeps = new Set();
  const dropped = new Set();
  const conflicts = [];
  const nestedDeps = new Set();
  const push = (dep, from, range) => {
    const key = `${dep}<-${from}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    triples.push({ dep, from, range });
  };
  for (const n of bareNames) push(n, '<entry>', null);
  for (let i = 0; i < triples.length; i++) {
    // 索引遍历而非队列快照：push 进 triples 的新依赖必须被后续迭代展开，
    // 否则递归在第二层腰斩（实测坑：feishu-bot → node-sdk → axios 断链）。
    const { dep, from, range } = triples[i];
    if (seenDeps.has(dep)) continue;
    seenDeps.add(dep);
    // 开发态分叉检测（仅非 @agentdevjs 依赖；框架包互相间版本一致）。
    // 必须先于目录解析：分叉包的依赖清单要以框架实测版本的 package.json
    // 为准展开——若先按根解析读到旧 major（如根 openai@6），其 deps 里没有
    // 框架版本实际需要的传递依赖（v4 的 node-fetch），镜像内运行期 import
    // 才断裂（实测坑：llm → 嵌套 openai@4 → node-fetch 缺失）。
    if (form === 'dev' && from.startsWith('@agentdevjs/') && range && !dep.startsWith('@agentdevjs/')) {
      const rootDir = findInstalledDir(dep);
      const rootPkg = rootDir ? readPkgSafe(rootDir) : null;
      const rangeMajor = extractMajor(range);
      const rootMajor = rootPkg ? extractMajor(rootPkg.version) : null;
      if (rangeMajor != null && rootMajor != null && rangeMajor !== rootMajor) {
        conflicts.push({ owner: from, dep, range, rootMajor });
        nestedDeps.add(dep);
      }
    }
    const dir = nestedDeps.has(dep)
      ? join(frameworkRoot, 'node_modules', dep)
      : findInstalledDir(dep);
    if (!dir) { dropped.add(dep); continue; }
    const pkg = readPkgSafe(dir);
    if (!pkg) { dropped.add(dep); continue; }
    // 平台绑定的 optional 子包（os/cpu，如 @img/sharp-win32-x64）：不复制
    // Windows 实体（Linux 版经 NATIVE 补齐），声明继续向下递归。
    if (pkg.os || pkg.cpu) continue;
    for (const [d, r] of Object.entries(pkg.dependencies || {})) push(d, dep, r);
    for (const d of Object.keys(pkg.peerDependencies || {})) push(d, dep, null);
    for (const d of Object.keys(pkg.optionalDependencies || {})) push(d, dep, null);
  }
  // 声明了但本机未安装的依赖（典型：optional 平台变体 darwin/arm64 等、
  // 未启用的 optional peer 如 bufferutil）跳过复制——平台绑定的 Linux 版经
  // native 子包通道补齐，其余真实缺失由镜像自检（import 链真实加载）暴露，
  // 不在构建期猜测。triples 仍保留这些条目供 native 检测使用。
  if (dropped.size > 0) {
    log(`声明但本机未安装（跳过复制，共 ${dropped.size} 个）: ${[...dropped].slice(0, 12).join(', ')}${dropped.size > 12 ? ' …' : ''}`);
  }
  const deps = [...seenDeps].filter((d) => !dropped.has(d));
  return { deps, triples, conflicts, nested: nestedDeps };
}

// 平台绑定依赖检测：安装实体带 os/cpu 字段或含 *.node 二进制 → 其宿主包需
// 容器内可用的 Linux 版（Windows 装的平台二进制在 Linux 不可用；wasm 类资产
// 跨平台，不触发）。返回宿主包 pkg@version 清单。
function detectNativeDeps(graph) {
  const native = new Map();
  for (const { dep, from } of graph.triples) {
    const dir = graph.nested.has(dep)
      ? join(frameworkRoot, 'node_modules', dep)
      : findInstalledDir(dep);
    if (!dir) continue;
    const pkgPath = join(dir, 'package.json');
    const pkg = readPkgSafe(dir);
    if (!pkg) continue;
    let platformBound = Boolean(pkg.os || pkg.cpu);
    if (!platformBound) {
      try {
        platformBound = readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith('.node'));
      } catch { /* 读取失败按非平台绑定处理，镜像自检兜底 */ }
    }
    if (!platformBound) continue;
    const target = from.startsWith('@agentdevjs/') ? dep : from;
    if (target === '<entry>') continue; // 入口直接 import 的平台包（不存在此形态，防御）
    const targetDir = findInstalledDir(target);
    if (!targetDir) continue;
    const version = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).version;
    native.set(target, version);
  }
  return [...native].map(([name, version]) => `${name}@${version}`);
}

// ============= 镜像 context / node_modules 组装 =============

function copyTreeFiltered(src, dest, excludeSegments) {
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = relative(src, s);
      if (!rel) return true;
      const segs = rel.split(/[\\/]/);
      return !excludeSegments.some((x) => segs.includes(x));
    },
  });
}

// 主 context：闭包文件 + agent 目录整树 + 引用到的 local-features / features
// 子包产物树。local-features 走顶层 dist 布局（agent.js 以
// local-features/dist/<seg>/src/index.js 引用，knowledge / skills 等运行时
// 资产由 copy-local-feature-skills.mjs 在构建时拷入 dist，随 dist 目录整树
// 进入镜像）；features 子包自带独立 dist，整树拷贝。
// resources/features（官方 tgz 仓库）仅当闭包引用 server/feature-runtime 时
// 携带（按需解析 feature tgz 的 agent 才需要）。
function buildAgentContext(agent, rels) {
  const ctx = join(root, 'dist', `container-ctx-${agent.id}`);
  rmSync(ctx, { recursive: true, force: true });
  mkdirSync(ctx, { recursive: true });
  const copyIn = (rel) => {
    const src = join(root, rel);
    if (!existsSync(src)) fail(`主 context 组装缺文件: ${rel}`);
    mkdirSync(dirname(join(ctx, rel)), { recursive: true });
    cpSync(src, join(ctx, rel), { recursive: true });
  };

  const lfSubs = new Set();
  const featSubs = new Set();
  let needsFeatureRepo = false;
  for (const rel of rels) {
    if (rel.startsWith('local-features/dist/')) {
      const seg = rel.slice('local-features/dist/'.length).split('/')[0];
      if (seg && !seg.includes('.') && existsSync(join(root, 'local-features', seg))) lfSubs.add(seg);
    } else if (rel.startsWith('features/')) {
      const seg = rel.split('/')[1];
      if (seg) featSubs.add(seg);
    } else if (rel.startsWith('server/feature-runtime/')) {
      needsFeatureRepo = true;
    }
  }

  // 闭包文件（local-features/dist/<seg> 子树由整树覆盖；其余 local-features
  // 文件——如顶层 barrel dist/index.js——单文件复制）
  for (const rel of rels) {
    if (lfSubs.has(rel.split('/')[2] ?? '') && rel.startsWith('local-features/dist/')) continue;
    if (rel.startsWith('features/')) continue;
    copyIn(rel);
  }
  copyIn('scripts/container-selftest.js');
  copyIn('package.json');

  copyTreeFiltered(agent.dir, join(ctx, 'prebuilt-agents', agent.tier, agent.id), ['node_modules']);
  for (const sub of lfSubs) {
    copyTreeFiltered(join(root, 'local-features', 'dist', sub), join(ctx, 'local-features', 'dist', sub), []);
  }
  for (const sub of featSubs) {
    copyTreeFiltered(join(root, 'features', sub), join(ctx, 'features', sub), ['node_modules', 'test']);
  }
  if (needsFeatureRepo) {
    copyTreeFiltered(join(root, 'resources', 'features'), join(ctx, 'resources', 'features'), []);
  }
  log(`[${agent.id}] 主 context：闭包 ${rels.size} 文件 + local-features [${[...lfSubs].join(', ') || '-'}] + features [${[...featSubs].join(', ') || '-'}]${needsFeatureRepo ? ' + resources/features' : ''}`);
  return ctx;
}

// @agentdevjs 开发态实体化：相邻框架仓库 npm pack → 共享 tgz 缓存 → 解包。
// pack 产物即发布形态（files/npmignore 裁剪），与 vendor 化同语义。
async function materializeAgentdevEntity(name, nmDir) {
  const short = name.slice('@agentdevjs/'.length);
  const dirName = PACKAGE_DIR_OVERRIDES[name] ?? short;
  const pkgDir = join(frameworkRoot, 'packages', dirName);
  if (!existsSync(join(pkgDir, 'package.json'))) fail(`框架仓库缺少包目录: ${pkgDir}`);
  if (!existsSync(join(pkgDir, 'dist'))) {
    fail(`${name} 的 dist 缺失（${pkgDir}/dist）——框架仓库未构建。请先在 ${frameworkRoot} 运行 npm run build。`);
  }
  const version = readPkgSafe(pkgDir).version;
  const tgzPath = join(tgzCache, tgzFileName(name, version));
  if (!existsSync(tgzPath)) {
    runShell(`npm pack --pack-destination "${tgzCache}"`, pkgDir, `打包 ${name}`);
  }
  if (!existsSync(tgzPath)) fail(`npm pack 产物缺失: ${tgzPath}`);
  const dest = join(nmDir, '@agentdevjs', short);
  untarBufferToDir(await gunzipFileToBuffer(tgzPath), dest, { strip: 1 });
}

// 平台绑定包的 Linux 二进制子包（宿主侧补齐，替代容器内 RUN npm install）：
// 读宿主包 optionalDependencies，取匹配容器架构的 linux 子包。ppc64/riscv64
// 等不匹配架构的绝不拉取。tgz 走共享缓存（跨 agent 只拉一次）。
async function materializeNativeSubpkgs(nativeInstalls, npmArch, nmDir) {
  for (const spec of nativeInstalls) {
    const [name, version] = spec.split('@').length > 2
      ? [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]
      : spec.split('@');
    const hostDir = findInstalledDir(name);
    if (!hostDir) { fail(`平台绑定包 ${name} 本地未安装，无法解析其 Linux 子包`); }
    const hostPkg = readPkgSafe(hostDir);
    const linuxSubs = Object.entries(hostPkg.optionalDependencies || {})
      .filter(([n]) => n.includes(`linux-${npmArch}`))
      .map(([n, v]) => `${n}@${v}`);
    log(`[${nmDir.split(/[\\/]/).pop()}] 平台绑定 ${spec}：补 Linux 子包 ${linuxSubs.join(', ') || '（无 linux 子包，跳过）'}`);
    for (const sub of linuxSubs) {
      const subName = sub.slice(0, sub.lastIndexOf('@'));
      const expected = `${subName.replace(/^@/, '').replace(/\//g, '-')}-${sub.slice(sub.lastIndexOf('@') + 1)}.tgz`;
      const tgzPath = join(tgzCache, expected);
      if (!existsSync(tgzPath)) {
        runShell(`npm pack "${sub}" --pack-destination "${tgzCache}"`, root, `拉取 ${sub}`);
      }
      // npm pack 实际文件名可能带 scope 前缀差异，缺失时从缓存目录兜底查找
      let actual = tgzPath;
      if (!existsSync(actual)) {
        const found = readdirSync(tgzCache).find((f) => f.endsWith('.tgz') && f.includes(subName.split('/').pop()));
        if (!found) fail(`npm pack ${sub} 产物缺失`);
        actual = join(tgzCache, found);
      }
      untarBufferToDir(await gunzipFileToBuffer(actual), join(nmDir, subName), { strip: 1 });
    }
  }
}

// 镜像 node_modules：闭包集合整体组装（不再复制全量骨架）。平台绑定包跳过
// Windows 实体（Linux 子包由 materializeNativeSubpkgs 补入）；开发态
// @agentdevjs 实体化 + 分叉仲裁嵌套。
async function buildAgentNm(agentId, graph, form, nativeInstalls, npmArch) {
  const nmDir = join(root, 'dist', `container-nm-${agentId}`);
  rmSync(nmDir, { recursive: true, force: true });
  mkdirSync(nmDir, { recursive: true });
  let copied = 0;
  let skippedPlatform = 0;
  for (const dep of graph.deps) {
    const dir = graph.nested.has(dep)
      ? join(frameworkRoot, 'node_modules', dep)
      : findInstalledDir(dep);
    if (!dir) fail(`依赖 ${dep} 本地未安装（构建过程中树被改动？）`);
    const pkg = readPkgSafe(dir);
    if (!pkg) fail(`依赖 ${dep} 缺少 package.json: ${dir}`);
    if (pkg.os || pkg.cpu) { skippedPlatform += 1; continue; }
    if (dep.startsWith('@agentdevjs/') && form === 'dev') {
      await materializeAgentdevEntity(dep, nmDir);
    } else {
      cpSync(dir, join(nmDir, dep), { recursive: true });
    }
    copied += 1;
  }
  for (const { owner, dep, range } of graph.conflicts) {
    const fwSrc = join(frameworkRoot, 'node_modules', dep);
    if (!existsSync(join(fwSrc, 'package.json'))) {
      fail(`依赖分叉仲裁失败：框架仓库 node_modules 无 ${dep}（${owner} 声明 ${range}）`);
    }
    const dest = join(nmDir, owner, 'node_modules', dep);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(fwSrc, dest, { recursive: true });
    log(`[${agentId}] 依赖分叉仲裁：${owner} 的 ${dep} 声明 ${range}，根占位分叉 → 嵌套 ${readPkgSafe(fwSrc).version}`);
  }
  if (nativeInstalls.length > 0) {
    await materializeNativeSubpkgs(nativeInstalls, npmArch, nmDir);
  }
  log(`[${agentId}] node_modules：${copied} 个包${skippedPlatform ? `（另 ${skippedPlatform} 个平台绑定包跳过，Linux 子包已补）` : ''}`);
  return nmDir;
}

// 镜像 tag：git 可用时附短 hash（工作区脏加 -dirty，便于对表）；桌面安装树
// 无 .git，回退 released——发布树版本本身即确定轨道。
function computeTag(version) {
  const hash = runCapture('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  if (hash === null) return `${version}-released`;
  const dirty = runCapture('git', ['status', '--porcelain'], { cwd: root });
  return `${version}-${hash}${dirty ? '-dirty' : ''}`;
}

// runtime 语义冒烟：镜像内加载该镜像包含的 agent 装配链（import 成功 = 依赖
// 闭包完整；native 二进制在 import 链上真实加载）。
function smoke(imageTag) {
  const r = spawnSync('docker', [
    'run', '--rm', '--entrypoint', 'node', imageTag, 'scripts/container-selftest.js',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`镜像自检失败（退出码 ${r.status}）\n--- 自检输出 ---\n${r.stdout}${r.stderr}`);
  }
  log(`镜像自检通过: ${r.stdout.trim().split('\n').pop()}`);
}

async function buildAgent(agent, hostClosure, version, form, npmArch) {
  log(`── agent ${agent.id} ──`);
  const agentClosure = collectClosure([join(agent.dir, 'agent.js')]);
  const rels = new Set(
    [...hostClosure.files, ...agentClosure.files].map((f) => relative(root, f).replace(/\\/g, '/')),
  );
  const bare = new Set([...hostClosure.bare, ...agentClosure.bare]);
  const ctxDir = buildAgentContext(agent, rels);
  const graph = expandDepGraph(bare, form);
  const nativeInstalls = detectNativeDeps(graph);
  if (nativeInstalls.length > 0) {
    log(`[${agent.id}] 检出平台绑定依赖: ${nativeInstalls.join(', ')}——宿主侧补 Linux ${npmArch} 子包（npm pack 需网络或本地缓存）`);
  }
  const nmDir = await buildAgentNm(agent.id, graph, form, nativeInstalls, npmArch);

  const tag = computeTag(version);
  const primary = `${RUNTIME_REPO}:${agent.id}`;
  const secondary = `${RUNTIME_REPO}:${agent.id}-${tag}`;
  log(`[${agent.id}] docker build（主 context ${ctxDir} + nm=${nmDir}）`);
  runShell(
    `docker build` +
      ` --build-context nm="${nmDir}"` +
      ` -f container/Dockerfile` +
      ` -t ${primary}` +
      ` -t ${secondary}` +
      ` --label org.opencontainers.image.revision="${tag}"` +
      ` --label org.opencontainers.image.version="${version}"` +
      ` --label dev.claw.agent="${agent.id}"` +
      ` "${ctxDir}"`,
    root,
    `镜像构建 ${agent.id}`,
  );
  smoke(primary);
  return { primary, secondary };
}

async function main() {
  const npmArch = ensureDocker();
  ensureBase();
  mkdirSync(tgzCache, { recursive: true });
  try {
    const { names, version } = resolveAgentdevjsDeps();
    const form = detectInstallForm(names);
    log(`安装形态: ${form === 'dev' ? '开发态（junction 实体化）' : '实体（发布态 / 桌面树）'}`);
    ensureLocalDist(form);

    const agents = selectAgents(discoverAgents());
    log(`构建目标: ${agents.map((a) => a.id).join(', ')}`);
    const hostClosure = collectClosure([HOST_ENTRY]);

    const built = [];
    for (const agent of agents) {
      const { primary, secondary } = await buildAgent(agent, hostClosure, version, form, npmArch);
      built.push({ agent: agent.id, primary, secondary });
    }
    log('完成。镜像（容器后端按 agentId 选用主 tag）：');
    for (const b of built) log(`  ${b.agent}: ${b.primary}（版本副 tag ${b.secondary}）`);
  } finally {
    rmSync(tgzCache, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[pack:container] ${err.stack || err.message}`);
  process.exit(1);
});
