#!/usr/bin/env node
/**
 * 试验性会话格式迁移：v2 → v2.1。
 *
 * v2.1 = v2 schema 原样保留，仅两点变化：
 * - 顶层 version: 2 -> 2.1
 * - 序列化去掉缩进空白（历史上约占总体积 21%）
 *
 * 安全措施（避免误伤历史会话）：
 * - 只处理 version === 2 的会话（v1 的 rollbackHistory 是全量快照语义，另行处理）
 * - 每个文件先原样备份到 backups/session-format-v2.1/<agentId>/，再原子重写
 * - 逐文件 roundtrip 校验：重写内容重新解析后，除 version 外必须与原文深等价
 * - 默认跳过 mtime 不足 24h 的会话（避免碰到正在使用/刚保存的会话）
 *
 * 用法：
 *   node scripts/migrate-session-format.mjs [--agent programming-helper] [--limit 5] [--dry-run]
 *
 * 注意：迁移后 session index 中该会话的 fileSize/fileMtimeMs 短暂陈旧，
 * 服务端在下次保存 / 列表刷新时自愈，无需手工修 index。
 */
import { copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { deepStrictEqual } from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const SESSION_FORMAT_VERSION = 2.1;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

function userDataRoot() {
  return resolve(homedir(), '.agentdev', 'AgentDevClaw');
}

/**
 * 纯函数：v2 会话文件内容 → v2.1 紧凑内容，内含 roundtrip 校验。
 * 返回 { ok, content?, originalBytes, migratedBytes, reason? }
 */
export function migrateSessionContent(rawContent) {
  let data;
  try {
    data = JSON.parse(rawContent);
  } catch (err) {
    return { ok: false, originalBytes: Buffer.byteLength(rawContent), migratedBytes: 0, reason: `JSON 解析失败: ${err.message}` };
  }
  if (data?.version !== 2) {
    return { ok: false, originalBytes: Buffer.byteLength(rawContent), migratedBytes: 0, reason: `非 v2 会话（version=${JSON.stringify(data?.version) ?? 'undefined'}）` };
  }
  if (!data.runtime || typeof data !== 'object') {
    return { ok: false, originalBytes: Buffer.byteLength(rawContent), migratedBytes: 0, reason: '缺少 runtime 字段，结构异常' };
  }

  const migrated = { ...data, version: SESSION_FORMAT_VERSION };
  const compact = JSON.stringify(migrated);

  let reparsed;
  try {
    reparsed = JSON.parse(compact);
  } catch (err) {
    return { ok: false, originalBytes: Buffer.byteLength(rawContent), migratedBytes: 0, reason: `重写后解析失败: ${err.message}` };
  }
  const { version: _v, ...origRest } = data;
  const { version: _v2, ...newRest } = reparsed;
  try {
    deepStrictEqual(newRest, origRest);
  } catch (err) {
    return { ok: false, originalBytes: Buffer.byteLength(rawContent), migratedBytes: 0, reason: `roundtrip 校验失败: ${err.message}` };
  }

  return {
    ok: true,
    content: compact,
    originalBytes: Buffer.byteLength(rawContent),
    migratedBytes: Buffer.byteLength(compact),
  };
}

/** 原子重写（对齐框架 FileSessionStore 的 tmp + rename 模式，含 Windows EPERM 处理） */
async function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.migrate-tmp`;
  await writeFile(tmpPath, content, 'utf8');
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      await unlink(filePath).catch(() => {});
      await rename(tmpPath, filePath);
    } else {
      throw err;
    }
  }
}

/** 读文件头探测 version（version 字段固定在最前面，256 字节足够） */
async function probeVersion(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0);
    const head = buffer.toString('utf8', 0, bytesRead);
    const match = head.match(/"version"\s*:\s*([\d.]+)/);
    return match ? Number(match[1]) : null;
  } finally {
    await handle.close();
  }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string', default: 'programming-helper' },
      limit: { type: 'string', default: '5' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const agentId = values.agent;
  const limit = Math.max(1, Number(values.limit) || 5);
  const dryRun = values['dry-run'];

  const sessionsDir = join(userDataRoot(), 'workspaces', agentId, 'sessions');
  const backupDir = join(userDataRoot(), 'backups', 'session-format-v2.1', agentId);

  let entries;
  try {
    entries = await readdir(sessionsDir);
  } catch (err) {
    console.error(`会话目录不存在: ${sessionsDir} (${err.message})`);
    process.exit(1);
  }

  const candidates = [];
  for (const name of entries) {
    if (!/^session-\d+-[0-9a-f]+\.json$/.test(name)) continue;
    const filePath = join(sessionsDir, name);
    const [st, version] = await Promise.all([stat(filePath), probeVersion(filePath)]);
    if (version !== 2) continue;
    if (dryRun || Date.now() - st.mtimeMs >= MIN_AGE_MS) {
      candidates.push({ name, filePath, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.size - a.size);
  const selected = candidates.slice(0, limit);

  if (selected.length === 0) {
    console.log('没有符合条件的 v2 会话（只处理 mtime 超过 24h 的历史会话）');
    return;
  }
  console.log(`发现 ${candidates.length} 个可迁移的 v2 会话，本次处理 ${selected.length} 个${dryRun ? '（dry-run，不写入）' : ''}\n`);

  let totalBefore = 0;
  let totalAfter = 0;
  let migrated = 0;
  for (const item of selected) {
    const raw = await readFile(item.filePath, 'utf8');
    const result = migrateSessionContent(raw);
    if (!result.ok) {
      console.error(`[跳过] ${item.name}: ${result.reason}`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] ${item.name}: ${fmtBytes(result.originalBytes)} -> ${fmtBytes(result.migratedBytes)}`);
      totalBefore += result.originalBytes;
      totalAfter += result.migratedBytes;
      continue;
    }
    try {
      await mkdir(backupDir, { recursive: true });
      await copyFile(item.filePath, join(backupDir, item.name));
      await atomicWrite(item.filePath, result.content);
      migrated++;
      totalBefore += result.originalBytes;
      totalAfter += result.migratedBytes;
      console.log(`[完成] ${item.name}: ${fmtBytes(result.originalBytes)} -> ${fmtBytes(result.migratedBytes)}（备份于 ${backupDir}）`);
    } catch (err) {
      console.error(`[失败] ${item.name}: ${err.message}（原文件未改动或已备份，可从备份恢复）`);
    }
  }

  if (totalBefore > 0) {
    console.log(`\n合计: ${fmtBytes(totalBefore)} -> ${fmtBytes(totalAfter)}，节省 ${fmtBytes(totalBefore - totalAfter)}（${migrated} 个已迁移）`);
  }
  if (!dryRun && migrated > 0) {
    console.log('提示: session index 中的 fileSize 在下次保存/列表刷新时自愈，无需手工处理。');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
