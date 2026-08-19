import path from 'path';
import { existsSync, promises as fs } from 'fs';

import { USER_AGENT_REGISTRY_PATH, PROJECT_ROOT } from '../shared/constants.js';
import { normalizeAgentMetadata } from './schemas.js';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch { return fallback; }
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clean(raw.id);
  const projectDir = clean(raw.projectDir);
  const metadataPath = clean(raw.metadataPath);
  if (!id || !projectDir || !metadataPath) return null;
  const studioProjectDir = clean(raw.studioProjectDir);
  return { id, projectDir, metadataPath, ...(studioProjectDir ? { studioProjectDir } : {}), registeredAt: clean(raw.registeredAt), updatedAt: clean(raw.updatedAt) };
}

export async function listRegisteredAgents({ registryPath = USER_AGENT_REGISTRY_PATH } = {}) {
  const parsed = await readJson(registryPath, { agents: [] });
  const agents = Array.isArray(parsed?.agents) ? parsed.agents.map(normalizeRecord).filter(Boolean) : [];
  return agents.sort((left, right) => left.id.localeCompare(right.id));
}

export async function getRegisteredAgent(id, options = {}) {
  const normalizedId = clean(id);
  return (await listRegisteredAgents(options)).find((agent) => agent.id === normalizedId) || null;
}

export async function registerAgentProject({ projectDir, metadataPath, studioProjectDir = '', registryPath = USER_AGENT_REGISTRY_PATH } = {}) {
  const root = path.resolve(clean(projectDir));
  if (!root || !existsSync(root)) throw new Error(`Agent 项目目录不存在：${projectDir}`);
  const resolvedMetadataPath = metadataPath ? path.resolve(clean(metadataPath)) : path.join(root, 'metadata.json');
  const raw = await readJson(resolvedMetadataPath, null);
  if (!raw) throw new Error(`无法读取 Agent metadata：${resolvedMetadataPath}`);
  const metadata = normalizeAgentMetadata(raw, { requireFeatureVersions: true });
  if (metadata.deployment.kind !== 'standalone') {
    throw new Error(`只能注册 deployment.kind=standalone 的独立 Agent；${metadata.id} 当前为 ${metadata.deployment.kind}。`);
  }
  const entryPath = path.resolve(root, metadata.entry);
  if (!existsSync(entryPath)) throw new Error(`Agent entry 不存在：${entryPath}`);
  if (existsSync(path.join(PROJECT_ROOT, 'agents', metadata.id, 'agent.js'))) {
    throw new Error(`Agent ID ${metadata.id} 与内建 plain Agent 冲突；请选择其他 metadata.id。`);
  }
  const normalizedStudioDir = clean(studioProjectDir) ? path.resolve(clean(studioProjectDir)) : '';
  if (normalizedStudioDir && !existsSync(path.join(normalizedStudioDir, 'agent-studio.json'))) {
    throw new Error(`Studio 项目不存在 agent-studio.json：${normalizedStudioDir}`);
  }
  const existing = await listRegisteredAgents({ registryPath });
  const conflicting = existing.find((item) => item.id === metadata.id && path.resolve(item.projectDir) !== root);
  if (conflicting) throw new Error(`Agent ID ${metadata.id} 已注册到其他项目：${conflicting.projectDir}`);
  const now = new Date().toISOString();
  const record = {
    id: metadata.id,
    projectDir: root,
    metadataPath: resolvedMetadataPath,
    ...(normalizedStudioDir ? { studioProjectDir: normalizedStudioDir } : {}),
    registeredAt: existing.find((item) => item.id === metadata.id)?.registeredAt || now,
    updatedAt: now,
  };
  const next = [...existing.filter((item) => item.id !== metadata.id), record].sort((left, right) => left.id.localeCompare(right.id));
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, agents: next }, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, registryPath);
  return record;
}

export async function unregisterAgentProject(id, { registryPath = USER_AGENT_REGISTRY_PATH } = {}) {
  const existing = await listRegisteredAgents({ registryPath });
  const target = existing.find((item) => item.id === clean(id));
  if (!target) throw new Error(`未注册独立 Agent：${id}`);
  const next = existing.filter((item) => item.id !== target.id);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, agents: next }, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, registryPath);
  return target;
}
