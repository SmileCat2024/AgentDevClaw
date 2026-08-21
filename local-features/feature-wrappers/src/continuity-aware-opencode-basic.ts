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
 * - readDedupState 不参与接续，因为当前上下文不含旧 Read 工具结果，
 *   新 runtime 必须能重新读取文件正文。
 * - 协议：claw.opencode-basic-continuity.v1（由 Claw 协议层投影 readFiles）
 */

import { OpencodeBasicFeature } from '@agentdev/core';
import {
  declareContinuity,
  OPENCODE_BASIC_CONTINUITY_PROTOCOL,
} from '../../continuity-participant/src/index.js';

export const ContinuityAwareOpencodeBasic = declareContinuity(OpencodeBasicFeature, {
  protocol: OPENCODE_BASIC_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});
