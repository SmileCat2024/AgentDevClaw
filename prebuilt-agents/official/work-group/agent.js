/**
 * 工作群 Agent
 *
 * 群聊工作空间的运行时 agent。
 * 通过 GroupAdminFeature 暴露 gc_* 工具集，为 @管理员 提供协调能力。
 */
import { BasicAgent, TemplateComposer } from 'agentdev';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { GroupAdminFeature } from '../../../local-features/dist/group-admin/src/index.js';
import { GroupChatBridgeFeature } from '../../../local-features/dist/group-admin/src/bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

function readSystemPrompt() {
  if (!existsSync(SYSTEM_PROMPT_PATH)) return '';
  try {
    return readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  } catch {
    return '';
  }
}

export class WorkGroupAgent extends BasicAgent {
  constructor(config = {}) {
    super(config);

    this.use(new GroupAdminFeature());
    this.use(new GroupChatBridgeFeature());

    this.composer = new TemplateComposer({
      systemPrompt: readSystemPrompt(),
    });
  }
}

export default WorkGroupAgent;
