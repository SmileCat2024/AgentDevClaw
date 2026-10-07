// Agent Studio「项目 → feature」模型迁移编排（ADR-0022）。
//
// 一次性、幂等，服务启动时执行（server.js main()）：
//   1. 注册表迁移（feature-store.migrateLegacyRegistry）：projects.json + 各目录
//      schema ≤ 4 档案的 features[] → 全局 features.json，旧档案就地升级 schema 5；
//   2. 会话重绑定：agent-studio 会话索引中带 studioProjectId 的记录，按
//      openDirectory 匹配该目录全部 feature，换算为 studioFeatureIds（宁多绑不丢
//      可见性）；匹配不到 feature 的会话清空绑定，由首页「最近的对话」兜底展示；
//   3. 重绑定无异常后删除 projects.json（迁移收口）。
//
// 中断重跑安全：第 1 步以 features.json 已有记录优先；第 2 步换算后即删除
// studioProjectId 字段，重跑无新工作；第 3 步在前两步异常时跳过，下次启动重试。
//
// 迁移逻辑不进 agent 运行时（agent 进程每次会话都起，迁移只能做一次）；
// feature-store 是 shared 实现，本模块是唯一的服务端编排入口。

import {
  migrateLegacyRegistry,
  deleteLegacyProjectsRegistry,
  readFeatureRegistry,
} from '../../local-features/dist/agent-studio/src/feature-store.js';
import { readSessionIndex, updateSessionIndex } from '../shared/session-access.js';

const STUDIO_AGENT_ID = 'agent-studio';

/** 目录归一化比较（与 session-helpers-pure.normalizeProjectDirForCompare 同语义）。 */
function normalizeDirForCompare(dir) {
  return String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 收集一条会话记录上旧字段 studioProjectId（顶层或 metadata 内）。 */
function legacyProjectId(record) {
  return String(record?.studioProjectId || record?.metadata?.studioProjectId || '').trim();
}

/**
 * 会话重绑定：把 studioProjectId 换算为 studioFeatureIds。
 * 绑定策略：按会话 openDirectory 匹配该目录下全部 feature（旧模型一个目录 =
 * 一个项目，项目内 feature 都可能在这段对话里被开发过，宁多绑不丢可见性）。
 * 返回重绑定的会话数；索引无旧字段记录时不产生写入。
 */
async function rebindStudioSessions(features) {
  const byDirectory = new Map();
  for (const feature of features) {
    const key = normalizeDirForCompare(feature?.directory);
    if (!key) continue;
    const ids = byDirectory.get(key) || [];
    ids.push(feature.id);
    byDirectory.set(key, ids);
  }

  const index = await readSessionIndex(STUDIO_AGENT_ID);
  const stale = (index?.sessions || []).filter((record) => legacyProjectId(record));
  if (stale.length === 0) return 0;

  await updateSessionIndex(STUDIO_AGENT_ID, (currentIndex) => {
    for (const record of currentIndex.sessions) {
      if (!legacyProjectId(record)) continue;
      const directory = normalizeDirForCompare(record?.openDirectory);
      const featureIds = directory ? (byDirectory.get(directory) || []) : [];
      record.metadata = { ...(record.metadata || {}) };
      delete record.metadata.studioProjectId;
      delete record.studioProjectId;
      // 绑定只写 metadata（light record 从 metadata 派生顶层投影）
      if (featureIds.length > 0) {
        record.metadata.studioFeatureIds = featureIds;
      }
    }
    return currentIndex;
  });
  return stale.length;
}

/**
 * 启动迁移入口。失败只告警不阻断启动：旧字段与新字段并存时新模型读不到的
 * 只是旧详情页数据，核心功能（会话/目录/feature 注册表）不受影响。
 */
export async function runStudioFeatureMigration() {
  const registry = await migrateLegacyRegistry();
  if (registry.skipped.length > 0) {
    console.warn(`[studio-migration] skipped ${registry.skipped.length} unreadable director(y/ies):`, registry.skipped);
  }
  const rebound = await rebindStudioSessions(await readFeatureRegistry());
  await deleteLegacyProjectsRegistry();
  if (registry.changed || rebound > 0) {
    console.log(`[studio-migration] registry migrated: ${registry.changed}, sessions rebound: ${rebound}`);
  }
}
