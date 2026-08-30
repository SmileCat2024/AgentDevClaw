# 009: AgentDev — BasicAgent 纯基类化（移除全部内置 feature 装配）

- 批次：3（库结构原子重构）
- 前置：无（可与批次 2 并行——不触碰 continuity / WorkThread 文件）
- 依据：ADR-0003 决策 3
- 仓库：D:\code\AgentDev

## 背景

`src/agents/system/BasicAgent.ts` L11 / L159 反向依赖并内置装配 4 个 feature：

```ts
import { MCPFeature, SkillFeature, SubAgentFeature, OpencodeBasicFeature } from '../../features/index.js';
this.use(new SubAgentFeature()); // 及 MCP / Skill / OpencodeBasic 同款
```

`ExplorerAgent.ts` L10 / L124 同款装配。这使 core 无法做到零 feature 反向依赖，也是 MCP SDK 渗入框架核心的路径。移除 subagent 支持的更改已在进行，本票将其扩展为全部内置装配的移除。

## 实施步骤

1. BasicAgent 移除全部内置 `use()`（SubAgentFeature、MCPFeature、SkillFeature、OpencodeBasicFeature）与对应 import
2. ExplorerAgent 同步纯基类化；需要其预装配行为的消费方（Claw 编程小助手探索会话）在装配层自行组合
3. MCPFeature 移出 core bundle，归宿 `@agentdev/mcp`（与 010 协同；其余轻量 feature 的白名单见 010）
4. 框架 README 记录"装配权在宿主"的约定
5. 测试：新增 BasicAgent / ExplorerAgent 零 feature 注册断言；依赖内置装配的既有测试改为显式装配

## 验收标准

- BasicAgent / ExplorerAgent 的 import 面不含 `features/index.js`
- AgentDev 仓库全部测试绿（显式装配改造后）
- Claw 侧受影响的 agent（若依赖内置装配）显式补装配，编程小助手探索会话冒烟通过

## 风险与回滚

- 依赖内置装配的第三方宿主失去工具——预期内破坏性变更，ADR-0003 已接受
- 回滚：整票回退（git revert）

## 阻塞项 / 未决

无。
