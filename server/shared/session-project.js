import { existsSync } from 'fs';

import { findPhProjectSync } from '../routes/ph-projects.js';
import { cleanSessionText } from './string-helpers.js';

// ── PH 项目会话归属解析（ticket 042）───────────────────────────────────────
//
// 单一归属规则源：server 路由（agent-startup 的运行时装配）与三类宿主脚本
// （run-prebuilt-agent / mirror-runtime / run-one-shot-agent）都经本模块把
// Session 索引记录解析为项目身份与运行目录，禁止各自实现不同规则。
//
// 契约（docs/tickets/2026-10-22-ph-project-coexistence.md）：
// - 目录会话不带非空 projectId，继续按 openDirectory 归属；
// - 项目会话的运行目录由项目表当前记录决定（openDirectory 只是创建时的
//   目录记录，不是运行目录权威）；
// - 显式项目身份无法解析时必须报错，绝不退回目录会话语义
//   （openDirectory / workspace state 回退都不允许）。

/** 会话索引记录的 PH 项目归属；'' 表示目录会话。 */
export function getSessionProjectId(record) {
  return cleanSessionText(record?.projectId);
}

/**
 * Session 记录 → PH 项目运行目录（strict）。
 *
 * - 无 projectId：返回 null，调用方继续目录会话语义（openDirectory）；
 * - 有 projectId：读项目表解析当前 workDirectory。项目不在表中、表损坏、
 *   记录无目录或目录在磁盘上不存在时直接 throw——项目会话不允许退回
 *   openDirectory 旧记录或 workspace 当前目录继续运行。
 *
 * 同步实现：三类宿主在 readFileSync 上下文调用（server 侧 async 调用方
 * 同样可用）。
 */
export function resolveSessionRuntimeDirectory(record, { sessionId = '' } = {}) {
  const projectId = getSessionProjectId(record);
  if (!projectId) return null;
  const sessionHint = sessionId ? ` (session=${sessionId})` : '';
  const project = findPhProjectSync(projectId); // 损坏表 / 非法 ID 直接 throw
  if (!project) {
    throw new Error(`Session belongs to unknown PH project ${projectId}${sessionHint}`);
  }
  const workDirectory = cleanSessionText(project.workDirectory);
  if (!workDirectory) {
    throw new Error(`PH project ${projectId} has no work directory${sessionHint}`);
  }
  if (!existsSync(workDirectory)) {
    throw new Error(`PH project ${projectId} work directory does not exist: ${workDirectory}${sessionHint}`);
  }
  return workDirectory;
}
