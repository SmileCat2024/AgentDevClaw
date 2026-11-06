# 右栏面板插件化实施计划

> 创建日期：2026-11-07
> 状态：**进行中**（P0、P1、P2 已完成；P3 起未开工）
> 关联：[ADR-0044 右栏面板插件化与效果归属](../adr/0044-frontend-panel-plugins-and-effect-ownership.md)（决策依据，本计划不重复论证）；上游 [前端插件化规划](2026-11-04-frontend-plugin-architecture.md)（已结项，Phase C 完成了注册面去全局化）
> 背景与目标：新增一个右栏面板 = 一个插件文件 + plugin-manifest 一行登记，宿主 git diff 为零。总验收口径三段：挂上即用、卸了即净、坏了即显。

## 一、阶段总览与依赖

```
P0 宿主缺陷修复 ────（已完成，独立）
P1 归属补齐与 effect 面 ──→ P2 生命周期与按钮派生 ──→ P3 容器型渲染 ──→ P4 面板进插件协议 ──→ P5 存量迁移（×4）
                                                                        ↘ P6 第三方样本（衔接非验收）
```

P1 到 P5 严格串行（P1/P2 都碰 panels 注册表语义，P3 依赖 P2 的注册元数据形态稳定，P4 依赖 P1 归属与 P3 容器约定，P5 依赖 P4 装载链路）。每阶段一个 commit，即一个回滚点。

## 二、各阶段

### P0 插件宿主缺陷修复（✅ 已完成，2026-11-07）

ADR-0044 决策 2 落地，实际修复三处（第三处为核实中发现的同段实现缺陷，269 行头注声称摘除三样但 refresher-only 项漏摘）：

1. `activatePlugin`：mount 抛错时回滚本轮声明式注册项（blocks / refreshers / actions），不留半激活插件；
2. `unloadPlugin`：unmount 抛错记录后继续，摘除必达，不僵尸化；
3. 新增 `unregisterRefreshersOf`：refresher 摘除独立遍历，不再依赖同名 block 的连带删除。

接触面：`public/src/modules/claw-host.js`、`test/frontend-claw-host.test.js`（回归测试 ×3：回滚 / 摘除必达 / refresher-only）。

已知边界（留 P1）：mount() 内部经 host api 动态注册的项带不上 owner，回滚与卸载都摘不到——归属补齐阶段给 api 注册面加激活上下文的 owner 绑定。

### P1 归属补齐与 host.effect 撤销面（✅ 已完成，2026-11-07）

已落地：

1. `panels.register` 第三参 owner、`panels.unregister(id)`、按 owner 批量摘除；被摘面板经 `setPanelTeardownHook` 注入的钩子通知编排层（钩子异常不阻断摘除）；
2. `slots.mount` 第四参 owner，按 owner 摘除时一并清空槽位 DOM；
3. owner 绑定采用**绑定 api**：`activatePlugin` 构造 `makeOwnerBoundApi(owner)`（浅拷贝 + 注册方法自动绑 owner）传给 `mount(host)`，无可变全局，async mount 交织下不串；显式 owner 参数优先；
4. `host.effect(disposer)`（仅绑定 api 暴露，顶层不提供——无主 effect 无人执行，直接堵死）：`Map<owner, Set>`，执行时先取走清单，disposer 抛错记录后继续，支持 Promise；
5. 卸载与激活失败回滚同序扩展：blocks / refreshers / actions / panels / slots 摘除 → effect 清单执行；
6. **声明式 `panels` 字段随本阶段落地**（原属 P4 的协议字段部分）：`activatePlugin` 遍历 `mod.panels` 注册并归属 owner。P4 剩余范围收窄为按需装载（manifest 登记 + 打开面板经 `ensurePlugin`）；
7. debug-panel-host 末尾接通 teardown 钩子：被摘面板若正打开，置空 `activeFeaturePanel` 后走一次 `renderFeaturePanel`，复用其空面板自愈路径（清 body、撤 open、复位按钮）。

验证：frontend-claw-host.test.js 新增 6 用例（28/28 绿）覆盖动态注册零残留、声明式摘除与 teardown 通知、无主面板隔离、回滚含动态注册与 effect、disposer 抛错不阻断、钩子抛错不阻断；三个变异（禁用 panels 摘除 / 禁用 effect 执行 / 解除 owner 绑定）均被对应用例捕获；定向回归 7 文件 81 测试全绿（claw-host / 注册表 / 金样本 / rail / 启动链 / bg 面板 / script 门禁）；浏览器冒烟（本地 1420 服务）页面零错误、右栏渲染正常、服务端确认下发新代码。

遗留：全量 `test:core` 因本机多会话并发跑测试（进程树实测 5 组以上 test:core 并发）两次停滞，结果不可信；待并发窗口结束后补跑并记录。已知合理慢文件 feature-runtime（真实子进程）在并发下互相踩是主嫌疑。

### P2 生命周期与 rail 按钮注册表派生

内容：

1. 注册元数据扩展：`onOpen` / `onClose`（生命周期）、`icon`（SVG 字符串）、`order`（数字权重）；`toggleFeaturePanel` 的 if 链删除，生命周期统一经注册表调用；`window.GitPanel` 一类全局寻址随迁移消亡，bg badge 经 agent-data-loader 的调用面一并收编；
2. rail 按钮从注册表 diff 生成（`syncRailButtons`），icon / order 来自元数据；`railButtons` 全局快照改为动态查询；`CUSTOMIZABLE_PANEL_ORDER` 平行清单删除，自定义弹窗默认序从注册表派生，用户 localStorage 排序继续生效；
3. 宿主自有面板（workspace、monitor、logs、mcp、hooks、inspector、plan、settings、threads）不迁移插件化，但同样走注册表按钮生成。

验收：index.html 只留 rail 容器无手写按钮；金样本快照加入 icon / order / 生命周期字段；开关面板行为等价；拖拽排序与长按手势手动整体验证（排序读自 DOM 天然兼容，applyConfig 的 insertBefore 锚点逻辑是重点回归项）。

接触面：`debug-panel-host.js`、`rail-customize.js`、`app-core.js`（`railButtons` 消灭，全局区净收缩）、`app-ui.js`、五个面板模块、`index.html`、金样本测试。

完成（2026-11-07）：

- 生命周期（P2a）：`notifyPanelLifecycle` 统一经注册表元数据分发 onOpen / onClose；`toggleFeaturePanel` 三段 if 链与 app-ui click 处理器的 logs/mcp/resources 加载链全部删除；git / bg / annotations / genui / logs / mcp / settings / threads / resources 九个面板的钩子挂入注册元数据（模块内函数惰性引用——金样本沙箱只执行注册块，shorthand 会立即求值，此为既有约束）。`window.XxxPanel` 导出暂保留（面板测试仍引用，P5 存量迁移时收编）。
- 按钮派生（P2b）：注册元数据新增 `icon`（SVG 字符串）/ `order`（可自定义排序权重）/ `badge`（徽标 span）；`syncRailButtons` 按 [order 序 customizable + 注册序其余] 生成按钮到 rail-spacer 前，摘除面板按钮随之清理；`CUSTOMIZABLE_PANEL_ORDER` 删除（order 非空 = 可自定义）；`railButtons` 启动快照消灭（消费方全部动态查询）；index.html 15 个手写按钮删除；theme-lang 的逐按钮平行翻译清单收编为 label 元数据派生。
- 测试：新增 `frontend-panel-lifecycle.test.js` 6 用例（开关/切换生命周期分发、钩子缺失/抛错容错、按钮生成/摘除清理/语言切换 title 重算；含一个变异验证记录）；金样本快照加 onOpenHas/onCloseHas/iconHas/order 四字段，"index.html 含手写面板按钮"断言反转为守门拒绝；rail-customize 测试注册元数据补 order/icon。dom-harness 补 `contains` 与 remove 后 id 注销（与真实 DOM 对齐）。
- 验证：定向 28+13+2 全绿；浏览器冒烟——首页按钮隐藏（surface 过滤）、chat 下 8+3 按钮按序生成、plan 徽标链路通、开关面板 active/标题/内容正常、自定义弹窗清单与元数据渲染完整；check:frontend-globals 基线已更新（state 层净减 railButtons 一键）。

### P3 容器型渲染

内容：

1. `mountBody(bodyEl, host)` / `unmountBody()` 进渲染管线：打开时宿主清空 body 后调 mountBody，面板全权接管容器 DOM；切换或关闭时先 unmountBody 再清空；宿主 innerHTML 路径不触碰容器型面板内容；
2. 试点 bg 面板（现为 `preserveOnReRender` 用户，且有 elapsedTimer 与 badge 轮询需要清理，正好验证 unmount 语义）；定时器与订阅走 P1 的 `host.effect`（插件级）或 `onClose`（面板级）；
3. 轮询签名 diff 排除容器型面板——契约文档写明：容器型面板的数据刷新责任在面板自身（bg 的 refreshList 模式是先例），不参与 `renderCurrentMainView` 的重渲染。

验收：试点走容器路径；切换/关闭面板不留订阅残留（可观察点：SSE 连接数、定时器计数）；轮询高频期容器 DOM 不被重建。genui / annotations 的 `preserveOnReRender` 随 P5 各自迁移时退役，本阶段不动。

接触面：`debug-panel-host.js`（主）、`bg-panel.js`、`app-ui.js`。

### P4 面板进插件协议（范围已随 P1 收窄）

声明式 `panels` 字段的注册与归属已随 P1 落地（见上）。本阶段剩余为按需装载：

1. plugin-manifest 登记面板插件 URL；打开面板时经 `ensurePlugin` 幂等装载：装载中显示既有加载占位，失败显式错误态且不自动重试（对齐 APP 插件语义）。

验收：一个面板走完注册 → 按钮出现 → 按需装载 → 渲染 → 关闭 → 卸载全链，且卸载后重开可再装载。

接触面：`claw-host.js`、`plugin-manifest.js`、`debug-panel-host.js`（打开入口接 ensurePlugin）。

### P5 存量迁移（每面板一个可验证单元）

顺序与理由（由简到繁）：

| 批次 | 面板 | 规模与要点 |
|---|---|---|
| 5.1 | session-controls | 最简单，纯注册搬家 |
| 5.2 | git | 生命周期钩子 + badge 全局寻址收编 |
| 5.3 | annotations | ADR-0018 通道订阅（SSE）挂到面板级生命周期 |
| 5.4 | genui | 最复杂：跨进程通道 + 交互密集，`preserveOnReRender` 退役 |

每批次动作：模块化（default export panels 声明）→ manifest 登记 → 删 index.html script 标签 → 删全局对象 → 修剪 `.script-tags-baseline.json` 与 `.frontend-globals-baseline.json` → 更新金样本 REGISTRATION_HOMES 住址 → 该面板行为等价验证（含浏览器冒烟）。

### P6 第三方样本（衔接，非本计划验收范围）

Agentero library 面板做第一个第三方 vanilla 样本；预编译 React 产物经容器型通道另验。届时按 ADR-0044 决策 7 另立工程记录。

## 三、测试与门禁策略

- 金样本更新两个时点：P2（快照加字段）、P5 每批次（住址更新，字段快照不变）；
- 基线修剪随 P5 每批次执行，behavior 消退量是进度指标；
- 新防线（syncRailButtons diff 生成、容器型渲染隔离、通用卸载断言）落地时各自过变异验证——沿项目既有纪律；
- 每阶段收尾跑全量 `test:core`，涉浏览器行为（拖拽、长按、SSE 清理）另做手动冒烟并记录。

## 四、风险与对策

| 风险 | 对策 | 关联阶段 |
|---|---|---|
| 容器型面板不参与签名 diff，出现"数据更新面板不动" | 契约写明刷新责任归属；bg 试点先行暴露此类 bug | P3 |
| 按钮动态生成破坏拖拽/长按手势 | P2 验收含手势手动验证；insertBefore 锚点逻辑重点重验 | P2 |
| `railButtons` 等全局键的引用迁不干净 | 改造前 grep 全部消费点清单化，验收对照 | P2 |
| 面板 title 函数依赖 `currentLanguage` 裸全局 | 插件形态统一走 `host.env`（coder 插件先例） | P5 |
| 卸载时正打开的面板摘除引发渲染竞态 | P1 的关闭清理入口在 debug-panel-host 侧同步实现，不靠事后补 | P1 |
