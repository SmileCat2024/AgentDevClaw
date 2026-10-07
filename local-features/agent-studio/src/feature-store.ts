// ── 全局 Feature 注册表（features.json）──
//
// feature 是 Studio 的一级实体（ADR-0022）：状态机、验证账本、快照记账都在
// 这里，跨目录收敛为一份注册表；目录只是记录上的可变字段（运行环境）。
//
// 记录身份：id = 包名（legacy 模块无包名时用 feature 名），注册表内唯一。
// 目录移动：studio_add_feature 以同名新路径重新注册即视为移动，账本字段
// （status/verification/snapshot/staticInject）保留；状态有效性由源码指纹在
// 运行路径上另行判定，注册表不重复计算。
//
// 迁移（一次性、幂等）：schema ≤ 4 的旧"项目"档案（projects.json 注册表 +
// 各目录 agent-studio.json 的 features[]）转换为本注册表；已存在的记录以
// 注册表为准不被旧数据覆盖，保证中断重跑安全。projects.json 在会话重绑定
// 成功后由调用方删除（见 server/routes/studio-feature-migration.js）。

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { StudioFeatureEntry } from './project-store.js';
import {
  LEGACY_REGISTRY_FILE_NAME,
  getDefaultStatePath,
  normalizeFeatureEntry,
  readManifestFile,
  writeManifest,
} from './project-store.js';
import { cleanValue } from './clean-value.js';

export const FEATURE_REGISTRY_FILE_NAME = 'features.json';

export interface StudioFeatureRecord extends StudioFeatureEntry {
  /** 稳定身份 = 包名（legacy 模块无包名时用 feature 名） */
  id: string;
  /** 注册所在 Studio 目录（= 会话运行目录）；同名重注册可更新 */
  directory: string;
  /** 包描述（卡片展示用），注册时从 package.json 读取 */
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureRegistryPaths {
  registryPath: string;
  legacyRegistryPath: string;
}

export function getFeatureRegistryPaths(statePath?: string): FeatureRegistryPaths {
  const base = dirname(statePath || getDefaultStatePath());
  return {
    registryPath: join(base, FEATURE_REGISTRY_FILE_NAME),
    legacyRegistryPath: join(base, LEGACY_REGISTRY_FILE_NAME),
  };
}

export function featureRecordId(entry: Pick<StudioFeatureEntry, 'package' | 'name'>): string {
  return cleanValue(entry.package) || cleanValue(entry.name);
}

export function normalizeFeatureRecord(raw: unknown): StudioFeatureRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const entry = normalizeFeatureEntry(record as Partial<StudioFeatureEntry>);
  if (!entry) return null;
  const id = cleanValue(record.id) || featureRecordId(entry);
  const directory = cleanValue(record.directory);
  if (!id || !directory) return null;
  const createdAt = cleanValue(record.createdAt) || new Date().toISOString();
  return {
    ...entry,
    id,
    directory,
    description: cleanValue(record.description),
    createdAt,
    updatedAt: cleanValue(record.updatedAt) || createdAt,
  };
}

function normalizeDirectoryKey(directory: string): string {
  return directory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export async function readFeatureRegistry(statePath?: string): Promise<StudioFeatureRecord[]> {
  const { registryPath } = getFeatureRegistryPaths(statePath);
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const records: StudioFeatureRecord[] = [];
    for (const item of parsed) {
      const record = normalizeFeatureRecord(item);
      if (record && !seen.has(record.id)) {
        seen.add(record.id);
        records.push(record);
      }
    }
    return records;
  } catch {
    return [];
  }
}

export async function writeFeatureRegistry(statePath: string | undefined, records: StudioFeatureRecord[]): Promise<void> {
  const { registryPath } = getFeatureRegistryPaths(statePath);
  await fs.mkdir(dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

export function featuresInDirectory(records: StudioFeatureRecord[], directory: string): StudioFeatureRecord[] {
  const key = normalizeDirectoryKey(directory);
  return records.filter((record) => normalizeDirectoryKey(record.directory) === key);
}

/**
 * 注册/重注册一个 feature。已存在的同 id 记录保留账本字段
 * （status/verification/snapshot/staticInject/createdAt），身份字段
 * （directory/modulePath/package/export/source/description）以传入值为准。
 */
export async function registerFeatureRecord(
  statePath: string | undefined,
  entry: StudioFeatureEntry,
  directory: string,
  description = '',
): Promise<StudioFeatureRecord> {
  const id = featureRecordId(entry);
  const existing = (await readFeatureRegistry(statePath)).find((record) => record.id === id);
  const timestamp = new Date().toISOString();
  const next: StudioFeatureRecord = {
    ...entry,
    id,
    directory,
    description: description || existing?.description || '',
    createdAt: existing ? existing.createdAt : timestamp,
    ...(existing ? {
      status: existing.status,
      ...(existing.verification ? { verification: existing.verification } : {}),
      ...(existing.snapshot ? { snapshot: existing.snapshot } : {}),
      ...(existing.staticInject ? { staticInject: existing.staticInject } : {}),
    } : {}),
    updatedAt: timestamp,
  };
  await upsertFeatureRecords(statePath, [next]);
  return next;
}

/** 全值写入：状态推进/快照落账等"以计算结果为准"的写回路径。 */
export async function upsertFeatureRecords(
  statePath: string | undefined,
  updates: StudioFeatureRecord[],
): Promise<StudioFeatureRecord[]> {
  const records = await readFeatureRegistry(statePath);
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const update of updates) {
    byId.set(update.id, update);
  }
  const next = [...byId.values()];
  await writeFeatureRegistry(statePath, next);
  return next;
}

export async function removeFeatureRecord(
  statePath: string | undefined,
  id: string,
): Promise<StudioFeatureRecord[]> {
  const records = await readFeatureRegistry(statePath);
  const next = records.filter((record) => record.id !== id);
  await writeFeatureRegistry(statePath, next);
  return next;
}

// ── schema ≤ 4 → feature-first 迁移 ──────────────────────────

export interface LegacyMigrationResult {
  /** 是否发生了转换写入（false = 无 legacy 数据或已完成） */
  changed: boolean;
  /** 迁移覆盖到的目录（供会话重绑定按 openDirectory 匹配） */
  directories: string[];
  /** 跳过的损坏条目（目录不可读/档案不合法），不影响其余迁移 */
  skipped: string[];
}

interface LegacyRegistryEntry {
  projectDir?: string;
  directory?: string;
}

/**
 * 把 projects.json + 各目录 schema ≤ 4 档案迁移为 features.json，并把访问到的
 * 旧档案就地升级为 schema 5（剥离 features[] 与项目字段）。幂等：features.json
 * 已有的记录优先，不会被旧档案数据覆盖；projects.json 的删除由调用方在会话
 * 重绑定成功后执行（deleteLegacyProjectsRegistry）。
 */
export async function migrateLegacyRegistry(statePath?: string): Promise<LegacyMigrationResult> {
  const { registryPath, legacyRegistryPath } = getFeatureRegistryPaths(statePath);
  let legacyEntries: LegacyRegistryEntry[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(legacyRegistryPath, 'utf8')) as unknown;
    legacyEntries = Array.isArray(parsed) ? parsed as LegacyRegistryEntry[] : [];
  } catch {
    return { changed: false, directories: [], skipped: [] };
  }

  const records = await readFeatureRegistry(statePath);
  const byId = new Map(records.map((record) => [record.id, record]));
  const directories: string[] = [];
  const skipped: string[] = [];
  let changed = false;

  for (const entry of legacyEntries) {
    const directory = cleanValue(entry.projectDir) || cleanValue(entry.directory);
    if (!directory) continue;
    directories.push(directory);
    const parsed = await readManifestFile(directory);
    if (!parsed) {
      skipped.push(directory);
      continue;
    }
    for (const legacyFeature of parsed.legacyFeatures) {
      const id = featureRecordId(legacyFeature);
      if (!id || byId.has(id)) continue; // 注册表已有记录优先（重跑安全）
      const createdAt = new Date().toISOString();
      byId.set(id, { ...legacyFeature, id, directory, description: '', createdAt, updatedAt: createdAt });
      changed = true;
    }
    if (parsed.legacyFeatures.length > 0 || Number((parsed.raw as Record<string, unknown> | undefined)?.schemaVersion ?? 0) < 5) {
      // 就地升级 schema 5（剥离已迁移字段）
      await writeManifest(directory, { ...parsed.manifest, updatedAt: new Date().toISOString() });
    }
  }

  if (changed) {
    await writeFeatureRegistry(statePath, [...byId.values()]);
  } else if (directories.length > 0) {
    // 档案均已升级但注册表无新写入（例如全部记录已存在）：注册表文件缺失时也要落一份
    try { await fs.access(registryPath); } catch {
      await writeFeatureRegistry(statePath, [...byId.values()]);
    }
  }
  return { changed, directories, skipped };
}

/** 会话重绑定成功后由调用方执行；删除 legacy 注册表，迁移收口。 */
export async function deleteLegacyProjectsRegistry(statePath?: string): Promise<void> {
  const { legacyRegistryPath } = getFeatureRegistryPaths(statePath);
  await fs.rm(legacyRegistryPath, { force: true });
}
