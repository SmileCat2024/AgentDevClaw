# 前端插件化改造规划

> 创建日期：2026-11-04
> 状态：**已结项**（2026-11-06）。A / A2 / B 落地宿主底座与四个插件迁移；APP 插件化收口（qqbot 转线程化工程、home 转门户小组件工程）；Phase C 四面全部完成——右栏面板自注册、内联事件收编（427 → 11，终态全部为记录在案的语义豁免）、fw-config-panel 状态收敛、script 标签清单防线。结项后新工作（home 小组件契约、qqbot 线程化）另立规划。
> 背景：Claw 向前端插件化扩展演进——工作空间应用化（随时挂上/卸载）、扩展点持续打通而非硬编码。本规划基于对 public/ 前端的深度调研，数据全部来自源码实测。

## 一、调研结论：现状全景

### 1.1 扩展面盘点（按插件化成熟度排序）

| 扩展面 | 声明层 | 分发层 | 实现层 | 成熟度 |
|---|---|---|---|---|
| 右栏面板 | `ClawPanels.register(id, {when, title, render})` 注册表 | 注册表合流 + 上下文过滤 | `window.BgPanel` 等全局对象兜底 | **高**：只缺实现装载 |
| workspace tabs | `metadata.ui.tabs`（含 `tab.action` 声明式动作） | 声明渲染（`renderWorkspaceTabs`） | 宿主渲染 | **高** |
| home blocks | `metadata.ui.home.blocks` | **硬编码**：`renderWorkspaceBlock` 25 个 if 分支 | 三形态混杂 | **中**：缺分发注册化 |
| tab/动作执行 | `data-workspace-action` JSON 属性 | `runWorkspaceAction` | 宿主 | 中 |
| surface 接管 | 无声明 | **硬编码**：`renderCurrentMainView` 入口 if（work-group） | 独立模块（`WorkGroupUI`） | **低** |
| 事件处理 | 无 | A3 分发器已建（`ClawFW.actions`），无存量消费者 | 613 处内联 onclick / 108 全局函数 | **低**（基建已就位） |
| 跨模块状态 | 无 | 无 | `ClawFW` 袋子（三类混杂） | **低** |
| 模块装载 | 无 | 无 | index.html 140 个静态 script 标签 | **低** |

### 1.2 关键事实

- **block 插件协议已是事实**：coder-threads-ui（463 行）、memo-notes-ui（438 行）等 APP 模块形态一致——IIFE + `window.XxxUI` 命名空间 + `render()` 契约 + 内联 onclick 引自身方法。宿主侧分发是 `renderWorkspaceBlock` 的 if 分支。插件化的工作不是发明协议，是**把分发与装载从宿主代码里解放出来**。
- **右栏注册表是最佳先例**（53 行）：Map 私有存储、注册时 throw 校验、`when: {agentIds, surfaces}` 上下文过滤、`{zh,en}` i18n 元数据、render 返回 HTML string。加载顺序约束（注册方先于清单派生方）由 index.html 顺序 + 测试双重固化。
- **声明驱动纪律已立**：`metadata.ui`（entry/tabs/home blocks）全链声明驱动；`app-chat-input.js` 头注明确"公共代码不按 APP ID 分支"。存量反例：`agent.id === 'home'` 特判、work-group 接管型 if。
- **ClawFW 是三类东西的袋子**（挂载全景实测）：
  1. 真跨模块 API 约 6 键：`requestImmediatePoll` / `forceFullPollOnce`（轮询调度）、`featureCatalog`、`SseClient`、`workspaceAgents`、`actions`（A3 分发器）；
  2. 模块 UI 状态借宿约 13 键：fw-config-panel 的 `settingsTab` / `driftDialog` / `promptEditorOpen` 等（有真实跨模块读者：app-ui、model-settings），根因是 classic script 无 export，可变共享状态只能全局挂载；
  3. 下划线缓存：`_speechPresets` 等，已由 ESLint owner 模块规则治理。
- **事件链已有同构先例**：workspace tabs 用 `data-workspace-action` JSON + `runWorkspaceAction` 统一入口，与 A3 分发器 `data-action` 同构——收编内联事件有现成模式可循。

### 1.3 ADR 约束（不可违背的既定决策）

- **ADR-0010**：侧栏是统一投影（工作空间→目录→会话），**不对插件开放层级贡献**——插件化不得在侧栏开自由挂载口。
- **ADR-0018**：Feature 面板与 runtime 的通信走 feature-comms 通道（server 镜像 + SSE 订阅），host API 的 events 能力**不重造**这条链，只管前端模块间事件。
- **ADR-0024 / 0025**：APP 纯声明接入（`kind` / `launchMode` / `threadHost`）是既定方向，前端插件化是该方向的自然延伸，不是新方向。

## 二、host API 骨架（Phase A2 提案）

### 2.1 设计原则

- 从 `ClawPanels` 已验证模式提炼，不发明新形态；
- 能力克制：只开四个命名空间，需求出现再扩；
- 版本号第一天就有（内部使用阶段不做兼容承诺，对外契约缓行）；
- 与 A1 门禁自洽：host 挂载进 behavior 台账。

### 2.2 接口骨架

```
window.ClawHost = {
  version: '0.1',

  // 右栏面板（从 ClawPanels 提炼，行为对齐既有注册表）
  panels: { register(id, panel), getAvailable(ctx), getAll() },

  // home block 渲染器注册——renderWorkspaceBlock 的 25 个 if 注册化
  blocks: { register(type, renderer), render(agent, block) },

  // 槽位挂载——app-chat-input 槽位模式泛化（按签名比对，语义不变不动 DOM）
  ui: { mountSlot(slotId, signatureFn, renderFn) },

  // 前端模块间事件（会话切换/语言/主题等宿主广播；不涉 feature-comms 域）
  events: { on(name, fn), off(name, fn), emit(name, payload) },
}
```

### 2.3 ClawFW 处置（拆袋，三路）

| 类别 | 处置 | 时机 |
|---|---|---|
| 真 API 6 键 | 迁入 `ClawHost` 对应命名空间，旧键保留过渡别名 | A2 |
| 借宿 UI 状态 13 键 | 随 fw-config-panel 域改造回模块局部（读写函数化） | 随 C 阶段按域 |
| 下划线缓存 | 维持 owner 模式（ESLint 已治） | 不动 |

不整体废弃 `ClawFW`：34 个消费文件的迁移按域渐进，门禁 behavior 台账消退曲线即迁移进度。

## 三、分阶段路线图

### Phase A（已完成，23021ffd）

- A1 全局暴露门禁：`check:frontend-globals` 挂 `pretest:core`，基线 134 文件 state 808 / behavior 2272。
- A3 事件委托分发器：`ClawFW.actions`（click/change/input），协议 `data-action` + `data-args`。

### Phase A2：宿主底座（不动用户可见行为）

1. `ClawHost` 骨架落地（四命名空间 + 版本号）；
2. `ClawPanels` 收编为 `ClawHost.panels`（旧入口保留别名，注册方零改动）；
3. `renderWorkspaceBlock` 注册化：25 个 if 改为启动期注册调用，存量渲染器原地注册（行为不变，单点验证：全部 workspace 首页渲染输出与改造前一致）；
4. 装载机制 v1：APP UI 模块从 index.html 静态标签改为清单驱动 `import()` 动态装载（清单 = 服务端已知 APP 集合，非插件自报）。（已落地：memo 系 f9c8e104；coder-threads 见 Phase B）

### Phase B：第一个完整插件化试点

已完成的迁移：memo（f9c8e104，A2/B 合并落地）→ claw-guide（5e7ef89b）→ agent-studio（a789afaf）→ coder-threads（`plugins/coder/`；迁移同时修复了 f9c8e104 查表化时丢失 coder-threads 分发的存量回归——此前 coder 首页渲染「未知区块类型」，因 on-demand 无活跃线程时入口不显示而漏测）。APP 插件化到此收口。剩余两个 APP 不做载体迁移，转入各自的大工程重做（2026-11-04 决定）：

- qqbot（im-ui / im-actions，1345 行、真实全局状态与设置系统交叉）：方向已定（[ADR-0042](../adr/0042-im-channel-thread-binding.md)，Proposed）——线路绑定与接线员自身均线程化、平台连接归门户、轮次结果事件回流，两个线程化与通路切换作为一个里程碑联合交付锁死形态。界面随新会话模型重建。
- home（home-dashboard，441 行）：契约已立项（[ADR-0043](../adr/0043-home-portal-widgets.md)，Proposed）——首页消费各工作空间提供的只读 widget（类移动 OS widget），现在的 dashboard 是该愿景的静态版。契约要点：提供方自治模块（渲染与数据同源）、宿主清单驱动装载、ClawHost widgets 注册面、三层隔离（渲染 / 数据 / 生命周期）、第一版不做沙箱。
验收（从第一天机器化）：
- 装配不新增 index.html 标签；
- 挂载/卸载前后全局键 diff 断言零残留（复用 A1 扫描器）；
- block 走 `ClawHost.blocks` 注册、事件走 `ClawFW.actions` 分发、无新增全局函数。

### Phase C：按扩展面收编存量

范围（2026-11-04 实测复核）：悬置工作空间（work-group / flow / dispatch-console）与转入大工程的 qqbot / home 的模块不收编，其内联事件与全局函数随各自工程重做时消亡。
顺序（由小到大）：右栏面板实现去全局化（15 个面板集中在 app-ui.js 注册，5 个活跃面板经 `window.XxxPanel` 间接寻址：git / bg / annotations / genui / session-controls）→ 内联事件收编（规划时 613，2026-11-04 实测 513；防线基线建好后从 427 起算）→ fw-config-panel 状态回模块（占用 12 个 `ClawFW.*` 键，跨模块读者：app-ui、model-settings）→ script 标签清单化清尾（index.html 现 137 个标签：src/ 129 + vendor 5 + 根目录 1 + inline 2）。原计划的 work-group surface 声明化随 work-group 悬置取消。
每面收编完成即修剪 A1 基线，behavior 消退曲线是进度指标。内联事件面另有两道机器防线（`frontend-inline-events-gate`，变异验证过鉴别力）：ratchet——模板内联处理器（attribute 形态 + `setAttribute('on*', …)` 动态注入形态）计数只许降不许升，基线 `.inline-events-baseline.json`；覆盖——源码全部 `data-action` 字面量必须能对上注册点（分发器 `actions.registerMany/register`、插件 `actions: {}` 声明、局部 addEventListener 三种路径），丢分发（f9c8e104 同型）在测试期拦截。

进度：**右栏面已完成**（2026-11-04）。5 个 window 寻址面板（git / bg / annotations / genui / session-controls）全部迁移为模块自注册（`window.ClawHost.panels.register`，与 resources-viewer 先例同型）；app-ui.js 中央注册块只保留实现本就在 app-ui.js 内的面板。迁移中砍除了只写不读的 `featurePanels` 平行映射——渲染寻址（debug-panel-host `renderFeaturePanel`）与可见性过滤统一从 `ClawPanels` 读，落实 ADR-0010「不维护平行清单」纪律。行为等价由 `frontend-rail-panels-golden` 金样本钉住（注册面全集 + 元数据快照，搬家不许改变快照，变异验证过鉴别力）。`window.GitPanel` / `BgPanel` / `SessionControlsPanel` 命名空间仍在（生命周期钩子 onOpen/onClose 经 debug-panel-host if 链调用、badge 经 agent-data-loader 调用）——调用面收编属内联事件面与后续清理，不在本面范围。

进度：**内联事件面已完成**（2026-11-06）。防线测试先行落地（ratchet + 覆盖双断言，含 `setAttribute('on*', …)` 动态注入形态；基线从 427 起算）。按模块分批、每批一个提交全部完成：会话管理簇、静态壳弹窗（index.html 内联清零）、调试域面板、ph-settings、model-settings、session-list-render、workspace-blocks + choice-input、聊天渲染与输入系统、ph 域与工作空间 UI、配置认证、设置用量杂项、app-ui 殿后批、fw-config-panel。终态基线 11，全部为记录在案的语义豁免（2 处 mousedown 防焦点抢占、1 处 keydown 挡板、session-ui / sidebar-render 各若干处语义保留）。执行形态：线 1/线 2 由 Coder 线程并行完成（4 线工单 + 转换配方文档 [inline-events-migration-playbook.md](inline-events-migration-playbook.md)），主助手逐线验收（diff 审读 + 全家回归 + 浏览器冒烟 + 基线统一修剪）。配套改动：分发器 `invoke` 透传 async handler 的 Promise（thenable 鸭子判定——`instanceof Promise` 在 frontend-vm 沙箱会因宿主 realm Promise 遮蔽沙箱同名全局而恒 false，跨 realm 判定不可依赖）；`data-event` 支持空格分隔多类型；`data-key-activate` 声明式键盘激活（Enter/Space，保留内部按钮守卫语义）；`bindEventType` 支持 capture（`<details>` 的 toggle 不冒泡）；focusout 默认绑定 + 未声明 `data-event` 元素不响应的协议守卫。

进度：**fw-config-panel 状态面已完成**（2026-11-06）。12 个 UI 状态键（mode / section / _projectId / 弹窗开关 ×5 / 搜索态 / drift 对话框 / 能力缓存 / slash 选择器）从 ClawFW 袋收敛为 IIFE 模块局部；跨模块读改显式接口（app-ui renderFWFeatures 经 `fwGetFeatureQuery()` 读未提交搜索态，renderFWDetail 经参数快照接收分区）；settings* / _modelPresets 是 model-settings / model-preset-cache 域借宿键，保留初始化维持加载顺序兼容。行为验证：沙箱契约测试（状态键消失 / 他域键保留 / 导出面 / 动作链路 / 显式接口读写，变异验证过辨别力）；fw 面板消费工作空间在隐藏清单，浏览器不可达。

进度：**script 标签清单化已完成**（2026-11-06）。实测零死标签（历次迁移删模块同步删标签已是事实纪律）；`frontend-script-tags-gate` 三道防线固化（死标签检测、总数 ratchet 基线 `.script-tags-baseline.json`、悬置/大工程域 15 标签集合固化——只许整体删除随工程消亡，不许新增），变异验证过三道防线各自捕获目标变异。index.html 装载清单纪律注释就位。

### 挂起项

- React / Vite：不重启。重启条件（写明）：滚动类 bug 密集复发且事件收编后仍压不住。
- 第三方插件契约：host API 对外稳定性承诺随 Phase C 完成解锁评估——是否冻结版本、何时对外，由后续独立决策，不在本规划内定。

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| blocks 注册化改变渲染时序 | A2 单点验证：改造前后全部首页 HTML 输出 diff 为空 |
| 动态装载引入加载失败面 | 装载 v1 只覆盖已知 APP 集合，失败降级为现状的"加载中"占位 |
| host API 膨胀成新袋子 | 每个新命名空间需在本文档登记动机；评审看 version 字段变更史 |
| work-group 拆解周期长 | surface provider 声明化先行，单体拆解按需排期，不阻塞其他面 |
