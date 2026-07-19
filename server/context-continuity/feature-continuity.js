/**
 * Feature Continuity Protocol (Claw 侧)
 *
 * 用于在会话精简（trim-transcript）与摘要（summarized-nine-section）时
 * 把源会话的 Feature 内存状态转移到新 runtime。
 *
 * 设计理念（descriptor 驱动）：
 * - 协议不依赖 Claw 中心注册表。Feature 通过包装类（见 continuity-participant）
 *   自声明参与 continuity：在 captureState 的返回值里注入
 *   __claw_continuity__ = { protocol, importMode }。
 * - export 端从 sessionSnapshot.runtime.featureStates[*].snapshot 读取 descriptor，
 *   凡是声明了 descriptor 的 feature 都会被采集，未声明一律不参与。
 * - import 端通过 agent 实例的 getContinuityDescriptor() 校验当前 runtime 的 feature
 *   是否仍然声明该 protocol；声明一致才调用 restoreState。
 * - PROTOCOL_ADAPTERS 是按 protocol 注册的"特化 adapter"开放命名空间。
 *   未登记的 protocol（含 GENERIC_CONTINUITY_PROTOCOL）走透传，无需登记。
 *   只有需要 schema 规范化等特化处理的协议才在这里登记 adapter
 *   （例如 'claw.todo-continuity.v1' 为了清理脏数据需要 normalizeTodoSnapshot）。
 *
 * 与框架 captureState/restoreState 的关系：
 * - 框架 captureFeatureSnapshots 照常收集所有实现 captureState 的 feature 状态，
 *   不感知 continuity 协议。
 * - descriptor 注入发生在包装类的 captureState 里，对框架透明。
 */

import {
  CONTINUITY_FIELD_KEY,
  GENERIC_CONTINUITY_PROTOCOL,
  readContinuityDescriptor,
  stripContinuityField,
} from '../../local-features/dist/continuity-participant/src/index.js';

const CONTINUITY_SCHEMA_VERSION = 1;

const TODO_PROTOCOL = 'claw.todo-continuity.v1';
const TODO_FEATURE_NAME = 'todo';
const DEFAULT_IMPORT_MODE = 'replace';

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

/**
 * Todo protocol 的 export 适配器：
 * - 从 raw snapshot 中剥离 continuity descriptor 字段后做 schema 规范化
 * - tasks 为空时返回 null，表示当前无可转移状态
 */
function normalizeTodoExportState(rawSnapshot) {
  const stripped = stripContinuityField(rawSnapshot) || {};
  const tasks = Array.isArray(stripped.tasks)
    ? stripped.tasks.map(normalizeTodoTask).filter(Boolean)
    : [];
  if (tasks.length === 0) return null;
  return {
    tasks,
    counter: typeof stripped.counter === 'number'
      ? stripped.counter
      : tasks.reduce((max, task) => Math.max(max, Number.parseInt(task.id, 10) || 0), 0),
    reminderContent: typeof stripped.reminderContent === 'string' ? stripped.reminderContent : undefined,
    consecutiveNoTodoTurns: 0,
    reminderInjected: false,
  };
}

/**
 * Todo protocol 的 import 适配器：保留原有 metadata 注入语义。
 * 不重新 normalize（export 端已 normalize；旧数据未 normalize 时按原样交给
 * feature.restoreState，由 feature 自己处理兼容性）。
 */
function decorateTodoImportState(state, options) {
  return {
    ...state,
    metadata: {
      importedBy: 'claw-continuity',
      sourceSessionId: cleanText(options.sourceSessionId),
      importedAt: new Date().toISOString(),
    },
  };
}

/**
 * Protocol Adapter 合约：
 *   exportAdapter?(rawSnapshot) => state | null    返回 null/undefined 表示丢弃
 *   importAdapter?(state, options) => state        注入 metadata 等
 *
 * 未在表中登记的 protocol（包括 GENERIC_CONTINUITY_PROTOCOL）走通用透传：state 原样进出。
 *
 * 注意：这是一张开放的 protocol 命名空间表，不是 feature 注册表。
 * 第三方 feature 用 declareContinuity + GENERIC_CONTINUITY_PROTOCOL 即可参与
 * continuity，无需在此登记。
 */
const PROTOCOL_ADAPTERS = new Map([
  [TODO_PROTOCOL, {
    exportAdapter: normalizeTodoExportState,
    importAdapter: decorateTodoImportState,
  }],
]);

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

/**
 * 从 sessionSnapshot 导出所有自声明 continuity 的 feature 状态。
 *
 * 遍历 runtime.featureStates，逐个检查 snapshot 内是否注入了 continuity descriptor。
 * 仅采集显式声明 descriptor 的 feature；未声明（即未通过 declareContinuity 包装）
 * 的 feature 一律不参与，框架自带的 captureState 不会被自动消费。
 */
export function exportFeatureContinuity(sessionSnapshot, options = {}) {
  const mode = cleanText(options.mode) || 'handoff';
  const states = [];

  const checkpoints = Array.isArray(sessionSnapshot?.runtime?.featureStates)
    ? sessionSnapshot.runtime.featureStates
    : [];

  for (const checkpoint of checkpoints) {
    const featureName = cleanText(checkpoint?.featureName);
    if (!featureName) continue;

    const rawSnapshot = checkpoint?.snapshot;
    const descriptor = readContinuityDescriptor(rawSnapshot);
    if (!descriptor) continue;

    const adapter = PROTOCOL_ADAPTERS.get(descriptor.protocol);
    const state = adapter?.exportAdapter
      ? adapter.exportAdapter(rawSnapshot)
      : cloneJson(stripContinuityField(rawSnapshot));

    // adapter 返回 null/undefined 表示当前无可转移状态（如 todo tasks 为空）
    if (state === null || state === undefined) continue;

    states.push({
      featureName,
      protocol: descriptor.protocol,
      state,
      importMode: descriptor.importMode === 'merge' ? 'merge' : DEFAULT_IMPORT_MODE,
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

/**
 * 将 continuity states 导入到新 runtime 的 agent 中。
 *
 * 仅消费与 agent 当前 feature 声明 protocol 一致的 entry：
 * 通过 feature.getContinuityDescriptor() 查询当前 runtime 的 feature
 * 是否声明参与 continuity 且 protocol 匹配。
 *
 * 这保证了：源会话打包了某 feature 的 continuity，但新 runtime 装配时换了
 * 不同 feature 实现（或没有包装），不会误把状态塞进去。
 */
export async function importFeatureContinuity(agent, continuity, options = {}) {
  const states = Array.isArray(continuity?.states) ? continuity.states : [];
  const imported = [];

  for (const entry of states) {
    const featureName = cleanText(entry?.featureName);
    if (!featureName) continue;

    const feature = findAgentFeature(agent, featureName);
    if (!feature || typeof feature.restoreState !== 'function') continue;

    // 当前 runtime 的 feature 必须自声明参与 continuity，且 protocol 匹配
    const descriptor = typeof feature.getContinuityDescriptor === 'function'
      ? feature.getContinuityDescriptor()
      : null;
    if (!descriptor || cleanText(descriptor.protocol) !== cleanText(entry?.protocol)) {
      continue;
    }

    const adapter = PROTOCOL_ADAPTERS.get(descriptor.protocol);
    const rawState = entry?.state;
    const state = adapter?.importAdapter
      ? adapter.importAdapter(rawState, options)
      : rawState;

    await feature.restoreState(state);
    imported.push(featureName);
  }

  return imported;
}

// 兼容性再导出：让 server 模块可以从这里统一拿到字段名常量
export { CONTINUITY_FIELD_KEY, GENERIC_CONTINUITY_PROTOCOL };
