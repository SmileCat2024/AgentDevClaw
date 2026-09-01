import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// server/shared/constants.js → 向上 2 级到项目根
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const rootRequire = createRequire(path.join(PROJECT_ROOT, 'package.json'));
export const APP_PORT = Number.parseInt(process.env.PORT || '1420', 10);
export const VIEWER_PORT = Number.parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
export const REMOTE_CONNECTION_PORT_RANGE = Object.freeze({ min: 22100, max: 22199 });
export const AGENTS_ROOT = path.join(PROJECT_ROOT, 'prebuilt-agents');
export const RUNTIME_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-prebuilt-agent.js');
export const ONE_SHOT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-one-shot-agent.js');
export const AGENTDEV_ROOT = path.resolve(PROJECT_ROOT, '..', 'AgentDev');
export const AGENTDEV_CREATE_FEATURE_CLI = path.join(
  PROJECT_ROOT, 'node_modules', '@agentdevjs', 'create-feature', 'dist', 'cli.js'
);
export const VIEWER_ORIGIN = `http://127.0.0.1:${VIEWER_PORT}`;
// 数据根目录解析：AGENTDEV_DATA_DIR 仅用于多实例/测试场景（如本地双实例验证），
// 未设置时保持 ~/.agentdev/AgentDevClaw 不变。所有进程入口（server、scripts、
// 预制 agent、claw CLI）一律经由本函数解析，保证同一环境变量语义全局一致。
export function resolveUserDataDir(env = process.env) {
  const override = typeof env.AGENTDEV_DATA_DIR === 'string' ? env.AGENTDEV_DATA_DIR.trim() : '';
  return override ? path.resolve(override) : path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
}

// 实例唯一的 ViewerWorker IPC 管道名。默认管道是全局固定名，同机多实例
// （AGENTDEV_DATA_DIR 隔离数据目录时）必须各自派生独立管道，否则后启动实例的
// 运行时会注册进先启动实例的 ViewerWorker（已实测发生）。仅在解析结果为
// Claw 默认数据根时沿用历史全局名，保证既有单实例行为零变化。
export function resolveInstanceUdsPath(env = process.env) {
  const explicit = typeof env.AGENTDEV_UDS_PATH === 'string' ? env.AGENTDEV_UDS_PATH.trim() : '';
  if (explicit) return explicit;
  const legacy = process.platform === 'win32'
    ? '\\\\.\\pipe\\agentdev-viewer'
    : '/tmp/agentdev-viewer.sock';
  const dataRoot = resolveUserDataDir(env);
  if (dataRoot === path.join(os.homedir(), '.agentdev', 'AgentDevClaw')) return legacy;
  const suffix = crypto.createHash('sha1').update(dataRoot).digest('hex').slice(0, 10);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentdev-viewer-${suffix}`
    : `/tmp/agentdev-viewer-${suffix}.sock`;
}

export const USER_DATA_ROOT = resolveUserDataDir();
export const REMOTE_CONNECTIONS_CONFIG_PATH = path.join(USER_DATA_ROOT, 'remote-connections.json');
export const NO_SESSION_TOKEN = '__protoclaw-no-session__';
export const PREBUILT_SESSIONS_ROOT = path.join(USER_DATA_ROOT, 'prebuilt-sessions');
export const PREBUILT_WORKSPACES_ROOT = path.join(USER_DATA_ROOT, 'workspaces');
export const PROJECT_QQBOT_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'qqbot.config.json');
export const PROJECT_WEIXIN_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'weixin-bot.config.json');
export const PROJECT_FEISHU_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'feishu-bot.config.json');
export const PROJECT_WECOM_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'wecom-bot.config.json');
export const PROJECT_ROKID_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'rokid.config.json');
export const PROJECT_IM_WORKSPACE_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'im-workspace.config.json');
export const FEATURE_REPOSITORY_ROOT = path.join(PROJECT_ROOT, 'resources', 'features');
export const USER_FEATURE_REPOSITORY_ROOT = path.join(USER_DATA_ROOT, 'user-features');
export const AGENT_RUNTIME_ENVS_ROOT = path.join(USER_DATA_ROOT, 'runtime-envs');
export const USER_AGENT_REGISTRY_PATH = path.join(USER_DATA_ROOT, 'agent-registry.json');
export const FEATURE_MANIFEST_NAME = 'agentdev-feature.json';
export const GROUP_CHATS_ROOT = path.join(USER_DATA_ROOT, 'group-chats');
export const THREADS_ROOT = path.join(USER_DATA_ROOT, 'threads');
export const WORKSPACE_SESSION_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'agent-studio', 'programming-helper', 'flow-workspace']);
// PH 风格工作区（项目列表 / 会话列表首页 / 空表单会话）：programming-helper 与 coder（线程版编程助手）
export const PH_STYLE_WORKSPACE_AGENT_IDS = new Set(['programming-helper']);
// Hidden workspaces remain discoverable by their stable ID for historical sessions and explicit routes.
export const HIDDEN_PREBUILT_AGENT_IDS = new Set(['agent-creator', 'feature-creator', 'flow-test', 'work-group']);
export const PROJECT_DOCSET_SUBPATH = path.join('.agentdev', 'claw-workspace');
export const MODEL_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'default.json');
export const MODEL_PRESETS_PATH = path.join(PROJECT_ROOT, 'config', 'presets.json');
export const MCP_GATEWAY_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'mcp-gateway.json');
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

// ── Timeout / Wait (ms) ──────────────────────────────────────────
export const MIRROR_SCRIPT_TIMEOUT_MS   = 120000;   // title / recap mirror 进程超时
export const SESSION_TRANSFORMATION_TIMEOUT_MS = 300000; // in-process summary / trim+summary overall timeout
export const SPAWN_AGENT_TIMEOUT_MS     = 300000;   // spawn one-shot / resume sub-agent 默认超时
export const CALL_EXECUTION_TIMEOUT_MS  = 300000;   // call 执行默认超时
export const SHELL_DEFAULT_TIMEOUT_MS   = 5 * 60 * 1000; // Shell 命令默认超时
export const GROUP_CHAT_CALL_TIMEOUT_MS = 15 * 60 * 1000; // 群聊管理员调用超时
export const DISPATCH_FIRED_TIMEOUT_MS  = 5 * 60 * 1000;  // fired schedule 超时阈值
export const PROCESS_EXIT_WAIT_MS       = 5000;    // 子进程退出等待
export const RUNTIME_READY_WAIT_MS      = 10000;   // runtime READY 等待超时
export const ASSEMBLY_EXIT_WAIT_MS      = 2500;     // assembly runtime 退出等待
export const TUNNEL_RECONNECT_INITIAL_MS = 1000;    // managed SSH 首次重连退避
export const TUNNEL_RECONNECT_MAX_MS     = 30000;   // managed SSH 重连退避上限
export const TUNNEL_STDERR_TAIL_LINES   = 20;      // managed SSH stderr 诊断尾部
export const REMOTE_HANDSHAKE_INTERVAL_MS = 5000;  // 远程连接周期握手间隔（秒级，对齐前端轮询量级）
export const REMOTE_HANDSHAKE_TIMEOUT_MS  = 3000;  // 握手单请求超时（间隔+超时 < 10s 收敛预算）
export const REMOTE_CONNECTION_FAILURE_THRESHOLD = 2;  // 慢断快收：连续可重试失败达此次数才呈现断线（握手状态机与目录聚合共用）
export const IM_IPC_MOUNT_RETRY_MS      = 1500;    // IM carrier IPC mount 重试延迟
export const WORKSPACE_CACHE_TTL_MS     = 5000;    // workspace 数据内存缓存 TTL
export const REQ_TIMEOUT_BUFFER_MS      = 10000;   // req.setTimeout 的额外 buffer

// ── Long-poll parameters ─────────────────────────────────────────
export const LONG_POLL_DEFAULT_SEC = 25;   // long-poll 默认等待秒数
export const LONG_POLL_MAX_SEC     = 30;   // long-poll 上限秒数

// ── Call arbiter continuation budget ─────────────────────────────
export const CONTINUATION_BUDGET = {
  maxSegments: 20,
  maxCheckpoints: 5,
  maxRollbacks: 3,
};

// ── LLM limits ───────────────────────────────────────────────────
export const PREBUILT_AGENT_MAX_TOKENS_CAP = 8000; // 预制 agent / mirror runtime maxTokens 上限
export const DEFAULT_COMPRESS_RATIO = 80;          // 上下文压缩触发比例默认值

// ── Dispatch defaults ────────────────────────────────────────────
export const DISPATCH_IDLE_THRESHOLD_DEFAULT_SEC = 300; // idle 触发默认阈值（秒）
export const DISPATCH_IDLE_POLL_MIN_MS           = 5000; // idle 检测最小轮询间隔

// ── Usage ledger ─────────────────────────────────────────────────
export const USAGE_MAX_INDEX_IDS = 20000;

// ── Session search ───────────────────────────────────────────────
export const SESSION_SEARCH_MAX_RESULTS = 50;
export const SESSION_INDEX_BATCH_SIZE   = 10;
