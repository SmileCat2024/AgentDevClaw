# 会话引用拓扑：只读重建与后续持久化边界

## 目的与读图方式

本次工具用于从本机历史记录重建 **session reference 显式引用关系**，不改变平台存储，不将历史扫描结果回写成权威关系。

默认主图是严格的 **Thread → Thread** 关系图：一个节点代表一条线程，其所有 Session 合并，只有两端都能确认线程归属的关系进入主图。未归属的 Session 和无法解析的目标保留在「含未归属会话」视图中，不冒充线程。箭头 **A → B** 表示 A 引用了 B；它不是任务执行顺序，也不表示 B 是 A 的唯一原因。反复引用同一线程合并成一条边，边保留全部引用事件的 ID。

顶部「关联群」可以直接打开一组线程，无需选中节点。选择只控制右侧详情，默认不淡化其他节点；「淡化无关节点」由用户独立开启。再次点击选中节点、点击画布空白、按 Esc 或点击「取消选择」均可取消选择，保留当前关联群、范围锚和缩放。拖动平移不会被当作空白点击。需要追溯时再显式选择一跳邻居、向外追溯或反向依赖范围。

关系详情保留发生引用的源 Session、源轮次、消息数组位置，以及当时引用的目标 Session。线程是全局导航身份，具体快照是证据锚点，不需要把一整条接续链展开为多个节点。

模型的历史读取与血缘是可选辅助层，不进入默认显式引用图。成功读取表示工具返回了内容，不证明模型理解或使用了内容。

## 执行与产物

在仓库根运行：

```bash
node scripts/session-topology.mjs --out .agentdev/session-topology-run-01
```

数据根默认复用 `resolveUserDataDir()`，遵循 `AGENTDEV_DATA_DIR`；可用 `--data-root PATH` 指向隔离副本。输出目录必须不存在，且不能在源数据根之内。

输出：

- `index.html`：自包含可交互图，直接用浏览器打开。无 CDN 和外部请求，支持搜索、关系筛选、明暗主题、平移缩放和当前 SVG 导出。
- `graph.json`：Session、对话节点、聚合边、去重事件、血缘、文件摘要及警告。
- `summary.json`：扫描时间窗、覆盖率、各工作空间可读数量、显式引用关联群及警告。

默认 `.agentdev/` 已被 Git 忽略。产物包含私人标题、目录和关系信息，虽不导出会话正文，也不宜公开。脚本与测试可以入库，真实分析产物不应入库。

## 权威来源

- `local-features/session-reference/src/index.ts`：输入 metadata 的引用在 call 边界或忙时插话时转成 `source: session-reference` 的 system reminder；Feature 本身不保存引用状态。消息快照中仍保有这段注入记录。
- `server/shared/session-access.js`、`server/shared/constants.js`：workspace/prebuilt 存储选择、数据根与索引契约。分析器复用工作空间集合，但不导入可能修复数据的存储服务。
- `server/routes/session.js`：实际消息位于 `runtime.context.messages`；工具调用与结果以 `toolCalls`、`toolCallId` 配对。
- `threads/index.json`：Thread 身份与 `sessionIds` 归属；`threads/threads/*.json` 的明确 successor 字段补充接续事实。
- Session index 的 `metadata.sourceSessionId`、`resumeMode`、`branchSourceSessionId`：接续、派生与分支事实。

本次关注会话引用功能上线以来的记录；早期 v1 对话不补扫、不迁移。默认只呈现显式引用及其目标节点，早期无关联记录不进入主图。

扫描包含归档的规范索引记录，并额外纳入 `agents/*/sessions` 的 plain 历史；plain 身份使用独立 `plain:` 前缀，防止与工作空间同名冲突。备份、retired 目录、回滚历史、无索引文件不自动并入。远程目标保留寻址信息，不主动连远程主机。

## 证据提取与去重

显式引用只解析来源标记为 `session-reference`、以 `[会话引用]` 开始的 system 消息。支持实测存在的当前 `agentId:`、历史 `agent: agent/type` 和更早的 `(agent/type)` 行格式。不扫描任意正文或工具结果里的 Session ID，否则模型读回的历史会制造虚假关系。

读取记录只取 assistant 的 `session_read_overview` / `session_read_turn` 调用。工具结果经有限层 JSON 包装解码，分为返回内容、明确失败、结果未知；不以“发起调用”替代“读取成功”。复合工具内部未单独落盘的调用不推断。

去重只沿明确接续或分支祖先进行：

- 工具调用按调用 ID 识别，未保存调用 ID 时用输入锚和参数的指纹。
- 引用缺少原生事件 ID，使用目标身份、前一用户消息哈希和同形出现序号识别继承观察。轮次会在接续后重编号，不能作为事件身份。
- 独立对话中相同文字不去重。同一祖先的引用被分支复制时，事件保留在祖先，分支只作为另一处观察位置。
- 同一 Thread 内部的引用保留为事件，不画成对外协作边。

这是一种有明确边界的历史重建：摘要或裁剪改变输入锚可能导致去重不足；多次完全相同的输入在裁剪后也可能歧义。被改标为 `handoff-seed` 的引用不作为新事件提取，计入覆盖限制。精确次数不应成为生产业务账本。

## 对未来关系存储的建议

建议保存的是“引用事件”，而不是只有一对 Thread ID 的边：

1. **稳定事件身份**：入口接收引用时分配 ID，跨排队、保存、接续保持不变。事件发生与消息被复制是两件事。
2. **双层寻址**：事件保存源 Thread / Session / 消息锚，以及目标 Thread / 明确目标 Session。对话身份支持全局导航，快照身份说明当时引用了什么。跨主机时还需稳定的主机命名空间，不能只靠裸 Session ID。
3. **派生索引**：Thread → Thread 的聚合边、入边索引、关联群和递归追溯由事件投影生成，可重建；不要把投影计数当唯一权威。
4. **明确保存与失效语义**：用户提交引用、成功注入、成功读取是不同事实；目标删除、移动、分支和接续不能悄悄改写既有引用目标。

当前工具证明现有本地快照可以还原一部分关系网络；它没有实现跨节点复制、一致性、删除传播或权限控制，不能据此宣称已经有“分布式关系存储”。但它展示了下一步最有价值的基础：让引用从提示词文本中的线索，变成可持久化、可验证的事件，再由平台投影出需要的关系视图。

## 验证

```bash
node --test test/session-topology.test.js
npx eslint scripts/session-topology.mjs scripts/session-topology/render.mjs test/session-topology.test.js
```

测试用隔离临时数据验证来源过滤、历史格式、读取失败分流、接续和分支去重、独立对话不误合并、归档、缺文件告警、目标 Thread 寻址和源文件内容不变。HTML 将数据作为转义 JSON 嵌入，使用 `textContent` 呈现私人标题；测试包含脚本闭合注入字符串。

真实数据的覆盖数字与浏览器验收件随本地运行产物保存，不在本文固化易漂移统计。
