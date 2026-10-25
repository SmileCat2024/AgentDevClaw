# 051 · 编程小助手存量会话线程迁移

状态：工具与隔离验证已完成；真实数据预览已生成，执行未获批准且当前被歧义血缘安全闸阻止。
上游：[ADR-0032](../../docs/adr/0032-programming-helper-thread-driven.md) · [批次总入口](2026-10-24-ph-thread-driven.md) · 前置 [050](050-ph-conversation-list-and-history.md)

## 目标与边界

把尚未归属 Thread 的 PH 存量 Session 按明确接续血缘归并为 WorkThread。会话正文与 Session index 不改写；既有线程成员跳过；one-shot 派生会话排除；分支来源作为审计信息保留，分支本身建独立单代线程。歧义链不自动合并。

真实用户数据执行前必须完成预览审核并得到用户明确确认。此工单已生成只读预览，但没有向真实 ThreadStore 写入任何记录。

## 实施

- `scripts/ph-thread-migration.js`：从 PH session index 解析 compacted successor 血缘，生成线性链 / 单例组；识别多后继、多前驱、环、重复 ID、悬空 source 与缺失 source；记录 branch provenance 与 one-shot 排除项；按框架 WorkThreadRecord 契约生成记录。
- `scripts/migrate-ph-threads.mjs`：预览文件以 `wx` 创建，不覆盖既有预览；apply 必须提供计划 hash、备份目录与线程目录。apply 校验源 index revision/hash、计划完整性、成员分区、当前线程成员快照，并拒绝把备份目录放在线程存储根目录内；先备份 session index 与 Thread archive index，再经现有 `ThreadStore` / `ThreadArchiveIndex` 写入。已归档 head 对应线程归档标记。完成清单用于同计划幂等重跑；若中途失败，保留备份与已处理 ID，不静默删除可能已被观察的线程记录。
- `.tmp/ph-thread-migration-preview-verified.json`：当前只读真实数据预览产物，不入库；包含完整成员与歧义明细，是本次只读评估的依据。

## 验收证据

- `node --test test/ph-thread-migration.test.js`：11 项通过。覆盖线性 successor 链、单例、branch 独立线程、歧义多后继、重复 ID、悬空与缺失血缘、cycle、one-shot 排除、ThreadStore 实际写入与独立回读、head 归档映射、同计划重跑、预览不覆盖、备份目录隔离和过期源索引拒绝。
- `node --check scripts/migrate-ph-threads.mjs` 与 `node --check scripts/ph-thread-migration.js` 通过。
- 真实数据只读预览（2026-10-25）：索引 revision `13474`，plan hash `fdfb92c524c0d54bd42e2826257c30fd4ad8e3d316a1a53e7664f148241648da`。预览将 2669 条索引会话划分为 2603 条待迁移候选、11 条已线程化跳过、55 条 one-shot 排除；可自动规划 1420 个线程（962 单例、458 多会话链，最长 17 条），另有 45 个歧义分量（40 个多后继、5 个悬空 source）。执行器对含歧义计划拒绝写入，因此没有迁移真实数据。此结果是该索引快照的只读统计，不代表执行结果。

## 操作

使用当前 PH 用户索引生成预览（只读读取真实数据）：

```bash
node scripts/migrate-ph-threads.mjs --index default --preview .tmp/ph-thread-migration-preview-<date>.json
```

`default` 指向当前 PH 用户索引；预览会同时读取真实线程索引以排除已在线程中的成员，但不写入用户数据。输出路径已存在时命令会失败，避免覆盖审核中的计划；每次新预览请使用新路径。

真实数据执行需先审核完整预览，处理歧义并重新生成计划。执行命令必须显式提供真实 session index、`--threads-root`、新备份路径、确认 hash 与 `--allow-user-data`。线程目录备份包含原线程归档索引；session index 本身不修改。当前计划含歧义，执行器会拒绝，且本次未获真实迁移授权。
