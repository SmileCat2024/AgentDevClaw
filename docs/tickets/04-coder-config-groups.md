# Ticket 04 — 自动化编码智能体（coder）N 组配置可切换

- 依赖：01、02（可与 03 并行）
- 仓库：Claw
- 涉及：`agents/coder/agent.js`、`~/.agentdev/AgentDevClaw/workspaces/coder/feature-config/`

## 背景

coder 的产品情景是"工作空间内 N 组配置，可切换"（用户确认的第二个 scope
形态）。切换式 = 队列中激活一个元素，框架无感知（D13）。

## 任务

1. **配置组文件**：`workspaces/coder/feature-config/groups/<name>.json`
   - 每组一个稀疏 FeatureConfig；组名即文件名（去除扩展名）

2. **队列组装**（agent.js）：
   ```js
   const queue = [readGlobalLayer(), readGroupLayer(selectedGroup)];
   const { merged } = resolveFeatureConfig(queue);
   ```
   - 未选中任何组时队列只有全局层（单元素，合法）

3. **选中状态来源**（优先级）：
   - CLI 显式参数：`claw run coder --config-group <name>`（临时覆盖）
   - 持久状态：`workspaces/coder/feature-config/selected.json` 记录默认组
   - 两者都没有 → 无组层

4. **CLI 支撑**：`claw agents` 或新增 `claw config-groups coder` 列出可用组
   （只读列表，管理靠文件；UI 化不在本 ticket）

## 验收标准

- 两组配置（如 A 组关 memory、B 组开 memory）通过 `--config-group` 切换，
  运行行为不同
- selected.json 持久选择后，不带参数运行沿用该组
- 组名不存在时报错清晰（不静默回退无组，避免掩盖拼写错误）
- 无组/无 selected.json 时行为与现状（仅全局层）一致

## 边界说明

- 这是"就事论事"的第二个装配案例，证明队列模型的表达力；不做通用
  profile 管理 UI（如果未来需要，届时按实际使用反馈立项）
