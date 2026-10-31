/**
 * 嵌套启动 env 剥离（ADR-0037 M4，修 M1 遗留开放点）。
 *
 * 在托管 runtime 内再启动 Claw server（嵌套实例）时，宿主 runtime 注入的专属
 * env 会短路 per-instance 派生（AGENTDEV_UDS_PATH 的 explicit 分支抢全局管道，
 * 隔离实例会抢占父平台的默认管道）并把宿主会话身份泄漏给嵌套平台的 spawn。
 * 检测到嵌套特征（PROTOCLAW_PREBUILT_AGENT_ID 存在 = 本进程自身跑在托管
 * runtime 内）时剥离这些键；正常启动与显式注入路径（如 pack:desktop 冒烟显式
 * 设 UDS 路径）无嵌套特征，行为不变。
 */
const NESTED_RUNTIME_ENV_KEYS = [
  // 平台寻址（短路 per-instance UDS / TCP 派生）
  'AGENTDEV_UDS_PATH',
  'AGENTDEV_VIEWER_ADDR',
  'AGENTDEV_VIEWER_ORIGIN',
  // 宿主 runtime 的会话身份与装配形态（不得泄漏给嵌套平台的 runtime spawn）
  'PROTOCLAW_PREBUILT_AGENT_ID',
  'PROTOCLAW_PREBUILT_SESSION_ID',
  'PROTOCLAW_SESSION_WORKSPACE_CWD',
  'PROTOCLAW_SESSION_TYPE',
  'PROTOCLAW_GC_CHAT_ID',
  'PROTOCLAW_MODEL_PRESET_ROLE',
  'PROTOCLAW_HANDOFF_PATH',
  'PROTOCLAW_HANDOFF_PAYLOAD',
  'PROTOCLAW_ASSEMBLY_RUNTIME',
  'PROTOCLAW_ASSEMBLY_WORKSPACE',
];

export function stripNestedRuntimeEnv(env) {
  if (!env?.PROTOCLAW_PREBUILT_AGENT_ID) return env;
  const copy = { ...env };
  for (const key of NESTED_RUNTIME_ENV_KEYS) {
    delete copy[key];
  }
  return copy;
}
