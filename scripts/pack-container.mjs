#!/usr/bin/env node
// [pack:container] 路线一（ADR-0037 容器阶段 / M5）：本地树直取构建 runtime 镜像。
//
// 镜像内容 = Agent runtime 运行闭包（ADR-0037 决策 1：仅 runtime 进容器）。
// 构建器正向收集：run-prebuilt-agent.js 的 import 递归闭包 + prebuilt-agents /
// local-features / features / resources/features + node_modules。平台物
// （server.js / public / 未被 runtime 引用的平台路由）不进镜像。
//
// 断网可构建（纯 JS 依赖树）：无现场 npm install，依赖安装由"本地能跑"前提
// 消解。@agentdevjs/* 开发态是 Windows junction，docker CLI 打包不跟随
// （实测产生损坏条目），且 named-context ignore 特性实测不可用——node_modules
// 整体由脚本预组装进 dist/container-nm（复制骨架 + npm pack 实体化 +
// 传递依赖闭包补齐；这些依赖不在 Claw 根声明里，开发态靠 junction realpath
// 穿到框架仓库解析，镜像内此路不存在）。
//
// 平台绑定依赖（native 二进制，如 sharp）是系统机制而非豁免：依赖闭包扫描
// 检出（os/cpu 字段 / *.node 产物）→ 宿主侧补齐 Linux 版子包备入 nm
// （NATIVE_INSTALLS，npm pack 需网络或本地缓存，日志明示）。纯 JS 树无任何
// 额外准备步骤；镜像构建纯 COPY 零 RUN、零联网（不在容器内 npm install——
// 它会按镜像内 package.json 的 file: 开发态声明重建依赖链接，实测覆盖
// @agentdevjs 实体导致装配链断裂）。
//
// 四形态覆盖：开发态（junction 实体化）/ 发布态（registry 实体）/ 桌面安装树
// （staging 内运行本脚本，同实体路径）。镜像 = 本地树现状快照，开发迭代形态；
// 可复现轨道预留 --staging（计划 M5 路线二）。运行时（M6 容器后端）只
// docker run 既有 tag，缺失报错不代建。
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PACKAGE_DIR_OVERRIDES, tgzFileName, gunzipFileToBuffer, untarBufferToDir } from './pack-tgz-lib.mjs';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const frameworkRoot = resolve(process.env.AGENTDEV_LOCAL_PATH || join(root, '..', 'AgentDev'));
// base 镜像版本与 scripts/pack-desktop.mjs 的 PINNED_NODE_VERSION 同轨，
// 升级时两处（外加 container/base.Dockerfile）同步。
const BASE_TAG = 'agentdev-claw-base:24.19.0';
const RUNTIME_REPO = 'agentdev-claw-runtime';
const namedCtxNm = join(root, 'dist', 'container-nm');
const mainCtxDir = join(root, 'dist', 'container-context');

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
  // npm 平台子包命名（x64/arm64）与 Go 架构名（amd64/arm64）的映射；
  // 少见架构直接报错，出现新需求时再扩展。
  const npmArch = { amd64: 'x64', arm64: 'arm64', x86_64: 'x64' }[arch];
  if (!npmArch) fail(`未支持的容器架构: ${arch}（当前支持 amd64/x64、arm64）`);
  log(`Docker 守护进程就绪（server ${version}，容器架构 ${arch}）`);
  return npmArch;
}function ensureBase() {
  const existing = runCapture('docker', ['image', 'inspect', BASE_TAG, '--format', '{{.Id}}']);
  if (existing !== null) {
    log(`base 镜像就绪: ${BASE_TAG}（${existing.slice(0, 19)}）`);
    return;
  }
  log('base 镜像缺失，开始预烘焙（需网络：拉 node:24.19.0-slim + Debian 源；仅此一次，此后纯 JS 构建不联网）。离线环境可在他机构建后 docker save / docker load 导入。');
  runShell(`docker build -f container/base.Dockerfile -t ${BASE_TAG} container/`, root, 'base 镜像构建');
}

function resolveAgentdevjsDeps() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const names = Object.keys(pkg.dependencies || {}).filter((n) => n.startsWith('@agentdevjs/'));
  if (names.length === 0) fail('根声明中没有 @agentdevjs/* 依赖，疑似源码树异常');
  return { names, version: pkg.version };
}

// ============= runtime import 闭包（正向收集的事实依据） =============

function resolveLocalSpec(fromFile, spec) {
  const base = dirname(fromFile);
  for (const cand of [spec, spec + '.js', spec + '/index.js', spec + '.mjs']) {
    const t = resolve(base, cand);
    if (existsSync(t) && !t.includes('\\node_modules\\') && !t.includes('/node_modules/')) return t;
  }
  return null;
}

// 递归收集 entry 的本地 import 闭包（静态 import / 动态 import / require 字面量）。
// 入口 = 宿主入口 + 全部 prebuilt agent.js：agent.js 是运行时动态加载的
// （不在宿主入口的静态链里），其 import 的 server/scripts 文件必须从此处
// 收集，否则镜像内装配链缺文件（实测：feature-config-layers.js 漏收）。
// 非字面量的动态 import（feature loader 按运行时产物加载）由整目录白名单覆盖
// （local-features / features / resources / prebuilt-agents）。
function collectRuntimeClosure() {
  const entries = [join(root, 'scripts', 'run-prebuilt-agent.js')];
  // prebuilt-agents/<tier>/<name>/agent.js 两层布局
  const paRoot = join(root, 'prebuilt-agents');
  for (const tier of readdirSync(paRoot)) {
    const tierPath = join(paRoot, tier);
    for (const name of readdirSync(tierPath)) {
      const agentJs = join(tierPath, name, 'agent.js');
      if (existsSync(agentJs)) entries.push(agentJs);
    }
  }
  const seen = new Set();
  const files = [];
  // 正则必须按文件重建：带 g 标志的正则对象有 lastIndex 状态，跨文件复用
  // 时上个长文件的扫描位置会污染下个短文件（起点超文件尾 → 整文件 import
  // 漏抓，实测 feature-config-layers 因此漏收 ph-projects）。
  const patternSrcs = [
    String.raw`from\s+['"](\.[^'"]+)['"]`,
    String.raw`import\(\s*['"](\.[^'"]+)['"]\s*\)`,
    String.raw`require\(\s*['"](\.[^'"]+)['"]\s*\)`,
  ];
  function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    const src = readFileSync(file, 'utf8');
    for (const ps of patternSrcs) {
      const re = new RegExp(ps, 'g');
      let m;
      while ((m = re.exec(src))) {
        const t = resolveLocalSpec(file, m[1]);
        if (t) walk(t);
      }
    }
  }
  entries.forEach(walk);
  return files.map((f) => relative(root, f).replace(/\\/g, '/')).sort();
}

// ============= 主 context 组装（白名单树） =============

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

function buildMainContext(closureFiles) {
  rmSync(mainCtxDir, { recursive: true, force: true });
  mkdirSync(mainCtxDir, { recursive: true });
  const copyIn = (rel) => {
    const src = join(root, rel);
    if (!existsSync(src)) fail(`主 context 组装缺文件: ${rel}`);
    mkdirSync(dirname(join(mainCtxDir, rel)), { recursive: true });
    cpSync(src, join(mainCtxDir, rel), { recursive: true });
  };

  // 宿主脚本闭包 + 自检脚本（入口本身不 import，显式加入）
  for (const rel of closureFiles) copyIn(rel);
  copyIn('scripts/container-selftest.js');
  copyIn('package.json');

  // Agent 资产整树（skills / knowledge 等非 dist 运行时资产在包根目录）
  copyTreeFiltered(join(root, 'prebuilt-agents'), join(mainCtxDir, 'prebuilt-agents'), []);
  copyTreeFiltered(join(root, 'local-features'), join(mainCtxDir, 'local-features'), ['node_modules', 'test']);
  for (const name of FEATURE_DIRS) {
    const src = join(root, 'features', name);
    if (existsSync(src)) copyTreeFiltered(src, join(mainCtxDir, 'features', name), ['node_modules', 'test']);
  }
  copyTreeFiltered(join(root, 'resources', 'features'), join(mainCtxDir, 'resources', 'features'), []);

  // named context（nm）没有排除文件：BuildKit 的 <name>.dockerignore 特性
  // 实测不可用（docker 29.0.1 Desktop，Dockerfile 旁与主 context 根均不生效），
  // nm 指向脚本预组装的 dist/container-nm，排除在组装时完成。
  log(`主 context 组装完成: ${mainCtxDir}（闭包 ${closureFiles.length} 文件 + Agent 资产整树）`);
}

// ============= node_modules 镜像目录组装（单一 nm context） =============
//
// 背景（实测，docker 29.0.1 Desktop）：BuildKit named-context 的
// <name>.dockerignore 特性不可用（Dockerfile 旁与主 context 根两处放置
// 均不生效），且 Windows junction 在 context tar 中产生损坏条目导致
// COPY 报 non-directory。因此不依赖任何排除特性：脚本预组装一个干净的
// node_modules 目录，docker build 直接整目录消费。
//
// 开发态：复制 node_modules（排除 @agentdevjs junction scope / 构建期
//   typescript / .bin shim）+ npm pack 实体化 @agentdevjs + 从框架仓库
//   node_modules 补传递依赖（这些包不在 Claw 根声明里，运行时靠 junction
//   realpath 穿到框架仓库解析，镜像内此路不存在）。
// 发布态 / 桌面树：@agentdevjs 与传递依赖已是实体，仅排除构建期包。

// 依赖定位：优先 Claw 本地树（镜像主来源），开发态缺的在框架仓库
function findInstalledDir(dep) {
  for (const base of [join(root, 'node_modules'), join(frameworkRoot, 'node_modules')]) {
    const p = join(base, dep);
    if (existsSync(join(p, 'package.json'))) return p;
  }
  return null;
}

// 收集镜像内会缺失的传递依赖（含递归）与全部 (dep, from) 关系（native 检测复用）
// conflicts：框架包直接依赖与 Claw 根已装版本 major 分叉的清单（嵌套仲裁用）。
// 预组装是扁平复制，没有 npm 的版本仲裁——根的 openai@6 会劫持框架 llm 声明
// 的 ^4（实测容器内 SDK 6.x 对 API 新事件 response.metadata 直接 assertNever，
// 模型调用全灭）。仲裁 = 把框架本机实测版本嵌套复制进 @agentdevjs/<pkg>/
// node_modules/<dep>，与 npm 冲突解析行为一致。
function extractMajor(rangeOrVersion) {
  const m = /^[^0-9]*?(\d+)(?:[.\s]|$)/.exec(String(rangeOrVersion || '').trim());
  return m ? Number(m[1]) : null;
}
function collectDepsGraph(names) {
  const pairs = []; // [dep, from]
  const seenPairs = new Set();
  const seenDeps = new Set();
  const missing = [];
  const conflicts = []; // { owner, dep, range, rootVersion }
  const push = (dep, from) => {
    const key = `${dep}<-${from}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    pairs.push([dep, from]);
  };
  for (const name of names) {
    const dirName = PACKAGE_DIR_OVERRIDES[name] ?? name.slice('@agentdevjs/'.length);
    const pkgPath = join(frameworkRoot, 'packages', dirName, 'package.json');
    if (!existsSync(pkgPath)) fail(`框架仓库缺少包目录: ${pkgPath}`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const [d, range] of Object.entries(pkg.dependencies || {})) {
      if (!d.startsWith('@agentdevjs/')) {
        push(d, name);
        const rootPkgPath = join(root, 'node_modules', d, 'package.json');
        if (existsSync(rootPkgPath)) {
          const rangeMajor = extractMajor(range);
          const rootMajor = extractMajor(JSON.parse(readFileSync(rootPkgPath, 'utf8')).version);
          if (rangeMajor != null && rootMajor != null && rangeMajor !== rootMajor) {
            conflicts.push({ owner: name, dep: d, range, rootMajor });
          }
        }
      }
    }
    for (const d of Object.keys(pkg.peerDependencies || {})) {
      if (!d.startsWith('@agentdevjs/')) push(d, name);
    }
  }
  // 索引遍历而非队列快照：push 进 pairs 的新依赖必须被后续迭代展开，
  // 否则递归在第二层腰斩（实测 axios：feishu-bot → node-sdk → axios 断链）。
  // 嵌套仲裁的包（major 分叉）递归源固定为框架仓库版本——根占位版本（如
  // openai 6.x）的依赖树与嵌套版本（4.x，依赖 node-fetch）不同，读错侧会
  // 漏掉嵌套版本的运行时依赖（实测镜像自检 node-fetch 缺失）。
  const nestedDeps = new Set(conflicts.map((c) => c.dep));
  for (let i = 0; i < pairs.length; i++) {
    const [dep] = pairs[i];
    if (seenDeps.has(dep)) continue;
    seenDeps.add(dep);
    const dir = nestedDeps.has(dep)
      ? join(frameworkRoot, 'node_modules', dep)
      : findInstalledDir(dep);
    if (!dir) continue; // 上层复制时统一 fail
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // 平台绑定的 optional 子包（os/cpu 字段，如 @img/sharp-win32-x64）不复制
    // Windows 实体——其宿主包经 NATIVE_INSTALLS 在容器内装 Linux 版。
    if (pkg.os || pkg.cpu) continue;
    // 所有已安装包（无论复制进镜像与否）都深入递归依赖：镜像内包的依赖树里
    // 的平台绑定同样必须检出。optionalDependencies 一并递归：平台二进制子包
    // 经此进入 pairs 供检测。
    for (const d of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]) {
      if (!d.startsWith('@agentdevjs/')) push(d, dep);
    }
    if (!existsSync(join(root, 'node_modules', dep, 'package.json'))) missing.push(dep);
  }
  return { pairs, missing, conflicts };
}

// 平台绑定依赖检测：安装实体带 os/cpu 字段或含 *.node 二进制 → 其引入的
// 外部包需容器内安装 Linux 版（Windows 装的平台二进制在 Linux 不可用）。
// wasm 类资产跨平台，不触发。
function detectNativeDeps(pairs, nestedDeps = new Set()) {
  const native = new Map(); // pkg -> version
  for (const [dep, from] of pairs) {
    const dir = nestedDeps.has(dep)
      ? join(frameworkRoot, 'node_modules', dep)
      : findInstalledDir(dep);
    if (!dir) continue;
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    let platformBound = Boolean(pkg.os || pkg.cpu);
    if (!platformBound) {
      try {
        platformBound = readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith('.node'));
      } catch { /* 读取失败按非平台绑定处理，镜像自检兜底 */ }
    }
    if (!platformBound) continue;
    const target = from.startsWith('@agentdevjs/') ? dep : from;
    const targetDir = findInstalledDir(target);
    if (!targetDir) continue;
    const version = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).version;
    native.set(target, version);
  }
  return [...native].map(([name, version]) => `${name}@${version}`);
}

// 组装 dist/container-nm：docker build 的唯一 node_modules 来源。
// nativeInstalls：检出的平台绑定包（pkg@version）——容器内不可 RUN npm
// install（它会按镜像内 package.json 的 file: 开发态声明重建依赖链接，
// 覆盖 @agentdevjs 实体，实测导致装配链断裂），改在宿主侧补齐 Linux 版：
// 本体（平台无关纯 JS）已在骨架里，仅需按宿主包的 optionalDependencies
// 拉取 linux 平台二进制子包解包进 nm。宿主 npm pack 需网络（或本地缓存），
// 与原先容器内安装的网络需求等价，但失败点提前到准备阶段、报错更清晰。
async function materializeNm(names, missing, form, nativeInstalls, npmArch, conflicts = []) {
  rmSync(namedCtxNm, { recursive: true, force: true });
  const isDev = form === 'dev';
  if (isDev && !existsSync(join(frameworkRoot, 'package.json'))) {
    fail(`开发态（junction）但未找到框架仓库: ${frameworkRoot}（可用 AGENTDEV_LOCAL_PATH 指定）`);
  }

  // 1. 复制本地 node_modules 骨架（排除项随形态）
  const exclude = isDev ? ['@agentdevjs', 'typescript', '.bin'] : ['typescript', '.bin'];
  copyTreeFiltered(join(root, 'node_modules'), namedCtxNm, exclude);
  log(`node_modules 骨架复制完成（排除 ${exclude.join(' / ')}）`);

  if (!isDev) {
    // 发布态 / 桌面树：@agentdevjs 与传递依赖已是 npm 安装实体，骨架即完整。
    log('安装形态 = 实体（发布态 / 桌面树），@agentdevjs 随骨架整体复制');
    await materializeNativeSubpkgs(nativeInstalls, npmArch);
    return namedCtxNm;
  }

  // 2. 开发态：@agentdevjs 实体化（npm pack 本地操作，无网络）
  log(`安装形态 = 开发态 junction，实体化 ${names.length} 个包（npm pack）`);
  mkdirSync(join(namedCtxNm, '@agentdevjs'), { recursive: true });
  const tgzCache = join(tmpdir(), `pack-container-${process.pid}`);
  mkdirSync(tgzCache, { recursive: true });
  for (const name of names) {
    const dirName = PACKAGE_DIR_OVERRIDES[name] ?? name.slice('@agentdevjs/'.length);
    const pkgDir = join(frameworkRoot, 'packages', dirName);
    if (!existsSync(join(pkgDir, 'package.json'))) {
      fail(`框架仓库缺少包目录: ${pkgDir}`);
    }
    if (!existsSync(join(pkgDir, 'dist'))) {
      fail(`${name} 的 dist 缺失（${pkgDir}/dist）——框架仓库未构建。请先在 ${frameworkRoot} 运行 npm run build。`);
    }
    const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
    runShell(`npm pack --pack-destination "${tgzCache}"`, pkgDir, `打包 ${name}`);
    const tgzPath = join(tgzCache, tgzFileName(name, version));
    if (!existsSync(tgzPath)) fail(`npm pack 产物缺失: ${tgzPath}`);
    // 安装目录名 = npm 包名短名（node 的模块寻址依据）；dirName 只是框架
    // 仓库源目录名（PACKAGE_DIR_OVERRIDES 特例，如 rokid-bot -> rokid-feature）。
    const dest = join(namedCtxNm, '@agentdevjs', name.slice('@agentdevjs/'.length));
    untarBufferToDir(await gunzipFileToBuffer(tgzPath), dest, { strip: 1 });
    log(`${name}@${version} -> @agentdevjs/${name.slice('@agentdevjs/'.length)}`);
  }
  rmSync(tgzCache, { recursive: true, force: true });

  // 3. 传递依赖闭包补齐（Claw 根声明外的运行时依赖）
  if (missing.length > 0) {
    log(`传递依赖闭包：${missing.length} 个包本地树缺失，从框架仓库 node_modules 补齐`);
    for (const dep of missing) {
      const src = join(frameworkRoot, 'node_modules', dep);
      if (!existsSync(join(src, 'package.json'))) {
        fail(`框架仓库 node_modules 缺少 ${dep}——框架仓库未完整安装，请先在其根目录 npm install。`);
      }
      cpSync(src, join(namedCtxNm, dep), { recursive: true });
    }
  }

  // 4. 依赖版本 major 分叉的嵌套仲裁：框架包声明 ^4 而根占位 6.x 时，
  // 把框架本机实测版本嵌套复制进框架包私有 node_modules（node 解析顺序：
  // 包目录就近优先）。只仲裁一层直接依赖——嵌套包自身的依赖仍从根解析
  //（深链 major 分叉概率低，出现时按本条日志定位再加条目）。
  if (conflicts.length > 0) {
    for (const { owner, dep, range, rootMajor } of conflicts) {
      const fwSrc = join(frameworkRoot, 'node_modules', dep);
      if (!existsSync(join(fwSrc, 'package.json'))) {
        fail(`依赖分叉仲裁失败：框架仓库 node_modules 无 ${dep}（${owner} 声明 ${range}）`);
      }
      const fwVersion = JSON.parse(readFileSync(join(fwSrc, 'package.json'), 'utf8')).version;
      const ownerShort = owner.slice('@agentdevjs/'.length);
      const dest = join(namedCtxNm, owner, 'node_modules', dep);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(fwSrc, dest, { recursive: true });
      log(`依赖分叉仲裁：${owner} 的 ${dep} 声明 ${range}，根占位 v${rootMajor} → 嵌套 ${fwVersion}`);
    }
  }

  await materializeNativeSubpkgs(nativeInstalls, npmArch);
  return namedCtxNm;
}

// 平台绑定包的 Linux 二进制子包准备（宿主侧，替代容器内 RUN npm install）：
// 读宿主包 package.json 的 optionalDependencies，取匹配容器架构的 linux
// 子包（如 x64 下 sharp 的 @img/sharp-linux-x64 与 libvips 变体；同名包
// 覆盖全架构——ppc64/riscv64 等不匹配架构的绝不拉取，避免镜像臃肿）。
async function materializeNativeSubpkgs(nativeInstalls, npmArch) {
  for (const spec of nativeInstalls) {
    const [name, version] = spec.split('@').length > 2
      ? [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]
      : spec.split('@');
    const hostDir = findInstalledDir(name);
    if (!hostDir) { fail(`平台绑定包 ${name} 本地未安装，无法解析其 Linux 子包`); }
    const hostPkg = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'));
    const linuxSubs = Object.entries(hostPkg.optionalDependencies || {})
      .filter(([n]) => n.includes('linux') && n.includes(npmArch))
      .map(([n, v]) => `${n}@${v}`);
    log(`平台绑定 ${spec}：宿主侧补齐 Linux 子包 ${linuxSubs.join(', ') || '（无 linux 子包，跳过）'}`);
    const tgzCache = join(tmpdir(), `pack-container-native-${process.pid}`);
    mkdirSync(tgzCache, { recursive: true });
    for (const sub of linuxSubs) {
      runShell(`npm pack "${sub}" --pack-destination "${tgzCache}"`, root, `拉取 ${sub}`);
      const tgzDir = readdirSync(tgzCache).filter((f) => f.endsWith('.tgz'));
      if (tgzDir.length === 0) fail(`npm pack ${sub} 产物缺失`);
      const tgzPath = join(tgzCache, tgzDir[tgzDir.length - 1]);
      const subName = sub.slice(0, sub.lastIndexOf('@'));
      untarBufferToDir(await gunzipFileToBuffer(tgzPath), join(namedCtxNm, subName), { strip: 1 });
      rmSync(tgzPath, { force: true });
      log(`${sub} -> node_modules/${subName}`);
    }
    rmSync(tgzCache, { recursive: true, force: true });
  }
}

// 安装形态探测：开发态（@agentdevjs junction）/ 实体（发布态 registry 实体、
// 桌面安装树 vendor 实体）。四形态目标（ADR-0037 M5）：构建器只依赖"一棵
// 能跑的树"，形态差异全部在此适配。
function detectInstallForm(names) {
  const firstPkgDir = join(root, 'node_modules', '@agentdevjs', names[0].slice('@agentdevjs/'.length));
  return existsSync(firstPkgDir) && lstatSync(firstPkgDir).isSymbolicLink() ? 'dev' : 'entity';
}

// 本地 dist 策略（形态感知）：
//   开发态——总是重建（tsc / 子包构建均增量，保证镜像内 dist 与当前源码
//     一致，路线一"镜像 = 本地现状"语义；构建依赖在本地 devDeps）；
//   实体形态（发布 / 桌面树）——跳过重建：dist 是安装产物本身即权威，
//     且发布树已 prune 构建期依赖、不可也不应重建（pack:desktop 原则）。
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

// 镜像 tag：git 可用时附短 hash（工作区脏加 -dirty，便于对表）；桌面安装树
// 无 .git（staging 为文件导出），回退 <version>-released——发布树版本本身
// 就是确定轨道，无 hash 语义反而正确。
function computeTag(version) {
  const hash = runCapture('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
  if (hash === null) return `${version}-released`;
  const dirty = runCapture('git', ['status', '--porcelain'], { cwd: root });
  return `${version}-${hash}${dirty ? '-dirty' : ''}`;
}

// runtime 语义冒烟：镜像内加载全部 prebuilt agent 装配链。import 成功 =
// 依赖闭包完整；native 二进制（若装配链引用）在 import 时真实加载。
function smoke(imageTag) {
  const r = spawnSync('docker', [
    'run', '--rm', '--entrypoint', 'node', imageTag, 'scripts/container-selftest.js',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`镜像自检失败（退出码 ${r.status}）\n--- 自检输出 ---\n${r.stdout}${r.stderr}`);
  }
  log(`镜像自检通过: ${r.stdout.trim().split('\n').pop()}`);
}

async function main() {
  const npmArch = ensureDocker();
  ensureBase();
  const { names, version } = resolveAgentdevjsDeps();
  const form = detectInstallForm(names);

  ensureLocalDist(form);
  const closureFiles = collectRuntimeClosure();
  buildMainContext(closureFiles);

  const { pairs, missing, conflicts } = collectDepsGraph(names);
  const nativeInstalls = detectNativeDeps(pairs, new Set(conflicts.map((c) => c.dep)));
  if (nativeInstalls.length > 0) {
    log(`检出平台绑定依赖: ${nativeInstalls.join(', ')}——宿主侧补齐 Linux ${npmArch} 子包（npm pack 需网络或本地缓存）`);
  } else {
    log('依赖闭包为纯 JS，无额外准备步骤（镜像构建零联网）');
  }
  await materializeNm(names, missing, form, nativeInstalls, npmArch, conflicts);

  const tag = computeTag(version);
  const imageTag = `${RUNTIME_REPO}:${tag}`;
  log(`docker build（主 context ${mainCtxDir} + nm=${namedCtxNm}）`);
  runShell(
    `docker build` +
      ` --build-context nm="${namedCtxNm}"` +
      ` -f container/Dockerfile -t ${imageTag} "${mainCtxDir}"`,
    root,
    '镜像构建',
  );
  log(`镜像就绪: ${imageTag}`);
  smoke(imageTag);
  log(`完成。镜像 tag: ${imageTag}（M6 容器后端运行时引用该 tag）`);
}

main().catch((err) => {
  console.error(`[pack:container] ${err.stack || err.message}`);
  process.exit(1);
});
