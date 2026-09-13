/**
 * playwright 领域 shell 测试（ticket 036）
 *
 * 覆盖简报 §5 验收要点：
 * - 动词表恰为 4 个（env/screenshot/pdf/har），交互/会话/安装类动词不入表且报文附结构化指引
 * - help 从策略声明生成；参数校验（产物路径 workspace 边界、flag 剥离、URL 引号纪律）
 * - adapter 行为（spawn 注入替身）：argv 契约、env 注入、产物报文 = 路径 + 字节数
 * - 失败分类改写：后端缺失 / 浏览器资产缺失 / 导航失败，不透传裸错误
 * - 终止语义：abort → terminated 报文；真实浏览器整组回收无残留（需资产，缺失自动跳过）
 *
 * spawn 全部注入替身（无真实网络与浏览器）；真实端到端块由
 * PLAYWRIGHT_SHELL_E2E_BROWSERS 环境变量放行（指向浏览器注册目录）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { checkArgs } from '../src/args.js';
import { createPlaywrightShellPolicy, PLAYWRIGHT_ENV_FIX_GUIDANCE } from '../src/playwright/playwright-policy.js';
import type { ShellSegment } from '../src/types.js';
import { createPlaywrightAdapters, migrateLegacyBrowsersRoot } from '../src/playwright/playwright-shell.js';
import { createCapabilityShellTool, runCapabilityShellPipeline } from '../src/tool-factory.js';
import type { SpawnLike } from '../src/playwright/playwright-shell.js';
import type { AdapterMap } from '../src/dispatch.js';

const POLICY = createPlaywrightShellPolicy();

// ---------------------------------------------------------------- fixtures

/** fixture：tmp 目录拼一个最小 playwright 包根 + 浏览器资产布局。 */
function makeFixture(opts: { version?: string; withAssets?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pws-fx-'));
  const packageRoot = join(root, 'pkg', 'playwright');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.63.0' }));
  writeFileSync(join(packageRoot, 'cli.js'), '// stub entry');
  // browsers.json 候选位之一：<dirname(packageRoot)>/playwright-core/browsers.json
  mkdirSync(join(root, 'pkg', 'playwright-core'), { recursive: true });
  writeFileSync(
    join(root, 'pkg', 'playwright-core', 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: '9999', installByDefault: true },
        { name: 'chromium-headless-shell', revision: '9999', installByDefault: true },
        { name: 'firefox', revision: '8888', installByDefault: true },
      ],
    }),
  );
  const browsersDir = join(root, 'browsers');
  mkdirSync(browsersDir, { recursive: true });
  if (opts.withAssets !== false) {
    for (const dir of ['chromium-9999', 'chromium_headless_shell-9999']) {
      mkdirSync(join(browsersDir, dir), { recursive: true });
    }
  }
  return { root, packageRoot, cliEntry: join(packageRoot, 'cli.js'), browsersDir };
}

/** 可编程 spawn 替身：记录 argv/env，按预设行为回应（成功/失败/挂起到 abort）。 */
interface RecordedCall { argv: string[]; env: Record<string, string>; workdir?: string }

function stubSpawn(behavior: {
  exitCode?: number;
  stderr?: string;
  artifactBytes?: number;
  throwEnoent?: boolean;
  hangUntilAbort?: boolean;
} = {}) {
  const calls: RecordedCall[] = [];
  const spawn: SpawnLike = async (_command, args, options) => {
    calls.push({ argv: [_command, ...args], env: options.env ?? {}, workdir: options.workdir });
    if (behavior.throwEnoent) {
      return { ok: false, stdout: '', stderr: 'Error: spawn node ENOENT', exitCode: null, terminated: false };
    }
    if (behavior.hangUntilAbort) {
      const signal = options.signal;
      if (!signal || signal.aborted) return { ok: false, stdout: '', stderr: '', exitCode: null, terminated: true };
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, stdout: 'Navigating to ...', stderr: '', exitCode: null, terminated: true };
    }
    const outArg = [...args].reverse().find((a) => a.startsWith('/') && !a.endsWith('.js'));
    if (outArg && behavior.artifactBytes !== undefined) {
      writeFileSync(outArg, Buffer.alloc(behavior.artifactBytes, 7));
    }
    const ok = (behavior.exitCode ?? 0) === 0;
    return { ok, stdout: 'Navigating to ...\nCapturing screenshot into ...', stderr: behavior.stderr ?? '', exitCode: ok ? 0 : 1, terminated: false };
  };
  return { spawn, calls };
}

/** 用 playwright_shell 策略跑完整管线（bashPath null 降级，结构道兜底）。 */
async function run(command: string, opts: { adapters?: AdapterMap; signal?: AbortSignal } = {}) {
  return runCapabilityShellPipeline(POLICY, command, {
    adapters: opts.adapters,
    bashPath: null,
    signal: opts.signal,
  });
}

// ---------------------------------------------------------------- 动词表

describe('playwright_shell 动词表（ticket 036）', () => {
  it('动词表 = 4 产物动词 + 10 会话动词 + profile-list', () => {
    assert.deepEqual(Object.keys(POLICY.verbs).sort(), [
      'click', 'close', 'env', 'fill', 'find', 'goto', 'har',
      'open', 'pdf', 'press', 'profile-list', 'screenshot', 'snapshot', 'tab-list', 'tab-select',
    ]);
  });

  it('open 声明 --headed/--browser=/--profile= 三 flags；click/fill 参数为 ref 形态', () => {
    assert.deepEqual(POLICY.verbs['open'].flags, ['--headed', '--browser=', '--profile=']);
    assert.deepEqual(POLICY.verbs['click'].params.map((p) => p.kind), ['ref']);
    assert.equal(POLICY.verbs['fill'].params[0].kind, 'ref');
    assert.deepEqual(POLICY.verbs['press'].params[0].enum,
      ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
  });

  it('help 不占动词表（管线级）', () => {
    assert.ok(!('help' in POLICY.verbs));
  });

  it('工具未声明 parallelizable（渲染开销大，默认串行）', () => {
    const tool = createCapabilityShellTool(POLICY, {}, { bashPath: null });
    assert.ok(!tool.parallelizable, '未声明 parallelizable 时工具应为串行（基座默认）');
  });

  it('help 从策略声明生成：动词 + usage 齐备（模型可自我发现动词面）', async () => {
    const r = await run('help');
    assert.equal(r.ok, true);
    for (const fragment of ['playwright_shell', 'env', 'screenshot', 'pdf', 'har', '--full-page', "screenshot '<url>' <output.png>"]) {
      assert.ok(r.output.includes(fragment), `help 缺 fragment: ${fragment}\n---\n${r.output}`);
    }
    assert.ok(r.output.includes('拒绝'), 'help 应说明语法白名单边界');
  });

  it('URL 含 & 被结构道确定拒绝（已知基座边界，另票放宽）', async () => {
    const r = await run("screenshot 'https://x.com/search?q=a&lang=en' out.png");
    assert.equal(r.ok, false);
    assert.equal(r.rejection?.code, 'structure_rejected');
    assert.ok(r.output.includes('&'), r.output);
  });

  it('引号内 URL 的 ? # ; 是字面量，通过结构道', async () => {
    for (const url of ["'https://x.com/p?a=1'", "'https://x.com/p#top'", "'https://x.com/a;b'"]) {
      const r = await run(`screenshot ${url} out.png`);
      assert.notEqual(r.rejection?.code, 'structure_rejected', `应过结构道: ${url} → ${r.output}`);
      assert.notEqual(r.rejection?.code, 'unknown_verb', `应过动词道: ${url}`);
    }
  });
});

// ------------------------------------------------- 交互/安装类动词拒绝

describe('playwright_shell unknownVerbHints（交互/安装类不入表）', () => {
  for (const verb of ['codegen', 'eval', 'run-code', 'state-save', 'route', 'install', 'install-deps', 'uninstall', 'test', 'show-trace', 'show-report', 'mcp', 'cli']) {
    it(`被拒并附结构化指引: ${verb}`, async () => {
      const r = await run(verb);
      assert.equal(r.ok, false, `${verb} 应拒绝`);
      assert.equal(r.rejection?.code, 'unknown_verb');
      assert.ok(r.output.includes('可用动词'), r.output);
    });
  }

  it('install 指引明确指向人工装配路径（env 前置探测，不在 shell 内执行）', async () => {
    const r = await run('install');
    assert.ok(r.output.includes('env'), '指引应引导先运行 env');
    assert.ok(r.output.includes('人工'), r.output);
  });
});

// ------------------------------------------------- 参数校验

describe('playwright_shell 参数校验', () => {
  it('screenshot 缺产物路径 → arg_rejected（文案含用法）', async () => {
    const r = await run("screenshot 'https://example.com'");
    assert.equal(r.rejection?.code, 'arg_rejected');
    assert.ok(r.output.includes('screenshot'), r.output);
    assert.ok(r.output.includes('output'), r.output);
  });

  it('未声明的尾部 flag 被按位置参数拒绝（时间 flag 不进动词表）', async () => {
    const r = await run("screenshot 'https://example.com' out.png --wait-for-timeout");
    assert.equal(r.rejection?.code, 'arg_rejected');
  });

  it('产物路径绝对路径 / .. 逃逸 → arg_rejected', async () => {
    for (const cmd of ["screenshot 'https://example.com' /tmp/abs.png", "screenshot 'https://example.com' ../escape.png"]) {
      const r = await run(cmd);
      assert.equal(r.rejection?.code, 'arg_rejected', `应拒绝: ${cmd} → ${r.output}`);
    }
  });

  it('env 不接受位置参数', async () => {
    const r = await run('env verbose');
    assert.equal(r.rejection?.code, 'arg_rejected');
  });
});

// ------------------------------------------------- env 动词（fixture fs）

describe('playwright_shell env 资产盘点（fixture，不 spawn）', () => {
  it('资产齐备：verdict ok，报文含包版本 / 资产目录 / 浏览器清单', async () => {
    const fx = makeFixture();
    const adapters = createPlaywrightAdapters({ packageRoot: fx.packageRoot, browsersPath: fx.browsersDir }) as AdapterMap;
    const r = await run('env', { adapters });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('playwright 1.63.0'), r.output);
    assert.ok(r.output.includes(fx.browsersDir), r.output);
    assert.ok(r.output.includes('chromium rev=9999: installed'), r.output);
    assert.ok(r.output.includes('chromium-headless-shell rev=9999: installed'), r.output);
    assert.ok(r.output.includes('verdict: ok'), r.output);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('浏览器资产缺失：verdict=资产缺失 + 人工修复指引，仍 ok（结构化）', async () => {
    const fx = makeFixture({ withAssets: false });
    const adapters = createPlaywrightAdapters({ packageRoot: fx.packageRoot, browsersPath: fx.browsersDir }) as AdapterMap;
    const r = await run('env', { adapters });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('chromium-headless-shell rev=9999: missing'), r.output);
    assert.ok(r.output.includes('verdict: 浏览器资产缺失'), r.output);
    assert.ok(r.output.includes(PLAYWRIGHT_ENV_FIX_GUIDANCE.slice(0, 12)), '应附统一修复指引');
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('后端包缺失：verdict=后端缺失 + 修复指引（不裸抛）', async () => {
    const adapters = createPlaywrightAdapters({ packageRoot: '/nonexistent-pkg-root' }) as AdapterMap;
    const r = await run('env', { adapters });
    assert.equal(r.ok, true);
    assert.ok(r.output.includes('verdict: 后端缺失'), r.output);
    assert.ok(r.output.includes('playwright 包未安装'), r.output);
  });

  it('报文不出现后端原生命令名（验收点 1）', async () => {
    const fx = makeFixture({ withAssets: false });
    const adapters = createPlaywrightAdapters({ packageRoot: fx.packageRoot, browsersPath: fx.browsersDir }) as AdapterMap;
    const r = await run('env', { adapters });
    assert.ok(!r.output.includes('npx playwright install'), r.output);
    assert.ok(!r.output.includes('playwright install'), r.output);
    rmSync(fx.root, { recursive: true, force: true });
  });
});

// ------------------------------------------------- screenshot adapter（替身）

describe('playwright_shell screenshot adapter（spawn 注入替身）', () => {
  it('argv 契约：node <entry> screenshot <url> <absOut>；--full-page 透传', async () => {
    const fx = makeFixture();
    const calls: RecordedCall[] = [];
    const adapters = createPlaywrightAdapters({
      packageRoot: fx.packageRoot,
      browsersPath: fx.browsersDir,
      workdir: fx.root,
      spawnImpl: (async (_c, args, options) => {
        calls.push({ argv: [_c, ...args], env: options.env ?? {}, workdir: options.workdir });
        const out = args.find((a) => a.endsWith('.png'));
        if (out) writeFileSync(out, Buffer.alloc(100, 7));
        return { ok: true, stdout: 'ok', stderr: '', exitCode: 0, terminated: false };
      }) as SpawnLike,
    }) as AdapterMap;
    const r = await run("screenshot 'https://example.com' shots/a.png --full-page", { adapters });
    assert.equal(r.ok, true, r.output);
    assert.equal(calls.length, 1);
    const argv = calls[0].argv;
    assert.equal(argv[0], process.execPath);
    assert.equal(argv[1], fx.cliEntry);
    assert.deepEqual(argv.slice(2, 5), ['screenshot', 'https://example.com', join(fx.root, 'shots/a.png')]);
    assert.ok(argv.includes('--full-page'), '声明 flag 应透传后端');
    // env 注入：资产目录重定向 + 关闭 update-check
    assert.equal(calls[0].env.PLAYWRIGHT_BROWSERS_PATH, fx.browsersDir);
    assert.equal(calls[0].env.NO_UPDATE_NOTIFIER, '1');
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('成功报文 = 路径 + 字节数（不回灌大块输出）', async () => {
    const fx = makeFixture();
    const adapters = makeAdapters(fx, { artifactBytes: 4321 });
    const r = await run("screenshot 'https://example.com' shots/b.png", { adapters });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('screenshot ok'), r.output);
    assert.ok(r.output.includes('saved: shots/b.png'), r.output);
    assert.ok(r.output.includes('bytes: 4321'), r.output);
    assert.ok(!r.output.includes('Navigating'), '成功报文不回灌后端 stdout');
  });

  it('导航失败：结构化分类报文（net::ERR_* 保留可判因），退出码非 0 不裸抛', async () => {
    const fx = makeFixture();
    const adapters = makeAdapters(fx, { exitCode: 1, stderr: 'Error: net::ERR_NAME_NOT_RESOLVED at https://bad.example/' });
    const r = await run("screenshot 'https://bad.example' x.png", { adapters });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('failed screenshot'), r.output);
    assert.ok(r.output.includes('net::ERR_NAME_NOT_RESOLVED'), r.output);
    assert.ok(r.output.includes('URL 不可达'), r.output);
  });

  it("浏览器资产缺失形态（Executable doesn't exist）→ 修复指引，不透传 ASCII 框", async () => {
    const fx = makeFixture();
    const stderr = "Error: command.parse: Executable doesn't exist at /x/chromium_headless_shell-9999/chrome-headless-shell\n╔══╗";
    const adapters = makeAdapters(fx, { exitCode: 1, stderr });
    const r = await run("screenshot 'https://example.com' x.png", { adapters });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('浏览器资产缺失'), r.output);
    assert.ok(r.output.includes(PLAYWRIGHT_ENV_FIX_GUIDANCE.split('：')[0].slice(0, 6)), r.output);
    assert.ok(!r.output.includes('npx playwright install'), '报文不得出现后端原生命令行');
  });

  it('后端包缺失：结构化报文（不裸抛 ENOENT）', async () => {
    const adapters = createPlaywrightAdapters({
      packageRoot: '/nonexistent-pkg-root',
      spawnImpl: (async () => { throw new Error('should not spawn'); }) as unknown as SpawnLike,
    }) as AdapterMap;
    const r = await run("screenshot 'https://example.com' x.png", { adapters });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('后端'), r.output);
    assert.ok(r.output.includes('env'), '修复指引应指向 env 动词');
  });

  it('超时终止：terminated 报文（结构化，非错误文案）', async () => {
    const fx = makeFixture();
    const ac = new AbortController();
    const adapters = makeAdapters(fx, { hangUntilAbort: true });
    setTimeout(() => ac.abort(), 50);
    const r = await run("screenshot 'https://example.com' t.png", { adapters, signal: ac.signal });
    assert.ok(r.output.startsWith('terminated'), r.output);
  });
});

// ------------------------------------------------- pdf / har adapter

describe('playwright_shell pdf / har adapter（替身）', () => {
  it('pdf：argv 契约 [screenshot→pdf 子命令 + url + absOut]，产物报文同契约', async () => {
    const fx = makeFixture();
    const calls: RecordedCall[] = [];
    const adapters = makeAdapters(fx, {
      artifactBytes: 8192,
      record: calls,
    });
    const r = await run("pdf 'https://example.com' docs/b.pdf", { adapters });
    assert.equal(r.ok, true, r.output);
    assert.equal(calls[0].argv[2], 'pdf');
    assert.equal(calls[0].argv[3], 'https://example.com');
    assert.equal(calls[0].argv[4], join(fx.root, 'docs/b.pdf'));
    assert.ok(r.output.includes('saved: docs/b.pdf'), r.output);
    assert.ok(r.output.includes('bytes: 8192'), r.output);
  });

  it('har：--save-har 一次 spawn 产出 HAR + 同目录 PNG 侧产物', async () => {
    const fx = makeFixture();
    const calls: RecordedCall[] = [];
    const adapters = createPlaywrightAdapters({
      packageRoot: fx.packageRoot,
      browsersPath: fx.browsersDir,
      workdir: fx.root,
      spawnImpl: (async (_c: string, args: string[], options: { env?: Record<string, string> }) => {
        calls.push({ argv: [_c, ...args], env: options.env ?? {} });
        const harArg = args[args.indexOf('--save-har') + 1];
        writeFileSync(harArg, Buffer.alloc(1500, 1));
        const png = args[args.length - 1];
        writeFileSync(png, Buffer.alloc(2048, 2));
        return { ok: true, stdout: 'ok', stderr: '', exitCode: 0, terminated: false };
      }) as unknown as SpawnLike,
    }) as AdapterMap;
    const r = await run("har 'https://example.com' traces/net.har", { adapters });
    assert.equal(r.ok, true, r.output);
    assert.ok(r.output.includes('saved: traces/net.har'), r.output);
    assert.ok(r.output.includes('bytes: 1500'), r.output);
    assert.ok(r.output.includes('net.har.png'), '侧产物路径应随报文给出');
  });

  it('pdf 仅 chromium 的后端错误被改写为结构化报文', async () => {
    const fx = makeFixture();
    const adapters = makeAdapters(fx, { exitCode: 1, stderr: 'Error: PDF creation is only working with Chromium' });
    const r = await run("pdf 'https://example.com' p.pdf", { adapters });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('pdf 仅支持 Chromium'), r.output);
  });
});

// ------------------------------------------------- helpers

function makeAdapters(fx: ReturnType<typeof makeFixture>, opts: {
  exitCode?: number;
  stderr?: string;
  artifactBytes?: number;
  hangUntilAbort?: boolean;
  record?: RecordedCall[];
}): AdapterMap {
  const spawn: SpawnLike = async (_command, args, options) => {
    opts.record?.push({ argv: [_command, ...args], env: options.env ?? {}, workdir: options.workdir });
    if (opts.hangUntilAbort) {
      const signal = options.signal;
      if (!signal || signal.aborted) return { ok: false, stdout: '', stderr: '', exitCode: null, terminated: true };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, stdout: 'partial', stderr: '', exitCode: null, terminated: true };
    }
    if (opts.artifactBytes !== undefined) {
      const out = [...args].reverse().find((a) => (a.endsWith('.png') || a.endsWith('.pdf') || a.endsWith('.har')));
      if (out) writeFileSync(out, Buffer.alloc(opts.artifactBytes, 7));
    }
    const ok = (opts.exitCode ?? 0) === 0;
    return { ok, stdout: ok ? 'ok stdout' : '', stderr: opts.stderr ?? '', exitCode: ok ? 0 : 1, terminated: false };
  };
  return createPlaywrightAdapters({
    packageRoot: fx.packageRoot,
    browsersPath: fx.browsersDir,
    workdir: fx.root,
    spawnImpl: spawn,
  }) as AdapterMap;
}

// ------------------------------------------------- 安全（scheme 白名单 / 路径真实边界）

describe('playwright_shell 安全边界（ticket 036）', () => {
  it('URL scheme 白名单：file:// 与其他协议被结构化拒绝（防本地文件经渲染渗入产物）', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,<h1>x</h1>']) {
      const adapters = makeAdapters(makeFixture(), {}) as AdapterMap;
      const r = await run(`screenshot '${url}' out.png`, { adapters });
      assert.equal(r.ok, false, `应拒绝: ${url}`);
      assert.ok(r.output.includes('http:// 或 https://'), `拒绝文案应说明允许协议: ${r.output}`);
      assert.ok(!r.output.includes('net::'), '不应进入渲染阶段');
    }
  });

  it('非 URL 文本被拒绝且不触发 spawn', async () => {
    let spawned = 0;
    const adapters = createPlaywrightAdapters({
      packageRoot: '/nonexistent',
      spawnImpl: (async () => {
        spawned += 1;
        return { ok: true, stdout: 'ok', stderr: '', exitCode: 0, terminated: false };
      }) as SpawnLike,
    }) as AdapterMap;
    await run("screenshot 'not a url' out.png", { adapters });
    assert.equal(spawned, 0, '非法 URL 不应 spawn 后端');
  });

  it('产物路径符号链接逃逸被真实 resolve 核对拒绝（工作区内 symlink 指向外部）', async () => {
    const fx = makeFixture();
    const escapeDir = mkdtempSync(join(tmpdir(), 'pws-escape-'));
    try {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      symlinkSync(escapeDir, join(fx.root, 'escape-link'), linkType);
      const adapters = makeAdapters(fx, { artifactBytes: 100 });
      const r = await run("screenshot 'https://example.com' escape-link/x.png", { adapters });
      assert.equal(r.ok, false, r.output);
      assert.match(r.output, /escapes workspace|产物文件未写出|failed screenshot/);
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- 真实端到端（需浏览器资产，缺失自动跳过）

const E2E_BROWSERS_DIR = process.env.PLAYWRIGHT_SHELL_E2E_BROWSERS ?? '';

describe('playwright_shell 真实端到端（需浏览器资产，缺失自动跳过）', () => {
  const browsersDir = process.env.PLAYWRIGHT_SHELL_E2E_BROWSERS;
  let workdir = '';

  before(() => {
    if (browsersDir && existsSync(browsersDir)) {
      workdir = mkdtempSync(join(tmpdir(), 'pws-e2e-'));
    }
  });

  after(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('真实渲染：本地 http 页面 → PNG 产物（路径 + 字节数报文）', async () => {
    if (!E2E_BROWSERS_DIR || !existsSync(E2E_BROWSERS_DIR)) return;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>forensic-e2e</h1></body></html>');
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as { port: number }).port;
    try {
      const adapters = createPlaywrightAdapters({ browsersPath: E2E_BROWSERS_DIR, workdir });
      const r = await run(`screenshot 'http://127.0.0.1:${port}/' e2e.png`, { adapters });
      assert.equal(r.ok, true, r.output);
      const outPath = join(workdir, 'e2e.png');
      assert.ok(existsSync(outPath), '产物应真实落盘');
      assert.ok(statSync(outPath).size > 1000, 'PNG 应有实质字节');
      assert.ok(r.output.includes('e2e.png'), r.output);
    } finally {
      server.close();
    }
  });

  it('超时/打断：terminated 收尾 + 浏览器整组回收无残留（验收点 6）', async () => {
    if (!E2E_BROWSERS_DIR || !existsSync(E2E_BROWSERS_DIR)) return;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>slow page</body></html>');
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as { port: number }).port;
    const ac = new AbortController();
    const adapters = createPlaywrightAdapters({ browsersPath: E2E_BROWSERS_DIR, workdir });
    const timer = setTimeout(() => ac.abort(), 2500);
    const r = await run(`screenshot 'http://127.0.0.1:${port}/' aborted.png --full-page`, { adapters, signal: ac.signal });
    clearTimeout(timer);
    server.close();
    assert.ok(r.output.includes('terminated'), `终止应以 terminated 结构化报文收尾: ${r.output}`);
    // 浏览器经 pipe EOF 收敛（调研实测 2s 内）；留足余量后断言无残留
    await new Promise((res) => setTimeout(res, 2500));
    let leftover = '';
    try {
      leftover = execSync('ps -eo args | grep chrome-headless | grep -v grep || true').toString().trim();
    } catch { leftover = ''; }
    assert.equal(leftover, '', `浏览器进程应无残留: ${leftover}`);
  });
});

// ================================================== v2 会话动词


// ------------------------------------------------- v2 会话动词（@playwright/cli daemon 转发）

describe('playwright_shell v2 会话动词（daemon 转发）', () => {
  function makeSessionAdapter(forward: (command: string, argv: string[], options: { env?: Record<string, string>; workdir?: string; signal?: AbortSignal }) => { ok: boolean; stdout: string; stderr: string; exitCode: number; terminated: boolean }) {
    return createPlaywrightAdapters({
      sessionCliEntry: '/fake/pw-cli/bin.js',
      spawnImpl: async (command, argv, options) => forward(command, argv, options),
    });
  }

  it('open 会话动词 argv 契约：转发官方 CLI + env 注入（adapter 层收管线道后的裸参数）', async () => {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const adapters = makeSessionAdapter((_c, argv, options) => {
      calls.push({ argv: [...argv], env: options.env });
      return { ok: true, stdout: '### Browser `default` opened with pid 1.', stderr: '', exitCode: 0, terminated: false };
    });
    // Windows/macOS 桌面不依赖 DISPLAY；Linux 测试用临时 DISPLAY
    // 覆盖有头模式的显示环境检查。
    const saved = process.env.DISPLAY;
    if (process.platform === 'win32' || process.platform === 'darwin') delete process.env.DISPLAY;
    else process.env.DISPLAY = ':99';
    try {
      const out = await adapters['playwright:open'](['https://www.baidu.com', '--headed'], { stdin: '', termination: () => null });
      assert.ok(out.includes('### Browser'), out);
      assert.deepEqual(calls[0].argv, ['/fake/pw-cli/bin.js', 'open', 'https://www.baidu.com', '--headed']);
      assert.equal(
        (calls[0].env as Record<string, string>).PLAYWRIGHT_BROWSERS_PATH,
        join(homedir(), '.agentdev', 'AgentDevClaw', 'assets', 'playwright-shell', 'browsers'),
      );
    } finally {
      if (saved === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = saved;
    }
  });

  it('旧布局浏览器资产一次性迁移到数据根（新根已存在/旧根缺失时跳过）', () => {
    const root = mkdtempSync(join(tmpdir(), 'pws-migrate-'));
    const nextRoot = join(root, 'data-root', 'assets', 'playwright-shell', 'browsers');
    const legacyRoot = join(root, 'legacy', 'playwright-shell', 'browsers');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'marker.txt'), 'x');

    // 旧根存在、新根不存在 → rename 迁移
    assert.equal(migrateLegacyBrowsersRoot(nextRoot, legacyRoot), true);
    assert.ok(existsSync(join(nextRoot, 'marker.txt')));
    assert.ok(!existsSync(legacyRoot));

    // 新根已存在 → 跳过（不抛错、不动文件）
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'marker2.txt'), 'y');
    assert.equal(migrateLegacyBrowsersRoot(nextRoot, legacyRoot), false);
    assert.ok(existsSync(join(legacyRoot, 'marker2.txt')));

    // 旧根不存在 → 跳过
    rmSync(legacyRoot, { recursive: true, force: true });
    assert.equal(migrateLegacyBrowsersRoot(join(root, 'other', 'browsers'), legacyRoot), false);
    assert.ok(!existsSync(join(root, 'other', 'browsers')));
    rmSync(root, { recursive: true, force: true });
  });

  it('fill 的 ref 参数：任意选择器形态被参数道拒绝（refs 防注入）', () => {
    const r = checkArgs([{ verb: 'fill', args: ['#search', 'x'] } as unknown as ShellSegment], POLICY.verbs);
    assert.equal(r.ok, false);
    assert.ok((r.message ?? '').includes('snapshot 输出里的元素 ref'), r.message);
  });

  it('press 的 key 是字面量白名单（Enter 允许，任意键拒）', () => {
    assert.ok(checkArgs([{ verb: 'press', args: ['Enter'] } as unknown as ShellSegment], POLICY.verbs).ok);
    assert.equal(checkArgs([{ verb: 'press', args: ['Ctrl+P'] } as unknown as ShellSegment], POLICY.verbs).ok, false);
  });

  it('close 幂等：未开会话时以 ok 报文收尾（不裸抛）', async () => {
    const adapters = makeSessionAdapter(() => ({ ok: false, stdout: '', stderr: "Browser 'default' is not open.", exitCode: 1, terminated: false }));
    const out = await adapters['playwright:close']([], { stdin: '', termination: () => null });
    assert.ok(out.includes('close ok'), out);
  });

  it('会话动词失败分类：无会话时 goto 给出先 open 的结构化指引（不裸抛）', async () => {
    const adapters = makeSessionAdapter(() => ({ ok: false, stdout: '', stderr: 'Error: Browser is not open.', exitCode: 1, terminated: false }));
    let thrown = '';
    try {
      await adapters['playwright:goto'](['https://example.com'], { stdin: '', termination: () => null });
    } catch (e) {
      thrown = (e as Error).message;
    }
    assert.ok(thrown.includes('先运行 open'), thrown);
  });

  it('goto 拒绝非 HTTP URL，且不调用会话后端', async () => {
    let spawned = 0;
    const adapters = createPlaywrightAdapters({
      sessionCliEntry: '/fake/pw-cli/bin.js',
      spawnImpl: async () => {
        spawned += 1;
        return { ok: true, stdout: '', stderr: '', exitCode: 0, terminated: false };
      },
    });
    let thrown = '';
    try {
      await adapters['playwright:goto'](['file:///C:/Windows/win.ini'], { stdin: '', termination: () => null });
    } catch (error) {
      thrown = String(error);
    }
    assert.ok(thrown.includes('仅支持 “http://” 或 “https://”') || thrown.includes('仅支持 http:// 或 https:'), thrown);
    assert.equal(spawned, 0);
  });
});

// ------------------------------------------------- v2.1 登录档案（open --profile / profile-list）

describe('playwright_shell 登录档案（open --profile / profile-list）', () => {
  function makeProfileHarness() {
    const root = mkdtempSync(join(tmpdir(), 'pws-profile-'));
    const profilesPath = join(root, 'profiles');
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const adapters = createPlaywrightAdapters({
      sessionCliEntry: '/fake/pw-cli/bin.js',
      profilesPath,
      spawnImpl: (async (_command: string, argv: string[], options: { env?: Record<string, string> }) => {
        calls.push({ argv: [...argv], env: options.env });
        return { ok: true, stdout: '### Browser `default` opened with pid 1.', stderr: '', exitCode: 0, terminated: false };
      }) as SpawnLike,
    }) as AdapterMap;
    return { root, profilesPath, adapters, calls };
  }

  const CTX = { stdin: '', termination: () => null } as const;

  it('open --profile=<名称>：名称解析到档案根下目录（自动创建）并以绝对路径转发后端，站点域名入档', async () => {
    const h = makeProfileHarness();
    try {
      const out = await h.adapters['playwright:open'](['https://example.com', '--profile=work'], CTX);
      assert.ok(String(out).includes('### Browser'), String(out));
      assert.deepEqual(h.calls[0].argv, [
        '/fake/pw-cli/bin.js', 'open', 'https://example.com', `--profile=${join(h.profilesPath, 'work')}`,
      ]);
      assert.ok(existsSync(join(h.profilesPath, 'work')), '首次使用应创建档案目录');
      assert.deepEqual(
        JSON.parse(readFileSync(join(h.profilesPath, 'work', 'agentdev-sites.json'), 'utf-8')),
        ['example.com'],
        'open 的 URL 域名应记入档案站点',
      );
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('goto 顺势记录站点，close 后不再记录（会话结束即止）', async () => {
    const h = makeProfileHarness();
    try {
      const sitesFile = join(h.profilesPath, 'work', 'agentdev-sites.json');
      await h.adapters['playwright:open'](['https://first.example.com', '--profile=work'], CTX);
      await h.adapters['playwright:goto'](['https://second.example.org'], CTX);
      assert.deepEqual(JSON.parse(readFileSync(sitesFile, 'utf-8')), ['second.example.org', 'first.example.com']);
      await h.adapters['playwright:close']([], CTX);
      await h.adapters['playwright:goto'](['https://third.example.net'], CTX);
      assert.deepEqual(
        JSON.parse(readFileSync(sitesFile, 'utf-8')),
        ['second.example.org', 'first.example.com'],
        'close 之后 goto 不应再记录',
      );
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('open 不带 --profile 不注入档案 flag（回归）', async () => {
    const h = makeProfileHarness();
    try {
      await h.adapters['playwright:open'](['https://example.com'], CTX);
      assert.equal(h.calls[0].argv.filter((a) => a.startsWith('--profile=')).length, 0);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('带值 flag 真正转发后端：--browser=firefox 不被静默丢弃（存量 bug 回归）', async () => {
    const h = makeProfileHarness();
    try {
      await h.adapters['playwright:open'](['https://example.com', '--browser=firefox'], CTX);
      assert.deepEqual(h.calls[0].argv, ['/fake/pw-cli/bin.js', 'open', 'https://example.com', '--browser=firefox']);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('profile 名称白名单：穿越/分隔符/空值等拒绝且不 spawn（防路径穿越）', async () => {
    const h = makeProfileHarness();
    try {
      for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', 'a.b', '-x', '']) {
        let thrown = '';
        try {
          await h.adapters['playwright:open'](['https://example.com', `--profile=${bad}`], CTX);
        } catch (e) {
          thrown = (e as Error).message;
        }
        assert.ok(thrown.includes('profile 名称不合法'), `${JSON.stringify(bad)} 应被拒: ${thrown}`);
        assert.ok(thrown.includes('字母或数字开头'), `${JSON.stringify(bad)} 报文应说明规则: ${thrown}`);
      }
      assert.equal(h.calls.length, 0, '非法名称不应触达后端');
      assert.equal(existsSync(h.profilesPath), false, '拒绝路径不应创建任何目录');
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('profile-list 列出档案目录名（只列目录，忽略普通文件）', async () => {
    const h = makeProfileHarness();
    try {
      mkdirSync(join(h.profilesPath, 'work'), { recursive: true });
      mkdirSync(join(h.profilesPath, 'shop'), { recursive: true });
      writeFileSync(join(h.profilesPath, 'notes.txt'), 'not a profile');
      const out = String(await h.adapters['playwright:profile-list']([], CTX));
      assert.ok(out.includes('profile-list ok'), out);
      assert.ok(out.includes('work'), out);
      assert.ok(out.includes('shop'), out);
      assert.ok(out.includes('profiles (2)'), out);
      assert.ok(!out.includes('notes.txt'), '普通文件不应列为档案');
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('profile-list 展示档案 → 站点关联（站点文件缺失/损坏时降级为裸名）', async () => {
    const h = makeProfileHarness();
    try {
      mkdirSync(join(h.profilesPath, 'taobao'), { recursive: true });
      mkdirSync(join(h.profilesPath, 'fresh'), { recursive: true });
      writeFileSync(join(h.profilesPath, 'taobao', 'agentdev-sites.json'), JSON.stringify(['taobao.com', 'tmall.com']));
      writeFileSync(join(h.profilesPath, 'fresh', 'agentdev-sites.json'), '{broken json');
      const out = String(await h.adapters['playwright:profile-list']([], CTX));
      assert.ok(out.includes('taobao → taobao.com, tmall.com'), out);
      assert.ok(/fresh\s*$/m.test(out), '损坏站点文件应降级为裸档案名');
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('profile-list 空态：根目录缺失时给创建指引（不报错）', async () => {
    const h = makeProfileHarness();
    try {
      const out = String(await h.adapters['playwright:profile-list']([], CTX));
      assert.ok(out.includes('profile-list ok'), out);
      assert.ok(out.includes('(空)'), out);
      assert.ok(out.includes('--profile='), '空态应指向 open --profile 用法');
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  // ------------------------------------- 会话级 cookie 保活（登录态跨重启）

  interface PwsCookieTestDb {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown; all(): unknown[] };
    close(): void;
  }
  const sqliteSpec = 'node:sqlite';
  async function loadSqlite(): Promise<{ DatabaseSync: new (path: string) => PwsCookieTestDb } | null> {
    try {
      return (await import(sqliteSpec)) as { DatabaseSync: new (path: string) => PwsCookieTestDb };
    } catch {
      return null; // 旧 Node 无 node:sqlite，保活相关用例无意义
    }
  }

  it('open --profile 在 spawn 前把会话级 cookie 翻转为持久化（登录态跨重启）', async (t) => {
    const sqlite = await loadSqlite();
    if (!sqlite) { t.skip('node:sqlite 不可用'); return; }
    const h = makeProfileHarness();
    try {
      const profileDir = join(h.profilesPath, 'work');
      mkdirSync(join(profileDir, 'Default', 'Network'), { recursive: true });
      const dbPath = join(profileDir, 'Default', 'Network', 'Cookies');
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, is_persistent INTEGER, expires_utc INTEGER)');
      const ins = db.prepare('INSERT INTO cookies (host_key, name, is_persistent, expires_utc) VALUES (?, ?, ?, ?)');
      ins.run('.site.com', 'login_ticket', 0, 0); // 会话级票据（如阿里云 aliyunid 族）
      ins.run('.site.com', 'sid', 0, 0);
      ins.run('.site.com', 'prefs', 1, 4102444800000000n); // 已持久化，不应被改动
      db.close();

      const out = await h.adapters['playwright:open'](['https://example.com', '--profile=work'], CTX);
      assert.equal(h.calls.length, 1, '翻转后应正常 spawn');
      assert.ok(!String(out).includes('warn:'), `翻转成功不应有警告：${out}`);

      const check = new sqlite.DatabaseSync(dbPath);
      const rows = check
        .prepare('SELECT name, is_persistent, CAST(expires_utc AS TEXT) AS exp FROM cookies ORDER BY name')
        .all() as Array<{ name: string; is_persistent: number; exp: string }>;
      check.close();
      const nowUs = BigInt(Date.now()) * 1000n + 11644473600000000n;
      const byName = new Map(rows.map((r) => [r.name, r]));
      assert.equal(byName.get('login_ticket')?.is_persistent, 1, '会话级行应翻转为持久化');
      assert.ok(BigInt(byName.get('login_ticket')?.exp ?? '0') > nowUs, '翻转应写入未来过期时间');
      assert.equal(byName.get('sid')?.is_persistent, 1, '会话级行应翻转为持久化');
      assert.equal(byName.get('prefs')?.exp, '4102444800000000', '已持久化的行不应被改动');
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('cookie 库损坏（不可打开）时 open 不被阻塞，仅附加 warn', async (t) => {
    const sqlite = await loadSqlite();
    if (!sqlite) { t.skip('node:sqlite 不可用'); return; }
    const h = makeProfileHarness();
    try {
      const profileDir = join(h.profilesPath, 'work');
      mkdirSync(join(profileDir, 'Default', 'Network'), { recursive: true });
      writeFileSync(join(profileDir, 'Default', 'Network', 'Cookies'), 'this is not a sqlite file');
      const out = await h.adapters['playwright:open'](['https://example.com', '--profile=work'], CTX);
      assert.equal(h.calls.length, 1, '保活失败不应阻塞 open');
      assert.ok(String(out).includes('warn:'), `应附保活跳过警告：${out}`);
      assert.ok(String(out).includes('### Browser'), out);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('cookie 库 schema 未知（缺 is_persistent 列）时保活跳过并警告', async (t) => {
    const sqlite = await loadSqlite();
    if (!sqlite) { t.skip('node:sqlite 不可用'); return; }
    const h = makeProfileHarness();
    try {
      const profileDir = join(h.profilesPath, 'work');
      mkdirSync(join(profileDir, 'Default', 'Network'), { recursive: true });
      const db = new sqlite.DatabaseSync(join(profileDir, 'Default', 'Network', 'Cookies'));
      db.exec('CREATE TABLE cookies (host_key TEXT)');
      db.close();
      const out = await h.adapters['playwright:open'](['https://example.com', '--profile=work'], CTX);
      assert.equal(h.calls.length, 1);
      assert.ok(String(out).includes('schema 未知'), out);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- v2 布局契约（skills 发现不重复）

describe('playwright_shell v2 布局契约（ticket 036 v2 修复）', () => {
  it('同包多 feature 的 skills 目录互不相交（框架按 dirname(source)/skills 逐 feature 扫描）', async () => {
    // 回归背景：coder 与 playwright feature 曾同住 src 根，同一 skills/ 目录被
    // 逐 feature 扫描两次 → SkillFeature 里同一 skill 注册两次 → capability
    // registry 抛 duplicate capability ref（Windows 用户 pull 后新建会话即炸）。
    const { CapabilityShellFeature } = await import('../src/coder-shell-feature.js');
    const { PlaywrightShellFeature } = await import('../src/playwright/playwright-shell-feature.js');
    const coder = new CapabilityShellFeature({});
    const pw = new PlaywrightShellFeature({});

    const skillsOf = (feature: { source: string }) => {
      const dir = join(dirname(feature.source), 'skills');
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    };
    const coderSkills = skillsOf(coder);
    const playwrightSkills = skillsOf(new PlaywrightShellFeature({}));
    assert.ok(coderSkills.includes('claw-coder-dispatch'), `coder feature 应发现自身 skill，实得 ${coderSkills}`);
    assert.ok(!coderSkills.includes('playwright-shell'), 'coder 的 skills 目录不得含 playwright 技能（防重复注册）');
    assert.deepEqual(playwrightSkills, ['playwright-shell'], 'playwright feature 的 skills 目录应只含自身技能');
  });
});
