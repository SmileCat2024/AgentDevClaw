/**
 * ContinuityAwareOpencodeBasic
 *
 * 包装框架自带的 OpencodeBasicFeature，让它向 Claw continuity 协议自声明参与。
 *
 * 设计参照 ControlledTodoFeature：通过继承框架原 feature + declareContinuity 高阶函数
 * 添加 Claw 自有协议字段，框架本体零侵入。
 *
 * 包装后：
 * - readFiles 状态（先读后写保护机制所依赖的内部 Set）会在 trim/summary 时
 *   随 captureState 一起导出，新 runtime 启动时通过 restoreState 恢复，
 *   避免精简后会话内“先读后写”保护重置导致 write 工具被错误拦截。
 * - readDedupState（edit/write 的 mtime 基线）同样随快照接续：mtime 是
 *   文件系统事实，与旧上下文是否保留 Read 结果无关。trim 保留了读取结果的
 *   场景可直接编辑未被外部修改的文件；外部修改或记忆偏差由 staleness
 *   校验与 oldString 匹配失败兜底。
 * - 协议：claw.opencode-basic-continuity.v1（通用透传，无 schema 特化）
 */

import { OpencodeBasicFeature } from '@agentdevjs/core';
import {
  declareContinuity,
  OPENCODE_BASIC_CONTINUITY_PROTOCOL,
} from '../../continuity-participant/src/index.js';

export const ContinuityAwareOpencodeBasic = declareContinuity(OpencodeBasicFeature, {
  protocol: OPENCODE_BASIC_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});
