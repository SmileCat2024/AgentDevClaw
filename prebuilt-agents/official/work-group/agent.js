/**
 * 工作群 Agent
 *
 * 群聊工作空间的运行时 agent。
 * 通过 GroupAdminFeature 暴露 gc_* 工具集，为 @管理员 提供协调能力。
 */
import { BasicAgent, TemplateComposer } from '@agentdevjs/core';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GroupAdminFeature } from '../../../local-features/dist/group-admin/src/index.js';
import { ModelSelectionFeature } from '../../../local-features/dist/model-selection/src/index.js';
import { GroupChatBridgeFeature } from '../../../local-features/dist/group-admin/src/bridge.js';
import { ShellFeature } from '@agentdevjs/shell-feature';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

export class WorkGroupAgent extends BasicAgent {
  constructor(config = {}) {
    // BasicAgent 已纯基类化（a5fe117 / ticket 009），不再自动挂载任何 feature，
    // 也不再消费 mcpServer/skillConfig 等项；本 agent 不启用 SubAgent/MCP。
    super(config);

    this.use(new GroupAdminFeature());
    this.use(new GroupChatBridgeFeature());
    // 会话级模型选择（ADR-0034）：群会话视图输入框切换控件的后端
    //（群聊 @mention 派发不经模型控件，装配无副作用）。
    this.use(new ModelSelectionFeature({
      agentId: config.runtime?.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'work-group',
      sessionId: config.runtime?.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID ?? '',
      serverOrigin: config.runtime?.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420',
    }));
    this.use(new ShellFeature({ workspaceDir: config.workspaceDir }));
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);
    const composer = new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户需要生成或更新项目背景文档时，可使用 invoke_skill 工具激活技能。你拥有如下技能：\n')
      .add({ skills: '- **{{name}}**: {{description}}' });
    this.setSystemPrompt(composer);
  }
}

export default WorkGroupAgent;
