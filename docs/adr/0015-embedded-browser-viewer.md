# ADR-0015 — 内嵌浏览器 viewer：浏览器所有权翻转与极简画面页

- 状态：Archived（调查完成，暂不实施）
- 日期：2026-09-06

## 封存结论

本记录用于保留一次关于“在 Claw 右栏显示 agent 当前 Playwright 网页”的技术调查，
不构成当前实施计划。

调查已确认：

- 官方 `playwright-cli show` 能提供实时控制台，但界面口径不符合 Claw 的右栏需求；
- 自有浏览器 + `attach --cdp` + CDP screencast 在 Windows 真实环境中可行，且现有
  refs、find、fill 等命令可以继续工作；
- 该完整方案会把现有 CLI adapter 扩展成浏览器宿主，新增浏览器、CDP、帧流、
  HTTP/WS、token、端口寻址和多 runtime 生命周期，重量明显高于普通 UI 面板；
- 现有 daemon session 可以直接执行 `screenshot --filename=<path>` 获取当前页面 PNG，
  因此将来若重新启动需求，可优先评估不改变浏览器所有权的低频观察版。

最终决定：**本次不实现内嵌 viewer，不翻转浏览器所有权，不新增 viewer 服务；本记录
到此封存。**

## 问题：agent 操作的浏览器，用户看不见

playwright-shell（2026-09-06 Windows 修复与登录档案调查）
让 agent 能驱动浏览器取证与操作，但浏览器画面用户不可见——headless 无窗口，
headed 弹出的独立窗口游离在 Claw UI 之外。需求（用户 2026-09-06 提出）：

> 右栏里渲染 agent 正在操作的网页画面——就是"一个网页"，不是控制台。

诉求边界（用户裁决）：

- 要**当前网页本身**：一块等比缩放的画面 + 一条状态（当前 URL / 档案），
  像 VSCode 的 Simple Browser 那样干净；
- 不要官方 `playwright-cli show` 控制台：它的会话列表、工具栏、术语体系
  是它自己的口径，与 Claw 设计语言不统一，且不可定制。

配套需求：viewer 必须与登录档案（`open --profile`，同日已落地）是同一套
浏览器——用户看到的画面就是 agent 带着登录态操作的那个页面。

## 两个可行性前提（2026-09-06 POC 实证）

### POC 1 — 浏览器所有权翻转后动词面不变

feature 用 playwright 库 `launchPersistentContext` 自启浏览器
（`--remote-debugging-port`），官方 CLI `attach --cdp=http://127.0.0.1:<port>`
挂接为会话后，`snapshot`（refs 体系 e2/e3）、`find`、`fill` 全部原样工作。
**动词面零重写。**

### POC 2 — 画面流独立可取

任意客户端 `chromium.connectOverCDP(<端口>)` 后
`Page.startScreencast` 即收到 JPEG 帧流（实测 19KB/帧）。画面通道与命令
通道解耦，viewer 独立连帧源。注意：帧需 `screencastFrameAck` 确认才会
续流（viewer 服务端职责）。

反向前提不成立（排除捷径）：daemon 代管的浏览器走
remote-debugging-pipe，`list` 无端点暴露，外部取不到画面流——
"沿用 daemon 浏览器、只加画面"此路不通，所有权翻转是必要条件。

## 方案

### 架构

```text
agent runtime 进程（feature 内）
  ├─ OwnedBrowser：launchPersistentContext(profileDir, headless,
  │                --remote-debugging-port=0)
  ├─ attach：CLI attach --cdp=<DevToolsActivePort 解析出的端口>
  │          → 既有动词面（open/goto/snapshot/find/fill/press/click/
  │            tab-list/tab-select/close）经 daemon 转发，零改动
  ├─ FrameSource：connectOverCDP → Page.startScreencast（服务端 ack）
  └─ ViewerServer：127.0.0.1:<port> 的极简 HTTP 服务
       ├─ GET /view?token=…   → viewer 页面（iframe 目标）
       ├─ GET /stream (WS)    → 帧流 + URL/标题元数据（一条通道）
       └─ 画面 = 等比缩放的 canvas + 一条 Claw 风格状态条，别无他物

Claw 前端右栏
  └─ iframe http://127.0.0.1:<viewerPort>/view?token=…
```

### 设计决策

**所有权 = launch 换 attach。** 浏览器进程由 feature 启动与回收，daemon
降级为"命令转发器"。登录档案目录由 launch 直接指定，`--profile` 登录态、
站点记录（agentdev-sites.json）全部原样保留——viewer 看到的就是登录态会话。

**显示模式从动词 flag 升为装配配置。** headless 浏览器无法中途变 headed，
`--headed` 不再是运行时开关。launch 参数由 feature 配置/env 决定（缺省
headless）。人工首次登录场景 = 配置成 headed 后 `open --profile`。`--headed`
flag 保留但降级为校验提示（当前装配是否 headed），不再触发启动行为。

**单活跃档案（v1）。** 档案在 launch 时绑定，运行中切换 = 重启浏览器。
`open --profile=x` 与活跃档案不一致时结构化报错（报当前档案名），不做
热切换。多档案并行实例留 v2。

**CDP 端口动态分配。** `--remote-debugging-port=0` 让系统选口，launch 后读
`<profileDir>/DevToolsActivePort` 首行拿实际端口（Chromium 标准机制），
attach URL 由代码拼装。不占用固定端口，无冲突治理问题。

**viewer 寻址不能简单使用固定端口。** 右栏需要稳定可寻址（ADR-0006 本地
显式资源寻址），但编程助手可以同时存在多个 runtime；“每个 feature 固定
1431 端口”会发生冲突。完整方案必须二选一：由 Claw 主服务统一代理各 runtime
的动态 viewer 端口，或由宿主分配动态端口并把带 token 的地址安全回传前端。
在端口治理和身份链路确定前，不实现独立 viewer server。

**传输用 WebSocket 单通道。** 若完整实时方案最终保留 WS，帧与元数据（URL、
标题、档案名）同一条消息流，前端 canvas 绘制 + 状态条更新。服务端维护“最近
一帧”，新客户端接入立即补发，避免黑屏等待。备选 MJPEG（`<img src>` 零 JS）
实现更轻，但元数据需另拉通道；备选 SSE 不能自然承载二进制帧。

**懒启动 + onDestroy 收口。** 完整方案首次 `open` 才启动浏览器 + attach +
viewer 服务；feature `onDestroy` 依次回收 attach 会话、浏览器进程、HTTP 服务。
这组生命周期属于浏览器宿主，不应进入 AgentDev core 或 ViewerWorker 通用层。

### 重量复核与轻量阶段

2026-09-06 的复核确认：官方 CLI 的活动 daemon session 可以直接执行
`screenshot --filename=<path>`，成功得到当前页面 PNG；不需要 CDP 端口、
`launchPersistentContext`、`attach --cdp` 或自建 screencast server。因此，
“先让右栏看见 agent 当前网页”可以有一个**观察版**：继续使用现有 daemon 和
profile，只在成功的浏览器动作后更新一张最新截图，由 Claw 现有本地服务提供
给右栏预览。它不是实时视频，但能满足“用户看到 agent 正在操作哪个网页”的
核心认知，并保持现有浏览器所有权、登录态和动词语义不变。

观察版仍需一条小的状态链（最新截图路径/版本、当前 URL、标题），但不新增
浏览器宿主、不翻转 daemon 所有权、不增加 CDP/WS/动态端口/attach 回收面。
只有在观察版的刷新延迟确实不足时，才进入完整 screencast 方案。

完整方案的侵入性边界如下：

- **不污染 AgentDev core**：所有浏览器宿主和帧流代码必须留在 Claw 的
  `local-features/capability-shell`；core 只继续承载既有 agent 调试协议。
- **会增加 Claw runtime 复杂度**：浏览器进程、CDP 连接、帧 ACK、HTTP/WS、
  token、端口分配和多 runtime 路由都成为新的长期生命周期。
- **会改变当前 adapter 职责**：现有实现是“每次 spawn CLI、daemon 自己管理
  浏览器”；完整方案会把 feature 变成“浏览器宿主 + CLI attach 适配器”。
- **不会自动获得人工接管**：纯观察版不接收键鼠；键鼠接管还要增加坐标缩放、
  iframe 焦点、输入回传和并发仲裁，另算一层复杂度。

**close 语义保持"关页面"。** `close` 关当前 tab，浏览器进程与 viewer 驻留
（viewer 价值在持续观看，频繁杀浏览器会让画面反复黑屏）。浏览器进程只在
onDestroy（或未来显式 shutdown 动词）回收。SKILL.md"用完 close"纪律保留，
语义更新为"结束当前页面"。

**安全边界。** viewer 服务只绑 127.0.0.1；`/view` 与 `/stream` 带 launch
时生成的随机 token（经既有 Inspector snapshot 字段上报，前端拼 iframe
URL）——防本机其他进程无授权观看。token 机制复用
`normalizeHookInspector` 的字段链路时，须同步更新前端与框架
`viewer-html.ts` 两处 normalize（既有陷阱，见 CLAUDE.md）。

### 动词面重映射表

| 动词 | 翻转后语义 |
|---|---|
| `open '<url>'` | 首次：启动浏览器 + attach + 建 page + 导航；后续：当前 page 导航 |
| `open --profile=x` | 与活跃档案一致才放行，否则结构化报错（报当前档案） |
| `open --headed` | 校验装配是否 headed，不符则提示（不触发启动行为） |
| `close` | 关当前 page；浏览器进程与 viewer 驻留 |
| 其余会话动词 | 不变（经 attach 转发） |
| `profile-list` | 不变（读档案目录） |

## 迁移顺序（每阶段可独立验收）

1. **Phase 1 — OwnedBrowser 生命周期**：launch/port 解析/attach/onDestroy
   回收，单测覆盖（注入 spawn 与 fs 替身）。
2. **Phase 2 — FrameSource**：CDP screencast 封装（含 ack、最近一帧缓存、
   断线重连），单测用 CDP 替身。
3. **Phase 3 — 观察版（推荐先做）**：复用 daemon 的 screenshot 动词，
   在会话动作成功后更新最新 PNG；通过 Claw 现有服务/状态链路向右栏提供
   图片、URL、标题。验收：不改变浏览器所有权和现有动词语义，真实 Windows
   session 可看到最新页面。
4. **Phase 4 — ViewerServer + viewer 页面（仅在观察版不足时）**：HTTP+WS
   服务与极简页面，token 校验；先解决多 runtime 寻址，再做真实浏览器帧流 E2E。
5. **Phase 5 — 动词重映射与语义更新（仅完整方案）**：open/close/flag
   重映射落地，SKILL.md 与策略描述同步；全量 feature 测试绿。
6. **Phase 6 — 前端接入**：右栏极简 viewer + 状态链路；若走完整方案，
   同步 inspector 字段链路（两处 normalize）；往返测试驱动。

## Considered Options

- **iframe 官方控制台**：实现最省，但样式/术语/交互不可控，用户明确否决
  （口径不统一）。rejected。
- **沿用 daemon 浏览器 + CDP 实时外接画面**：`list` 无端点、pipe 不可外接，
  实时 screencast 技术不可行；但复核发现可以复用 daemon 的 screenshot 动词
  做低频观察版，因此完整实时方案 rejected，观察版保留为 Phase 3。
- **iframe 直接嵌目标 URL**：X-Frame-Options/CSP 大面积拦截；且那是用户
  自己浏览器的实例，与 agent 的浏览器（登录态、操作）完全无关，看到的
  不是 agent 在操作的页面。rejected。
- **轮询 page.screenshot 充当实时帧源**：低频截图确实可以对活动 daemon
  session 工作，但刷新频率、磁盘/传输开销和动作后时序不适合伪装成视频；作为
  观察版保留，作为实时帧源 rejected。
- **自研浏览器 + 自研命令面（不用 CLI attach）**：refs 体系（snapshot
  编号、find）是 playwright-core 内部能力，自研等于重写并长期追平上游。
  attach 实证可复用，rejected 自研。

## 关联

- `local-features/capability-shell/src/playwright/`：当前 Playwright shell
  adapter、profile 和平台兼容实现；本记录不改变其现有会话后端。
- 登录档案（`open --profile`）：档案目录与站点记录原样保留，launch 直用。
- ADR-0006 本地显式资源寻址：viewer 端口与 token URL 遵循显式寻址；
  CDP 端口动态分配是 Chromium 标准机制的例外（实际端口经
  DevToolsActivePort 显式读取）。
- 前端接入将触碰 `docs/frontend-rendering-patterns.md` 的 inspector 字段
  同步纪律（两处 normalizeHookInspector）。
