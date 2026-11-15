# ADR 0049: 会话操作事实与会话菜单的应用声明面

日期：2026-11-15
状态：Accepted（P1+P2 已实施并全量测试通过：sessionOps 事实声明化、ui.sessionMenu 贡献项管道、旧静态会话菜单退役；P3 外部插件通道按需后置。实施记录见 [session-menu-app-declaration plan](../plans/2026-11-15-session-menu-app-declaration.md)）
关联：[ADR-0045 外部插件包与工作空间装配](0045-external-plugin-package-and-workspace-assembly.md)（本 ADR 解决其开放问题中 APP 插件面的第一面）、[ADR-0046 插件管理产品体系](0046-plugin-management-product-system.md)、[ADR-0032 编程小助手线程驱动](0032-programming-helper-thread-driven.md)、[ADR-0044 前端面板插件化](0044-frontend-panel-plugins-and-effect-ownership.md)、[ADR-0010 侧栏统一投影](0010-sidebar-unified-projection.md)

## 背景与问题

侧栏对话的右键菜单按 APP 呈现不同内容，差异全部写在壳层前端 `public/src/modules/ctx-menu-items.js`：硬编码集合 `CTX_SESSION_OPS_AGENTS`（programming-helper、agent-studio）决定谁能拿到完整会话操作菜单，「移动到…」写死 `ns === 'programming-helper'`。slash 命令面（`slash-commands.js`）复用同一集合：sessionOps 是产品事实，被两个面消费，真相却是一份代码内清单。

metadata 声明通道是现成的：`agent-discovery.js` 把 metadata.json 全量展开进 agent 记录，`threadHost`、`kind`、`titlePolicy` 都经此驱动宿主行为。菜单差异没有走这条通道。

工作空间应用化要求 APP 定义整体打包、整体卸载、整体挂载。现状下三者都不成立：卸载 APP 后壳层为它写死的分支留在宿主源码里；新 APP 挂载带不来自己的菜单项；`workspace-creators.js` 脚手架生成的用户 APP 只能拿到空菜单。ADR-0045 把「APP 插件面（`ui.appPlugins`）」留作开放问题，本 ADR 解决其第一面：侧栏会话菜单。

## 决策

### 1. sessionOps 升为 metadata 顶层产品事实

APP 在 metadata.json 声明 `sessionOps: true`，语义是「本 APP 的对话支持会话操作族（总结、精简、分支、归档、待办、重命名、删除）」。与 `threadHost`、`titlePolicy` 同层级。菜单、slash 命令、会话对话框从这一事实单一来源派生，`CTX_SESSION_OPS_AGENTS` 集合与 `ns === 'programming-helper'` 分支退役。远程叶子沿用握手能力位 `sessionOps` 门控，语义不变。

### 2. 菜单 = 事实选族（宿主）+ 贡献项（APP）

内建项族由事实选中（`sessionOps` 选会话操作族，`threadHost` 派生线程语义菜单），族内动态语义（线程归档优先、busy 才显示停止、历史数大于零才显示、assembly 会话排除接续项）留在宿主求值，声明不涉及。APP 经 `ui.sessionMenu.items` 追加自定义项，v1 只追加不与内建族交错。prebuilt 的 metadata.json 与外部插件的 manifest v3 用同一 schema，后者经既有声明合成通道（素材乘装配事实）下发，禁用与卸载即停发，菜单项随之退场。

### 3. 动作绑定两类

- `claw:<name>`：宿主内建动作，`dispatchCtxAction` 剥前缀走既有分发。
- `plugin:<pluginId>.<name>`：APP 前端插件模块的处理器。声明是数据，菜单项在处理器装载前可见；点击时 `ensurePlugin` 懒装载，模块经 `registerActions(actions, owner=pluginId)` 注册（ADR-0044 的效果归属机制），卸载按 owner 摘除。装载失败给显式错误态，不自动重试。

### 4. 谓词小词表，边界校验

自定义项的 `when` 用受控谓词词表（v1：`not-archived`、`has-thread`、`thread-busy`），宿主求值。声明在边界校验：prebuilt 侧 agent-discovery 扫描时归一（非法项丢弃加警告，对齐 permissions 先例），插件侧走 manifest 导入的 schema 校验。未知谓词按声明错误处理，项跳过并告警。

### 5. 不做面级菜单谓词 DSL

内建族的条目级动态语义不声明化。这是对「全声明菜单树」候选的否决：把宿主内部状态编码成公共谓词语言，公开面失控，每个 APP 还要复制样板。整体打包的完整性由「事实 + 贡献项 + 处理器模块全在 APP 包内」达成，不要求内建族出门。

## 不做清单（显式边界）

- 不做内建项族的逐条声明化、排序、删改。
- 不做子菜单、图标与样式定制。
- 不做用户级菜单显隐覆盖（呈现配置哲学下的后续课题）。
- 不动 APP 条目本身的右键菜单（`agent-context-menu`）。
- v1 不支持远程叶子上的自定义项。内建族沿用能力位；自定义项处理器在本机插件模块里，远程无法执行。endpoint 型动作（HTTP 调用，memo 首页 blocks 的 `action: {type, endpoint}` 是先例）是出路，进开放问题。

## 后果

正面：菜单差异随 APP 定义走，整体打包、卸载、挂载在菜单面上成立；sessionOps 单一事实源消除菜单与 slash 的手工同步清单；新 APP（含脚手架生成的用户 APP）不改宿主即可声明自己的菜单项；外部插件 APP 获得 ADR-0045 遗留的 `ui.appPlugins` 第一面。

代价：`ctx-menu-items.js` 的合成逻辑重构为声明驱动；三个测试文件（`frontend-ctx-menu-items`、`frontend-thread-ctx-menu`、`slash-commands-thread-ops`）夹具改声明形态；P3 需扩展 declarations 载荷与 registry 合并。

风险：谓词词表是新的公开契约，只增不删，按需增长；`claw:` 动作名成为 APP 可引用的协议面，命名要当作对外契约管理（对齐 ClawHost 面板协议 minor 冻结承诺的口径）。
