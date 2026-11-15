# 会话菜单的应用声明面：设计与实施计划

日期：2026-11-15
状态：P1+P2 已实施（2026-11-15，全量测试通过）；P3 按需后置（ADR-0049 承载决策，本文承载形状与阶段明细）
关联：[ADR-0049](../adr/0049-session-ops-fact-and-menu-declaration.md)、[ADR-0045](../adr/0045-external-plugin-package-and-workspace-assembly.md)、[ADR-0032](../adr/0032-programming-helper-thread-driven.md)、[ADR-0046](../adr/0046-plugin-management-product-system.md)

## 问题

左侧列表里不同 APP 的对话，右键菜单内容不同。差异目前写在壳层前端，不随 APP 走：

- `public/src/modules/ctx-menu-items.js` 用硬编码集合 `CTX_SESSION_OPS_AGENTS = new Set(['programming-helper', 'agent-studio'])` 决定谁能拿到完整会话操作菜单。
- 「移动到…」一项写死 `ns === 'programming-helper'` 才出现。
- `test/slash-commands-thread-ops.test.js` 的头注说明 slash 命令面复用同一个 `ctxSessionOpsAllowed`。sessionOps 是产品事实，被菜单和 slash 两处消费，真相却是一份代码内清单。
- `server/routes/agent-discovery.js` 把 metadata.json 全量展开进 agent 记录（`...metadata`），`kind`、`launchMode`、`threadHost`、`titlePolicy` 都是这么到的前端。菜单差异没有走这条声明通道。

后果：APP 卸载后壳层为它写死的分支留在宿主源码里；新 APP 挂载带不来自己的菜单项；`workspace-creators.js` 脚手架生成的用户 APP 只能拿到空菜单，想有差异化就得改宿主。这挡住了工作空间应用化的「整体打包、整体卸载、整体挂载」。

## 目标

- 菜单差异随 APP 定义走：prebuilt APP 声明在 metadata.json，外部插件 APP 声明在 manifest v3，同一 schema。
- sessionOps 成为声明的产品事实，菜单、slash 命令、会话对话框从同一来源派生，删掉代码内清单。
- APP 能贡献自定义菜单项，动作处理器随 APP 的前端插件模块走，右键时懒装载。
- 禁用或卸载 APP（插件）后，它的菜单项在下一个声明周期内退场，对齐 ADR-0045 面板声明的退场语义。

## 非目标

- 不做内建项族的逐条声明化。归档在线程与会话两种语义间的自动切换、线程 busy 才显示停止、历史数大于零才显示历史，这些动态语义留在宿主。
- 不做菜单项图标、样式定制，不做子菜单（进开放问题）。
- 不做用户级菜单显隐覆盖（呈现配置哲学下是后续课题）。
- 不动 APP 条目本身的右键菜单（`agent-context-menu`），那是另一个面。
- v1 不支持远程叶子上的自定义项（见「接受的取舍」）。

## 设计空间

四个结构不同的候选，按同一组维度比较：

| 维度 | A 纯事实声明 | B 全声明菜单树 | C 事实选族加贡献项 | D 运行时注册 |
|---|---|---|---|---|
| 随包装卸 | 事实可，菜单项不可 | 完整 | 完整 | 完整 |
| 公开面 | 一个布尔 | 谓词 DSL，大 | 小 schema 加小谓词词表 | ClawHost.menus 新 API |
| 动态语义 | 留在壳层 | 要用 DSL 表达，宿主内部状态泄漏 | 族内保留 | 留在处理器 |
| 装载经济 | 无影响 | 无影响 | 无影响，处理器点击时懒装载 | 差，为拿菜单要急切装载插件 |
| 远程适配 | 能力位现成 | 谓词要远程求值 | 能力位沿用，自定义项隐藏 | 处理器在本机，不可用 |
| 迁移成本 | 小 | 大 | 中 | 中 |

各候选一句话结论：

- A（metadata 只声明 `sessionOps: true`，壳层模板不变）解决白名单硬编码，不解决整体打包。作为终态不够。
- B（APP 声明整棵菜单树，内建项也作为数据）包装完整，但「线程 busy 时显示停止」「归档态切换文案」这类语义要么塞进谓词 DSL，要么退化。每个 APP 还要复制八行样板。
- D（插件 mount 时经 ClawHost 注册菜单）时序错位。侧栏菜单在插件装载前就要可用，为拿菜单急切装载全部 APP 插件违背按需装载。但它的 owner 作用域动作注册机制（`registerActions` 加 `unregisterActionsOf`）正是自定义动作需要的。
- C 是底座。

合并决定：C 为底。C 的事实层就是 A。处理器分发复用 D 的 owner 作用域注册机制。B 的「声明是数据」保留，但内建族不出门。

## 数据形状

prebuilt APP 的 metadata.json 与外部插件包 manifest v3 用同一 schema：

```jsonc
{
  "sessionOps": true,                    // 顶层产品事实，同 threadHost / titlePolicy 一个层级
  "ui": {
    "sessionMenu": {
      "items": [                         // 可选。v1 只追加，不与内建族交错
        {
          "id": "ph.move",               // 必填。APP 内唯一，^[a-z0-9][a-z0-9.-]*$
          "label": { "zh": "移动到…", "en": "Move to…" },
          "action": "claw:move-session", // 必填。两类绑定见下
          "when": ["not-archived"],      // 可选。宿主谓词词表
          "danger": false                // 可选。破坏性样式标记
        }
      ]
    }
  }
}
```

事实与项的分工：

- `sessionOps: true` 选中内建会话操作族（重命名、AI 标题、待办、会话接续、复制 ID、历史、归档、停止、重启、删除）。族内部的动态语义（线程归档优先、busy 才显示停止、assembly 会话排除接续项）由宿主求值，声明不涉及。
- `threadHost: true` 维持现状：线程宿主的叶子走线程语义菜单，这是宿主从声明派生的事实，不是菜单偏好。
- `items` 追加在全部内建族之后，自成一段。v1 不提供与内建项交错排序。

动作绑定两类：

- `claw:<name>`：宿主内建动作。`dispatchCtxAction` 剥前缀后走既有 switch。引用不存在的名字算声明错误，边界校验拦，前端兜底报错不吞。
- `plugin:<pluginId>.<name>`：APP 前端插件模块的处理器。点击时 `ensurePlugin(pluginId)` 懒装载，模块 mount 时经 `registerActions(actions, owner=pluginId)` 注册，分发走 `ClawFW.actions` 查 `<pluginId>.<name>`。装载失败给显式错误态，不自动重试，对齐 plugin-manifest 的装载失败纪律。声明是数据，菜单项在处理器装载前就可见。

谓词词表（v1 三个，宿主求值；未知谓词按声明错误处理，项跳过并告警）：

- `not-archived`：会话或其线程未归档。
- `has-thread`：会话归属某线程。
- `thread-busy`：线程处于 executing 或 pending-commands。

i18n：`label` 是 `{zh, en}` 纯数据，宿主按 `currentLanguage` 解析并回退另一语言，与 `feature-ui-registry.js` 的 `toHostMeta` 同款。

## 模块边界与数据流

两源一汇：

- 源一（prebuilt）：metadata.json 经 `agent-discovery.js` 扫描。扫描时 `normalizeSessionMenu` 校验并归一（非法项丢弃加启动警告），对齐 permissions 的 normalize 先例。声明随 agent 记录经 /api/agents 到前端，不新增传输。
- 源二（外部插件，P3）：manifest v3 的 `ui.sessionMenu` facet 经 `plugin-ui.js` 同族合成（素材乘装配事实，禁用与卸载停发），`/api/feature-ui/declarations` 载荷增加 menus 数组，`feature-ui-registry.js` 消费。
- 汇：新模块 `public/src/modules/session-menu-decls.js`。职责三件：合并两个来源的声明（按 agentId 键控）、求值谓词、暴露 `sessionOpsAllowed(ns)` 单一事实源。菜单和 slash 命令都从这里读事实。

改动面：

- `ctx-menu-items.js`：`getCtxMenuItems` 从按 app id 分支改为「事实选族，声明项追加，谓词过滤」；`dispatchCtxAction` 增加前缀路由。
- `slash-commands.js`：`ctxSessionOpsAllowed` 的消费换成 `session-menu-decls` 的同源事实。
- 退役清单：`CTX_SESSION_OPS_AGENTS` 集合、两处 `ns === 'programming-helper'` 分支、旧静态菜单路径（`context-menu.js` 的 `openSessionContextMenu` 与 index.html 的 `#session-context-menu`，实现期先核实无活调用方再删）。
- 远程叶子：内建族沿用 `RemoteConnections.capabilityFor(ns, 'sessionOps')` 能力位门控，语义不变。远程主机的声明派生事实由握手能力位承载，本机不再查远程 APP 的 metadata。

## 迁移路径与阶段表

每阶段以测试收尾，测试不绿不进下一阶段。

- P1 事实声明化（已实施，2026-11-15）。`programming-helper` 与 `agent-studio` 的 metadata.json 增 `sessionOps: true`；`ctxSessionOpsAllowed` 改读 agent 记录事实；slash 消费换同源；删集合。改 `frontend-ctx-menu-items.test.js`、`frontend-thread-ctx-menu.test.js`、`slash-commands-thread-ops.test.js` 夹具为声明驱动。验收：三个测试文件全绿，菜单与 slash 行为与迁移前一致。
- P2 自定义项管道（已实施，2026-11-15）。items 声明的渲染、谓词求值、`claw:*` 分发；「移动到…」迁移为 PH 的声明项；旧静态菜单路径退役（四类发射器迁声明式：feature-creator 会话列表 ×2、fw-run 项、assembly 会话卡片）。新增声明合成与谓词过滤测试。验收：PH 菜单由声明合成，壳层无 app id 分支。
- P3 外部插件通道（按需后置：第一波只做 P1+P2，等外部插件应用的真实需求出现再启动）。manifest v3 增 `ui.sessionMenu` facet；`composePanelDeclarations` 同族合成并下发 menus；registry 合并；`plugin:*` 懒装载分发；禁用与卸载的退场。验收：用一个测试插件包携带菜单项完成导入、装配、右键、禁用、卸载全链路，菜单项随之出现与退场。
- P4 开放问题，不在本计划内实施：endpoint 型动作（HTTP 调用，远程叶子可用，memo 首页 blocks 的 `action: {type, endpoint}` 是先例）、子菜单、用户级显隐覆盖、APP 条目右键菜单声明化。

## 接受的取舍

- 我们接受自定义项只追加不交错，换取不做一套交错排序协议。需要排序的表达力时再扩。
- 我们接受 v1 远程叶子上自定义项隐藏，换取不引入远程执行处理器的问题。endpoint 型动作是出路，进开放问题。
- 我们接受内建族不逐条声明化，换动态语义留在宿主。代价是 APP 不能删改内建项。
- 我们接受 danger 自定义项没有宿主级确认弹窗，动作方自管确认 UX。宿主只负责破坏性样式。
- 我们接受右键时才懒装载插件模块带来的首次点击延迟，换零急切装载。

## 未决问题

- 谓词词表按需增长还是一次补齐？倾向按需，每个新谓词都是新的公开契约。
- 外部插件 APP 的 `plugin:<pluginId>` 与 APP 自身的 identity（agentId）是否强制同名？P3 实施时随 appPlugins 面一起定。
- agent-studio 的 assembly 会话排除接续项目前按会话 variant 求值，迁移后保持族内逻辑还是显式声明？倾向保持族内，属动态语义。
