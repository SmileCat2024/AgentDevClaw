/**
 * Continuity Participant（Claw 消费层）
 *
 * 实现本体已下沉框架（ticket 006），本模块从 'agentdev' 消费 declareContinuity，
 * 并保留两件 Claw 侧事务：
 *
 * 1. Claw 协议命名空间（claw.*）。协议字符串是持久化数据的一部分
 *    （会话快照 descriptor 与 handoff 包 states[].protocol 两处落盘），
 *    换成框架 agentdev.* 会让旧数据的 protocol 匹配失效。
 *    008 票只重命名快照字段 key，协议名保持不变。
 * 2. continuity 字段一次性读旧写新：declareContinuity（框架）写
 *    __agentdev_continuity__；本模块的 readContinuityDescriptor /
 *    stripContinuityField 同时兼容读旧 __claw_continuity__，让旧会话快照
 *    的 descriptor 仍可被识别与剥离（docs/tickets/008）。
 */

import { CONTINUITY_FIELD_KEY, declareContinuity } from '@agentdev/core';

export { CONTINUITY_FIELD_KEY, declareContinuity };

/**
 * 旧字段名：切换前持久化数据（会话快照 / 旧 handoff 包）使用。
 * 只在读取与剥离时兼容，不再写出。
 */
export const LEGACY_CONTINUITY_FIELD_KEY = '__claw_continuity__';

/**
 * 通用 continuity 协议：无 schema 适配，state 原样进出。
 */
export const GENERIC_CONTINUITY_PROTOCOL = 'claw.feature-continuity.v1';

/**
 * OpencodeBasic 的专用 continuity 协议。
 *
 * 接续时保留“先读后写”校验需要的 readFiles，
 * 但不继承依赖旧上下文内容的 readDedupState。
 */
export const OPENCODE_BASIC_CONTINUITY_PROTOCOL = 'claw.opencode-basic-continuity.v1';

/**
 * Claw continuity descriptor：feature 自声明参与 continuity 的合约。
 */
export interface ClawContinuityDescriptor {
  protocol: string;
  importMode?: 'replace' | 'merge';
}

/**
 * 从 snapshot 读取 continuity descriptor。无声明返回 null。
 * 兼容读取新旧两种字段 key（新 __agentdev_continuity__ 优先，旧 __claw_continuity__ 兜底）。
 */
export function readContinuityDescriptor(snapshot: unknown): ClawContinuityDescriptor | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const record = snapshot as Record<string, unknown>;
  const descriptor = record[CONTINUITY_FIELD_KEY] ?? record[LEGACY_CONTINUITY_FIELD_KEY];
  if (!descriptor || typeof descriptor !== 'object') return null;
  const protocol = (descriptor as { protocol?: unknown }).protocol;
  if (typeof protocol !== 'string' || !protocol.trim()) return null;
  return descriptor as ClawContinuityDescriptor;
}

/**
 * 从 snapshot 剥离 continuity 字段（新旧两种 key 都剥），返回纯 state。
 */
export function stripContinuityField(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  if (!(CONTINUITY_FIELD_KEY in record) && !(LEGACY_CONTINUITY_FIELD_KEY in record)) return snapshot;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== CONTINUITY_FIELD_KEY && key !== LEGACY_CONTINUITY_FIELD_KEY) {
      rest[key] = record[key];
    }
  }
  return rest;
}
