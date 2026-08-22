# Feature 配置队列模型 — 设计总纲

> 2026-08-22 经 grill 讨论 converged。本文件是 tickets 01-06 的共同上下文，
> 未来实施者未参与讨论，请先读本文件。

## 问题

Feature 可通过 manifest.json 自声明配置项（`getFeatureManifest()`），但运行时
配置（feature-setup.json）全局只有一份，所有预制 agent 硬编码读取同一文件并
spread 进 `config.features`。真实需求是：

- 不同工作空间 / agent 的配置需求差异很大（编程小助手要按项目目录区分，
  自动化编码智能体要 N 组配置可切换，qqbot 可能按线路）；
- 需要支持完全覆盖、部分覆盖；
- 前端必须能感知"上游默认值是什么、当前字段是继承还是覆盖"；
- feature 目前只按 featureName 匹配配置（`ctx.featureConfig =
  this.config.features?.[name]`），多层配置来源对 feature 完全不可见。

## 模型：配置队列（Config Queue）

框架不认识"层"（global/agent/dir/profile 都是产品语义），只接受一个
**有序配置数组**，按序 deep merge 出最终配置：

```
queue: FeatureConfig[]          // FeatureConfig = 顶层按 featureName 分桶的对象
       ↓ resolveFeatureConfig(queue)
{ merged, provenance, warnings }
```

- **队列组装权在装配方**（各 agent.js / Claw 产品层），就事论事：
  - 编程小助手：`[全局层, 目录层(cwd), 会话注入(不落盘)]`
  - 自动化编码智能体(coder)：`[全局层, 当前选中配置组]`（切换式 = 激活一个）
- **merge 与 provenance 规则唯一权威实现在框架**（AgentDev），Claw 只消费。
- Agent / feature 接口零改动：`ctx.featureConfig` 仍是合并后的最终值。

### 字段三态（前端渲染的判定基础）

| 本层有该字段？ | 上游（队列更早元素）有？ | 状态 |
|---|---|---|
| 无 | 无 | 出厂默认（manifest default，虚拟第 0 层，不进队列） |
| 无 | 有 | 继承自第 i 层（显示其值） |
| 有 | 任意 | 覆盖（显示上游值供对照） |

"存在即覆盖"：字段在本层稀疏文件中存在 = 显式覆盖，哪怕值等于上游（pin）。
不需要任何来源元数据落盘，provenance 全部查询时动态计算。

## 已定决策清单

| # | 决策 |
|---|---|
| D1 | 框架提供 merge 原语，输入为队列，不预设层语义 |
| D2 | 队列组装权在装配方（Claw 产品层），就事论事 |
| D3 | Agent 构造函数零改动（不加 featureConfigQueue 语法糖）；feature 零改动 |
| D4 | manifest default 不进队列，feature 消费侧兜底（现状行为不变） |
| D5 | merge 规范：对象递归合并；标量/数组整体替换（数组绝不按索引合并）；null 禁止（按删除处理并产生 warning）；不写即继承 |
| D6 | provenance 与 merge 同源：单函数 `resolveFeatureConfig(queue)` 单次遍历返回 `{ merged, provenance, warnings }` |
| D7 | provenance 查询时计算，永不落盘 |
| D8 | pin = 存在即覆盖（值同也保留）；UI 值同提示"清除覆盖/保留锁定"；重置为继承 = 删字段 |
| D9 | 每层存储必须稀疏（只存显式设置的字段）；UI 保存只写 diff（用户碰过的字段），杜绝影子写入 |
| D10 | 层文件放 `~/.agentdev/AgentDevClaw/workspaces/<agentId>/` 下 |
| D11 | 现有 feature-setup.json 一次性清洗为稀疏后作全局层（剔空串/空数组/null，保留疑似 pin） |
| D12 | 会话级/调用方注入走队列末尾（不落盘），不再走 config.features 直接 spread |
| D13 | scope 形态多样化是需求本身（并行组/目录/切换），全部是 Claw 装配层的事，框架不可见 |

## 关键否决项（为什么不是别的方案）

- **否决：框架内置固定层栈（global/agent/dir）** — 不同 agent 需求差异大，
  固定栈把产品语义焊进框架，flexibility 丢失。
- **否决：Claw 侧自建合并工具函数** — merge 规则与 provenance 会散在 Claw，
  无法成为唯一权威；各 agent 仍要手动接线。
- **否决：Kustomize 式指令系统 / 按 key 数组合并** — 复杂度远超收益
  （strategic merge patch 是业界著名反面教材）。merge 语义全场唯一、无例外。
- **否决：null 作为显式语义** — null 删除与"不写即继承"行为等价，仅
  provenance 展示有差异，不值得付语义复杂度。层文件禁止 null。
- **否决：manifest default 进队列** — default 活在 feature 代码里，落盘反而
  制造第二份默认值；且 default 进队列会破坏"feature 零改动"。

## 业界参照

- VS Code Settings：固定层栈 + 稀疏存储 + modified indicator + inspect() +
  恢复默认（三态 UI 的直接参照）
- git config：`--show-origin/--show-scope`（provenance 查询时计算的参照）
- Spring Environment：可编程 PropertySource 队列（队列组装权的参照）
- RFC 7386 (JSON Merge Patch)：对象递归/null 删除/其余替换（merge 规范参照）
- 反面教材：Docker Compose（同类字段 append/replace 语义不一致）、
  Kustomize strategic merge patch（数组按 key 合并过于复杂）

## 分工与依赖

```
[AgentDev 框架]  01 resolveFeatureConfig 纯函数 + 单测
        ↓
[Claw]   02 全局文件清洗（稀疏化）
        ↓
[Claw]   03 编程小助手目录层（首个消费方，含会话注入队列位）
[Claw]   04 coder 配置组切换（可与 03 并行）
        ↓
[Claw]   05 resolved API（scope→queue 注册表 + provenance 暴露）
        ↓
[Claw]   06 前端多作用域三态编辑器
```

## 已登记风险（不阻塞，实施时注意）

- 配置文件含明文敏感字段（如 github token），现状 resolved API
  （system_feature_config）已原样返回前端。新 resolved API 不得扩散此问题，
  脱敏方案另立 ticket。
- LspFeature 等 7 个 feature 的 onInitiate 内部字段合并代码（结构映射，非层间
  合并）与新模型不冲突，第一版不动；长期收敛另行评估。
- 悬置 agent（agent-creator/feature-creator 等）的 readSystemFeatureConfig
  旧路径在 01-06 完成后统一迁移，不在本批 tickets 范围。
