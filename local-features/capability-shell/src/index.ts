/**
 * Capability Shell 基座（ticket 033）
 *
 * 管线四道检查点（语法验收 / 结构分段 / 逐段动词校验 / 参数校验）+
 * bash 形态工具工厂 + adapter 分派。每个领域 shell = 一份策略声明 +
 * 若干 adapter 映射；边界 = 管线确定性拒绝，不是沙箱。
 */

export type {
  CapabilityShellErrorCode,
  CapabilityShellPolicy,
  ShellSegment,
  ShellRedirect,
  ShellVerbDecl,
  ShellParamDecl,
  ShellParamKind,
  PipelineRejection,
  CapabilityShellAuditEvent,
} from './types.js';

// 第一道：语法验收（唯一非纯函数道）
export { checkSyntax, findBashPath, resolveBashForSyntaxCheck } from './syntax.js';
export type { SyntaxCheckOptions, SyntaxCheckResult } from './syntax.js';

// 第二道：结构分段 + v1 拒绝特征
export {
  checkStructure,
  containsGlob,
  containsDollarOutsideSingleQuotes,
} from './structure.js';
export type { StructureCheckResult } from './structure.js';

// 第三道：逐段动词校验
export { checkVerbs, listVerbs } from './verbs.js';
export type { VerbCheckResult } from './verbs.js';

// 第四道：参数校验
export {
  checkArgs,
  validateParamValue,
  isAbsoluteLike,
  escapesWorkspace,
} from './args.js';
export type { ParamCheckResult } from './args.js';

// 分派层
export {
  dispatchPipeline,
  runCollectedSpawn,
} from './dispatch.js';
export type {
  AdapterMap,
  InProcessAdapter,
  DispatchSegment,
  DispatchOptions,
  DispatchResult,
  SpawnRunResult,
} from './dispatch.js';

// 工具工厂与完整管线
export {
  createCapabilityShellTool,
  runCapabilityShellPipeline,
} from './tool-factory.js';
export type { CapabilityShellRunResult, CapabilityShellToolOptions } from './tool-factory.js';
