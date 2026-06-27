/**
 * IM 门户代理 Agent - Claw 官方实现
 *
 * 管理 IM 线路连接、接线转接，作为消息的入口网关。
 * 通过 QQ/微信等渠道与用户交互，可将线路动态转接到任意工作空间会话。
 */

import { BasicAgent, TemplateComposer, TodoFeature } from 'agentdev';
import { QQBotFeature } from '@agentdev/qqbot-feature';
import { WeixinBot, WeixinApiClient } from '@agentdev/weixin-bot';
import { FeishuBot } from '@agentdev/feishu-bot';
import { WecomBot } from '@agentdev/wecom-bot';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import { ClawDispatchFeature } from '../../../local-features/dist/dispatch/src/index.js';
import { ConversationExportFeature } from '../../../local-features/dist/conversation-export/src/index.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const SERVER_ORIGIN = `http://127.0.0.1:${process.env.PORT || 1420}`;

const SYSTEM_FEATURE_CONFIG_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'feature-setup.json');

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

const DEFAULT_QQBOT_CONFIG_CANDIDATES = [
  join(PROTOCLAW_ROOT, '.agentdev', 'qqbot.config.json'),
  join(PROTOCLAW_ROOT, '..', 'AgentDev', 'config', 'qqbot.config.json'),
];
const DEFAULT_WEIXIN_CONFIG_CANDIDATES = [
  join(PROTOCLAW_ROOT, '.agentdev', 'weixin-bot.config.json'),
];
const DEFAULT_IM_WORKSPACE_CONFIG_CANDIDATES = [
  join(PROTOCLAW_ROOT, '.agentdev', 'im-workspace.config.json'),
];

function resolveQQBotConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_QQBOT_CONFIG_CANDIDATES.find(path => existsSync(path));
}

function resolveWeixinConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_WEIXIN_CONFIG_CANDIDATES.find(path => existsSync(path)) || DEFAULT_WEIXIN_CONFIG_CANDIDATES[0];
}

function resolveIMWorkspaceConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_IM_WORKSPACE_CONFIG_CANDIDATES.find(path => existsSync(path)) || DEFAULT_IM_WORKSPACE_CONFIG_CANDIDATES[0];
}

function readIMWorkspaceConfig(configPath) {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const channels = raw && typeof raw.channels === 'object' && raw.channels ? raw.channels : {};
    const rawChannel = typeof raw.selectedChannel === 'string' ? raw.selectedChannel.trim() : '';
    const selectedChannel = rawChannel && channels[rawChannel] ? rawChannel : '';
    return {
      selectedChannel,
      receptionistSessionId: typeof raw.receptionistSessionId === 'string' ? raw.receptionistSessionId.trim() : '',
      channels,
    };
  } catch {
    return {
      selectedChannel: '',
      receptionistSessionId: '',
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
        description: '查看所有 IM 线路的当前状态。返回每条线路的载体（QQ/微信）和绑定会话信息。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          try {
            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_routable_targets`);
            if (!resp.ok) return { error: `服务端返回 ${resp.status}` };
            const data = await resp.json();
            const lines = data.lines || [];
            const now = IMOperatorFeature.nowStr();
            if (lines.length === 0) {
              return { text: `当前没有配置任何 IM 线路。\n（当前时间: ${now}）`, lines: [] };
            }
            const fmtTokens = (n) => n != null ? n.toLocaleString() : '?';
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
            const summary = lines.map(l => {
              const carrierLabel = l.carrier === 'qq' ? 'QQ' : l.carrier === 'weixin' ? '微信' : l.carrier === 'feishu' ? '飞书' : l.carrier === 'wecom' ? '企业微信' : '未配置';
              const bound = l.boundSession;
              if (!bound) {
                return `- **${l.name}** [${carrierLabel}]: 空闲（未连接）`;
              }
              const model = bound.modelName || '未知';
              const ctxPct = bound.contextUsagePct != null ? `${bound.contextUsagePct}%` : '?';
              const ctxDetail = bound.contextTokens != null && bound.contextLength
                ? `${fmtTokens(bound.contextTokens)}/${fmtTokens(bound.contextLength)}`
                : '?';
              const threshold = bound.compressRatio != null ? `${bound.compressRatio}%` : '?';
              const warn = bound.contextUsagePct != null && bound.compressRatio != null
                && bound.contextUsagePct >= bound.compressRatio ? ' ⚠️已达压缩阈值' : '';
              const exec = execLabel(bound.execStatus);
              const lastActive = fmtAgo(bound.savedAt);
              const workdirLine = bound.workdir ? `\n  工作目录: ${bound.workdir}` : '';
              return (
                `- **${l.name}** [${carrierLabel}]: 已连接 → ${bound.sessionTitle || bound.sessionId} (${bound.agentId})\n` +
                `  状态: ${exec} | 最后活动: ${lastActive}\n` +
                `  模型: ${model} | 上下文: ${ctxDetail} (${ctxPct}) | 压缩阈值: ${threshold}${warn}` +
                workdirLine
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
        description: '列出所有可连接的工作空间会话。返回每个工作空间下的项目和在线会话，包含模型名称、上下文用量、压缩阈值等运行时状态，以及 im_connect_line 所需的 agentId 和 sessionId。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          try {
            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_routable_targets`);
            if (!resp.ok) return { error: `服务端返回 ${resp.status}` };
            const data = await resp.json();
            const workspaces = data.workspaces || [];
            if (workspaces.length === 0) {
              return { text: '当前没有在线的工作空间会话。', sessions: [] };
            }
            const fmtTokens = (n) => n != null ? n.toLocaleString() : '?';
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
            for (const ws of workspaces) {
              for (const project of ws.projects) {
                for (const session of (project.runningSessions || [])) {
                  const model = session.modelName || '未知';
                  const ctxPct = session.contextUsagePct != null ? `${session.contextUsagePct}%` : '?';
                  const ctxDetail = session.contextTokens != null && session.contextLength
                    ? `${fmtTokens(session.contextTokens)}/${fmtTokens(session.contextLength)}`
                    : '?';
                  const threshold = session.compressRatio != null ? `${session.compressRatio}%` : '?';
                  const msgCount = session.messageCount != null ? session.messageCount : '?';
                  const warn = session.contextUsagePct != null && session.compressRatio != null
                    && session.contextUsagePct >= session.compressRatio ? ' ⚠️已达压缩阈值' : '';
                  const exec = execLabel(session.execStatus);
                  const lastActive = fmtAgo(session.savedAt);
                  const queueInfo = session.execQueueLength > 0 ? ` | 队列: ${session.execQueueLength}` : '';
                  const workdirLine = session.workdir ? `\n  工作目录: ${session.workdir}` : '';
                  lines.push(
                    `- 工作空间: ${ws.name} | agentId: ${ws.agentId}\n` +
                    `  会话: ${session.title} | sessionId: ${session.id}\n` +
                    `  状态: ${exec}${queueInfo} | 最后活动: ${lastActive}\n` +
                    `  模型: ${model} | 上下文: ${ctxDetail} (${ctxPct}) | 压缩阈值: ${threshold} | 消息数: ${msgCount}${warn}` +
                    workdirLine
                  );
                  flatSessions.push({
                    agentId: ws.agentId,
                    agentName: ws.name,
                    sessionId: session.id,
                    sessionTitle: session.title,
                    modelName: model,
                    contextTokens: session.contextTokens ?? null,
                    contextLength: session.contextLength ?? null,
                    contextUsagePct: session.contextUsagePct ?? null,
                    compressRatio: session.compressRatio ?? null,
                    messageCount: session.messageCount ?? null,
                    tokenUsage: session.tokenUsage ?? null,
                    sessionType: session.sessionType ?? null,
                    execStatus: session.execStatus ?? null,
                    execQueueLength: session.execQueueLength ?? 0,
                    workdir: session.workdir ?? null,
                    savedAt: session.savedAt ?? null,
                  });
                }
              }
            }
            return {
              text: `可连接的在线会话（${IMOperatorFeature.nowStr()}）：\n${lines.join('\n')}\n\n使用 im_connect_line 并传入 lineId、agentId、sessionId 即可接线。`,
              sessions: flatSessions,
            };
          } catch (err) {
            return { error: `浏览失败: ${err.message}` };
          }
        },
      },
      {
        name: 'im_connect_line',
        description: '将指定线路连接到目标会话。连接后该线路的 IM 消息将由目标会话处理。先用 im_overview 获取 lineId，用 im_browse 获取 agentId 和 sessionId。',
        parameters: {
          type: 'object',
          properties: {
            lineId: { type: 'string', description: '线路 ID，来自 im_overview 返回的 lines[].id（如 line1、line2）' },
            agentId: { type: 'string', description: '目标工作空间 ID，来自 im_browse 返回的 agentId（如 programming-helper）' },
            sessionId: { type: 'string', description: '目标会话 ID，来自 im_browse 返回的 sessionId' },
          },
          required: ['lineId', 'agentId', 'sessionId'],
        },
        execute: async (args) => {
          const { lineId, agentId, sessionId } = args || {};
          if (!lineId || !agentId || !sessionId) {
            return { error: '参数不完整，需要 lineId、agentId、sessionId。' };
          }
          try {
            const targetsResp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_routable_targets`);
            if (!targetsResp.ok) return { error: `查询线路状态失败: ${targetsResp.status}` };
            const targets = await targetsResp.json();
            const line = (targets.lines || []).find(l => l.id === lineId);
            if (!line) return { error: `未找到线路 "${lineId}"。` };
            if (!line.carrier) return { error: `线路 "${line.name}" 未配置载体（QQ/微信），无法连接。` };

            const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_line_transfer`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lineId, carrier: line.carrier, agentId, sessionId }),
            });
            const result = await resp.json();
            if (!resp.ok) {
              return { error: result.error || `连接失败 (${resp.status})` };
            }
            return { text: `线路「${line.name}」已连接到 ${agentId}::${sessionId}。\n（操作时间: ${IMOperatorFeature.nowStr()}）`, success: true };
          } catch (err) {
            return { error: `连接失败: ${err.message}` };
          }
        },
      },
      {
        name: 'im_disconnect_line',
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
              headers: { 'Content-Type': 'application/json' },
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
  _activeIMChannel = null;
  _lastIMTarget = null;

  constructor(config = {}) {
    const systemConfig = readSystemFeatureConfig();

    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...(systemConfig.shell ? { shell: systemConfig.shell } : {}),
      },
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
    this.imWorkspaceConfigPath = resolveIMWorkspaceConfigPath(config.imWorkspaceConfigPath);

    // 移除 BasicAgent 自动挂载的 SubAgentFeature
    this.removeFeature('subagent');

    // ClawDispatchFeature 始终挂载，主模式与探索模式都需要接收调度消息
    this.use(new ClawDispatchFeature());

    if (isExploration) {
      this.use(new WebSearchFeature());
      this.use(new ShellFeature());
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

      this.use(new TodoFeature({
        reminderTemplate: TODO_REMINDER_PROMPT_PATH,
        reminderThresholdWithTasks: config.reminderThresholdWithTasks,
        reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
      }));

      this.use(new WebSearchFeature());
      this.use(new ShellFeature());
      this.use(new IMOperatorFeature());
      this.use(new ConversationExportFeature());
    }
  }

  setCallArbiter(arbiter) {
    this._callArbiter = arbiter;
  }

  async sendIMMessage(text) {
    if (!this._activeIMChannel) {
      console.warn('[PortalAgent] sendIMMessage: no active IM channel');
      return false;
    }

    if (!this._lastIMTarget?.userId) {
      console.warn('[PortalAgent] sendIMMessage: no known IM peer');
      return false;
    }

    try {
      if (this._activeIMChannel === 'weixin' && this.weixinBotFeature) {
        const apiClient = this.weixinBotFeature.apiClient;
        if (apiClient && typeof apiClient.sendTextMessage === 'function') {
          await apiClient.sendTextMessage(
            this._lastIMTarget.userId,
            text,
            this._lastIMTarget.contextToken || '',
          );
          return true;
        }
        return false;
      }

      if (this._activeIMChannel === 'qq' && this.qqbotFeature) {
        console.log(`[PortalAgent] IM result (qq, user=${this._lastIMTarget.userId}): ${text.slice(0, 100)}`);
        return false;
      }

      return false;
    } catch (err) {
      console.error('[PortalAgent] sendIMMessage failed:', err);
      return false;
    }
  }

  setLastIMTarget(userId, contextToken) {
    this._lastIMTarget = { userId, contextToken: contextToken || '' };
  }

  getActiveIMChannel() {
    return this._activeIMChannel || null;
  }

  async startQQBotGateway() {
    await this.qqbotFeature.startGateway(this);
    this._activeIMChannel = 'qq';
    if (this._callArbiter && this.qqbotFeature) {
      this.qqbotFeature.agentRef = {
        onCall: async (text) => {
          const entry = this._callArbiter.enqueue({ source: 'qq', text });
          const finished = await this._callArbiter.waitForCompletion(entry.id);
          if (finished.status === 'failed') {
            throw new Error(finished.error || 'unknown error');
          }
          return finished.result || '处理完成';
        },
      };
    }
  }

  async startWeixinBotGateway() {
    const weixinBot = this.weixinBotFeature;
    if (weixinBot && typeof weixinBot.handleMessage === 'function') {
      const originalHandleMessage = weixinBot.handleMessage.bind(weixinBot);
      weixinBot.handleMessage = async (msg) => {
        if (msg && msg.from_user_id) {
          this.setLastIMTarget(msg.from_user_id, msg.context_token);
        }
        if (!this._callArbiter) {
          return originalHandleMessage(msg);
        }
        if (!msg || msg.message_type !== 1) {
          return;
        }
        const text = WeixinApiClient.extractText(msg);
        if (!text) {
          return;
        }

        // 设置 WeixinBot 的 turn context，使 @CallStart 和 upload_attachment 工具生效
        weixinBot._currentTurnCtx = {
          fromUserId: msg.from_user_id,
          contextToken: msg.context_token,
        };
        weixinBot._pendingMedia = [];

        try {
          const entry = this._callArbiter.enqueue({
            source: 'weixin',
            sourceRef: msg.from_user_id || '',
            text,
          });
          const finished = await this._callArbiter.waitForCompletion(entry.id);
          const responseText = finished.status === 'failed'
            ? `处理失败: ${finished.error || '未知错误'}`
            : (finished.result || '');

          // 发送文本回复
          if (responseText) {
            await weixinBot.apiClient.sendTextMessage(
              msg.from_user_id,
              responseText,
              msg.context_token,
            );
          }

          // flush 所有待发送的媒体附件
          await weixinBot.flushPendingMedia();
        } finally {
          weixinBot._currentTurnCtx = null;
          weixinBot._pendingMedia = [];
        }
      };
    }

    await weixinBot.startGateway(this);
    this._activeIMChannel = 'weixin';
  }

  async startFeishuBotGateway() {
    const feishuBot = this.feishuBotFeature;
    await feishuBot.startGateway(this);
    this._activeIMChannel = 'feishu';
    if (this._callArbiter && feishuBot) {
      feishuBot.agentRef = {
        onCall: async (text) => {
          const entry = this._callArbiter.enqueue({ source: 'feishu', text });
          const finished = await this._callArbiter.waitForCompletion(entry.id);
          if (finished.status === 'failed') {
            throw new Error(finished.error || 'unknown error');
          }
          return finished.result || '处理完成';
        },
      };
    }
  }

  async startWecomBotGateway() {
    const wecomBot = this.wecomBotFeature;
    await wecomBot.startGateway(this);
    this._activeIMChannel = 'wecom';
    if (this._callArbiter && wecomBot) {
      wecomBot.agentRef = {
        onCall: async (text) => {
          const entry = this._callArbiter.enqueue({ source: 'wecom', text });
          const finished = await this._callArbiter.waitForCompletion(entry.id);
          if (finished.status === 'failed') {
            throw new Error(finished.error || 'unknown error');
          }
          return finished.result || '处理完成';
        },
      };
    }
  }

  async startSelectedIMGateway() {
    const workspaceConfig = readIMWorkspaceConfig(this.imWorkspaceConfigPath);
    if (!workspaceConfig.selectedChannel) {
      console.log('[PortalAgent] 未选择 IM 渠道，跳过 Gateway 启动（仅调试模式运行）');
      return 'none';
    }
    if (workspaceConfig.selectedChannel === 'weixin') {
      await this.startWeixinBotGateway();
      return 'weixin';
    }

    if (workspaceConfig.selectedChannel === 'feishu') {
      await this.startFeishuBotGateway();
      return 'feishu';
    }

    if (workspaceConfig.selectedChannel === 'wecom') {
      await this.startWecomBotGateway();
      return 'wecom';
    }

    await this.startQQBotGateway();
    return 'qq';
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
    const wcUploadTool = this.wecomBotFeature?.getTools().find(t => t.name === 'upload_attachment');
    this.tools.register({
      name: 'upload_attachment',
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
        if (this._activeIMChannel === 'weixin' && wxUploadTool) {
          return wxUploadTool.execute(args);
        }
        if (this._activeIMChannel === 'wecom' && wcUploadTool) {
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
