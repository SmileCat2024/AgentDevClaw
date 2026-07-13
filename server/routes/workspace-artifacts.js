import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import { getPrebuiltWorkspaceArtifactsDir, getWorkspaceArtifactPath } from '../shared/session-access.js';

// ── Artifact helpers ─────────────────────────────────────────────────────────

export function cleanWorkspaceArtifactPayload(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return value.length > 0;
        return true;
      }),
  );
}

export function normalizeWorkspaceArtifact(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const relatedToSource = source.relatedTo && typeof source.relatedTo === 'object' ? source.relatedTo : {};
  const normalizedId = sanitizeSessionFragment(source.id || source.title || randomUUID());

  return {
    id: normalizedId,
    kind: typeof source.kind === 'string' && source.kind.trim() ? source.kind.trim() : 'artifact',
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : normalizedId,
    status: typeof source.status === 'string' && source.status.trim() ? source.status.trim() : 'active',
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : null,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : null,
    source: source.source && typeof source.source === 'object' ? source.source : {},
    relatedTo: {
      openDirectory: typeof relatedToSource.openDirectory === 'string' ? relatedToSource.openDirectory.trim() : '',
      sessionId: typeof relatedToSource.sessionId === 'string' ? relatedToSource.sessionId.trim() : '',
      parentId: typeof relatedToSource.parentId === 'string' ? relatedToSource.parentId.trim() : '',
    },
    payload: cleanWorkspaceArtifactPayload(source.payload),
  };
}

export function buildFeatureCreatorDraftArtifact(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const payload = cleanWorkspaceArtifactPayload({
    feature_name: startupForm.feature_name,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    install_mode: startupForm.install_mode,
    target_dir: startupForm.target_dir,
  });
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';
  const featureName = typeof payload.feature_name === 'string' ? payload.feature_name : '';
  const targetDir = typeof payload.target_dir === 'string' ? payload.target_dir : '';
  const stableKey = openDirectory || [featureName, targetDir].filter(Boolean).join('@');

  if (!stableKey) {
    return null;
  }

  return normalizeWorkspaceArtifact({
    id: `feature-creator-draft-${stableKey}`,
    kind: 'draft',
    title: featureName ? `创建 ${featureName}` : 'Feature 创建草稿',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      workspace: 'feature-creator',
      formId: 'startup-form',
    },
    relatedTo: {
      openDirectory,
      sessionId: '',
      parentId: '',
    },
    payload,
  });
}

export function buildAgentCreatorDraftArtifact(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const payload = cleanWorkspaceArtifactPayload({
    agent_name: startupForm.agent_name,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    install_mode: startupForm.install_mode,
    target_dir: startupForm.target_dir,
    target_user: startupForm.target_user,
    runtime_style: startupForm.runtime_style,
    planned_features: startupForm.planned_features,
  });
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';
  const agentName = typeof payload.agent_name === 'string' ? payload.agent_name : '';
  const targetDir = typeof payload.target_dir === 'string' ? payload.target_dir : '';
  const stableKey = openDirectory || [agentName, targetDir].filter(Boolean).join('@');

  if (!stableKey) {
    return null;
  }

  return normalizeWorkspaceArtifact({
    id: `agent-creator-draft-${stableKey}`,
    kind: 'draft',
    title: agentName ? `创建 ${agentName}` : 'Agent 创建草稿',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      workspace: 'agent-creator',
      formId: 'startup-form',
    },
    relatedTo: {
      openDirectory,
      sessionId: '',
      parentId: '',
    },
    payload,
  });
}

export function buildProgrammingHelperDraftArtifact(state, timestamp) {
  return null;
}

export async function writeWorkspaceArtifact(agentId, rawArtifact) {
  const artifact = normalizeWorkspaceArtifact(rawArtifact);
  const artifactPath = getWorkspaceArtifactPath(agentId, artifact.id);
  let createdAt = artifact.createdAt;

  try {
    const existing = normalizeWorkspaceArtifact(await readJson(artifactPath));
    createdAt = existing.createdAt || createdAt;
  } catch {
    // New artifact file.
  }

  const nextArtifact = {
    ...artifact,
    createdAt: createdAt || artifact.updatedAt || new Date().toISOString(),
  };

  await ensureDir(getPrebuiltWorkspaceArtifactsDir(agentId));
  await fs.writeFile(artifactPath, JSON.stringify(nextArtifact, null, 2), 'utf8');
  return nextArtifact;
}

export async function listWorkspaceArtifacts(agentId) {
  const artifactsDir = getPrebuiltWorkspaceArtifactsDir(agentId);

  try {
    const entries = await fs.readdir(artifactsDir, { withFileTypes: true });
    const artifacts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        const artifactPath = path.join(artifactsDir, entry.name);
        const artifact = normalizeWorkspaceArtifact(await readJson(artifactPath));
        return {
          ...artifact,
          path: artifactPath,
        };
      }));

    artifacts.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    return {
      artifacts,
      artifactsDir,
    };
  } catch {
    return {
      artifacts: [],
      artifactsDir,
    };
  }
}

export async function summarizeWorkspaceArtifacts(agentId, options = {}) {
  const { artifacts, artifactsDir } = await listWorkspaceArtifacts(agentId);
  const allowedKinds = Array.isArray(options.kinds)
    ? new Set(options.kinds.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 8;
  const openDirectoryFilter = String(options.openDirectory || '').trim().toLowerCase();
  let filtered = allowedKinds
    ? artifacts.filter((artifact) => allowedKinds.has(String(artifact.kind || '').trim()))
    : artifacts;

  if (openDirectoryFilter) {
    const scoped = filtered.filter((artifact) => String(artifact?.relatedTo?.openDirectory || '').trim().toLowerCase() === openDirectoryFilter);
    if (scoped.length > 0) {
      filtered = scoped;
    }
  }

  return {
    type: 'workspace-artifacts',
    workspaceId: sanitizeSessionFragment(agentId),
    artifactsDir,
    artifactCount: filtered.length,
    latestUpdatedAt: filtered[0]?.updatedAt || null,
    items: filtered.slice(0, limit).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      updatedAt: artifact.updatedAt,
      createdAt: artifact.createdAt,
      source: artifact.source || {},
      relatedTo: artifact.relatedTo || {},
      payload: artifact.payload || {},
    })),
  };
}

export async function summarizeWorkspaceArtifactsCollection(agentIds, options = {}) {
  const results = await Promise.all((Array.isArray(agentIds) ? agentIds : []).map(async (workspaceId) => {
    const summary = await summarizeWorkspaceArtifacts(workspaceId, {
      ...options,
      openDirectory: '',
    });
    return {
      workspaceId: sanitizeSessionFragment(workspaceId),
      items: Array.isArray(summary.items) ? summary.items : [],
    };
  }));

  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 10;
  const items = results
    .flatMap((entry) => entry.items.map((item) => ({
      ...item,
      source: {
        ...(item.source && typeof item.source === 'object' ? item.source : {}),
        workspace: entry.workspaceId,
      },
    })))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, limit);

  return {
    type: 'workspace-artifacts',
    workspaceId: 'aggregate',
    artifactsDir: '',
    artifactCount: items.length,
    latestUpdatedAt: items[0]?.updatedAt || null,
    items,
  };
}
