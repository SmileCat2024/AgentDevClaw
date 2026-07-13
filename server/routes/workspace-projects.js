import path from 'path';

import { cleanSessionText, parseListField, getAssemblyWorkspaceDir } from '../shared/string-helpers.js';

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

export function buildWorkspaceFeatureProjectId(project = {}) {
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

export function buildWorkspaceAgentProjectId(project = {}) {
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

export function upsertWorkspaceFeatureProject(state, rawProject, timestamp) {
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

export function upsertWorkspaceAgentProject(state, rawProject, timestamp) {
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

export function syncFeatureCreatorProjects(state, timestamp) {
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

export function syncAgentCreatorProjects(state, timestamp) {
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

export function syncFlowAssemblyProjects(state, timestamp) {
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
