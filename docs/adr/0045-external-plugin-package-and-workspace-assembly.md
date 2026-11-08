# ADR 0045: 外部插件包与工作空间装配模型

日期：2026-11-08
状态：Accepted（P1–P3 已实施并验证：资产通道、声明下发、数据面挂载、agentero 三面出仓、SMOKE 全链路通过；P4 收尾分批进行。实施纪要见文末；实施计划见 [external-plugin-package plan](../plans/2026-11-08-external-plugin-package-ui-binding.md)）
关联：[ADR-0017 Feature Manifest 与 Registry](0017-feature-manifest-and-registry.md)、[ADR-0044 前端面板插件化与效果归属](0044-frontend-panel-plugins-and-effect-ownership.md)、[ADR-0022 Agent Studio feature-first](0022-agent-studio-feature-first-model.md)、[ADR-0018 Feature-Panel 通信](0018-feature-panel-communication-transport.md)、[ADR-0016 用户数据存储分区](0016-user-data-storage-partitioning.md)

## 背景与问题

Feature tgz 导入链路（upload/catalog/install/provision/loader）已就绪，但只承载 Node 侧代码；前端面板与 APP 插件经 `panel-plugins.js` / `plugin-manifest.js` 两处硬编码清单接入，无法外部导入；插件自带的 HTTP 数据面只能写成宿主硬编码路由（`server/routes/agentero.js`）。agentero 以三件套形态散落主仓库三处（local-feature 工具面、server 路由数据面、React 面板 UI 面），需要整体出仓为用户可导入的形态。

DeepSeek Harness（dsh 0.2.1-rc.2）与 agentero-dsh-plugin（0.1.5）的对照调研给出三条可迁移结论：

1. cordis 插件协议只是运行时底座；从作者代码到用户可用，dsh 叠了六层产品包装（bundle / profile / UI 半发现 `dsh.client` + `exports["./client"]` / 浏览器 `/plugins/<id>/client.js` 装载 / host 半 `inject webServer` 数据面 / 市场静态 JSON 索引）。UI 与宿主能力的绑定发生在 bundle 层而非插件协议层——UI 包的宿主半可以是空壳 `apply() {}`。
2. dsh 插件页的一等公民是 bundle（宏观插件），cordis 插件行只是卡片下可展开的细节；安装与启用分离（bundle 选择 + 行级 `disabled` 覆盖行），禁用不碰安装。
3. dsh 是全局单棵组合树（profile）；Claw 是装配制（每身份独立 $mount），组织自由度更高，UI 归属与处置模型必须以工作空间为中心重新设计，不能照搬全局模型。

## 决策

### 1. 术语分层：Plugin 与 feature 是两个层级

**插件（Plugin）= 用户可导入的 tgz 包 = 分发与处置单位**，内含至多三个面：工具面（feature，增强 agent 运行时能力）、UI 面（面板/APP 入口，面向人）、数据面（HTTP 服务，面向 UI 供数）。**feature 降为插件内部能力面的组成单元**，同时保留原有含义（内置能力、运行时挂载单元）。三面全部可选，任意组合合法（纯 UI、纯能力、三面俱全），操作心智统一为"装插件"一件事。

### 2. 包格式：manifest v3，单包三面

扩展现有 feature tgz（npm pack 格式），不另起炉灶。`package.json.agentdev` 升 schemaVersion 3，新增两个可选声明：

```
package/
  dist/index.js    # 工具面：Feature class（现状已有）
  client/          # UI 面：预构建 ESM 产物（浏览器直接执行，宿主不提供构建链）
  server/          # 数据面：ESM，导出 registerRoutes(router, context)
```

- `ui.panels[]`：id、entry（相对 client/ 的入口）、scope（`assembly` | `global`）、meta（label/icon/order/when 的默认呈现建议）。
- `server`：entry、prefix。`registerRoutes` 收窄 context（config / logger / paths），不暴露 app 裸对象；宿主导入确认时动态 import、形状校验、挂载到 `/protoclaw/plugin/<prefix>/` 前缀（实施定稿：prefix 单段、全局唯一、即审计面，与包名解耦——同包升级或改名不影响 URL 契约），失败标 invalid 不连带宿主，路由异常计数熔断（连续 5 次摘除，remount 端点整体重建）。
- 兼容：`engines.agentdev` 已有；ui 面追加 ClawHost 协议版本校验（当前 '1.0'）。不声明 ui/server 的包行为不变。

### 3. 仓库：Claw 层统一托管，边界明确

现有 feature 双仓库升格为插件仓库：官方区（`resources/features/`，随产品分发）+ 用户区（`user-features/`，导入落位），同包用户区优先、同版本不同字节拒绝、digest 纪律原样继承。新增资产解出目录：导入确认时把 `client/` 解到 `user-features/assets/<package>/<version>/`，经 `GET /protoclaw/feature-assets/:package/:version/*file` 版本化 URL serve（MIME 按扩展名、路径穿越防护、immutable 缓存）。资产不依赖 provisioner 环境（其按 agent 生命周期重建，URL 必须跨工作空间稳定）。

托管边界：`local-features/` 基础设施（checkpoint、time-awareness、上下文守卫等宿主强耦合、无需选择性安装的能力）保留内置，不出仓；判据是"基础设施 vs 应用型"——宿主功能不可缺的留内置，可选、独立、面向用户价值的出仓成插件。插件页统一呈现三类来源（内置 / 官方插件 / 用户插件），统一可见、不统一分发。生态包（npm `@agentdevjs/*`）是宿主开发态依赖，与用户导入体系无关。

### 4. 装配模型：仓库导入与工作空间装配严格分离

导入是 Claw 层仓库动作（上传 tgz、确认页预览三面内容、入库，不激活任何东西）；装配是工作空间内部动作（各工作空间的插件页自主决定挂什么、按 feature-config 四层作用域配什么、何时卸）。两者之间只做引导不做代装。`install-service` 的装配身份从硬编码 `IDENTITY_SCOPES`（main/coder）泛化为按工作空间注册表派生，任何有 runtime 的工作空间都是合法装配目标。

### 5. 呈现配置：插件提供素材，显示决定权在工作空间

插件 manifest 的 scope 与 meta 全部是默认呈现建议，不是裁决。每个工作空间持有一份服务端持久化、随工作空间走的呈现配置（sparse：`{ panelId: { visible, order } }`），是右栏最终形态的唯一权威，统一覆盖宿主自带面板与插件面板；粒度到显隐与排序，不提供改 label/icon（作者品牌，处置权到显隐排序为止）。现有 rail-customize 的浏览器 localStorage 偏好一次性迁移进工作空间层后废弃——收益是跨设备一致、远程视图呈现的是远端工作空间的处置结果。

scope 语义相应收敛：`assembly`（默认）= 装配后默认只在该工作空间视图出现；`global` = 装配后默认全局出现（agentero 场景：vault 与工作空间无关）。两者都可被工作空间呈现配置覆盖。

### 6. 面板注册与可见性链路

rail 按钮是三层叠加的结果，链路四步：manifest 素材声明 → server 按"已装配 + 未禁用"合成下发 → 前端 feature-ui-registry 转为 `ClawHost.panels.declare()` stub（rail 按 order 插入按钮，此时未加载实现代码）→ 用户打开时 `ensurePlugin` 经资产 URL 装载实现模块接管渲染（容器型面板 mountBody 通道，ADR-0044 机制原样复用）。可见性 = 插件 scope（作者建议）× 装配事实（哪个工作空间挂了）× 工作空间呈现配置（显隐排序）。卸载/禁用 → stub 移除 → 打开中的面板按 owner 关闭。`panel-plugins.js` 与 `plugin-manifest.js` 的存量条目随声明下发迁移后删除。

### 7. 处置模型：单位是插件，三面联动，三态生命周期

处置动作四个：**装配**（$mount 写声明，现有）、**禁用**（声明加 `enabled: false`，新增——声明与配置全保留，三面整体下线，重新启用即恢复）、**卸载**（$mount 置 null，现有语义，三面退场）、**删除**（仓库级删 tgz，前置检查无工作空间装配引用）。feature 面进程内实例活到 runtime 重启（与 dsh 行级 disabled 同边界，组合变化在启动边界生效）。

不做面级独立开关：Claw 的三面是同一包的投影，不是 dsh bundle 内多个独立插件的集合，拆开禁用会制造"面板活着但工具禁了"这类难以解释的中间态；UI 面的显示层控制由呈现配置覆盖（显隐是偏好，不是功能开关）。多 feature 包（manifest `features[]` 多条目）的面级控制留作演进开放问题。

### 8. 界面模式：共享货架 + 各工作空间装配清单

现有 feature-store 商店骨架保留。货架（插件仓库）全局共享；卡片升格为插件卡片——聚合三面摘要（工具 N / 面板 M / 服务 K / 兼容版本），状态三态（未装配 / 已装配 / 已禁用），操作按当前工作空间上下文执行。builtin 官方选装开关保持原样（内置能力无包形态）。

视觉分层硬约束：插件卡片（重样式：包徽章、版本、三面清单、操作按钮）是插件层级的唯一视觉单位；右侧 Features 面板保持 feature 层级轻条目（运行时视图：当前 agent 挂载了哪些 feature 实例），标注来源"内置 / 来自某插件 vX.Y.Z"，两套样式彻底解耦（现状商店复用 feature-card 结构的做法废止），条目与卡片之间提供导航跳转。

### 9. 数据面的信任模型

导入 tgz 即信任执行：工具面本来就在 runtime 进程执行任意 Node 代码，server 面在宿主进程执行，差异是崩溃隔离而非安全边界。三层缓解：路由前缀声明（审计面）、context 收窄、异常熔断。会话相关数据继续走 feature-comms（ADR-0018）；server 面服务与工作空间无关的全局数据（agentero vault）。未来若宿主内执行不可接受，升级路径是独立子进程 server runner，manifest 契约不变。

### 10. 验收样本与实施顺序

agentero 三件套整体出仓（主仓库删除全部三处实现）为总验收。阶段：P1 资产通道 + ui 声明 + 前端 registry（agentero UI 面出仓）；P2 server 面（数据面出仓）；P3 工具面出仓（agent.js 删静态 import，经 $mount 装配，验证 `features[].config` 与构造参数对齐）；P4 studio 契约同步、清单动态化、呈现配置与 localStorage 迁移、术语与文档收尾。明细以实施计划文档为准。

## 不做清单（显式边界）

- 不做导入即装配（一步到位已否决：仓库导入与工作空间装配严格分离，以工作空间自主装载为主）。
- 不做插件间 provide/inject、反应式重载、waterfall（沿 ADR-0044 不做清单）。
- 不做宿主构建链：client/ 必须是预构建产物（与 dsh npm 分发预构建产物免构建授权同一取舍）。
- 不做市场索引源协议（对标 dsh 静态 JSON 索引）与 git 安装源：后置，待单 tgz 导入闭环验证后评估。
- 不改 local-features 内置形态、不迁移生态包来源。
- 多 feature 包的面级控制、APP 插件面（`ui.appPlugins`）第一版不实施，进开放问题。

## 后果

正面：第三方不改宿主源码即可交付完整产品体验（工具 + 界面 + 服务一体）；工作空间获得一致的处置模型（装配/禁用/卸载以插件为单位）；右栏呈现跨设备一致；agentero 出仓后主仓库维护面收缩。

代价：claw-host 上游是 asset serve 路由 + feature-ui-registry + 呈现配置三块新前端机制；install-service 身份泛化；catalog 读 v3 声明；rail-customize localStorage 迁移；agentero 三处实现迁出与装配等价性验证（`AgenteroFeature(merged.agentero)` 构造参数 vs `$mount` config 路径）。

风险：server 面在宿主进程执行第三方代码（缓解见决策 9，升级路径已定）；装配变更后前端声明收敛依赖低频拉取，面板可见性可能滞后一个周期（可接受，面板可见性非会话状态）；ClawHost 面板协议对第三方的冻结承诺必须在本 ADR 实施前给出（建议随 agentdev minor 冻结、破坏性变更升 major）。

## 实施纪要（2026-11-08，P1–P3）

已落地内容：

- **manifest v3 与资产通道**：catalog 读 `ui.panels[]` / `server` 声明；导入确认时 `client/` 解出至 `user-features/assets/<pkg>/<version>/`、`server/` 解出至 `user-features/server-env/<pkg>/<version>/`（解出目录自动补 `{ "type": "module" }` 标记，脱离包根后 `.js` 仍按 ESM 解析）；同版本 digest 纪律与 tgz 仓库同构（一致幂等、冲突拒绝）。
- **声明下发**：`GET /api/feature-ui/declarations` 按"素材 × 装配事实"合成（scope=assembly 换算 `when.agentIds` 为装配身份集合，global 不设限；资产未解出的包跳过下发并出警告）。
- **资产路由**：`GET /protoclaw/feature-assets/:package/:version/*`（Express 4 匿名通配——实测命名通配 `*file` 在 4.21 不匹配），MIME 白名单、防穿越（realpath 校验）、immutable 缓存。
- **前端 feature-ui-registry**：拉取声明转 `ClawHost.panels.declare` stub（复用 ADR-0044 懒装载）；声明退场 / 同面板换版（url 变化）经新增的 `undeclarePanel` 对称处理；30s 低频轮询 + 失败保留现有声明。
- **数据面挂载器**：`server/feature-runtime/plugin-server.js`——prefix 单段全局唯一（冲突保先挂载者）、装配事实驱动、受控 router（相对子路径校验）、连续 5 次异常熔断摘除、`POST /protoclaw/plugin/remount` 整体重建；`context.getConfig()` 每请求现读四层作用域合成配置。
- **agentero 三面出仓**：源码仓 `D:\code\adv-plugin\agentero`（单包三面，`npm pack` 出 tgz）；主仓库删除 `local-features/agentero`、`server/routes/agentero.js`、`public/src/plugins/agentero-library/` 与 `build:react-panels` 构建链；`agent.js` 删静态装配改 `$mount`。

验证：宿主侧 `test/feature-assets.test.js`（14）、`test/plugin-server.test.js`（11，真 Express + 随机端口 HTTP）、`test/frontend-feature-ui-registry.test.js`（7）；包侧 38 测试（工具面 / 划词提问 / 数据面契约）；`npm run test:core` 全量通过；`scripts/smoke-plugin-package.mjs` 隔离数据根冒烟（upload → parse → confirm → install → declarations → 资产 URL → remount → 数据面路由）全链路通过。

实施差异与决定：

- 挂载前缀定稿为 `/protoclaw/plugin/<prefix>/` 单段（本 ADR 决策 3 原文为 `<package>/`）：prefix 与包名解耦即审计面，同包升级不破坏 URL 契约。
- 插件包对 `@agentdevjs/core` 0.1.1 的兼容：`CallStartContext.metadata` 与 `onTurnMetadata` 是新版框架能力，0.1.1 下两条划词提问投递路径静默降级（面板直接查询不受影响），新版 core 发版后自动激活；插件源码以宽容断言保持旧版可编译可运行。
- 开放问题 4 结论（ClawHost 面板协议冻结承诺）：P1 实施未引入协议破坏；面板插件协议面（`export default { id, panels, mount, unmount }` + `host.env` / `host.workspace` 注入）随 agentdev minor 版本冻结，破坏性变更升 major 并保留至少一个 minor 的兼容期。

待办（P4）：studio 契约升 v3、装配身份泛化、工作空间呈现配置（替代 rail-customize localStorage）、插件卡片视觉分层与禁用动作、术语收口。
