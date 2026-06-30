import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { PROJECT_ROOT, USER_FEATURE_REPOSITORY_ROOT } from '../shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, parseListField, getAssemblyWorkspaceDir } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import {
  getPrebuiltWorkspaceDir,
  getPrebuiltWorkspaceStatePath,
  getPrebuiltWorkspaceArtifactsDir,
  getWorkspaceArtifactPath,
  readSessionIndex,
} from '../shared/session-access.js';
import { syncWorkspaceProjectDocset, summarizeProjectDocset } from './project-docset.js';
import { summarizeFeatureRepository, mergeFeatureRepositoryPackages } from './feature-repository.js';

// ── State normalization ──────────────────────────────────────────────────────

export function normalizeFeatureConfigs(rawConfigs) {
  if (!rawConfigs || typeof rawConfigs !== 'object') return {};
  const result = {};
  for (const [featureKey, config] of Object.entries(rawConfigs)) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      result[String(featureKey)] = Object.fromEntries(
        Object.entries(config).map(([k, v]) => [String(k), v]),
      );
    }
  }
  return result;
}

export function normalizeWorkspaceState(raw = {}) {
  const rawForms = raw && typeof raw.forms === 'object' && raw.forms ? raw.forms : {};
  const featureConfigs = normalizeFeatureConfigs(rawForms['feature-configs']);
  const forms = Object.fromEntries(Object.entries(rawForms).map(([formId, value]) => {
    if (formId === 'feature-configs') return [formId, featureConfigs];
    return [
      String(formId),
      value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([field, fieldValue]) => [String(field), String(fieldValue ?? '')])) : {},
    ];
  }));
  const assemblyForm = forms['assembly-form'] && typeof forms['assembly-form'] === 'object'
    ? forms['assembly-form']
    : {};
  const assemblyConfigs = Array.isArray(raw?.assemblyConfigs)
    ? raw.assemblyConfigs.map((item) => ({
        id: cleanSessionText(item?.id),
        name: cleanSessionText(item?.name),
        displayName: cleanSessionText(item?.displayName),
        preset: cleanSessionText(item?.preset),
        goal: cleanSessionText(item?.goal),
        targetUser: cleanSessionText(item?.targetUser),
        features: Array.isArray(item?.features) ? item.features.map((value) => cleanSessionText(value)).filter(Boolean) : [],
        toolkits: Array.isArray(item?.toolkits) ? item.toolkits.map((value) => cleanSessionText(value)).filter(Boolean) : [],
        constraints: cleanSessionText(item?.constraints),
        customSystemPrompt: cleanSessionText(item?.customSystemPrompt),
        envDir: cleanSessionText(item?.envDir),
        envConfiguredName: cleanSessionText(item?.envConfiguredName),
        envConfiguredFeatures: Array.isArray(item?.envConfiguredFeatures) ? item.envConfiguredFeatures.map((value) => cleanSessionText(value)).filter(Boolean) : [],
        envStatus: cleanSessionText(item?.envStatus),
        envStatusMessage: cleanSessionText(item?.envStatusMessage),
        modelPreset: cleanSessionText(item?.modelPreset),
        workdir: cleanSessionText(item?.workdir),
        featureConfigs: normalizeFeatureConfigs(item?.featureConfigs),
        createdAt: cleanSessionText(item?.createdAt),
        updatedAt: cleanSessionText(item?.updatedAt),
      })).filter((item) => item.id)
        .reduce((acc, item) => {
          const matchesDraft = item.id === cleanSessionText(assemblyForm?.editing_config_id)
            || item.id === cleanSessionText(assemblyForm?.assembly_name);
          const nextItem = matchesDraft ? {
            ...item,
            envDir: assemblyForm.env_dir !== undefined ? cleanSessionText(assemblyForm.env_dir) : item.envDir,
            envConfiguredName: assemblyForm.env_configured_name !== undefined ? cleanSessionText(assemblyForm.env_configured_name) : item.envConfiguredName,
            envConfiguredFeatures: assemblyForm.env_configured_features !== undefined
              ? parseListField(assemblyForm.env_configured_features)
              : item.envConfiguredFeatures,
            envStatus: assemblyForm.env_status !== undefined ? cleanSessionText(assemblyForm.env_status) : item.envStatus,
            envStatusMessage: assemblyForm.env_status_message !== undefined ? cleanSessionText(assemblyForm.env_status_message) : item.envStatusMessage,
            featureConfigs,
          } : item;
          if (!acc.some((existing) => existing.id === item.id)) {
            acc.push(nextItem);
          }
          return acc;
        }, [])
    : [];
  const featureProjects = Array.isArray(raw?.featureProjects)
    ? raw.featureProjects.map((project) => normalizeWorkspaceFeatureProject(project)).filter(Boolean)
    : [];
  const agentProjects = Array.isArray(raw?.agentProjects)
    ? raw.agentProjects.map((project) => normalizeWorkspaceAgentProject(project)).filter(Boolean)
    : [];
  const phProjects = Array.isArray(raw?.phProjects)
    ? raw.phProjects.map((p) => normalizeWorkspacePhProject(p)).filter(Boolean)
    : [];

  return {
    forms,
    assemblyConfigs,
    featureProjects,
    agentProjects,
    phProjects,
    openDirectory: typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

// ── Artifact helpers ─────────────────────────────────────────────────────────

function cleanWorkspaceArtifactPayload(raw = {}) {
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

function normalizeWorkspaceArtifact(raw = {}) {
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

function buildFeatureCreatorDraftArtifact(state, timestamp) {
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

function buildAgentCreatorDraftArtifact(state, timestamp) {
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

function buildProgrammingHelperDraftArtifact(state, timestamp) {
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

async function listWorkspaceArtifacts(agentId) {
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

async function summarizeWorkspaceArtifacts(agentId, options = {}) {
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

async function summarizeWorkspaceArtifactsCollection(agentIds, options = {}) {
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

// ── Project normalization ────────────────────────────────────────────────────

export function normalizeWorkspaceFeatureProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  const featureName = typeof raw.featureName === 'string' ? raw.featureName.trim() : '';
  const targetDir = typeof raw.targetDir === 'string' ? raw.targetDir.trim() : '';
  const installMode = raw.installMode === 'custom' ? 'custom' : 'system';
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  const constraints = typeof raw.constraints === 'string' ? raw.constraints.trim() : '';
  const id = buildWorkspaceFeatureProjectId({ openDirectory, featureName, targetDir });

  if (!id) return null;

  return {
    id,
    featureName,
    installMode,
    targetDir,
    openDirectory,
    goal,
    constraints,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function normalizeWorkspaceAgentProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  const agentName = typeof raw.agentName === 'string' ? raw.agentName.trim() : '';
  const targetDir = typeof raw.targetDir === 'string' ? raw.targetDir.trim() : '';
  const installMode = raw.installMode === 'custom' ? 'custom' : 'system';
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  const constraints = typeof raw.constraints === 'string' ? raw.constraints.trim() : '';
  const targetUser = typeof raw.targetUser === 'string' ? raw.targetUser.trim() : '';
  const runtimeStyle = typeof raw.runtimeStyle === 'string' ? raw.runtimeStyle.trim() : '';
  const plannedFeatures = typeof raw.plannedFeatures === 'string' ? raw.plannedFeatures.trim() : '';
  const id = buildWorkspaceAgentProjectId({ openDirectory, agentName, targetDir });

  if (!id) return null;

  return {
    id,
    agentName,
    installMode,
    targetDir,
    openDirectory,
    goal,
    constraints,
    targetUser,
    runtimeStyle,
    plannedFeatures,
    managedBy: typeof raw.managedBy === 'string' ? raw.managedBy.trim() : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function normalizeWorkspacePhProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  if (!openDirectory) return null;
  return {
    id: 'dir:' + openDirectory.replace(/\\/g, '/').toLowerCase(),
    openDirectory,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function buildWorkspaceFeatureProjectId(project = {}) {
  const openDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim() : '';
  if (openDirectory) {
    return `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
  }

  const featureName = typeof project.featureName === 'string' ? project.featureName.trim().toLowerCase() : '';
  const targetDir = typeof project.targetDir === 'string' ? project.targetDir.trim().replace(/\\/g, '/').toLowerCase() : '';
  if (featureName && targetDir) {
    return `feature:${featureName}@${targetDir}`;
  }
  if (featureName) {
    return `feature:${featureName}`;
  }
  return '';
}

function buildWorkspaceAgentProjectId(project = {}) {
  const openDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim() : '';
  if (openDirectory) {
    return `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
  }

  const agentName = typeof project.agentName === 'string' ? project.agentName.trim().toLowerCase() : '';
  const targetDir = typeof project.targetDir === 'string' ? project.targetDir.trim().replace(/\\/g, '/').toLowerCase() : '';
  if (agentName && targetDir) {
    return `agent:${agentName}@${targetDir}`;
  }
  if (agentName) {
    return `agent:${agentName}`;
  }
  return '';
}

// ── Project CRUD ─────────────────────────────────────────────────────────────

function upsertWorkspaceFeatureProject(state, rawProject, timestamp) {
  const project = normalizeWorkspaceFeatureProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) {
    return state;
  }

  const projects = Array.isArray(state.featureProjects) ? [...state.featureProjects] : [];
  const existingIndex = projects.findIndex((item) => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };

  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }

  projects.sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  return {
    ...state,
    featureProjects: projects,
  };
}

function upsertWorkspaceAgentProject(state, rawProject, timestamp) {
  const project = normalizeWorkspaceAgentProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) {
    return state;
  }

  const projects = Array.isArray(state.agentProjects) ? [...state.agentProjects] : [];
  const existingIndex = projects.findIndex((item) => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };

  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }

  projects.sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  return {
    ...state,
    agentProjects: projects,
  };
}

export function upsertWorkspacePhProject(state, rawProject, timestamp) {
  const project = normalizeWorkspacePhProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) return state;
  const projects = Array.isArray(state.phProjects) ? [...state.phProjects] : [];
  const existingIndex = projects.findIndex((item) => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };
  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }
  projects.sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  return { ...state, phProjects: projects };
}

export function removeWorkspacePhProject(state, projectId) {
  const projects = Array.isArray(state.phProjects)
    ? state.phProjects.filter((p) => p.id !== projectId)
    : [];
  return { ...state, phProjects: projects };
}

// ── Project sync ─────────────────────────────────────────────────────────────

function syncFeatureCreatorProjects(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const featureName = typeof startupForm.feature_name === 'string' ? startupForm.feature_name.trim() : '';
  const targetDir = typeof startupForm.target_dir === 'string' ? startupForm.target_dir.trim() : '';
  const goal = typeof startupForm.goal === 'string' ? startupForm.goal.trim() : '';
  const constraints = typeof startupForm.constraints === 'string' ? startupForm.constraints.trim() : '';
  const installMode = startupForm.install_mode === 'custom' ? 'custom' : 'system';
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';

  if (!featureName && !openDirectory) {
    return state;
  }

  return upsertWorkspaceFeatureProject(state, {
    featureName,
    targetDir,
    goal,
    constraints,
    installMode,
    openDirectory,
  }, timestamp);
}

function syncAgentCreatorProjects(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const agentName = typeof startupForm.agent_name === 'string' ? startupForm.agent_name.trim() : '';
  const targetDir = typeof startupForm.target_dir === 'string' ? startupForm.target_dir.trim() : '';
  const goal = typeof startupForm.goal === 'string' ? startupForm.goal.trim() : '';
  const constraints = typeof startupForm.constraints === 'string' ? startupForm.constraints.trim() : '';
  const targetUser = typeof startupForm.target_user === 'string' ? startupForm.target_user.trim() : '';
  const runtimeStyle = typeof startupForm.runtime_style === 'string' ? startupForm.runtime_style.trim() : '';
  const plannedFeatures = typeof startupForm.planned_features === 'string' ? startupForm.planned_features.trim() : '';
  const installMode = startupForm.install_mode === 'custom' ? 'custom' : 'system';
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';

  if (!agentName && !openDirectory) {
    return state;
  }

  return upsertWorkspaceAgentProject(state, {
    agentName,
    targetDir,
    goal,
    constraints,
    targetUser,
    runtimeStyle,
    plannedFeatures,
    installMode,
    openDirectory,
  }, timestamp);
}

function syncFlowAssemblyProjects(state, timestamp) {
  const assemblyConfigs = Array.isArray(state?.assemblyConfigs) ? state.assemblyConfigs : [];
  const retainedProjects = Array.isArray(state?.agentProjects)
    ? state.agentProjects.filter((project) => String(project?.managedBy || '').trim() !== 'assembly-config')
    : [];
  let nextState = {
    ...state,
    agentProjects: retainedProjects,
  };

  for (const config of assemblyConfigs) {
    const agentName = cleanSessionText(config?.name || config?.id);
    if (!agentName) continue;
    const openDirectory = cleanSessionText(config?.envDir) || getAssemblyWorkspaceDir(agentName);
    nextState = upsertWorkspaceAgentProject(nextState, {
      agentName,
      installMode: 'system',
      targetDir: openDirectory ? path.dirname(openDirectory) : '',
      openDirectory,
      goal: cleanSessionText(config?.goal),
      constraints: cleanSessionText(config?.constraints),
      targetUser: cleanSessionText(config?.targetUser),
      runtimeStyle: cleanSessionText(config?.preset) || 'assembly',
      plannedFeatures: Array.isArray(config?.features) ? config.features.join('\n') : '',
      managedBy: 'assembly-config',
    }, timestamp);
  }

  return nextState;
}

// ── Read / write core ────────────────────────────────────────────────────────

const _wsCache = new Map();

export async function readWorkspaceState(agentId) {
  const key = sanitizeSessionFragment(agentId);
  const cached = _wsCache.get(key);
  if (cached && Date.now() - cached.ts < 5000) return cached.data;
  try {
    let data = normalizeWorkspaceState(await readJson(getPrebuiltWorkspaceStatePath(key)));
    if (key === 'programming-helper' && data.forms && data.forms['startup-form']) {
      delete data.forms['startup-form'];
      writeWorkspaceState(key, data).catch(() => {});
      _wsCache.delete(key);
    }
    if (key === 'programming-helper' && (!Array.isArray(data.phProjects) || data.phProjects.length === 0)) {
      const sessionIndex = await readSessionIndex(key);
      const directories = new Map();
      for (const session of (sessionIndex?.sessions || [])) {
        const dir = String(session.openDirectory || '').trim();
        if (dir && !directories.has(dir.replace(/\\/g, '/').toLowerCase())) {
          directories.set(dir.replace(/\\/g, '/').toLowerCase(), {
            openDirectory: dir,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          });
        }
      }
      if (directories.size > 0) {
        const timestamp = new Date().toISOString();
        data.phProjects = Array.from(directories.values()).map(d =>
          normalizeWorkspacePhProject({ ...d, createdAt: d.createdAt || timestamp, updatedAt: d.updatedAt || timestamp })
        ).filter(Boolean);
        writeWorkspaceState(key, data).catch(() => {});
        _wsCache.delete(key);
      }
    }
    // Auto-set openDirectory to most recently used project if empty
    if (key === 'programming-helper' && !data.openDirectory && Array.isArray(data.phProjects) && data.phProjects.length > 0) {
      const sorted = [...data.phProjects].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      data.openDirectory = sorted[0].openDirectory || '';
      if (data.openDirectory) {
        writeWorkspaceState(key, data).catch(() => {});
        _wsCache.delete(key);
      }
    }
    _wsCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    const data = normalizeWorkspaceState({});
    _wsCache.set(key, { data, ts: Date.now() });
    return data;
  }
}

export async function writeWorkspaceState(agentId, rawState) {
  const timestamp = new Date().toISOString();
  const nextState = normalizeWorkspaceState({
    ...await readWorkspaceState(agentId),
    ...(rawState || {}),
    updatedAt: timestamp,
  });
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const resolvedState = normalizedAgentId === 'feature-creator'
    ? syncFeatureCreatorProjects(nextState, timestamp)
    : (normalizedAgentId === 'agent-creator'
      ? syncAgentCreatorProjects(nextState, timestamp)
      : (normalizedAgentId === 'flow-workspace'
        ? syncFlowAssemblyProjects(nextState, timestamp)
        : nextState));
  await ensureDir(getPrebuiltWorkspaceDir(agentId));
  await fs.writeFile(getPrebuiltWorkspaceStatePath(agentId), JSON.stringify(resolvedState, null, 2), 'utf8');

  if (sanitizeSessionFragment(agentId) === 'feature-creator') {
    const draftArtifact = buildFeatureCreatorDraftArtifact(resolvedState, timestamp);
    if (draftArtifact) {
      await writeWorkspaceArtifact(agentId, draftArtifact);
    }
  } else if (sanitizeSessionFragment(agentId) === 'agent-creator') {
    const draftArtifact = buildAgentCreatorDraftArtifact(resolvedState, timestamp);
    if (draftArtifact) {
      await writeWorkspaceArtifact(agentId, draftArtifact);
    }
  } else if (sanitizeSessionFragment(agentId) === 'programming-helper') {
    const draftArtifact = buildProgrammingHelperDraftArtifact(resolvedState, timestamp);
    if (draftArtifact) {
      await writeWorkspaceArtifact(agentId, draftArtifact);
    }
  }

  await syncWorkspaceProjectDocset(agentId, resolvedState, timestamp).catch(() => null);

  _wsCache.set(normalizedAgentId, { data: resolvedState, ts: Date.now() });
  return resolvedState;
}

// ── Data aggregation ─────────────────────────────────────────────────────────

async function summarizeDirectorySource(rawPath) {
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(PROJECT_ROOT, rawPath);

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return {
        path: resolvedPath,
        exists: false,
        type: 'directory-summary',
        error: 'Not a directory',
        skillCount: 0,
        entryCount: 0,
        sampleNames: [],
        updatedAt: null,
      };
    }

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const directoryEntries = entries.filter((entry) => entry.isDirectory());
    const skillDirChecks = await Promise.all(directoryEntries.map(async (entry) => {
      try {
        await fs.stat(path.join(resolvedPath, entry.name, 'SKILL.md'));
        return entry.name;
      } catch {
        return null;
      }
    }));

    return {
      path: resolvedPath,
      exists: true,
      type: 'directory-summary',
      skillCount: skillDirChecks.filter(Boolean).length,
      entryCount: entries.length,
      sampleNames: skillDirChecks.filter(Boolean).slice(0, 6),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: false,
      type: 'directory-summary',
      error: error && error.message ? error.message : String(error),
      skillCount: 0,
      entryCount: 0,
      sampleNames: [],
      updatedAt: null,
    };
  }
}

export async function resolveWorkspaceData(agent) {
  const blocks = Array.isArray(agent?.ui?.home?.blocks) ? agent.ui.home.blocks : [];
  const workspaceState = await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
  const entries = await Promise.all(blocks.map(async (block) => {
    if (!block?.id) {
      return null;
    }

    const data = {};

    if (block.directorySummary?.path) {
      Object.assign(data, await summarizeDirectorySource(block.directorySummary.path));
    }

    if (block.featureRepository?.path) {
      const officialData = await summarizeFeatureRepository(block.featureRepository.path, 'official');
      const customData = await summarizeFeatureRepository(USER_FEATURE_REPOSITORY_ROOT, 'custom');
      const allPackages = mergeFeatureRepositoryPackages(officialData, customData);
      Object.assign(data, {
        path: officialData.path,
        exists: officialData.exists || customData.exists,
        type: 'feature-repository',
        packageCount: allPackages.length,
        archiveCount: (officialData.archiveCount || 0) + (customData.archiveCount || 0),
        missingManifestCount: (officialData.missingManifestCount || 0) + (customData.missingManifestCount || 0),
        officialCount: officialData.packages ? officialData.packages.length : 0,
        customCount: customData.packages ? customData.packages.length : 0,
        updatedAt: [officialData.updatedAt, customData.updatedAt].filter(Boolean).sort().pop() || null,
        packages: allPackages,
      });
    }

    if (block.workspaceArtifacts) {
      if (Array.isArray(block.workspaceArtifacts.workspaces) && block.workspaceArtifacts.workspaces.length > 0) {
        Object.assign(data, await summarizeWorkspaceArtifactsCollection(block.workspaceArtifacts.workspaces, block.workspaceArtifacts));
      } else {
        Object.assign(data, await summarizeWorkspaceArtifacts(agent.id, {
          ...block.workspaceArtifacts,
          openDirectory: workspaceState?.openDirectory || '',
        }));
      }
    }

    if (block.projectDocset) {
      Object.assign(data, await summarizeProjectDocset(workspaceState?.openDirectory || '', {
        ...block.projectDocset,
        currentSessionId: agent?.workspace_sessions?.activeSessionId || agent?.active_workspace_session_id || '',
      }));
    }

    if (block.installDefaults?.type === 'feature-creator') {
      data.systemInstallRoot = path.join(os.homedir(), '.agentdev', 'feature-dev');
    } else if (block.installDefaults?.type === 'agent-creator') {
      data.systemInstallRoot = path.join(os.homedir(), '.agentdev', 'agent-dev');
    }

    return Object.keys(data).length > 0 ? [block.id, data] : null;
  }));

  return Object.fromEntries(entries.filter(Boolean));
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function setupWorkspaceRoutes(app, express) {
  app.get('/protoclaw/workspace_state', async (req, res, next) => {
    try {
      if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      res.json(await readWorkspaceState(req.query.agentId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/workspace_artifacts', async (req, res, next) => {
    try {
      if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      res.json(await listWorkspaceArtifacts(req.query.agentId));
    } catch (error) {
      next(error);
    }
  });

  app.put('/protoclaw/workspace_state', express.json(), async (req, res, next) => {
    try {
      if (typeof req.body?.agentId !== 'string' || !req.body.agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      const state = await writeWorkspaceState(req.body.agentId, req.body.state || {});
      res.json(state);
    } catch (error) {
      next(error);
    }
  });
}
