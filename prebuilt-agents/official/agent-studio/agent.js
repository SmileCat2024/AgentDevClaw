import { BasicAgent, ShellFeature, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import { AgentStudioFeature } from '../../../local-features/dist/index.js';
import { ForceContinuation } from '../../../features/force-continuation/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const SYSTEM_PROMPT_PATH = join(__dirname, '.agentdev', 'prompts', 'system.md');
const SYSTEM_FEATURE_CONFIG_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'feature-setup.json');
const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];

function readSystemFeatureConfig() {
  if (!existsSync(SYSTEM_FEATURE_CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SYSTEM_FEATURE_CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class AgentStudioAgent extends BasicAgent {
  constructor(config = {}) {
    const projectRoot = config.projectRoot ?? PROTOCLAW_ROOT;
    const workspaceDir = config.workspaceDir ?? PROTOCLAW_ROOT;
    const systemFeatureConfig = readSystemFeatureConfig();

    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...systemFeatureConfig,
      },
      projectRoot,
      workspaceDir,
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    this.workspaceDir = workspaceDir;
    this.use(new TodoFeature({
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));
    this.use(new ForceContinuation({
      ...(systemFeatureConfig['force-continuation'] && typeof systemFeatureConfig['force-continuation'] === 'object'
        ? systemFeatureConfig['force-continuation'] : {}),
      ...(config.features?.['force-continuation'] && typeof config.features['force-continuation'] === 'object'
        ? config.features['force-continuation'] : {}),
    }));
    this.use(new AuditFeature({ workspaceDir }));
    this.use(new WebSearchFeature({ workspaceDir }));
    this.use(new ShellFeature({ workspaceDir, resourceRoot: projectRoot }));
    this.use(new AgentStudioFeature({ workspaceDir }));
    this.use(new UserInputFeature());
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 当前工作目录\n\n')
      .add(`当前工作目录为：\`${this.workspaceDir}\``)
      .add('\n\n## 可用技能（Skills）\n\n')
      .add('当用户请求与你拥有的技能匹配时，主动使用 invoke_skill。以下是可用技能：\n')
      .add({ skills: '- **{{name}}**: {{description}}' }));
  }
}
