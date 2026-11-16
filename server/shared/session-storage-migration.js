import path from 'path';
import { existsSync, renameSync, readdirSync, rmdirSync, statSync, mkdirSync } from 'fs';
import { USER_DATA_ROOT } from './constants.js';
import { sanitizeSessionFragment } from './string-helpers.js';

/**
 * 会话存储声明化迁移（ADR-0016 修订配套）。
 *
 * 两个动作，均幂等、可安全重入：
 * 1. 归位：声明 sessionBundle 的 agent 若旧位置（prebuilt-sessions/<agentId>）
 *    仍有数据且新位置（workspaces/<agentId>/sessions）不存在，一次性 rename
 *    归位。两边都有数据视为冲突：不合并、告警保留，人工处置。
 * 2. 清壳：prebuilt-sessions 下完全为空的目录（历史 runtime 实例残骸
 *    agent-N-<pid> 与归位后的空壳）直接移除；有任何文件的目录不碰。
 *
 * 迁移失败遵循 ADR-0016 原则：保持现状不动、告警不阻断启动。
 * 调用时点：server 启动序列，sessionBundle 派生注册完成之后（迁移目标由
 * resolveSessionStoreDir 按声明解析，不硬编码 agent 名单）、任何 runtime
 * 拉起之前。
 */

export function runSessionStoreMigration({ dataRoot, bundleAgentIds, log = () => {} } = {}) {
  const actions = { relocated: [], conflicts: [], cleanedEmptyDirs: 0, failures: [] };
  const root = dataRoot || USER_DATA_ROOT;

  for (const agentId of Array.isArray(bundleAgentIds) ? bundleAgentIds : []) {
    const id = sanitizeSessionFragment(agentId);
    const legacyDir = path.join(root, 'prebuilt-sessions', id);
    // 目标路径由传入的声明名单直接构造，不依赖全局注册态
    const targetDir = path.join(root, 'workspaces', id, 'sessions');
    if (!existsSync(legacyDir)) continue;
    if (existsSync(targetDir)) {
      try {
        if (readdirSync(targetDir).length > 0) {
          actions.conflicts.push({ agentId: id, legacyDir, targetDir });
          log(`[session-store-migration] 冲突：${id} 新旧位置均有数据，保留不动（旧: ${legacyDir} / 新: ${targetDir}）`);
          continue;
        }
        // 首次启动可能已创建新位置空目录；它不构成数据冲突，但 Windows
        // 不能把旧目录 rename 覆盖到已存在的空目录，因此先移除空壳再归位。
        rmdirSync(targetDir);
      } catch (err) {
        actions.failures.push({ agentId: id, message: err?.message || String(err) });
        log(`[session-store-migration] 目标目录检查失败（保持现状）: ${id} ${err?.message || err}`);
        continue;
      }
    }
    try {
      mkdirSync(path.dirname(targetDir), { recursive: true });
      renameSync(legacyDir, targetDir);
      actions.relocated.push(id);
      log(`[session-store-migration] 归位：${id} ${legacyDir} -> ${targetDir}`);
    } catch (err) {
      actions.failures.push({ agentId: id, message: err?.message || String(err) });
      log(`[session-store-migration] 归位失败（保持现状）: ${id} ${err?.message || err}`);
    }
  }

  cleanEmptyDirs(path.join(root, 'prebuilt-sessions'), actions, log);
  return actions;
}

function cleanEmptyDirs(dirPath, actions, log) {
  if (!existsSync(dirPath)) return;
  for (const name of readdirSync(dirPath)) {
    const entry = path.join(dirPath, name);
    try {
      if (!statSync(entry).isDirectory()) continue;
      // rmdir 仅能移除空目录：非空抛 ENOTEMPTY，天然不会误删有数据的目录
      rmdirSync(entry);
      actions.cleanedEmptyDirs += 1;
    } catch (err) {
      if (err?.code !== 'ENOTEMPTY' && err?.code !== 'EPERM' && err?.code !== 'EBUSY') {
        log(`[session-store-migration] 清壳检查异常（忽略）: ${entry} ${err?.message || err}`);
      }
    }
  }
}
