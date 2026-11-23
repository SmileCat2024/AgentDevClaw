import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { killProcessTree } from './process-tree.js';
import { createClawLogger } from './claw-logger.js';

/**
 * 旧版 Office（doc / ppt / pptx）转 PDF 的本机转换器。
 *
 * 边界：Claw 只调用本机已安装的 LibreOffice（soffice），不随包分发引擎——
 * DSH 走独立发布的 libreoffice-kit（原生包或 WASM），Claw 侧的等价物是
 * 「有引擎就转换、没有就明确告知」。引擎缺失不是错误配置，属正常环境差异，
 * 因此每次转换前只探测一次路径并缓存结果。
 *
 * 每次转换使用独立的临时用户配置目录（-env:UserInstallation），并发时
 * 不会争抢同一份 soffice 配置锁；输出与临时目录在转换结束后删除。
 * 结果按「源文件真实路径 + mtime + size」缓存，命中直接复用 PDF 字节。
 */

const log = createClawLogger('office-converter');

const ENGINE_ENV = 'CLAW_SOFFICE_PATH';
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_CACHED_BYTES = 64 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const STDERR_LIMIT = 4096;

function candidateEngines() {
  const explicit = (process.env[ENGINE_ENV] || '').trim();
  if (explicit) return [explicit];
  if (process.platform === 'win32') {
    return [
      'soffice.exe',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return ['soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  }
  return ['soffice', 'libreoffice'];
}

function officeError(code, message, cause) {
  const error = new Error(message || code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/** 运行一个子进程并收集尾部 stderr；超时按进程树终止。 */
function runProcess(spawnImpl, binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (cause) {
      reject(officeError('office_engine_unavailable', 'spawn failed', cause));
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      void killProcessTree(child.pid);
      finish(officeError('office_convert_timeout', `conversion exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
    });
    child.on('error', cause => {
      finish(cause.code === 'ENOENT'
        ? officeError('office_engine_unavailable', 'engine binary not found', cause)
        : officeError('office_convert_failed', cause.message, cause));
    });
    child.on('exit', code => {
      if (code === 0) finish();
      else finish(officeError('office_convert_failed', `engine exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function probeEngine(spawnImpl, binary) {
  try {
    await runProcess(spawnImpl, binary, ['--version'], PROBE_TIMEOUT_MS);
    return true;
  } catch (error) {
    if (error?.code !== 'office_convert_failed') log.debug(`office 引擎探测失败：${binary}（${error?.code ?? 'unknown'}）`);
    return false;
  }
}

/**
 * @param {{
 *   spawn?: typeof spawn,
 *   probe?: (binary: string) => Promise<boolean>,
 *   timeoutMs?: number,
 *   maxEntries?: number,
 *   maxCachedBytes?: number,
 *   concurrency?: number,
 * }} [options]
 */
export function createOfficeConverter(options = {}) {
  const spawnImpl = options.spawn ?? spawn;
  const probe = options.probe ?? (binary => probeEngine(spawnImpl, binary));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxCachedBytes = options.maxCachedBytes ?? DEFAULT_MAX_CACHED_BYTES;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  /** @type {Promise<string | null> | undefined} */
  let enginePromise;
  /** @type {Map<string, { bytes: Buffer, usedAt: number }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<Buffer>>} */
  const inflight = new Map();
  let cachedBytes = 0;
  let active = 0;
  /** @type {Array<() => void>} */
  const waiters = [];

  async function acquire() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    // 排队者拿到的是前一个任务让出的名额（release 直接交接，不先减再加）。
    await new Promise(resolve => waiters.push(resolve));
  }

  function release() {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }

  function resolveEngine() {
    enginePromise ??= (async () => {
      for (const candidate of candidateEngines()) {
        if (await probe(candidate)) return candidate;
      }
      log.info(`未找到 LibreOffice 引擎：doc/ppt/pptx 预览将提示安装（${ENGINE_ENV} 可指定路径）`);
      return null;
    })();
    return enginePromise;
  }

  function evict() {
    while (cache.size > maxEntries || cachedBytes > maxCachedBytes) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of cache) {
        if (entry.usedAt < oldestAt) { oldestAt = entry.usedAt; oldestKey = key; }
      }
      if (oldestKey === null) return;
      const entry = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedBytes -= entry ? entry.bytes.length : 0;
    }
  }

  async function convertWithEngine(binary, absolutePath) {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-office-'));
    const outDir = path.join(workDir, 'out');
    const profileDir = path.join(workDir, 'profile');
    try {
      await fs.mkdir(outDir);
      await fs.mkdir(profileDir);
      await runProcess(spawnImpl, binary, [
        '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--convert-to', 'pdf',
        '--outdir', outDir,
        absolutePath,
      ], timeoutMs);
      const base = path.basename(absolutePath, path.extname(absolutePath));
      const produced = path.join(outDir, `${base}.pdf`);
      return await fs.readFile(produced);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    /** @returns {Promise<boolean>} 本机是否可用 LibreOffice 引擎。 */
    async available() {
      return (await resolveEngine()) !== null;
    },

    /**
     * 把 Office 文档转成 PDF 字节（带缓存与并发限流）。
     * @param {string} absolutePath 已通过路径校验的绝对路径
     * @param {{ realPath: string, mtimeMs: number, size: number }} identity
     * @returns {Promise<Buffer>}
     */
    async toPdf(absolutePath, identity) {
      const engine = await resolveEngine();
      if (engine === null) throw officeError('office_engine_unavailable', 'no LibreOffice engine');
      const key = `${identity.realPath}|${identity.mtimeMs}|${identity.size}`;
      const cached = cache.get(key);
      if (cached) {
        cached.usedAt = Date.now();
        return cached.bytes;
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const task = (async () => {
        await acquire();
        try {
          const bytes = await convertWithEngine(engine, absolutePath);
          cache.set(key, { bytes, usedAt: Date.now() });
          cachedBytes += bytes.length;
          evict();
          return bytes;
        } finally {
          release();
          inflight.delete(key);
        }
      })();
      inflight.set(key, task);
      return task;
    },
  };
}

/** 服务进程内共享的转换器实例（探测与缓存跨请求复用）。 */
export const sharedOfficeConverter = createOfficeConverter();
