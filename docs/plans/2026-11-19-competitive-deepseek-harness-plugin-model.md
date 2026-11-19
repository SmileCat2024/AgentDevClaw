# 竞品分析：DeepSeek Harness 的插件/bundle 体系与结构性弱点

日期：2026-11-19
对象：`/home/dev/deepseek-harness`（dsh，0.2.2-rc.5）
目的：找出其架构层面的结构性弱点（不是可快速修补的缺陷），据此确定
AgentDevClaw 插件体系的发力点。本文只做判断与依据记录，不改代码。

## 结论

dsh 的插件体系本质上是**单机、单用户、单进程的"插件操作系统"**：能力通过
Cordis 服务容器在进程内共享，组合通过 profile 的 patch 层叠完成。它的强项
是组合工程化（pnpm 安装链、版本检查、回滚、市场索引、配置 dump）与能力抽象
（service / event seam、可逆副作用）。它的软肋不在这些可追赶的工程细节，而
在四个**改起来会伤筋动骨的架构决定**：

1. 没有租户/工作空间边界——插件与宿主同进程同权限，隔离只到会话级 realm。
2. 装配即 patch 层叠——层序就是优先级，配置覆盖必须整段重述，无法表达
   空间/项目/目录级参数分层。
3. 包（bundle）与运行时单位（entry/row）不对齐——包级开关是"移除一层"，
   行又可能被其他 patch 覆盖或追加，用户很难得到稳定的包级状态。
4. 依赖 npm 生态做分发治理——有 lockfile 完整性，没有面向插件的发布者
   签名、来源证明与权限声明。

AgentDevClaw 的发力点应当是**多工作空间的装配治理**（包级处置 + 装配层级 =
可见性 + 配置分层 + 供应链完整性），而不是模仿它的 profile/patch 组合工程。

## 一、竞品模型速写（事实）

| 概念 | 定义 | 证据 |
|---|---|---|
| Plugin | Cordis 插件：向共享 `ctx` 贡献服务、类型化事件与可逆副作用 | `docs/cordis-primer.zh.md` |
| Service | 占据稳定字符串键 `ctx.<key>`，其他插件按 key 查找而非导入实现；`inject` 声明依赖并等待就绪 | 同上；`docs/architecture.zh.md` |
| Entry / row | 挂载单位：Cordis 配置树里的一行，按 `id` 定位 | `vendor/include/src/patch.ts` |
| Bundle | npm 包声明 `dsh.bundle.patch`，提供一层 patch；一个 bundle 可声明多行 | `packages/bundle/README.md`、`docs/architecture.zh.md` |
| Profile | 具名组装：有序 bundle 列表 + `dsh.profile.dependencies` + 用户 `cordis.patch.yml` | `.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md` |
| Patch | 按 `id` 替换某 entry 的键（含整个 `config`），或 `insert` 新 entry；层序：bundle 顺序 → profile patch → home patch → `--patch` | `docs/architecture.zh.md`、`vendor/include/src/patch.ts` |
| Agent preset | 会话级能力集合，服务行通过 `isolate` realm 隔离 | `docs/architecture.zh.md` |
| 管理面 | `plugin-manager`（安装/删除/启停/更新）、`plugin-market`（索引读取） | 两个包 README |

## 二、结构性弱点

### 1. 单进程共享容器，第三方插件与宿主同权

**架构事实**：所有插件挂载在同一个 Cordis 上下文树，服务是进程内对象；
Host 代码在宿主进程内运行。文档明确写"Host 代码在宿主进程内运行，不受工作区
沙箱限制"，兼容性检查"不是防范恶意包代码的沙箱"（`plugin-manager` 与
`app-boot` README）。

**后果**：插件一旦装配即拥有宿主全部能力（文件、进程、网络、凭据）；产品的
安全边界只剩"安装前批准"，没有运行时权限。用户越多、插件市场越大，单点
供应链风险越高。

**为什么是结构性的**：Cordis 的核心假设就是共享 `ctx` 与进程内服务；要做
权限/进程隔离，等于替换插件运行模型（worker/进程 + RPC），现有服务 seam、
事件与 HMR 全部要重做。这不是补丁能解决的。

### 2. 装配即 patch 层叠，层序就是优先级

**架构事实**：profile 由有序 bundle 层 + 用户 patch 层叠而成；一条 patch
按 `id` 覆盖 entry 的键，`config` 是整体替换（`vendor/include/src/patch.ts`）。
`app-boot` README 的已知限制直接写明："用户 patch 会替换匹配到的整个配置
——按 id 定位的 patch 不做深度合并，因此 profile 覆盖必须重述需要保留的
组合包字段"。`plugin-manager` 也写明：关闭再开启组合包会"追加到列表末尾，
可能改变配置优先级"。

**后果**：配置无法分层表达——没有"全局默认 → 工作空间覆盖 → 项目/目录覆盖"
的治理能力；用户想改一个字段要重写整段 config；组合的可解释性依赖 dump 与
来源标注，但"优先级随启停顺序漂移"使组合不具时间稳定性。

**为什么是结构性的**：patch 语义是产品契约的一部分（`--dump-config`、用户
patch 文件、插件管理器的启停记录）。改成分层合并会破坏既有 profile 与所有
作者写的 patch。

### 3. 包与运行时单位不对齐，处置粒度不稳定

**架构事实**：安装/删除以 npm 包（bundle）为单位；启停以 entry/row 为单位；
一个 bundle 可声明多行，行 id 由 patch 声明或随机生成（`ensureIds`）。组合
包自身的开关（`dsh.profile.bundles` 列表成员）以"移除该层"表达，且"关闭保留
依赖；开启追加到列表末尾"（`plugin-manager`）。同时任何层的 patch 都能按 id
覆盖或向别的 bundle 的行 `insert` 新行。

**后果**：包级状态与运行时状态可能不一致——关闭一个组合包只移除它的层，
已被其他 patch 覆盖/追加的行仍在；单行的启停又不代表包级语义。用户心智里
"这个插件现在到底装没装、整体关掉没有"没有稳定答案，包级回滚/整体下线也
无法精确表达。

**为什么是结构性的**：row 是 Cordis 运行时单位，bundle 是 npm 单位，中间
没有宿主持有的"产品对象"。要做包级处置，需要宿主维护"包 → 行集合"的显式
映射并把它作为装配契约，而不是允许任意 patch 增删行。

### 4. 服务定位器 + 全局字符串键，没有接口版本

**架构事实**：插件通过 `ctx.<key>` 查找服务；`inject` 只声明"需要这个服务"，
不声明接口版本；同名服务的提供方冲突只在运行时暴露。

**后果**：第三方生态的兼容性靠约定与运行时失败；上游改接口会静默破坏下游；
同一键的多实现无法共存（除 isolate realm 外）。生态规模上去后，升级可靠性
成为天花板。

**为什么是结构性的**：这是 Cordis 的 DI 模型本身。加"服务契约版本"需要
在每个 seam 上引入版本化的接口定义与协商，等于改框架内核。

### 5. 分发治理绑定 npm 生态，缺少插件级来源证明

**架构事实**：安装走 `pnpm add`，支持 registry / git（固定完整 commit）/ 本地
路径；版本检查用 `engines.dsh` 与 peer；回滚靠删除后重装旧版本；完整性依赖
npm/lockfile。没有面向插件的发布者身份、签名、来源证明或权限声明（全仓
文档未出现 plugin 级 digest/signature/provenance 机制）。

**后果**：插件市场只能建立在"信任 registry 与作者"之上；私有源、镜像、Git
spec 的信任模型各不相同；无法做"官方认证 / 社区 / 本地私有"这类来源分级。

**为什么是结构性的**：他们的分发模型已经锁定 npm/pnpm；要加签名与来源证明，
需要在安装链上引入独立仓库格式与校验链，与现有 pnpm 转发、市场索引、
compatibility.json 豁免机制并存，复杂度高且会分裂生态。

### 6. 能力作用域只到会话，没有工作空间/租户层

**架构事实**：profile 是全局的——`plugin-manager` 明说"改动影响使用该
profile 的全部会话"；会话级差异靠 agent preset 的 `isolate` realm。数据模型
是 home → profile → session，没有 workspace 层。

**后果**：无法做"这个工作空间装 A、那个装 B"；无法做多用户/多租户；插件
装配与配置天然是全局的，产品形态被限定为单用户本地工具。

**为什么是结构性的**：这是数据模型与进程模型的双重缺失；补工作空间层要改
profile/数据目录/服务作用域/UI 可见性四处。

### 7. 插件配置只有 profile 级，运行时状态无宿主分区

**架构事实**：插件 Config 有宿主契约——`packages/settings` 由 Config schema
派生表单，编辑结果保存在 profile patch。但插件运行时状态（缓存、用户数据、
面板偏好、呈现配置）由插件自己的 service 或持久化实现负责，宿主没有统一
分区；配置本身也只有 profile 级，没有按工作空间/项目的层。

**后果**：卸载/重装的状态残留与迁移没有统一语义；面板显隐排序这类宿主级
偏好缺少既定归属；跨工作空间迁移插件时用户数据无法跟随。与弱点 2 叠加后，
"同一插件在不同工作空间用不同参数"无法表达。

**为什么是结构性的**：补这套契约要宿主定义插件数据分区、键空间、生命周期
与迁移规则，并让生态插件改用它；同时要先把配置做成多层的（弱点 2）。


## 三、社区反馈与内部复盘证据

dsh 仓库关闭了 GitHub Issues（`has_issues: false`），反馈在 Discussions。以下标题
按结构性弱点归类（只取到讨论标题与编号：正文需登录，未读取，因此不做正文推断）。
另有 4 篇内部事故复盘（`docs/postmortem/`）可直接引用。

### 对应弱点 1（无边界/权限）

- #12097 `[security][plugins] Third-party plugin silently rebranded the entire host UI; request plugin-system guardrails`
- #13622 `A sign-in plugin can't refuse WebSocket, static or /plugins requests`
- #12742 `Community plugins cannot reach the model or the composer`（既无边界，也缺宿主 API）
- postmortem 0002：权限预设"在运行时更新 bash 沙箱和审批状态，但无法挂载、卸载或约束文件系统栈"——权限与装配两张皮

### 对应弱点 2（层序即优先级、配置不可分层）

- `[需求] 支持拆分 profile 用户 patch 层为多个文件 / Split the profile user patch layer (cordis.patch.yml) into multiple files`
- `Profile-backed settings cannot be saved — recompose throws profile reload requires the root Include entry when dsh-app-boot is loaded twice`
- `plugin_manager writes succeed, but profile reload always fails (dsh: profile reload requires the root Include entry)`
- `Enabling Agent Teams turns off subagent tools for the whole profile`
- `Plugin install can shadow runtime packages; boot failure then resets the profile config`
- `--dump-config is documented as "print … and exit", but it also applies profile manifest migrations and rewrites package.json silently`
- postmortem 0002：`disabled: !!js` 只在 `config` 内插值，元数据读到 truthy 表达式对象 → 文件系统栈被永久禁用，而七个快照场景仍"通过"

### 对应弱点 3（包与行不对齐、装配状态无单一权威）

- `Settings → Plugins shows one row per profile dependency; a dependency that ships dsh.bundle.patch renders as a bundle whose patch was never loaded`
- `plugin-manager: Git-pinned bundle update reports applied but leaves dsh.profile.bundles without the bundle`
- `[Bug][Plugin Manager] Refresh and local .tgz install fail after private registry provenance is lost`
- `[Desktop] "Disable third-party plugins" recovery permanently drops all profile settings and user plugins (and looks like a sign-out)`
- `[Bug] plugin_manager set_plugin(false) drops the management RPC and leaves the host plugin disabled after DSH restart`
- `Host-side: plugin market unloaded after every install/uninstall (and a host-written patch row can block the next start)`
- `client-modules: a failed client-bundle scan at boot poisons pkgMeta with null and permanently skips a newly installed plugin`
- `One dangling workspace id in workspace.json takes the whole plugin tree down`
- `[Bug] 0.2.2-rc.5 desktop auto-update leaves official optional bundles at rc.3 — preflight disables session-query-sqlite`
- `Sessions not loading + "sessionController is unavailable" after installing official bundles by name`

### 对应弱点 4（服务定位器与隐式插件契约）

- postmortem 0001：一行多余的 `export default apply` 让 Loader 丢弃 `inject`，ACP 在真实编辑器连接时立即崩溃；178 个单测与 100% 行覆盖全绿，因为测试都走了"手动挂载插件"的路径
- `Make systemPrompt.context text providers optionally async (sync contract forces plugins to block the UI)`
- `skills: a restrict()/filter hook so plugins can hide skills without patching the registry`（缺注册表级 API，只能 patch）
- `Plugin notices (form: "notice") carry no session identity`

### 对应弱点 5（供应链与来源）

- `[Bug][Plugin Manager] Refresh and local .tgz install fail after private registry provenance is lost`
- `[Bug] Desktop 卸载从自定义 npm 源安装的插件时回退到公共源，校验 404`
- `macOS: workspace create fails after app update - cua-bundle pin stays on old version, hoisted @deepseek-ai/* shadows host singleton`
- `Safe-mode boot that skips third-party plugin bundles`（用户自己在求一个"坏了还能起来"的开关）

### 对应弱点 6（无工作空间层、全局影响）

- `Enabling Agent Teams turns off subagent tools for the whole profile`
- `dsh-settings: legacy settings.yaml import lands in one profile only`
- `[Desktop] Profile lock left empty by a crash blocks every later profile operation, including recovery`

### 对应弱点 7（状态归属与可诊断性）

- `[Bug] Desktop crash reports and the plugin-operation journal drop the information needed to diagnose a failure`
- `Proposal: a per-plugin diagnostics action on the Plugins page`
- `Plugin inventory shows no diagnostic for plugins that failed to import`
- 大量 `Plugin compatibility report` 讨论（同一主题反复出现）
- `web client preloads 101 plugin bundles (~24 MB raw) at first paint`

### 从反馈读出的三个信号

1. **用户在替系统承担概念负担**：讨论标题里反复出现 profile / patch / bundle / row，
   说明装配模型没有被产品化，用户必须理解内部机制才能排障。
2. **失败模式高度集中在"状态不一致"**：装上了但 patch 没加载、更新报告成功但
   bundles 列表没变、禁用后管理器自身被禁、恢复动作清空配置——都是"多份状态各说各话"。
3. **社区自己在补护栏**：安全模式启动、按插件诊断、拆分 patch 文件、注册表级技能
   过滤 hook——这些需求正是结构性缺口的镜像。

## 四、我们的结构性优势（对照）

| 维度 | AgentDevClaw（ADR-0045/0046/0052） | dsh |
|---|---|---|
| 处置单位 | 包级：装配/禁用/卸载/删除都以 tgz 包为单位；feature 只是运行期投影 | 包与行两套粒度，包级启用/禁用不可表达 |
| 可见性 | 装配层级 = 可见性：工作空间层限本空间，默认装配源 opt-in；面板 `when.agentIds` 由宿主合成 | profile 全局生效；可见性由插件自己决定 |
| 配置 | 四层配置树（global / workspaces / project / dir）+ 会话注入；`$mount` 与参数同文件不同语义 | patch 覆盖整段 config，不深度合并 |
| 仓库 | 三层来源（官方 / 用户 / 空间私有），优先级明确，空间私有不跨空间 | npm registry + git spec，无来源分级 |
| 完整性 | 精确版本 + digest 纪律 + 删除引用检查 + 内容寻址环境 | lockfile 完整性；无插件级签名/来源证明 |
| 配置与状态归属 | 分层配置树 + 面板偏好 panelPrefs + 呈现配置 ui-prefs（均按工作空间） | Config schema 有宿主契约但仅 profile 级；运行时状态归插件自管 |
| 隔离 | 工作空间数据分区 + 每身份 runtime 进程 | 单进程共享 ctx；isolate 只到会话 |

## 五、发力点（按优先级）

### 1. 把"包级处置 + 装配层级 = 可见性"做成不可绕过的产品硬约束

已完成：包级 `$mount`、空间私有仓库、面板/数据面按装配身份合成、删除引用
检查。下一步：

- 装配事实可视化：把"这个包被谁装配、在哪个层、可见范围、依赖哪个环境"
  做成界面可查（对标 `--dump-config` 的可解释性，但以产品对象而非 YAML 呈现）。
- 包级状态的唯一入口：禁用/升级/卸载都在包卡片上，行级概念不暴露给用户。

### 2. 配置分层作为差异化能力

已完成：四层配置树 + `$mount` 层白名单 + 按面寻址。下一步：

- 把"全局默认 / 本空间覆盖 / 项目覆盖 / 目录覆盖"的继承状态在插件设置里
  显式呈现（当前只有全局/本空间两 tab）。
- 配置冲突诊断：同一字段多层取值时展示来源链，而不是只显示最终值。

### 3. 供应链与来源分级

已完成：三层仓库、digest、精确版本、删除引用检查。下一步：

- 插件来源徽章与信任等级（官方 / 用户 / 空间私有 / 未签名）在卡片与安装
  确认中统一呈现。
- 空间私有包的内容完整性复用 digest 纪律；后续再评估签名（不做 npm 式
  registry 转发）。

### 4. 多工作空间与多身份隔离作为架构卖点

已完成：workspace 数据分区、每身份 runtime、空间级配置与偏好。下一步：

- 明确"插件在空间之间不共享运行时状态"的边界，并给出迁移动作（导出/导入
  私有包 + 配置）。
- 数据面请求上下文按工作空间合成（ADR-0052 §10 已挂账），这是"多空间同一
  插件不同配置"的最后一公里。

## 六、不照搬清单

- 不做 profile/patch 组合层：我们的装配单位是包，组合由依赖与装配声明表达。
- 不做行级启停：行是运行时内部概念，产品面只暴露包。
- 不把插件市场绑定到 npm：包是 tgz，仓库是宿主持有；市场只做索引与展示。
- 不引入"全局 profile 影响所有会话"的语义：装配必须能按工作空间隔离。

## 七、需要补的工程差距（公平评估）

dsh 在这些方面领先，属于可追赶的工程而非结构性优势：

1. **安装链工程化**：注册表计划、版本检查、Git 固定 commit、失败回滚、
   安装日志流。我们目前是上传 tgz + 本地解析，缺少"从来源获取"的链路。
2. **组合可解释性**：`--dump-config` + 来源标注 + 配置 schema dump。我们有
   overview 与配置 resolved，但没有等价的装配事实导出。
3. **插件开发体验**：模板、schema、cookbook、展示元信息。我们的
   agent-studio 工作流已覆盖一部分，但对外部作者的门槛更高。
4. **热装配**：HMR + 重载失败策略。我们明确不做热挂载（ADR-0046），这是
   取舍，不是缺口。


## 八、反向评估：如果有人在 dsh 之上做平台层

前七节是"我们怎么看 dsh"。这一节反过来问：如果对手用 dsh 当底座、在它上面
做一层平台，我们守不守得住。

### 8.1 结论

按当前结构，**接不住**。原因不是我们的设计不好，而是优势的性质：
我们领先的是**平台层的设计选择**，对手可以在更强的底层上原样复刻；我们落后的是
**运行时与生态**，对手可以直接继承。上层可复制、下层不可掩盖，这是最不利的组合。

### 8.2 优势拆成三类，只有一类是护城河

| 类型 | 例子 | 可复制性 |
|---|---|---|
| 设计选择 | 包级处置、装配层级=可见性、配置分层、空间私有仓库、插件页信息架构 | 高。写在文档里就能被照抄，甚至因为底层更强而做得更顺 |
| 实现资产 | 工作空间/会话数据、IM 渠道、调度与线程、群聊协作、桌面安装器、子域名入口 | 中。要时间与踩坑，但不是原理性壁垒 |
| 结构壁垒 | 用户数据与协作关系、组织治理（权限/审计/配额/成本）、渠道覆盖、迁移成本 | 待验证。目前只有雏形，尚未成为壁垒 |

前两类都不是"真赢"。第三类里，"组织治理"是我们有、dsh 结构上没有的东西
（它的数据模型是 home → profile → session，没有租户层）；但它需要真的做出来，
不是靠插件页的设计差异。

### 8.3 攻击剧本（推演）

1. 用 dsh 的 SDK / ACP / 多实例能力，按工作空间起独立 host 或容器——**绕过**
   dsh 的单进程与全局 profile 限制，而不是修复它。
2. 平台层自建仓库、装配清单、配置分层、可见性与审计数据库；只把 dsh 当
   runtime 与工具生态。dsh 的 patch 不可分层、包行不对齐这些弱点，被平台层
   自己的数据模型**隔离**，用户根本不接触。
3. 插件作者因为底层 seam 更完整、生态更大、性能更好而优先适配 dsh；平台层
   再提供"把插件装进工作空间"的治理能力。
4. 用户看到的是：同样甚至更好的治理 + 更稳的 runtime + 更大的插件生态。

### 8.4 他们会继承什么、我们会失去什么

- 他们继承：seam 抽象、事件模型、会话日志、迁移链、组合工程化、插件市场、
  生态与性能。
- 他们复刻：包级处置、可见性、分层配置、私有仓库（这些是我们的设计，不是
  我们的实现壁垒）。
- 我们失去：因为底层弱而无法吸引的第三方作者；因为生态小而留不住的进阶用户。

### 8.5 我们更危险的地方

1. **底层差距不可掩盖**：我们的 AgentDev 在服务/事件抽象、会话格式迁移、
   热装配、生态规模上不如 dsh。平台层可以不用我们的底层，却可以用我们的设计。
2. **可靠性尚未成为优势**：dsh 的讨论区里满是升级丢状态、装配状态不一致；
   但如果我们自己的服务也靠重启生效、测试基线长期带失败，这一步我们并没有领先。
3. **"平台层可替换"没有做**：平台能力与自研 runtime 绑得越紧，越难在底层落后时
   换底座；而这正是对手攻击的着力点。

### 8.6 什么才算真赢（检验标准）

1. **迁移成本**：用户迁移到"dsh + 平台层"要丢什么？如果答案是"只是插件装一遍"，
   我们没壁垒；如果答案是"工作空间、协作关系、渠道、治理记录、私有插件资产都
   要重建"，才算。
2. **治理深度**：权限、审计、配额、成本、合规这些组织级能力，dsh 结构上做不了，
   平台层要自建。我们做出多少，决定上层平台能不能平替我们。
3. **可靠性标准**：装配状态单一权威、升级不丢状态、崩溃可恢复。这比插件页的
   设计差异更难复制，也更能留住用户。
4. **平台契约的可移植性**：即使底层换成别的 runtime，平台层的数据模型与治理
   仍然成立。这是"不被底座绑架"的保险。

### 8.7 战略含义（不改代码也能先定的三件事）

1. **把插件治理降级为卫生标准**：它必须做好，但不能当作护城河投入超额资源。
   继续按 ADR-0052 推进即可，不再为"设计领先"加戏。
2. **把重资产做成壁垒**：工作空间/协作/渠道/治理/可靠性。每一项都要能回答
   "迁移到对手那里会丢什么"。
3. **明确分层与可替换性**：平台层（Claw）与 runtime 层（AgentDev）的契约显式化，
   评估"平台层能否在另一 runtime 上成立"。这不是要现在换底座，而是避免被底座
   锁死，同时给底层补齐争取时间。

## 九、证据索引

- `docs/architecture.zh.md`：profile/bundle/patch 层叠、核心服务表、能力 seam
- `docs/cordis-primer.zh.md`：服务键、inject、事件分发、可逆副作用
- `vendor/include/src/patch.ts`：patch 应用与来源索引（`config` 整体替换）
- `packages/boot/app-boot/README.zh.md`：已知限制"用户 patch 替换整个配置"、
  兼容性检查不是沙箱、跳过 bundle 的后果
- `packages/boot/plugin-manager/README.zh.md`：profile 全局影响全部会话、
  Host 代码无沙箱、启停改变优先级、安装/版本/回滚流程
- `packages/boot/plugin-market/README.zh.md`：索引读取与安装分工
- `.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md`：
  profile 与 bundle 的决策与被否决方案
