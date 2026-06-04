/**
 * IM 门户代理 Agent - Claw 官方实现
 *
 * 管理 IM 线路连接、接线转接，作为消息的入口网关。
 * 通过 QQ/微信等渠道与用户交互，可将线路动态转接到任意工作空间会话。
 */

import { BasicAgent, TemplateComposer, TodoFeature } from 'agentdev';
import { QQBotFeature } from '@agentdev/qqbot-feature';
import { WeixinBot, WeixinApiClient } from '@agentdev/weixin-bot';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { ClawDispatchFeature } from '../../../local-features/dist/dispatch/src/index.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const SERVER_ORIGIN = `http://127.0.0.1:${process.env.PORT || 1420}`;

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
    const selectedChannel = typeof raw.selectedChannel === 'string' && channels[raw.selectedChannel]
      ? raw.selectedChannel
      : 'qq';
    return {
      selectedChannel,
      receptionistSessionId: typeof raw.receptionistSessionId === 'string' ? raw.receptionistSessionId.trim() : '',
      channels,
    };
  } catch {
    return {
      selectedChannel: 'qq',
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
            if (lines.length === 0) {
              return { text: '当前没有配置任何 IM 线路。', lines: [] };
            }
            const summary = lines.map(l => {
              const carrierLabel = l.carrier === 'qq' ? 'QQ' : l.carrier === 'weixin' ? '微信' : '未配置';
              const bound = l.boundSession;
              const status = bound
                ? `已连接 → ${bound.sessionTitle || bound.sessionId} (${bound.agentId})`
                : '空闲（未连接）';
              return `- **${l.name}** [${carrierLabel}]: ${status}`;
            });
            return {
              text: `当前 IM 线路状态：\n${summary.join('\n')}`,
              lines,
            };
          } catch (err) {
            return { error: `查询失败: ${err.message}` };
          }
        },
      },
      {
        name: 'im_browse',
        description: '列出所有可连接的工作空间会话。返回每个工作空间下的项目和在线会话，包含 im_connect_line 所需的 agentId 和 sessionId。',
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
            const lines = [];
            const flatSessions = [];
            for (const ws of workspaces) {
              for (const project of ws.projects) {
                for (const session of (project.runningSessions || [])) {
                  lines.push(`- 工作空间: ${ws.name} | agentId: ${ws.agentId} | 会话: ${session.title} | sessionId: ${session.id}`);
                  flatSessions.push({ agentId: ws.agentId, agentName: ws.name, sessionId: session.id, sessionTitle: session.title });
                }
              }
            }
            return {
              text: `可连接的在线会话：\n${lines.join('\n')}\n\n使用 im_connect_line 并传入 lineId、agentId、sessionId 即可接线。`,
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
            return { text: `线路「${line.name}」已连接到 ${agentId}::${sessionId}。`, success: true };
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
            return { text: `线路已断开。`, success: true };
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
    super({
      ...config,
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

      this.use(new TodoFeature({
        reminderTemplate: TODO_REMINDER_PROMPT_PATH,
        reminderThresholdWithTasks: config.reminderThresholdWithTasks,
        reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
      }));

      this.use(new WebSearchFeature());
      this.use(new ShellFeature());
      this.use(new IMOperatorFeature());
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
        const entry = this._callArbiter.enqueue({
          source: 'weixin',
          sourceRef: msg.from_user_id || '',
          text,
        });
        const finished = await this._callArbiter.waitForCompletion(entry.id);
        const responseText = finished.status === 'failed'
          ? `处理失败: ${finished.error || '未知错误'}`
          : (finished.result || '处理完成');
        await weixinBot.apiClient.sendTextMessage(
          msg.from_user_id,
          responseText,
          msg.context_token,
        );
      };
    }

    await weixinBot.startGateway(this);
    this._activeIMChannel = 'weixin';
  }

  async startSelectedIMGateway() {
    const workspaceConfig = readIMWorkspaceConfig(this.imWorkspaceConfigPath);
    if (workspaceConfig.selectedChannel === 'weixin') {
      await this.startWeixinBotGateway();
      return 'weixin';
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
      .add('\n\n## 身份设定\n\n')
      .add('你是 IM 门户接线员。你的职责是管理 IM 线路连接，将消息路由到正确的工作空间会话。')
      .add('用户通过 QQ 或微信与你对话，你可以使用接线员工具查看线路状态、浏览可连接的工作空间和会话、以及进行接线转接。')
      .add('\n\n## 接线员工具（唯一信息来源）\n\n')
      .add('你只能使用以下 4 个接线员工具获取线路和目标信息，禁止使用其他工具（如 MCP 调试工具）来查询线路或会话状态：\n\n')
      .add('- `im_overview`: 查看所有线路的当前状态（线路 ID、载体、是否已连接）\n')
      .add('- `im_browse`: 列出所有可连接的在线会话（直接返回 agentId 和 sessionId，无需多次调用）\n')
      .add('- `im_connect_line`: 将线路连接到指定会话。参数：lineId（来自 im_overview）、agentId 和 sessionId（来自 im_browse）\n')
      .add('- `im_disconnect_line`: 断开线路的当前连接。参数：lineId（来自 im_overview）\n')
      .add('\n## 工作流程\n\n')
      .add('1. 收到转接请求时，用 `im_overview` 查看线路状态，获取 lineId\n')
      .add('2. 用 `im_browse` 获取所有可连接会话，找到目标的 agentId 和 sessionId\n')
      .add('3. 用 `im_connect_line` 执行接线\n')
      .add('4. 如需断开用 `im_disconnect_line`\n')
    );
  }
}
