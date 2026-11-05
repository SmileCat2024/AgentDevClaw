# ADR 0043: home 门户小组件契约

日期：2026-11-05
状态：Proposed（未实施；实施计划另行立项）

## 背景与问题

home 是纯 UI 壳 APP（`kind: "workspace"` 加 `launchMode: "ui-only"`），定位是消费各工作空间提供的"小组件"的门户。widget 愿景出自 [group-chat-command-center 设计](../plans/group-chat-command-center-design.md) 第 12 节，[前端插件化规划](../plans/2026-11-04-frontend-plugin-architecture.md) 将其定为 home 的重做方向。现状三处过时（2026-11-05 代码实测）。

1. metadata 的 home.blocks 已死。`renderWorkspaceSurface` 对 `agent.id === 'home'` 直接返回 `renderHomeDashboard`（public/src/app-ui.js），blocks 不渲染。其中三张启动卡指向的 feature-creator / feature-repository / flow-workspace 全部在 HIDDEN_PREBUILT_AGENT_IDS。
2. home-dashboard.js（442 行）把提供方写死。五个数据端点、四个 APP ID、五张卡片硬编码在单个模块里，新增一个工作空间的卡片就要改这个文件。
3. 无隔离。单模块的渲染或数据失败影响整页；交互依赖 `window.hd*` 全局函数与内联 onclick。

约束：ADR-0018 规定 host API 不重造 feature-comms。ADR-0010 规定插件不对侧栏开放层级贡献。docs/adr 没有现成的 widget 隔离条款，隔离形状由本 ADR 定义。

## 决策

### 1. widget 是提供方自治的卡片单元

widget 是一个工作空间向门户提供的只读概览卡片，由一个 ES 模块承载，渲染与数据同源：

```
default export {
  id, agentId,                 // 提供方工作空间
  title: { zh, en },
  load(): Promise<data>,       // 同源 fetch，模块自持端点与缓存
  render(data, ctx): string,   // HTML 字符串，ctx 注入宿主能力
  refreshMs?,                  // 可选轮询间隔
}
```

- 交互经 ClawFW.actions 注册，owner 摘除，禁内联 onclick。
- 不建服务端 widget 描述符注册表。提供方拥有端点，数据形状不需要第二处声明。

### 2. 装载：宿主清单驱动

- widget 模块 URL 登记进前端插件清单（plugin-manifest.js 扩展 widgets 字段），home 装载时按清单动态 import。
- ClawHost 新增 widgets 命名空间（register / render / 按提供方卸载），机制对齐 blocks 两层注册表：宿主内置 widget 为 primitive 层，工作空间 widget 为 plugin 层，卸载只清 plugin 层。按插件化规划的治理要求，该命名空间的动机在规划文档登记。

### 3. 宿主容器化

- 删除 app-ui.js 的 home 特判与 metadata 死 blocks。home surface 变为一个 widget 容器 block（primitive），卡片布局来自 widget 注册序；用户自定义排序留第二期。
- home-dashboard 四张卡转为宿主内置 widget，走同一注册面。验收：容器化前后渲染输出一致（卡片级对照）。

### 4. 隔离边界（第一版）

- 渲染隔离。单个 widget 抛错显示失败态卡片，不拖垮首页。
- 数据隔离。单个 load 失败或超时只影响该卡片。
- 生命周期隔离。卸载按 owner 摘除全部注册项，沿用 unloadPlugin 兜底。
- 不做 iframe 沙箱。本地部署阶段沿用设计文档 16.3 节的倾向；开放远程访问或第三方工作空间时再引入，升级路径写入契约。
- HTML 输出遵守 escapeHtml 与 data-action 参数编码纪律。

### 5. 数据链分期

- 第一版只走同源 HTTP（load 内 fetch）。feature-comms（ADR-0018）与 runtime 活数据留第二期，出现真实需求再接。
- 第一个外部提供方选 memo 或 coder 线程概览：两者有稳定的服务端数据面，不受 IM 工程波及。IM 与群聊 widget 等 [ADR-0042](0042-im-channel-thread-binding.md) 第 1 个里程碑（核心通路）落地后再接。

## 不做清单（显式边界）

- 不做侧栏贡献（ADR-0010）。
- 不做 widget 写操作与跨 widget 通信，第一版是只读概览。
- 不对第三方插件承诺契约稳定性，沿插件化规划挂起项。
- 不做服务端 widget 聚合 API。

## 后果

**正面**：新增工作空间卡片等于提供方自持一个模块加清单一行，home 不随工作空间增长改自己的代码。失败面按卡片隔离。home-dashboard 的全局函数与内联 onclick 随容器化消亡，A1 门禁基线同步修剪。

**代价**：ClawHost 扩大一个命名空间。四张内置卡是一次行为等价迁移。

**风险与失效条件**：widget 模块 import 失败需显式失败态，对齐插件装载失败不自动重试的既有语义。清单漂移（登记了模块但提供方 APP 已隐藏）时按隐藏清单过滤，不渲染死卡片。容器化验收若只看整页截图会漏卡片级差异，验收按卡片对照。

## 关联

- [前端插件化规划](../plans/2026-11-04-frontend-plugin-architecture.md)：宿主机制、qqbot / home 转入大工程的决定。
- [group-chat-command-center 设计](../plans/group-chat-command-center-design.md)第 12 节与 16.3 节：widget 愿景与沙箱开放问题。
- [ADR-0042](0042-im-channel-thread-binding.md)：IM 数据形状的上游依赖。
- [ADR-0018](0018-feature-panel-communication-transport.md)：feature-comms 边界。
