# ADR-0052: 插件体系的管理模型与用户心智模型（一包多 feature、空间私有仓库、资产隔离）

日期：2026-11-19
状态：Accepted（本轮定稿；实现按文末清单推进）
关联：[ADR-0045](0045-external-plugin-package-and-workspace-assembly.md)（包与装配机制）、
[ADR-0046](0046-plugin-management-product-system.md)（插件管理产品体系，本 ADR 修订其
一包一 feature、仓库归属与资产寻址三处）

## 背景

插件机制可用之后，产品层的三个问题一直没被定义清楚，导致每加一个功能都要
临时决定，改动互相牵制：

1. **对象模型不稳**：插件包、feature、面板、数据服务、内置能力、官方可选
   插件的关系没有一处写全。一个包能不能带多个 feature、配置挂在谁身上、
   面板与数据面归谁，答案散在各处实现里。
2. **仓库归属含糊**：全局两仓是库存还是装配源、工作空间要不要自己的仓库、
   包与装配的关系，用户与自己都容易混。
3. **用户心智模型缺失**：全局设置、工作空间设置、右栏面板三个入口各自能
   做什么、结果是什么，没有一份对照；"导入后删不掉""列表里一堆没描述
   的内置项"都是这个缺口的表现。

本 ADR 一次性定义对象模型、存储与归属、生命周期、一包多 feature 契约、
内置能力边界、资产与 URL 寻址，以及界面信息架构。后续实现以此为准，
不在具体功能里临时决定。

## 决策

### 1. 对象模型（术语与关系）

| 对象 | 定义 | 谁持有 | 处置单位 |
|---|---|---|---|
| **仓库（Repository）** | 插件包（tgz）的存放处，分三层来源 | 官方区随产品、用户区与空间私有区随数据目录 | 包 |
| **插件包（Plugin package）** | 一个 tgz，含工具面 / UI 面 / 数据面，是导入、装配、处置的唯一单位 | 仓库 | 包 |
| **插件 feature** | 包内工具面的一个运行时单元（Feature 类实例），一个包可含 1..N 个 | 包 | 包（不单独装卸） |
| **面板（Panel）** | 包内 UI 面声明，可多个，面板 id 全局唯一 | 包 | 包 |
| **数据服务（Server facet）** | 包内 server 声明，单入口单 prefix | 包 | 包 |
| **装配声明（$mount）** | 配置层里的一条包级声明 `{ package, version, enabled? }` | 工作空间配置层 / global 层 | 包 |
| **内置能力（Built-in capability）** | agent.js 静态装配的产品本体，无包坐标 | 宿主 | 无（随产品升级） |
| **官方可选插件（builtin）** | 宿主内置工厂、用开关装配的能力，无包坐标 | 宿主 | 装配开关 |

关系：仓库持有包 → 包提供 feature / 面板 / 数据服务 → 用户把包装配到某个
装配层 → 运行时按装配把包展开成 N 个 feature 实例，并把面板与数据服务按
装配身份下发。

**不变量**：装配、卸载、删除永远是包级；feature 是包的运行期投影，不存在
"只装包里的某一个 feature"。多 feature 包提供 feature 级启用/禁用
（`$mount.disabledFeatures`）：被禁用的实例不挂载，包、配置、面板与数据面
仍保留；需要独立安装与版本节奏的能力仍应拆成独立包。

### 2. 仓库三层与归属

| 层 | 路径 | 可见范围 | 写入入口 |
|---|---|---|---|
| 官方库存 | `resources/features/` | 全局（但不上商店货架） | 随产品分发 |
| 用户库存 | `user-features/` | 全局（所有装配身份可见） | 设置 → 插件管理（上传 tgz） |
| 空间私有 | `workspaces/<agentId>/features/` | 仅所属工作空间 | 工作空间设置 → 插件页（导入到本空间） |

- 同包同版本并存时解析优先级：**空间私有 > 用户库存 > 官方库存**。
- 空间私有包不进入其他空间的货架、装配解析、面板声明与数据面挂载。
- `featureMounts: true` 的工作空间才拥有装配身份与私有仓库；未声明的工作
  空间不出现插件装配入口。
- 全局层的 `$mount` 是**默认装配源**：只对 metadata 声明 `defaultMounts: true`
  的工作空间生效，且只引用全局库存（不引用空间私有包）。

### 3. 一包多 feature 契约

manifest（v3 扩展，向后兼容）新增可选数组：

```json
{
  "schemaVersion": 3,
  "entry": "index.js",
  "export": "FooFeature",
  "features": [
    { "name": "foo", "export": "FooFeature" },
    { "name": "bar", "entry": "bar.js", "export": "BarFeature" }
  ],
  "settings": {
    "features": {
      "foo": { "properties": { "vaultPath": { "type": "string" } } },
      "bar": { "properties": { "limit": { "type": "number" } } }
    }
  }
}
```

规则：

- 无 `features` / 空数组 = 单 feature 包，行为与既往完全一致（`entry` /
  `export` 沿用顶层）。
- `features[].name` **必填**，字符集 `[A-Za-z0-9][A-Za-z0-9._-]*`，包内唯一；
  它同时是运行时实例名、配置树键与界面展示键。
- `features[].entry` 缺省用顶层 `entry`；`features[].export` 缺省按 loader
  的单类推断（同一 entry 多个导出时必须在声明里写 export）。
- 装配：一条 `$mount` 展开为 N 个运行时 feature；装卸/禁用/删除仍按包。
- 配置：多 feature 包用 `settings.features[<name>].properties`，键与 feature
  名对齐；顶层 `settings.properties` 在多 feature 包内不单独成节（避免一个键
  对应多个实例）。单 feature 包仍用顶层 `settings.properties`。
- 面板与数据面：按包归属，不按 feature 拆分；`when.agentIds` 仍是装配身份。
- feature 级禁用：`$mount.disabledFeatures: ["bar"]` 声明包内不挂载的实例。
  包仍装配、环境与配置保留、面板与数据面按包保留；重新启用只改声明，不重装
  环境。仅多 feature 包可用——单 feature 包声明该字段会被装配链拒绝（应改用
  包级 `enabled: false`），避免"禁用不生效"的静默误解。
- 冲突：包内 feature 名重复、与内置能力或其他已装包同名 → 运行时 fail fast。

### 4. 配置与状态全景（文件层级与关系）

插件体系里"配置文件"不是一个东西，而是四类文件加一份运行时投影。它们各自
归属不同管理层，读写方与生效边界也不同。

**按管理层归属**

| 层 | 文件 / 存储 | 内容 | 谁写 | 何时生效 |
|---|---|---|---|---|
| 包（作者） | `agentdev-feature.json`（包内） | 包声明：`entry` / `export` / `features[]` / `settings`（schema）/ `ui.panels[]` / `server` | 作者打包时写入 | 随导入的新版本 |
| 包（作者） | `package.json`（包内） | 包名与版本（仓库坐标） | 作者 | 同上 |
| Claw 层 | `resources/features/*.tgz` | 官方库存包 | 随产品分发 | 随产品版本 |
| Claw 层 | `user-features/*.tgz` | 用户库存包 | 设置 → 插件管理导入 | 货架即时 |
| Claw 层 | `~/.agentdev/AgentDevClaw/feature-setup.json` | global 配置层：全局默认参数 + 默认装配声明 | 配置 API / 插件管理 | 面板与数据面即时；工具面下次启动 |
| 工作空间层 | `workspaces/<agentId>/features/*.tgz` | 空间私有库存包 | 工作空间插件页导入 | 本空间货架即时 |
| 工作空间层 | `workspaces/<agentId>/feature-config/agent.json` | agent（工作空间）配置层：本空间装配声明 + 参数覆盖 | 配置 API / 插件页 | 同上 |
| 工作空间层（PH） | `workspaces/programming-helper/feature-config/project-<id>.json` | 项目层参数（不承载 `$mount`） | 配置 API | 同上 |
| 工作空间层（PH） | `workspaces/programming-helper/feature-config/dir-<hash>-<name>.json` | 目录层参数（不承载 `$mount`） | 配置 API | 同上 |
| 工作空间层 | `workspaces/<agentId>/feature-config/ui-prefs.json` | 面板呈现配置（显隐/排序）+ 面板偏好 KV | 前端宿主 / 面板作者 | 面板渲染即时 |
| 解出物（可重建） | `user-features/assets|server-env/<pkg>/<ver>/` | 全局包 UI 资产 / 数据面代码 | 导入链路解出、自愈重建 | 资产 URL 即时 |
| 解出物（可重建） | `workspaces/<agentId>/feature-assets|feature-server/<pkg>/<ver>/` | 空间私有包 UI 资产 / 数据面代码（见 §7） | 同上 | 同上 |
| 运行时 | `runtime-envs/<agentId>:user-mounts/<hash>/` | 依赖环境（内容寻址） | provisioner | 随 runtime 启动 |
| 运行时 | 会话注入 `runtime.config.featureOverrides` | 会话级临时参数覆盖，不落盘 | 会话（分支/接续/接口） | 当前会话 |

**四类文件回答四个不同问题**

1. **包声明（manifest）回答"这个包是什么、能配什么"**：它只描述，不含用户值。
   `settings` 是 JSON Schema properties，决定配置界面渲染什么控件；本身不保存值。
2. **配置层文件回答"用户选了什么"**：键是 feature 名，值是用户配置。
   `$mount` 是同一文件里的特殊键，回答"装了什么包、什么版本、是否禁用"。
   装配与参数共用一个文件，但语义互不覆盖：`$mount` 后层整体替换前层，
   参数按层字段合并。
3. **ui-prefs 回答"这个空间的界面长什么样"**：纯空间级、不分层，每个空间从零
   开始；`presentation` 归宿主，`panelPrefs` 归面板作者，宿主不解释其值。
4. **解出物与环境回答"代码从哪来、依赖装在哪"**：全部可重建，不作为事实源；
   丢失时按仓库 tgz 与环境 hash 自愈。

**关系链（一次装配到运行的完整路径）**

```
配置层文件（global → agent → project/dir → session）
   │  $mount（包+版本）                      │  参数值（按 feature 名）
   ▼                                        ▼
装配事实 ──→ 仓库解析（空间私有 > 用户 > 官方）──→ 依赖环境 provision
   │                                        │
   ▼                                        ▼
运行时 feature 实例（一包 N 个）           Feature 构造参数（merged 配置）
   │                                        │
   ├── UI 面：面板声明（when.agentIds=装配身份）→ 资产 URL
   └── 数据面：server 挂载（prefix）→ getConfig 按请求上下文合成
```

**层级与合并规则（容易混淆的三点）**

- **`$mount` 只在 global / agent 层有效**，项目层、目录层、会话注入拒绝写
  `$mount`（装配是身份级事实）。参数值四层都能写。
- **合并方向是 global → agent → project/dir → session**，后层覆盖前层；
  `$mount` 是整体替换而不是字段合并，`null` 表示卸载，`enabled: false` 表示禁用。
- **默认装配源**只在 global 层，通过 `defaultMounts` 声明 opt-in 后并入身份层，
  合并语义与普通声明一致。

**谁能改、改了影响什么**

- 包声明只能通过"重新打包 + 导入新版本 + 显式升级装配"改变；直接改仓库内
  tgz 会破坏 digest 纪律（同版本不同字节被拒）。
- 配置层文件可由 API 写、也可手工编辑；读取是现读，所以面板与数据面即时，
  工具面要等下一次 runtime 启动。
- ui-prefs 只由服务端 UI 路由写；前端不落 localStorage。
- 解出物与运行时环境可以随时删除，系统会按需自愈，不构成数据丢失。

### 4a. 插件设置：一个用户入口，多个显式消费方（2026-11-19 修订）

本节修订 §3、§4、§7 与不变量 6 中的配置描述，以及 ADR-0046 §3 的「按面寻址」：**参数层级由当前使用上下文决定，不由工具/UI/数据面决定**。未声明新契约的存量包继续走旧读法；本节是新契约，实施与验收见末尾。面板偏好与右栏布局不在本次修订范围；`$mount` 仍只管理装配，项目和目录只覆盖参数。

**三种对象，不合并 manifest。** Feature manifest 定义原生 Feature 接受的参数；UI 声明定义 UI 自己的业务参数；包声明的 `pluginSettings.fields` 则选择要向用户公开的设置，声明字段如何绑定消费方。引用只复用定义，不复制默认值和校验规则。绑定生成参数值，不生成或修改 Feature manifest。浏览器无需加载 Feature 本体来获得 schema：包里已有的 `settings.features` 承载打包时导出的 Feature 设置声明，UI 可在自己的 `ui.settings.properties` 描述业务参数。运行时仍装配原生 Feature。

```json
{
  "features": [{ "name": "lookup", "export": "LookupFeature" }],
  "settings": { "features": { "lookup": { "properties": {
    "directory": { "type": "string" },
    "limit": { "type": "number", "default": 20 }
  } } } },
  "ui": { "settings": { "properties": { "collection": { "type": "string" } } } },
  "pluginSettings": { "fields": {
    "library": { "schema": { "type": "string", "format": "path" },
      "targets": [{ "feature": "lookup", "field": "directory" }] },
    "limit": { "from": { "feature": "lookup", "field": "limit" } },
    "collection": { "from": { "ui": "collection" } }
  } }
}
```

- `schema` 与 `from` 二选一。`from.feature` 默认绑定回被引用的原生字段；`from.ui` 复用 UI 字段声明，并允许浏览器读取该插件字段。包自定义字段如需浏览器直接读，显式声明 `exposeToUi: true`。没有绑定的字段依然可以被数据服务使用。第一批只开放现有编辑器能可靠承接的扁平标量（字符串、数字、整数、布尔）；未知引用、目标重复或类型不匹配直接报错。绑定的 Feature 用 `features[]` 显式声明身份。
- **一份持久值。** 在现有全局/工作空间/项目/目录层文件中保留独立的插件参数命名空间（键为 `$plugin:` 加完整包名，包名中的点编码为 `%2E`，避免与现有编辑器点路径混淆）。稳定键按包名和字段，不含版本；不同空间自然有独立覆盖。合成顺序为声明默认 → 全局 → 工作空间 → 项目或目录。项目、目录不互相继承；首页没有具体归属时读取到工作空间。未声明字段不进入消费方。已映射的原生字段由插件值接管；没有插件值时保留原生参数的旧值或 Feature 自己的默认值。投影不回写层文件，也不把插件命名空间作为 Feature 交给框架。未映射的原生参数不受影响。
- **同一个使用上下文，同一个合成规则。** Feature 启动时用已经绑定的项目/目录；浏览器和数据服务请求显式使用本地工作空间及可选会话。宿主按会话记录解析归属，有项目时用项目 ID，否则用记录中的目录；不取活跃会话、不取第一个装配身份，也不按目录猜项目。缺失或矛盾的请求上下文显式失败。声明编辑时支持直接选项目或目录层，不需要伪造会话。会话期临时注入仍是原生 Feature 的独立机制，不新增插件设置的会话持久层。保存后在线读取端可取新值，已启动的 Feature 保持启动快照。
- **读取与编辑分离。** Claw 用已装配版本的包声明合成设置视图，现有参数编辑器按入口编辑一层；同一设置不再为每个贡献面生成重复表单。不含 `pluginSettings` 的包保留原生设置入口与兼容读法。浏览器消费面只返回明确公开的字段；新数据路由必须按请求绑定装配身份、包版本和来源，而非按同名全局选一个。首批不重做右栏注册表：遇到分发版本/来源不匹配应拒绝读取，不借用别的工作空间的配置或实现。

**宿主读取接口。** 容器型面板在 `mountBody(element, context)` 中使用 `context.getPluginSettings()` 读取显式公开的字段，用 `context.pluginRequestUrl(path)` 给同源数据请求附上工作空间、会话和包摘要。数据路由在 handler 中以 `context.getConfig(req)` 读取该请求的设置快照。摘要用于拒绝制品错配，不是授权凭证；右栏注册表仍只承载每个 panelId 的一个实现，不匹配的空间不会借用该实现。每层只有一个编辑面：工作空间层在「工作空间设置 → 参数配置」，全局默认层在「插件配置 → 默认装配」卡片的齿轮，项目与目录层在各自的设置弹窗。插件商店卡片的齿轮不另开配置弹窗，而是收起商店并跳到所在空间的参数配置并选中该项。

验收：用一个包验证「共享字段、仅 Feature 字段、仅 UI 字段」；工作空间、同目录的项目会话与目录会话各有不同覆盖；Feature 构造参数、UI 和服务端各读到对应投影；清除覆盖恢复继承；两空间不会串读；旧包不迁移、不改行为。Agentero 是存量样例，不要求随本次改造改包。

### 5. 生命周期（动作矩阵）

| 动作 | 前置 | 效果 | 生效边界 |
|---|---|---|---|
| 导入 | tgz 包名/版本/digest 合法；同版本同字节幂等，不同字节拒绝（同仓库内） | 包入库 + 解出 UI/数据面资产 | 货架即时可见 |
| 装配 | 包在可见仓库；版本精确 | 写 `$mount`；provision 环境 | 工具面随该身份下次新会话；UI/数据面即时 |
| 禁用 | 已装配 | `enabled: false`：三面下线、声明与配置保留 | 即时（面板/数据面），工具面下次启动 |
| feature 启用/禁用 | 已装配的多 feature 包 | 写 `$mount.disabledFeatures`；对应实例不进入装配计划，包与其余 feature 照常 | 工具面下次启动；面板与数据面不变（按包归属） |
| 卸载 | 已装配 | `$mount` 置 null；配置保留在层文件 | 同上 |
| 升级 | 新版本已在仓库 | 装配改指新版本；环境按 digest 重建 | 同上 |
| 删除 | 无任何装配引用 | 删除 tgz | 数据面重建；资产目录保留（见 §7） |
| 环境修复 | 已装配、env 缺失/损坏 | 按声明组合重建环境 | 即时 |

删除前引用检查的范围：全局库存删除查全部装配身份 + 默认装配源；空间私有
删除只查所属工作空间。被引用时拒绝并返回引用明细。

### 6. 内置能力与插件的边界（过渡策略）

- **内置能力**（todo、shell、memory、context-guard、mcp、skill、stylized-output
  等）是产品本体，继续静态装配、随宿主升级，不进仓库、不可装卸。它们在
  设置页的「内置能力」区只呈现与配置。
- **官方可选插件**（builtin 工厂：playwright-shell、lsp 等）属于插件区：
  有装配开关，无包坐标、不可删除。
- **tgz 插件**：完整生命周期（导入/装配/禁用/卸载/删除/升级）。
- 历史遗留的"裸挂 feature"不迁移、不改造成 tgz；它们就是内置能力。新的
  可插拔能力一律走插件包。
- 边界判据：**随产品分发且不可卸载 = 内置；可装卸/可禁用 = 插件**。

### 7. 资产与 URL 寻址（空间维度）

资产按仓库来源分区；同名同版本不同字节可跨来源并存：

| 来源 | UI 资产目录 | 数据面目录 | URL |
|---|---|---|---|
| 全局库存 | `user-features/assets/<pkg>/<ver>/` | `user-features/server-env/<pkg>/<ver>/` | `/protoclaw/feature-assets/<pkg>/<ver>/<file>` |
| 空间私有 | `workspaces/<agentId>/feature-assets/<pkg>/<ver>/` | `workspaces/<agentId>/feature-server/<pkg>/<ver>/` | 同上 + `?ws=<agentId>` |

- digest 纪律在各自目录内生效，同名同版本不同字节可跨来源并存。
- 面板声明按"包 + 装配版本"下发的 URL 必须指向该版本实际来源目录；同一
  panelId 仍全局唯一，多来源并存时取最高装配版本并给出 warning。
- 数据面加载路径按装配事实解析来源目录；`context.getConfig()` 按请求上下文
  的工作空间合成配置（现状取第一个装配身份，属待收敛项，见 §10）。
- 资产自愈（解出物缺失时从仓库 tgz 现场解出）按来源目录执行，负缓存键带
  来源身份。

### 8. 用户心智模型与信息架构

三个入口，职责不重叠：

1. **设置 → 插件管理（Claw 级）**
   - 看到：全局库存的全部可装配包、默认装配清单。
   - 能做：上传 tgz 入库、删除库存包（被引用时拒绝）、设/撤默认装配。
   - 不做：工作空间的装配（不放这里）。
2. **工作空间设置 → 插件及配置**
   - 看到两个区段：
     - **插件**：本空间已装的可处置包（builtin 可选 + tgz 包），标注来源
       （全局 / 本空间）与包内 feature 数。
     - **内置能力**：产品本体内置能力，只读呈现 + 参数配置。
   - 能做：打开商店添加插件（全局库存 + 本空间私有）、导入 tgz 到本空间、
     配置、移除、删除本空间私有包。
   - 不做：管理全局库存。
3. **会话右栏**
   - 看到：当前 runtime 实际挂载的 feature 实例与插件面板。
   - 能做：使用面板、看运行时状态；不承担装配管理。

一句话心智：**插件管理是仓库，工作空间插件页是"我装了什么"，右栏是"正在跑什么"。**

### 9. 一致性不变量（实现与评审检查表）

1. 装配、禁用、卸载、删除都以包为单位；feature 不可单独处置。
2. `$mount` 是装配的唯一事实源；仓库只是库存。
3. 空间私有包不跨空间可见、可装、可下发。
4. 删除前必须无装配引用；装配中的包删除被拒绝。
5. 面板可见性 = 装配身份集合；作者 scope 只是建议。
6. 存量包按原生 Feature 名取参数；选择 `pluginSettings` 的包按完整包名读插件参数，再按显式绑定生成原生 Feature 参数（§4a）。
7. 版本钉精确；升级是显式动作。
8. feature 级禁用只影响实例挂载，不改变包级处置、版本与可见性。
9. 默认装配源只对 opt-in 身份生效，且只引用全局库存。

### 10. 已知待收敛项（不回避，明确挂账）

- **数据面配置上下文**：`context.getConfig()` 现取第一个装配身份合成，目标
  是按请求上下文（面板所在工作空间）合成；需要插件数据面请求携带工作空间
  标识，宿主注入。
- **多来源同名包的面板/数据面**：同一 panelId 的多个来源目前取最高装配版本
  并 warning；若将来需要按身份下发不同实现，需要把 panel 注册改为按
  `(panelId, agentId)` 维度。
- **升级交互**：服务端已支持多版本并存与改指，界面尚无"升级到 X"动作。
- **内置能力插件化**：保留为未来选项，不在当前范围（见 §6）。
- **空间私有包的跨空间复用**：当前不提供共享动作；用户可重新导入到目标
  空间（各自独立 digest 与资产目录）。

### 11. 实现映射（本轮及后续）

| 关注点 | 模块 |
|---|---|
| 仓库扫描与来源优先级、多 feature 解析 | `server/feature-runtime/catalog.js` |
| 装配展开（一包 N feature） | `server/feature-runtime/user-mount.js` |
| 装配声明与环境 | `server/feature-runtime/install-service.js` |
| 面板/数据面合成与 URL | `server/feature-runtime/plugin-ui.js`、`plugin-server.js` |
| 资产解出与自愈 | `server/feature-runtime/feature-assets.js` |
| 商店数据面与删除引用检查 | `server/routes/feature-store.js`、`feature-repository.js` |
| 空间私有仓库 | `server/shared/constants.js`、`catalog.js` |
| 插件页与商店 | `public/src/modules/ph-settings.js`、`feature-store.js` |
| 配置编辑器 | `server/routes/system-feature-config.js`、`public/src/modules/feature-config-editor.js` |

## 后果

- manifest 契约扩展（features[]、settings.features），需同步 Agent Studio 的
  包元数据文档与打包校验。
- 资产目录与 URL 增加空间维度，`plugin-ui` 生成 URL、资产路由与自愈均按
  来源解析。
- 配置清单与配置编辑器按 feature 名展开，插件页卡片显示包内 feature 数。
- 删除接口按包坐标 + 引用检查（已实现）。
- 插件页两个区段（插件 / 内置能力）固化，内置能力不再出现在"插件"区。
- 后续新增可插拔能力一律走插件包；内置能力清单保持静态。
