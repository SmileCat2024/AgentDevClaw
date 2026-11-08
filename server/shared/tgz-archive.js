/**
 * tgz-archive.js — 纯 Node tgz 读取/解出共享库（运行时）
 *
 * 为什么不用 tar CLI：Windows 下双 tar 并存（Git 的 GNU tar 与 System32 的
 * bsdtar），PATH 解析因启动环境而异——GNU tar 把 "C:\..." 盘符冒号当远程
 * 主机分隔符需要 --force-local，而 bsdtar 不支持该选项（历史事故：开发机
 * Git Bash 里测试全绿，用户桌面启动的 server 解析到 bsdtar 导入全炸）。
 * 纯 Node 解析（zlib + ustar/pax 头）彻底消除对环境的依赖。
 *
 * 支持条目：普通文件（type '0'/'\0'）、目录（'5'）、GNU 长名（'L'）。
 * npm pack 产物只含这两类实条目；symlink/hardlink 等直接报错（与
 * scripts/pack-tgz-lib.mjs 同策略——该脚本是本库的前身，pack:desktop 与
 * pack:container 已实战检验 parser 逻辑）。
 */
import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';

/** tgz 文件 → tar Buffer（gunzip 到内存；插件包都在数 MB 量级）。 */
export async function gunzipFileToBuffer(file) {
  const { createGunzip } = await import('zlib');
  const { createReadStream } = await import('fs');
  return await new Promise((resolvePromise, reject) => {
    const chunks = [];
    createReadStream(file)
      .pipe(createGunzip())
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolvePromise(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

/**
 * tar Buffer → 条目数组。每个条目 { name, type, size, data }；
 * data 是条目内容（目录条目 data 为空 Buffer）。
 */
export function parseTarBuffer(buffer) {
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    let name = longName ?? header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    longName = null;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/[\0 ]/g, '');
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { // GNU 长名：内容是下一个条目的真实名字
      longName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    entries.push({ name, type, size, data: buffer.subarray(dataStart, dataStart + size) });
  }
  return entries;
}

/** 条目名列表（不含 GNU 长名垫片）。 */
export function listTarEntryNames(tarBuffer) {
  return parseTarBuffer(tarBuffer)
    .filter((e) => e.name && e.name !== '.' && e.name !== './')
    .map((e) => e.name);
}

/** 读单个条目内容；不存在返回 null。 */
export function readTarEntry(tarBuffer, entryPath) {
  const entry = parseTarBuffer(tarBuffer).find((e) => e.name === entryPath);
  return entry ? entry.data : null;
}

/**
 * tar Buffer → 目录落盘。
 *
 * options：
 *   - strip：剥离前 N 段路径（`package/client/index.js` strip 2 → `index.js`）
 *   - prefix：只落原始名以该前缀开头的条目（strip 前匹配）
 *
 * 返回写入的文件数；越界条目名直接抛错（防恶意构造的 tar 逃逸解出目录）。
 */
export async function untarBufferToDir(tarBuffer, destDir, { strip = 0, prefix = null } = {}) {
  const destAbs = resolve(destDir);
  let written = 0;
  for (const entry of parseTarBuffer(tarBuffer)) {
    let name = entry.name;
    if (!name || name === '.' || name === './') continue;
    if (prefix && !name.startsWith(prefix)) continue;
    if (strip > 0) name = name.split('/').slice(strip).join('/');
    if (!name) continue;
    const target = resolve(destDir, name);
    if (target !== destAbs && !target.startsWith(destAbs + '\\') && !target.startsWith(destAbs + '/')) {
      throw new Error(`tar 条目越界: ${entry.name}`);
    }
    if (entry.type === '5') {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    if (entry.type === '0' || entry.type === '\0') {
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, entry.data);
      written++;
      continue;
    }
    throw new Error(`tgz 含不支持的条目类型 "${entry.type}"（${entry.name}）`);
  }
  return written;
}
