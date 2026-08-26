/**
 * TicketsBuildFlow — 「拿到 tickets 之后」的标准构建流程
 *
 * 封装 Matt Pocock skills 仓库中 tickets 下游的三个流程规范：
 *   - implement    按票实现：TDD 于预定 seam，定期类型检查，收尾 code-review，提交当前分支
 *   - tdd          红绿循环：什么是好测试、seam 纪律、反模式与循环规则
 *   - code-review  双轴评审：Standards（写对了吗）与 Spec（做的是对的事吗）独立报告
 *
 * 交付形态：
 *   1. Feature 自带 skills/（SKILL.md + references）。挂载 SkillFeature 的宿主
 *      （如 BasicAgent 系 coder）会按 `dirname(source)/skills` 约定自动发现并
 *      注入 Agent 技能列表（invoke_skill 可展开）。
 *   2. 一个便携读取工具 tickets_flow_skill：在未挂载 SkillFeature 的宿主上
 *      提供同样的规范入口；也用于运行期自省（列出/读取某个 skill 全文）。
 *
 * 非目标：不做 issue tracker 集成、不做 ticket 状态机、不封装测试运行器。
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AgentFeature, PackageInfo, Tool } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';

const SKILL_IDS = ['implement', 'tdd', 'code-review'] as const;
type SkillId = (typeof SKILL_IDS)[number];

interface BundledSkillMeta {
  name: SkillId;
  description: string;
}

/** frontmatter 之外的机器可读摘要，供工具的清单模式返回 */
const SKILL_SUMMARIES: BundledSkillMeta[] = [
  {
    name: 'implement',
    description:
      '按 spec 或 ticket 实现已决定的工作：TDD 于预定 seam，定期类型检查，全量测试收尾，code-review 后提交当前分支。不重开方案讨论。',
  },
  {
    name: 'tdd',
    description:
      '测试驱动开发参考：什么是好测试、seam（测试边界）纪律、三大反模式与红绿循环规则。以测试先行构建功能或修 bug 时查阅。',
  },
  {
    name: 'code-review',
    description:
      '双轴 diff 评审：Standards（是否符合仓库规范 + 12 条 Fowler smell 基线）与 Spec（是否忠实实现来源工单/规格）独立报告、不合并排序。',
  },
];

export class TicketsBuildFlow implements AgentFeature {
  readonly name = 'tickets-build-flow';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description =
    '「拿到 tickets 之后」的标准构建流程：implement / tdd / code-review 三个流程规范 skill，外加便携读取工具。';

  private _packageInfo: PackageInfo | null = null;

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /** 读取某个自带 skill 的 SKILL.md 全文；文件缺失返回 null */
  private readSkillContent(skill: SkillId): string | null {
    try {
      const skillPath = join(dirname(this.source.replace(/\\/g, '/')), 'skills', skill, 'SKILL.md');
      return readFileSync(skillPath, 'utf-8');
    } catch {
      return null;
    }
  }

  getTools(): Tool[] {
    const skillTool: Tool = {
      name: 'tickets_flow_skill',
      description:
        '读取票据构建流程（tickets-build-flow）自带的流程规范。不带参数返回三个规范 skill 的清单（implement / tdd / code-review 及各自适用场景）；带 skill 参数返回该规范全文。开始处理一张 ticket、准备以测试先行写代码、或准备评审一段 diff 之前，先查阅对应规范。',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            enum: [...SKILL_IDS],
            description: '要读取完整规范的 skill 名；省略时返回清单。',
          },
        },
        additionalProperties: false,
      },
      parallelizable: true,
      execute: async (args: { skill?: string }) => {
        const requested = args?.skill;
        if (requested === undefined) {
          return {
            ok: true,
            count: SKILL_SUMMARIES.length,
            skills: SKILL_SUMMARIES,
            hint: '携带 skill 参数可读取对应规范全文；已挂载技能系统的宿主也可通过 invoke_skill 展开。',
          };
        }
        if (!SKILL_IDS.includes(requested as SkillId)) {
          return {
            ok: false,
            error: `未知规范 "${requested}"。可用规范：${SKILL_IDS.join(', ')}。`,
          };
        }
        const content = this.readSkillContent(requested as SkillId);
        if (content === null) {
          return {
            ok: false,
            error: `规范 "${requested}" 的 SKILL.md 缺失：构建产物未复制 skills/ 目录。`,
          };
        }
        return { ok: true, skill: requested, content };
      },
    };

    return [skillTool];
  }
}

export default TicketsBuildFlow;
