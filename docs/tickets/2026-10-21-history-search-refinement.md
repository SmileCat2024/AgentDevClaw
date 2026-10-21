# 历史搜索体验收敛

## 用户目标与授权

用户要通过高质量原文片段恢复语境，认出并找回当时的对话；已确认本方案并授权先做一版看效果。不是独立逐条消息搜索器，不引入 AI 摘要或语义检索。

## 仓库与边界

- 只改 D:/code/AgentDevClaw，在当前分支直接施工，不建 worktree，不 commit/push/切分支，不重启现有 Claw 服务。
- 先读 AGENT.md、docs/reference/design-system.md、frontend-rendering-patterns.md、相关 ADR；UI 修改前读 impeccable craft-floor。
- 已存在其他会话未提交改动：guide/基础用法/MCP配置.md；local-features/claw-help/skills/agentdevclaw-help/ 下文件；public/src/app-main.js；public/src/modules/persistent-input.js；public/src/modules/sse-client.js；test/frontend-input-convergence.test.js、frontend-msg-probe.test.js、frontend-sse-client.test.js。保留并避开这些文件。必须触及 app-main.js 时优先找已有扩展点，否则说明证据再协调，不自行覆盖。
- 禁 reset/clean/checkout 覆盖，不改无关代码，不增加依赖。完整读取待修改文件，优先复用已有逻辑。

## 交付要求

1. 正常列表与搜索共用会话条目骨架/操作能力，不维护两套脱节的会话操作实现。保留标题、更新时间、必要的待办/归档状态和更多操作；搜索上下文替代普通摘要，用量等非核心信息弱化。
2. 视觉硬约束：信息层级清楚，足够克制，遵循现有 Claw 风格。只用既有外层条目；内部无卡片套卡片、气泡套卡片、缩进套缩进；用字重字号颜色留白区分来源与内容。所有新增样式走主题 token，深浅主题和窄窗检查。控制界面增量，不重做首页。
3. 一段对话一条目，标题和正文均召回；原文短上下文预览，标清你/助手，必要时补相邻问答；原地展开更多上下文/命中。片段按消息边界生成，不泄漏 [assistant] 等内部标签。保留代码/列表必要可读结构，关键词安全高亮（不能引入 XSS）。不用 LLM 改写原文。
4. 默认当前项目所有对话（包括归档），可筛选全部/我的对话/已归档。明确搜索范围；跨项目只作显式入口（如实现需大范围改动可先不扩大，报告清楚）。远程视图身份必须来自当前项目，不误搜本地。
5. 分类过滤先于分页；真实总数与显示数，加载更多。相关度默认，可切真实最近更新，UI 排序必须生效。标题相关度 + 真实时间即可，不做复杂检索系统。
6. 区分 loading/empty/error，失败有重试。异步结果按查询、项目/宿主、请求代次隔离；连续输入不覆盖新结果，不新增 app-core 全局状态，模块局部/ClawFW。
7. 从搜索进入定位预览对应消息，可回最新。先调查聊天历史分页、原始索引/显示索引/错误组折叠等机制，复用已有消息定位能力，不能靠猜下标或固定 setTimeout 重试。正常列表进入行为不变。返回保留搜索词、筛选、展开及列表滚动位置。定位必须有身份守卫，消息不在当前 tail 时需真实加载对应历史范围。可用现有扩展模块，不动脏 app-main.js。
8. 测试用 node:test + assert/strict。后端搜索使用隔离 fixture，不能读真实用户目录。补真实前端 VM 回归覆盖，共用 renderer/搜索状态、分页排序、失败、stale 响应、定位与返回。避免 inline 复刻生产逻辑。

## 调查证据与入口

- public/src/modules/ph-session-list.js 独立简化搜索渲染，失败转空结果，stale 仅看 query。
- public/src/modules/session-list-render.js 的 _renderProgrammingHelperSessionList 内 renderPhSessionItem 为正常列表行，含状态/菜单/拖拽等；搜索 toolbar 与正常 tabs 位于此。
- server/routes/session-search-index.js 持久化全文拼接索引 VERSION=1；内容命中后才按标题排序，按 sessionId 近似时间，全部结果先截 50 再由前端分类。
- server/routes/session.js GET /protoclaw/search_sessions 有远程转发。
- public/src/modules/ph-project-actions.js 的项目切换、分页入口；app-ui.js 保存/恢复 tab 与 workspace 渲染。
- public/styles/components.css .ph-search-*、正常列表配方；base.css 主题 tokens。
- test/session-search-index.test.js、test/helpers/frontend-vm.js（以实际路径为准）。

## 验收与报告

先静态检查→定向测试→相关回归→check:cycles / diff --check。不要运行会影响其它工作线程的构建/重启。调度方负责最终浏览器验收，可启动隔离端口服务验证新 server 路由，不能重启现有 1420/2026 服务。

报告修改文件、各验证命令结果、未验证项、风险及所需重启范围。若确有需要用户决定的新契约或架构阻碍，暂停说明，不静默 fallback 或阉割目标。

## 实施与验收记录

- 正常与搜索列表共用 `renderPhSessionItemHtml`；保留标题、时间、状态与菜单。搜索原文按消息边界显示，展开按原消息顺序去重，Markdown 转可读文本后安全高亮，无内层卡片。
- 搜索默认当前项目含归档，支持标题召回、范围筛选、真实更新时间排序、筛选后分页、总数和重试。索引升级 v2，首次搜索会重建派生索引；原会话文件不改变。
- 定位复用原始消息下标及错误组 plan，展开折叠，保持搜索/展开/列表滚动；本地视图身份与远程目录 accessor 分别取权威，导航代次防抢位。
- 清除旧搜索全局 results/loading/tab；正常列表自动分页观察器只观察普通分页入口，避免搜索分页触发普通列表请求。
- 定向回归：`node --test test/frontend-ph-search.test.js test/frontend-ph-search-locate.test.js test/session-search-index.test.js test/session-search-v2.test.js test/remote-session-history.test.js test/remote-write.test.js test/ph-project-filter.test.js`，116/116 通过。
- 静态检查：改动 JS 语法检查、ESLint 零 error（既有文件 11 warning）、`check:cycles`、`git diff --check` 通过。
- 默认环境全量 core：4711 项，4706 通过、4 skipped、1 失败。失败为 `thread-quota.test.js` 的 unconfigured 用例读取真实用户配额 2 而非隔离路径；同文件用独立数据目录复跑 13/13 通过，未修改生产配置或无关测试。全局覆盖 AGENTDEV_DATA_DIR 重跑全量导致旧 OAuth、路径与子进程 fixture 的路径假设失败（25 失败），不能视为全绿。
- 浏览器：使用隔离模拟会话、无真实凭证及模型调用，在独立端口核对 1280/640 宽、深浅主题、原地展开、筛选/排序、进入命中与返回；控制台零 error/warning。远程以真实模块 VM 测试覆盖命名空间、显式宿主及代次守卫，未做远程实机端到端。
- 未提交、未推送，现有 1420/2026 服务未重启；正式使用需重启整个 Claw 服务。两条本任务 Coder 线程已归档。
- 预览 fixture：`test/history-search-browser-fixture.mjs`，数据写入 `.tmp/`，只供效果检查，不作为真实会话。

## 查询性能修复（2026-10-21）

- 优先处理查询耗时，前端呈现不变。真实服务索引覆盖 2590 段可读会话；`MCP`、`接续`、重复 `MCP` 请求分别为 3440 / 3857 / 3330ms。
- 根因：缺失 `fileMtimeMs` 的空会话以 `undefined` 对比索引中的 `0`，每次误判变化；索引还包含一个不可读会话，即使重试没有成功更新内容也全量保存；约 69MiB 的全文超过原 64MiB 缓存预算。CPU 采样确认索引 IO 与 JSON 编解码占主要耗时。
- 修改：时间戳按已有写入口径归一；只有成功刷新内容或清理删除项才保存；缓存估算预算提高到 128MiB（仍按工作空间 LRU 淘汰，非精确堆内存上限）；复用只读元数据缓存及未变化的索引；只为当前页生成片段，全部候选仍参与计数和排序。不可读文件继续重试，恢复后可召回；内存命中时删除条目也会清理持久索引。
- 验证：真实数据隔离快照、真实 `setupSessionRoutes` 注册的 HTTP 路由，临时 loopback 端口自动关闭；首次 `MCP` 485ms，后续五次请求 82–98ms。覆盖中文、英文、归档、最近更新、第二页和宽匹配；完整 JSON 响应与优化前逐字段一致（含总数、排序、片段、原始消息下标）。该耗时不包含正式服务其他负载或浏览器渲染。
- 定向回归 147/147 通过，覆盖缓存预算/淘汰、缺失时间戳无重复读写、元数据/正文更新、新增删除、显式失效、不可读文件重试与恢复、分页后片段构造，以及原搜索/定位/远程路由。语法、`git diff --check`、循环依赖检查通过；ESLint 0 error，保留原有空 catch 的 1 warning。本轮未重跑全量测试。真实数据副本仅用于手动性能验证，自动化测试继续使用临时合成数据。
- 限制：沿用 v2 JSON 全文索引，没有新增数据库或依赖；首次加载、真实内容变化时仍有索引读取/整写成本，单工作空间超过 128MiB 估算预算仍不会被保留。正式服务未重启，需重启整个 Claw 服务生效；未提交、未推送。
