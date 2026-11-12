/**
 * IM 门户代理 Agent - Claw 官方实现
 *
 * 管理 IM 线路连接、接线转接，作为消息的入口网关。
 * 通过 QQ/微信等渠道与用户交互，可将线路动态转接到任意工作空间会话。
 */

import { BasicAgent, TemplateComposer, TodoFeature } from '@agentdevjs/core';
import { QQBotFeature } from '@agentdevjs/qqbot-feature';
import { WeixinBot, WeixinApiClient } from '@agentdevjs/weixin-bot';
import { FeishuBot } from '@agentdevjs/feishu-bot';
import { WecomBot } from '@agentdevjs/wecom-bot';
import { RokidBot } from '@agentdevjs/rokid-bot';
import { ShellFeature } from '@agentdevjs/shell-feature';
import { WebSearchFeature } from '@agentdevjs/websearch-feature';
import { ImageReaderFeature } from '@agentdevjs/image-reader-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { ClawDispatchFeature } from '../../../local-features/dist/dispatch/src/index.js';
import { ConversationExportFeature } from '../../../local-features/dist/conversation-export/src/index.js';
import { createPortalLines } from './portal-lines.js';
import { TimeAwarenessFeature } from '../../../local-features/dist/time-awareness/src/index.js';
import { ModelSelectionFeature } from '../../../local-features/dist/model-selection/src/index.js';
import { getIMChannelLabel } from '../../../server/shared/im-channels.js';
import { resolveUserDataDir, APP_QQBOT_CONFIG_PATH, APP_WEIXIN_CONFIG_PATH, APP_ROKID_CONFIG_PATH, APP_IM_WORKSPACE_CONFIG_PATH } from '../../../server/shared/constants.js';
import { internalAuthHeaders } from '../../../server/shared/internal-auth.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const SERVER_ORIGIN = `http://127.0.0.1:${process.env.PORT || 14200}`;

// IM 接线员工具的渲染模板资产随 local-features 构建（dist/templates/im-*.render.js），
// 经 IMOperatorFeature.getTemplateNames() 声明后由 ViewerWorker 以 /res/ 资源 URL（ADR-0038）提供。
const LOCAL_FEATURES_ROOT = join(dirname(dirname(dirname(__dirname))), 'local-features');

// 数据根同源解析（server/shared/constants.js），支持 AGENTDEV_DATA_DIR 多实例隔离
const USER_DATA_ROOT = resolveUserDataDir();
const SYSTEM_FEATURE_CONFIG_PATH = join(USER_DATA_ROOT, 'feature-setup.json');
const IMAGE_STORAGE_DIR = join(USER_DATA_ROOT, 'images');

function readSystemFeatureConfig() {
  if (!existsSync(SYSTEM_FEATURE_CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(SYSTEM_FEATURE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const DEFAULT_QQBOT_CONFIG_PATH = APP_QQBOT_CONFIG_PATH;
const DEFAULT_WEIXIN_CONFIG_PATH = APP_WEIXIN_CONFIG_PATH;
const DEFAULT_ROKID_CONFIG_PATH = APP_ROKID_CONFIG_PATH;
const DEFAULT_IM_WORKSPACE_CONFIG_PATH = APP_IM_WORKSPACE_CONFIG_PATH;

function resolveQQBotConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_QQBOT_CONFIG_PATH;
}

function resolveWeixinConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_WEIXIN_CONFIG_PATH;
}

function resolveRokidConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_ROKID_CONFIG_PATH;
}

function resolveIMWorkspaceConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_IM_WORKSPACE_CONFIG_PATH;
}

function readIMWorkspaceConfig(configPath) {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const channels = raw && typeof raw.channels === 'object' && raw.channels ? raw.channels : {};
    // ADR-0042：线路统一线程寻址。接线员线路 = boundTarget 指向 operatorThreadId
    // 的线路；门户渠道 = 接线员线路的 carrier（selectedChannel 已并入线路模型，
    // 此处读到旧字段会被忽略——配置经 server 归一化写盘后残留自然消失）。
    const operatorThreadId = typeof raw.operatorThreadId === 'string' ? raw.operatorThreadId.trim() : '';
    const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
    const operatorLines = operatorThreadId
      ? rawLines.filter((l) => l && typeof l === 'object'
        && l.boundTarget && l.boundTarget.agentId === 'qqbot'
        && typeof l.boundTarget.threadId === 'string'
        && l.boundTarget.threadId.trim() === operatorThreadId)
      : [];
    const operatorCarrier = (operatorLines.find((l) => typeof l.carrier === 'string' && l.carrier.trim()) || {}).carrier || '';
    return {
      operatorThreadId,
      operatorCarrier: operatorCarrier.trim(),
      lines: rawLines,
      channels,
    };
  } catch {
    return {
      operatorThreadId: '',
      operatorCarrier: '',
      lines: [],
      channels: {},
    };
  }
}

// ── IM Operator Feature ──────────────────────────────────────────────────
//
// 接线员 Feature：门户代理通过此 Feature 管理 IM 线路连接。
// 所有操作通过 HTTP 调用 server.js API，并发安全由服务端保证。

class IMOperatorFeature {
  constructor() {
    this.name = 'im-operator';
  }

  getPackageInfo() {
    // 模板资产的包根与版本随 local-features/package.json（读真实文件，避免版本漂移）
    try {
      const pkg = JSON.parse(readFileSync(join(LOCAL_FEATURES_ROOT, 'package.json'), 'utf8'));
      return { name: pkg.name || 'agentdevclaw-local-features', version: pkg.version, root: LOCAL_FEATURES_ROOT };
    } catch {
      return { name: 'agentdevclaw-local-features', version: '0.0.0', root: LOCAL_FEATURES_ROOT };
    }
  }

  getTemplateNames() {
    return ['im-overview', 'im-browse', 'im-line', 'upload-attachment'];
  }

  static nowStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${weekday} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  getTools() {
    return [
      {
        name: 'im_overview',
        parallelizable: true,
        render: { call: 'im-overview', result: 'im-overview' },
        description: '查看所有 IM 线路的当前状态。返回每条线路的载体（QQ/微信）和绑定会话信息。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          try {
            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_routable_targets`, { headers: internalAuthHeaders() });
            if (!resp.ok) return { error: `服务端返回 ${resp.status}` };
            const data = await resp.json();
            const lines = data.lines || [];
            const now = IMOperatorFeature.nowStr();
            if (lines.length === 0) {
              return { text: `当前没有配置任何 IM 线路。\n（当前时间: ${now}）`, lines: [] };
            }
            const fmtAgo = (ms) => {
              if (!ms) return '?';
              const diff = Date.now() - ms;
              if (diff < 60_000) return '刚刚';
              if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
              if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
              return `${Math.floor(diff / 86_400_000)}天前`;
            };
            // ADR-0042 决策 1：线路投影为 boundThread（线程寻址）。运行时状态
            // 在 im_browse 的线程投影里给出，线路摘要只报绑定事实与线程状态。
            const summary = lines.map(l => {
              const carrierLabel = l.carrier ? getIMChannelLabel(l.carrier) : '未配置';
              const bound = l.boundThread;
              if (!bound) {
                return `- **${l.name}** [${carrierLabel}]: 空闲（未连接）`;
              }
              const lastActive = fmtAgo(bound.updatedAt);
              const statusLabel = bound.status === 'closed' ? '已关闭' : '进行中';
              return (
                `- **${l.name}** [${carrierLabel}]: 已连接 → ${bound.threadTitle || bound.threadId} (${bound.agentId})\n` +
                `  线程状态: ${statusLabel} | 最后活动: ${lastActive} | threadId: ${bound.threadId}`
              );
            });
            return {
              text: `当前 IM 线路状态（${now}）：\n${summary.join('\n')}`,
              lines,
            };
          } catch (err) {
            return { error: `查询失败: ${err.message}` };
          }
        },
      },
      {
        name: 'im_browse',
        parallelizable: true,
        render: { call: 'im-browse', result: 'im-browse' },
        description: '列出所有可连接的线程。按工作空间分组返回非终态线程（含模型、运行状态、最后活动时间），以及 im_connect_line 所需的 agentId 和 threadId。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          try {
            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_routable_targets`, { headers: internalAuthHeaders() });
            if (!resp.ok) return { error: `服务端返回 ${resp.status}` };
            const data = await resp.json();
            const workspaces = data.workspaces || [];
            if (workspaces.length === 0) {
              return { text: '当前没有可连接的线程。', sessions: [] };
            }
            const fmtAgo = (ms) => {
              if (!ms) return '?';
              const diff = Date.now() - ms;
              if (diff < 60_000) return '刚刚';
              if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
              if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
              return `${Math.floor(diff / 86_400_000)}天前`;
            };
            const execLabel = (s) => {
              if (s === 'running') return '忙（处理中）';
              if (s === 'queued') return '排队中';
              return '空闲';
            };
            const lines = [];
            const flatSessions = [];
            // ADR-0042 决策 1：可绑目标是线程（workspaces[].threads），不再是
            // 「项目 → 运行中会话」。运行时状态按 head 会话投影给出。
            for (const ws of workspaces) {
              for (const thread of (ws.threads || [])) {
                const model = thread.modelName || '未知';
                const exec = execLabel(thread.execStatus);
                const lastActive = fmtAgo(thread.updatedAt);
                lines.push(
                  `- 工作空间: ${ws.agentName} | agentId: ${ws.agentId}\n` +
                  `  线程: ${thread.title} | threadId: ${thread.threadId}\n` +
                  `  状态: ${exec} | 线程状态: ${thread.status === 'closed' ? '已关闭' : '进行中'} | 最后活动: ${lastActive}\n` +
                  `  模型: ${model} | head 会话: ${thread.headSessionId}`
                );
                flatSessions.push({
                  agentId: ws.agentId,
                  agentName: ws.agentName,
                  threadId: thread.threadId,
                  title: thread.title,
                  headSessionId: thread.headSessionId,
                  status: thread.status,
                  modelName: model,
                  execStatus: thread.execStatus ?? null,
                  updatedAt: thread.updatedAt ?? null,
                });
              }
            }
            return {
              text: `可连接的线程（${IMOperatorFeature.nowStr()}）：\n${lines.join('\n')}\n\n使用 im_connect_line 并传入 lineId、agentId、threadId 即可接线。`,
              sessions: flatSessions,
            };
          } catch (err) {
            return { error: `浏览失败: ${err.message}` };
          }
        },
      },
      {
        name: 'im_connect_line',
        render: { call: 'im-line', result: 'im-line' },
        description: '将指定线路连接到目标线程。连接后该线路的 IM 消息将由目标线程处理，线程接续时绑定不失效。先用 im_overview 获取 lineId，用 im_browse 获取 agentId 和 threadId。',
        parameters: {
          type: 'object',
          properties: {
            lineId: { type: 'string', description: '线路 ID，来自 im_overview 返回的 lines[].id（如 line1、line2）' },
            agentId: { type: 'string', description: '目标工作空间 ID，来自 im_browse 返回的 agentId（如 programming-helper）' },
            threadId: { type: 'string', description: '目标线程 ID，来自 im_browse 返回的 threadId' },
          },
          required: ['lineId', 'agentId', 'threadId'],
        },
        execute: async (args) => {
          const { lineId, agentId, threadId } = args || {};
          if (!lineId || !agentId || !threadId) {
            return { error: '参数不完整，需要 lineId、agentId、threadId。' };
          }
          try {
            const targetsResp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_routable_targets`, { headers: internalAuthHeaders() });
            if (!targetsResp.ok) return { error: `查询线路状态失败: ${targetsResp.status}` };
            const targets = await targetsResp.json();
            const line = (targets.lines || []).find(l => l.id === lineId);
            if (!line) return { error: `未找到线路 "${lineId}"。` };
            if (!line.carrier) return { error: `线路 "${line.name}" 未配置载体（QQ/微信），无法连接。` };

            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_line_transfer`, {
              method: 'POST',
              headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ lineId, carrier: line.carrier, agentId, threadId }),
            });
            const result = await resp.json();
            if (!resp.ok) {
              return { error: result.error || `连接失败 (${resp.status})` };
            }
            return { text: `线路「${line.name}」已连接到线程 ${threadId}（${agentId}）。\n（操作时间: ${IMOperatorFeature.nowStr()}）`, success: true };
          } catch (err) {
            return { error: `连接失败: ${err.message}` };
          }
        },
      },
      {
        name: 'im_disconnect_line',
        render: { call: 'im-line', result: 'im-line' },
        description: '断开指定线路的当前连接。',
        parameters: {
          type: 'object',
          properties: {
            lineId: { type: 'string', description: '线路 ID' },
          },
          required: ['lineId'],
        },
        execute: async (args) => {
          const { lineId } = args || {};
          if (!lineId) return { error: '需要指定 lineId。' };
          try {
            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_line_disconnect`, {
              method: 'POST',
              headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ lineId }),
            });
            const result = await resp.json();
            if (!resp.ok) {
              return { error: result.error || `断开失败 (${resp.status})` };
            }
            return { text: `线路已断开。\n（操作时间: ${IMOperatorFeature.nowStr()}）`, success: true };
          } catch (err) {
            return { error: `断开失败: ${err.message}` };
          }
        },
      },
    ];
  }
}

/**
 * IM 门户代理 Agent
 *
 * 管理 IM 线路连接与消息路由，通过接线员工具控制线路转接。
 * 继承 BasicAgent 获得所有基础设施能力。
 */
export class QQBotProgrammingHelperAgent extends BasicAgent {
  qqbotFeature;
  weixinBotFeature;
  imWorkspaceConfigPath;
  _callArbiter = null;
  /** ADR-0042 决策 2：线路状态按线路记账，由 _portalLines 持有；
   *  单值 _activeIMChannel / _lastIMTarget 已退役（多线路并发会互相覆盖）。 */
  _portalLines = null;

  constructor(config = {}) {
    const systemConfig = readSystemFeatureConfig();

    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...systemConfig,
      },
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
    const workspaceDir = config.workspaceDir || process.cwd();
    this.imWorkspaceConfigPath = resolveIMWorkspaceConfigPath(config.imWorkspaceConfigPath);

    // BasicAgent 已纯基类化（a5fe117 / ticket 009），不再自动挂载 SubAgentFeature，
    // 无需再 removeFeature('subagent')。

    // ClawDispatchFeature 始终挂载，主模式与探索模式都需要接收调度消息
    this.use(new ClawDispatchFeature());

    // 会话级模型选择（ADR-0034）：会话视图输入框切换控件的后端
    //（feature-comms selection 通道；IM 线路不经输入框，装配无副作用）。
    this.use(new ModelSelectionFeature({
      agentId: config.runtime?.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'qqbot',
      sessionId: config.runtime?.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID ?? '',
      serverOrigin: config.runtime?.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:14200',
    }));

    // 时间感知：CallStart 按节奏注入系统时间（>4h 未汇报才汇报），距上一轮
    // call >24h 时额外提示长间隔。主/探索模式都需要，状态经框架会话快照
    // （captureState）持久化。
    this.use(new TimeAwarenessFeature());

    if (isExploration) {
      this.use(new WebSearchFeature());
      this.use(new ShellFeature({ workspaceDir }));
      this.use(new ImageReaderFeature({ workspaceDir, storageDir: IMAGE_STORAGE_DIR }));
    } else {
      // 主模式：IM 门户代理能力
      this.qqbotFeature = new QQBotFeature({
        appId: config.appId,
        clientSecret: config.clientSecret,
        configPath: resolveQQBotConfigPath(config.qqbotConfigPath),
        accountId: config.accountId,
        markdownSupport: config.markdownSupport,
      });
      this.use(this.qqbotFeature);

      this.weixinBotFeature = new WeixinBot({
        configPath: resolveWeixinConfigPath(config.weixinConfigPath),
      });
      this.use(this.weixinBotFeature);

      this.feishuBotFeature = new FeishuBot({});
      this.use(this.feishuBotFeature);

      this.wecomBotFeature = new WecomBot({});
      this.use(this.wecomBotFeature);

      this.rokidBotFeature = new RokidBot({
        configPath: resolveRokidConfigPath(config.rokidConfigPath),
      });
      this.use(this.rokidBotFeature);

      this.use(new TodoFeature({
        reminderTemplate: TODO_REMINDER_PROMPT_PATH,
        reminderThresholdWithTasks: config.reminderThresholdWithTasks,
        reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
      }));

      this.use(new WebSearchFeature());
      this.use(new ShellFeature({ workspaceDir }));
      this.use(new ImageReaderFeature({ workspaceDir, storageDir: IMAGE_STORAGE_DIR }));
      this.use(new IMOperatorFeature());
      this.use(new ConversationExportFeature());

      // ADR-0042 决策 2：门户线路运行时——多线路并发连接、按线路入站分发、
      // 轮次事件出站。构造期只装配依赖，连接在 startPortalLines 里按配置对账。
      this._portalLines = createPortalLines({
        agent: this,
        serverOrigin: SERVER_ORIGIN,
        portalAgentId: config.runtime?.agentId
          || process.env.PROTOCLAW_PREBUILT_AGENT_ID
          || 'qqbot',
        logger: (message, level) => {
          if (level === 'error') console.error(`[PortalAgent] ${message}`);
          else if (level === 'warn') console.warn(`[PortalAgent] ${message}`);
          else console.log(`[PortalAgent] ${message}`);
        },
      });
    }
  }

  setCallArbiter(arbiter) {
    this._callArbiter = arbiter;
  }

  /** 当前门户线路运行时（懒建于首次启动，见 startPortalLines）。 */
  getPortalLines() {
    return this._portalLines;
  }

  /**
   * 启动门户 IM 线路（ADR-0042 决策 2/3/4）。
   *
   * 门户持有全部线路的平台连接，不再向目标 runtime 挂载体。启动即按配置
   * 对账：连上每条配了 carrier 的线路，随后开始订阅线程轮次事件作为出站
   * 通道。返回已连接的 carrier 列表（空数组表示没有任何线路配置）。
   */
  async startPortalLines() {
    if (!this._portalLines) return [];
    const config = readIMWorkspaceConfig(this.imWorkspaceConfigPath);
    const lines = (config.lines || []).filter((l) => l && String(l.carrier || '').trim());
    if (lines.length === 0) {
      console.log('[PortalAgent] 无已配置渠道的线路，跳过 Gateway 启动（仅调试模式运行）');
      return [];
    }
    const { connected } = await this._portalLines.syncLines(lines);
    this._portalLines.startOutboundListener();
    const carriers = connected.map((c) => c.carrier);
    console.log(`[PortalAgent] 门户线路已启动: ${carriers.join(', ') || 'none'}`);
    return carriers;
  }

  /**
   * 运行期线路变更后的对账入口（改完配置调用）。只重连变化，已连线路的
   * 平台连接不重建。
   */
  async reloadPortalLines() {
    if (!this._portalLines) return null;
    const config = readIMWorkspaceConfig(this.imWorkspaceConfigPath);
    const lines = (config.lines || []).filter((l) => l && String(l.carrier || '').trim());
    const { connected } = await this._portalLines.syncLines(lines);
    this._portalLines.startOutboundListener();
    return connected;
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
    if (isExploration) {
      this.setSystemPrompt(new TemplateComposer()
        .add({ file: SYSTEM_PROMPT_PATH })
        .add('\n\n## 身份设定\n\n')
        .add('你是一个自主探索代理，被调度系统触发执行任务。请自主完成任务，不需要与用户对话。')
        .add('\n\n## WebSearch 能力\n\n')
        .add('你可以使用 `web_fetch` 获取网页原始内容。')
      );
      return;
    }

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
    );
  }

  /**
   * 在所有 Feature 工具注册完毕后调用。
   * 注册统一的 upload_attachment 工具，按当前活跃渠道委托执行。
   */
  async onFeatureToolsReady() {
    if (process.env.PROTOCLAW_SESSION_TYPE === 'exploration') return;
    if (!this.qqbotFeature || !this.weixinBotFeature) return;

    const qqUploadTool = this.qqbotFeature.getTools().find(t => t.name === 'upload_attachment');
    const wxUploadTool = this.weixinBotFeature.getTools().find(t => t.name === 'upload_attachment');
    const fsUploadTool = this.feishuBotFeature?.getTools().find(t => t.name === 'upload_attachment');
    const wcUploadTool = this.wecomBotFeature?.getTools().find(t => t.name === 'upload_attachment');
    this.tools.register({
      name: 'upload_attachment',
      render: { call: 'upload-attachment', result: 'upload-attachment' },
      description:
        '上传一个文件/图片/语音/视频作为附件。上传成功后，附件会在当前回复结束后自动发送给对方。' +
        '支持本地文件绝对路径和公网 URL。文件大小限制 20MB。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要发送的文件的本地绝对路径或公网 URL',
          },
          filename: {
            type: 'string',
            description: '文件名（可选，默认从路径中提取）',
          },
        },
        required: ['path'],
      },
      execute: async (args) => {
        // ADR-0042：多线路并发下不再有单一活跃渠道——按已连接的线路找可用
        // 的上传入口（QQ 是默认渠道，未连时仍回落它，与历史行为一致）。
        const connectedCarriers = (this._portalLines?.snapshot() || []).map((line) => line.carrier);
        if (connectedCarriers.includes('weixin') && wxUploadTool) {
          return wxUploadTool.execute(args);
        }
        if (connectedCarriers.includes('feishu') && fsUploadTool) {
          return fsUploadTool.execute(args);
        }
        if (connectedCarriers.includes('wecom') && wcUploadTool) {
          return wcUploadTool.execute(args);
        }
        if (qqUploadTool) {
          return qqUploadTool.execute(args);
        }
        return { error: '没有可用的 IM 渠道处理文件上传' };
      },
    }, 'portal-agent');
  }
}
