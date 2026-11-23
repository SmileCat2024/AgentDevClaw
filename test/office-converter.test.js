import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createOfficeConverter } from '../server/shared/office-converter.js';

/**
 * 伪造 soffice：`--version` 按 versionOk 返回，转换按 outdir 写出同名 PDF。
 * 转换器只依赖 spawn 的 ChildProcess 形状（pid / stderr 流 / exit 事件），
 * 因此无需真实引擎即可覆盖探测、缓存、限流与失败分支。
 */
function fakeEngine({ versionOk = true, exitCode = 0, delayMs = 0, pdf = '%PDF-1.4 engine' } = {}) {
  const calls = [];
  const stats = { active: 0, peak: 0 };
  const spawnImpl = (binary, args) => {
    calls.push({ binary, args: [...args] });
    const child = new EventEmitter();
    child.pid = 9090;
    child.stderr = new EventEmitter();
    const isVersion = args.includes('--version');
    const code = isVersion ? (versionOk ? 0 : 1) : exitCode;
    if (!isVersion) {
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);
    }
    setTimeout(async () => {
      try {
        if (!isVersion && exitCode === 0) {
          const outdir = args[args.indexOf('--outdir') + 1];
          const input = args[args.length - 1];
          const base = path.basename(input, path.extname(input));
          await fs.mkdir(outdir, { recursive: true });
          await fs.writeFile(path.join(outdir, `${base}.pdf`), pdf);
        }
      } finally {
        if (!isVersion) stats.active -= 1;
        child.emit('exit', code);
      }
    }, delayMs);
    return child;
  };
  return { spawnImpl, calls, stats, convertCalls: () => calls.filter(call => !call.args.includes('--version')).length };
}

async function sourceFile(name = 'legacy.doc') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-office-src-'));
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return { dir, file };
}

test('missing engine: available() is false and conversion is refused without spawning a convert', async t => {
  const { dir, file } = await sourceFile();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const engine = fakeEngine({ versionOk: false });
  const converter = createOfficeConverter({ spawn: engine.spawnImpl, probe: undefined });
  assert.equal(await converter.available(), false);
  await assert.rejects(
    converter.toPdf(file, { realPath: file, mtimeMs: 1, size: 4 }),
    error => error.code === 'office_engine_unavailable',
  );
  assert.equal(engine.convertCalls(), 0);
});

test('converts once per source version and reuses the produced PDF', async t => {
  const { dir, file } = await sourceFile();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const engine = fakeEngine();
  const converter = createOfficeConverter({ spawn: engine.spawnImpl });
  const identity = { realPath: file, mtimeMs: 1, size: 4 };
  const bytes = await converter.toPdf(file, identity);
  assert.equal(bytes.toString(), '%PDF-1.4 engine');
  assert.equal(engine.convertCalls(), 1);
  // 同一版本重复打开不重新起进程
  await converter.toPdf(file, identity);
  assert.equal(engine.convertCalls(), 1);
  // 源文件变化后必须重新转换，不复用旧 PDF
  await converter.toPdf(file, { ...identity, mtimeMs: 2 });
  assert.equal(engine.convertCalls(), 2);
});

test('parallel conversions use separate LibreOffice profiles', async t => {
  const { dir, file } = await sourceFile();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const engine = fakeEngine({ delayMs: 20 });
  const converter = createOfficeConverter({ spawn: engine.spawnImpl, concurrency: 2 });
  await Promise.all([
    converter.toPdf(file, { realPath: file, mtimeMs: 1, size: 4 }),
    converter.toPdf(file, { realPath: file, mtimeMs: 2, size: 4 }),
  ]);
  assert.equal(engine.stats.peak, 2);
  const profiles = engine.calls
    .filter(call => !call.args.includes('--version'))
    .map(call => call.args.find(arg => arg.startsWith('-env:UserInstallation=')));
  assert.equal(profiles.length, 2);
  assert.notEqual(profiles[0], profiles[1]);
});

test('failure exit rejects with office_convert_failed and does not poison the cache', async t => {
  const { dir, file } = await sourceFile();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const engine = fakeEngine({ exitCode: 1 });
  const converter = createOfficeConverter({ spawn: engine.spawnImpl });
  const identity = { realPath: file, mtimeMs: 1, size: 4 };
  await assert.rejects(converter.toPdf(file, identity), error => error.code === 'office_convert_failed');
  await assert.rejects(converter.toPdf(file, identity), error => error.code === 'office_convert_failed');
  assert.equal(engine.convertCalls(), 2);
});

test('limits concurrent conversions and evicts least-recently-used entries', async t => {
  const { dir, file } = await sourceFile();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const engine = fakeEngine({ delayMs: 30 });
  const converter = createOfficeConverter({ spawn: engine.spawnImpl, concurrency: 1, maxEntries: 1 });
  const first = { realPath: file, mtimeMs: 1, size: 4 };
  const second = { realPath: file, mtimeMs: 2, size: 4 };
  await Promise.all([
    converter.toPdf(file, first),
    converter.toPdf(file, second),
  ]);
  assert.equal(engine.stats.peak, 1);
  assert.equal(engine.convertCalls(), 2);
  // maxEntries=1：第二次转换淘汰了第一份，再取第一份需要重新转换
  await converter.toPdf(file, first);
  assert.equal(engine.convertCalls(), 3);
});
