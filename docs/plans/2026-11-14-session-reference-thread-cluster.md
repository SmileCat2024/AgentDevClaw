# 会话引用线程化与关联群注入（session-reference thread cluster）

日期：2026-11-14 · 状态：已实施（本文档为实施记录）· **2026-11-18 修订**：目标 2 的关联信息从"引用时注入 reminder"改为"读取时随 session_read_overview / session_read_thread 返回附带"，原 `[会话引用·关联线程]` 关联 reminder 退役（见文末修订记录） · 背景：feat/session-reference-topology 分支的离线拓扑工具与本地一周实测——显式引用口径下 41 条活跃线程构成 9 个关联群；掺入读取边后坍缩为 3 个（最大 49 节点）

## 目标

把对话引用从"给我那个对话的上下文"升级为"把我放进关系地图的一个位置"：

1. **引用目标线程化**：被引会话属于线程时，引用 reminder 以 threadId 为主身份注入，附一行"被引代"锚点（sessionId + 标题）；无线程归属维持会话引用现状。
2. **关联群地图注入**：注入引用时同步给出被引线程的一跳邻居（谁引用它 / 它引用过谁）与关联群规模，作为上下游上下文。（2026-11-18 修订：改为读取时附带，引用时不再注入）

## 决策账本

| # | 决定 | 理由 |
|---|---|---|
| D1 | 引用目标线程化（threadId 主身份 + 被引代锚点；无线程回退现状） | 读侧 `session_read_overview` 的 wt- 双模寻址已就绪；模型拿到工作流全貌 |
| D2 | 关联信息 = 一跳邻居 + 分量规模一句话 | 与"上下游"语义对齐；全分量在大簇膨胀（实测周最大 11 线程 56 会话） |
| D3 | 关联数据历史重建 + 派生投影缓存（落盘 + 增量刷新） | 存量 809 个引用事件是主要价值；投影可重建，不构成第二事实源 |
| D4 | 边口径只用显式引用（`source: session-reference` 且 `[会话引用]` 开头的系统消息），不掺读取边与系统推断 | 实测对照：加读取边后周窗口从 9 个有意义的分量坍缩为 3 个（49 节点巨分量） |
| D5 | 形态是地图非内容（线程身份+方向+次数），内容靠既有检索下钻 | 群信息是系统补充的，克制以免稀释注意力 |
| D6 | 本期不动 picker UI；跨 agent 边如实注入；引用账本 schema 不动（账本仍记会话身份）；事件持久化留作后续演进 | 克制增量 |
| D7 | 投影服务采用 stale-while-revalidate：新鲜度窗口（10min）过期后的查询立即服务旧快照并后台重验证；只有进程内尚无快照（首建）才 500ms 竞速、超时降级 partial | 真实数据上增量刷新的成本大头是枚举全部存储目录（约分钟级），若让查询等待，每个新鲜度周期都有一段全部降级 partial 的窗口；关联是可陈旧的派生提示（builtAt 随响应披露），陈旧服务优于缺席 |

## 架构落点

- **投影（数据面）**：`server/session-relations/projection.js` —— 扫描会话快照中的引用 reminder，聚合 thread→thread 边；缓存落 `用户数据根/session-relations/cache.json`（tmp+rename 原子写），按会话 updatedAt 水位增量刷新；线程归属读 `threads/index.json` 现值（投影时刻解析）。只读扫描，不写会话数据。进程内 memo + 启动预热（server.js `warmRelationsProjection`）；查询服务语义见 D7（stale-while-revalidate）。
- **端点**：`GET /protoclaw/thread_relations?threadId=wt-…`（`server/session-relations/routes.js`，server.js 注册；`?agentId=&sessionId=` 为会话反查路径，`?refresh=1` 强制重建）→ `{ threadId, resolvedThreadId, resolvedThreadTitle, generations, found, neighbors[{threadId,title,direction,count,lastSeenAt}], component{size,memberThreadIds}, builtAt, partial }`。
- **注入（feature）**：`local-features/session-reference` —— `checkAvailability` 顺带解析 session_record 已返回的 `threadId/threadTitle`（不新增请求）；`renderReferenceReminder` 线程行新格式；另注入一条独立关联 reminder（见"防误抽"约束）。（2026-11-18 修订：关联 reminder 已移除——feature 仍经同一端点反查线程身份用于引用行升级；关联信息的消费面改为读取工具返回附带）

## 关键契约与约束

- **reminder 线程行新格式**（与旧格式同骨架，首 token 即寻址身份）：
  `- wt-xxx「线程标题」 — agentId: <agentId>（身份: main，线程对话 · 被引一代: <sessionId>「标题」，共 N 代）`
- **防误抽**：关联注入是独立 system 消息，前缀 `[会话引用·关联线程]`（不以 `[会话引用]` 开头，投影抽取的 content 门不会命中），行前缀用 `·` 不用 `- `——结构上不可能被引用行解析器误抽为边。（2026-11-18 修订：该消息形态已随关联 reminder 退役；修订后的关联提示位于工具结果 text 内，投影 content 门只认 `source === 'session-reference'` 的 system 消息，工具结果天然不在扫描面内，`·` 行前缀为惯例延续）
- **边语义**：source thread → target thread（A 引用了 B）；同线程内部引用不产生边；目标无法解析到线程时计入 unresolved 不产生边；邻居 `count` 是观察权重——同一条边被观察到几次（跨代复制的 reminder）就计几次，按方向聚合（out + in），只作相对权重提示，不是账本。
- **注入体积有界**：邻居行上限（默认 8 行，超出标注省略行数），关联请求失败静默省略该节——关联是补充信息，不阻塞主引用注入。

## 验收依据

1. 引用属于线程的会话 → reminder 行为 threadId 主身份 + 被引代锚点；关联 reminder 出现一跳邻居与群规模。
2. 引用独立会话 → reminder 行为与现状字节级一致；无关联节。
3. 投影：历史格式（`agentId:` / `agent: agent/type` / `(agent/type)`）与新格式都被解析；`[会话引用账本]`、非 session-reference 来源、正文中裸 ID 不产生边。
4. 增量刷新：未变化的会话不重扫（缓存命中），变化会话重扫并更新边；窗口过期后的查询立即服务旧值（stale-while-revalidate），后台重验证落地后新值可见（`freshnessMs: 0` 模拟窗口过期测试）。
5. 测试：`test/session-relations-projection.test.js`（隔离临时数据根：行解析 / 内容门 / 增量水位 / 方向与分量 / 陈旧服务与重验证）+ `local-features/session-reference/test/`（渲染与关联节注入，HTTP 面 mock）。

实施验证结论（2026-11-14）：单元测试 11/11、feature 测试 59/59 通过；真实数据（5179 会话 / 188 条边）冒烟——冷启动首查 partial 降级、首次全量构建约 80s、构建后查询 26ms 完整返回，与 D7 设计的服务语义一致。改动生效需重启 Claw 服务（server 路由 + local-features dist）。

## 限制（明确不在本期）

- 不做引用事件持久化（升一等事实）、不做 picker UI 可视化、不动读取协议与账本 schema。
- 投影只覆盖本地规范索引存储；远程命名空间目标保留寻址信息但不产生本地边。
- 计数含跨代重复观察（见"边语义"）。

## 修订记录

### 2026-11-18：关联信息从"引用时注入"后移到"读取时附带"

**动机**：关联 reminder 在模型尚未决定读取任何会话时，就注入了兄弟线程的寻址信息，实测诱导模型读取用户未引用的线程（overread），上下文预算被无关内容消耗。引用注入收缩为只携带被引对象自身的寻址信息。

**变更**（`local-features/session-reference`，服务端无改动）：

- 引用注入路径移除 `[会话引用·关联线程]` reminder（`renderThreadRelationsSection` 退役）。引用行的线程身份升级（threadId 主身份 + 被引代锚点）保留，仍经同一端点反查。
- 关联信息改为读取面附带：`session_read_overview`（sessionId 与 threadId 双输入）与 `session_read_thread` 返回体新增 `relations` 字段（`{ threadId, neighbors, componentSize, partial? }`），text 尾部附 `[线程引用关联]` 提示（一跳邻居 + 关联群规模；方向文案改为"该线程引用过 / 引用过该线程"以适配读取语境）。`session_read_turn` 不附带——单轮深读必经 overview，信息不漏。
- 降级语义与原注入一致：端点失败 / 非线程会话 / 无邻居时不附带 relations、无提示，读取主路径不受影响；邻居行上限 8 行保留；关联查询与读取主数据并发发起。

**验收**：`local-features/session-reference/test/`——注入用例改写为"单条引用 reminder，兄弟线程寻址不出现"；读取用例断言 relations 字段与文本提示，及端点失败时的静默降级。改动生效需重建 local-features dist 并重启 Claw 服务。
