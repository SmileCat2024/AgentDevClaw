# ADR 0036：会话索引存储迁移到嵌入式 SQLite（node:sqlite）

- 日期：2026-10-29
- 状态：Proposed
- 关联：[ADR-0013 消息轮询的增量探测](0013-message-polling-incremental-probing.md)、[ADR-0016 用户数据存储分区治理](0016-user-data-storage-partitioning.md)、[ADR-0032 编程小助手线程驱动](0032-programming-helper-thread-driven.md)

## 背景

会话索引（`workspaces/<agentId>/sessions/index.json`）是侧栏列表、创建、轮换与各类路由的发现层。编程小助手的索引已达 2767 条 / 4.5MB，且随使用持续增长。排查确认了结构性问题：

- **单文件 = 整文件写**。任何一条记录的变更（会话活跃时每个 turn 的 meta_sync：messageCount / preview / tokenUsage / updatedAt）都要付出"克隆全量 → 双签名比对 → 序列化 4.5MB → 原子整写"的链路，服务进程实测 `index_committed` 约 400ms。
- **写后缓存失效放大读成本**。整写使 mtime+size 缓存失效，下一个读者（前端 3 秒级轮询）重新付"读 4.5MB + JSON.parse + 逐条归一化"（服务进程 ~150ms）。为此已积累的手搓机制（缓存、并发装载去重、stampede 防护）是对文件形态的补偿，不是资产。
- **体积与活跃度严重不对称**。2767 条中 65% 已归档、90% 的体积超过 30 天未更新，7 天内真正活跃的只有 157 条——热数据与死数据混在同一个文件里，每次操作按总量付费，成本随会话总数线性增长。

两项快赢（创建免预读 `d51ad78f`、跳过冗余签名比对 `f43e8e25`）已落地，但只削常数项；O(总量) 的写放大不变。文件内的冷热分层是可行替代，对比见"取舍"。

关键事实：开发机与桌面打包链路（`pack-desktop` 钉死 `PINNED_NODE_VERSION = 24.19.0`）运行的都是 Node 24，`node:sqlite` 为内置模块、无需 flag、无需安装任何依赖——引入 SQLite 的传统障碍（原生绑定编译、按平台分发二进制）不存在。同规模实测（2767 行，开发机）：全量装载+解析 8.4ms，单行更新事务 0.23ms，SQL 过滤分页（60 条）0.24ms，`PRAGMA data_version` 可探测跨连接写入。

## 决策

### 1. 存储换引擎，API 契约不变

会话索引的持久层从单 JSON 文件迁移到嵌入式 SQLite（`node:sqlite`）。`server/shared/session-access.js` 保持全部导出的签名与返回对象形状不变（`readSessionIndex` / `readSessionIndexShared` / `readSessionIndexSync` / `updateSessionIndex` / `writeSessionIndex`）：读函数仍返回 `{ revision, activeSessionId, sessions[] }` 形态、`readSessionIndex` 仍返回可安全突变的副本、`updateSessionIndex` 仍是"读快照 → mutator → 提交"事务（含 `skipContentComparison` 选项）。`writeSessionIndex` 生产代码无调用方，但测试 fixture 与工具场景以它做全量写入，保留为显式全量替换入口（落点改写为 db）。20 余个消费方（路由、投影、线程控制、IM、搜索索引）零改动。随本决策将 `package.json` 的 `engines.node` 下限提升至 `>=24`（与桌面钉死版本对齐）。

### 2. 库文件布局与 schema

每工作空间一个库：`workspaces/<agentId>/sessions/index.db`（保持 ADR-0016 分区粒度：备份、删除工作空间 = 删目录的语义不变）。连接参数：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`。

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- revision、activeSessionId
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL, -- 数组顺序是持久事实（新会话头插、消费方遍历序），读时 ORDER BY position
  record TEXT NOT NULL,      -- 完整会话记录（归一化后 JSON）
  updated_at TEXT, archived INTEGER, project_id TEXT,
  open_directory TEXT, session_type TEXT, workspace_agent_id TEXT, created_at TEXT
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_id);
```

`record` 存整条 JSON 保证与现有对象形状逐一对应；冗余列仅服务于未来的 SQL 过滤/分页下推（后续可选阶段），写入时由同一事务从 record 提取，不构成第二事实源。`position` 是例外：数组顺序本身是持久数据，diff 时 id 序列不变则各行 position 不动（turn 级更新零重排），序列变化（头插新会话、删除、显式重排）时全量重建 position——顺序变化均为低频操作。

### 3. 读写路径

- **写**（`updateSessionIndex`）：`BEGIN IMMEDIATE` 事务内——SELECT 全量构建数组 → 执行 mutator（JS 函数契约不变）→ 指针级 diff 找出变更/增删记录 → 变更行入库前做与今日 `normalizeSessionIndexData` 相同的字段清洗（**归一化时机从读侧移到写侧**，读侧直接返回存储形态）→ `revision + 1` 写 meta → COMMIT。单条 turn 更新只改 1 行 + meta，实测 0.23ms。
- **读**（`readSessionIndex` / `readSessionIndexShared`）：进程内缓存以 `meta.revision` 为键（单次读 ~µs 级）；命中时 `Shared` 返回同一稳定对象（下游 `findPrebuiltSessionRecordShared`、投影缓存等 WeakMap 身份键继续成立），`readSessionIndex` 返回其 `structuredClone`。未命中时全量装载 + 逐行 parse（2767 条实测 8.4ms）。`DatabaseSync` 为同步 API，检查与装载之间无 await 交错，今日的并发装载去重（stampede 防护）不再需要。跨进程写探测：`PRAGMA data_version` 作为兜底（探测到外部连接提交即弃缓存重装载）。
- **同步读**（`readSessionIndexSync`）：`DatabaseSync` 直查，语义天然同步，调用方（im.js、group-chat.js）零改动。

### 4. 手搓文件机制退役

`_indexCache`（mtime+size 失效）、`_indexLoads`（并发装载去重）、`writeIndexFileAt`（唯一临时名 + rename 原子写）、`_indexLocks` 的文件形态进程锁，全部由 SQLite 的页缓存、`BEGIN IMMEDIATE` 与 WAL 取代（约 200 行补偿性机制删除）。`_indexLocks` 保留为进程内事务排队（同一连接上的串行化），跨进程互斥交给数据库锁。

### 5. 迁移与回滚

- **启动自迁移为主**：服务启动时扫描两个数据根（`workspaces/*/sessions/index.json` 与 `prebuilt-sessions/*/index.json`），对每个 `index.json` 存在的工作空间执行迁移（读 JSON → 建库 → 逐条归一入库 → 写 meta 继承文件 revision → `index.json` 改名 `index.migrated.json` 留档）。单工作空间失败按 ADR-0032 先例**告警不阻断**，保持 JSON 原状，下次启动重试。迁移在事务内完成：COMMIT 前崩溃 db 无数据、JSON 原样；COMMIT 后改名前崩溃则重试时检测到 db 已有 meta 即跳过导入、直接完成改名——两种中间态都幂等可重入。
- **访问时兜底**：运行期打开索引时执行同一检查，覆盖启动迁移失败残留的工作空间。这是一段迁移器逻辑，不是 JSON 双链路——稳态下所有工作空间都已是 db。
- **小工作空间同样统一迁移**，保持单一代码路径。
- **降级**：旧版本代码只认 `index.json`。回滚 = 手工把 `index.migrated.json` 恢复为 `index.json` 并删除 `index.db`；快照之后新建的会话不会出现在恢复的索引里，需从会话文件本体重新登记（索引是发现层，会话内容不受影响）。
- **备份**：数据库文件带 WAL 边车，热拷贝不再安全；备份走 `VACUUM INTO`（单文件产物）或停服拷贝。`node:sqlite` 的 backup 模块当前无可用导出，不依赖。

### 6. 范围边界

- plain agent 索引（`AGENTS_DATA_ROOT`，`upsertSessionIndexAt` 路径变体）数据量小且根不同，首版维持 JSON，列为可选跟进。
- SQL 原生查询（列表过滤/分页/排序下推到 `WHERE ... ORDER BY ... LIMIT`，替代 JS 全量投影）是收益可观的后续阶段，依赖决策 2 的冗余列；不做也不影响本次成立的收益。
- 直接摸 `index.json` 的旁路点跟随改造：`scripts/mirror-runtime.js`（AI 标题/回顾镜像的同步读）改为只读连接（WAL 支持跨进程并发读）；`scripts/run-prebuilt-agent.js` 的 runtime 子进程两处同步读（`resolveSessionWorkspaceCwd` 与 `SessionLifecycle.start` 解析 boundAgentId/projectId）改为 `readSessionIndexSync`（父进程写侧同一存储，WAL 支持父子进程并发）；`coder-identity-retirement.js` 等一次性迁移脚本按新布局调整；`session-search-index.js` 注释中"index.json session IDs"的提法随实现更新。`ph-legacy-migration.js` 与 `migrate-ph-threads.mjs` 是有意读遗留 JSON 的历史迁移工具（前者在启动自迁移之前运行，读的正是待迁移源文件），保持不动。

## 取舍

- **vs 文件内冷热分层**：两者改造成本相近（都收敛在 session-access.js），但 SQLite 收益彻底——行级写（0.23ms vs O(热集) 整写）、真索引、退役而非新增缓存机制；分层还需自建降冷时机与整理策略。分层方案退役为备选。
- **vs 继续 JSON 调优**：写放大是文件粒度与记录粒度不匹配的结构问题，参数调优与局部缓存只能削常数。
- **vs better-sqlite3 等第三方绑定**：需要按 Node ABI 与平台编译分发原生二进制，拖累 `pack:desktop`；内置模块零成本。
- **放弃 JSON 的可手改性**：索引不再是能文本编辑、能 grep 的文件。缓解：数据根其余部分仍全 JSON；会话文件本体是权威数据，索引丢失不损失会话内容；`VACUUM INTO` 可导出快照，`sqlite3` CLI 可直接查库。非正式的"手改 index.json 救数据"渠道关闭（本就无契约保障）。
- **同步 API 阻塞事件循环**：单操作 µs~ms 级且有界（全量装载 8.4ms），对照现状单次缓存失效 50-150ms 是改善；后续 SQL 下推可进一步消减。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `node:sqlite` 官方稳定级 1.1（Active development） | 开发与桌面运行时钉死同一版本 24.19.0；仅使用长期稳定的 `DatabaseSync` / `StatementSync` / 事务面；Node 升级时把 sqlite 冒烟加入验证清单；`engines` 下限提到 `>=24` |
| 事务内 mutator 抛错 | 与今日语义一致：事务回滚，索引不变，异常上抛 |
| 崩溃留下 WAL 边车 | SQLite 崩溃恢复自校验；`index.db` 与边车同目录，随工作空间整体备份/删除 |
| 外部直连 db 写绕过 revision | 声明唯一写者是 server（runtime 走 HTTP meta_sync）；外部写经 `data_version` 兜底探测弃缓存 |

## 不变量

- `session-access.js` 导出的签名与返回对象形状不变；除声明的旁路点外消费方零改动。
- `revision` 单调递增、每次变更 +1；`prebuilt_sessions` 的 `sinceRevision` 条件刷新契约（ADR-0013）原样成立。
- 索引是发现层：会话文件本体（`sessions/<id>.json`）是权威数据，索引损坏或丢失不损失会话内容。
- 索引数据位于 `workspaces/<agentId>/sessions/` 分区（ADR-0016）内，不新增数据根外落点。

## 验收（测试矩阵）

- 迁移：JSON→db 幂等可重入（含 COMMIT 前后两种崩溃中间态）；迁移失败保持 JSON 原状；启动迁移失败的工作空间不影响服务启动，下次启动重试；`index.migrated.json` 留档。
- 契约：revision 单调且 sinceRevision 短路成立；并发 `updateSessionIndex` 串行化（事务）；`readSessionIndexSync` 与异步变体一致；归一化输出与旧实现逐字段等价（现有 fixture 全量套件作为回归——它们以真实数据目录驱动真实函数，换引擎后应原样通过）。
- 缓存：revision 键命中/失效正确；外部连接提交后探测弃缓存（`data_version`）。
- 性能预算：meta_sync 型单行事务 < 5ms；2767 条全量装载 < 20ms；超预算按 bug 排查。
