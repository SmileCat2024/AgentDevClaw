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
 *   结果），本 adapter 不自实现终止；
 * - --profile（--user-data-dir）渲染路径：后端 playwright one-shot CLI（stable
 *   正式版）在 --user-data-dir 路径存在收尾挂起（产物写出后 CLI 进程与
 *   浏览器均不退出，复现稳定），adapter 以「产物落盘稳定 → 宽限 → kill
 *   回收」补偿（spawnBackendWithSalvage），实测 kill 后浏览器 1s 内随
 *   pipe 断开自退、档案锁释放。
 *
 * 动词绑定模式与 coder 相同：分派层传参不含动词，adapter key 形如
 * `playwright:<verb>`，工厂按 key 绑定路由；策略声明的 argPrefix 未用
 * （基座类型契约中该字段当前未被分派层消费，本票核实后决定不补齐）。
 *
 * 报文契约：成功 = 路径 + 字节数等元数据，不回灌大块输出；失败 = 结构化
 * 原因 + 摘录 stderr（分类改写，不透传裸错误；资产缺失附修复指引）。
 */

import { mkdir, readdir, stat, realpath } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /** 浏览器资产目录（注入 PLAYWRIGHT_BROWSERS_PATH）；缺省 ~/.agentdev/AgentDevClaw/assets/playwright-shell/browsers */
  browsersPath?: string;
  /** 持久化登录档案根目录；缺省 ~/.agentdev/AgentDevClaw/playwright-shell/profiles */
  profilesPath?: string;
  /** 产物相对路径解析基准 + spawn cwd；缺省 process.cwd() */
  workdir?: string;
  /** 注入 spawn 实现（测试替身）；缺省用基座 runCollectedSpawn */
  spawnImpl?: SpawnLike;
  /** 产物落盘回收（--user-data-dir 渲染收尾挂起补偿）的采样间隔（毫秒）；测试注入用 */
  salvagePollMs?: number;
  /** 产物落盘稳定后给后端的完成宽限（毫秒）；测试注入用 */
  salvageGraceMs?: number;
}

/** 产物动词所需的浏览器资产（headless 渲染）。 */
const REQUIRED_BROWSER = 'chromium-headless-shell';
/** env 报文最多列出的浏览器行数（防 browsers.json 增条目撑爆报文）。 */
const MAX_BROWSER_LINES = 8;
/** 失败报文里 stderr 摘录上限（字符）。 */
const MAX_STDERR_CHARS = 500;
/** 每个档案记录的站点域名上限（防无限增长）。 */
const MAX_PROFILE_SITES = 20;
/** profile-list 报文里每个档案展示的站点数上限。 */
const MAX_PROFILE_SITES_SHOW = 5;
/** 产物动词带档案渲染失败时的占用提示（同一档案目录同时只能被一个浏览器使用）。 */
const PROFILE_OCCUPIED_HINT =
  'hint: 若该档案正被其他浏览器占用（例如未 close 的 open 会话），先 close 旧会话或换档案重试；同一档案同时只能被一个浏览器使用。';
/** 会话级 cookie 翻转持久化时写入的过期时间（从现在起算）。 */
const SALVAGE_EXPIRES_MILLISECONDS = 180 * 24 * 60 * 60 * 1000;
/** 产物落盘回收：产物字节数稳定判定采样间隔（毫秒）。 */
const ARTIFACT_SALVAGE_POLL_MS = 500;
/** 产物落盘回收：稳定后给后端自然退出的宽限（毫秒），逾期 kill 回收。 */
const ARTIFACT_SALVAGE_GRACE_MS = 15_000;
/** 回收成功报文附注（--user-data-dir 渲染收尾挂起被回收时）。 */
const ARTIFACT_SALVAGE_NOTE =
  'note: 后端渲染完成后收尾未退出（上游 CLI 已知问题，仅 --profile 渲染出现），产物完好，进程已回收。';
/** Chrome 时间纪元偏移（1601-01-01 → Unix 纪元，微秒），cookie 库 expires_utc 用。 */
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11644473600000000n;

/**
 * node:sqlite 最小面。@types/node 钉在 v20（无 sqlite 声明），运行时
 * Node ≥22.5 才有该模块——动态 import 探测，缺失时保活降级为提示。
 */
interface PwsCookieDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    all(): unknown[];
  };
  close(): void;
}

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

/**
 * 旧布局浏览器资产根迁移：历史版本直接放在 ~/.agentdev/assets/ 下（绕过
 * 数据根，AGENTDEV_DATA_DIR 隔离对它无效），收敛进数据根。新根已存在（迁移
 * 过/已安装）或旧根不存在时跳过；rename 失败（跨设备等）保持新根不动——
 * 缺浏览器时 env 动词给出安装指引，比静默回退旧布局更可诊断。
 */
export function migrateLegacyBrowsersRoot(nextRoot: string, legacyRoot: string): boolean {
  if (existsSync(nextRoot) || !existsSync(legacyRoot)) return false;
  try {
    mkdirSync(dirname(nextRoot), { recursive: true });
    renameSync(legacyRoot, nextRoot);
    return true;
  } catch {
    return false;
  }
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

  // 单会话模型：open --profile 记住当前档案，goto 顺势补充站点记录，close
  // 清空。daemon 会话异常死亡时下次 open 会覆盖，无需额外清理。
  let activeProfileName: string | null = null;

  // ----------------------------------------------------------- 路径与环境

  /** 缺省浏览器资产根的进程内缓存（迁移只做一次）。 */
  let defaultBrowsersRoot: string | null = null;

  function browsersPath(): string {
    if (deps.browsersPath) return expandDir(deps.browsersPath);
    if (!defaultBrowsersRoot) {
      defaultBrowsersRoot = join(homedir(), '.agentdev', 'AgentDevClaw', 'assets', 'playwright-shell', 'browsers');
      migrateLegacyBrowsersRoot(
        defaultBrowsersRoot,
        join(homedir(), '.agentdev', 'assets', 'playwright-shell', 'browsers'),
      );
    }
    return defaultBrowsersRoot;
  }

  /** 持久化登录档案根目录（open --profile 的名称解析到这里；产品数据与 prebuilt-sessions 同层）。 */
  function profilesRoot(): string {
    const configured = deps.profilesPath ?? join(homedir(), '.agentdev', 'AgentDevClaw', 'playwright-shell', 'profiles');
    return expandDir(configured);
  }

  /**
   * profile 名称白名单：字母/数字开头，仅含字母数字下划线连字符。
   * 名称会拼进档案目录路径，必须杜绝分隔符与 `..` 段（防路径穿越）。
   */
  function validateProfileName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
  }

  /** 档案关联站点记录文件（放档案目录内，随档案走；Chromium 忽略未知文件）。 */
  function profileSitesFile(profileDir: string): string {
    return join(profileDir, 'agentdev-sites.json');
  }

  /** 读取档案关联站点（缺失/损坏按空处理）。 */
  function readProfileSites(profileDir: string): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(profileSitesFile(profileDir), 'utf-8'));
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * 记录档案使用过的站点域名（最近在前，去重，限量）。profile-list 据此
   * 展示"档案 → 站点"，模型可自动匹配任务站点与档案。记录失败不影响主流程。
   */
  async function recordProfileSite(name: string, rawUrl: string): Promise<void> {
    let host: string;
    try {
      host = new URL(rawUrl).hostname;
    } catch {
      return;
    }
    if (!host) return;
    const sites = [host, ...readProfileSites(join(profilesRoot(), name)).filter((s) => s !== host)]
      .slice(0, MAX_PROFILE_SITES);
    try {
      writeFileSync(profileSitesFile(join(profilesRoot(), name)), JSON.stringify(sites, null, 2));
    } catch { /* 提示数据，写失败不阻塞导航 */ }
  }

  /** 档案 cookie 库的候选路径（新版在 Network/ 下，旧版直接在 Default/ 下）。 */
  function cookieDbCandidates(profileDir: string): string[] {
    return [
      join(profileDir, 'Default', 'Network', 'Cookies'),
      join(profileDir, 'Default', 'Cookies'),
    ];
  }

  /**
   * 会话级 cookie 保活：把档案 cookie 库中 is_persistent=0 的行翻转为持久化。
   *
   * 大量站点的登录票据是会话级 cookie（is_persistent=0，如阿里云 aliyunid
   * 票据族），Chromium 启动时会清掉这类行；实测 Preferences 的
   * restore_on_startup=1 在后端 CLI 的启动模式下不还原。因此在每次 open
   * 该档案、启动浏览器前做翻转——只改标志位与过期时间，cookie 值保持
   * Chromium 的 DPAPI 加密不动；浏览器与服务端对翻转后的票据照常接受
   * （阿里云真实登录实测）。必须在 spawn 前执行（浏览器运行期间持库锁）。
   *
   * 失败容忍：库不存在（新档案）跳过；被占用/损坏/缺 node:sqlite 时返回
   * error 由 open 报文附警告——只影响会话级登录态跨重启，不阻塞打开。
   */
  async function salvageSessionCookies(profileDir: string): Promise<{ flipped: number } | { error: string }> {
    const sqliteSpec = 'node:sqlite';
    const sqlite = (await import(sqliteSpec).catch(() => null)) as
      | { DatabaseSync: new (path: string) => PwsCookieDb }
      | null;
    if (!sqlite) return { error: '运行环境缺少 node:sqlite（需 Node 22.5+）' };
    const dbPath = cookieDbCandidates(profileDir).find((p) => existsSync(p));
    if (!dbPath) return { flipped: 0 }; // 新档案尚无 cookie 库，无需保活
    let db: PwsCookieDb;
    try {
      db = new sqlite.DatabaseSync(dbPath);
    } catch (reason) {
      return { error: `cookie 库不可打开（可能被占用或损坏）：${reason instanceof Error ? reason.message : String(reason)}` };
    }
    try {
      const columns = db.prepare("SELECT name FROM pragma_table_info('cookies')").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'is_persistent')) {
        return { error: 'cookie 库 schema 未知（缺少 is_persistent 列）' };
      }
      const expiresUtc = (BigInt(Date.now() + SALVAGE_EXPIRES_MILLISECONDS)) * 1000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
      const result = db.prepare('UPDATE cookies SET is_persistent = 1, expires_utc = ? WHERE is_persistent = 0').run(expiresUtc);
      return { flipped: Number(result.changes) };
    } catch (reason) {
      return { error: `cookie 库写入失败：${reason instanceof Error ? reason.message : String(reason)}` };
    } finally {
      db.close();
    }
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
    lines.push(`profiles dir: ${profilesRoot()}`);
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

  /**
   * 剥离尾部声明 flag（参数道已校验白名单，adapter 按声明自行剥离）。
   * 带 `=` 后缀的声明是赋值形态 flag（如 `--browser=`、`--profile=`），
   * 按「前缀 + 非空值」匹配——与参数道 args.ts 的剥离语义一致，
   * 保证带值 flag 真正转发后端而非混入位置参数被静默丢弃。
   */
  function stripTailFlags(args: string[], flags: string[]): { positional: string[]; tailFlags: string[] } {
    const positional = [...args];
    const tailFlags: string[] = [];
    while (positional.length > 0) {
      const last = positional[positional.length - 1];
      if (flags.includes(last)) {
        tailFlags.unshift(positional.pop() as string);
        continue;
      }
      const valued = flags.find((f) => f.endsWith('=') && last.startsWith(f) && last.length > f.length);
      if (valued) {
        tailFlags.unshift(positional.pop() as string);
        continue;
      }
      break;
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
   * 带「产物落盘回收」的渲染等待（--user-data-dir 路径专用）。
   *
   * 后端 playwright one-shot CLI（stable 正式版）的
   * launchPersistentContext（--user-data-dir）路径存在收尾挂起：产物写出后
   * CLI 进程与浏览器均不退出（多次复现；用 stable core 直跑等价调用序列
   * 无此问题，挂点在 CLI 自身流程）。实测单杀 CLI 进程后浏览器在 1s 内随
   * pipe 断开自退，档案锁随之释放。产物动词的成功凭证是产物文件本身，
   * 因此：并发盯产物字节数至稳定（连续两次采样一致）→ 给后端宽限窗口
   * 自然退出（区分正常慢渲染与挂死）→ 逾期仍未退出则 kill 回收，由调用
   * 方按产物存在报成功。外部中断（context.signal）优先于回收。
   */
  async function spawnBackendWithSalvage(
    artifactPath: string,
    argv: string[],
    salvage: boolean,
    context?: PlaywrightAdapterContext,
  ): Promise<{ run: BackendRunResult; salvaged: boolean }> {
    if (!salvage) {
      return { run: await spawnBackend(argv, context?.signal), salvaged: false };
    }
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    // 已 aborted 的信号不会再触发 abort 事件，须先置位（与基座 runCollectedSpawn 同款防御）
    if (context?.signal?.aborted) controller.abort();
    context?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let finished = false;
    let salvaged = false;
    const pollMs = deps.salvagePollMs ?? ARTIFACT_SALVAGE_POLL_MS;
    const graceMs = deps.salvageGraceMs ?? ARTIFACT_SALVAGE_GRACE_MS;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const runP = spawnBackend(argv, controller.signal);
      void (async () => {
        let last = -1;
        while (!controller.signal.aborted && !finished) {
          const cur = await fileSize(artifactPath);
          if (cur > 0 && cur === last) break;
          last = cur;
          await sleep(pollMs);
        }
        if (controller.signal.aborted || finished) return;
        await sleep(graceMs);
        if (controller.signal.aborted || finished) return;
        salvaged = true;
        controller.abort();
      })();
      return { run: await runP, salvaged };
    } finally {
      finished = true;
      context?.signal?.removeEventListener('abort', onOuterAbort);
    }
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

  /**
   * 产物动词渲染参数值校验（执行时校验，与 URL 白名单同模式）：
   * - viewport-size："宽,高" 像素（如 1280,720；手机/宽屏取证）
   * - color-scheme：light | dark（暗色页取证）
   * - wait-for-timeout：毫秒（页面渲染等待——懒加载/动画场景截图空白；这是
   *   渲染等待不是工具超时，上限 10s，更长等待应改用 open 会话确认后截取）
   * - paper-format：纸型枚举（仅 pdf；CLI 缺省 Letter，国内场景常要 A4）
   * - ignore-https-errors：布尔（自签证书内网站点），无需值校验
   */
  const RENDER_FLAG_SPECS: Array<{
    prefix: string;
    verbs: string[];
    validate: (v: string) => string | null;
  }> = [
    {
      prefix: '--viewport-size=',
      verbs: ['screenshot', 'pdf', 'har'],
      validate: (v) => (/^\d{2,5},\d{2,5}$/.test(v) ? null : `viewport-size 值应为 "宽,高" 像素（如 1280,720），拒绝 “${v.slice(0, 30)}”。`),
    },
    {
      prefix: '--color-scheme=',
      verbs: ['screenshot', 'pdf', 'har'],
      validate: (v) => (v === 'light' || v === 'dark' ? null : `color-scheme 只接受 light 或 dark，拒绝 “${v.slice(0, 30)}”。`),
    },
    {
      prefix: '--wait-for-timeout=',
      verbs: ['screenshot', 'pdf', 'har'],
      validate: (v) => (/^\d{1,5}$/.test(v) && Number(v) <= 10000
        ? null
        : `wait-for-timeout 值应为不超过 10000 的毫秒数（页面渲染等待；更长等待用 open 会话），拒绝 “${v.slice(0, 30)}”。`),
    },
    {
      prefix: '--paper-format=',
      verbs: ['pdf'],
      validate: (v) => (/^(letter|legal|tabloid|ledger|a[0-6])$/i.test(v)
        ? null
        : `paper-format 只接受 Letter/Legal/Tabloid/Ledger/A0-A6，拒绝 “${v.slice(0, 30)}”。`),
    },
  ];

  /** 校验产物动词尾参（返回 null = 通过；返回文案 = 拒绝原因）。 */
  function validateRenderFlags(verb: string, tailFlags: string[]): string | null {
    for (const f of tailFlags) {
      for (const spec of RENDER_FLAG_SPECS) {
        if (!f.startsWith(spec.prefix)) continue;
        if (!spec.verbs.includes(verb)) return `${spec.prefix} 不适用于 ${verb} 动词。`;
        const reason = spec.validate(f.slice(spec.prefix.length));
        if (reason) return reason;
      }
    }
    return null;
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

  /**
   * `--profile=<名称>` 尾参的统一解析（open 会话动词与 screenshot/pdf/har 产物
   * 动词共用）：名称白名单校验 → 档案根下目录（缺即创建）→ 会话级 cookie 保活
   * （产物动词同样需要：不翻转则本次启动就丢会话级登录票据）。保活失败不阻塞，
   * 以警告随报文透出。
   */
  async function resolveProfileDir(verb: string, name: string): Promise<{ name: string; dir: string; warnings: string[] }> {
    if (!validateProfileName(name)) {
      throw new Error(failureReport(
        verb,
        `profile 名称不合法：“${name.slice(0, 40) || '(空)'}”。`
        + '只允许字母或数字开头，随后是字母/数字/下划线/连字符，总长 1-64（名称即档案目录名）。',
        '',
      ));
    }
    const dir = join(profilesRoot(), name);
    await mkdir(dir, { recursive: true });
    const warnings: string[] = [];
    const salvage = await salvageSessionCookies(dir);
    if ('error' in salvage) {
      warnings.push(`warn: 会话级 cookie 保活跳过（${salvage.error}）；依赖会话级 cookie 的登录态跨重启可能失效。`);
    }
    return { name, dir, warnings };
  }

  async function renderVerb(sub: 'screenshot' | 'pdf', args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    const { positional, tailFlags } = stripTailFlags(args, [
      '--full-page', '--ignore-https-errors', '--profile=',
      '--viewport-size=', '--color-scheme=', '--wait-for-timeout=', '--paper-format=',
    ]);
    const [url, output] = positional;
    if (!validateUrl(url)) {
      throw new Error(failureReport(sub, invalidUrlReason(url), ''));
    }
    const flagReason = validateRenderFlags(sub, tailFlags);
    if (flagReason !== null) {
      throw new Error(failureReport(sub, flagReason, ''));
    }
    const absOut = await ensureOutputPath(output);
    // --profile=<名称>：以持久化登录档案渲染。后端 one-shot CLI 的用户数据目录
    // 语义与 open 的档案一致（同一档案空间），登录态跨渲染留存。
    const profileArg = tailFlags.find((f) => f.startsWith('--profile='));
    let profile: Awaited<ReturnType<typeof resolveProfileDir>> | null = null;
    if (profileArg !== undefined) {
      profile = await resolveProfileDir(sub, profileArg.slice('--profile='.length));
    }
    const backendFlags = tailFlags
      .filter((f) => !f.startsWith('--profile='))
      .concat(profile ? [`--user-data-dir=${profile.dir}`] : []);
    const { run, salvaged } = await spawnBackendWithSalvage(
      absOut, [sub, url, absOut, ...backendFlags], profile !== null, context,
    );
    const successReport = async (extra = ''): Promise<string> => {
      if (profile) await recordProfileSite(profile.name, url);
      return (await artifactReport(sub, url, absOut, output, backendFlags))
        + (profile ? `\nprofile: ${profile.name}` : '')
        + (profile && profile.warnings.length > 0 ? `\n${profile.warnings.join('\n')}` : '')
        + extra;
    };
    if (run.terminated) {
      // 回收触发且产物已落盘：按成功报文（附回收说明）；否则保持终止语义（外部中断）。
      if (salvaged && (await fileSize(absOut)) >= 0) return successReport(`\n${ARTIFACT_SALVAGE_NOTE}`);
      return terminatedReport(sub, run);
    }
    if (!run.ok) {
      const report = failureReport(sub, classifyFailure(run.stderr), run.stderr);
      throw new Error(profile ? `${report}\n${PROFILE_OCCUPIED_HINT}` : report);
    }
    return successReport();
  }

  async function harVerb(args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    const { positional, tailFlags } = stripTailFlags(args, [
      '--ignore-https-errors', '--profile=',
      '--viewport-size=', '--color-scheme=', '--wait-for-timeout=',
    ]);
    const [url, output] = positional;
    if (!validateUrl(url)) {
      throw new Error(failureReport('har', invalidUrlReason(url), ''));
    }
    const flagReason = validateRenderFlags('har', tailFlags);
    if (flagReason !== null) {
      throw new Error(failureReport('har', flagReason, ''));
    }
    const absHar = await ensureOutputPath(output);
    const sidePng = `${absHar}.png`;
    // 侧产物 PNG 与 HAR 同目录（workspace 内，参数道已保证边界）。
    const profileArg = tailFlags.find((f) => f.startsWith('--profile='));
    let profile: Awaited<ReturnType<typeof resolveProfileDir>> | null = null;
    if (profileArg !== undefined) {
      profile = await resolveProfileDir('har', profileArg.slice('--profile='.length));
    }
    const argv = ['screenshot', '--save-har', absHar, url, sidePng]
      .concat(profile ? [`--user-data-dir=${profile.dir}`] : []);
    const { run, salvaged } = await spawnBackendWithSalvage(absHar, argv, profile !== null, context);
    const successReport = async (): Promise<string> => {
      if (profile) await recordProfileSite(profile.name, url);
      const harBytes = await fileSize(absHar);
      const pngBytes = await fileSize(sidePng);
      return [
        'har ok',
        `url: ${url}`,
        `saved: ${output}`,
        `bytes: ${harBytes}`,
        `side artifact: ${output}.png（${pngBytes < 0 ? '缺失' : `${pngBytes} bytes`}，viewport 截图）`,
        ...(profile ? [`profile: ${profile.name}`, ...profile.warnings] : []),
      ].join('\n');
    };
    if (run.terminated) {
      // HAR 在 context 收尾阶段落盘：挂起若发生在其写出前则无产物，如实报终止。
      if (salvaged && (await fileSize(absHar)) >= 0) return `${await successReport()}\n${ARTIFACT_SALVAGE_NOTE}`;
      return terminatedReport('har', run);
    }
    if (!run.ok) {
      const report = failureReport('har', classifyFailure(run.stderr), run.stderr);
      throw new Error(profile ? `${report}\n${PROFILE_OCCUPIED_HINT}` : report);
    }
    const harReady = (await fileSize(absHar)) >= 0;
    if (!harReady) throw new Error(failureReport('har', '产物文件未写出（后端异常退出）', run.stderr));
    return successReport();
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

  /** 会话动词转发：spawn 官方 CLI 子命令，输出直接回模型（### Page / ### Snapshot 结构化文本）。
   *  cliSub：动词名与 CLI 子命令不一致时显式指定（如 capture → screenshot）。 */
  async function forwardSessionVerb(verb: string, args: string[], context?: PlaywrightAdapterContext, cliSub?: string): Promise<string> {
    if (verb === 'close') activeProfileName = null;
    if (verb === 'goto' || verb === 'tab-new') {
      if (!validateUrl(args[0])) {
        throw new Error(failureReport(verb, invalidUrlReason(args[0] ?? ''), ''));
      }
    }
    if (verb === 'resize' && (!/^\d{2,5}$/.test(args[0] ?? '') || !/^\d{2,5}$/.test(args[1] ?? ''))) {
      throw new Error(failureReport(verb, `resize 参数应为两个 2-5 位像素数（如 resize 1280 720），拒绝 “${(args ?? []).join(' ').slice(0, 40)}”。`, ''));
    }
    if ((verb === 'tab-close' || verb === 'request') && !/^\d+$/.test(args[0] ?? '')) {
      throw new Error(failureReport(verb, `${verb} 参数应为数字编号（来自 tab-list / requests 输出），拒绝 “${(args[0] ?? '').slice(0, 30)}”。`, ''));
    }
    const entry = resolveSessionCliEntry();
    if (!entry) {
      throw new Error(
        `failed ${verb}\n会话后端缺失：@playwright/cli npm 包未安装，属装配期人工动作。` +
        '由人工在运行环境安装后重试（步骤见技能 playwright-shell「故障处置」）。',
      );
    }
    const run = await spawnImpl(process.execPath, [entry, cliSub ?? verb, ...args], {
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
    if ((verb === 'goto' || verb === 'tab-new') && activeProfileName) await recordProfileSite(activeProfileName, args[0]);
    return output || `${verb} ok`;
  }

  function hasHeadedDisplay(): boolean {
    // Windows/macOS 的桌面浏览器不使用 Linux 的 DISPLAY 约定。
    return process.platform === 'win32'
      || process.platform === 'darwin'
      || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }

  async function openVerb(args: string[], context?: PlaywrightAdapterContext): Promise<string> {
    // open 的 flags（--headed / --browser=chrome / --profile=name）已在参数道
    // 剥离校验，透传给官方 CLI；URL 同产物动词的 scheme 校验。
    const { positional, tailFlags } = stripTailFlags(args, ['--headed', '--browser=', '--profile=']);
    const [url] = positional;
    if (!validateUrl(url)) {
      throw new Error(failureReport('open', invalidUrlReason(url), ''));
    }
    if (tailFlags.includes('--headed') && !hasHeadedDisplay()) {
      return [
        'open 失败',
        'headed 模式需要显示环境：当前进程没有可用的桌面显示。',
        'Windows/macOS 桌面会自动使用系统显示；Linux 请在带 DISPLAY 或 WAYLAND_DISPLAY 的环境运行 agent；',
        '无桌面 Linux 服务器可由人工用 xvfb-run 包裹（虚拟显示，窗口无人观看，仅用于兼容站点检测或人工接管）。',
        'headless（默认）不受影响，绝大多数取证与会话任务无需 --headed。',
      ].join('\n');
    }
    // --profile=<名称>：持久化登录档案，与产物动词共用同一解析（白名单校验 +
    // 档案目录创建 + 会话级 cookie 保活，见 resolveProfileDir）。open 以绝对
    // 目录转发会话后端的 --profile；产物动词侧转发为 one-shot CLI 的
    // --user-data-dir（同一目录，同一登录态）。
    let profileFlag: string | null = null;
    let profileName: string | null = null;
    const openWarnings: string[] = [];
    const profileArg = tailFlags.find((f) => f.startsWith('--profile='));
    if (profileArg !== undefined) {
      const resolved = await resolveProfileDir('open', profileArg.slice('--profile='.length));
      openWarnings.push(...resolved.warnings);
      profileName = resolved.name;
      profileFlag = `--profile=${resolved.dir}`;
    }
    const passFlags = tailFlags.filter((f) => !f.startsWith('--profile='));
    const entry = resolveSessionCliEntry();
    if (!entry) {
      throw new Error(
        'failed open\n会话后端缺失：@playwright/cli npm 包未安装，属装配期人工动作，' +
        '由人工在运行环境安装后重试（步骤见技能 playwright-shell「故障处置」）。',
      );
    }
    const argv = [entry, 'open', url, ...passFlags];
    if (profileFlag) argv.push(profileFlag);
    const run = await spawnImpl(process.execPath, argv, {
      signal: context?.signal,
      workdir,
      env: backendEnv(),
    });
    if (run.terminated) return terminatedReport('open', run);
    if (!run.ok) throw new Error(failureReport('open', classifySessionFailure(run.stderr), run.stderr));
    if (profileName) {
      activeProfileName = profileName;
      await recordProfileSite(profileName, url);
    }
    return [run.stdout.trim(), ...openWarnings].filter(Boolean).join('\n');
  }

  /** profile-list：列出档案根目录下已创建的持久化登录档案（只读，不 spawn 后端）。 */
  async function profileListVerb(): Promise<string> {
    const root = profilesRoot();
    let names: string[] = [];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      // 根目录不存在 = 还没有任何档案，走空态报文
    }
    const lines = [`profile-list ok`, `profiles dir: ${root}`];
    if (names.length === 0) {
      lines.push('profiles: (空)');
      lines.push(`用法：open '<url>' --profile=<名称> 创建并使用持久化登录档案（首次可加 --headed 人工登录）`);
    } else {
      lines.push(`profiles (${names.length})（→ 后为该档案用过的站点，可据此匹配任务站点）:`);
      for (const name of names) {
        const sites = readProfileSites(join(root, name));
        lines.push(sites.length > 0
          ? `  ${name} → ${sites.slice(0, MAX_PROFILE_SITES_SHOW).join(', ')}`
          : `  ${name}`);
      }
    }
    return lines.join('\n');
  }

  return {
    'playwright:env': () => envVerb(),
    'playwright:screenshot': (args, context) => renderVerb('screenshot', args, context),
    'playwright:pdf': (args, context) => renderVerb('pdf', args, context),
    'playwright:har': (args, context) => harVerb(args, context),
    // 会话动词 v2：转发 @playwright/cli daemon 子命令（官方自动管理 daemon 生命周期）
    'playwright:open': (args, context) => openVerb(args, context),
    'playwright:profile-list': () => profileListVerb(),
    'playwright:goto': (args, context) => forwardSessionVerb('goto', args, context),
    'playwright:snapshot': (args, context) => forwardSessionVerb('snapshot', args, context),
    'playwright:find': (args, context) => forwardSessionVerb('find', args, context),
    'playwright:fill': (args, context) => forwardSessionVerb('fill', args, context),
    'playwright:press': (args, context) => forwardSessionVerb('press', args, context),
    'playwright:click': (args, context) => forwardSessionVerb('click', args, context),
    'playwright:hover': (args, context) => forwardSessionVerb('hover', args, context),
    'playwright:select': (args, context) => forwardSessionVerb('select', args, context),
    'playwright:go-back': (args, context) => forwardSessionVerb('go-back', args, context),
    'playwright:go-forward': (args, context) => forwardSessionVerb('go-forward', args, context),
    'playwright:reload': (args, context) => forwardSessionVerb('reload', args, context),
    'playwright:tab-list': (args, context) => forwardSessionVerb('tab-list', args, context),
    'playwright:tab-select': (args, context) => forwardSessionVerb('tab-select', args, context),
    'playwright:tab-new': (args, context) => forwardSessionVerb('tab-new', args, context),
    'playwright:tab-close': (args, context) => forwardSessionVerb('tab-close', args, context),
    'playwright:resize': (args, context) => forwardSessionVerb('resize', args, context),
    'playwright:capture': (args, context) => forwardSessionVerb('capture', args, context, 'screenshot'),
    'playwright:requests': (args, context) => forwardSessionVerb('requests', args, context),
    'playwright:request': (args, context) => forwardSessionVerb('request', args, context),
    'playwright:console': (args, context) => forwardSessionVerb('console', args, context),
    'playwright:dialog-accept': (args, context) => forwardSessionVerb('dialog-accept', args, context),
    'playwright:dialog-dismiss': (args, context) => forwardSessionVerb('dialog-dismiss', args, context),
    'playwright:cookie-list': (args, context) => forwardSessionVerb('cookie-list', args, context),
    'playwright:close': (args, context) => forwardSessionVerb('close', args, context),
  };
}
