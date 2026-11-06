# ADR 0044: 右栏面板插件化与效果归属

日期：2026-11-06
状态：Proposed（未实施；实施顺序见各决策节，详细计划另行立项）
关联：[前端插件化规划](../plans/2026-11-04-frontend-plugin-architecture.md)（已结项）、[ADR-0010 侧栏统一投影](0010-sidebar-unified-projection.md)、[ADR-0018 Feature-Panel 通信基座](0018-feature-panel-communication-transport.md)、[ADR-0043 home 门户小组件契约](0043-home-portal-widgets.md)

## 背景与问题

[前端插件化规划](../plans/2026-11-04-frontend-plugin-architecture.md) Phase C 已完成右栏面板的注册面去全局化：五个活跃面板模块自注册，`frontend-rail-panels-golden` 金样本钉住注册面全集，script 标签建立只减不增防线。规划对该面的评级是"高：只缺实现装载"。规划同时明确把生命周期调用面留作后续（"window.GitPanel 等命名空间仍在，onOpen/onClose 经 debug-panel-host if 链调用，不在本面范围"）。本 ADR 接续这块遗留。

剩余缺口在装载与编排层。以下为 2026-11-06 代码实测。

1. 装载静态。面板模块靠 index.html 的 script src 标签启动即全量预载（当前 133 个）。插件协议 `activatePlugin` 只注册 blocks、refreshers、actions 三个维度，`unloadPlugin` 只摘除这三样。panels 注册表没有 owner，没有 unregister。
2. 按钮静态。15 个 rail 按钮是 index.html 手写 DOM；`app-core.js` 启动时对 `.rail-button` 做一次性快照存入 `railButtons`；图标只存在于按钮 DOM 里。`rail-customize.js` 另维护 `CUSTOMIZABLE_PANEL_ORDER`（8 个 ID）的平行清单，不进清单的面板按钮被强制隐藏。这与 ADR-0010"不维护平行清单"纪律冲突。
3. 生命周期硬编码。`toggleFeaturePanel` 按面板 ID 写 if 链，经 `window.GitPanel` 一类全局对象晚绑定调用 onOpen/onClose。
4. 渲染约定单一。`panel.render()` 返回 HTML 字符串，宿主做签名缓存与 innerHTML 整体替换。`preserveOnReRender` 标志（bg、genui、annotations 在用）只能跳过重渲染，没有挂载与卸载的容器语义。自带渲染运行时的产物（如预编译 React 模块）在这条约定下无法存活，innerHTML 替换会销毁其 DOM 根。

综合后果：新增一个面板要改宿主四处（index.html 两处、debug-panel-host 生命周期链、rail-customize 清单）。第三方无法不改宿主源码添加面板。

同时 claw-host 插件宿主自身有两个 bug 级缺陷（2026-11-06 源码核对）：

- `activatePlugin` 先注册 blocks 再 `await mount()`。mount 抛错时已注册项不回滚，插件半激活。
- `unloadPlugin` 里 `await unmount()` 没有 try/finally。unmount 抛错时后续摘除全部跳过，插件僵尸化。

这两个缺陷与 dsh 项目 vendor 补丁修复的 cordis 问题同构（deepseek-harness 仓库 vendor/cordis README 的 fiber 生命周期加固补丁；对应公开故障案例见该仓库 GitHub Discussion #10040、#6723、#3056）。它们是插件宿主的通用陷阱，不需要反应式运行时就能修。面板插件化扩大装载卸载路径的使用量，这两个缺陷要先修。

## 决策

### 1. 效果归属为宿主的第一原则

效果归属指：插件经宿主注册的一切注册项与副作用，都归属该插件的生命周期；卸载时宿主自动撤销，不依赖插件自觉补写清理。claw-host 已在 blocks、refreshers、actions 三个注册面实现 owner 归属与卸载兜底。本决策把同一语义补齐到全部注册面与任意副作用面。思想来源是 cordis 的 revertible effects，实现不引入其运行时（见不做清单）。

### 2. 先修两个 bug（P0，独立先行）

`activatePlugin` 的注册序列加回滚：mount 抛错时摘除本插件本轮已注册项。`unloadPlugin` 的 unmount 调用包 try/finally：unmount 抛错记录后继续，摘除必达。各十几行，先于其余各节落地，不依赖后续任何阶段。

### 3. 归属补齐与 host.effect 撤销面（P1）

- `panels.register` 增加 owner 与 `unregister`。插件注册的面板随 `unloadPlugin` 按 owner 摘除；正打开的面板被摘除时关闭面板并清空 body。
- `slots.mount` 同理带 owner。
- 宿主 api 新增 `host.effect(disposer)`。插件在 mount 里把超出注册面的清理（定时器、事件源、observer）登记进来，卸载时宿主统一执行。注册面兜底由此升级为对任意副作用的契约。

验收口径三段：挂上即用、卸了即净、坏了即显。前两条由通用卸载断言测试机器验证：装载任意插件再卸载，注册面与 effect 清单双断言无残留。

### 4. 面板成为插件协议第四维度

插件模块 default export 增加 `panels` 字段，`activatePlugin` 注册、`unloadPlugin` 按 owner 摘除：

```
export default {
  id, blocks?, refreshers?, actions?,
  panels: {
    '<panelId>': {
      when, title, label, description,  // 既有字段不变
      icon,                             // SVG 字符串，rail 按钮图标
      order,                            // 数字，rail 默认顺序权重，小者在前
      onOpen(), onClose(),              // 面板生命周期
      render() 或 mountBody(bodyEl, host) / unmountBody(),  // 二选一
    },
  },
  mount(host), unmount(),
}
```

渲染约定双轨。字符串型走现有管线（签名缓存、焦点与滚动恢复不变）。容器型指 mountBody 存在的面板：打开时宿主清空 body 后调 mountBody，面板全权接管该容器 DOM；切换或关闭时先调 unmountBody 再清空。宿主的 innerHTML 路径不触碰容器型面板的内容。`preserveOnReRender` 面板迁移到容器型后该标志退役。

两层生命周期不混用：装载卸载（mount/unmount 与 host.effect）属于插件，打开关闭（onOpen/onClose 与 mountBody/unmountBody）属于面板。通道订阅一类随开关起停的资源挂在面板层，随装载销毁的资源挂在插件层。

### 5. rail 按钮与生命周期从注册表派生

宿主提供按钮同步：rail 按 `ClawHost.panels` 全集 diff 生成与移除按钮，icon 与 order 来自注册元数据；`railButtons` 消费改为动态查询。`CUSTOMIZABLE_PANEL_ORDER` 平行清单删除，自定义弹窗的默认序从注册表派生，用户 localStorage 排序继续生效。`toggleFeaturePanel` 的 if 链删除，onOpen/onClose 统一经注册表调用；`window.GitPanel` 一类全局寻址随迁移消亡（bg 的 badge 经 agent-data-loader 的调用面一并收编）。

宿主自有面板（workspace、monitor、logs、mcp、hooks、inspector、plan、settings、threads）继续静态预载与中央注册，不迁移插件化，但按钮同样由注册表生成。金样本随之更新：icon、order、生命周期字段进快照。

### 6. 按需装载与存量迁移

面板插件 URL 登记进 plugin-manifest.js。打开面板时经 `ensurePlugin` 幂等装载：装载中显示既有加载占位，失败显式错误态且不自动重试，对齐 APP 插件既有语义。

存量五个活跃面板按 session-controls → git → annotations → genui 顺序逐个迁移（由简到繁，genui 涉及跨进程通道）。每面板一个可验证单元：删 script 标签、删全局对象、修剪 `.script-tags-baseline.json` 与 `.frontend-globals-baseline.json`、更新金样本的注册住址（REGISTRATION_HOMES）。

### 7. 首个第三方样本（后续工程衔接）

Agentero library 面板（外部项目 agentero-dsh-plugin 的文献库 UI，vanilla 移植）作为第一个第三方样本；预编译 React 产物经容器型通道另验。此项属后续工程，不属本 ADR 验收范围。

## 不做清单（显式边界）

- 不引入 cordis 运行时或任何反应式重载机制。public/ 免编译静态直出是前端核心开发约定；语义缺口约一两百行可补齐，运行时是比例倒置。dsh 三个公开故障案例的机制根源即动态重载。
- 不做插件间 provide/inject。UI 是加法世界，插件彼此隔离，宿主供全部能力。
- 不做 waterfall 链式改写。无主题定制链需求，出现再议。
- 不做宿主自有面板的插件化迁移（见第 5 节）。
- 不在本 ADR 承诺 host API 对第三方的契约稳定性。沿规划挂起项，存量迁移完成后评估冻结版本。
- 宿主不提供构建链。容器型面板的渲染栈自选，预编译产物自带；React / Vite 引入与否沿规划挂起项的重启条件，本 ADR 不改判。

## 后果

正面：新增面板等于一个插件文件加清单一行，宿主 git diff 为零。插件作者只写挂载，清理是宿主义务（host.effect 登记）。全局对象寻址消亡，`window.GitPanel` 等退出 behavior 台账，两份基线净收缩。

代价：claw-host 扩 effect 面与 panels 归属；debug-panel-host、app-ui、app-core、rail-customize 四个宿主文件一次改造；五个存量面板行为等价迁移，金样本与两份基线随迁更新。

风险与失效条件：容器型面板不参与轮询签名 diff，数据刷新责任移入面板自身，契约文档必须写明，否则出现数据停更类迁移 bug。按钮动态生成后，rail-customize 的拖拽与长按手势需整体验收（排序读自 DOM 天然兼容，插入锚点逻辑需重验）。金样本若只钉字段集不钉注册住址（REGISTRATION_HOMES），迁移中注册面来源漂移将无断言可拦。
