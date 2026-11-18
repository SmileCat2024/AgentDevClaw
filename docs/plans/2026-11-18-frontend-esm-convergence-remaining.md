# 前端 ESM 收敛的剩余工作（P4 之后）

承接 [2026-11-17 的 P4 计划](2026-11-17-frontend-esm-p4-active-domain-zero.md)。P4 的 T1–T3 已全部落地，T5 做完了两件（`app-core` 转 ESM、三层装载入口合一），**撤桥没有做**：为了让 105 个 `app-core` 符号仍能被现有消费方取到，这批反而新增了桥键。本文记录从「文件是模块」到「依赖走模块」之间还剩什么，以及每件事的验收口径。

## 现状（2026-11-18 实测）

| 指标 | 当前值 | 含义 |
|---|---|---|
| 项目代码 classic 标签 | 21 条（悬置域 15 + 非悬置 6） | 非悬置 6 条：`kernel-state`（设计保留）、`claw-host`、`action-dispatcher`、`right-panel-registry`、`desktop-notify`、`desktop-open` |
| 桥键静态注册 / 认领 | 510 / 117 | 运行期真实键：`registeredKeys 630 / claimedKeys 624` |
| 台账（globals baseline） | 51 文件 / state 110 / behavior 387 | 活跃域已基本退出，剩余主要是悬置域与保留项 |
| `app-core` 内跨域 `defineKey` | 46 条，落在 8 个域 | 见 S2 |
| `app-core` 域桥键 | 105 个 | 消费方生产侧 105 处 `window.<fn>()` 未改具名 import |
| 测试面 | `test:core` 6652 项 / 6645 通过 / 3 已知平台失败 / 4 跳过 | 基线：`desktop-workspace`、`process-group`×2、`thread-conversation-search` |

## 剩余工作

### S1 消费方改具名 import + 夹具收敛（按域分批，主体工程）

目标是把活跃域符号的 window 中转清掉，让模块间的依赖显式化。

- **S1-a `p2-bootstrap-*` 与宿主工厂组**：9 个 `createP2Bootstrap*Host` + `createCallInterruptHost` + `createRuntimeViewCacheHost` 的取用方（`p2-bootstrap-*.js`、`project-data.js`、`sidebar-render.js`、`app-ui.js`、`runtime-view-cache-host.js`、`agent-loader-host.js`）。
- **S1-b 渲染与面板组**：`getEmptyStateHtml` / `getFeaturePanelEmptyHtml` / `setCurrentLogs` / 工作空间分类谓词族（`isUiOnlyUnit` / `isWorkspaceHostUnit` / `isWorkspaceSurfaceUnit` / `isTablessHostSurface` / `isPhStyleWorkspaceAgent` / `isUiOnlyAgentId`）在 `app-ui` / `debug-*` / `ctx-menu-*` / `ph-*` 的取用点。
- **S1-c 状态键**：宿主工厂属性访问与 classic 裸引用（`im-ui` / `im-actions` 5 键、`desktop-notify` 的 `_recentlyFinishedRuntimes`）——后两个属悬置/保留项，随 S4 定稿处理。
- **夹具收敛（本阶段真正的风险点）**：约 60 个 test 文件把上述符号当沙箱全局。改 import 后，夹具里 `window.X = stub` 的写法不再透传进模块，**编译不报错、多数测试也不红**，只在真实路径才炸。做法：`test/helpers/p2-classic-hosts.js` 的 `APP_CORE_DOMAIN` 增加「模块相覆盖回放」（参考第十批 `replayAppMainOverrides`），并把逐用例的 window 桩改为域注入；每批改完必须跑真实浏览器回归，不能只看 `test:core`。

每批一组、独立提交；单批控制在 30 处调用点以内，便于定位回归。

### S2 `app-core` 的跨域注册回归各域 owner

`app-core` 现在替 8 个域注册状态（agent-store 7、orchestration 8、session-view-storage 10、render-entry 13、panel-layout-state 1、i18n-environment 2、call-interrupt 4、agent-loader 1，合计 46 条）。这是依赖方向反着的集中式注册：域状态由 app-core 声明、由各域 claim 吸收。

S2 把这些注册搬到各域自己的模块（owner 自注册），`app-core` 只保留属于它自己的状态。前置是 S1 完成——注册搬走后，`app-core` 必须在各域 claim 之前求值这条时序约束才可能解除。

### S3 `claw-host` 转化（前置：处置 `resources-viewer`）

`claw-host` 的阻断来自 `resources-viewer.js`（classic 顶层 IIFE）经 `right-panel-registry.js` 在解析期调用 `window.ClawHost.panels.register`。deferred module 必然晚于 classic 解析，**靠装载序解不开**。

两条路，先定一条再动手：

- **A. 让 `resources-viewer` 的面板注册离开解析相**（挪到 `DOMContentLoaded` 或改为 `ClawPanels` 队列），代价是 work-group 两个面板出现时间晚一点；该文件属悬置域，需明确授权。
- **B. 等它随 work-group 重做或退役**（当前选择）。

条件解除后，`claw-host` 本身改造量不大：19 个对外裸标识符里 17 个已是桥键，需改写约 20 处引用；转完顺带退役 `right-panel-registry` 转发壳（`window.ClawPanels` 的消费方改具名 import 后删除）。

### S4 契约性保留项定稿、死代码清理、基线收尾

- **永久 classic 白名单**：`kernel-state`、`action-dispatcher`、`desktop-open`、`desktop-notify`、`claw-host`（若 S3 未解）连同 15 个悬置域文件，写进一处显式清单（`test/frontend-script-tags-gate.test.js` 已有 `SUSPENDED_TAGS`，扩成「悬置 + 保留」两类），并逐条附判据：装载时点即契约 / 外部壳消费入口 / 桥基础设施。
- **死代码清理**：`right-panel-registry` 转发壳（随 S3）、`dispatch-ui.js` 里 `dispatch-console` 已删后不可达的表单渲染路径、以及 S1 完成后零消费面归私有的符号。
- **基线收敛**：`check:frontend-globals` 修剪、`script-tags` 清单化、桥债基线随撤桥下调；`AGENT.md` 与 `docs/reference/frontend-rendering-patterns.md` 的表述按当时真实形态再核一遍。

## 每批验收（沿用 P4 配方，另加两条）

1. `node --check` 本批改动文件；
2. 目标测试全绿 + `npm run test:core` 只剩 3 个已知平台失败与 4 跳过；
3. `node test/p2-production-boot-browser-check.mjs` 通过且零 pageerror（**夹具改造批次必跑**，它是唯一能发现「替身空了但没报错」的手段）；
4. `node test/bg-panel-browser-check.mjs` 通过（真实布局断言）；
5. `node scripts/check-import-cycles.mjs` 零新增环；`check:frontend-globals` 无新增 state；
6. 变异抽查 ≥ 2 项，其中一项必须是「删掉一批里改写的 import，确认有测试能红」。

## 风险

- **夹具静默失效**（主要风险）：窗口桩面改模块注入时，误判「测试绿 = 通过」。对策：浏览器回归为每批必跑项，且夹具改造后逐用例确认注入值真的被模块读到（可在改完的首个用例里临时断言一次）。
- **时序回归**：S2 搬动注册相位后，`app-core` 与各域 claim 的先后关系变化；对策是每搬一个域就单独提交并跑浏览器回归，不合并多个域。
- **S3 的 A 路会改变面板出现时点**：work-group 的「资料 / 文档」晚于首屏出现；若不可接受，只能走 B 路等待。

## 完成定义（可验证）

1. 活跃域模块之间不再经 `window.<符号>` 取用彼此的实现与状态（桥键只剩悬置域 + 保留项消费的键）；
2. `app-core` 内的跨域 `defineKey` 归零，各域在自己的模块里注册；
3. `index.html` 项目代码 classic 标签 = 悬置域 15 + 永久保留清单；
4. `test:core` 无新增失败、浏览器两项回归通过、`check:import-cycles` 零新增环。

## 不做的事

- 不转化悬置域（`wg-*` / `im-*` / `flow-editor` / `home-dashboard` / `resources-viewer` / `dispatch-*`）——它们随各自工程重做或退役时处理；
- 不为收敛改动任何对外行为；`desktop-open` / `desktop-notify` 的「装载时点即契约」性质不因收敛而改变；
- 不引入新框架、不做与本目标无关的重构。
