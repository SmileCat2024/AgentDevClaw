/**
 * 工作群 Agent
 *
 * 群聊工作空间的运行时 agent。
 * 通过 GroupAdminFeature 暴露 gc_* 工具集，为 @管理员 提供协调能力。
 */
import { BasicAgent, TemplateComposer, MemoryFeature } from 'agentdev';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GroupAdminFeature } from '../../../local-features/dist/group-admin/src/index.js';
import { GroupChatBridgeFeature } from '../../../local-features/dist/group-admin/src/bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

export class WorkGroupAgent extends BasicAgent {
  constructor(config = {}) {
    super({ ...config, mcpServer: false });

    this.use(new GroupAdminFeature());
    this.use(new GroupChatBridgeFeature());

    // 从群聊 dispatch 时传入的 PROTOCLAW_GC_WORKDIR 读取 GROUP.md
    // GROUP.md 作为群聊的静态背景文档，类似 CLAUDE.md 对编程项目的意义
    const gcWorkDir = process.env.PROTOCLAW_GC_WORKDIR;
    if (gcWorkDir) {
      this.use(new MemoryFeature({
        workspaceDir: gcWorkDir,
        filename: '.agentdev/GROUP.md',
      }));
    }
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
