/**
 * QQBot 编程小助手 Agent - Claw 官方实现
 *
 * 专业的编程助手，通过 QQ 与用户交互
 * 当前先作为 ProtoClaw 内置预置 agent 展示，运行时仍基于 npm agentdev
 */

import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { QQBotFeature } from '@agentdev/qqbot-feature';
import { WeixinBot, WeixinApiClient } from '@agentdev/weixin-bot';
import { MemoryFeature } from '@agentdev/memory-feature';
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

/**
 * QQBot 编程小助手 Agent
 *
 * 专业的编程助手，通过 QQ 与用户交互
 * 继承 BasicAgent 获得所有基础设施能力
 */
export class QQBotProgrammingHelperAgent extends BasicAgent {
  qqbotFeature;
  weixinBotFeature;
  imWorkspaceConfigPath;
  _callArbiter = null;
  _activeIMChannel = null;
  _lastIMTarget = null; // { userId, contextToken? } — last IM peer for result delivery

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

    // ClawDispatchFeature 始终挂载，主模式与探索模式都需要接收调度消息
    this.use(new ClawDispatchFeature());

    if (isExploration) {
      // 探索模式：跳过 IM gateway、Todo、Audit、UserInput
      // 仅保留 Shell、WebSearch、Memory 等自主执行能力
      this.use(new WebSearchFeature());
      this.use(new ShellFeature());
      if (MemoryFeature) this.use(new MemoryFeature());
    } else {
      // 主模式：完整 IM 门户代理能力
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

      this.use(new AuditFeature());
      this.use(new WebSearchFeature());
      this.use(new ShellFeature());
      this.use(new UserInputFeature());
    }
  }

  /**
   * Set the CallArbiter reference (called by run-prebuilt-agent.js after arbiter init).
   * When set, IM gateway message handlers route through the arbiter instead of calling
   * agent.onCall() directly.
   */
  setCallArbiter(arbiter) {
    this._callArbiter = arbiter;
  }

  /**
   * Send a text message to the active IM channel.
   * Used by the callfinish result dispatcher to deliver non-IM-originated results.
   *
   * @param {string} text - The message text to send
   * @returns {boolean} Whether the message was sent successfully
   */
  async sendIMMessage(text) {
    if (!this._activeIMChannel) {
      console.warn('[QQBotAgent] sendIMMessage: no active IM channel');
      return false;
    }

    if (!this._lastIMTarget?.userId) {
      console.warn('[QQBotAgent] sendIMMessage: no known IM peer (no prior IM interaction)');
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
          console.log(`[QQBotAgent] IM result delivered to weixin user ${this._lastIMTarget.userId}`);
          return true;
        }
        console.warn('[QQBotAgent] sendIMMessage: weixin apiClient not accessible');
        return false;
      }

      if (this._activeIMChannel === 'qq' && this.qqbotFeature) {
        // QQ gateway adapter reply is handled in-band via the adapter's return value.
        // For non-IM-originated calls, we log since the QQBot standalone adapter
        // does not expose a direct send API. A future QQ adapter upgrade can
        // add proactive send support.
        console.log(`[QQBotAgent] IM result (qq channel, user=${this._lastIMTarget.userId}): ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
        return false;
      }

      console.warn(`[QQBotAgent] sendIMMessage: unknown channel "${this._activeIMChannel}"`);
      return false;
    } catch (err) {
      console.error('[QQBotAgent] sendIMMessage failed:', err);
      return false;
    }
  }

  /**
   * Record the last IM peer for result delivery.
   * Called by run-prebuilt-agent.js when IM gateway receives a message.
   *
   * @param {string} userId
   * @param {string} [contextToken]
   */
  setLastIMTarget(userId, contextToken) {
    this._lastIMTarget = { userId, contextToken: contextToken || '' };
  }

  /**
   * Get the currently active IM channel identifier.
   */
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
    // QQ adapter uses in-band reply (return value from adapter callback).
    // It does not expose a proactive send API for non-IM-originated calls.
    // Known limitation: callfinish → IM delivery for dispatch/viewer calls
    // will log but cannot actually push to QQ without adapter upgrade.
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

    // 主模式：完整的编程助手提示词
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。你通过当前被选中的 IM 线路与用户交流。')
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' })
      .add('\n\n## MCP 工具\n\n')
      .add('除了标准工具外，你还可以使用通过 MCP (Model Context Protocol) 接入的外部工具。默认自动挂载的工具通常以 `mcp_` 开头，而业务功能内部封装的工具可能使用业务前缀命名。\n')
      .add('\n\n## WebSearch 能力\n\n')
      .add('你可以使用 `web_fetch` 获取网页原始内容。')
      .add('如果内置 crawl4ai 服务可用，还可以使用以 `websearch_crawl4ai_` 开头的工具执行更强的网页抓取与提取。')
      .add('\n\n每次对话开始时，你会自动收到当前系统窗口状态的摘要信息。')
    );
  }
}
