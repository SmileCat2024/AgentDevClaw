# Ticket 02 — 全局 feature-setup.json 稀疏化清洗

- 依赖：01（规范确定后清洗结果才可被 merge 消费；清洗本身可先行开发）
- 仓库：Claw
- 涉及：`scripts/`（新一次性迁移脚本）、`~/.agentdev/AgentDevClaw/feature-setup.json`

## 背景

现状 feature-setup.json 是 UI 全量 dump 的**完整快照**：audio-feedback 里躺着
`audioPath: ""`、github 里一堆空串字段。这些影子字段在新模型中会永久压制上游
默认（manifest default），且让三态 UI 无法判断"用户到底设过什么"。
清洗为稀疏存储是全局层进入队列模型的前提（D11）。

## 任务

写一次性迁移脚本 `scripts/migrate-feature-setup-sparse.mjs`：

1. 读 `~/.agentdev/AgentDevClaw/feature-setup.json`
2. 递归剔除：
   - 值为 `""`（空串）的字段
   - 值为 `[]`（空数组）的字段
   - 值为 `null` 的字段
3. **保留**：一切非空值，包括恰好等于 manifest default 的字段（视为用户 pin，
   宁可多留不可误删用户意图，D8）；敏感字段（如 github.token）照常保留
4. 写回前备份原文件为 `feature-setup.json.bak-<timestamp>`（不覆盖已有备份）
5. 支持 `--dry-run`：只打印将删除的字段路径与将保留的内容摘要
6. 幂等：重复运行第二次应无变化（第二次 dry-run 输出为空）

运行后 `server/routes/system-feature-config.js` 的读写路径无需改动（它只是
JSON 读写，稀疏化对它透明）。但注意：**当前前端保存是全量 dump**，会把清洗
成果立刻污染回去——所以本 ticket 的清洗效果要到 Ticket 06（diff 保存）落地
后才真正稳定。实施顺序上 02 只是打通数据侧，防回流靠 06。

## 验收标准

- dry-run 输出准确列出将被剔除的字段（对照现状文件：audio-feedback 的两个
  空串、github 的多个空串应全部命中）
- 实跑后：文件仅含非空字段；有 .bak 备份；JSON 可解析
- 二次运行（含 dry-run）无变化（幂等）
- 一个已存在的非空配置（如 github.token、contextGuard.enabled=false）原样保留
