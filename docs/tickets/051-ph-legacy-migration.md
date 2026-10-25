# 051 · 编程小助手存量会话线程迁移

状态：迁移工具、真实数据迁移与启动自动迁移已完成。
上游：[ADR-0032](../../docs/adr/0032-programming-helper-thread-driven.md) · [批次总入口](2026-10-24-ph-thread-driven.md) · 前置 [050](050-ph-conversation-list-and-history.md)

## 目标与边界

将尚未归属 Thread 的编程小助手（PH）存量 Session 按明确的 compacted 接续血缘归并为 WorkThread。会话正文和 Session index 不改写；已在线程中的成员跳过；one-shot 派生会话排除；分支来源作为审计信息保留，分支本身建立独立单代线程。

无法唯一还原的血缘分量（多后继、多前驱、环、重复 ID、悬空或缺失来源）保持原样，不猜测合并。其余明确分组可以继续迁移。迁移仅建立 Thread 连续性记录，并不删除或改写 Session。

## 实现

- `scripts/ph-thread-migration.js`：解析 PH session index，生成线性链、单例组、歧义分量、分支来源和排除项；Thread 记录遵循框架 WorkThreadRecord 契约。
- `scripts/migrate-ph-threads.mjs`：开发与运维入口。预览以 `wx` 创建固定计划；执行校验确认 hash、计划完整性、源 index 与现有线程成员，备份 session index 和 archive index 后经 `ThreadStore` / `ThreadArchiveIndex` 写入。支持同计划幂等重跑与部分写入恢复；真实用户目录执行要求显式 `--allow-user-data`。
- `server/thread-control/ph-legacy-migration.js`：服务启动自动迁移。计划和完成标记保存在用户数据目录 `migrations/ph-thread-legacy-v1/`，备份保存在 `migration-backups/`；歧义分量跳过，干净分组自动写入。成功后完成标记使后续启动幂等跳过；源索引变化、文件损坏等失败会告警并保留现场，服务启动继续进行。
- `server.js`：在工作空间会话清理和请求服务前调用启动迁移器。新安装没有 PH session index 时直接跳过。

## 本机真实数据执行

2026-10-25，在 `~/.agentdev/AgentDevClaw` 上执行了只读预览并按其计划迁移。计划 hash：`ff10a7bb7ce8359e51c04541b916f5074f95b66832f84d546b4a19865d761ac6`。

- 1,420 条明确分组共 2,376 个 Session 成员写入线程；包括 962 个单例和 458 条多会话链，最长链 17 个 Session。
- 45 个歧义分量（40 个多后继、5 个悬空来源）保持未归线；其中 228 个 Session 未被并入任何 PH Thread。
- 11 个已在线程成员跳过，55 个 one-shot 会话排除。
- 写入后独立读取确认 1,420 条迁移记录全部存在，head 和成员顺序与计划一致；最长链完整；歧义成员未进入线程。682 条迁移线程保留了 head 的原归档状态。
- 迁移备份与完成清单位于用户数据目录的 `migration-backups/ph-threads-20261025/`。Session index 与 Session 正文未修改。

上述数量是本机迁移记录，不代表其他用户数据。其他用户升级后由服务启动迁移器按同一规则处理。

## 验收

- `node --test test/ph-thread-migration.test.js test/ph-legacy-startup-migration.test.js`：16 项通过。覆盖血缘分析、歧义分量隔离、真实 ThreadStore 写入与回读、归档映射、预览过期拒绝、备份、幂等与续跑，以及新安装跳过和启动迁移完成标记。
- 对现有线程成员 partition 缺陷进行了针对性回归验证：缺陷版在已有线程场景失败，修复版通过；对“歧义会话不得写入”用例做破坏验证，错误实现导致用例失败，还原后通过。
- `node --check server/thread-control/ph-legacy-migration.js`、`node --check scripts/migrate-ph-threads.mjs`、`node --check server.js`、`npm run check:cycles` 与 `npm run build` 通过。
- 未运行全量测试或真实升级用户的桌面安装验收。
