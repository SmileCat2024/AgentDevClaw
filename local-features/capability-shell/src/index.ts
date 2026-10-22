/**
 * Capability Shell 基座（ticket 033）
 *
 * Bash AST 预检 + 解释执行 + 展开后参数校验 + adapter 分派。
 * 每个领域 shell = 一份策略声明 + 若干 adapter；不开放系统 shell 执行。
 */

export type {
  CapabilityShellErrorCode,
  CapabilityShellPolicy,
  ShellSegment,
  ShellVerbDecl,
  ShellParamDecl,
  ShellParamKind,
  PipelineRejection,
  CapabilityShellAuditEvent,
} from './types.js';

// Bash AST parsing/validation; evaluation and expansion share the same interpreter.
export { parseBashProgram, BASH_SYNTAX_DESCRIPTION } from './bash-program.js';
export type { BashProgram, BashRejection } from './bash-program.js';

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
  runCollectedSpawn,
} from './dispatch.js';
export type {
  AdapterMap,
  InProcessAdapter,
  CommandResult,
  CommandExecution,
  SpawnRunResult,
} from './dispatch.js';

// 工具工厂与完整管线
export {
  createCapabilityShellTool,
  runCapabilityShellPipeline,
} from './tool-factory.js';
export type { CapabilityShellRunResult, CapabilityShellToolOptions } from './tool-factory.js';

// coder 领域 shell（ticket 034）：动词表 + threads adapter + feature 挂载
export {
  createThreadsAdapter,
  createThreadsAdapters,
} from './coder-shell.js';
export type { ThreadAdapter, ThreadAdapterContext, FetchLike } from './coder-shell.js';
export {
  CODER_SHELL_NAME,
  CODER_SHELL_DESCRIPTION,
  createCoderShellPolicy,
} from './coder-policy.js';
export {
  CapabilityShellFeature,
} from './coder-shell-feature.js';
export type { CapabilityShellFeatureConfig } from './coder-shell-feature.js';

// playwright 领域 shell（ticket 036）：动词表 + CLI adapter + feature 挂载
export {
  createPlaywrightAdapters,
} from './playwright/playwright-shell.js';
export type { PlaywrightAdaptersDeps, PlaywrightAdapterContext, BackendRunResult } from './playwright/playwright-shell.js';
export {
  PLAYWRIGHT_SHELL_NAME,
  PLAYWRIGHT_SHELL_DESCRIPTION,
  PLAYWRIGHT_ENV_FIX_GUIDANCE,
  createPlaywrightShellPolicy,
} from './playwright/playwright-policy.js';
export {
  PlaywrightShellFeature,
} from './playwright/playwright-shell-feature.js';
export type { PlaywrightShellFeatureConfig } from './playwright/playwright-shell-feature.js';
