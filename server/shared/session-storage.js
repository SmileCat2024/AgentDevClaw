import path from 'path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { USER_DATA_ROOT, WORKSPACE_SESSION_AGENT_IDS } from './constants.js';
import { sanitizeSessionFragment } from './string-helpers.js';

/**
 * 会话存储分区（ADR-0016 修订：分区键声明化）。
 *
 * 语义：metadata 声明 `sessionBundle: true` 的 agent，其会话目录是工作空间
 * 数据包的一等成员（`workspaces/<agentId>/sessions/`）；未声明的 agent 会话
 * 存 `prebuilt-sessions/<agentId>/`（目录名是历史遗留，实际语义是"无工作
 * 空间数据包的 agent 会话区"）。
 *
 * 与 string-helpers 的 isWorkspaceSessionAgent（workspace state / forms /
 * project 面）是两个判定，不要合并：memo 声明 sessionBundle 后存储归位，
 * 但不应因此获得 forms / project 分支行为。
 *
 * 兜底集合 = 声明化前的现役事实（WORKSPACE_SESSION_AGENT_IDS）：宿主未完成
 * 派生注册前行为与旧集合一致，保证任何调用方在注册前的读取不漂移。宿主
 * （server / runtime 脚本）启动后按 metadata 声明替换，模式与
 * thread-control/host-agents.js 的 registerThreadHostAgents 同构
 * （ADR-0024 可拔插约束：公共代码不按 APP ID 硬编码）。
 */

/** 会话打包进工作空间数据包的 agent 集合（初始为迁移兜底，宿主启动按声明替换）。 */
export const SESSION_BUNDLE_AGENT_IDS = new Set(WORKSPACE_SESSION_AGENT_IDS);

/**
 * 注册会话打包集合（替换式、幂等）。宿主启动时按 agents metadata 的
 * `sessionBundle` 声明派生注入；测试可直接注册构造场景。
 */
export function registerSessionBundleAgents(agentIds) {
  SESSION_BUNDLE_AGENT_IDS.clear();
  for (const id of Array.isArray(agentIds) ? agentIds : []) {
    const normalized = String(id || '').trim();
    if (normalized) SESSION_BUNDLE_AGENT_IDS.add(normalized);
  }
}

/** 单点声明（runtime 脚本一进程一 agent 场景：读自身 metadata 后声明，不影响其他成员）。 */
export function declareSessionBundleAgent(agentId, bundled) {
  const normalized = sanitizeSessionFragment(agentId);
  if (!normalized) return;
  if (bundled) SESSION_BUNDLE_AGENT_IDS.add(normalized);
  else SESSION_BUNDLE_AGENT_IDS.delete(normalized);
}

/** 按 metadata 声明派生集合（输入为 discoverAgents 结果或等价形态）。 */
export function deriveSessionBundleAgentIds(agents) {
  const ids = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent?.sessionBundle === true && agent?.enabled !== false) {
      const id = String(agent.id || '').trim();
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * 轻量扫描注册：直接读 agents 根目录（prebuilt-agents/<tier>/<name>/metadata.json）
 * 的 sessionBundle 声明。scripts（不经 server 启动序列）用这个入口获得与
 * server 一致的派生结果；server 侧已有 discoverAgents 结果，用
 * registerSessionBundleAgents + deriveSessionBundleAgentIds 即可，不必走本函数。
 */
export function registerSessionBundleAgentsFromScan(agentsRoot) {
  const ids = [];
  for (const tier of existsSync(agentsRoot) ? readdirSafe(agentsRoot) : []) {
    const tierDir = path.join(agentsRoot, tier);
    for (const name of readdirSafe(tierDir)) {
      const metaPath = path.join(tierDir, name, 'metadata.json');
      try {
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (meta?.sessionBundle === true && meta?.enabled !== false && meta.id) {
          ids.push(String(meta.id).trim());
        }
      } catch {
        // 单个 metadata 损坏不阻断派生，保持兜底集合语义
      }
    }
  }
  registerSessionBundleAgents(ids);
}

function readdirSafe(dirPath) {
  try {
    return readdirSync(dirPath).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/** 判定 agent 的会话是否打包进工作空间数据包。 */
export function isSessionBundleAgent(agentId) {
  return SESSION_BUNDLE_AGENT_IDS.has(sanitizeSessionFragment(agentId));
}

/**
 * agent 会话存储目录的单一权威解析入口。
 * dataRoot 参数化以支持容器挂载与多实例隔离（AGENTDEV_DATA_DIR 由
 * resolveUserDataDir 在调用方解析后传入）。
 */
export function resolveSessionStoreDir(agentId, dataRoot = USER_DATA_ROOT) {
  const id = sanitizeSessionFragment(agentId);
  return isSessionBundleAgent(id)
    ? path.join(dataRoot, 'workspaces', id, 'sessions')
    : path.join(dataRoot, 'prebuilt-sessions', id);
}
