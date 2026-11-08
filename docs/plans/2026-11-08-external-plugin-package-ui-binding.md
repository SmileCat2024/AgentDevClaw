# 外部插件包实施计划（P1–P4）

日期：2026-11-08（按对齐结论归一改写）
状态：P1–P3 已完成并验证（2026-11-08，实施纪要与验证证据见 ADR-0045 文末）；P4 待实施
决策依据：[ADR-0045 外部插件包与工作空间装配模型](../adr/0045-external-plugin-package-and-workspace-assembly.md)——本文件只记实施拆解，模型论证以 ADR 为准。
调研底稿：dsh 0.2.1-rc.2 与 agentero-dsh-plugin 0.1.5 的对照结论见 ADR 背景节。

## 总目标

用户导入一个 tgz（插件），工具面、UI 面、数据面三面同时就位；装配、禁用、卸载以插件为单位在工作空间内自主处置；右栏呈现由工作空间呈现配置裁决。总验收：agentero 三件套整体出仓，主仓库不再维护其任何实现。

## P1 资产通道 + ui 声明 + 前端 registry

服务端：

- `catalog.js` 的 `summarizeArchive` 读取 manifest v3 的 `ui` 声明（`agentdev.schemaVersion: 3`，v2 及以下按现状兼容）。
- 导入确认（`confirm_import`）时解出 `client/` 至 `user-features/assets/<package>/<version>/`；同版本重导入按 digest 拒绝，与 tgz 纪律一致。
- 新路由 `GET /protoclaw/feature-assets/:package/:version/*file`：MIME 按扩展名、路径穿越防护、immutable 缓存头。
- ui 声明合成下发：按"已装配 + 未禁用"过滤、按 scope 合成默认 when（assembly → 装配身份集合；global → 不设限），并入 `GET /api/feature-store/overview` 或新增 `GET /api/feature-ui/declarations`。

前端：

- 新模块 `feature-ui-registry.js`：拉取声明 → `ClawHost.panels.declare(id, meta, { pluginId, url })` stub → 打开时 `ensurePlugin` 装载（ADR-0044 机制零改动复用）。
- agentero-library 迁移：`public/src/plugins/agentero-library/` 源码与构建脚本迁入独立插件包仓（或本仓库过渡目录）产出 tgz 的 `client/` 面；`panel-plugins.js` 删除 agentero 条目。

验收：删除主仓库 agentero UI 源码后，经外部 tgz 导入 + 工作空间装配，文献面板可用。

## P2 server 面

- `registerRoutes(router, context)` 契约与形状校验；挂载前缀 `/protoclaw/plugin/<prefix>`（实施定稿：prefix 单段全局唯一，原稿 `<package>/<prefix>` 双段已弃）；异常计数熔断（连续失败自动摘除并显式报错）。
- `server/routes/agentero.js` 迁入插件包 `server/` 面（只读 SQLite 查询逻辑原样迁移，`registerRoutes` 包装）；vault 配置仍经 feature-config 四层作用域由 context.config 提供。
- 主仓库删除该路由文件与 `test/agentero-routes.test.js` 对应用例（逻辑随包走，包仓侧补测试）。

验收：数据面随包走，主仓库 `server/routes/agentero.js` 删除后面板数据正常。

## P3 工具面出仓

- `local-features/agentero` 迁入插件包 `dist/` 面（构建脚本随包走），`local-features/index.ts` barrel 与 tsconfig include 同步清理。
- `prebuilt-agents/official/programming-helper/agent.js` 删除 `AgenteroFeature` 静态 import 与装配，改经 `$mount` 装配。
- 等价性验证两点：`$mount` 的 `features[].config` 与现 `new AgenteroFeature(merged.agentero)` 构造参数对齐（install-service 写声明时带 config）；划词提问（metadata.agentero → reminder）随会话流动、不依赖装配位置（代码已确认，补回归测试）。

验收：主仓库三处 agentero 实现全部删除，插件经商店装配后工具面可用、划词联动正常。

## P4 收尾

状态（2026-11-08 第一批落地后）：可见性三级体系主体、全局装配（服务面 + 插件管理器入口）、数据面自动重建、资产懒解出自愈已完成并验证；呈现配置、禁用三态、builtin 升级按 ADR-0046 落地顺序第二/三批推进。

- studio 契约同步：`feature-package-metadata.md` 升 v3、`studio_create_feature` / 快照校验支持 ui/server 声明。（未动，与"Studio 数据源统一 catalog"一并挂起，等第一个真实需求）
- 装配身份泛化：`install-service.js` 的 `IDENTITY_SCOPES` 从硬编码 main/coder 改为按工作空间注册表派生（任意有 runtime 的工作空间可装配）。（**服务面已完成**：注册表机制 + 运行时 `registerIdentityScopes` + global 身份 install/rebuild/readiness，消费方现读注册表；**商店面剩余**：`server/routes/feature-store.js` 的 `STORE_SCOPES` 是模块加载时快照、`AGENT_MODULE_SOURCES` 写死 main/coder，后注册身份能装配但商店 overview 不显示其装配状态）
- 呈现配置：工作空间身份层新增 sparse 呈现配置（`{ panelId: { visible, order } }`）+ 读写 API；rail 渲染消费（素材 × 装配事实 × 呈现配置合成）；rail-customize localStorage 一次性迁移后废弃。（第二批；迁移归属已定：每空间首次打开时服务端无配置且浏览器有旧值则拷贝，打一次性迁移标记）
- 插件卡片视觉分层：商店货架卡片与右侧 Features 面板条目样式解耦（复用 feature-card 结构的做法废止），先查 design-system 配方再定卡片配方。（并入第二批插件设置弹窗批）
- 禁用动作：$mount 声明支持 `enabled: false`，卡片三态，三面联动下线。（第三批；与官方 builtin 开关升级三态同期，同一条处置链——ADR-0046 后果节要求，落地顺序原漏排已补）
- 术语收口：AGENT.md 词汇表登记 Plugin/feature 分层，前端 i18n 文案 feature 商店 → 插件，`server/feature-runtime/` 模块名不强制重命名。（本批完成）

## 开放问题（进入实施前逐项关闭）

1. APP 插件面（`ui.appPlugins`）：agentero 只有面板面，推迟到第二个出仓样本出现时实施。
2. server 面 context 是否提供 fetch 代理到 feature-comms 的桥（让数据面可代理会话相关数据）：P2 按需定。
3. 多 feature 包的面级控制：无近期需求，留演进。
4. ClawHost 面板协议第三方冻结承诺：P1 开工前必须给结论（建议随 agentdev minor 冻结、破坏性变更升 major）。
