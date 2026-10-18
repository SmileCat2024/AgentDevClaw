/**
 * ClawHelpFeature — AgentDevClaw 使用帮助技能载具
 *
 * 本 feature 不注册工具与钩子，唯一职责是携带 skills/agentdevclaw-help/
 * 技能文档：框架 collectFeatureSkills 按 dirname(source)/skills 约定自动
 * 发现并注入系统提示词（构建时 scripts/copy-local-feature-skills.mjs 将
 * 包根 skills/ 复制到 dist 的 source 同级位置）。
 *
 * 技能定位：编程小助手的对话面帮助台——面向终端用户与潜在贡献者，
 * 覆盖模型 / MCP / 技能配置、界面导览、上下文接续、故障排查与源码
 * 参与引导。权威事实清单与维护纪律见 skills/agentdevclaw-help/SKILL.md。
 */

import { fileURLToPath } from 'url';
import type { AgentFeature, PackageInfo } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';

const __filename = fileURLToPath(import.meta.url);

export class ClawHelpFeature implements AgentFeature {
  readonly name = 'claw-help';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'AgentDevClaw 使用帮助技能载具（agentdevclaw-help）。';

  private _packageInfo: PackageInfo | null = null;

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }
}
