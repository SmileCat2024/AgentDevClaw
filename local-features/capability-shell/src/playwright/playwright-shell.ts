/**
 * playwright 领域 shell — adapter 实现（ticket 036）
 *
 * 形态 B（封装外部 CLI 的既定模式）：动词声明的 adapterKey 指向进程内函数，
 * 函数内部 spawn 后端 CLI。CLI 是 adapter 的实现细节，对模型不可见——报文
 * 不出现后端原生命令名（安装类指引归属技能文档）。
 *
 * 后端 = `playwright` npm 包的 one-shot 命令面（调研与拍板见
 * docs/playwright-shell-brief.md §6.1.1 / §6.9b）：
 * - 入口显式绝对路径寻址（<pkg>/cli.js），spawn `process.execPath` 直调，
 *   不经 PATH、不经 npx/npm 包装（包装层自带额外进程组与 PATH 依赖）；
 * - 每动词一次性 spawn：渲染即退出，浏览器不驻留（实测 kill 进程组后浏览器
 *   经 remote-debugging-pipe EOF 自杀收敛，2s 余量 0）；
 * - spawn 时注入 env：PLAYWRIGHT_BROWSERS_PATH（shell 自管资产目录，与宿主
 *   环境解耦）+ NO_UPDATE_NOTIFIER=1；
 * - 终止语义复用基座 runCollectedSpawn（detached 进程组、组 kill、中断即
 *   结果），本 adapter 不自实现终止。
 *
 * 动词绑定模式与 coder 相同：分派层传参不含动词，adapter key 形如
 * `playwright:<verb>`，工厂按 key 绑定路由；策略声明的 argPrefix 未用
 * （基座类型契约中该字段当前未被分派层消费，本票核实后决定不补齐）。
 *
 * 报文契约：成功 = 路径 + 字节数等元数据，不回灌大块输出；失败 = 结构化
 * 原因 + 摘录 stderr（分类改写，不透传裸错误；资产缺失附修复指引）。
 */

import { mkdir, stat, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runCollectedSpawn } from '../dispatch.js';
import { PLAYWRIGHT_ENV_FIX_GUIDANCE } from './playwright-policy.js';

const __filename = fileURLToPath(import.meta.url);

/** 单次 spawn 的结果面（与基座 runCollectedSpawn 对齐，便于注入替身）。 */
export interface BackendRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  terminated?: boolean;
}

/** spawn 替身契约（测试注入；缺省实现 = 基座 runCollectedSpawn）。 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { env?: Record<string, string>; signal?: AbortSignal; workdir?: string },
) => Promise<BackendRunResult>;

export interface PlaywrightAdaptersDeps {
  /** CLI 入口（node_modules/playwright/cli.js 绝对路径）；缺省经 createRequire 解析 */
  cliEntry?: string;
  /** 会话后端入口（@playwright/cli bin）；缺省经 createRequire 解析 */
  sessionCliEntry?: string;
  /** playwright 包根（env 盘点用）；缺省取 cliEntry 所在目录 */
  packageRoot?: string;
  /** 浏览器资产目录（注入 PLAYWRIGHT_BROWSERS_PATH）；缺省 ~/.agentdev/assets/playwright-shell/browsers */
  browsersPath?: string;
  /** 产物相对路径解析基准 + spawn cwd；缺省 process.cwd() */
  workdir?: string;
  /** 注入 spawn 实现（测试替身）；缺省用基座 runCollectedSpawn */
  spawnImpl?: SpawnLike;
}

/** 产物动词所需的浏览器资产（headless 渲染）。 */
const REQUIRED_BROWSER = 'chromium-headless-shell';
/** env 报文最多列出的浏览器行数（防 browsers.json 增条目撑爆报文）。 */
const MAX_BROWSER_LINES = 8;
/** 失败报文里 stderr 摘录上限（字符）。 */
const MAX_STDERR_CHARS = 500;

/** adapter 执行上下文（基座分派层注入）。 */
export interface PlaywrightAdapterContext {
  stdin: string;
  termination?: () => 'timeout' | 'user' | null;
  signal?: AbortSignal;
}

/** 展开 `~` 前缀（deps 显式路径以 ~ 开头时用；其余原样返回）。 */
function expandDir(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function createPlaywrightAdapters(deps: PlaywrightAdaptersDeps): Record<string, (args: string[], context?: PlaywrightAdapterContext) => Promise<string>> {
  const workdir = expandDir(deps.workdir ?? process.cwd());
  const spawnImpl: SpawnLike = deps.spawnImpl
    ?? (async (command, args, options) => {
      const run = await runCollectedSpawn(command, args, {
        input: null,
        signal: options.signal,
        workdir: options.workdir,
        env: options.env,
      });
      return { ok: run.ok, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, terminated: run.terminated };
    });

  // ----------------------------------------------------------- 路径与环境

  function browsersPath(): string {
    const configured = deps.browsersPath ?? join(homedir(), '.agentdev', 'assets', 'playwright-shell', 'browsers');
    return expandDir(configured);
  }

  function resolveCliEntry(): string | null {
    if (deps.cliEntry) return deps.cliEntry;
    // 显式 packageRoot 优先（fixture / 装配期覆盖）；cli.js 布局由包契约固定
    if (deps.packageRoot) {
      const candidate = join(deps.packageRoot, 'cli.js');
      return existsSync(candidate) ? candidate : null;
    }
    try {
      // 动态解析（避免顶层 import 打包耦合）：从本模块位置解析 playwright 包
      const here = createRequire(__filename);
      const pkgJson = here.resolve('playwright/package.json');
      return join(dirname(pkgJson), 'cli.js');
    } catch {
      return null;
    }
  }

  function resolvePackageRoot(): string | null {
    if (deps.packageRoot) return deps.packageRoot;
    const entry = resolveCliEntry();
    return entry ? dirname(entry) : null;
  }

  /** 注入后端进程的环境：资产目录重定向 + 关闭联网更新检查。 */
  function backendEnv(): Record<string, string> {
    return {
      PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
      NO_UPDATE_NOTIFIER: '1',
    };
  }

  /** browsers.json 定位：标准 npm 布局在包根同级的 playwright-core 下。 */
  function readBrowsersJson(packageRoot: string): Array<{ name: string; revision: string }> {
    const candidates = [
      join(dirname(packageRoot), 'playwright-core', 'browsers.json'),
      join(packageRoot, 'node_modules', 'playwright-core', 'browsers.json'),
    ];
    for (const path of candidates) {
      try {
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { browsers?: Array<{ name: string; revision: string }> };
        if (Array.isArray(parsed.browsers)) return parsed.browsers;
      } catch { /* 下一个候选 */ }
    }
    return [];
  }

  // -------------------------------------------------------------- env 动词

  async function envVerb(): Promise<string> {
    const lines: string[] = ['playwright_shell env'];
    const packageRoot = resolvePackageRoot();
    let browsersJson: Array<{ name: string; revision: string }> = [];

    if (packageRoot && existsSync(join(packageRoot, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as { version?: string };
        lines.push(`package: playwright ${pkg.version || '(版本未知)'}  root=${packageRoot}`);
      } catch {
        lines.push(`package: playwright（package.json 不可读）  root=${packageRoot}`);
      }
      const entry = resolveCliEntry();
      const entryOk = entry ? existsSync(entry) : false;
      lines.push(`backend entry: ${entry ?? '(未解析)'}  ${entryOk ? 'present' : 'missing'}`);
      if (entryOk) browsersJson = readBrowsersJson(packageRoot);
    } else {
      lines.push('backend entry: missing（后端 playwright 包未安装或不可解析）');
    }

    const dir = browsersPath();
    lines.push(`browsers dir: ${dir}`);
    const hostEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (hostEnv && hostEnv !== dir) {
      lines.push(`host env: PLAYWRIGHT_BROWSERS_PATH=${hostEnv}（本 shell 不沿用宿主值，spawn 时注入自管目录）`);
    }

    if (browsersJson.length === 0) {
      lines.push('browsers: 未知（后端未就位，无法盘点期望版本）');
      lines.push('verdict: 后端缺失');
      lines.push(PLAYWRIGHT_ENV_FIX_GUIDANCE);
      return lines.join('\n');
    }

    const missing: string[] = [];
    lines.push('browsers:');
    for (const browser of browsersJson.slice(0, MAX_BROWSER_LINES)) {
      // 注册目录名约定（playwright-core registry）：name 的 '-' 转 '_' + '-' + revision
      // （如 chromium-headless-shell → chromium_headless_shell-1243）
      const assetDirName = `${browser.name.replace(/-/g, '_')}-${browser.revision}`;
      const installed = existsSync(join(dir, assetDirName));
      const tag = browser.name === REQUIRED_BROWSER ? '  <- 产物动词所需' : '';
      lines.push(`  ${browser.name} rev=${browser.revision}: ${installed ? 'installed' : 'missing'}${tag}`);
      if (browser.name === REQUIRED_BROWSER && !installed) missing.push(`${browser.name} rev=${browser.revision}`);
    }
    if (missing.length > 0) {
      lines.push('verdict: 浏览器资产缺失');
      lines.push(PLAYWRIGHT_ENV_FIX_GUIDANCE);
    } else {
      lines.push('verdict: ok（可调用 screenshot / pdf / har）');
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------ 产物动词共用

  /** 剥离尾部声明 flag（参数道已校验白名单，adapter 按声明自行剥离）。 */
  function stripTailFlags(args: string[], flags: string[]): { positional: string[]; tailFlags: string[] } {
    const positional = [...args];
    const tailFlags: string[] = [];
    while (positional.length > 0 && flags.includes(positional[positional.length - 1])) {
      tailFlags.unshift(positional.pop() as string);
    }
    return { positional, tailFlags };
  }

    /**
   * 解析产物绝对路径并确保父目录存在。
   * 参数道已拒绝绝对路径与 `..` 段（字符串级）；本层再按安全手册做
   * 真实文件系统级核对：mkdir 后对父目录 realpath，符号链接解析出的
   * 真实位置必须仍落在 workspace 内（防工作区内符号链接指出的逃逸）。
   */
  async function ensureOutputPath(outputArg: string): Promise<string> {
    const abs = isAbsolute(outputArg) ? outputArg : join(workdir, outputArg);
    await mkdir(dirname(abs), { recursive: true });
    const rootReal = await realpath(workdir).catch(() => workdir);
    const parentReal = await realpath(dirname(abs)).catch(() => dirname(abs));
    const rel = relative(rootReal, parentReal);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`output parent escapes workspace: ${outputArg}`);
    }
    return abs;
  }

  async function fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return -1;
    }
  }

  /** spawn 后端（含 env 注入与终止语义；entry 缺失直接结构化返回）。 */
  async function spawnBackend(argv: string[], signal?: AbortSignal): Promise<BackendRunResult> {
    const entry = resolveCliEntry();
    if (!entry) {
      // 后端包缺失：合成的可分类 stderr（与资产缺失区分，env 动词给出人工修复路径）
      return { ok: false, stdout: '', stderr: 'backend entry missing: playwright 包未安装或不可解析', exitCode: null, terminated: false };
    }
    return spawnImpl(process.execPath, [entry, ...argv], {
      env: backendEnv(),
      signal,
      workdir,
    });
  }

  /**
   * URL scheme 白名单（安全关键，执行时校验，不依赖工具描述）：
   * 只放行 http/https。拒绝 file://（本地文件经渲染渗入产物，信息渗漏面）、
   * data:、ftp: 等其他 scheme——取证目标是可公开寻址的网页。
   */
  function validateUrl(raw: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
  }

  function invalidUrlReason(url: string): string {
    return `URL 仅支持 http:// 或 https://，拒绝 “${url.slice(0, 80)}”。本 shell 渲染网页取证，不接受本地文件或其他协议地址。`;
  }

  /** 失败分类改写（不透传裸错误；缺失资产附修复指引）。 */
  function classifyFailure(stderr: string): string {
    const s = stderr.trim();
    if (/backend entry missing/i.test(s)) {
      return `后端 playwright 包未安装或不可解析：属装配期人工动作，不在本 shell 动词表内。\n${PLAYWRIGHT_ENV_FIX_GUIDANCE}`;
    }
    if (/Executable doesn't exist/i.test(s)) {
      return `浏览器资产缺失或与后端版本不匹配。\n${PLAYWRIGHT_ENV_FIX_GUIDANCE}`;
    }
    if (/PDF creation is only working with Chromium/i.test(s)) {
      return 'pdf 仅支持 Chromium 后端：当前浏览器资产不含可用 Chromium，先运行 env 检查资产。';
    }
    const nav = s.match(/net::(ERR_[A-Z_]+)/);
    if (nav) {
      return `网页访问失败（${nav[1]}）：URL 不可达或被拒。检查 URL 与网络后重试。`;
    }
    return '后端渲染失败（退出码非 0）。';
  }

  function failureReport(verb: string, reason: string, stderr: string): string {
    return [
      `failed ${verb}`,
      reason,
      'detail: ' + (stderr.trim().slice(0, MAX_STDERR_CHARS) || '(无 stderr)'),
    ].join('\n');
  }

  function terminatedReport(verb: string, run: BackendRunResult): string {
    return [
      `terminated ${verb}`,
      '渲染被终止（超时或用户打断），浏览器子进程已随进程组回收。',
      run.stdout.trim() ? `partial stdout: ${run.stdout.trim().slice(0, MAX_STDERR_CHARS)}` : '',
    ].filter(Boolean).join('\n');
  }

  /** 产物动词成功报文：路径 + 字节数等元数据，不回灌大块输出。 */
  async function artifactReport(verb: string, url: string, absPath: string, givenPath: string, extraFlags: string[]): Promise<string> {
    const bytes = await fileSize(absPath);
    if (bytes < 0) {
      throw new Error(failureReport(verb, '产物文件未写出（后端异常退出）', ''));
    }
    const lines = [
      `${verb} ok`,
      `url: ${url}`,
      `saved: ${givenPath}`,
      `bytes: ${bytes}`,
    ];
    if (extraFlags.includes('--full-page')) lines.push('fullPage: true');
    return lines.join('\n');
  }

  // ------------------------------------------------------------ 产物动词

  async function renderVerb(sub: 'screenshot' | 'pdf', args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    const { positional, tailFlags } = stripTailFlags(args, ['--full-page']);
    const [url, output] = positional;
    if (!validateUrl(url)) {
      throw new Error(failureReport(sub, invalidUrlReason(url), ''));
    }
    const absOut = await ensureOutputPath(output);
    const run = await spawnBackend([sub, url, absOut, ...tailFlags], context?.signal);
    if (run.terminated) return terminatedReport(sub, run);
    if (!run.ok) throw new Error(failureReport(sub, classifyFailure(run.stderr), run.stderr));
    return artifactReport(sub, url, absOut, output, tailFlags);
  }

  async function harVerb(args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    const { positional } = stripTailFlags(args, []);
    const [url, output] = positional;
    if (!validateUrl(url)) {
      throw new Error(failureReport('har', invalidUrlReason(url), ''));
    }
    const absHar = await ensureOutputPath(output);
    const sidePng = `${absHar}.png`;
    // 侧产物 PNG 与 HAR 同目录（workspace 内，参数道已保证边界）。
    const argv = ['screenshot', '--save-har', absHar, url, sidePng];
    const run = await spawnBackend(argv, context?.signal);
    if (run.terminated) return terminatedReport('har', run);
    if (!run.ok) throw new Error(failureReport('har', classifyFailure(run.stderr), run.stderr));
    const harBytes = await fileSize(absHar);
    if (harBytes < 0) throw new Error(failureReport('har', '产物文件未写出（后端异常退出）', run.stderr));
    const pngBytes = await fileSize(sidePng);
    return [
      'har ok',
      `url: ${url}`,
      `saved: ${output}`,
      `bytes: ${harBytes}`,
      `side artifact: ${output}.png（${pngBytes < 0 ? '缺失' : `${pngBytes} bytes`}，viewport 截图）`,
    ].join('\n');
  }

  // ------------------------------------------------------- 会话后端（v2）

  /**
   * 会话后端入口（@playwright/cli 的 playwright-cli.js）。双后端架构：
   * one-shot 产物动词走 playwright one-shot CLI；会话动词转发官方
   * daemon 子命令（open 时官方 CLI 自动起 daemon，跨调用共享页面）。
   * daemon 进程由官方 CLI 管理（detached），本 shell 只转发命令；
   * 收尾防线 = close 动词 + feature onDestroy 兜底（见 feature 文件）。
   */
  function resolveSessionCliEntry(): string | null {
    if (deps.sessionCliEntry) return deps.sessionCliEntry;
    try {
      const here = createRequire(__filename);
      const pkgJson = here.resolve('@playwright/cli/package.json');
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { bin?: Record<string, string> | string };
      const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['playwright-cli'];
      if (!binRel) return null;
      const candidate = join(dirname(pkgJson), binRel);
      return existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  /** 会话动词失败分类（daemon 转发命令的 stderr 语义与 one-shot 不同）。 */
  function classifySessionFailure(stderr: string, _stdout = ''): string {
    if (/Executable doesn't exist/i.test(stderr)) {
      return '浏览器资产缺失（会话后端同用自管资产目录）。' + PLAYWRIGHT_ENV_FIX_GUIDANCE;
    }
    if (/not open/i.test(stderr)) {
      return '当前没有已开启的会话：先运行 open 启动会话。';
    }
    if (/net::ERR_|ECONNREFUSED|ENOTFOUND/i.test(stderr)) {
      return `网页访问失败（${firstLine(stderr)}）。检查 URL 与网络后重试。`;
    }
    return firstLine(stderr || '会话命令失败（无诊断输出）');
  }

  /** 首行摘录（失败报文用）。 */
  function firstLine(text: string): string {
    const line = (text || '').split('\n').find((l) => l.trim().length > 0) ?? '';
    return line.slice(0, MAX_STDERR_CHARS);
  }

  /** 会话动词转发：spawn 官方 CLI 子命令，输出直接回模型（### Page / ### Snapshot 结构化文本）。 */
  async function forwardSessionVerb(verb: string, args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    const entry = resolveSessionCliEntry();
    if (!entry) {
      throw new Error(
        `failed ${verb}\n会话后端缺失：@playwright/cli npm 包未安装，属装配期人工动作。` +
        '由人工在运行环境安装后重试（步骤见技能 playwright-shell「故障处置」）。',
      );
    }
    const run = await spawnImpl(process.execPath, [entry, verb, ...args], {
      signal: context?.signal,
      workdir,
      env: backendEnv(),
    });
    if (run.terminated) {
      return `terminated ${verb}\n命令被终止（超时或用户打断）；会话浏览器进程独立存活，可重试或用 close 收尾。\npartial stdout: ${firstLine(run.stdout)}`;
    }
    const output = `${run.stdout}${run.stderr ? `\n${run.stderr}` : ''}`.trim();
    if (!run.ok) {
      // close 幂等：未开会话的 close 以 ok 收尾（生命周期收尾不报错）
      if (verb === 'close') {
        return 'close ok（当前没有已开启的会话，无需收尾）';
      }
      throw new Error(`failed ${verb}\n${classifySessionFailure(run.stderr, run.stdout)}`);
    }
    return output || `${verb} ok`;
  }

  async function openVerb(args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    // open 的 flags（--headed / --browser=chrome）已在参数道剥离校验，
    // 透传给官方 CLI；URL 同产物动词的 scheme 校验。
    const { positional, tailFlags } = stripTailFlags(args, ['--headed', '--browser=']);
    const [url] = positional;
    if (!validateUrl(url)) {
      throw new Error(failureReport('open', invalidUrlReason(url), ''));
    }
    if (tailFlags.includes('--headed') && !process.env.DISPLAY) {
      return [
        'open 失败',
        'headed 模式需要显示环境：当前进程 DISPLAY 未设置。',
        '两条路径：(1) 宿主有桌面环境时在带 DISPLAY 的环境运行 agent；',
        '(2) 无桌面服务器由人工用 xvfb-run 包裹（虚拟显示，窗口无人观看，仅用于兼容站点检测或人工接管）。',
        'headless（默认）不受影响，绝大多数取证与会话任务无需 --headed。',
      ].join('\n');
    }
    const entry = resolveSessionCliEntry();
    if (!entry) {
      throw new Error(
        'failed open\n会话后端缺失：@playwright/cli npm 包未安装，属装配期人工动作，' +
        '由人工在运行环境安装后重试（步骤见技能 playwright-shell「故障处置」）。',
      );
    }
    const run = await spawnImpl(process.execPath, [entry, 'open', url, ...tailFlags], {
      signal: context?.signal,
      workdir,
      env: backendEnv(),
    });
    if (run.terminated) return terminatedReport('open', run);
    if (!run.ok) throw new Error(failureReport('open', classifySessionFailure(run.stderr), run.stderr));
    return run.stdout.trim();
  }

  return {
    'playwright:env': () => envVerb(),
    'playwright:screenshot': (args, context) => renderVerb('screenshot', args, context),
    'playwright:pdf': (args, context) => renderVerb('pdf', args, context),
    'playwright:har': (args, context) => harVerb(args, context),
    // 会话动词 v2：转发 @playwright/cli daemon 子命令（官方自动管理 daemon 生命周期）
    'playwright:open': (args, context) => openVerb(args, context),
    'playwright:goto': (args, context) => forwardSessionVerb('goto', args, context),
    'playwright:snapshot': (args, context) => forwardSessionVerb('snapshot', args, context),
    'playwright:find': (args, context) => forwardSessionVerb('find', args, context),
    'playwright:fill': (args, context) => forwardSessionVerb('fill', args, context),
    'playwright:press': (args, context) => forwardSessionVerb('press', args, context),
    'playwright:click': (args, context) => forwardSessionVerb('click', args, context),
    'playwright:tab-list': (args, context) => forwardSessionVerb('tab-list', args, context),
    'playwright:tab-select': (args, context) => forwardSessionVerb('tab-select', args, context),
    'playwright:close': (args, context) => forwardSessionVerb('close', args, context),
  };
}
