// npm tgz 解包共享工具（pack:desktop 与 pack:container 共用）。
// 用 Node 内置 zlib 解 tgz（不用 tar CLI：MSYS tar 把 D:\ 的冒号当远程主机，
// Windows bsdtar 又不支持 --force-local，跨 shell 环境不可靠）。npm 官方 tgz
// 只含文件与目录（无 symlink/hardlink），遇到其他条目类型直接报错。
import { createHash } from 'crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

// 包名 ≠ 目录名的特例（与 use-agentdev-published.mjs 保持一致）
export const PACKAGE_DIR_OVERRIDES = { '@agentdevjs/rokid-bot': 'rokid-feature' };

export function tgzFileName(name, version) {
  return `agentdevjs-${name.slice('@agentdevjs/'.length)}-${version}.tgz`;
}

export async function gunzipFileToBuffer(file) {
  const { createGunzip } = await import('zlib');
  return await new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream(file)
      .pipe(createGunzip())
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

export function untarBufferToDir(buffer, destDir, { strip = 0 } = {}) {
  let offset = 0;
  let longName = null;
  let written = 0;
  const destAbs = resolve(destDir);
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
    if (!name || name === '.' || name === './') continue;
    if (strip > 0) name = name.split('/').slice(strip).join('/');
    if (!name) continue;
    const target = resolve(destDir, name);
    if (target !== destAbs && !target.startsWith(destAbs + '\\') && !target.startsWith(destAbs + '/')) {
      throw new Error(`tar 条目越界: ${name}`);
    }
    if (type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer.subarray(dataStart, dataStart + size));
      written++;
      continue;
    }
    throw new Error(`npm tgz 含不支持的条目类型 "${type}"（${name}）；需扩展解包器`);
  }
  if (written === 0) throw new Error('tar 解包结果为空');
  return written;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
