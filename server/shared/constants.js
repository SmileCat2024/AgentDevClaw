import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// server/shared/constants.js → 向上 2 级到项目根
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const rootRequire = createRequire(path.join(PROJECT_ROOT, 'package.json'));
export const APP_PORT = Number.parseInt(process.env.PORT || '1420', 10);
export const VIEWER_PORT = Number.parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
export const AGENTS_ROOT = path.join(PROJECT_ROOT, 'prebuilt-agents');
export const RUNTIME_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-prebuilt-agent.js');
export const ONE_SHOT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-one-shot-agent.js');
export const AGENTDEV_ROOT = path.resolve(PROJECT_ROOT, '..', 'AgentDev');
export const AGENTDEV_CREATE_FEATURE_CLI = path.join(AGENTDEV_ROOT, 'dist', 'create-feature-cli.js');
export const VIEWER_ORIGIN = `http://127.0.0.1:${VIEWER_PORT}`;
export const USER_DATA_ROOT = path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
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
export const MIRROR_SCRIPT_TIMEOUT_MS   = 120000;   // summary / title / recap mirror 进程超时
export const SPAWN_AGENT_TIMEOUT_MS     = 300000;   // spawn one-shot / resume sub-agent 默认超时
export const CALL_EXECUTION_TIMEOUT_MS  = 300000;   // call 执行默认超时
export const SHELL_DEFAULT_TIMEOUT_MS   = 5 * 60 * 1000; // Shell 命令默认超时
export const GROUP_CHAT_CALL_TIMEOUT_MS = 15 * 60 * 1000; // 群聊管理员调用超时
export const DISPATCH_FIRED_TIMEOUT_MS  = 5 * 60 * 1000;  // fired schedule 超时阈值
export const PROCESS_EXIT_WAIT_MS       = 5000;    // 子进程退出等待
export const RUNTIME_READY_WAIT_MS      = 10000;   // runtime READY 等待超时
export const ASSEMBLY_EXIT_WAIT_MS      = 2500;     // assembly runtime 退出等待
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
