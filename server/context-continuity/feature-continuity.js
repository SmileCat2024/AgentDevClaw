const CONTINUITY_SCHEMA_VERSION = 1;

const TODO_FEATURE_NAME = 'todo';
const TODO_PROTECTED_TOOLS = ['task_create', 'task_update', 'task_clear'];

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTodoTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = cleanText(task.id);
  if (!id) return null;
  const status = ['pending', 'in_progress', 'completed', 'deleted'].includes(task.status)
    ? task.status
    : 'pending';
  return {
    id,
    subject: cleanText(task.subject),
    description: cleanText(task.description),
    activeForm: cleanText(task.activeForm),
    status,
    owner: cleanText(task.owner) || undefined,
    blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : [],
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    metadata: task.metadata && typeof task.metadata === 'object' ? cloneJson(task.metadata) : undefined,
    createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
  };
}

function normalizeTodoSnapshot(snapshot) {
  const tasks = Array.isArray(snapshot?.tasks)
    ? snapshot.tasks.map(normalizeTodoTask).filter(Boolean)
    : [];
  if (tasks.length === 0) return null;
  return {
    tasks,
    counter: typeof snapshot?.counter === 'number'
      ? snapshot.counter
      : tasks.reduce((max, task) => Math.max(max, Number.parseInt(task.id, 10) || 0), 0),
    reminderContent: typeof snapshot?.reminderContent === 'string' ? snapshot.reminderContent : undefined,
    consecutiveNoTodoTurns: 0,
    reminderInjected: false,
  };
}

function findFeatureCheckpoint(sessionSnapshot, featureName) {
  const checkpoints = Array.isArray(sessionSnapshot?.runtime?.featureStates)
    ? sessionSnapshot.runtime.featureStates
    : [];
  return checkpoints.find((entry) => entry?.featureName === featureName && entry.snapshot);
}

export function getContinuityToolPolicy() {
  return {
    preserveToolNames: [...TODO_PROTECTED_TOOLS],
  };
}

export function applyContinuityToolPolicy(rawPolicy = {}) {
  const existing = Array.isArray(rawPolicy?.preserveToolNames) ? rawPolicy.preserveToolNames.map(String) : [];
  return {
    ...rawPolicy,
    preserveToolNames: [...new Set([...existing, ...getContinuityToolPolicy().preserveToolNames])],
  };
}

export function exportFeatureContinuity(sessionSnapshot, options = {}) {
  const mode = cleanText(options.mode) || 'handoff';
  const states = [];

  const todoCheckpoint = findFeatureCheckpoint(sessionSnapshot, TODO_FEATURE_NAME);
  const todoState = normalizeTodoSnapshot(todoCheckpoint?.snapshot);
  if (todoState) {
    states.push({
      featureName: TODO_FEATURE_NAME,
      protocol: 'claw.todo-continuity.v1',
      state: todoState,
      importMode: 'replace',
    });
  }

  return {
    schemaVersion: CONTINUITY_SCHEMA_VERSION,
    mode,
    exportedAt: new Date().toISOString(),
    states,
    toolPolicy: getContinuityToolPolicy(),
  };
}

export function hasFeatureContinuity(continuity) {
  return Array.isArray(continuity?.states) && continuity.states.length > 0;
}

function findAgentFeature(agent, featureName) {
  const features = agent?.features;
  if (features?.get && typeof features.get === 'function') {
    const direct = features.get(featureName);
    if (direct) return direct;
    for (const feature of features.values()) {
      if (feature?.name === featureName) return feature;
    }
  }
  if (Array.isArray(agent?.features)) {
    return agent.features.find((feature) => feature?.name === featureName);
  }
  return null;
}

export async function importFeatureContinuity(agent, continuity, options = {}) {
  const states = Array.isArray(continuity?.states) ? continuity.states : [];
  const imported = [];
  for (const entry of states) {
    if (entry?.featureName !== TODO_FEATURE_NAME) continue;
    const feature = findAgentFeature(agent, TODO_FEATURE_NAME);
    if (!feature || typeof feature.restoreState !== 'function') continue;
    const state = normalizeTodoSnapshot(entry.state);
    if (!state) continue;
    await feature.restoreState({
      ...state,
      metadata: {
        importedBy: 'claw-continuity',
        sourceSessionId: cleanText(options.sourceSessionId),
        importedAt: new Date().toISOString(),
      },
    });
    imported.push(entry.featureName);
  }
  return imported;
}
