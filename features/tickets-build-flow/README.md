# @agentdevjs/tickets-build-flow

「拿到 tickets 之后」的标准构建流程 Feature。封装 [skills-mattpocock](https://github.com/mattpocock/skills) 仓库中 tickets 下游的三个流程规范，为编码 Agent（coder）提供从工单到提交的完整工作流知识：

```
grill-with-docs → to-spec → to-tickets → [implement → tdd → code-review] → commit
                                            └────────── 本 Feature ──────────┘
```

## 三个自带 skill

| Skill | 职责 |
|---|---|
| `implement` | 按票实现五节拍：读票找 seam → TDD 红绿切片 → 定期类型检查 → 全量测试一次 → code-review 后提交当前分支。一次一张票、不重开方案、不碰工单状态。 |
| `tdd` | 红绿循环规范：好测试定义、seam 纪律（未确认的 seam 不写测试）、三大反模式（耦合实现 / 同义反复 / 水平切片）、循环规则。附 `references/`（好测试示例、mocking 准则）。 |
| `code-review` | 双轴 diff 评审：Standards（仓库成文规范 + 12 条 Fowler smell 基线）与 Spec（来源工单忠实度）独立报告、永不合并排序。 |

skill 通过 AgentDev 的 Feature 自带技能约定交付：构建时 `skills/` 复制到 `dist/skills/`，挂载 SkillFeature 的宿主（BasicAgent 系）在 `ensureFeatureTools` 阶段自动发现并注入技能列表，`invoke_skill` 可展开全文。工作区同名 skill 优先于 Feature 自带 skill（文档化覆盖行为）。

## 便携读取工具

`tickets_flow_skill` 在未挂载 SkillFeature 的宿主上提供同样的规范入口：

- **无参数** — 返回三个规范的清单（name / description / 适用场景）
- **`skill: "implement" | "tdd" | "code-review"`** — 返回该规范的 SKILL.md 全文
- 未知名称返回 `ok: false` 与可用清单；只读操作，`parallelizable: true`

## Mounting

```typescript
import { TicketsBuildFlow } from '@agentdevjs/tickets-build-flow';

agent.use(new TicketsBuildFlow()); // 无配置面，直接挂载
```

Claw 仓库内消费见 `prebuilt-agents/official/coder/agent.js`（工单看板 agent 的主工作分支挂载；探索分支不挂）。

## Verification

- Studio Test Runtime（feature-harness）：`tickets-flow-list-skills` / `tickets-flow-read-tdd` 两个测试断言全通过，工具执行证据归属本 Feature（run-1787200089920-qaxh）。
- 真实 coder agent 冒烟：`tickets_flow_skill` 注册归属正确；`implement / tdd / code-review` 出现在技能列表。

## Development

```bash
npm install
npm run build    # tsup 构建 + copy-assets 复制 skills/ 到 dist/skills/
npm test         # node --test test/
```

## License

MIT
