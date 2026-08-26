import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature, SkillFeature } from '@agentdevjs/core';
import { ShellFeature } from '@agentdevjs/shell-feature';
import { AuditFeature } from '@agentdevjs/audit-feature';
import { WebSearchFeature } from '@agentdevjs/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import { AgentStudioFeature } from '../../../local-features/dist/index.js';
import { ContextGuardFeature } from '../../../local-features/dist/context-guard/src/index.js';
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
    // 一次性过界拦截：manifest 决定会话启动初值，会话控制面板可实时装填。
    this.use(new ContextGuardFeature({
      ...(systemFeatureConfig['context-guard'] && typeof systemFeatureConfig['context-guard'] === 'object'
        ? systemFeatureConfig['context-guard'] : {}),
      ...(config.contextGuard && typeof config.contextGuard === 'object'
        ? config.contextGuard : {}),
    }));
    this.use(new AuditFeature({ workspaceDir }));
    this.use(new WebSearchFeature({ workspaceDir }));
    this.use(new ShellFeature({ workspaceDir, resourceRoot: projectRoot }));
    this.use(new AgentStudioFeature({ workspaceDir }));
    // SkillFeature：dev agent 的权威技能（agent-studio-workflow / agentdev-agent-assembly /
    // agentdev-feature-guide / agentdev-feature-packaging）随 AgentStudioFeature 构建产物携带，
    // 由框架按"feature source 同级 skills/ 目录"约定经 collectFeatureSkills 自动投递；
    // workspaceDir/.agentdev/skills（Studio 项目目录）可追加或同名覆盖。
    // feature-setup.json 的 skill 配置（scanAgentdevDir/scanClaudeDir/extraDirs 等）可覆盖默认值。
    this.use(new SkillFeature(
      systemFeatureConfig.skill && typeof systemFeatureConfig.skill === 'object'
        ? systemFeatureConfig.skill
        : undefined
    ));
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
