# 空 assistant 消息：浏览器受控回放与证据边界

日期：2026-10-20。范围：Claw 主前端，不是 DebugHub Viewer。

## 当前结论

1. **错误聚合后的屏内空行已稳定复现并修复**：修复前，显示过程开启、连续同类错误聚合后，新增的工具-only assistant 行只剩标签；显隐切换后恢复。最小场景只有四条消息。修复后同一浏览器回放通过，并验证了隐藏过程、尾部补文与后到工具调用。
2. **该缺陷不能直接归因于最初报告**：错误聚合由 `86b18e5` 于 2026-10-16 加入，晚于引用会话的 10 月 12 日调查。
3. **旧版本的虚拟化窗口归属错误得到浏览器验证**：`ca283c9` 中，超过节点预算的会话在阅读历史时收到 append/tail，会把原先可见的调用卡设为 `process-cv-hidden`。当前代码在相同机制断言下通过，符合已有修复 `aaa0aee`。但被观察行在更新后移出视口，因此本实验不能宣称完整复现最初现场。

修复位于 Claw 的 `chat-renderer.js` 和 `input-helpers.js`，只调整前端行寻址与同步，不改消息数据、错误聚合规则、协议或 CSS。未重启服务、发送模型请求或改动用户会话。

## 反馈回路

脚本：[scripts/experiments/empty-assistant-replay.mjs](../../scripts/experiments/empty-assistant-replay.mjs)。

使用真实 Chromium，加载目标版本的生产 CSS、Markdown/JSON 模板、SessionView、消息 diff、`runMessagesProbeCycle`、append/tail/full 渲染及过程可见性代码。消息接口用内存快照模拟，排除网络、凭证与模型输出随机性；无关壳层、滚动结算被简化。虚拟化实验在注入消息期间暂停 scroll 监听，主动设置阅读窗口，用于隔离消息到达对窗口的影响，**不是完整 SSE 网络端到端实验**。

需要本机已有 Playwright Chromium，遵循 `PLAYWRIGHT_BROWSERS_PATH`，缺省使用 Claw 浏览器资产目录。脚本按正常可见性断言：发现缺陷时 exit 1，这是预期失败信号，不是测试通过。

```bash
# 修复后：错误数量对照及显示/隐藏模式的连续流式更新均通过
node scripts/experiments/empty-assistant-replay.mjs --scenario=grouped

# 原报告时期版本：预算内对照通过，预算外 append/tail 机制断言失败
node scripts/experiments/empty-assistant-replay.mjs --scenario=virtual --revision=ca283c9

# 当前版本：预算两侧 append/tail 共四组机制断言通过
node scripts/experiments/empty-assistant-replay.mjs --scenario=virtual
```

截图与 JSON 留在 `.agentdev/temp/empty-assistant-replay/<版本>-<场景>/`。`before` 表示显隐切换之前的状态，不表示修复前版本；重跑会更新产物。`results.json` 含实际样式、消息数、行数和同步入口参数。

## 已确认的当前缺陷：消息下标被误作界面行下标

### 最小消息与动作

1. 开启显示过程。
2. 加载一条 user 消息和两条 `execution.status=failed`、`error.category=server_error` 的连续 assistant 消息。
3. 两条错误被全量渲染合成一行。
4. 经真实 `runMessagesProbeCycle` append 一条 `content=''`、带一个工具调用的 assistant 消息。

修复前结果：新增行在视口内，`ASSISTANT` 标签可见，调用卡 `display:none`。切换隐藏/显示过程后调用卡恢复。重复运行获得相同结果；0/1 个错误的对照正常。

### 直接证据

| 项目 | 失败时 | 显隐切换后 |
|---|---|---|
| 消息数 | 4 | 4 |
| `.message-row` 数 | 3 | 3 |
| 最后 assistant 行在视口内 | 是 | 是 |
| 调用卡类 | `tool-call-container process-hidden` | `tool-call-container` |
| 调用卡 display | `none` | `block` |
| 同步参数 | `fromIndex=3`，`rowCount=3` | 全行同步 |

修复前的代码因果链：

- `chat-renderer.js` 的 `render()` 聚合连续错误，非组首消息返回空字符串，消息与 DOM 行的一对一关系从此不成立。
- `appendNewMessages()` 先给新调用卡加 `process-hidden`，再把**消息下标**传给 `applyConversationProcessState`。
- `lazy-tool-content.js` 的 `_applyIncrementalProcessRows()` 按**DOM 行下标**读取 `fromIndex`；`rows.length <= fromIndex` 时直接返回。此时 3 <= 3，新增卡未被揭示。
- `input-helpers.js` 的 `syncAssistantProcessOnlyRows()` 同样从 DOM 行下标 3 开始扫描，因此也没有访问最后一行。
- 显隐切换执行全行同步，去掉 `process-hidden`，所以不重新获取消息也能恢复。

单变量验证：重新制造相同空行后，不改消息、CSS、显隐模式，不重新取数，只用实际 DOM 行下标 `2` 调用 `applyConversationProcessState`，调用卡立即恢复 `display:block`。与原始 `fromIndex=3` 失败对照，确认该路径由索引口径错位造成。

这条路径没有使用超大会话、真实 API 错误请求或 SSE 竞态；聚合导致的索引不一致已足以触发。

### 修复

- append 记录插入前的实际 DOM 行数，过程可见性与出生折叠都从该位置开始。
- tail 通过已有 `msg-N` 元素定位消息行，以实际行下标同步过程缓存；结构重建后继续使用新行。
- “编辑此轮”从行内 `msg-N` 读取原消息下标，聚合后的 user 行仍绑定正确消息，assistant 行不会冒领按钮。
- 不新增延时、重试或全量刷新兜底。

## 原报告时期的虚拟化机制对照

使用相同合成消息生成大量真实 JSON 高亮节点，不强行改写预算判断。预算内约六千元素，预算外约十二万元素；两组消息数量相同，证明仅增加消息条数不是覆盖条件。

| 版本 | 预算内 append/tail | 预算外 append/tail |
|---|---|---|
| `ca283c9` | 通过 | 失败，调用卡被设为 `process-cv-hidden` |
| 当前代码 | 通过 | 通过 |

旧版本的背景消息更新重新锚定末行，当前版本由 `aaa0aee` 引入的分支使用真实视口位置。显隐切换可以重新揭示旧版本被错误隐藏的调用卡。

**限制**：严格记录 `inViewport` 后发现，观察行在消息更新引发布局变化后移出视口。该结果证明错误的窗口状态转换，不等于截图中完整复现了用户原始空行。此前初步汇报将二者等同，已明确收紧结论。原始用户现场是否属于这条路径，仍未确认。

尝试使用自然 scroll-stop 等待的回放出现等待超时，没有把超时计为复现，也未调大超时掩盖；正式脚本改为显式控制 scroll 投递并在脚本头声明边界。

## 验证与边界

- 新回归先运行失败，确认显示调用卡、隐藏模式尾部补文和出生折叠三条路径能抓住缺陷，修复后通过。
- 相关测试共 85 项通过，覆盖错误聚合、过程显隐、尾部结构重建、折叠窗口、编辑按钮、图片和渲染签名。
- 浏览器 `--scenario=all` 共 11 组通过：预算两侧 append/tail、错误数量对照，以及显示/隐藏模式下两种聚合长度的连续更新。连续更新不借助显隐切换，历史 DOM 节点保持原位。
- 最终 `npm run test:core`：4634 通过、1 失败、4 跳过。失败为 `thread-quota.test.js` 的默认无限制断言：该用例未指定隔离 settingsPath，实际得到本机 coder 上限 2。未修改用户配置或扩大本次修复范围。首轮另有两项 MCP `bad port` 失败，复跑未出现。
- ESLint：除 `input-helpers.js` 外，改动文件无错误，有既有警告；该文件被原有重复声明 `captureInputViewToken` 阻塞，已核对 HEAD 同样存在。脚本与浏览器均按现行经典 script 模式运行正常；未混入重复声明清理。

原测试缺少“错误聚合减少 DOM 行数，再进行增量更新”的组合，已补齐。未验证用户原始现场、桌面 WebView、真实 SSE 重连乱序和完整滚动结算；不将这些未知项视为已确认缺陷。本次到已确认的行寻址问题收口。
