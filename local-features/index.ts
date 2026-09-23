export { FeatureCommunicationClient } from './shared/src/feature-communication.js';
export { FeatureDevFeature } from './feature-dev/src/index.js';
export { AgentDevFeature } from './agent-dev/src/index.js';
export { AgentStudioFeature } from './agent-studio/src/index.js';
export { FlowFeature, FlowAwareFeature } from './flow/src/index.js';
export { ContextCompactionMirrorFeature } from './context-compaction-mirror/src/index.js';
export { ContextGuardFeature, ContextRotationTriggerFeature } from './context-guard/src/index.js';
export { ClawDispatchFeature } from './dispatch/src/index.js';
export { CheckpointFeature } from './checkpoint/src/index.js';
export { GenerativeUISurfaceFeature } from './generative-ui/src/index.js';
export { GitHubShellFeature } from './github/src/index.js';
export { createGitHubShellPolicy, createGitHubShellAdapters, GITHUB_SHELL_NAME } from './github/src/github-shell.js';
export { SessionReferenceFeature } from './session-reference/src/index.js';
export { ShellBgCommsFeature } from './shell-bg-comms/src/index.js';
export {
  createCapabilityShellTool,
  runCapabilityShellPipeline,
} from './capability-shell/src/index.js';
