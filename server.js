import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { ViewerWorker } from 'agentdev';
import {
  exportHistoryOnlyHandoffPackage,
  readHandoffPackage,
} from './server/context-continuity/handoff-package.js';
import { exportSummarizedHandoffPackage, writeSummarizedHandoffPackage } from './server/context-continuity/summarized-handoff.js';
import { ClawMCPServer } from './server/claw-mcp.js';
import {
  getRuntimeInboxSnapshot,
  getRuntimeExecutionState,
  listRuntimeExecutionStates,
  findEnvelopeById,
  findEnvelopesBySourceRef,
} from './server/runtime-call-envelope.js';
import { renderConversationHtml } from './server/conversation-renderer.js';

// ── Phase 0: shared infrastructure ────────────────────────────────
import {
  PROJECT_ROOT, rootRequire, APP_PORT, VIEWER_PORT,
  AGENTS_ROOT, RUNTIME_SCRIPT, ONE_SHOT_SCRIPT,
  AGENTDEV_ROOT, AGENTDEV_CREATE_FEATURE_CLI, VIEWER_ORIGIN,
  USER_DATA_ROOT, NO_SESSION_TOKEN,
  PREBUILT_SESSIONS_ROOT, PREBUILT_WORKSPACES_ROOT,
  PROJECT_QQBOT_CONFIG_PATH, PROJECT_WEIXIN_CONFIG_PATH,
  PROJECT_FEISHU_CONFIG_PATH, PROJECT_WECOM_CONFIG_PATH,
  PROJECT_IM_WORKSPACE_CONFIG_PATH,
  FEATURE_REPOSITORY_ROOT, USER_FEATURE_REPOSITORY_ROOT,
  FEATURE_MANIFEST_NAME, GROUP_CHATS_ROOT,
  WORKSPACE_SESSION_AGENT_IDS, HIDDEN_PREBUILT_AGENT_IDS,
  PROJECT_DOCSET_SUBPATH, MODEL_CONFIG_PATH, MODEL_PRESETS_PATH,
  APP_ORIGIN,
} from './server/shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent, log } from './server/shared/string-helpers.js';
import { readJson, readJsonSafe, ensureDir } from './server/shared/fs-helpers.js';
import {
  managedAgents, assemblyRuntimeProcesses,
  getManagedRuntimeKey, listAgentRuntimes, pickPrimaryAgentRuntime,
  getAgentRuntime, getAssemblyRuntime, stopAssemblyRuntime, buildStatus,
} from './server/shared/agent-access.js';
import {
  getPrebuiltAgentSessionDir, getPrebuiltSessionFilePath, getPrebuiltSessionIndexPath,
  getPrebuiltWorkspaceDir, getPrebuiltWorkspaceStatePath, getPrebuiltWorkspaceArtifactsDir,
  getWorkspaceArtifactPath,
  getProjectDocsetDir, getProjectDocsetProjectPath, getProjectDocsetFormsDir,
  getProjectDocsetMaterialsDir, getProjectDocsetConversationsDir,
  readSessionIndex, resolvePrebuiltSessionType,
  writeSessionIndex, updateSessionIndex,
  buildSessionTitle, normalizeSessionMetadata, readSessionIndexSync,
} from './server/shared/session-access.js';
import { sendIPCtoSession } from './server/shared/ipc.js';
import { proxyToViewer } from './server/shared/proxy.js';
import { notifyRuntimeReady } from './server/shared/runtime-hooks.js';

// ── Phase 1: domain route modules ────────────────────────────────
import { setupSystemFeatureConfigRoutes } from './server/routes/system-feature-config.js';
import { setupFsOperationsRoutes, runCommand } from './server/routes/fs-operations.js';
import {
  setupModelConfigRoutes,
  readModelConfig, writeModelConfig,
  readModelPresets, writeModelPresetsFile,
  resolveSessionModelInfo,
} from './server/routes/model-config.js';
import { setupGroupChatRoutes } from './server/routes/group-chat.js';
import { setupDispatchRoutes, getProjectAdapter, fireBootSchedules } from './server/routes/dispatch.js';
import { setupIMRoutes, readProjectIMWorkspaceConfig, getPortalAgentDisplayName } from './server/routes/im.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const viewerWorker = new ViewerWorker(VIEWER_PORT, false, process.env.AGENTDEV_UDS_PATH);
const clawMcp = new ClawMCPServer();
const pendingFeatureImports = new Map();

function isValidFeatureName(value) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(value || '').trim());
}

function resolveFeatureCreatorOutputDir(parentDir, featureName) {
  return path.join(path.resolve(String(parentDir || '').trim()), String(featureName || '').trim());
}

function getAssemblyWorkspaceDir(assemblyName) {
  return path.join(os.homedir(), '.agentdev', 'agent-dev', sanitizeSessionFragment(assemblyName));
}

function parseListField(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeSpawnEnv(inputEnv) {
  return Object.fromEntries(
    Object.entries(inputEnv || {}).filter(([key, value]) => {
      return typeof key === 'string' && key.length > 0 && value != null;
    }).map(([key, value]) => [key, String(value)])
  );
}

async function ensureAssemblyWorkspaceBase(envDir, assemblyName) {
  await ensureDir(envDir);
  await ensureDir(path.join(envDir, '.agentdev', 'audit'));
  await ensureDir(path.join(envDir, '.agentdev', 'plugins'));
  await ensureDir(path.join(envDir, '.agentdev', 'tts'));

  const claudeMdPath = path.join(envDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
  } catch {
    await fs.writeFile(claudeMdPath, `# ${assemblyName}\n\nThis is the workspace for the ${assemblyName} chatbot.\n`, 'utf8');
  }

  const packageJsonPath = path.join(envDir, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(packageJsonPath, `${JSON.stringify({
      name: sanitizeSessionFragment(assemblyName),
      private: true,
      type: 'module',
      version: '0.0.0',
      description: `Assembly workspace for ${assemblyName}`,
    }, null, 2)}\n`, 'utf8');
  }
}

async function resolveAssemblyFeatureArchives(tokens) {
  const requested = Array.from(new Set(tokens
    .map((token) => String(token || '').trim())
    .filter(Boolean)));

  if (requested.length === 0) {
    return [];
  }

  const [officialData, customData] = await Promise.all([
    summarizeFeatureRepository(FEATURE_REPOSITORY_ROOT, 'official'),
    summarizeFeatureRepository(USER_FEATURE_REPOSITORY_ROOT, 'custom'),
  ]);
  const catalogs = [officialData, customData];
  const resolved = [];

  for (const token of requested) {
    const normalized = token.replace(/^@agentdev\//, '').trim().toLowerCase();
    let matched = null;

    for (const catalog of catalogs) {
      const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
      const item = packages.find((pkg) => {
        const packageName = String(pkg?.packageName || '').trim().toLowerCase();
        const packageId = String(pkg?.id || '').trim().toLowerCase();
        const packageNameShort = packageName.replace(/^@agentdev\//, '');
        return token.toLowerCase() === packageName
          || normalized === packageId
          || normalized === packageNameShort;
      });

      if (!item) {
        continue;
      }

      const versions = Array.isArray(item.versions) ? item.versions : [];
      const latestVersion = versions.find((version) => String(version?.version || '') === String(item.latestVersion || ''))
        || versions[versions.length - 1]
        || null;
      if (!latestVersion?.fileName) {
        continue;
      }

      const rootDir = item.source === 'custom' ? USER_FEATURE_REPOSITORY_ROOT : FEATURE_REPOSITORY_ROOT;
      matched = {
        token,
        packageName: String(item.packageName || token).trim(),
        archivePath: path.join(rootDir, latestVersion.fileName),
      };
      break;
    }

    if (!matched) {
      throw new Error(`未找到装配 Feature 包: ${token}`);
    }

    resolved.push(matched);
  }

  return resolved;
}

function toFileDependencySpec(targetPath) {
  return `file:${path.resolve(targetPath).replace(/\\/g, '/')}`;
}

function computeDependencyHash(dependencies) {
  const entries = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
  let hash = 0;
  for (const [key, value] of entries) {
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    hash = ((hash << 5) - hash + 0x3A) | 0;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    hash = ((hash << 5) - hash + 0x7C) | 0;
  }
  return hash.toString(36);
}

async function ensureAssemblyWorkspaceDependencies(envDir, selectedFeatures) {
  const _t0 = Date.now();
  const requestedFeatures = Array.isArray(selectedFeatures)
    ? Array.from(new Set(selectedFeatures.map((value) => String(value || '').trim()).filter(Boolean)))
    : [];
  const hashFilePath = path.join(envDir, '.protoclaw-deps-hash');
  const nodeModulesExists = existsSync(path.join(envDir, 'node_modules'));
  const featureKey = [...requestedFeatures].sort().join(',');

  // Early skip: if features haven't changed and node_modules exists, skip everything
  if (nodeModulesExists && requestedFeatures.length >= 0) {
    const savedContent = await fs.readFile(hashFilePath, 'utf8').catch(() => '');
    const savedParts = savedContent.trim().split('|');
    const savedFeatureKey = savedParts.length > 1 ? savedParts[0] : null;
    const savedHash = savedParts.length > 1 ? savedParts[1] : savedParts[0];
    if (savedFeatureKey === featureKey && savedHash) {
      console.log(`[PERF] ensureAssemblyWorkspaceDependencies EARLY SKIP (${Date.now() - _t0}ms) features=${featureKey}`);
      return { installedPackages: requestedFeatures, installDir: envDir, skipped: true };
    }
  }

  const archives = requestedFeatures.length > 0
    ? await resolveAssemblyFeatureArchives(requestedFeatures)
    : [];
  const nextDependencies = {
    agentdev: toFileDependencySpec(AGENTDEV_ROOT),
    ...Object.fromEntries(archives.map((item) => [item.packageName, toFileDependencySpec(item.archivePath)])),
  };
  const depHash = computeDependencyHash(nextDependencies);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packageJsonPath = path.join(envDir, 'package.json');
  const packageJson = await readJson(packageJsonPath).catch(() => ({}));

  await fs.writeFile(packageJsonPath, `${JSON.stringify({
    ...packageJson,
    name: typeof packageJson?.name === 'string' && packageJson.name.trim() ? packageJson.name.trim() : sanitizeSessionFragment(path.basename(envDir)),
    private: true,
    type: 'module',
    version: typeof packageJson?.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : '0.0.0',
    description: typeof packageJson?.description === 'string' && packageJson.description.trim()
      ? packageJson.description.trim()
      : `Assembly workspace for ${path.basename(envDir)}`,
    dependencies: nextDependencies,
  }, null, 2)}\n`, 'utf8');

  await Promise.all([
    fs.rm(path.join(envDir, 'node_modules'), { recursive: true, force: true }).catch(() => {}),
    fs.rm(path.join(envDir, 'package-lock.json'), { force: true }).catch(() => {}),
  ]);

  await runCommand(npmCommand, [
    'install',
    '--no-fund',
    '--no-audit',
    '--no-package-lock',
  ], { cwd: envDir });

  const hashContent = `${featureKey}|${depHash}`;
  await fs.writeFile(hashFilePath, hashContent, 'utf8').catch(() => {});

  console.log(`[PERF] ensureAssemblyWorkspaceDependencies npm install DONE (${Date.now() - _t0}ms) deps=${Object.keys(nextDependencies).join(',')}`);
  return {
    installedPackages: archives.map((item) => item.packageName),
    installDir: envDir,
    skipped: false,
  };
}


function normalizeFeatureConfigs(rawConfigs) {
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

function normalizeWorkspaceState(raw = {}) {
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

function mergeFeatureRepositoryPackages(...catalogs) {
  const groups = new Map();
  for (const catalog of catalogs) {
    const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
    for (const item of packages) {
      const key = String(item?.packageName || item?.id || '').trim().toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    }
  }

  return Array.from(groups.values()).map((group) => {
    const sorted = [...group].sort((left, right) => {
      const sourceScore = (right?.source === 'custom') - (left?.source === 'custom');
      if (sourceScore !== 0) return sourceScore;
      const versionScore = compareSemver(String(right?.latestVersion || ''), String(left?.latestVersion || ''));
      if (versionScore !== 0) return versionScore;
      const t1 = new Date(String(right?.updatedAt || 0)).getTime() || 0;
      const t2 = new Date(String(left?.updatedAt || 0)).getTime() || 0;
      return t1 - t2;
    });
    const preferred = sorted[0];
    const warnings = uniqueStrings(sorted.flatMap((item) => Array.isArray(item?.warnings) ? item.warnings : []));
    return {
      ...preferred,
      source: preferred.source || 'official',
      warnings,
      warningCount: warnings.length,
      duplicateSources: uniqueStrings(sorted.map((item) => String(item?.source || '').trim()).filter(Boolean)),
      versions: Array.isArray(preferred.versions) ? preferred.versions : [],
    };
  }).sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || ''), 'zh-CN'));
}

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

async function writeWorkspaceArtifact(agentId, rawArtifact) {
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

function normalizeWorkspaceFeatureProject(raw = {}) {
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

function normalizeWorkspaceAgentProject(raw = {}) {
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

function normalizeWorkspacePhProject(raw = {}) {
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

function upsertWorkspacePhProject(state, rawProject, timestamp) {
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

function removeWorkspacePhProject(state, projectId) {
  const projects = Array.isArray(state.phProjects)
    ? state.phProjects.filter((p) => p.id !== projectId)
    : [];
  return { ...state, phProjects: projects };
}

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

const _wsCache = new Map();

async function readWorkspaceState(agentId) {
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

async function writeWorkspaceState(agentId, rawState) {
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

async function summarizeDirectorySource(rawPath) {
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);

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

function compareSemver(left, right) {
  const leftParts = String(left || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeFeatureRequirements(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    platforms: uniqueStrings(source.platforms),
    node: typeof source.node === 'string' ? source.node.trim() : '',
    external: uniqueStrings(source.external),
    services: uniqueStrings(source.services),
  };
}

function normalizeFeatureTypes(values) {
  const allowed = new Set(['tools', 'mcp', 'hooks', 'control', 'rollback']);
  return uniqueStrings(values).filter((value) => allowed.has(value));
}

function normalizeFeatureCompatibility(raw = {}, featureTypes = []) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rollback = typeof source.rollback === 'boolean'
    ? source.rollback
    : featureTypes.includes('rollback');

  return {
    rollback,
    tags: uniqueStrings([
      ...(Array.isArray(source.tags) ? source.tags : []),
      rollback ? 'supports-rollback' : 'no-rollback',
    ]),
  };
}

function inferFeatureTypes(pkg, baseId) {
  const packageName = String(pkg?.name || '').trim();
  const lowerBaseId = String(baseId || '').toLowerCase();

  if (packageName.startsWith('@sliverp/')) {
    return [];
  }
  if (/(shell|websearch|visual|tts|lsp|memory)/i.test(lowerBaseId)) {
    return ['tools'];
  }
  if (/(audio-feedback|audit|plugin-compat)/i.test(lowerBaseId)) {
    return ['hooks'];
  }
  if (/qqbot/i.test(lowerBaseId)) {
    return ['hooks', 'control'];
  }
  return [];
}

function inferFeatureManifest(pkg, archiveName) {
  const packageName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
  const baseId = packageName
    ? packageName.split('/').pop()
    : archiveName.replace(/\.tgz$/i, '');
  const tags = uniqueStrings(pkg?.keywords);
  const featureTypes = inferFeatureTypes(pkg, baseId);
  const dependencyNames = Object.keys(pkg?.dependencies || {});
  const requirements = {
    platforms: [],
    node: '',
    external: [],
    services: [],
  };

  if (typeof pkg?.engines?.node === 'string' && pkg.engines.node.trim()) {
    requirements.node = pkg.engines.node.trim();
  }
  if (dependencyNames.includes('openai') || /websearch|visual|tts/i.test(baseId)) {
    requirements.services.push('network');
  }
  if (/shell/i.test(baseId)) {
    requirements.external.push('system-shell');
  }
  if (/audio|tts/i.test(baseId) || dependencyNames.includes('sound-play')) {
    requirements.external.push('audio-output');
  }
  if (/visual/i.test(baseId)) {
    requirements.external.push('desktop-capture');
  }
  if (/lsp/i.test(baseId)) {
    requirements.external.push('language-server');
  }
  if (/qqbot/i.test(baseId)) {
    requirements.services.push('qqbot');
  }

  return {
    schemaVersion: 1,
    id: baseId,
    name: baseId,
    version: typeof pkg?.version === 'string' ? pkg.version.trim() : '',
    description: typeof pkg?.description === 'string' ? pkg.description.trim() : '',
    tags,
    entry: typeof pkg?.main === 'string' ? pkg.main.trim() : '',
    agentdev: {
      compatible: typeof pkg?.peerDependencies?.agentdev === 'string'
        ? pkg.peerDependencies.agentdev.trim()
        : '',
    },
    homepage: typeof pkg?.homepage === 'string' ? pkg.homepage.trim() : '',
    repository: typeof pkg?.repository === 'string'
      ? pkg.repository.trim()
      : (typeof pkg?.repository?.url === 'string' ? pkg.repository.url.trim() : ''),
    featureTypes,
    compatibility: normalizeFeatureCompatibility({}, featureTypes),
    requirements,
  };
}

async function ensureFeatureProjectManifest(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const manifestPath = path.join(projectDir, FEATURE_MANIFEST_NAME);
  const pkg = await readJson(packageJsonPath);
  const existingManifest = await readJson(manifestPath).catch(() => null);
  const inferred = inferFeatureManifest(pkg, `${path.basename(projectDir)}.tgz`);
  const featureTypes = normalizeFeatureTypes(existingManifest?.featureTypes || inferred.featureTypes);
  const manifest = {
    schemaVersion: 1,
    id: typeof existingManifest?.id === 'string' && existingManifest.id.trim() ? existingManifest.id.trim() : inferred.id,
    name: typeof existingManifest?.name === 'string' && existingManifest.name.trim() ? existingManifest.name.trim() : inferred.name,
    version: typeof pkg?.version === 'string' ? pkg.version.trim() : inferred.version,
    description: typeof existingManifest?.description === 'string' && existingManifest.description.trim()
      ? existingManifest.description.trim()
      : inferred.description,
    tags: uniqueStrings([...(existingManifest?.tags || []), ...(pkg?.keywords || [])]),
    entry: typeof existingManifest?.entry === 'string' && existingManifest.entry.trim()
      ? existingManifest.entry.trim()
      : inferred.entry,
    homepage: typeof existingManifest?.homepage === 'string' && existingManifest.homepage.trim()
      ? existingManifest.homepage.trim()
      : inferred.homepage,
    repository: typeof existingManifest?.repository === 'string' && existingManifest.repository.trim()
      ? existingManifest.repository.trim()
      : inferred.repository,
    agentdev: {
      compatible: typeof existingManifest?.agentdev?.compatible === 'string' && existingManifest.agentdev.compatible.trim()
        ? existingManifest.agentdev.compatible.trim()
        : inferred.agentdev.compatible,
    },
    featureTypes,
    compatibility: normalizeFeatureCompatibility(existingManifest?.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(existingManifest?.requirements || inferred.requirements),
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (Array.isArray(pkg.files) && !pkg.files.includes(FEATURE_MANIFEST_NAME)) {
    await fs.writeFile(packageJsonPath, `${JSON.stringify({
      ...pkg,
      files: uniqueStrings([...pkg.files, FEATURE_MANIFEST_NAME]),
    }, null, 2)}\n`, 'utf8');
  }

  return {
    manifestPath,
    packageJsonPath,
  };
}

async function readArchiveJson(archivePath, archiveEntryPath) {
  const { stdout } = await runCommand('tar', ['-xOf', archivePath, archiveEntryPath], { cwd: __dirname });
  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`Archive entry is empty: ${archiveEntryPath}`);
  }
  return JSON.parse(raw);
}

async function summarizeFeatureArchive(archivePath, archiveName, source = 'custom') {
  const stat = await fs.stat(archivePath);
  let pkg = null;
  let manifest = null;
  const warnings = [];

  try {
    pkg = await readArchiveJson(archivePath, 'package/package.json');
  } catch (error) {
    return {
      id: archiveName.replace(/\.tgz$/i, ''),
      name: archiveName.replace(/\.tgz$/i, ''),
      packageName: '',
      description: '',
      latestVersion: '',
      version: '',
      updatedAt: stat.mtime.toISOString(),
      archiveCount: 1,
      size: stat.size,
      tags: [],
      featureTypes: [],
      compatibility: normalizeFeatureCompatibility({}, []),
      requirements: normalizeFeatureRequirements(),
      homepage: '',
      repository: '',
      entry: '',
      agentdev: {},
      manifestPresent: false,
      warningCount: 1,
      source,
      warnings: [`无法读取 package.json: ${error instanceof Error ? error.message : String(error)}`],
      fileName: archiveName,
    };
  }

  try {
    manifest = await readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`);
  } catch {
    manifest = null;
  }

  const normalizedManifest = manifest || inferFeatureManifest(pkg, archiveName);
  const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || archiveName);
  const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
  if (!manifest) {
    warnings.push(`缺少 ${FEATURE_MANIFEST_NAME}，当前仅展示 package.json 推断信息。`);
  }

  return {
    id: String(normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    packageName: String(pkg.name || '').trim(),
    description: String(normalizedManifest.description || pkg.description || '').trim(),
    latestVersion: String(normalizedManifest.version || pkg.version || '').trim(),
    version: String(normalizedManifest.version || pkg.version || '').trim(),
    updatedAt: stat.mtime.toISOString(),
    archiveCount: 1,
    size: stat.size,
    tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
    featureTypes,
    compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
    homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
    repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
    entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
    agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev ? normalizedManifest.agentdev : {},
    manifestPresent: !!manifest,
    warningCount: warnings.length,
    source,
    warnings,
    fileName: archiveName,
  };
}

async function summarizeFeatureRepository(rawPath, source) {
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);

  try {
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const archives = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tgz'));
    const packageSummaries = await Promise.all(archives.map(async (entry) => {
      const archivePath = path.join(resolvedPath, entry.name);
      const stat = await fs.stat(archivePath);
      let pkg = null;
      let manifest = null;

      try {
        pkg = await readArchiveJson(archivePath, 'package/package.json');
      } catch (error) {
        return {
          id: entry.name.replace(/\.tgz$/i, ''),
          name: entry.name.replace(/\.tgz$/i, ''),
          packageName: '',
          description: '',
          latestVersion: '',
          updatedAt: stat.mtime.toISOString(),
          archiveCount: 1,
          size: stat.size,
          tags: [],
          featureTypes: [],
          compatibility: normalizeFeatureCompatibility({}, []),
          requirements: normalizeFeatureRequirements(),
          homepage: '',
          repository: '',
          manifestPresent: false,
          warningCount: 1,
          warnings: [`无法读取 package.json: ${error instanceof Error ? error.message : String(error)}`],
          versions: [{
            fileName: entry.name,
            version: '',
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            manifestPresent: false,
            warnings: ['package.json 缺失或损坏'],
          }],
        };
      }

      try {
        manifest = await readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`);
      } catch {
        manifest = null;
      }

      const normalizedManifest = manifest || inferFeatureManifest(pkg, entry.name);
      const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || entry.name);
      const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
      const warnings = [];
      if (!manifest) {
        warnings.push(`缺少 ${FEATURE_MANIFEST_NAME}，当前仅展示 package.json 推断信息。`);
      }

      return {
        id: String(normalizedManifest.id || pkg.name || entry.name.replace(/\.tgz$/i, '')).trim(),
        name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || entry.name.replace(/\.tgz$/i, '')).trim(),
        packageName: String(pkg.name || '').trim(),
        description: String(normalizedManifest.description || pkg.description || '').trim(),
        version: String(normalizedManifest.version || pkg.version || '').trim(),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
        featureTypes,
        compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
        requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
        homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
        repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
        entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
        agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev
          ? normalizedManifest.agentdev
          : {},
        manifestPresent: !!manifest,
        warnings,
        fileName: entry.name,
      };
    }));

    const groups = new Map();
    for (const item of packageSummaries) {
      const groupId = item.packageName || item.id;
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId).push(item);
    }

    const packages = [...groups.values()].map((group) => {
      const versions = [...group].sort((left, right) => {
        const semverDiff = compareSemver(right.version, left.version);
        if (semverDiff !== 0) return semverDiff;
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
      const latest = versions[0];
      const warnings = uniqueStrings([
        ...versions.flatMap((item) => item.warnings || []),
        versions.some((item) => !item.manifestPresent) ? '部分版本缺少 feature 元数据。' : '',
      ]);

      return {
        id: latest.id,
        name: latest.name,
        packageName: latest.packageName,
        description: latest.description,
        latestVersion: latest.version,
        updatedAt: latest.updatedAt,
        archiveCount: versions.length,
        size: latest.size,
        tags: uniqueStrings(versions.flatMap((item) => item.tags || [])),
        featureTypes: latest.featureTypes || [],
        compatibility: latest.compatibility || normalizeFeatureCompatibility({}, latest.featureTypes || []),
        requirements: latest.requirements || normalizeFeatureRequirements(),
        homepage: latest.homepage,
        repository: latest.repository,
        entry: latest.entry,
        agentdev: latest.agentdev || {},
        manifestPresent: versions.every((item) => item.manifestPresent),
        warningCount: warnings.length,
        source: source || 'official',
        warnings,
        versions: versions.map((item) => ({
          fileName: item.fileName,
          version: item.version,
          updatedAt: item.updatedAt,
          size: item.size,
          manifestPresent: item.manifestPresent,
          warnings: item.warnings || [],
        })),
      };
    }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

    return {
      path: resolvedPath,
      exists: true,
      type: 'feature-repository',
      packageCount: packages.length,
      archiveCount: archives.length,
      missingManifestCount: packageSummaries.filter((item) => !item.manifestPresent).length,
      updatedAt: packages.reduce((latest, item) => {
        if (!latest) return item.updatedAt;
        return new Date(item.updatedAt).getTime() > new Date(latest).getTime() ? item.updatedAt : latest;
      }, null),
      packages,
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: false,
      type: 'feature-repository',
      packageCount: 0,
      archiveCount: 0,
      missingManifestCount: 0,
      updatedAt: null,
      packages: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function deleteFeaturePackage(packageId) {
  const deletedFiles = [];
  
  // 尝试从官方仓库删除
  const officialPath = FEATURE_REPOSITORY_ROOT;
  try {
    const officialEntries = await fs.readdir(officialPath, { withFileTypes: true });
    for (const entry of officialEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) {
        const archivePath = path.join(officialPath, entry.name);
        const archiveId = entry.name.replace(/\.tgz$/i, '');
        if (archiveId === packageId) {
          await fs.unlink(archivePath);
          deletedFiles.push({ path: archivePath, source: 'official' });
        }
      }
    }
  } catch {
    // 官方仓库可能不存在
  }

  // 尝试从用户仓库删除
  const userPath = USER_FEATURE_REPOSITORY_ROOT;
  try {
    const userEntries = await fs.readdir(userPath, { withFileTypes: true });
    for (const entry of userEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) {
        const archivePath = path.join(userPath, entry.name);
        const archiveId = entry.name.replace(/\.tgz$/i, '');
        if (archiveId === packageId) {
          await fs.unlink(archivePath);
          deletedFiles.push({ path: archivePath, source: 'custom' });
        }
      }
    }
  } catch {
    // 用户仓库可能不存在
  }

  return deletedFiles;
}

async function resolveWorkspaceData(agent) {
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

function sanitizeProjectDocsetId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'doc';
}

function buildProjectDocsetMarkdownId(title, createdAt, fallbackPrefix = 'plan') {
  const normalizedTitle = sanitizeProjectDocsetId(title || fallbackPrefix);
  const timestamp = String(createdAt || new Date().toISOString())
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `${fallbackPrefix}-${normalizedTitle}-${timestamp || Date.now()}`;
}

function cleanProjectDocsetPayload(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => value !== undefined && value !== null && !(typeof value === 'string' && value === '')),
  );
}

function normalizeProjectConversationRecord(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const timestamp = new Date().toISOString();
  return {
    sessionId: sanitizeProjectDocsetId(source.sessionId || 'session'),
    title: cleanSessionText(source.title) || 'conversation-record',
    summary: cleanSessionText(source.summary),
    currentFocus: cleanSessionText(source.currentFocus),
    keyDecisions: Array.isArray(source.keyDecisions) ? source.keyDecisions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    nextActions: Array.isArray(source.nextActions) ? source.nextActions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    openQuestions: Array.isArray(source.openQuestions) ? source.openQuestions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    relatedMaterialIds: Array.isArray(source.relatedMaterialIds) ? source.relatedMaterialIds.map((value) => sanitizeProjectDocsetId(value)).filter(Boolean) : [],
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : timestamp,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : timestamp,
  };
}

function extractMaterialSourcePath(content = '') {
  const match = String(content || '').match(/^- Source Path:\s*(.+)$/m);
  return match ? cleanSessionText(match[1]) : '';
}

async function ensureProjectDocset(projectDir, options = {}) {
  const resolvedProjectDir = path.resolve(String(projectDir || '').trim());
  const docsetDir = getProjectDocsetDir(resolvedProjectDir);
  const formsDir = getProjectDocsetFormsDir(resolvedProjectDir);
  const materialsDir = getProjectDocsetMaterialsDir(resolvedProjectDir);
  const conversationsDir = getProjectDocsetConversationsDir(resolvedProjectDir);
  const timestamp = typeof options.timestamp === 'string' && options.timestamp ? options.timestamp : new Date().toISOString();

  await Promise.all([
    ensureDir(docsetDir),
    ensureDir(formsDir),
    ensureDir(materialsDir),
    ensureDir(conversationsDir),
  ]);

  const legacyPlansDir = path.join(docsetDir, 'plans');
  try {
    const entries = await fs.readdir(legacyPlansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fromPath = path.join(legacyPlansDir, entry.name);
      const toPath = path.join(materialsDir, entry.name);
      await fs.rename(fromPath, toPath).catch(async () => {
        const content = await fs.readFile(fromPath);
        await fs.writeFile(toPath, content);
        await fs.rm(fromPath, { force: true }).catch(() => {});
      });
    }
    await fs.rmdir(legacyPlansDir).catch(() => {});
  } catch {
    // Ignore missing legacy plans dir.
  }

  await fs.rm(path.join(docsetDir, 'tasks'), { recursive: true, force: true }).catch(() => {});

  const legacySessionsDir = path.join(docsetDir, 'sessions');
  try {
    const legacyEntries = await fs.readdir(legacySessionsDir, { withFileTypes: true });
    for (const entry of legacyEntries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const legacyPath = path.join(legacySessionsDir, entry.name);
      const nextPath = path.join(conversationsDir, entry.name);
      const raw = await readJson(legacyPath).catch(() => null);
      if (raw) {
        const normalized = normalizeProjectConversationRecord(raw);
        await fs.writeFile(nextPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      }
      await fs.rm(legacyPath, { force: true }).catch(() => {});
    }
    await fs.rmdir(legacySessionsDir).catch(() => {});
  } catch {
    // Ignore missing legacy sessions dir.
  }

  const nextProjectRecord = {
    schemaVersion: 1,
    workspaceId: cleanSessionText(options.workspaceId),
    projectType: cleanSessionText(options.projectType),
    projectName: cleanSessionText(options.projectName),
    openDirectory: resolvedProjectDir,
    targetDir: cleanSessionText(options.targetDir) || path.dirname(resolvedProjectDir),
    goal: cleanSessionText(options.goal),
    constraints: cleanSessionText(options.constraints),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const projectPath = getProjectDocsetProjectPath(resolvedProjectDir);
  try {
    const existing = await readJson(projectPath);
    nextProjectRecord.createdAt = typeof existing?.createdAt === 'string' && existing.createdAt ? existing.createdAt : timestamp;
  } catch {
    // Ignore if project record does not exist yet.
  }

  await fs.writeFile(projectPath, `${JSON.stringify(nextProjectRecord, null, 2)}\n`, 'utf8');

  if (options.requirementForm && typeof options.requirementForm === 'object') {
    const requirementDoc = {
      schemaVersion: 1,
      formId: cleanSessionText(options.formId) || 'startup-form',
      workspaceId: cleanSessionText(options.workspaceId),
      openDirectory: resolvedProjectDir,
      payload: cleanProjectDocsetPayload(options.requirementForm),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const requirementPath = path.join(formsDir, `${requirementDoc.formId}.json`);
    try {
      const existing = await readJson(requirementPath);
      requirementDoc.createdAt = typeof existing?.createdAt === 'string' && existing.createdAt ? existing.createdAt : timestamp;
    } catch {
      // Ignore if form file does not exist yet.
    }
    await fs.writeFile(requirementPath, `${JSON.stringify(requirementDoc, null, 2)}\n`, 'utf8');
  }

  return {
    docsetDir,
    projectPath,
    formsDir,
    materialsDir,
    conversationsDir,
  };
}

async function syncWorkspaceProjectDocset(agentId, state, timestamp) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (normalizedAgentId !== 'feature-creator' && normalizedAgentId !== 'agent-creator' && normalizedAgentId !== 'programming-helper') {
    return null;
  }

  const openDirectory = cleanSessionText(state?.openDirectory);
  if (!openDirectory) {
    return null;
  }

  const startupForm = state?.forms?.['startup-form'] || {};
  const isFeatureCreator = normalizedAgentId === 'feature-creator';
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  return ensureProjectDocset(openDirectory, {
    timestamp,
    workspaceId: normalizedAgentId,
    projectType: isProgrammingHelper ? 'programming-task' : (isFeatureCreator ? 'feature' : 'agent'),
    projectName: isProgrammingHelper ? startupForm.task_title : (isFeatureCreator ? startupForm.feature_name : startupForm.agent_name),
    targetDir: isProgrammingHelper ? path.dirname(openDirectory) : startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    formId: 'startup-form',
    requirementForm: startupForm,
  });
}

async function summarizeProjectDocset(projectDir, options = {}) {
  const resolvedProjectDir = cleanSessionText(projectDir);
  if (!resolvedProjectDir) {
    return {
      type: 'project-docset',
      exists: false,
      projectDir: '',
      docsetDir: '',
      requirementForm: null,
      materials: [],
      materialCount: 0,
    };
  }

  const docsetDir = getProjectDocsetDir(resolvedProjectDir);
  const materialLimit = Number.isFinite(Number(options.materialLimit)) ? Math.max(1, Number(options.materialLimit)) : 6;
  const conversationLimit = Number.isFinite(Number(options.conversationLimit)) ? Math.max(1, Number(options.conversationLimit)) : 5;
  const currentSessionId = cleanSessionText(options.currentSessionId);

  try {
    const [projectRecord, requirementForm, materialEntries, conversationEntries] = await Promise.all([
      readJson(getProjectDocsetProjectPath(resolvedProjectDir)).catch(() => null),
      readJson(path.join(getProjectDocsetFormsDir(resolvedProjectDir), 'startup-form.json')).catch(() => null),
      fs.readdir(getProjectDocsetMaterialsDir(resolvedProjectDir), { withFileTypes: true }).catch(() => []),
      fs.readdir(getProjectDocsetConversationsDir(resolvedProjectDir), { withFileTypes: true }).catch(() => []),
    ]);

    const materials = (await Promise.all(materialEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const filePath = path.join(getProjectDocsetMaterialsDir(resolvedProjectDir), entry.name);
        const stat = await fs.stat(filePath);
        const body = await fs.readFile(filePath, 'utf8');
        const lines = body.split(/\r?\n/).map((line) => line.trim());
        const heading = lines.find((line) => line.startsWith('# ')) || '';
        const title = heading ? heading.replace(/^#\s+/, '').trim() : entry.name.replace(/\.md$/i, '');
        const preview = lines.filter(Boolean).slice(1, 4).join(' ').slice(0, 180);
        return {
          id: sanitizeProjectDocsetId(entry.name.replace(/\.md$/i, '')),
          title,
          preview,
          content: body,
          sourcePath: extractMaterialSourcePath(body),
          path: filePath,
          updatedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
        };
      })))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const conversationRecords = (await Promise.all(conversationEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(getProjectDocsetConversationsDir(resolvedProjectDir), entry.name);
        const raw = await readJson(filePath);
        return normalizeProjectConversationRecord(raw);
      })))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const currentConversationRecord = currentSessionId
      ? conversationRecords.find((item) => item.sessionId === sanitizeProjectDocsetId(currentSessionId)) || null
      : null;

    return {
      type: 'project-docset',
      exists: true,
      projectDir: resolvedProjectDir,
      docsetDir,
      project: projectRecord,
      requirementForm,
      currentSessionId: currentSessionId || '',
      currentConversationRecord,
      conversationRecords: conversationRecords.slice(0, conversationLimit),
      materialCount: materials.length,
      materials: materials.slice(0, materialLimit),
    };
  } catch {
    return {
      type: 'project-docset',
      exists: false,
      projectDir: resolvedProjectDir,
      docsetDir,
      requirementForm: null,
      currentSessionId: currentSessionId || '',
      currentConversationRecord: null,
      conversationRecords: [],
      materials: [],
      materialCount: 0,
    };
  }
}

function buildFeatureSessionTitle(featureName, createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  const base = cleanSessionText(featureName);
  return base ? `${base} · ${parts.join('-')} ${time.join(':')}` : buildSessionTitle(createdAtIso);
}

function buildNamedSessionTitle(name, createdAtIso) {
  return buildFeatureSessionTitle(name, createdAtIso);
}

async function getNextNewSessionTitle(agentId, openDirectory) {
  const index = await readSessionIndex(agentId);
  const normalizedDir = String(openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const newSessionPattern = /^新对话(\d+)$/;
  let maxN = 0;
  for (const session of (index.sessions || [])) {
    const sessionDir = String(session?.openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalizedDir && sessionDir !== normalizedDir) continue;
    const m = cleanSessionText(session?.title).match(newSessionPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return `新对话${maxN + 1}`;
}

async function checkSessionHasSummary(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

async function buildSessionSummaryMap(agentId) {
  const map = new Map();
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId && !parsed.stats?.synthetic) {
          const existing = map.get(parsed.sourceSessionId);
          const thisCreatedAt = parsed.createdAt || '';
          if (!existing || thisCreatedAt > (existing.createdAt || '')) {
            map.set(parsed.sourceSessionId, {
              sessionTitle: cleanSessionText(parsed.compactOutput?.sessionTitle),
              createdAt: thisCreatedAt,
            });
          }
        }
      } catch {}
    }
  } catch {}
  return map;
}

function buildLightPrebuiltSessionRecord(agentId, record) {
  const metadata = normalizeSessionMetadata(record?.metadata);
  const sessionType = cleanSessionText(record?.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
  return {
    id: cleanSessionText(record?.id),
    title: cleanSessionText(record?.title),
    featureName: cleanSessionText(record?.featureName),
    agentName: cleanSessionText(record?.agentName),
    taskTitle: cleanSessionText(record?.taskTitle),
    taskType: cleanSessionText(record?.taskType),
    goal: cleanSessionText(record?.goal),
    constraints: cleanSessionText(record?.constraints),
    expectedOutput: cleanSessionText(record?.expectedOutput),
    targetFiles: cleanSessionText(record?.targetFiles),
    referenceMaterials: cleanSessionText(record?.referenceMaterials),
    sessionType,
    status: cleanSessionText(record?.status) || (sessionType === 'exploration' ? 'locked' : ''),
    metadata,
    formId: cleanSessionText(record?.formId) || '',
    openDirectory: cleanSessionText(record?.openDirectory),
    createdAt: cleanSessionText(record?.createdAt) || new Date().toISOString(),
    updatedAt: cleanSessionText(record?.updatedAt) || cleanSessionText(record?.createdAt) || new Date().toISOString(),
    path: getPrebuiltSessionFilePath(agentId, cleanSessionText(record?.id) || ''),
    exists: true,
    bytes: record?.fileSize || 0,
    messageCount: typeof record?.messageCount === 'number' ? record.messageCount : 0,
    preview: cleanSessionText(record?.preview),
    hasSummary: false,
    tokenUsage: record?.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextLength: null,
    modelName: cleanSessionText(record?.modelName),
  };
}

async function findSessionSummary(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return parsed;
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function findSessionSummaryPath(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return path.join(handoffsDir, file);
        }
      } catch {}
    }
  } catch {}
  return null;
}

function extractToolCallLabel(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'read' || name === 'edit' || name === 'write') {
    const filePath = typeof args.filePath === 'string' ? args.filePath : '';
    if (filePath) {
      const baseName = filePath.split(/[\\/]/).pop() || filePath;
      return `${name} ${baseName}`;
    }
  }
  if (name === 'invoke_skill') {
    const skill = typeof args.skill === 'string' ? args.skill : '';
    if (skill) return `invoke_skill ${skill}`;
  }
  return null;
}

function buildSessionTrimPreview(messages) {
  const rounds = [];
  let currentRound = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = typeof m?.role === 'string' ? m.role : '';
    if (role === 'user') {
      if (currentRound) rounds.push(currentRound);
      const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
      currentRound = {
        roundIndex: rounds.length,
        turnStart: Number.isFinite(m.turn) ? m.turn : i,
        turnEnd: Number.isFinite(m.turn) ? m.turn : i,
        msgIndexStart: i,
        msgIndexEnd: i,
        userPreview: content.slice(0, 120),
        assistantPreview: '',
        toolCalls: [],
        messageCount: 1,
      };
    } else if (currentRound) {
      currentRound.messageCount += 1;
      currentRound.turnEnd = Number.isFinite(m.turn) ? m.turn : currentRound.turnEnd;
      currentRound.msgIndexEnd = i;
      if (role === 'assistant') {
        const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
        if (content && !currentRound.assistantPreview) {
          currentRound.assistantPreview = content.slice(0, 120);
        }
        const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        for (const tc of toolCalls) {
          const name = typeof tc?.name === 'string' ? tc.name : '';
          if (!name) continue;
          let args = tc.args ?? tc.arguments ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          const label = extractToolCallLabel(name, args) || name;
          currentRound.toolCalls.push({ name, summary: label });
        }
      }
    }
  }
  if (currentRound) rounds.push(currentRound);

  const recentCount = 2;
  for (let i = 0; i < rounds.length; i++) {
    rounds[i].suggestedTrim = i < rounds.length - recentCount;
  }

  return rounds;
}

/**
 * Session index metadata version. Bump when the cached fields schema changes;
 * old index records will auto-heal via the slow path on first access.
 */
const META_VERSION = 1;

async function summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap) {
  const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const metadata = normalizeSessionMetadata(record.metadata);
  const workspaceState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  const formId = cleanSessionText(record.formId) || (isProgrammingHelper ? '' : 'startup-form');
  const sourceForm = workspaceState?.forms?.[formId] || {};
  const startupForm = isProgrammingHelper ? {} : (workspaceState?.forms?.['startup-form'] || {});
  const featureName = cleanSessionText(record.featureName) || cleanSessionText(sourceForm.feature_name) || cleanSessionText(startupForm.feature_name);
  const agentName = cleanSessionText(record.agentName) || cleanSessionText(sourceForm.agent_name || sourceForm.assembly_name) || cleanSessionText(startupForm.agent_name);
  const taskTitle = cleanSessionText(record.taskTitle) || cleanSessionText(sourceForm.task_title) || cleanSessionText(startupForm.task_title);
  const taskType = cleanSessionText(record.taskType) || cleanSessionText(sourceForm.task_type) || cleanSessionText(startupForm.task_type);
  const goal = cleanSessionText(record.goal) || cleanSessionText(sourceForm.goal) || cleanSessionText(startupForm.goal);
  const constraints = cleanSessionText(record.constraints) || cleanSessionText(sourceForm.constraints) || cleanSessionText(startupForm.constraints);
  const expectedOutput = cleanSessionText(record.expectedOutput) || cleanSessionText(sourceForm.expected_output) || cleanSessionText(startupForm.expected_output);
  const targetFiles = cleanSessionText(record.targetFiles) || cleanSessionText(sourceForm.target_files) || cleanSessionText(startupForm.target_files);
  const referenceMaterials = cleanSessionText(record.referenceMaterials) || cleanSessionText(sourceForm.reference_materials) || cleanSessionText(startupForm.reference_materials);
  // NOTE: Do NOT fall back to workspaceState.openDirectory for non-assembly
  // agents. workspaceState.openDirectory is the *current* project directory,
  // not the one the session was created with. Falling back here causes sessions
  // with empty openDirectory to appear in every project the user opens.
  const openDirectory = (normalizedAgentId === 'agent-creator' || normalizedAgentId === 'flow-workspace') && formId === 'assembly-form'
    ? (
        cleanSessionText(sourceForm.env_dir)
        || cleanSessionText(record.openDirectory)
      )
    : cleanSessionText(record.openDirectory);
  const displayName = (normalizedAgentId === 'agent-creator' || (normalizedAgentId === 'flow-workspace' && formId === 'assembly-form'))
    ? agentName
    : (normalizedAgentId === 'programming-helper' ? taskTitle : featureName);
  try {
    const stat = await fs.stat(sessionPath);

    // ── Fast path: use cached metadata when the session file hasn't changed ──
    if (
      record.fileMtimeMs === stat.mtimeMs &&
      record.fileSize === stat.size &&
      record.metaVersion === META_VERSION &&
      typeof record.messageCount === 'number' &&
      typeof record.preview !== 'undefined' &&
      record.tokenUsage
    ) {
      const sType = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
      const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
      const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole])
        || await resolveSessionModelInfo(agentId, sType);
      const persistedModelName = cleanSessionText(record.modelName);
      const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
        ? record.contextLength : null;
      const sessionModelInfo = {
        modelName: fallbackModelInfo.modelName || persistedModelName || '',
        contextLength: fallbackModelInfo.contextLength || persistedCL || null,
        compressRatio: fallbackModelInfo.compressRatio || 80,
      };
      const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
      const compactTitle = summaryInfo?.sessionTitle || '';
      return {
        id: record.id,
        title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
        featureName,
        agentName,
        taskTitle,
        taskType,
        goal,
        constraints,
        expectedOutput,
        targetFiles,
        referenceMaterials,
        sessionType: sType,
        status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
        archived: record.archived === true,
        todo: record.todo === true,
        metadata,
        formId,
        openDirectory,
        createdAt: record.createdAt || stat.birthtime.toISOString(),
        updatedAt: record.savedAt ? new Date(record.savedAt).toISOString() : (record.updatedAt || stat.mtime.toISOString()),
        path: sessionPath,
        exists: true,
        bytes: stat.size,
        messageCount: record.messageCount,
        preview: cleanSessionText(record.preview),
        hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
        tokenUsage: record.tokenUsage,
        contextLength: sessionModelInfo.contextLength || null,
        compressRatio: sessionModelInfo.compressRatio || 80,
        modelName: sessionModelInfo.modelName || '',
      };
    }

    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const lastMessage = [...messages].reverse().find((message) => message && typeof message.content === 'string' && message.role !== 'system') || null;
    const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
    const compactTitle = summaryInfo?.sessionTitle || '';
    const usageStats = parsed?.runtime?.usageStats;
    const totalUsage = usageStats?.totalUsage;
    const sType = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
    const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
    const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole])
      || await resolveSessionModelInfo(agentId, sType);
    // 优先使用动态解析的模型信息（当前全局配置），回退到 index record 中持久化的模型信息
    const persistedModelName = cleanSessionText(record.modelName);
    const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
      ? record.contextLength : null;
    const sessionModelInfo = {
      modelName: fallbackModelInfo.modelName || persistedModelName || '',
      contextLength: fallbackModelInfo.contextLength || persistedCL || null,
      compressRatio: fallbackModelInfo.compressRatio || 80,
    };
    const result = {
      id: record.id,
      title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
      featureName,
      agentName,
      taskTitle,
      taskType,
      goal,
      constraints,
      expectedOutput,
      targetFiles,
      referenceMaterials,
      sessionType: cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
      status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
      archived: record.archived === true,
      todo: record.todo === true,
      metadata,
      formId,
      openDirectory,
      createdAt: record.createdAt || stat.birthtime.toISOString(),
      updatedAt: typeof parsed?.savedAt === 'number' ? new Date(parsed.savedAt).toISOString() : (record.updatedAt || stat.mtime.toISOString()),
      path: sessionPath,
      exists: true,
      bytes: stat.size,
      messageCount: messages.length,
      preview: lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '',
      hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
      tokenUsage: {
        inputTokens: totalUsage?.inputTokens || 0,
        outputTokens: totalUsage?.outputTokens || 0,
        totalTokens: totalUsage?.totalTokens || 0,
        lastRequestUsage: usageStats?.lastRequestUsage || null,
      },
      contextLength: sessionModelInfo.contextLength || null,
      compressRatio: sessionModelInfo.compressRatio || 80,
      modelName: sessionModelInfo.modelName || '',
    };
    // Attach writeback payload as non-enumerable so it doesn't leak into API JSON responses
    Object.defineProperty(result, '_metaWriteback', {
      value: {
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        messageCount: messages.length,
        preview: lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '',
        tokenUsage: {
          inputTokens: totalUsage?.inputTokens || 0,
          outputTokens: totalUsage?.outputTokens || 0,
          totalTokens: totalUsage?.totalTokens || 0,
          lastRequestUsage: usageStats?.lastRequestUsage || null,
        },
        savedAt: typeof parsed?.savedAt === 'number' ? parsed.savedAt : null,
        metaVersion: META_VERSION,
      },
      enumerable: false,
      configurable: true,
    });
    return result;
  } catch {
    return {
      id: record.id,
      title: record.title || buildNamedSessionTitle(displayName, record.createdAt || new Date().toISOString()),
      featureName,
      agentName,
      taskTitle,
      taskType,
      goal,
      constraints,
      expectedOutput,
      targetFiles,
      referenceMaterials,
      sessionType: cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
      status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
      archived: record.archived === true,
      todo: record.todo === true,
      metadata,
      formId,
      openDirectory,
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
      path: sessionPath,
      exists: false,
      bytes: 0,
      messageCount: 0,
      preview: '',
      hasSummary: false,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextLength: null,
      compressRatio: 80,
      modelName: '',
    };
  }
}

// ── Session Content Search Index ────────────────────────────────
// In-memory cache: agentId → Map<sessionId, { sessionId, title, openDirectory, fileMtimeMs, text }>
const _searchIndexCache = new Map();
const _searchIndexBuilding = new Map();
const SEARCH_INDEX_VERSION = 1;
const SEARCH_SNIPPET_RADIUS = 40;
const SEARCH_MAX_RESULTS = 50;

function getSearchIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'search-index.json');
}

async function loadPersistentSearchIndex(agentId) {
  try {
    const raw = await fs.readFile(getSearchIndexPath(agentId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== SEARCH_INDEX_VERSION) return null;
    return parsed.entries || {};
  } catch {
    return null;
  }
}

async function savePersistentSearchIndex(agentId, entriesMap) {
  try {
    const data = { version: SEARCH_INDEX_VERSION, entries: entriesMap };
    await fs.writeFile(getSearchIndexPath(agentId), JSON.stringify(data), 'utf8');
  } catch {}
}

async function extractSessionSearchText(sessionPath) {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
  const parts = [];
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[user] ' + m.content);
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[assistant] ' + m.content);
    }
  }
  return parts.join('\n');
}

async function ensureSearchIndex(agentId) {
  // Deduplicate concurrent builds
  if (_searchIndexBuilding.has(agentId)) {
    return _searchIndexBuilding.get(agentId);
  }

  const buildPromise = (async () => {
    const index = await readSessionIndex(agentId);
    const memCache = _searchIndexCache.get(agentId);
    const persistent = memCache ? null : await loadPersistentSearchIndex(agentId);

    // Source of truth for valid entries: index.json session IDs
    const validIds = new Set(index.sessions.map(s => s.id));

    // Build entries map: start from existing cache (in-memory or persistent)
    const entries = new Map();
    const toRead = []; // sessions that need file reads

    for (const record of index.sessions) {
      // Check in-memory cache first, then persistent
      const source = memCache?.get(record.id) || persistent?.[record.id];
      if (
        source &&
        source.fileMtimeMs === record.fileMtimeMs &&
        typeof source.text === 'string'
      ) {
        entries.set(record.id, {
          ...source,
          title: cleanSessionText(record.title) || source.title || record.id,
          openDirectory: cleanSessionText(record.openDirectory),
          sessionType: cleanSessionText(record.sessionType) || source.sessionType || 'main',
          archived: record.archived === true,
          todo: record.todo === true,
        });
      } else {
        toRead.push(record);
      }
    }

    // Read files in batches, yielding between batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < toRead.length; i += BATCH_SIZE) {
      const batch = toRead.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (record) => {
        try {
          const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
          const text = await extractSessionSearchText(sessionPath);
          entries.set(record.id, {
            sessionId: record.id,
            title: cleanSessionText(record.title) || record.id,
            openDirectory: cleanSessionText(record.openDirectory),
            sessionType: cleanSessionText(record.sessionType) || 'main',
            archived: record.archived === true,
            todo: record.todo === true,
            fileMtimeMs: record.fileMtimeMs || 0,
            text,
          });
        } catch {
          // Skip unreadable sessions
        }
      }));
      if (i + BATCH_SIZE < toRead.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Persist updated index (only if we actually read files)
    if (toRead.length > 0) {
      const persistData = {};
      for (const [id, entry] of entries) {
        persistData[id] = {
          sessionId: entry.sessionId,
          title: entry.title,
          openDirectory: entry.openDirectory,
          sessionType: entry.sessionType,
          archived: entry.archived,
          fileMtimeMs: entry.fileMtimeMs,
          text: entry.text,
        };
      }
      await savePersistentSearchIndex(agentId, persistData);
    }

    // Cache in memory
    _searchIndexCache.set(agentId, entries);
    return entries;
  })();

  _searchIndexBuilding.set(agentId, buildPromise);
  try {
    const result = await buildPromise;
    return result;
  } finally {
    _searchIndexBuilding.delete(agentId);
  }
}

function searchInText(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + queryLower.length + SEARCH_SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  // Strip role prefix from the beginning of snippet if present
  snippet = snippet.replace(/^\[[^\]]*\]\s*/, '');
  // Determine match role by looking backwards for role tag
  const beforeSnippet = text.slice(0, idx);
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^\[]*$/);
  const matchRole = lastRoleMatch ? lastRoleMatch[1] : '';
  return { snippet, matchRole, matchIndex: idx };
}

async function searchSessionsContent(agentId, query, openDirectory) {
  const entries = await ensureSearchIndex(agentId);
  const queryLower = query.toLowerCase();
  const results = [];

  // Normalize openDirectory for filtering
  const normalizedDir = openDirectory
    ? String(openDirectory).replace(/\\/g, '/').toLowerCase()
    : null;

  for (const [sessionId, entry] of entries) {
    // Filter by openDirectory
    if (normalizedDir) {
      const entryDir = String(entry.openDirectory || '').replace(/\\/g, '/').toLowerCase();
      if (entryDir !== normalizedDir) continue;
    }

    // Search in text content
    const match = searchInText(entry.text, queryLower);
    if (match) {
      results.push({
        sessionId: entry.sessionId,
        title: entry.title,
        openDirectory: entry.openDirectory,
        sessionType: entry.sessionType || 'main',
        archived: entry.archived === true,
        snippet: match.snippet,
        matchRole: match.matchRole,
        matchedInText: true,
      });
    }
  }

  // Sort by title relevance then by recency (approximated by sessionId timestamp)
  results.sort((a, b) => {
    // Exact title match gets priority
    const aTitle = a.title.toLowerCase().includes(queryLower) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(queryLower) ? 0 : 1;
    if (aTitle !== bTitle) return aTitle - bTitle;
    return String(b.sessionId).localeCompare(String(a.sessionId));
  });

  const total = results.length;
  const trimmed = results.slice(0, SEARCH_MAX_RESULTS);

  return {
    query,
    results: trimmed,
    total,
    indexed: entries.size,
  };
}

async function cleanupEmptySessions(agentId) {
  const index = await readSessionIndex(agentId);
  const toDelete = [];
  for (const record of index.sessions) {
    // Only target default "新对话N" titled sessions
    if (!/^新对话\d+$/.test(cleanSessionText(record.title))) continue;
    const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
    try {
      const raw = await fs.readFile(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
      // Empty session: no messages at all (never had user input)
      if (messages.length === 0) {
        toDelete.push(record.id);
      }
    } catch {
      // Session file missing or corrupt — also clean up
      toDelete.push(record.id);
    }
  }

  if (toDelete.length === 0) return 0;

  let nextActiveId = index.activeSessionId;
  const remaining = index.sessions.filter((s) => !toDelete.includes(s.id));
  if (toDelete.includes(nextActiveId)) {
    nextActiveId = remaining[0]?.id ?? null;
  }
  await writeSessionIndex(agentId, { activeSessionId: nextActiveId, sessions: remaining });

  for (const id of toDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, id), { force: true }).catch(() => {});
  }

  console.log(`[sessions] cleaned up ${toDelete.length} empty session(s) for ${agentId}: ${toDelete.join(', ')}`);
  return toDelete.length;
}

async function listPrebuiltSessions(agentId) {
  const index = await readSessionIndex(agentId);
  const summaryMap = await buildSessionSummaryMap(agentId);
  const modelInfoMap = await buildSessionModelInfoMap(agentId);
  const sessions = await Promise.all(index.sessions.map((record) => summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap)));

  // ── Batch writeback of stale index metadata ──
  const writebacks = [];
  for (const s of sessions) {
    if (s?._metaWriteback) {
      writebacks.push({ id: s.id, updatedAt: s.updatedAt, ...s._metaWriteback });
      delete s._metaWriteback;
    }
  }
  if (writebacks.length > 0) {
    updateSessionIndex(agentId, (idx) => {
      let dirty = false;
      const sessionMap = new Map(idx.sessions.map((s) => [s.id, s]));
      for (const wb of writebacks) {
        const existing = sessionMap.get(wb.id);
        if (!existing) continue;
        if (
          existing.fileMtimeMs === wb.fileMtimeMs &&
          existing.fileSize === wb.fileSize &&
          existing.metaVersion === wb.metaVersion
        ) continue; // already up-to-date (concurrent list may have written first)
        dirty = true;
        sessionMap.set(wb.id, {
          ...existing,
          fileMtimeMs: wb.fileMtimeMs,
          fileSize: wb.fileSize,
          messageCount: wb.messageCount,
          preview: wb.preview,
          tokenUsage: wb.tokenUsage,
          savedAt: wb.savedAt,
          metaVersion: wb.metaVersion,
          updatedAt: wb.updatedAt,
        });
      }
      if (!dirty) return idx;
      return { ...idx, sessions: Array.from(sessionMap.values()) };
    }).catch(() => {});
  }

  sessions.sort((left, right) => {
    const aUpdated = String(right.updatedAt || '');
    const bUpdated = String(left.updatedAt || '');
    if (aUpdated !== bUpdated) return aUpdated.localeCompare(bUpdated);
    const aCreated = String(right.createdAt || '');
    const bCreated = String(left.createdAt || '');
    if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
  const defaultModelInfo = modelInfoMap.default || modelInfoMap.main || {};
  return {
    activeSessionId: index.activeSessionId || (sessions[0]?.id ?? null),
    contextLength: defaultModelInfo.contextLength || null,
    compressRatio: defaultModelInfo.compressRatio || 80,
    sessions,
  };
}

async function buildSessionModelInfoMap(agentId) {
  const roles = ['default', 'exploration', 'sub'];
  const map = {};
  await Promise.all(roles.map(async (role) => {
    map[role] = await resolveSessionModelInfo(agentId, role);
  }));
  return map;
}

async function createPrebuiltSession(agentId, options = {}) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const sessionMetadata = normalizeSessionMetadata(options.metadata);
  const currentState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  const requestedFormId = cleanSessionText(options.formId) || (isProgrammingHelper ? '' : 'startup-form');
  const startupForm = isProgrammingHelper ? {} : (currentState?.forms?.['startup-form'] || {});
  const sourceForm = currentState?.forms?.[requestedFormId] || startupForm;
  const sourceSessionId = cleanSessionText(options.sourceSessionId);
  const preIndex = await readSessionIndex(agentId);
  const sourceSession = sourceSessionId
    ? preIndex.sessions.find((session) => session.id === sourceSessionId) || null
    : null;
  const createdAt = new Date().toISOString();
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const nextFeatureName =
    cleanSessionText(options.featureName)
    || cleanSessionText(sourceSession?.featureName)
    || cleanSessionText(sourceForm.feature_name)
    || cleanSessionText(startupForm.feature_name);
  const nextAgentName =
    cleanSessionText(options.agentName)
    || cleanSessionText(sourceSession?.agentName)
    || cleanSessionText(sourceForm.agent_name || sourceForm.assembly_name)
    || cleanSessionText(startupForm.agent_name);
  const assemblyForm = currentState?.forms?.['assembly-form'] || {};
  const nextAssemblyEnvDir =
    cleanSessionText(options.openDirectory)
    || cleanSessionText(sourceForm.env_dir)
    || cleanSessionText(assemblyForm.env_dir)
    || (requestedFormId === 'assembly-form' && nextAgentName ? getAssemblyWorkspaceDir(nextAgentName) : '');
  const nextOpenDirectory =
    requestedFormId === 'assembly-form'
      ? nextAssemblyEnvDir
      : (
        cleanSessionText(options.openDirectory)
        || cleanSessionText(sourceSession?.openDirectory)
        || cleanSessionText(currentState?.openDirectory)
      );
  const nextTaskTitle =
    cleanSessionText(options.taskTitle)
    || cleanSessionText(sourceSession?.taskTitle)
    || cleanSessionText(sourceForm.task_title)
    || cleanSessionText(startupForm.task_title);
  const nextTaskType =
    cleanSessionText(options.taskType)
    || cleanSessionText(sourceSession?.taskType)
    || cleanSessionText(sourceForm.task_type)
    || cleanSessionText(startupForm.task_type);
  const nextGoal =
    cleanSessionText(options.goal)
    || cleanSessionText(sourceSession?.goal)
    || cleanSessionText(sourceForm.goal)
    || cleanSessionText(startupForm.goal);
  const nextConstraints =
    cleanSessionText(options.constraints)
    || cleanSessionText(sourceSession?.constraints)
    || cleanSessionText(sourceForm.constraints)
    || cleanSessionText(startupForm.constraints);
  const nextExpectedOutput =
    cleanSessionText(options.expectedOutput)
    || cleanSessionText(sourceSession?.expectedOutput)
    || cleanSessionText(sourceForm.expected_output)
    || cleanSessionText(startupForm.expected_output);
  const nextTargetFiles =
    cleanSessionText(options.targetFiles)
    || cleanSessionText(sourceSession?.targetFiles)
    || cleanSessionText(sourceForm.target_files)
    || cleanSessionText(startupForm.target_files);
  const nextReferenceMaterials =
    cleanSessionText(options.referenceMaterials)
    || cleanSessionText(sourceSession?.referenceMaterials)
    || cleanSessionText(sourceForm.reference_materials)
    || cleanSessionText(startupForm.reference_materials);
  const sessionDisplayName = normalizedAgentId === 'agent-creator'
    ? nextAgentName
    : (normalizedAgentId === 'programming-helper' ? '' : nextFeatureName);
  const nextTitle = nextTaskTitle || (isProgrammingHelper
    ? await getNextNewSessionTitle(agentId, nextOpenDirectory)
    : buildNamedSessionTitle(sessionDisplayName, createdAt));
  // 解析当前模型配置，持久化到 session index record
  const sessionType = cleanSessionText(options.sessionType) || 'main';
  const modelRole = sessionType === 'exploration' ? 'exploration' : sessionType === 'sub' ? 'sub' : 'default';
  const currentModelInfo = await resolveSessionModelInfo(agentId, modelRole);

  const record = {
    id: sessionId,
    title: nextTitle,
    featureName: nextFeatureName,
    agentName: nextAgentName,
    taskTitle: nextTaskTitle,
    taskType: nextTaskType,
    goal: nextGoal,
    constraints: nextConstraints,
    expectedOutput: nextExpectedOutput,
    targetFiles: nextTargetFiles,
    referenceMaterials: nextReferenceMaterials,
    formId: requestedFormId,
    openDirectory: nextOpenDirectory,
    sessionType,
    metadata: sessionMetadata,
    modelName: currentModelInfo.modelName || '',
    contextLength: currentModelInfo.contextLength || null,
    createdAt,
    updatedAt: createdAt,
  };
  const nextIndex = await updateSessionIndex(agentId, (index) => {
    return {
      activeSessionId: sessionId,
      sessions: [record, ...index.sessions.filter((session) => session.id !== sessionId)],
    };
  });

  if (normalizedAgentId === 'feature-creator') {
    const featureName = nextFeatureName || cleanSessionText(startupForm.feature_name);
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    const targetDir = cleanSessionText(options.targetDir)
      || (openDirectory ? path.dirname(openDirectory) : cleanSessionText(startupForm.target_dir));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'startup-form': {
          ...startupForm,
          feature_name: featureName,
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'agent-creator') {
    const formId = requestedFormId;
    const targetForm = currentState.forms?.[formId] || {};
    const agentName = nextAgentName || cleanSessionText(targetForm.agent_name || targetForm.assembly_name || startupForm.agent_name);
    const openDirectory = formId === 'assembly-form'
      ? (nextOpenDirectory || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(agentName || 'assembled-agent'))
      : (nextOpenDirectory || cleanSessionText(currentState.openDirectory));
    const targetDir = cleanSessionText(options.targetDir)
      || (openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir || startupForm.target_dir));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'flow-workspace') {
    const formId = requestedFormId;
    const targetForm = currentState.forms?.[formId] || {};
    const agentName = nextAgentName || cleanSessionText(targetForm.agent_name || targetForm.assembly_name);
    const openDirectory = formId === 'assembly-form'
      ? (nextOpenDirectory || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(agentName || 'flow-agent'))
      : (nextOpenDirectory || cleanSessionText(currentState.openDirectory));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? { assembly_name: agentName, env_created: '1', env_dir: openDirectory }
            : { agent_name: agentName }),
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'programming-helper') {
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    const cleanedForms = { ...currentState.forms };
    delete cleanedForms['startup-form'];
    await writeWorkspaceState(agentId, {
      forms: cleanedForms,
      openDirectory,
    });
  }

  if (options.returnSummary === false) {
    return buildLightPrebuiltSessionRecord(agentId, record);
  }
  return summarizePrebuiltSession(agentId, record);
}

async function activatePrebuiltSession(agentId, sessionId, options = {}) {
  await updateSessionIndex(agentId, (index) => {
    const session = index.sessions.find((s) => s.id === sessionId);
    if (!session) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    return { ...index, activeSessionId: sessionId };
  });

  const index = await readSessionIndex(agentId);
  const existing = index.sessions.find((s) => s.id === sessionId);

  if (sanitizeSessionFragment(agentId) === 'feature-creator') {
    const currentState = await readWorkspaceState(agentId);
    const startupForm = currentState.forms?.['startup-form'] || {};
    const openDirectory = cleanSessionText(existing?.openDirectory) || cleanSessionText(currentState.openDirectory);
    const featureName = cleanSessionText(existing?.featureName) || cleanSessionText(startupForm.feature_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(startupForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'startup-form': {
          ...startupForm,
          feature_name: featureName,
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'agent-creator') {
    const currentState = await readWorkspaceState(agentId);
    const formId = cleanSessionText(existing.formId) || 'startup-form';
    const startupForm = currentState.forms?.['startup-form'] || {};
    const targetForm = currentState.forms?.[formId] || startupForm;
    const openDirectory = formId === 'assembly-form'
      ? (cleanSessionText(existing.openDirectory) || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(cleanSessionText(existing.agentName) || 'assembled-agent'))
      : (cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory));
    const agentName = cleanSessionText(existing.agentName) || cleanSessionText(targetForm.agent_name || targetForm.assembly_name || startupForm.agent_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir || startupForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'flow-workspace') {
    const currentState = await readWorkspaceState(agentId);
    const formId = cleanSessionText(existing.formId) || 'assembly-form';
    const targetForm = currentState.forms?.[formId] || {};
    const openDirectory = formId === 'assembly-form'
      ? (cleanSessionText(existing.openDirectory) || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(cleanSessionText(existing.agentName) || 'flow-agent'))
      : (cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory));
    const agentName = cleanSessionText(existing.agentName) || cleanSessionText(targetForm.agent_name || targetForm.assembly_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'programming-helper') {
    const currentState = await readWorkspaceState(agentId);
    const openDirectory = cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory);
    const cleanedForms = { ...currentState.forms };
    delete cleanedForms['startup-form'];
    await writeWorkspaceState(agentId, {
      forms: cleanedForms,
      openDirectory,
    });
  }

  if (options?.returnSummary === false) {
    return buildLightPrebuiltSessionRecord(agentId, existing);
  }
  return summarizePrebuiltSession(agentId, existing);
}

async function deletePrebuiltSession(agentId, sessionId) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const remainingSessions = index.sessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = index.activeSessionId === sessionId
      ? (remainingSessions[0]?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions };
  });

  await fs.rm(getPrebuiltSessionFilePath(agentId, sessionId), { force: true }).catch(() => {});

  return {
    deletedSessionId: sessionId,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function archivePrebuiltSession(agentId, sessionId, archived) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    const sessions = index.sessions.map((session) =>
      session.id === sessionId ? { ...session, archived: !!archived, todo: archived ? false : session.todo } : session,
    );
    return { activeSessionId: index.activeSessionId, sessions };
  });

  return {
    archivedSessionId: sessionId,
    archived: !!archived,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function tagPrebuiltSessionTodo(agentId, sessionId, todo) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    // Only non-archived sessions can be tagged as todo
    if (todo && existing.archived) {
      const error = new Error('Cannot tag an archived session as todo');
      error.statusCode = 400;
      throw error;
    }
    const sessions = index.sessions.map((session) =>
      session.id === sessionId ? { ...session, todo: !!todo } : session,
    );
    return { activeSessionId: index.activeSessionId, sessions };
  });

  return {
    todoSessionId: sessionId,
    todo: !!todo,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function requirePrebuiltSessionRecord(agentId, sessionId) {
  const index = await readSessionIndex(agentId);
  const existing = index.sessions.find((session) => session.id === cleanSessionText(sessionId));
  if (!existing) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }
  return existing;
}

async function resolvePrebuiltSessionOwner(sessionId, preferredAgentId = '') {
  const cleanSessionId = cleanSessionText(sessionId);
  if (!cleanSessionId) return null;

  const candidates = [];
  const addCandidate = (agentId) => {
    const normalized = normalizeClientAgentId(agentId);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  addCandidate(preferredAgentId);
  addCandidate('flow-workspace');
  addCandidate('agent-creator');
  addCandidate('feature-creator');
  addCandidate('programming-helper');
  try {
    const discovered = await discoverAgents(AGENTS_ROOT);
    discovered.forEach((agent) => addCandidate(agent?.id));
  } catch {}

  for (const agentId of candidates) {
    try {
      const index = await readSessionIndex(agentId);
      if (index.sessions.some((session) => session.id === cleanSessionId)) {
        return agentId;
      }
    } catch {}
  }

  return null;
}

async function requirePrebuiltAgentForRuntime(agentId) {
  const normalizedAgentId = normalizeClientAgentId(agentId);
  const discovered = await discoverAgents(AGENTS_ROOT);
  const metadata = discovered.find((item) => sanitizeSessionFragment(item.id) === normalizedAgentId);
  if (!metadata) {
    const error = new Error(`Unknown agent: ${agentId}`);
    error.statusCode = 404;
    throw error;
  }
  return enrichAgent(metadata);
}

async function exportContextHandoffForSession(sessionId, preferredAgentId = '', policy = {}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const summary = await summarizePrebuiltSession(ownerAgentId, record);
  if (!summary.exists) {
    const error = new Error(`Session snapshot not found for handoff export: ${sessionId}`);
    error.statusCode = 409;
    throw error;
  }
  const sessionPath = getPrebuiltSessionFilePath(ownerAgentId, sessionId);
  const normalizedStrategy = typeof policy?.strategy === 'string' ? policy.strategy.trim() : '';
  if (normalizedStrategy === 'summarized-nine-section') {
    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    return exportSummarizedHandoffPackage({
      userDataRoot: USER_DATA_ROOT,
      agentId: ownerAgentId,
      sessionId,
      sourceRecord: record,
      policy,
      agentRelativeDir: agent.relativeDir,
      projectRoot: __dirname,
    });
  }
  return exportHistoryOnlyHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sessionPath,
    sourceRecord: record,
    policy,
  });
}

async function createCompactedResumeFromHandoff({
  preferredAgentId = '',
  handoffId = '',
  handoffPath = '',
  goal = '',
  startRuntime = true,
}) {
  const normalizedAgentId = normalizeClientAgentId(preferredAgentId);
  if (!handoffPath && (!normalizedAgentId || !handoffId)) {
    const error = new Error('agentId is required when resuming from handoffId');
    error.statusCode = 400;
    throw error;
  }
  const { handoff, handoffPath: resolvedHandoffPath } = await readHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: normalizedAgentId || cleanSessionText(preferredAgentId),
    handoffId,
    handoffPath,
  });
  const sourceAgentId = cleanSessionText(handoff?.sourceAgentId);
  const sourceSessionId = cleanSessionText(handoff?.sourceSessionId);

  if (!sourceAgentId || !sourceSessionId) {
    const error = new Error('Invalid handoff package: sourceAgentId/sourceSessionId is required');
    error.statusCode = 400;
    throw error;
  }

  if (normalizedAgentId && normalizedAgentId !== sanitizeSessionFragment(sourceAgentId)) {
    const error = new Error('Phase-1 compacted resume only supports resuming within the source agent');
    error.statusCode = 400;
    throw error;
  }

  const agent = await requirePrebuiltAgentForRuntime(sourceAgentId);
  if (!handoff?.stats?.synthetic) {
    await requirePrebuiltSessionRecord(agent.id, sourceSessionId);
  }
  const session = await createPrebuiltSession(agent.id, {
    sourceSessionId,
    goal: goal || undefined,
      metadata: {
        resumeMode: 'compacted',
        sourceAgentId,
        sourceSessionId,
        handoffId: cleanSessionText(handoff?.handoffId) || cleanSessionText(handoffId),
        handoffPath: resolvedHandoffPath,
        handoffCreatedAt: cleanSessionText(handoff?.createdAt),
        handoffMode: cleanSessionText(handoff?.mode),
        handoffSummaryKind: cleanSessionText(handoff?.summaryShape),
      },
    });

  let status = null;
  let connected = null;
  if (startRuntime) {
    status = await startManagedAgent(agent, session.id, {
      extraEnv: {
        PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath,
      },
    });
    connected = await waitForManagedRuntimeReady(agent.id, 10000, session.id);
  }

  return {
    handoff,
    handoffPath: resolvedHandoffPath,
    session,
    status,
    agent: connected,
  };
}

async function compactAndResumeCurrentSession({
  preferredAgentId = '',
  sessionId = '',
  policy = {},
  startRuntime = true,
}) {
  const exportResult = await exportContextHandoffForSession(sessionId, preferredAgentId, policy);
  const handoffPath = cleanSessionText(exportResult?.handoffPath);
  const handoffId = cleanSessionText(exportResult?.handoff?.handoffId);
  return createCompactedResumeFromHandoff({
    preferredAgentId,
    handoffId,
    handoffPath,
    startRuntime,
  });
}

async function compactAndResumeFromProvidedSummary({
  preferredAgentId = '',
  sessionId = '',
  summaryText = '',
  rawResponse = '',
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  policy = {},
  startRuntime = true,
}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const handoffResult = await writeSummarizedHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sourceRecord: record,
    policy,
    summaryText,
    rawResponse,
    importantFiles,
    importantSkills,
    sessionTitle,
    fileRanges,
  });

  return createCompactedResumeFromHandoff({
    preferredAgentId: ownerAgentId,
    handoffId: cleanSessionText(handoffResult?.handoff?.handoffId),
    handoffPath: cleanSessionText(handoffResult?.handoffPath),
    startRuntime,
  });
}

async function exportProvidedSummaryHandoff({
  preferredAgentId = '',
  sessionId = '',
  summaryText = '',
  rawResponse = '',
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  policy = {},
  sessionTimestamp = null,
  gitMeta = null,
}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  return writeSummarizedHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sourceRecord: record,
    policy,
    summaryText,
    rawResponse,
    importantFiles,
    importantSkills,
    sessionTitle,
    fileRanges,
    sessionTimestamp,
    gitMeta,
  });
}

async function deletePrebuiltProject(agentId, projectId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!WORKSPACE_SESSION_AGENT_IDS.has(normalizedAgentId)) {
    const error = new Error(`Agent ${agentId} does not support project deletion`);
    error.statusCode = 400;
    throw error;
  }

  const state = await readWorkspaceState(agentId);
  const projectsKey = normalizedAgentId === 'feature-creator'
    ? 'featureProjects'
    : normalizedAgentId === 'programming-helper'
      ? 'phProjects'
      : 'agentProjects';
  const projects = Array.isArray(state[projectsKey]) ? [...state[projectsKey]] : [];
  const projectIndex = projects.findIndex((p) => p?.id === projectId);

  if (projectIndex < 0) {
    const error = new Error(`Unknown project: ${projectId}`);
    error.statusCode = 404;
    throw error;
  }

  const project = projects[projectIndex];
  const projectOpenDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim().toLowerCase().replace(/\\/g, '/') : '';
  const projectFeatureName = typeof (project.featureName || project.agentName) === 'string' ? (project.featureName || project.agentName).trim().toLowerCase() : '';

  projects.splice(projectIndex, 1);
  await writeWorkspaceState(agentId, { [projectsKey]: projects });

  let sessionsToDelete = [];
  let nextActiveSessionId = null;
  await updateSessionIndex(agentId, (index) => {
    sessionsToDelete = [];
    const remainingSessions = index.sessions.filter((session) => {
      const sessionDir = typeof session.openDirectory === 'string' ? session.openDirectory.trim().toLowerCase().replace(/\\/g, '/') : '';
      const sessionName = typeof (session.featureName || session.agentName) === 'string' ? (session.featureName || session.agentName).trim().toLowerCase() : '';
      const matchesDir = projectOpenDirectory && sessionDir === projectOpenDirectory;
      const matchesName = !projectOpenDirectory && projectFeatureName && sessionName === projectFeatureName;
      if (matchesDir || matchesName) {
        sessionsToDelete.push(session);
        return false;
      }
      return true;
    });

    const deletedWasActive = sessionsToDelete.some((s) => s.id === index.activeSessionId);
    nextActiveSessionId = deletedWasActive
      ? (remainingSessions[0]?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions };
  });

  for (const session of sessionsToDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, session.id), { force: true }).catch(() => {});
  }

  return {
    deletedProjectId: projectId,
    deletedSessionIds: sessionsToDelete.map((s) => s.id),
    activeSessionId: nextActiveSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

// ── FS operations extracted to server/routes/fs-operations.js ──

async function initializeFeatureCreatorWorkspace(rawFeatureName, rawParentDir) {
  const featureName = String(rawFeatureName || '').trim();
  const parentDir = path.resolve(String(rawParentDir || '').trim());

  if (!isValidFeatureName(featureName)) {
    const error = new Error('Invalid feature name. Use lowercase letters, numbers, and hyphens only.');
    error.statusCode = 400;
    throw error;
  }

  const parentStat = await fs.stat(parentDir).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) {
    const error = new Error(`Parent directory does not exist: ${parentDir}`);
    error.statusCode = 400;
    throw error;
  }

  const outputDir = resolveFeatureCreatorOutputDir(parentDir, featureName);
  const outputExists = await fs.stat(outputDir).then(() => true).catch(() => false);
  if (outputExists) {
    const error = new Error(`Feature directory already exists: ${outputDir}`);
    error.statusCode = 409;
    throw error;
  }

  const cliExists = await fs.stat(AGENTDEV_CREATE_FEATURE_CLI).then(() => true).catch(() => false);
  if (!cliExists) {
    const error = new Error(`Feature scaffold CLI not found: ${AGENTDEV_CREATE_FEATURE_CLI}`);
    error.statusCode = 500;
    throw error;
  }

  const { stdout, stderr } = await runCommand(process.execPath, [AGENTDEV_CREATE_FEATURE_CLI, featureName], {
    cwd: parentDir,
  });
  const metadataFiles = await ensureFeatureProjectManifest(outputDir);
  await ensureProjectDocset(outputDir, {
    workspaceId: 'feature-creator',
    projectType: 'feature',
    projectName: featureName,
    targetDir: parentDir,
  });

  return {
    featureName,
    parentDir,
    outputDir,
    metadataFiles,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function buildGeneratedAgentClassName(agentName) {
  const parts = String(agentName || '').trim().split('-').filter(Boolean);
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'GeneratedAgent';
}

function buildAgentWorkspacePackageJson(agentName) {
  return {
    name: `@local/${agentName}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: `${agentName} generated by AgentDevClaw agent creator`,
    scripts: {
      start: 'node agent.js',
    },
    dependencies: {
      agentdev: '^0.1.0',
      '@agentdev/audit-feature': '^0.1.0',
      '@agentdev/shell-feature': '^0.1.0',
      '@agentdev/websearch-feature': '^0.1.0',
    },
    engines: {
      node: '>=20',
    },
  };
}

function buildAgentWorkspaceMetadata(agentName, goal) {
  const displayName = buildGeneratedAgentClassName(agentName);

  return {
    id: agentName,
    kind: 'agent',
    name: displayName,
    description: goal || `${agentName} generated by AgentDevClaw`,
    version: '0.1.0',
    icon: 'bot',
    category: 'custom',
    enabled: true,
    features: ['todo', 'audit', 'shell', 'websearch', 'user-input', 'mcp', 'skill'],
    ui: {
      entry: 'home',
      tabs: [
        {
          id: 'home',
          label: {
            zh: '首页',
            en: 'Home',
          },
        },
        {
          id: 'chat',
          label: {
            zh: '对话',
            en: 'Chat',
          },
        },
      ],
      home: {
        blocks: [
          {
            id: 'hero',
            type: 'hero',
            title: {
              zh: displayName,
              en: displayName,
            },
            body: {
              zh: goal || '这是一个由 Agent 创建者初始化的 Agent 工作空间，可以继续补全能力、提示词和挂载的 Features。',
              en: goal || 'This agent workspace was initialized by Agent Creator and can now be extended with prompts and features.',
            },
          },
          {
            id: 'session-list',
            type: 'session-list',
            visibility: 'home-default',
            title: {
              zh: '历史会话',
              en: 'Sessions',
            },
            description: {
              zh: '恢复或继续这个 Agent 的工作会话。',
              en: 'Resume prior work sessions for this agent.',
            },
          },
        ],
      },
    },
  };
}

function buildAgentWorkspaceAgentSource(agentName, goal) {
  const className = `${buildGeneratedAgentClassName(agentName)}Agent`;

  return `import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

export class ${className} extends BasicAgent {
  constructor(config = {}) {
    super(config);

    this.use(new TodoFeature({
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));
    this.use(new AuditFeature());
    this.use(new WebSearchFeature());
    this.use(new ShellFeature());
    this.use(new UserInputFeature());
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\\n\\n## 当前目标\\n\\n')
      .add(${JSON.stringify(goal || '请根据用户需求继续完善这个 Agent 的能力、提示词与工作流。')})
      .add('\\n\\n## 可用技能\\n\\n')
      .add({ skills: '- **{{name}}**: {{description}}' }));
  }
}
`;
}

function buildAgentWorkspaceSystemPrompt(agentName, goal) {
  return `# ${buildGeneratedAgentClassName(agentName)}

你是 \`${agentName}\` 的系统提示词草稿。

## 目标

${goal || '根据用户后续要求继续完善你的职责与边界。'}

## 默认约束

- 先澄清用户意图，再执行
- 优先复用现有 Feature、Skills 和 MCP 能力
- 如果用户要求改代码，先确认范围，再最小化修改
`;
}

function buildAgentWorkspaceReadme(agentName, goal) {
  return `# ${agentName}

由 AgentDevClaw 的 Agent 创建者初始化。

## 当前目标

${goal || '待补充'}

## 初始结构

- \`agent.js\`: Agent 入口
- \`metadata.json\`: Claw 预制工作空间元数据草稿
- \`.agentdev/prompts/system.md\`: 系统提示词草稿
- \`package.json\`: 基础依赖与脚本
`;
}

async function initializeAgentCreatorWorkspace(rawAgentName, rawParentDir, rawGoal) {
  const agentName = String(rawAgentName || '').trim();
  const parentDir = path.resolve(String(rawParentDir || '').trim());
  const goal = String(rawGoal || '').trim();

  if (!isValidFeatureName(agentName)) {
    const error = new Error('Invalid agent name. Use lowercase letters, numbers, and hyphens only.');
    error.statusCode = 400;
    throw error;
  }

  const parentStat = await fs.stat(parentDir).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) {
    const error = new Error(`Parent directory does not exist: ${parentDir}`);
    error.statusCode = 400;
    throw error;
  }

  const outputDir = path.join(parentDir, agentName);
  const outputExists = await fs.stat(outputDir).then(() => true).catch(() => false);
  if (outputExists) {
    const error = new Error(`Agent directory already exists: ${outputDir}`);
    error.statusCode = 409;
    throw error;
  }

  await fs.mkdir(path.join(outputDir, '.agentdev', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(outputDir, 'package.json'), `${JSON.stringify(buildAgentWorkspacePackageJson(agentName), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'metadata.json'), `${JSON.stringify(buildAgentWorkspaceMetadata(agentName, goal), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'agent.js'), buildAgentWorkspaceAgentSource(agentName, goal), 'utf8');
  await fs.writeFile(path.join(outputDir, '.agentdev', 'prompts', 'system.md'), buildAgentWorkspaceSystemPrompt(agentName, goal), 'utf8');
  await fs.writeFile(path.join(outputDir, 'README.md'), buildAgentWorkspaceReadme(agentName, goal), 'utf8');
  await ensureProjectDocset(outputDir, {
    workspaceId: 'agent-creator',
    projectType: 'agent',
    projectName: agentName,
    targetDir: parentDir,
    goal,
  });

  return {
    agentName,
    parentDir,
    outputDir,
    files: [
      'package.json',
      'metadata.json',
      'agent.js',
      '.agentdev/prompts/system.md',
      'README.md',
    ],
  };
}

async function discoverAgents(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await discoverAgents(rootDir, entryPath));
      continue;
    }

    if (entry.isFile() && entry.name === 'metadata.json') {
      const metadata = await readJson(entryPath);
      const agentDir = path.dirname(entryPath);
      results.push({
        ...metadata,
        id: metadata.id ?? path.basename(agentDir),
        relativeDir: path.relative(__dirname, agentDir).replace(/\\/g, '/'),
        agentPath: agentDir,
      });
    }
  }

  return results.sort((left, right) => {
    const leftOrder = typeof left.sortOrder === 'number' ? left.sortOrder : null;
    const rightOrder = typeof right.sortOrder === 'number' ? right.sortOrder : null;
    if (leftOrder !== null && rightOrder !== null) return leftOrder - rightOrder;
    if (leftOrder !== null) return -1;
    if (rightOrder !== null) return 1;
    return (left.name || left.id).localeCompare(right.name || right.id, 'zh-CN');
  });
}

async function getAgentsLight() {
  const agents = await discoverAgents(AGENTS_ROOT);
  const visibleAgents = agents.filter((agent) => !HIDDEN_PREBUILT_AGENT_IDS.has(sanitizeSessionFragment(agent.id)));
  return visibleAgents.map((agent) => ({ ...agent, status: buildStatus(agent.id) }));
}

async function resolveAgentModelPresets(agentId, metaPresets = null) {
  const userConfigPath = path.join(__dirname, '.agentdev', 'agent-configs', `${agentId}.json`);
  const userConfig = await readJsonSafe(userConfigPath, null);
  const userPresets = userConfig?.modelPresets || null;
  if (!userPresets) return metaPresets || null;
  return {
    ...(metaPresets && typeof metaPresets === 'object' ? metaPresets : {}),
    ...userPresets,
  };
}

async function enrichAgent(agent) {
  return {
    ...agent,
    workspace_sessions: await listPrebuiltSessions(agent.id),
    workspace_data: await resolveWorkspaceData(agent),
    workspace_state: await readWorkspaceState(agent.id),
    modelPresets: await resolveAgentModelPresets(agent.id, agent.modelPresets),
  };
}

async function getAgents() {
  const lightAgents = await getAgentsLight();
  return Promise.all(lightAgents.map(enrichAgent));
}

async function requireAgentLight(agentId) {
  const lightAgents = await getAgentsLight();
  const agent = lightAgents.find((item) => item.id === agentId);
  if (agent) return agent;
  // Fallback: hidden agents (e.g. work-group-admin) are not in getAgentsLight
  const allAgents = await discoverAgents(AGENTS_ROOT);
  const hidden = allAgents.find((item) => item.id === agentId);
  if (hidden) return { ...hidden, status: buildStatus(agentId) };
  const error = new Error(`Unknown agent: ${agentId}`);
  error.statusCode = 404;
  throw error;
}

async function requireAgent(agentId) {
  const agent = await requireAgentLight(agentId);
  return enrichAgent(agent);
}

function normalizeClientAgentId(value, fallback = '') {
  const text = cleanSessionText(value);
  if (!text) return fallback;
  const lower = text.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return fallback;
  return sanitizeSessionFragment(text);
}

async function readViewerJson(pathname) {
  const response = await fetch(`${VIEWER_ORIGIN}${pathname}`);
  if (!response.ok) {
    throw new Error(`Viewer request failed: ${pathname} ${response.status}`);
  }
  return response.json();
}

async function getPendingInputCount(runtimeSessionId) {
  try {
    const items = await readViewerJson(`/api/agents/${encodeURIComponent(runtimeSessionId)}/input-requests`);
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return null;
  }
}

function resolveActiveWorkspaceSessionMeta(agent) {
  const sessions = Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
  const activeSessionId = cleanSessionText(agent?.status?.selectedSessionId || agent?.workspace_sessions?.activeSessionId);
  if (!activeSessionId) {
    return {
      active_workspace_session_id: null,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }

  const matched = sessions.find((session) => cleanSessionText(session?.id) === activeSessionId) || null;
  const formId = cleanSessionText(matched?.formId);
  const title = cleanSessionText(matched?.title);
  const agentName = cleanSessionText(matched?.agentName);
  const displayName = formId === 'assembly-form'
    ? (agentName || title)
    : '';

  return {
    active_workspace_session_id: activeSessionId,
    active_workspace_session_form_id: formId || null,
    active_workspace_session_title: title,
    active_workspace_agent_name: agentName,
    active_workspace_display_name: displayName,
  };
}

async function resolveRuntimeDisplayName(agent, selectedSessionId = null) {
  const fallbackName = cleanSessionText(agent?.name) || cleanSessionText(agent?.id) || 'agent';
  const requestedSessionId = cleanSessionText(selectedSessionId);
  if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
    try {
      const imConfig = await readProjectIMWorkspaceConfig();
      return getPortalAgentDisplayName(imConfig.selectedChannel);
    } catch {}
    return getPortalAgentDisplayName('qq');
  }
  if (!requestedSessionId) {
    return fallbackName;
  }

  try {
    const sessionIndex = await readSessionIndex(agent.id);
    const sessionRecord = sessionIndex.sessions.find((session) => cleanSessionText(session?.id) === requestedSessionId) || { id: requestedSessionId };
    const sessionSummary = await summarizePrebuiltSession(agent.id, sessionRecord);
    const formId = cleanSessionText(sessionSummary?.formId);
    if (sanitizeSessionFragment(agent?.id) === 'agent-creator' && formId === 'assembly-form') {
      return cleanSessionText(sessionSummary?.agentName) || cleanSessionText(sessionSummary?.title) || fallbackName;
    }
  } catch {
  }

  return fallbackName;
}

async function readWorkspaceSessionSnapshot(agentId) {
  const index = await readSessionIndex(agentId);
  return {
    activeSessionId: index.activeSessionId || null,
    sessions: index.sessions.map((record) => buildLightPrebuiltSessionRecord(agentId, record)),
  };
}

async function readActiveWorkspaceSessionMeta(agent) {
  const workspaceSessions = await readWorkspaceSessionSnapshot(agent.id);
  const selectedSessionId = cleanSessionText(agent?.status?.selectedSessionId || workspaceSessions.activeSessionId);
  if (!selectedSessionId) {
    let noSessionDisplayName = '';
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      try {
        const imConfig = await readProjectIMWorkspaceConfig();
        noSessionDisplayName = getPortalAgentDisplayName(imConfig.selectedChannel);
      } catch {}
    }
    return {
      workspaceSessions,
      sessionMeta: {
        active_workspace_session_id: null,
        active_workspace_session_form_id: null,
        active_workspace_session_title: '',
        active_workspace_agent_name: '',
        active_workspace_display_name: noSessionDisplayName,
      },
    };
  }

  const matched = Array.isArray(workspaceSessions.sessions)
    ? workspaceSessions.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
    : null;
  let title = cleanSessionText(matched?.title);
  let agentName = cleanSessionText(matched?.agentName);
  let formId = cleanSessionText(matched?.formId);

  if (!matched) {
    try {
      const index = await readSessionIndex(agent.id);
      const record = Array.isArray(index?.sessions)
        ? index.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
        : null;
      title = cleanSessionText(record?.title);
      agentName = cleanSessionText(record?.agentName);
      formId = cleanSessionText(record?.formId);
    } catch {}
  }

  let displayName = formId === 'assembly-form'
    ? (agentName || title)
    : '';
  if (!displayName && sanitizeSessionFragment(agent.id) === 'qqbot') {
    try {
      const imConfig = await readProjectIMWorkspaceConfig();
      displayName = getPortalAgentDisplayName(imConfig.selectedChannel);
    } catch {}
  }

  return {
    workspaceSessions: {
      ...workspaceSessions,
      activeSessionId: selectedSessionId,
    },
    sessionMeta: {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: formId || null,
      active_workspace_session_title: title,
      active_workspace_agent_name: agentName,
      active_workspace_display_name: displayName,
    },
  };
}

async function readWorkspaceSessionMeta(agentId, sessionId) {
  const selectedSessionId = cleanSessionText(sessionId);
  if (!selectedSessionId) {
    return {
      active_workspace_session_id: null,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }

  try {
    const index = await readSessionIndex(agentId);
    const record = Array.isArray(index?.sessions)
      ? index.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
      : null;
    const title = cleanSessionText(record?.title);
    const agentName = cleanSessionText(record?.agentName);
    const formId = cleanSessionText(record?.formId);
    let displayName = formId === 'assembly-form' ? (agentName || title) : '';
    if (!displayName && sanitizeSessionFragment(agentId) === 'qqbot') {
      try {
        const imConfig = await readProjectIMWorkspaceConfig();
        displayName = getPortalAgentDisplayName(imConfig.selectedChannel);
      } catch {}
    }
    return {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: formId || null,
      active_workspace_session_title: title,
      active_workspace_agent_name: agentName,
      active_workspace_display_name: displayName,
    };
  } catch {
    return {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }
}

async function getConnectedAgents() {
  const prebuiltAgents = await getAgentsLight();
  const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [], currentAgentId: null }));
  const runtimeAgents = Array.isArray(viewerData.agents) ? viewerData.agents : [];
  const managedRuntimeByViewerId = new Map(
    Array.from(managedAgents.values())
      .filter((runtime) => runtime?.viewerAgentId && runtime.process && runtime.process.exitCode === null && !runtime.stopped)
      .map((runtime) => [String(runtime.viewerAgentId), runtime])
  );

  const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
    const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
    return {
      id: agent.id,
      name: agent.name,
      base_name: agent.name,
      description: agent.description,
      kind: agent.kind || 'agent',
      launchMode: agent.launchMode || null,
      ui: agent.ui || null,
      workspace: agent.workspace || null,
      workspace_sessions: workspaceSessions,
      workspace_data: {},
      workspace_state: { forms: {}, openDirectory: '', updatedAt: null },
      active_workspace_session_id: sessionMeta.active_workspace_session_id,
      active_workspace_session_form_id: sessionMeta.active_workspace_session_form_id,
      active_workspace_session_title: sessionMeta.active_workspace_session_title,
      active_workspace_agent_name: sessionMeta.active_workspace_agent_name,
      active_workspace_display_name: sessionMeta.active_workspace_display_name,
      status: 'stopped',
      source: 'prebuilt',
      parent_id: null,
      connection_info: null,
      pid: agent.status.pid,
      runtime_session_id: agent.status.viewerAgentId,
      message_count: 0,
      pending_input_count: null,
      created_at: null,
      modelPresets: await resolveAgentModelPresets(agent.id, agent.modelPresets),
      connected: false,
    };
  }));

  for (const runtimeAgent of runtimeAgents) {
    const managedRuntime = managedRuntimeByViewerId.get(String(runtimeAgent.id || '')) || null;
    if (managedRuntime) {
      const runtimeMeta = await readWorkspaceSessionMeta(managedRuntime.agentId, managedRuntime.selectedSessionId);
      connectedAgents.push({
        id: runtimeAgent.id,
        name: runtimeMeta.active_workspace_display_name
          || runtimeMeta.active_workspace_agent_name
          || runtimeMeta.active_workspace_session_title
          || runtimeAgent.name,
        description: runtimeAgent.description || '',
        status: runtimeAgent.connected ? 'running' : 'stopped',
        source: 'child',
        parent_id: managedRuntime.agentId,
        active_workspace_session_id: runtimeMeta.active_workspace_session_id,
        active_workspace_session_form_id: runtimeMeta.active_workspace_session_form_id,
        active_workspace_session_title: runtimeMeta.active_workspace_session_title,
        active_workspace_agent_name: runtimeMeta.active_workspace_agent_name,
        active_workspace_display_name: runtimeMeta.active_workspace_display_name,
        connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
        pid: runtimeAgent.pid || managedRuntime.process?.pid || null,
        runtime_session_id: runtimeAgent.id,
        message_count: runtimeAgent.messageCount ?? 0,
        pending_input_count: await getPendingInputCount(runtimeAgent.id),
        created_at: runtimeAgent.createdAt ?? managedRuntime.startedAt ?? null,
        connected: runtimeAgent.connected ?? false,
      });
      continue;
    }

    const explicitParentHost = connectedAgents.find((agent) =>
      agent.source === 'prebuilt'
      && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || ''));
    const isExplicitChildRuntime = !!runtimeAgent.parentAgentId && !!explicitParentHost;

    const workspaceHostParent = connectedAgents.find((agent) =>
      agent.source === 'prebuilt'
      && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || '')
      && (agent.id === 'agent-creator' || agent.id === 'feature-creator'));
    const isWorkspaceHostRuntime =
      workspaceHostParent
      && (cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.base_name)
        || cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.name));
    if (isWorkspaceHostRuntime) {
      continue;
    }

    const matched = connectedAgents.find((agent) => agent.id === runtimeAgent.id)
      || connectedAgents.find((agent) => agent.source === 'prebuilt' && agent.runtime_session_id === runtimeAgent.id)
      || (!isExplicitChildRuntime
        ? connectedAgents.find((agent) => agent.source === 'prebuilt' && (agent.base_name === runtimeAgent.name || agent.name === runtimeAgent.name))
        : null);
    const exposeAsSeparateAssemblyRuntime = matched
      && matched.source === 'prebuilt'
      && (sanitizeSessionFragment(matched.id) === 'agent-creator' || sanitizeSessionFragment(matched.id) === 'flow-workspace')
      && cleanSessionText(matched.active_workspace_session_form_id) === 'assembly-form';

    if (matched && !exposeAsSeparateAssemblyRuntime) {
      matched.status = runtimeAgent.connected ? 'running' : matched.status;
      matched.connection_info = 'viewer://127.0.0.1:2026';
      matched.runtime_session_id = runtimeAgent.id;
      matched.message_count = runtimeAgent.messageCount ?? 0;
      matched.created_at = runtimeAgent.createdAt ?? null;
      matched.connected = runtimeAgent.connected ?? false;
      matched.pending_input_count = await getPendingInputCount(runtimeAgent.id);
      continue;
    }

    if (!runtimeAgent.connected) {
      continue;
    }

    connectedAgents.push({
      id: runtimeAgent.id,
      name: runtimeAgent.name,
      description: runtimeAgent.description || '',
      status: runtimeAgent.connected ? 'running' : 'stopped',
      source: exposeAsSeparateAssemblyRuntime ? 'external' : (runtimeAgent.parentAgentId ? 'child' : 'external'),
      parent_id: exposeAsSeparateAssemblyRuntime ? matched.id : (runtimeAgent.parentAgentId || null),
      active_workspace_session_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_id || null) : null,
      active_workspace_session_form_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_form_id || null) : null,
      active_workspace_session_title: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_title || null) : null,
      active_workspace_agent_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_agent_name || null) : null,
      active_workspace_display_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_display_name || null) : null,
      connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
      pid: runtimeAgent.pid || null,
      runtime_session_id: runtimeAgent.id,
      message_count: runtimeAgent.messageCount ?? 0,
      pending_input_count: await getPendingInputCount(runtimeAgent.id),
      created_at: runtimeAgent.createdAt ?? null,
      connected: runtimeAgent.connected ?? false,
    });
  }

  for (const managed of connectedAgents) {
    const status = buildStatus(managed.id);
    if (status.status === 'running') {
      managed.status = 'running';
      managed.pid = status.pid;
      managed.active_workspace_session_id = status.selectedSessionId || managed.active_workspace_session_id;
      if (status.viewerAgentId) {
        managed.runtime_session_id = status.viewerAgentId;
      }
    } else if (managed.source === 'prebuilt') {
      managed.status = 'stopped';
      managed.pid = null;
      managed.runtime_session_id = null;
      managed.message_count = 0;
      managed.pending_input_count = null;
      managed.connected = false;
      managed.callActive = false;
    }
  }

  // 查询每个 connected agent 的 call 状态（从 ViewerWorker notification）
  await Promise.all(connectedAgents
    .filter((agent) => agent.connected && agent.runtime_session_id)
    .map(async (agent) => {
      try {
        const notif = await readViewerJson(`/api/agents/${encodeURIComponent(agent.runtime_session_id)}/notification`);
        agent.callActive = notif?.callActive === true;
      } catch {
        agent.callActive = false;
      }
    })
  );

  return connectedAgents;
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function waitForManagedRuntimeReady(agentId, timeoutMs = 10000, sessionId = undefined) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runtime = getAgentRuntime(agentId, sessionId);
    // Exploration agents run headlessly (no ViewerWorker) — just check ready flag
    if (runtime?.sessionType === 'exploration') {
      if (runtime.ready) return runtime;
    } else {
      const status = buildStatus(agentId, sessionId);
      if (status.viewerAgentId && runtime?.ready) {
        const agents = await getConnectedAgents();
        const viewerAgentId = cleanSessionText(status.viewerAgentId);
        const connected = agents.find((agent) => cleanSessionText(agent.id) === viewerAgentId || cleanSessionText(agent.runtime_session_id || agent.runtimeSessionId) === viewerAgentId);
        if (connected) {
          return connected;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function waitForAssemblyRuntimeReady(sessionId, timeoutMs = 10000) {
  const normalizedSessionId = sanitizeSessionFragment(sessionId);
  const start = Date.now();
  console.log(`[PERF] waitForAssemblyRuntimeReady BEGIN session=${normalizedSessionId} timeout=${timeoutMs}`);
  while (Date.now() - start < timeoutMs) {
    const runtime = getAssemblyRuntime(normalizedSessionId);
    if (runtime?.viewerAgentId && runtime?.ready) {
      const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
      const agents = Array.isArray(viewerData?.agents) ? viewerData.agents : [];
      const connected = agents.find((agent) => agent.id === runtime.viewerAgentId);
      if (connected) {
        console.log(`[PERF] waitForAssemblyRuntimeReady FOUND (${Date.now() - start}ms)`);
        return connected;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`[PERF] waitForAssemblyRuntimeReady TIMEOUT (${Date.now() - start}ms)`);
  return null;
}

async function startManagedAgent(agent, selectedSessionId = undefined, runtimeOptions = {}) {
  const requestedSessionId = typeof selectedSessionId === 'string' && selectedSessionId
    ? sanitizeSessionFragment(selectedSessionId)
    : (selectedSessionId === null ? null : undefined);
  let preferredSessionId = null;
  if (requestedSessionId === undefined && sanitizeSessionFragment(agent?.id) === 'qqbot') {
    preferredSessionId = (await readProjectIMWorkspaceConfig().catch(() => ({ receptionistSessionId: '' })))?.receptionistSessionId || null;
  }
  const existing = getAgentRuntime(agent.id, requestedSessionId);
  const resolvedSessionId = requestedSessionId !== undefined
    ? requestedSessionId
    : (preferredSessionId || existing?.selectedSessionId || agent.workspace_sessions?.activeSessionId || null);

  if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
    const siblings = listAgentRuntimes(agent.id).filter((rt) =>
      rt?.process && rt.process.exitCode === null && !rt.stopped
      && rt !== existing
    );
    for (const rt of siblings) {
      rt.stopped = true;
      rt.process.kill('SIGTERM');
    }
    await Promise.all(siblings.map((rt) => waitForProcessExit(rt.process)));
  }

  if (resolvedSessionId && !runtimeOptions?.extraEnv?.PROTOCLAW_HANDOFF_PATH) {
    try {
      const idx = await readSessionIndex(agent.id);
      const sessionRecord = idx.sessions.find(s => s.id === resolvedSessionId);
      if (sessionRecord?.metadata?.handoffPath) {
        // Only pass handoff env when the session has no persisted messages yet.
        // If the session file already exists and contains messages, the handoff
        // was already consumed on first boot and re-injecting would duplicate
        // seed messages with conflicting turn values.
        let shouldInjectHandoff = true;
        try {
          const sessionPath = getPrebuiltSessionFilePath(agent.id, resolvedSessionId);
          const raw = await fs.readFile(sessionPath, 'utf8');
          const snapshot = JSON.parse(raw);
          const messages = snapshot?.runtime?.context?.messages;
          if (Array.isArray(messages) && messages.length > 0) {
            shouldInjectHandoff = false;
          }
        } catch {
          // Session file doesn't exist or is unreadable — safe to inject
        }
        if (shouldInjectHandoff) {
          runtimeOptions = {
            ...runtimeOptions,
            extraEnv: {
              ...(runtimeOptions?.extraEnv || {}),
              PROTOCLAW_HANDOFF_PATH: sessionRecord.metadata.handoffPath,
            },
          };
        }
      }
    } catch {}
  }

  if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
    if (!resolvedSessionId || existing.selectedSessionId === resolvedSessionId) {
      return buildStatus(agent.id, resolvedSessionId);
    }

    existing.stopped = true;
    existing.process.kill('SIGTERM');
    await waitForProcessExit(existing.process);
  }

  if (existing?.process && existing.process.exitCode === null && existing.stopped) {
    await waitForProcessExit(existing.process);
  }

  const runtimeDisplayName = await resolveRuntimeDisplayName(agent, resolvedSessionId);

  const isExplorationSession = runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE === 'exploration';
  const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: sanitizeSpawnEnv({
      ...process.env,
      ...(isExplorationSession ? {} : {
        AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
        AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
        AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
      }),
      PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
      PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
      PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
      ...(runtimeOptions?.extraEnv && typeof runtimeOptions.extraEnv === 'object' ? runtimeOptions.extraEnv : {}),
    }),
    windowsHide: true,
  });

  const runtime = {
    key: getManagedRuntimeKey(agent.id, resolvedSessionId),
    agentId: agent.id,
    id: agent.id,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    stopped: false,
    viewerAgentId: null,
    selectedSessionId: resolvedSessionId || null,
    ready: false,
    sessionType: runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE || null,
  };

  managedAgents.set(runtime.key, runtime);

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    const match = text.match(/Viewer Agent ID:\s*([^\s]+)/);
    if (match) {
      runtime.viewerAgentId = match[1];
    }
    if (text.includes('[ProtoClaw Runtime] READY session=')) {
      runtime.ready = true;
      // Notify runtime-ready hook (for event-driven dispatch schedules)
      notifyRuntimeReady(agent.id, resolvedSessionId || null);
    }
    log(agent.id, text.trim());
  });

  child.stderr.on('data', (chunk) => {
    log(agent.id, String(chunk).trim(), 'error');
  });

  child.on('exit', (code) => {
    const current = managedAgents.get(runtime.key);
    if (current && current === runtime) {
      current.exitCode = code;
      current.stopped = true;
    }
    log(agent.id, `process exited with code ${code ?? 'null'}`);
  });

  child.on('error', (error) => {
    const current = managedAgents.get(runtime.key);
    if (current) {
      current.exitCode = 1;
      current.stopped = true;
    }
    log(agent.id, `failed to start: ${error.message}`, 'error');
  });

  return buildStatus(agent.id, resolvedSessionId);
}

/**
 * 启动一次性子代理（阻塞式）。
 *
 * 与 startManagedAgent 不同：
 * - 使用 run-one-shot-agent.js 而非 run-prebuilt-agent.js
 * - 不连接 ViewerWorker
 * - 只执行一次 onCall(goal) 后退出
 * - 返回 Promise，在进程退出时 resolve
 */
async function startOneShotAgent(agent, sessionId, goal, options = {}) {
  const resolvedSessionId = sanitizeSessionFragment(sessionId);
  const timeoutMs = options.timeoutMs || 300000;

  return new Promise((resolve, reject) => {
    let resultLine = null;
    const stdoutChunks = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`One-shot agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const child = spawn(process.execPath, [
      ONE_SHOT_SCRIPT,
      agent.relativeDir,
      agent.id,
      resolvedSessionId,
      goal,
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv({
        ...process.env,
        PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
        ...(options.extraEnv && typeof options.extraEnv === 'object' ? options.extraEnv : {}),
      }),
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdoutChunks.push(text);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('ONE_SHOT_RESULT:')) {
          resultLine = line;
        }
      }
      log(agent.id, text.trim());
    });

    child.stderr.on('data', (chunk) => {
      log(agent.id, String(chunk).trim(), 'error');
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      log(agent.id, `one-shot process exited with code ${code ?? 'null'}`);

      if (resultLine) {
        try {
          const jsonStr = resultLine.slice('ONE_SHOT_RESULT:'.length);
          const result = JSON.parse(jsonStr);
          resolve({ exitCode: code, result, stdout: stdoutChunks.join('') });
        } catch (err) {
          reject(new Error(`Failed to parse one-shot result: ${err.message}`));
        }
      } else {
        reject(new Error(
          `One-shot agent exited (code ${code}) without producing a result. ` +
          `stdout: ${stdoutChunks.join('').slice(-500)}`,
        ));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`One-shot agent failed to start: ${error.message}`));
    });
  });
}

async function startAssemblyRuntime(sessionId, agentId = 'agent-creator', preActivatedSession = null, preloadedWorkspaceState = null) {
  const _t0 = Date.now();
  console.log(`[PERF] startAssemblyRuntime BEGIN session=${sessionId} agent=${agentId} hasSession=${!!preActivatedSession} hasState=${!!preloadedWorkspaceState}`);
  const agent = await requireAgentLight(agentId || 'agent-creator');
  let session = preActivatedSession || await activatePrebuiltSession(agent.id, sessionId);
  if (!preActivatedSession) {
    console.log(`[PERF] startAssemblyRuntime activatePrebuiltSession (${Date.now() - _t0}ms)`);
  } else {
    console.log(`[PERF] startAssemblyRuntime using pre-activated session (${Date.now() - _t0}ms)`);
  }
  const normalizedSessionId = sanitizeSessionFragment(session.id);
  const existing = getAssemblyRuntime(normalizedSessionId);

  if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
    return existing;
  }

  const workspaceState = preloadedWorkspaceState || await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
  if (!preloadedWorkspaceState) {
    console.log(`[PERF] startAssemblyRuntime readWorkspaceState (${Date.now() - _t0}ms)`);
  }
  const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
  const runtimeDisplayName = cleanSessionText(session.agentName)
    || cleanSessionText(assemblyForm.assembly_name)
    || 'assembled-agent';
  const assemblyWorkspace = cleanSessionText(assemblyForm.env_dir) || getAssemblyWorkspaceDir(runtimeDisplayName);
  const selectedFeatures = parseListField(assemblyForm.selected_features);
  const customWorkdir = cleanSessionText(assemblyForm.workdir);
  const runtimeWorkdir = customWorkdir || assemblyWorkspace;

  if (cleanSessionText(session.openDirectory) !== assemblyWorkspace) {
    let updatedSession = session;
    await updateSessionIndex(agent.id, (index) => {
      const sessions = index.sessions.map((item) => item.id === session.id
        ? { ...item, openDirectory: assemblyWorkspace, updatedAt: new Date().toISOString() }
        : item);
      updatedSession = sessions.find((item) => item.id === session.id) || session;
      return { ...index, sessions };
    });
    session = await summarizePrebuiltSession(agent.id, updatedSession);
  }

  await ensureAssemblyWorkspaceBase(assemblyWorkspace, runtimeDisplayName);
  console.log(`[PERF] startAssemblyRuntime ensureBase (${Date.now() - _t0}ms)`);
  const installResult = await ensureAssemblyWorkspaceDependencies(assemblyWorkspace, selectedFeatures);
  console.log(`[PERF] startAssemblyRuntime ensureDeps (${Date.now() - _t0}ms) skipped=${installResult.skipped}`);
  if (installResult.installedPackages.length > 0) {
    log(`assembly:${normalizedSessionId}`, `refreshed feature dependencies: ${installResult.installedPackages.join(', ')}`);
  }
  await writeWorkspaceState(agent.id, {
    forms: {
      ...(workspaceState?.forms || {}),
      'assembly-form': {
        ...assemblyForm,
        assembly_name: runtimeDisplayName,
        env_created: '1',
        env_dir: assemblyWorkspace,
        env_configured_name: runtimeDisplayName,
        env_configured_features: selectedFeatures.join('\n'),
        env_status: 'ready',
        env_status_message: selectedFeatures.length > 0
          ? `Runtime dependencies refreshed for ${selectedFeatures.length} feature(s).`
          : 'Runtime dependencies refreshed.',
      },
    },
    openDirectory: assemblyWorkspace,
  });
  console.log(`[PERF] startAssemblyRuntime writeWorkspaceState (${Date.now() - _t0}ms)`);
  const spawnArgs = [
    String(RUNTIME_SCRIPT),
    String(agent.relativeDir || ''),
    String(agent.id || ''),
    String(runtimeDisplayName || ''),
    String(normalizedSessionId || ''),
  ];
  const child = spawn(process.execPath, spawnArgs, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeSpawnEnv({
      ...process.env,
      AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
      AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
      AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
      PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
      PROTOCLAW_PREBUILT_SESSION_ID: normalizedSessionId,
      PROTOCLAW_ASSEMBLY_RUNTIME: '1',
      PROTOCLAW_ASSEMBLY_WORKSPACE: runtimeWorkdir,
    }),
    windowsHide: true,
  });

  const runtime = {
    sessionId: normalizedSessionId,
    requestedName: runtimeDisplayName,
    workspaceDir: runtimeWorkdir,
    installedPackages: selectedFeatures,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    viewerAgentId: null,
    ready: false,
    stopped: false,
  };

  assemblyRuntimeProcesses.set(normalizedSessionId, runtime);
  console.log(`[PERF] startAssemblyRuntime process SPAWNED (${Date.now() - _t0}ms) pid=${child.pid}`);

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    log(`assembly:${normalizedSessionId}`, text.trimEnd());
    const viewerMatch = text.match(/Viewer Agent ID:\s*(\S+)/);
    if (viewerMatch) {
      runtime.viewerAgentId = viewerMatch[1];
      console.log(`[PERF] startAssemblyRuntime viewerAgentId=${viewerMatch[1]} (${Date.now() - _t0}ms)`);
    }
    if (text.includes('READY session=')) {
      runtime.ready = true;
      console.log(`[PERF] startAssemblyRuntime READY (${Date.now() - _t0}ms)`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    log(`assembly:${normalizedSessionId}`, chunk.toString().trimEnd(), 'error');
  });

  child.on('exit', (code) => {
    runtime.exitCode = code ?? 0;
    runtime.stopped = true;
    assemblyRuntimeProcesses.delete(normalizedSessionId);
  });

  return runtime;
}

async function stopManagedAgent(agentId, sessionId = undefined) {
  const runtimes = sessionId === undefined ? listAgentRuntimes(agentId) : [getAgentRuntime(agentId, sessionId)].filter(Boolean);
  if (runtimes.length === 0) {
    return buildStatus(agentId, sessionId);
  }

  for (const runtime of runtimes) {
    if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
      continue;
    }
    runtime.stopped = true;
    runtime.process.kill('SIGTERM');
  }
  return buildStatus(agentId, sessionId);
}

app.all('/protoclaw/claw-mcp', async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await clawMcp.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});
app.all('/protoclaw/claw-mcp/', async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await clawMcp.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});

// ── Identity Registry API ─────────────────────────────────────────

/**
 * 收集所有已启用 prebuilt agent 声明的 identities。
 * 无 identities 声明的 workspace 自动生成默认身份（向后兼容）。
 */
async function collectIdentities() {
  const agents = await discoverAgents(AGENTS_ROOT);
  const identities = [];

  for (const agent of agents) {
    if (agent.enabled === false) continue;
    if (agent.launchMode === 'ui-only') continue;

    const declared = Array.isArray(agent.identities) ? agent.identities : null;
    if (!declared || declared.length === 0) continue;

    for (const id of declared) {
      // 只暴露显式标记为 groupChat 的身份
      if (!id.groupChat) continue;

      identities.push({
        workspaceId: agent.id,
        workspaceName: agent.name,
        identityId: id.id,
        identityRef: `${agent.id}:${id.id}`,
        displayName: id.displayName || id.id,
        description: id.description || '',
        sessionModel: id.sessionModel || 'persistent',
        qualifierLabel: id.qualifierLabel || null,
        operations: Array.isArray(id.operations) ? id.operations : [],
        callTimeoutMs: typeof id.callTimeoutMs === 'number' ? id.callTimeoutMs : 900000,
      });
    }
  }

  return identities;
}

app.get('/protoclaw/identities', async (_req, res, next) => {
  try {
    const identities = await collectIdentities();
    res.json({ identities });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/identities/:workspaceId/:identityId/sessions', async (req, res, next) => {
  try {
    const { workspaceId, identityId } = req.params;

    // 验证 identity 存在
    const identities = await collectIdentities();
    const identity = identities.find(
      (i) => i.workspaceId === workspaceId && i.identityId === identityId
    );
    if (!identity) {
      return res.status(404).json({ error: `Identity not found: ${workspaceId}:${identityId}` });
    }

    const sessions = [];

    if (identity.sessionModel === 'persistent' && identity.qualifierLabel) {
      // 有 qualifierLabel 的 persistent 身份：从 session index 提取 qualifier 列表
      try {
        const index = await readSessionIndex(workspaceId);
        const seen = new Set();

        for (const record of index.sessions) {
          if (record.archived) continue;
          // qualifier 优先用 openDirectory，其次 title
          const qualifier = record.openDirectory || record.title || record.id;
          if (!qualifier || seen.has(qualifier)) continue;
          seen.add(qualifier);

          sessions.push({
            qualifier,
            label: record.title || qualifier,
            status: buildStatus(workspaceId).status === 'running' ? 'running' : 'idle',
            lastActiveTime: record.updatedAt || record.createdAt || null,
            summary: record.goal || null,
          });
        }
      } catch {
        // session index 不存在或读取失败 → 空列表
      }
    }

    const allowCreate = identity.operations.includes('create');

    res.json({
      sessions,
      allowCreate,
      qualifierLabel: identity.qualifierLabel,
    });
  } catch (error) {
    next(error);
  }
});

// ── End Identity Registry API ─────────────────────────────────────

// ── Group Chat API → server/routes/group-chat.js ──
setupGroupChatRoutes(app, express, {
  collectIdentities,
  createPrebuiltSession,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  requireAgentLight,
  readViewerJson,
  discoverAgents,
});

// ── System Feature Config API → server/routes/system-feature-config.js ──
setupSystemFeatureConfigRoutes(app, express);

// ── Dispatch API → server/routes/dispatch.js ──
setupDispatchRoutes(app, express, {
  readWorkspaceState,
  writeWorkspaceState,
  readProjectIMWorkspaceConfig,
  listPrebuiltSessions,
  requirePrebuiltAgentForRuntime,
  createPrebuiltSession,
  startManagedAgent,
  waitForManagedRuntimeReady,
  activatePrebuiltSession,
});

// ── Runtime Inbox observation API (read-only) ──────────────────

app.get('/protoclaw/runtime/inbox', (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
  res.json(getRuntimeInboxSnapshot(runtimeKey));
});

app.get('/protoclaw/runtime/execution_state', (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
  res.json(getRuntimeExecutionState(runtimeKey));
});

app.get('/protoclaw/runtime/execution_states', (_req, res) => {
  res.json({ states: listRuntimeExecutionStates() });
});

app.get('/protoclaw/runtime/envelope', (req, res) => {
  const envelopeId = req.query.envelopeId;
  if (!envelopeId) return res.status(400).json({ error: 'envelopeId required' });
  const envelope = findEnvelopeById(envelopeId);
  if (!envelope) return res.status(404).json({ error: 'envelope not found' });
  res.json(envelope);
});

app.get('/protoclaw/runtime/envelopes_by_source', (req, res) => {
  const sourceRef = req.query.sourceRef;
  if (!sourceRef) return res.status(400).json({ error: 'sourceRef required' });
  res.json({ envelopes: findEnvelopesBySourceRef(sourceRef) });
});

// ── End Runtime Inbox observation API ───────────────────────────

app.get('/protoclaw/health', (_req, res) => {
  res.json({ ok: true, appPort: APP_PORT, viewerPort: VIEWER_PORT });
});

app.get('/protoclaw/get_prebuilt_agents', async (_req, res, next) => {
  try {
    const agents = await getAgents();
    res.json(agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      category: agent.category,
      kind: agent.kind || 'agent',
      launchMode: agent.launchMode || null,
      ui: agent.ui || null,
      features: agent.features || [],
      workspace: agent.workspace || null,
      workspace_sessions: agent.workspace_sessions || { activeSessionId: null, sessions: [] },
      workspace_data: agent.workspace_data || {},
      workspace_state: agent.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
      active_workspace_session_id: agent.workspace_sessions?.activeSessionId || null,
      modelPresets: agent.modelPresets || null,
      entry_point: agent.relativeDir,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/get_agents_status', async (_req, res, next) => {
  try {
    const agents = await getAgentsLight();
    res.json(agents.map((agent) => ({
      id: agent.id,
      status: buildStatus(agent.id).status,
      pid: buildStatus(agent.id).pid,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/get_connected_agents', async (_req, res, next) => {
  try {
    res.json(await getConnectedAgents());
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/agent_detail', async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || '').trim();
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const lightAgents = await getAgentsLight();
    const agent = lightAgents.find((item) => item.id === agentId);
    if (!agent) {
      res.status(404).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    const enriched = await enrichAgent(agent);
    res.json({
      workspace_sessions: enriched.workspace_sessions || { activeSessionId: null, sessions: [] },
      workspace_data: enriched.workspace_data || {},
      workspace_state: enriched.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/start_agent', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (agent.launchMode === 'ui-only') {
      const connectedAgents = await getConnectedAgents();
      const connected = connectedAgents.find((item) => item.id === agent.id) || null;
      res.json({ status: buildStatus(agent.id), agent: connected });
      return;
    }
    // Block qqbot from starting when no IM channel is selected
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      const wsConfig = await readProjectIMWorkspaceConfig();
      if (!wsConfig.selectedChannel) {
        const connectedAgents = await getConnectedAgents();
        const connected = connectedAgents.find((item) => item.id === agent.id) || null;
        res.json({ status: buildStatus(agent.id), agent: connected, warning: '未选择 IM 渠道，门户代理不会启动' });
        return;
      }
    }
    const selectedSessionId = req.body.sessionId || null;
    const status = await startManagedAgent(agent, selectedSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
    res.json({ status, agent: connected });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/prebuilt_sessions', async (req, res, next) => {
  try {
    if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    res.json(await listPrebuiltSessions(req.query.agentId));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/search_sessions', async (req, res, next) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const openDirectory = typeof req.query.openDirectory === 'string' ? req.query.openDirectory : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!query) {
      res.json({ query: '', results: [], total: 0, indexed: 0 });
      return;
    }
    const result = await searchSessionsContent(agentId, query, openDirectory);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/session_record', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const sessionType = await resolvePrebuiltSessionType(agentId, sessionId);
    res.json({
      sessionId,
      sessionType: sessionType || null,
      goal: parsed.goal || null,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/render_conversation', express.json(), async (req, res, next) => {
  try {
    const { sessionId, agentId, lastNCalls } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const resolvedAgentId = (typeof agentId === 'string' && agentId) || 'qqbot';
    const sessionPath = getPrebuiltSessionFilePath(resolvedAgentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    if (messages.length === 0) {
      res.status(404).json({ error: 'Session has no messages to render' });
      return;
    }

    const html = renderConversationHtml(messages, {
      title: `对话记录 ${sessionId.slice(-12)}`,
      agentId: resolvedAgentId,
      sessionId,
      lastNCalls: typeof lastNCalls === 'number' && lastNCalls > 0 ? lastNCalls : null,
    });

    const tempDir = path.join(process.cwd(), '.agentdev', 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    const filename = `conversation-${sessionId.slice(-12)}-${Date.now()}.html`;
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, html, 'utf8');

    const stat = await fs.stat(filePath);
    res.json({
      path: filePath,
      filename,
      size: stat.size,
      messageCount: messages.length,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      res.status(404).json({ error: 'Session file not found' });
    } else {
      next(error);
    }
  }
});

app.get('/protoclaw/session_trim_preview', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const rounds = buildSessionTrimPreview(messages);
    res.json({
      sessionId,
      sessionTitle: parsed.title || '',
      contextLength: null,
      rounds,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/sessions/branch', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sourceSessionId = cleanSessionText(req.body?.sourceSessionId);
    const cutMsgIndexEnd = req.body?.cutMsgIndexEnd;

    if (!agentId || !sourceSessionId) {
      res.status(400).json({ error: 'agentId and sourceSessionId are required' });
      return;
    }
    if (typeof cutMsgIndexEnd !== 'number' || !Number.isFinite(cutMsgIndexEnd)) {
      res.status(400).json({ error: 'cutMsgIndexEnd must be a finite number' });
      return;
    }

    const sourcePath = getPrebuiltSessionFilePath(agentId, sourceSessionId);
    const sourceRaw = await fs.readFile(sourcePath, 'utf8');
    const sourceSnapshot = JSON.parse(sourceRaw);
    const rawMessages = Array.isArray(sourceSnapshot?.runtime?.context?.messages)
      ? sourceSnapshot.runtime.context.messages
      : [];

    const branchMessages = rawMessages.slice(0, cutMsgIndexEnd + 1);

    if (branchMessages.length === 0) {
      res.status(400).json({ error: 'No messages to keep after branch cut' });
      return;
    }

    // Determine the maximum user turn in the branch so we can preserve the
    // invariant: user message turn === checkpoint callIndex === _callIndex.
    // Previously callIndex was hardcoded to 0 which broke rollback entirely.
    let maxUserTurn = -1;
    for (const m of branchMessages) {
      if (m.role === 'user' && typeof m.turn === 'number') {
        maxUserTurn = Math.max(maxUserTurn, m.turn);
      }
    }

    // Only keep checkpoints whose callIndex is within the branch range.
    // Checkpoints beyond the cut point reference context that no longer exists.
    const sourceCheckpoints = Array.isArray(sourceSnapshot.rollbackHistory)
      ? sourceSnapshot.rollbackHistory
      : [];
    const branchCheckpoints = sourceCheckpoints.filter(
      cp => typeof cp.callIndex === 'number' && cp.callIndex <= maxUserTurn
    );

    // Truncate enrichedMessages to match the branch message range.
    const sourceEnriched = Array.isArray(sourceSnapshot.runtime?.context?.enrichedMessages)
      ? sourceSnapshot.runtime.context.enrichedMessages
      : [];
    const branchEnriched = sourceEnriched.filter(
      em => typeof em.turn !== 'number' || em.turn <= maxUserTurn
    );

    // Read the source session index record early so its metadata (title, etc.)
    // is available when building the branch record. Previously sourceRecord was
    // only assigned inside the updateSessionIndex callback, which ran AFTER the
    // branch record was constructed — so all sourceRecord fields were always null.
    let sourceRecord = null;
    try {
      const sourceIdx = await readSessionIndex(agentId);
      sourceRecord = sourceIdx.sessions.find(s => s.id === sourceSessionId) || null;
    } catch {}

    // Validate checkpoint integrity: warn if user turns lack matching checkpoints.
    const branchUserTurns = branchMessages
      .filter(m => m.role === 'user' && typeof m.turn === 'number')
      .map(m => m.turn);
    const branchCpIndices = branchCheckpoints.map(cp => cp.callIndex);
    const missingCheckpoints = branchUserTurns.filter(t => !branchCpIndices.includes(t));
    if (missingCheckpoints.length > 0) {
      console.warn(`[ProtoClaw] Branch from ${sourceSessionId}: user turns [${branchUserTurns.join(',')}] have missing checkpoints for turns [${missingCheckpoints.join(',')}]. Rollback will be unavailable for those turns.`);
    }

    const newSessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const createdAt = new Date().toISOString();

    const branchSnapshot = {
      ...sourceSnapshot,
      sessionId: newSessionId,
      savedAt: Date.now(),
      runtime: {
        ...(sourceSnapshot.runtime || {}),
        initialized: true,
        callIndex: maxUserTurn,
        context: {
          ...(sourceSnapshot.runtime?.context || {}),
          messages: branchMessages,
          enrichedMessages: branchEnriched,
        },
      },
      rollbackHistory: branchCheckpoints,
    };
    delete branchSnapshot.title;

    const branchSessionPath = getPrebuiltSessionFilePath(agentId, newSessionId);
    await fs.writeFile(branchSessionPath, JSON.stringify(branchSnapshot, null, 2), 'utf8');

    const sourceTitle = sourceRecord?.title || '';
    const branchTitle = sourceTitle
      ? `${sourceTitle}（分支）`
      : `分支会话 · ${createdAt.replace(/[TZ]/g, ' ').trim()}`;

    const branchRecord = {
      id: newSessionId,
      title: branchTitle,
      featureName: sourceRecord?.featureName || '',
      agentName: sourceRecord?.agentName || '',
      taskTitle: sourceRecord?.taskTitle || '',
      taskType: sourceRecord?.taskType || '',
      goal: sourceRecord?.goal || '',
      constraints: sourceRecord?.constraints || '',
      expectedOutput: sourceRecord?.expectedOutput || '',
      targetFiles: sourceRecord?.targetFiles || '',
      referenceMaterials: sourceRecord?.referenceMaterials || '',
      formId: sourceRecord?.formId || '',
      openDirectory: sourceRecord?.openDirectory || '',
      sessionType: sourceRecord?.sessionType || 'main',
      metadata: {
        ...(sourceRecord?.metadata || {}),
        branchSourceSessionId: sourceSessionId,
        branchCutMsgIndexEnd: cutMsgIndexEnd,
      },
      createdAt,
      updatedAt: createdAt,
    };

    const nextIndex = await updateSessionIndex(agentId, (index) => {
      return {
        activeSessionId: newSessionId,
        sessions: [branchRecord, ...index.sessions.filter((s) => s.id !== newSessionId)],
      };
    });

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    await startManagedAgent(agent, newSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, newSessionId);

    res.json({
      ok: true,
      newSessionId,
      branchTitle,
      keptMessages: branchMessages.length,
      totalMessages: rawMessages.length,
      agent: connected,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/session_summary', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const handoff = await findSessionSummary(agentId, sessionId);
    if (!handoff) {
      res.status(404).json({ error: 'No summary found for this session' });
      return;
    }
    res.json({
      sessionId,
      summaryText: handoff.sourceSummary || handoff.summaryArtifact?.summaryText || '',
      sessionTitle: handoff.compactOutput?.sessionTitle || '',
      importantFiles: handoff.compactOutput?.importantFiles || [],
      importantSkills: handoff.compactOutput?.importantSkills || [],
      createdAt: handoff.createdAt || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/session_generate_summary', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const force = !!req.body?.force;
    const existingSummary = await findSessionSummary(agentId, sessionId);
    if (existingSummary && !force) {
      res.json({ ok: true, alreadyExists: true });
      return;
    }
    if (existingSummary && force) {
      try {
        const handoffPath = await findSessionSummaryPath(agentId, sessionId);
        if (handoffPath) await fs.unlink(handoffPath).catch(() => {});
      } catch {}
    }
    const agentDir = path.join('prebuilt-agents', 'official', agentId);
    const resultPath = path.join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);

    // Resolve sessionType from the workspace session index first; session files may not carry the product-level type.
    const sessionType = await resolvePrebuiltSessionType(agentId, sessionId);

    const args = [
      path.join(__dirname, 'scripts', 'run-compact-mirror.js'),
      agentDir,
      agentId,
      sessionId,
      JSON.stringify({ sessionType, maxAttempts: 1 }),
      resultPath,
    ];
    const output = await new Promise((resolve, reject) => {
      const child = spawn('node', args, { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = 120000;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Compact mirror timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) reject(new Error(stderr || stdout || `compact mirror exited with code ${code}`));
        else resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    console.log('[generate_summary] compact mirror output:', output?.slice(0, 200));
    const result = await fs.readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!result?.ok || !result.summaryText) {
      res.status(500).json({ error: 'Compact mirror did not produce a valid summary' });
      return;
    }
    await exportProvidedSummaryHandoff({
      preferredAgentId: agentId,
      sessionId,
      summaryText: result.summaryText,
      rawResponse: result.rawResponse || '',
      importantFiles: result.importantFiles || [],
      importantSkills: result.importantSkills || [],
      sessionTitle: result.sessionTitle || '',
    });
    try { await fs.unlink(resultPath); } catch {}
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

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

app.post('/protoclaw/project_docset/import_materials', express.json({ limit: '20mb' }), async (req, res, next) => {
  try {
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
    const projectDir = typeof req.body?.projectDir === 'string' ? req.body.projectDir.trim() : '';
    const materials = Array.isArray(req.body?.materials) ? req.body.materials : [];

    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!projectDir) {
      res.status(400).json({ error: 'projectDir is required' });
      return;
    }
    if (materials.length === 0) {
      res.status(400).json({ error: 'materials are required' });
      return;
    }

    await ensureProjectDocset(projectDir, {});
    const materialsDir = getProjectDocsetMaterialsDir(projectDir);
    const imported = [];

    for (const material of materials) {
      const sourcePath = typeof material?.sourcePath === 'string' ? material.sourcePath.trim() : '';
      const sourceKind = material?.sourceKind === 'directory' ? 'directory' : 'file';
      const name = typeof material?.name === 'string' && material.name.trim()
        ? material.name.trim()
        : (sourcePath ? path.basename(sourcePath) : '');
      if (!name || !sourcePath) continue;

      const timestamp = new Date().toISOString();
      const title = `导入资料 · ${name}`;
      const id = buildProjectDocsetMarkdownId(title, timestamp, 'material');
      const body = [
        `# ${title}`,
        '',
        `- Source Kind: ${sourceKind}`,
        `- Source Path: ${sourcePath}`,
        `- Imported At: ${timestamp}`,
        '',
        '> 这是路径引用资料，项目文档集只保存来源路径，不复制原始内容。',
      ].join('\n');
      const filePath = path.join(materialsDir, `${id}.md`);
      await fs.writeFile(filePath, body, 'utf8');
      imported.push({ id, title, path: filePath });
    }

    res.json({ ok: true, count: imported.length, items: imported });
  } catch (error) {
    next(error);
  }
});

// ── IM Workspace → server/routes/im.js ────────────────────────────────────────
setupIMRoutes(app, express, {
  stopManagedAgent,
  requireAgentLight,
  startManagedAgent,
  waitForProcessExit,
  getAgentsLight,
  readViewerJson,
});


// ── Model Config ──────────────────────────────────────────────────────────────

async function resolveContextLength(agentId) {
  const info = await resolveSessionModelInfo(agentId, 'default');
  return info.contextLength;
}

app.post('/protoclaw/shutdown', async (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => void shutdown(0), 200);
});

// ── Model Config / Speech / ASR / Agent Presets → server/routes/model-config.js ──
setupModelConfigRoutes(app, express);

// ── Token Count Refresh ────────────────────────────────────────────────────────

app.post('/protoclaw/refresh_session_token_count', express.json(), async (req, res, next) => {
  try {
    const { sessionId, agentId } = req.body || {};
    if (!sessionId || !agentId) {
      return res.status(400).json({ success: false, error: 'Missing sessionId or agentId' });
    }

    // 读取会话索引
    const index = await readSessionIndex(agentId);
    const sessionRecord = index.sessions.find(s => s.id === sessionId);
    if (!sessionRecord) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // 复用 resolveSessionModelInfo 获取模型预设信息
    const modelInfo = await resolveSessionModelInfo(agentId, 'default');
    const presetName = modelInfo.presetName;
    const modelName = modelInfo.modelName;

    if (!presetName || !modelName) {
      return res.status(400).json({
        success: false,
        error: `Cannot determine model preset for agent ${agentId}`,
      });
    }

    // 读取模型预设配置（含 providers 和 countTokenPath）
    const presetsData = await readModelPresets();
    const preset = presetsData.presets.find(p => p.name === presetName);

    if (!preset) {
      return res.status(404).json({ success: false, error: `Model preset not found: ${presetName}` });
    }

    const countTokenPath = preset.countTokenPath || '/v1/messages/count_tokens';

    // 获取 provider 信息
    const provider = presetsData.providers.find(p => p.name === preset.providerName);
    if (!provider) {
      return res.status(404).json({ success: false, error: `Provider not found: ${preset.providerName}` });
    }

    const baseUrl = provider.endpoints?.[preset.protocol] || '';
    if (!baseUrl) {
      return res.status(400).json({ success: false, error: 'Provider base URL not configured' });
    }

    // 构建 count tokens API URL
    const countTokensUrl = baseUrl.replace(/\/+$/, '') + countTokenPath;

    // 读取会话文件中的实际消息
    const sessionPath = path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
    let sessionData = {};
    let actualMessages = [];
    try {
      sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      const rawMessages = sessionData?.runtime?.context?.messages || [];
      // count_tokens 接口只接受 user/assistant 角色
      // system 角色的内容合并到第一条 user 消息前
      // tool 角色映射为 user（tool_result 嵌入 user message）
      let systemParts = [];
      for (const m of rawMessages) {
        if (!m || m.content == null) continue;
        if (m.role === 'system') {
          systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          continue;
        }
        let content;
        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = m.content.map(b => typeof b === 'string' ? b : (b?.text || JSON.stringify(b))).join('\n');
        } else {
          content = JSON.stringify(m.content);
        }
        // prepend system text to first user message
        let role = m.role;
        if (role === 'tool') role = 'user';
        if (role === 'user' && systemParts.length > 0) {
          content = systemParts.join('\n\n') + '\n\n' + content;
          systemParts = [];
        }
        actualMessages.push({ role, content });
      }
      // 如果只有 system 没有 user，补一条
      if (actualMessages.length === 0 && systemParts.length > 0) {
        actualMessages.push({ role: 'user', content: systemParts.join('\n\n') });
      }
    } catch {}

    // 如果没有消息，无法计数
    if (!actualMessages.length) {
      return res.status(400).json({
        success: false,
        error: '会话中没有可用的消息，无法计数',
      });
    }

    // 调用 count tokens API，使用实际消息
    try {
      const countRequest = {
        model: modelName,
        messages: actualMessages,
      };

      const response = await fetch(countTokensUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
        },
        body: JSON.stringify(countRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Count tokens API failed: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      const tokenCount = result.input_tokens || result.inputTokens;

      if (typeof tokenCount !== 'number' || tokenCount < 0) {
        return res.status(500).json({
          success: false,
          error: 'Count tokens API did not return a valid token count',
          details: result,
        });
      }

      // 写入路径须与 summarizePrebuiltSession 读取路径一致: runtime.usageStats.lastRequestUsage
      if (!sessionData.runtime) sessionData.runtime = {};
      if (!sessionData.runtime.usageStats) sessionData.runtime.usageStats = {};
      sessionData.runtime.usageStats.lastRequestUsage = {
        inputTokens: tokenCount,
        outputTokens: 0,
        totalTokens: tokenCount,
      };
      sessionData.modelName = modelName;
      sessionData.updatedAt = new Date().toISOString();

      await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

      res.json({
        success: true,
        tokenCount,
      });
    } catch (fetchError) {
      return res.status(500).json({
        success: false,
        error: `Failed to call count tokens API: ${fetchError.message}`,
      });
    }
  } catch (error) {
    next(error);
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────

app.post('/protoclaw/prebuilt_sessions', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    const session = await createPrebuiltSession(agent.id, {
      returnSummary: false,
      sourceSessionId: req.body.sourceSessionId,
      formId: req.body.formId,
      featureName: req.body.featureName,
      agentName: req.body.agentName,
      openDirectory: req.body.openDirectory,
      targetDir: req.body.targetDir,
    });
    const status = await startManagedAgent(agent, session.id);
    res.json({ session, status, agent: null });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/prebuilt_sessions/:sessionId/title', express.json(), async (req, res, next) => {
  try {
    const { agentId, title } = req.body || {};
    const sessionId = req.params.sessionId;

    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId is required' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required and must be non-empty' });
    }

    await updateSessionIndex(agentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex === -1) {
        throw Object.assign(new Error('Session not found'), { statusCode: 404 });
      }
      index.sessions[sessionIndex].title = title.trim();
      index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      return index;
    });

    res.json({ ok: true, sessionId, title: title.trim() });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/generate_session_title', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId are required' });
    }

    const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, agentId);
    if (!ownerAgentId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const agentRelativeDir = agent.relativeDir;
    if (!agentRelativeDir) {
      return res.status(500).json({ error: 'Agent directory not resolved' });
    }

    const titleMirrorScript = path.join(__dirname, 'scripts', 'run-title-mirror.js');
    const resultDir = path.join(os.tmpdir(), `title-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [titleMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 1 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    let stderr = '';
    const timeoutMs = 120000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[title-mirror] ${line.trimEnd()}`);
      }
    });

    await new Promise((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Title generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `run-title-mirror exited with code ${code}`));
          return;
        }
        resolve();
      });
    });

    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw.trim());
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});

    const title = typeof result?.title === 'string' ? result.title.trim() : '';
    if (!title) {
      return res.status(500).json({ error: 'Title generation returned empty result' });
    }

    await updateSessionIndex(ownerAgentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        index.sessions[sessionIndex].title = title;
        index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      }
      return index;
    });

    res.json({ ok: true, sessionId, title });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/generate_recap', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId are required' });
    }

    const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, agentId);
    if (!ownerAgentId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const agentRelativeDir = agent.relativeDir;
    if (!agentRelativeDir) {
      return res.status(500).json({ error: 'Agent directory not resolved' });
    }

    const recapMirrorScript = path.join(__dirname, 'scripts', 'run-recap-mirror.js');
    const resultDir = path.join(os.tmpdir(), `recap-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [recapMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 1 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    let stderr = '';
    const timeoutMs = 120000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[recap-mirror] ${line.trimEnd()}`);
      }
    });

    await new Promise((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Recap generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `run-recap-mirror exited with code ${code}`));
          return;
        }
        resolve();
      });
    });

    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw.trim());
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});

    const recap = typeof result?.recap === 'string' ? result.recap.trim() : '';
    if (!recap) {
      return res.status(500).json({ error: 'Recap generation returned empty result' });
    }

    res.json({ ok: true, sessionId, recap });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/export', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await exportContextHandoffForSession(sessionId, preferredAgentId, req.body?.policy || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compacted_resume', express.json(), async (req, res, next) => {
  try {
    const handoffId = cleanSessionText(req.body?.handoffId);
    const handoffPath = cleanSessionText(req.body?.handoffPath);
    if (!handoffId && !handoffPath) {
      res.status(400).json({ error: 'handoffId or handoffPath is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await createCompactedResumeFromHandoff({
      preferredAgentId,
      handoffId,
      handoffPath,
      goal: cleanSessionText(req.body?.goal),
      startRuntime: req.body?.startRuntime !== false,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function lockExplorationSession(agentId, sessionId, goal, response) {
  try {
    await updateSessionIndex(agentId, (index) => {
      const record = index.sessions.find(s => s.id === sessionId);
      if (!record) return index;
      record.sessionType = 'exploration';
      record.status = 'locked';
      record.lockedAt = new Date().toISOString();
      if (goal) record.goal = goal;
      record.domains = extractDomainsFromText(response || goal || '');
      record.updatedAt = new Date().toISOString();
      return { ...index };
    });
    console.log(`[lockExploration] Locked session=${sessionId} domains=${record.domains?.join(',') || '(none)'}`);
  } catch (err) {
    console.error(`[lockExploration] Failed for session=${sessionId}:`, err.message);
  }
}

function extractDomainsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const techPatterns = [
    /\b(Flow|Feature|Hook|ToolRegistry|Node|Edge|Workflow|Assembly|Session|Workspace|Runtime|Context|Prompt|Compaction|Mirror|Handoff|Seed|Inspector|Editor|Surface|Block|State|Config|Form|Agent|Message|Chunk|Template|Variable|Skill|Tool|Permission)\b/gi,
  ];
  const found = new Set();
  for (const pattern of techPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const word = match[1];
      if (word.length >= 3) found.add(word);
    }
  }
  return [...found].slice(0, 8);
}

async function buildExplorationHandoffPayload(agentId, explorationIds, goal) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));

  // --- Phase 1: Read handoff files for 交接班信息 (sourceSummary + importantFiles/Skills) ---
  let handoffFiles = [];
  try {
    handoffFiles = (await fs.readdir(handoffsDir)).filter(f => f.startsWith('handoff-') && !f.startsWith('handoff-synthetic-') && f.endsWith('.json'));
  } catch {}

  const allImportantFiles = [];
  const allImportantSkills = [];
  const allFileRanges = {};
  const summaryParts = [];

  for (const expId of explorationIds) {
    let bestParsed = null;
    let bestCreatedAt = '';
    for (const fname of handoffFiles) {
      try {
        const raw = await fs.readFile(path.join(handoffsDir, fname), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId !== expId) continue;
        const ca = parsed.createdAt || '';
        if (ca > bestCreatedAt) {
          bestParsed = parsed;
          bestCreatedAt = ca;
        }
      } catch {}
    }
    if (bestParsed) {
      // sourceSummary (老版摘要) is part of 交接班信息
      const summary = bestParsed.sourceSummary || bestParsed.summaryText || '';
      if (summary) {
        summaryParts.push(`## 探索记录 ${expId}\n${summary}`);
      }
      if (Array.isArray(bestParsed.compactOutput?.importantFiles)) {
        allImportantFiles.push(...bestParsed.compactOutput.importantFiles);
      }
      if (Array.isArray(bestParsed.compactOutput?.importantSkills)) {
        allImportantSkills.push(...bestParsed.compactOutput.importantSkills);
      }
      if (bestParsed.compactOutput?.fileRanges && typeof bestParsed.compactOutput.fileRanges === 'object') {
        Object.assign(allFileRanges, bestParsed.compactOutput.fileRanges);
      }
    }
  }

  const combinedSummary = summaryParts.join('\n\n');

  // --- Phase 2: Read session files for full conversation history (全量历史) ---
  const sessionsDir = path.join(USER_DATA_ROOT, 'workspaces', sanitizeSessionFragment(agentId || 'programming-helper'), 'sessions');
  const allSeedMessages = [];

  for (const expId of explorationIds) {
    try {
      const sessionPath = path.join(sessionsDir, `${expId}.json`);
      const rawSession = await fs.readFile(sessionPath, 'utf8');
      const sessionData = JSON.parse(rawSession);
      const messages = sessionData?.runtime?.context?.messages;
      if (!Array.isArray(messages)) continue;

      // Include user, assistant, tool messages (skip system prompts — sub-agent has its own)
      const conversationMessages = messages
        .filter(m => m && m.role && m.role !== 'system' && (m.content || Array.isArray(m.toolCalls)))
        .map(m => {
          const msg = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
          if (typeof m.turn === 'number') msg.turn = m.turn;
          if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) msg.toolCalls = m.toolCalls;
          if (m.toolCallId) msg.toolCallId = m.toolCallId;
          return msg;
        });

      if (conversationMessages.length > 0) {
        allSeedMessages.push(...conversationMessages);
      }
    } catch (err) {
      console.warn(`[buildExplorationHandoffPayload] Failed to read session ${expId}: ${err.message}`);
    }
  }

  return {
    packageId: `synthetic-exploration-${Date.now()}`,
    sourceSessionId: explorationIds[0] || 'unknown',
    sourceSummary: combinedSummary,
    seedMessages: allSeedMessages,
    mode: 'summary',
    stats: { synthetic: true },
    compactOutput: {
      importantFiles: [...new Set(allImportantFiles)],
      importantSkills: [...new Set(allImportantSkills)],
      fileRanges: allFileRanges,
    },
  };
}

async function writeSyntheticHandoff(agentId, payload) {
  const dir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  await fs.mkdir(dir, { recursive: true });
  const fileName = `handoff-synthetic-${Date.now()}.json`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

app.post('/protoclaw/spawn_one_shot', express.json(), async (req, res, next) => {
  try {
    const handoffId = cleanSessionText(req.body?.handoffId);
    const handoffPath = cleanSessionText(req.body?.handoffPath);
    const goal = cleanSessionText(req.body?.goal);
    const timeoutMs = Number(req.body?.timeoutMs) || 300000;
    const explorationIds = Array.isArray(req.body?.explorationIds)
      ? req.body.explorationIds.map(id => cleanSessionText(id)).filter(Boolean)
      : [];

    if (!goal) {
      res.status(400).json({ error: 'goal is required for one-shot spawn' });
      return;
    }

    req.setTimeout(timeoutMs + 10000);

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const agentId = preferredAgentId || 'programming-helper';

    const isExploration = explorationIds.length === 0 && !handoffId && !handoffPath;
    const sessionType = isExploration ? 'exploration' : 'sub';

    let resolvedHandoffPath = null;
    let sourceSessionId = null;
    let handoff = null;

    if (isExploration) {
      sourceSessionId = `__protoclaw-exploration-${Date.now()}__`;
      console.log(`[spawn_one_shot] Exploration mode: no parent context`);
    } else {
      if (explorationIds.length > 0) {
        const handoffPayload = await buildExplorationHandoffPayload(agentId, explorationIds, goal);
        const syntheticPath = await writeSyntheticHandoff(agentId, handoffPayload);
        resolvedHandoffPath = syntheticPath;
        sourceSessionId = explorationIds[0];
        console.log(`[spawn_one_shot] Sub-agent mode: from explorations ${explorationIds.join(',')}`);
      } else {
        if (!handoffId && !handoffPath) {
          res.status(400).json({ error: 'handoffId, handoffPath, or explorationIds required' });
          return;
        }
        const handoffResult = await readHandoffPackage({
          userDataRoot: USER_DATA_ROOT,
          agentId: agentId || '',
          handoffId,
          handoffPath,
        });
        handoff = handoffResult.handoff;
        resolvedHandoffPath = handoffResult.handoffPath;
        const hSourceAgentId = cleanSessionText(handoff?.sourceAgentId);
        sourceSessionId = cleanSessionText(handoff?.sourceSessionId);
        if (!hSourceAgentId || !sourceSessionId) {
          res.status(400).json({ error: 'Invalid handoff: sourceAgentId/sourceSessionId required' });
          return;
        }
      }
    }

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    if (!isExploration && !handoff?.stats?.synthetic && explorationIds.length === 0) {
      await requirePrebuiltSessionRecord(agent.id, sourceSessionId);
    }

    const session = await createPrebuiltSession(agent.id, {
      sourceSessionId,
      goal,
      sessionType,
      metadata: {
        resumeMode: 'one-shot',
        ...(isExploration ? {} : {
          handoffId: cleanSessionText(handoff?.handoffId) || cleanSessionText(handoffId),
          handoffPath: resolvedHandoffPath,
          handoffCreatedAt: cleanSessionText(handoff?.createdAt),
          handoffMode: cleanSessionText(handoff?.mode),
          sourceExplorationIds: explorationIds.length > 0 ? explorationIds : undefined,
        }),
      },
    });

    console.log(`[spawn_one_shot] Starting agent=${agent.id} session=${session.id} type=${sessionType} goal="${goal.slice(0, 80)}"`);

    const { exitCode, result } = await startOneShotAgent(agent, session.id, goal, {
      timeoutMs,
      extraEnv: {
        PROTOCLAW_SESSION_TYPE: sessionType,
        PROTOCLAW_MODEL_PRESET_ROLE: sessionType === 'exploration' ? 'exploration' : 'sub',
        ...(resolvedHandoffPath ? { PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath } : {}),
      },
    });

    console.log(`[spawn_one_shot] Completed agent=${agent.id} session=${session.id} type=${sessionType} ok=${result.ok} duration=${result.durationMs}ms`);

    if (isExploration && result.ok) {
      await lockExplorationSession(agent.id, session.id, goal, result.response);
    }

    res.json({
      session: { id: session.id, title: session.title || null, sessionType },
      result: {
        ok: result.ok,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      },
      exitCode,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/resume_sub', express.json(), async (req, res, next) => {
  try {
    const subSessionId = cleanSessionText(req.body?.sessionId);
    const message = cleanSessionText(req.body?.message);
    const timeoutMs = Number(req.body?.timeoutMs) || 300000;

    if (!subSessionId || !message) {
      res.status(400).json({ error: 'sessionId and message are required' });
      return;
    }

    req.setTimeout(timeoutMs + 10000);

    const agentId = 'programming-helper';
    const agent = await requirePrebuiltAgentForRuntime(agentId);

    await updateSessionIndex(agentId, (index) => {
      const record = index.sessions.find(s => s.id === subSessionId);
      if (!record) {
        throw Object.assign(new Error(`Session ${subSessionId} not found`), { statusCode: 404 });
      }
      if (record.sessionType === 'exploration') {
        throw Object.assign(new Error('Cannot resume an exploration session (it is locked)'), { statusCode: 400 });
      }
      if (record.sessionType !== 'sub') {
        throw Object.assign(new Error(`Session ${subSessionId} is not a sub-agent session (type=${record.sessionType})`), { statusCode: 400 });
      }

      record.sessionType = 'sub';
      record.updatedAt = new Date().toISOString();
      return { ...index };
    });

    console.log(`[resume_sub] Resuming sub-agent session=${subSessionId} message="${message.slice(0, 80)}"`);

    const { exitCode, result } = await startOneShotAgent(agent, subSessionId, message, {
      timeoutMs,
      extraEnv: {
        PROTOCLAW_MODEL_PRESET_ROLE: 'sub',
      },
    });

    console.log(`[resume_sub] Completed session=${subSessionId} ok=${result.ok} duration=${result.durationMs}ms`);

    res.json({
      session: { id: subSessionId },
      result: {
        ok: result.ok,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      },
      exitCode,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compact_and_resume', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const detached = req.body?.detached !== false;
    const policy = req.body?.policy || {};
    console.log(`[compact_and_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId} detached=${detached}`);

    if (detached) {
      const jobId = `compact-resume-${Date.now()}-${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        compactAndResumeCurrentSession({
          preferredAgentId,
          sessionId,
          policy,
          startRuntime: req.body?.startRuntime !== false,
        }).then((result) => {
          console.log(`[compact_and_resume] job ${jobId} completed for session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
        }).catch((error) => {
          console.error(`[compact_and_resume] job ${jobId} failed for session=${sessionId}:`, error);
        });
      }, 10);

      res.json({
        scheduled: true,
        jobId,
        sessionId,
        agentId: preferredAgentId || null,
      });
      return;
    }

    const result = await compactAndResumeCurrentSession({
      preferredAgentId,
      sessionId,
      policy,
      startRuntime: req.body?.startRuntime !== false,
    });
    console.log(`[compact_and_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/summary_resume', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    const summaryText = typeof req.body?.summaryText === 'string' ? req.body.summaryText.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!summaryText) {
      res.status(400).json({ error: 'summaryText is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    console.log(`[summary_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId}`);
    const result = await compactAndResumeFromProvidedSummary({
      preferredAgentId,
      sessionId,
      summaryText,
      rawResponse: typeof req.body?.rawResponse === 'string' ? req.body.rawResponse : '',
      importantFiles: Array.isArray(req.body?.importantFiles) ? req.body.importantFiles : [],
      importantSkills: Array.isArray(req.body?.importantSkills) ? req.body.importantSkills : [],
      sessionTitle: typeof req.body?.sessionTitle === 'string' ? req.body.sessionTitle : '',
      fileRanges: typeof req.body?.fileRanges === 'object' && req.body.fileRanges !== null ? req.body.fileRanges : {},
      policy: req.body?.policy || {},
      startRuntime: req.body?.startRuntime !== false,
    });
    console.log(`[summary_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/summary_export', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    const summaryText = typeof req.body?.summaryText === 'string' ? req.body.summaryText.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!summaryText) {
      res.status(400).json({ error: 'summaryText is required' });
      return;
    }
    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await exportProvidedSummaryHandoff({
      preferredAgentId,
      sessionId,
      summaryText,
      rawResponse: typeof req.body?.rawResponse === 'string' ? req.body.rawResponse : '',
      importantFiles: Array.isArray(req.body?.importantFiles) ? req.body.importantFiles : [],
      importantSkills: Array.isArray(req.body?.importantSkills) ? req.body.importantSkills : [],
      sessionTitle: typeof req.body?.sessionTitle === 'string' ? req.body.sessionTitle : '',
      fileRanges: typeof req.body?.fileRanges === 'object' && req.body.fileRanges !== null ? req.body.fileRanges : {},
      policy: req.body?.policy || {},
      sessionTimestamp: typeof req.body?.sessionTimestamp === 'string' ? req.body.sessionTimestamp : null,
      gitMeta: req.body?.gitMeta && typeof req.body.gitMeta === 'object' ? req.body.gitMeta : null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/assembly_environment/create', express.json(), async (req, res, next) => {
  try {
    const agentId = sanitizeSessionFragment(String(req.body?.agentId || 'agent-creator').trim());
    const assemblyName = sanitizeSessionFragment(String(req.body?.assemblyName || '').trim());
    const force = req.body?.force === true;
    const selectedFeatures = uniqueStrings(Array.isArray(req.body?.selectedFeatures)
      ? req.body.selectedFeatures.map((value) => String(value || '').trim()).filter(Boolean)
      : parseListField(req.body?.selectedFeatures));
    if (!assemblyName || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
      res.status(400).json({ error: 'Invalid assembly name' });
      return;
    }
    const envDir = getAssemblyWorkspaceDir(assemblyName);
    const existed = existsSync(envDir);
    if (existed && !force) {
      res.status(409).json({
        error: 'Assembly environment already exists',
        code: 'ASSEMBLY_ENV_EXISTS',
        directory: envDir,
        existed: true,
      });
      return;
    }
    await ensureAssemblyWorkspaceBase(envDir, assemblyName);
    const installResult = await ensureAssemblyWorkspaceDependencies(envDir, selectedFeatures);
    const currentState = await readWorkspaceState(agentId).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    const assemblyForm = currentState?.forms?.['assembly-form'] || {};
    const assemblyConfigs = Array.isArray(currentState?.assemblyConfigs)
      ? currentState.assemblyConfigs.map((item) => {
          if (cleanSessionText(item?.id) !== assemblyName) {
            return item;
          }
          return {
            ...item,
            envDir,
            envConfiguredName: assemblyName,
            envConfiguredFeatures: selectedFeatures,
            envStatus: 'ready',
            envStatusMessage: existed ? 'Environment dependencies refreshed in the existing directory.' : 'Environment directory created and dependencies installed.',
            updatedAt: new Date().toISOString(),
          };
        })
      : [];
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'assembly-form': {
          ...assemblyForm,
          assembly_name: assemblyName,
          env_created: '1',
          env_dir: envDir,
          env_configured_name: assemblyName,
          env_configured_features: selectedFeatures.join('\n'),
          env_status: 'ready',
          env_status_message: existed ? 'Environment dependencies refreshed in the existing directory.' : 'Environment directory created and dependencies installed.',
          target_dir: assemblyForm.target_dir || path.dirname(envDir),
        },
      },
      openDirectory: envDir,
      assemblyConfigs,
    });
    res.json({ directory: envDir, created: !existed, existed, installedPackages: installResult.installedPackages });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/assembly_runtime/start', express.json(), async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const requestedSessionId = cleanSessionText(req.body?.sessionId);
    const requestedAgentId = normalizeClientAgentId(req.body?.agentId);
    const resolvedOwnerId = requestedSessionId
      ? (await resolvePrebuiltSessionOwner(requestedSessionId, requestedAgentId) || requestedAgentId || 'flow-workspace')
      : (requestedAgentId || 'flow-workspace');
    const agent = await requirePrebuiltAgentForRuntime(resolvedOwnerId);
    console.log(`[PERF] /assembly_runtime/start BEGIN agentId=${agent.id} sessionId=${requestedSessionId || '(new)'}`);
    const session = requestedSessionId
      ? await activatePrebuiltSession(agent.id, requestedSessionId)
      : await createPrebuiltSession(agent.id, {
          formId: 'assembly-form',
          agentName: req.body?.agentName,
          openDirectory: req.body?.openDirectory,
          targetDir: req.body?.targetDir,
        });
    console.log(`[PERF] /assembly_runtime/start session ready (${Date.now() - _t0}ms)`);
    const wsState = await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    await startAssemblyRuntime(session.id, agent.id, session, wsState);
    console.log(`[PERF] /assembly_runtime/start startAssemblyRuntime done (${Date.now() - _t0}ms)`);
    const connected = await waitForAssemblyRuntimeReady(session.id);
    console.log(`[PERF] /assembly_runtime/start waitForReady done (${Date.now() - _t0}ms)`);
    const latestSession = await summarizePrebuiltSession(agent.id, session);
    console.log(`[PERF] /assembly_runtime/start COMPLETE (${Date.now() - _t0}ms total)`);
    res.json({ session: latestSession, runtime: connected });
  } catch (error) {
    console.error(`[PERF] /assembly_runtime/start FAILED (${Date.now() - _t0}ms):`, error.message);
    next(error);
  }
});

app.post('/protoclaw/assembly_runtime/stop', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    res.json(await stopAssemblyRuntime(sessionId));
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/activate', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const session = await activatePrebuiltSession(agent.id, req.body.sessionId, { returnSummary: false });
    const status = await startManagedAgent(agent, session.id);
    res.json({ session, status, agent: null });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/delete', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    let assemblyRuntime = null;
    if (agent.id === 'agent-creator' || agent.id === 'flow-workspace') {
      assemblyRuntime = await stopAssemblyRuntime(req.body.sessionId);
    }
    const deleted = await deletePrebuiltSession(agent.id, req.body.sessionId);
    const runtime = getAgentRuntime(agent.id);
    const deletedRuntime = getAgentRuntime(agent.id, req.body.sessionId);
    const deletedWasActive = deletedRuntime?.selectedSessionId === req.body.sessionId;
    let connected = null;

    if (deletedRuntime?.process && deletedRuntime.process.exitCode === null && !deletedRuntime.stopped && deletedWasActive) {
      await stopManagedAgent(agent.id, req.body.sessionId);
    }

    res.json({
      deleted,
      agent: connected,
      assemblyRuntime,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/archive', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const archived = req.body.archived !== false;
    const result = await archivePrebuiltSession(agent.id, req.body.sessionId, archived);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/todo', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const todo = req.body.todo !== false;
    const result = await tagPrebuiltSessionTodo(agent.id, req.body.sessionId, todo);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── Session meta sync: runtime child process pushes fresh metadata after save ──
app.post('/protoclaw/session_meta_sync', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    let stat;
    try {
      stat = await fs.stat(sessionPath);
    } catch {
      res.status(404).json({ error: 'session file not found' });
      return;
    }

    const messageCount = typeof req.body.messageCount === 'number' ? req.body.messageCount : 0;
    const preview = cleanSessionText(req.body.preview);
    const tokenUsage = req.body.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const savedAt = typeof req.body.savedAt === 'number' ? req.body.savedAt : stat.mtimeMs;

    await updateSessionIndex(agentId, (index) => {
      const sessions = index.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          fileMtimeMs: stat.mtimeMs,
          fileSize: stat.size,
          messageCount,
          preview,
          tokenUsage,
          savedAt,
          metaVersion: META_VERSION,
          updatedAt: new Date(savedAt).toISOString(),
          // Auto-clear todo when session is actively producing new data
          todo: false,
        };
      });
      return { ...index, sessions };
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/open', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    // Add to phProjects if not already there
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    // Set as active project
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/switch', express.json(), async (req, res, next) => {
  try {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId || !projectId.startsWith('dir:')) {
      return res.status(400).json({ error: 'Valid projectId (dir:...) is required' });
    }
    const openDirectory = projectId.slice(4);
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    // Ensure the project exists in phProjects
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/add', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/open_in_explorer', express.json(), async (req, res, next) => {
  try {
    const dirPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!dirPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const { existsSync } = await import('fs');
    if (!existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', dirPath], { stdio: 'ignore', detached: true }).unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [dirPath], { stdio: 'ignore', detached: true }).unref();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_project/delete', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.projectId !== 'string' || !req.body.projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const deleted = await deletePrebuiltProject(agent.id, req.body.projectId);
    const runtimesToStop = listAgentRuntimes(agent.id).filter((runtime) => deleted.deletedSessionIds.includes(runtime?.selectedSessionId));
    let connected = null;

    for (const runtime of runtimesToStop) {
      await stopManagedAgent(agent.id, runtime.selectedSessionId);
    }

    res.json({
      deleted,
      agent: connected,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_repository/delete', express.json(), async (req, res, next) => {
  try {
    const packageId = String(req.body.packageId || '').trim();
    if (!packageId) {
      res.status(400).json({ error: 'packageId is required' });
      return;
    }

    const deleted = await deleteFeaturePackage(packageId);
    res.json({ deleted });
  } catch (error) {
    next(error);
  }
});

const uploadsDir = path.join(USER_DATA_ROOT, 'uploads');
await ensureDir(uploadsDir);
const upload = multer({ dest: uploadsDir });

app.post('/protoclaw/feature_repository/parse_upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const tempPath = req.file.path;
    const originalName = path.basename(req.file.originalname || '');
    if (!originalName.toLowerCase().endsWith('.tgz')) {
      await fs.unlink(tempPath).catch(() => {});
      res.status(400).json({ error: 'Only .tgz files are allowed' });
      return;
    }

    const uploadId = randomUUID();
    const summary = await summarizeFeatureArchive(tempPath, originalName, 'custom');
    pendingFeatureImports.set(uploadId, {
      tempPath,
      originalName,
      summary,
      createdAt: Date.now(),
    });
    res.json({ uploadId, summary });
  } catch (error) {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
});

app.post('/protoclaw/feature_repository/confirm_import', express.json(), async (req, res, next) => {
  try {
    const uploadId = String(req.body?.uploadId || '').trim();
    const pending = pendingFeatureImports.get(uploadId);
    if (!pending) {
      res.status(404).json({ error: 'Unknown or expired import' });
      return;
    }

    pendingFeatureImports.delete(uploadId);
    await ensureDir(USER_FEATURE_REPOSITORY_ROOT);
    const safeName = path.basename(pending.originalName).replace(/[^a-zA-Z0-9._@+-]+/g, '-');
    let targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, safeName);
    if (existsSync(targetPath)) {
      const parsed = path.parse(safeName);
      targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, `${parsed.name}-${Date.now()}${parsed.ext || '.tgz'}`);
    }
    await fs.rename(pending.tempPath, targetPath);
    const summary = await summarizeFeatureArchive(targetPath, path.basename(targetPath), 'custom');
    res.json({ success: true, fileName: path.basename(targetPath), summary });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_repository/cancel_import', express.json(), async (req, res, next) => {
  try {
    const uploadId = String(req.body?.uploadId || '').trim();
    const pending = pendingFeatureImports.get(uploadId);
    if (pending) {
      pendingFeatureImports.delete(uploadId);
      await fs.unlink(pending.tempPath).catch(() => {});
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_repository/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const tempPath = req.file.path;
    const originalName = req.file.originalname;

    if (!originalName.toLowerCase().endsWith('.tgz')) {
      await fs.unlink(tempPath).catch(() => {});
      res.status(400).json({ error: 'Only .tgz files are allowed' });
      return;
    }

    // 确保用户feature仓库目录存在
    await ensureDir(USER_FEATURE_REPOSITORY_ROOT);
    
    // 移动文件到用户feature仓库
    const targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, originalName);
    await fs.rename(tempPath, targetPath);

    res.json({ success: true, fileName: originalName });
  } catch (error) {
    // 清理临时文件
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
});

app.post('/protoclaw/stop_agent', express.json(), async (req, res, next) => {
  try {
    const status = await stopManagedAgent(req.body.agentId, req.body.sessionId);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/restart_agent', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    // Block qqbot from restarting when no IM channel is selected
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      const wsConfig = await readProjectIMWorkspaceConfig();
      if (!wsConfig.selectedChannel) {
        await stopManagedAgent(agent.id, req.body.sessionId || null);
        const connectedAgents = await getConnectedAgents();
        const connected = connectedAgents.find((item) => item.id === agent.id) || null;
        res.json({ status: buildStatus(agent.id), agent: connected, warning: '未选择 IM 渠道，门户代理不会启动' });
        return;
      }
    }
    const selectedSessionId = req.body.sessionId || null;
    await stopManagedAgent(agent.id, selectedSessionId);
    const status = await startManagedAgent(agent, selectedSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
    res.json({ status, agent: connected });
  } catch (error) {
    next(error);
  }
});

setupFsOperationsRoutes(app);

app.post('/protoclaw/feature_creator/initialize', express.json(), async (req, res, next) => {
  try {
    const featureName = typeof req.body?.featureName === 'string' ? req.body.featureName : '';
    const parentDir = typeof req.body?.parentDir === 'string' ? req.body.parentDir : '';
    const result = await initializeFeatureCreatorWorkspace(featureName, parentDir);
    const state = await writeWorkspaceState('feature-creator', {
      openDirectory: result.outputDir,
    });
    await writeWorkspaceArtifact('feature-creator', {
      id: `feature-init-${result.outputDir}`,
      kind: 'progress',
      title: `已初始化 ${result.featureName}`,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      source: {
        workspace: 'feature-creator',
        action: 'initialize',
      },
      relatedTo: {
        openDirectory: result.outputDir,
        sessionId: '',
        parentId: '',
      },
      payload: {
        feature_name: result.featureName,
        parent_dir: result.parentDir,
        output_dir: result.outputDir,
      },
    });
    res.json({
      ...result,
      workspaceState: state,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/agent_creator/initialize', express.json(), async (req, res, next) => {
  try {
    const agentName = typeof req.body?.agentName === 'string' ? req.body.agentName : '';
    const parentDir = typeof req.body?.parentDir === 'string' ? req.body.parentDir : '';
    const goal = typeof req.body?.goal === 'string' ? req.body.goal : '';
    const result = await initializeAgentCreatorWorkspace(agentName, parentDir, goal);
    const state = await writeWorkspaceState('agent-creator', {
      openDirectory: result.outputDir,
    });
    await writeWorkspaceArtifact('agent-creator', {
      id: `agent-init-${result.outputDir}`,
      kind: 'progress',
      title: `已初始化 ${result.agentName}`,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      source: {
        workspace: 'agent-creator',
        action: 'initialize',
      },
      relatedTo: {
        openDirectory: result.outputDir,
        sessionId: '',
        parentId: '',
      },
      payload: {
        agent_name: result.agentName,
        parent_dir: result.parentDir,
        output_dir: result.outputDir,
        files: result.files.join(', '),
      },
    });
    res.json({
      ...result,
      workspaceState: state,
    });
  } catch (error) {
    next(error);
  }
});

// ========== Flow Graph API ==========

function getFlowGraphsDir(agentId) {
  return path.join(USER_DATA_ROOT, 'flows', sanitizeSessionFragment(agentId));
}

function getFlowGraphPath(agentId, flowId) {
  return path.join(getFlowGraphsDir(agentId), `${sanitizeSessionFragment(flowId)}.json`);
}

async function readFlowGraphFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return { flow: JSON.parse(raw), recovered: false };
  } catch (error) {
    const message = error?.message || '';
    const trailingMatch = message.match(/position\s+(\d+)/i);
    if (trailingMatch) {
      const cutoff = Number(trailingMatch[1]);
      if (Number.isFinite(cutoff) && cutoff > 0) {
        const trimmed = raw.slice(0, cutoff).trimEnd();
        try {
          return { flow: JSON.parse(trimmed), recovered: true };
        } catch {}
      }
    }
    throw error;
  }
}

app.get('/protoclaw/flow_graphs', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const dir = getFlowGraphsDir(agentId);
    if (!existsSync(dir)) return res.json({ flows: [] });
    const files = await fs.readdir(dir);
    const flows = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          const parsed = await readFlowGraphFile(path.join(dir, f));
          flows.push(parsed.flow);
        } catch {}
      }
    }
    res.json({ flows });
  } catch (error) { next(error); }
});

app.get('/protoclaw/flow_graph/:flowId', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const filePath = getFlowGraphPath(agentId, req.params.flowId);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Flow not found' });
    const { flow } = await readFlowGraphFile(filePath);
    res.json({ flow });
  } catch (error) { next(error); }
});

app.post('/protoclaw/flow_graph', express.json(), async (req, res, next) => {
  try {
    const agentId = req.body?.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const flow = req.body?.flow;
    if (!flow || !flow.name) return res.status(400).json({ error: 'flow.name is required' });
    const flowId = flow.id || `flow-${Date.now()}`;
    const flowWithId = { ...flow, id: flowId, updatedAt: new Date().toISOString() };
    const dir = getFlowGraphsDir(agentId);
    await ensureDir(dir);
    await fs.writeFile(getFlowGraphPath(agentId, flowId), JSON.stringify(flowWithId, null, 2), 'utf8');
    res.json({ flow: flowWithId, created: true });
  } catch (error) { next(error); }
});

app.put('/protoclaw/flow_graph/:flowId', express.json(), async (req, res, next) => {
  try {
    const agentId = req.body?.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const flowId = req.params.flowId;
    const filePath = getFlowGraphPath(agentId, flowId);
    let existing = {};
    if (existsSync(filePath)) {
      try {
        existing = (await readFlowGraphFile(filePath)).flow || {};
      } catch (error) {
        console.warn(`[flow_graph] Failed to parse existing graph ${filePath}, overwriting with incoming payload:`, error?.message || error);
      }
    }
    const flow = { ...existing, ...req.body?.flow, id: flowId, updatedAt: new Date().toISOString() };
    const dir = getFlowGraphsDir(agentId);
    await ensureDir(dir);
    await fs.writeFile(filePath, JSON.stringify(flow, null, 2), 'utf8');
    res.json({ flow, saved: true });
  } catch (error) { next(error); }
});

app.delete('/protoclaw/flow_graph/:flowId', express.json(), async (req, res, next) => {
  try {
    const agentId = req.query.agentId || req.body?.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const filePath = getFlowGraphPath(agentId, req.params.flowId);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Flow not found' });
    await fs.unlink(filePath);
    res.json({ deleted: true, flowId: req.params.flowId });
  } catch (error) { next(error); }
});

function serializeFlowVariable(variable, featureMeta) {
  if (!variable || !variable.key) return null;
  return {
    id: `${featureMeta.id}:${String(variable.key)}`,
    key: String(variable.key),
    type: String(variable.type || 'string'),
    title: String(variable.title || variable.key),
    description: String(variable.description || ''),
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFlowTool(tool, featureMeta) {
  if (!tool || !tool.name) return null;
  return {
    id: `${featureMeta.id}:${String(tool.name)}`,
    name: String(tool.name),
    title: String(tool.title || tool.name),
    description: String(tool.description || ''),
    parameters: tool.parameters || null,
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeNodeTemplate(template, featureMeta) {
  if (!template || !template.id) return null;
  return {
    ...template,
    id: String(template.id),
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFlowMode(mode, featureMeta) {
  if (!mode || !mode.id) return null;
  return {
    ...mode,
    id: `${featureMeta.id}:${String(mode.id)}`,
    modeId: String(mode.id),
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFeatureManifest(manifest, featureMeta) {
  if (!manifest) return null;
  return {
    ...manifest,
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

async function instantiateFeatureForCapability(packageName, workspaceState) {
  const moduleName = String(packageName || '').trim();
  if (!moduleName) return null;
  try {
    const entryPath = rootRequire.resolve(moduleName);
    const mod = await import(`${pathToFileURL(entryPath).href}?capabilities=${Date.now()}`);
    const entry = Object.entries(mod).find(([name, value]) => typeof value === 'function' && /Feature$/.test(name));
    if (!entry) return null;
    return new entry[1]({
      workspaceDir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      projectRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      workdir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      resourceRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
    });
  } catch (error) {
    return { __capabilityError: error instanceof Error ? error.message : String(error) };
  }
}

async function instantiateBuiltInFeatureForCapability(featureName, workspaceState) {
  const normalized = cleanSessionText(featureName).toLowerCase();
  if (!normalized) return null;
  try {
    const baseConfig = {
      workspaceDir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      projectRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      workdir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      resourceRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
    };

    if (normalized === 'skill') {
      const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilities=${Date.now()}`);
      const FeatureClass = agentdev?.SkillFeature;
      if (typeof FeatureClass !== 'function') return null;
      return new FeatureClass(baseConfig);
    }

    if (normalized === 'flow') {
      const localFeatures = await import(`${pathToFileURL(path.join(__dirname, 'local-features', 'dist', 'index.js')).href}?builtinCapabilities=${Date.now()}`);
      const FeatureClass = localFeatures?.FlowFeature;
      if (typeof FeatureClass !== 'function') return null;
      const graph = readAssemblyGraphForCapabilities(workspaceState);
      const flows = graphToRuntimeFlowsForCapabilities(graph);
      return new FeatureClass({
        ...baseConfig,
        flows,
        useTestFlow: false,
      });
    }

    const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilities=${Date.now()}`);
    for (const exported of Object.values(agentdev || {})) {
      if (typeof exported !== 'function' || !/Feature$/.test(String(exported.name || ''))) continue;
      if (normalizeBuiltInCapabilityId(exported.name) !== normalized) continue;
      return new exported(baseConfig);
    }

    const localFeatures = await import(`${pathToFileURL(path.join(__dirname, 'local-features', 'dist', 'index.js')).href}?builtinCapabilities=${Date.now()}`);
    for (const [exportName, exported] of Object.entries(localFeatures || {})) {
      if (exportName === 'FlowAwareFeature') continue;
      if (typeof exported !== 'function' || !/Feature$/.test(String(exportName || ''))) continue;
      if (normalizeBuiltInCapabilityId(exportName) !== normalized) continue;
      return new exported(baseConfig);
    }

    return null;
  } catch (error) {
    return { __capabilityError: error instanceof Error ? error.message : String(error) };
  }
}

function hasCapabilitySurface(FeatureClass) {
  const proto = FeatureClass?.prototype;
  if (!proto) return false;
  return ['getFlowVariables', 'getFlowNodeTemplates', 'getFlowModes', 'getFeatureManifest']
    .some((name) => typeof proto[name] === 'function');
}

function normalizeBuiltInCapabilityId(exportName) {
  return String(exportName || '')
    .replace(/Feature$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
    .trim();
}

function isAutoEntryModeForFlow(mode) {
  return mode === 'auto' || mode === 'auto-reenterable';
}

async function listBuiltInCapabilitySources(workspaceState) {
  const sources = [];
  const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilityList=${Date.now()}`);
  const localFeatures = await import(`${pathToFileURL(path.join(__dirname, 'local-features', 'dist', 'index.js')).href}?builtinCapabilityList=${Date.now()}`);

  const modules = [
    { exports: agentdev, packageName: 'agentdev', skip: new Set() },
    { exports: localFeatures, packageName: 'local-features', skip: new Set(['FlowAwareFeature']) },
  ];

  for (const mod of modules) {
    for (const [exportName, exported] of Object.entries(mod.exports || {})) {
      if (!/Feature$/.test(exportName)) continue;
      if (mod.skip.has(exportName)) continue;
      if (typeof exported !== 'function') continue;
      if (!hasCapabilitySurface(exported)) continue;

      const featureId = normalizeBuiltInCapabilityId(exportName);
      if (!featureId) continue;

      sources.push({
        featureMeta: {
          id: featureId,
          name: featureId,
          packageName: mod.packageName,
          token: featureId,
        },
        instantiate: () => instantiateBuiltInFeatureForCapability(featureId, workspaceState),
      });
    }
  }

  return sources;
}

function readAssemblyGraphForCapabilities(workspaceState) {
  const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
  const projectId = cleanSessionText(assemblyForm.editing_config_id)
    || cleanSessionText(assemblyForm.assembly_name)
    || 'flow-workspace';
  const filePath = getFlowGraphPath(projectId, 'agent-flow-graph');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function graphToRuntimeFlowsForCapabilities(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  if (graph.mode && graph.entry && !graph.workflows) return [graph];

  const nodes = graph.nodes;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  const isWorkflowHead = (node) => Boolean(node && (node.type === 'workflow-head' || node.kind === 'workflow-head'));

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }

  const heads = nodes.filter(isWorkflowHead);
  if (heads.length > 0) {
    let autoSeen = false;
    return heads.map((head, index) => {
      const workflowId = cleanSessionText(head.workflowId) || Object.entries(graph.workflows || {})
        .find(([, meta]) => cleanSessionText(meta?.entry) === head.id)?.[0] || `workflow-${index + 1}`;
      const meta = graph.workflows?.[workflowId] || {};
      const seen = new Set([head.id]);
      const queue = [head.id];
      while (queue.length) {
        const id = queue.shift();
        for (const next of adjacency.get(id) || []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      const runtimeNodes = [...seen]
        .map((id) => byId.get(id))
        .filter((node) => node && !isWorkflowHead(node));
      if (runtimeNodes.length === 0) return null;

      const runtimeNodeIds = new Set(runtimeNodes.map((node) => node.id));
      const firstFromHead = edges.find((edge) => edge.from === head.id && runtimeNodeIds.has(edge.to))?.to
        || edges.find((edge) => edge.to === head.id && runtimeNodeIds.has(edge.from))?.from;
      const entry = runtimeNodeIds.has(meta.runtimeEntry) ? meta.runtimeEntry
        : (runtimeNodeIds.has(meta.entry) ? meta.entry : (firstFromHead || runtimeNodes[0]?.id));
      let mode = meta.mode || 'agent-initiated';
      if (isAutoEntryModeForFlow(mode)) {
        if (autoSeen) mode = 'agent-initiated';
        autoSeen = true;
      }

      return {
        id: workflowId,
        name: meta.name || head.name || `工作流 ${index + 1}`,
        description: meta.description || '',
        mode,
        nodes: runtimeNodes.map((item) => {
          const { position, workflowId: _workflowId, ...runtimeNode } = item;
          return runtimeNode;
        }),
        edges: edges.filter((edge) => runtimeNodeIds.has(edge.from) && runtimeNodeIds.has(edge.to)),
        entry,
        reminderFrequency: meta.reminderFrequency || 'every-step',
        reminderInterval: meta.reminderInterval,
        variables: meta.variables || {},
        prompts: meta.prompts || [],
      };
    }).filter(Boolean);
  }

  const seen = new Set();
  let autoSeen = false;
  const flows = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    const ids = [];
    seen.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      ids.push(id);
      for (const next of adjacency.get(id) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    const componentNodes = ids.map((id) => byId.get(id)).filter(Boolean);
    const workflowIds = new Map();
    for (const item of componentNodes) {
      workflowIds.set(item.workflowId, (workflowIds.get(item.workflowId) || 0) + 1);
    }
    const workflowId = [...workflowIds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || `workflow-${flows.length + 1}`;
    const meta = graph.workflows?.[workflowId] || {};
    const entry = componentNodes.some((item) => item.id === meta.entry) ? meta.entry : componentNodes[0]?.id;
    let mode = meta.mode || 'agent-initiated';
    if (isAutoEntryModeForFlow(mode)) {
      if (autoSeen) mode = 'agent-initiated';
      autoSeen = true;
    }

    flows.push({
      id: workflowId,
      name: meta.name || `工作流 ${flows.length + 1}`,
      description: meta.description || '',
      mode,
      nodes: componentNodes.map((item) => {
        const { position, workflowId: _workflowId, ...runtimeNode } = item;
        return runtimeNode;
      }),
      edges: edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to)),
      entry,
      reminderFrequency: meta.reminderFrequency || 'every-step',
      reminderInterval: meta.reminderInterval,
      variables: meta.variables || {},
      prompts: meta.prompts || [],
    });
  }
  return flows;
}

app.get('/protoclaw/flow_capabilities', async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.query.agentId) || 'flow-workspace';
    const workspaceState = await readWorkspaceState(agentId).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
    const selectedFeatures = parseListField(assemblyForm.selected_features);
    const archives = selectedFeatures.length > 0
      ? await resolveAssemblyFeatureArchives(selectedFeatures).catch(() => [])
      : [];

    const features = [];
    const tools = [];
    const variables = [];
    const nodeTemplates = [];
    const modes = [];
    const featureManifests = [];

    const builtInSources = await listBuiltInCapabilitySources(workspaceState).catch(() => []);
    const capabilitySources = [
      ...archives.map((item) => ({
        featureMeta: {
          id: String(item.packageName || item.token || '').replace(/^@agentdev\//, '') || String(item.token || ''),
          name: String(item.packageName || item.token || ''),
          packageName: String(item.packageName || item.token || ''),
          token: String(item.token || ''),
        },
        instantiate: () => instantiateFeatureForCapability(String(item.packageName || item.token || ''), workspaceState),
      })),
      ...builtInSources,
    ];

    const seenFeatureIds = new Set();

    for (const source of capabilitySources) {
      const featureMeta = source.featureMeta;
      if (!featureMeta?.id || seenFeatureIds.has(featureMeta.id)) continue;
      seenFeatureIds.add(featureMeta.id);
      const instance = await source.instantiate();
      const featureSummary = { ...featureMeta, tools: 0, variables: 0, nodeTemplates: 0, modes: 0, error: '' };

      if (!instance || instance.__capabilityError) {
        featureSummary.error = instance?.__capabilityError || 'Feature entry not found';
        features.push(featureSummary);
        continue;
      }

      try {
        const featureTools = typeof instance.getTools === 'function' ? instance.getTools() : [];
        if (Array.isArray(featureTools)) {
          for (const tool of featureTools) {
            const serialized = serializeFlowTool(tool, featureMeta);
            if (serialized) tools.push(serialized);
          }
          featureSummary.tools = featureTools.length;
        }
      } catch (error) {
        featureSummary.error = `getTools: ${error instanceof Error ? error.message : String(error)}`;
      }

      try {
        const featureVariables = typeof instance.getFlowVariables === 'function' ? instance.getFlowVariables() : [];
        if (Array.isArray(featureVariables)) {
          for (const variable of featureVariables) {
            const serialized = serializeFlowVariable(variable, featureMeta);
            if (serialized) variables.push(serialized);
          }
          featureSummary.variables = featureVariables.length;
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFlowVariables: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      try {
        const templates = typeof instance.getFlowNodeTemplates === 'function' ? instance.getFlowNodeTemplates() : [];
        if (Array.isArray(templates)) {
          for (const template of templates) {
            const serialized = serializeNodeTemplate(template, featureMeta);
            if (serialized) nodeTemplates.push(serialized);
          }
          featureSummary.nodeTemplates = templates.length;
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFlowNodeTemplates: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      try {
        const featureModes = typeof instance.getFlowModes === 'function' ? instance.getFlowModes() : [];
        if (Array.isArray(featureModes)) {
          for (const mode of featureModes) {
            const serialized = serializeFlowMode(mode, featureMeta);
            if (serialized) modes.push(serialized);
          }
          featureSummary.modes = featureModes.length;
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFlowModes: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      try {
        const manifest = typeof instance.getFeatureManifest === 'function' ? instance.getFeatureManifest() : null;
        if (manifest && typeof manifest === 'object') {
          const serialized = serializeFeatureManifest(manifest, featureMeta);
          if (serialized) featureManifests.push(serialized);
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFeatureManifest: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      features.push(featureSummary);
    }

    let modelPresets = [];
    try {
      const presetData = await readModelPresets();
      modelPresets = Array.isArray(presetData?.presets) ? presetData.presets : [];
    } catch {}

    res.json({
      agentId,
      selectedFeatures,
      features,
      tools,
      variables,
      nodeTemplates,
      modes,
      featureManifests,
      modelPresets,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) { next(error); }
});

// ── Server-side audio feedback for choice input requests ───────────────────

const _seenChoiceRequestIds = new Set();
const PLAY_SOUND_SCRIPT = path.join(__dirname, 'scripts', 'play-sound.ps1');

/**
 * Play an audio file on the server machine via PowerShell MCI.
 * Fire-and-forget — does not block the response.
 */
function playSoundOnServer(soundFile) {
  const soundPath = path.join(__dirname, 'public', 'sounds', soundFile);
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PLAY_SOUND_SCRIPT,
    '-Path', soundPath,
  ], { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
}

/**
 * Intercept input-requests proxy: forward to ViewerWorker, but also inspect
 * the response for new choice-type requests and play a terminal bell sound
 * on the server immediately — independent of frontend rendering state.
 */
app.get('/api/agents/:agentId/input-requests', async (req, res, next) => {
  try {
    const targetUrl = `${VIEWER_ORIGIN}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (key.toLowerCase() === 'host') continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const response = await fetch(targetUrl, { method: 'GET', headers });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);

    // Detect new choice requests after forwarding the response
    if (response.ok) {
      try {
        const requests = JSON.parse(buffer.toString('utf8'));
        if (Array.isArray(requests)) {
          for (const r of requests) {
            const isChoice = r && r.mode === 'choices'
              && Array.isArray(r.questions) && r.questions.length > 0
              && typeof r.requestId === 'string';
            if (isChoice && !_seenChoiceRequestIds.has(r.requestId)) {
              if (_seenChoiceRequestIds.size > 500) _seenChoiceRequestIds.clear();
              _seenChoiceRequestIds.add(r.requestId);
              playSoundOnServer('terminal-bell.mp3');
              break; // one bell per poll cycle
            }
          }
        }
      } catch { /* non-critical */ }
    }
  } catch (err) {
    next(err);
  }
});

app.get(/^\/(api|features|template|tools|npm)(\/.*)?$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.get(/^\/(chunk-|BasicAgent-|ExplorerAgent-|notification-|resolver-|types-|index\.js).*$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.put('/api/agents/current', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/queue-input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.get('/api/agents/:agentId/queued-inputs', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/dequeue-input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/interrupt', (req, res, next) => {
  console.log(`[Server] POST /api/agents/${req.params.agentId}/interrupt → proxying to ViewerWorker`);
  proxyToViewer(req, res).catch(next);
});

app.get('/api/agents/:agentId/running', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.delete('/api/agents/:agentId', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public')));

app.use((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal Server Error' });
});

async function shutdown(exitCode = 0) {
  for (const runtime of managedAgents.values()) {
    if (runtime.process && runtime.process.exitCode === null && !runtime.stopped) {
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
  }

  for (const runtime of assemblyRuntimeProcesses.values()) {
    if (runtime.process && runtime.process.exitCode === null && !runtime.stopped) {
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
  }

  await viewerWorker.stop().catch(() => {});
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

async function main() {
  await viewerWorker.start();

  // Ensure config directory and essential files exist (config/ is gitignored)
  try {
    await ensureDir(path.join(__dirname, 'config'));
    const exampleConfigPath = path.join(__dirname, 'config', 'default.example.json');
    if (!existsSync(MODEL_CONFIG_PATH)) {
      const example = await readJsonSafe(exampleConfigPath, null);
      await writeModelConfig(example || { defaultModel: {}, agent: {} });
      log('server', 'Created config/default.json from template');
    }
    if (!existsSync(MODEL_PRESETS_PATH)) {
      await writeModelPresetsFile({ providers: [], presets: [] });
      log('server', 'Created config/presets.json');
    }
  } catch (err) {
    log('server', `config init failed: ${err.message}`, 'warn');
  }

  // One-time cleanup of stale empty sessions from previous runs.
  // Only runs at startup — never during normal operation.
  for (const agentId of WORKSPACE_SESSION_AGENT_IDS) {
    try {
      await cleanupEmptySessions(agentId);
    } catch (err) {
      console.warn(`[sessions] startup cleanup failed for ${agentId}:`, err.message);
    }
  }

  app.listen(APP_PORT, () => {
    log('server', `product ui: http://127.0.0.1:${APP_PORT}`);
    log('server', `viewer worker: ${VIEWER_ORIGIN}`);
    fireBootSchedules();
  });
}

main().catch((error) => {
  log('server', error.stack || error.message, 'error');
  process.exit(1);
});
