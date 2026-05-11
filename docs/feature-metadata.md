# Feature 元数据说明

## 背景

AgentDevClaw 当前引入了一个本地 Feature 仓库概念：项目内部维护一组已经打包完成的 `.tgz` 包，首页中的 “Feature 仓库” 工作空间负责扫描这些包并展示信息。

现在这份元数据不再只是“仓库补录信息”。Feature 创建者工作空间已经把它纳入交付闭环：

1. 初始化新 Feature 项目时，会在项目根目录自动生成 `agentdev-feature.json`
2. 如果 `package.json.files` 存在，会自动把 `agentdev-feature.json` 加入可打包文件列表
3. 最终交付时，应通过 `feature-dev` 提供的 `featuredev_package_to_repository` 工具完成构建、打包、元数据写入和纳入当前系统托管的 Feature 仓库

对 Feature 创建者 Agent 来说，“进系统”是一个宿主管理概念：

- 它表示该 Feature 已成为当前系统中可浏览、可复用的交付产物
- 用户之后可以在 “Feature 仓库” 工作空间中看到它
- Agent 在正常工作流中不需要知道系统仓库的真实内部目录

这意味着元数据的主来源已经前移到 Feature 项目本身，而不是等 tgz 进入仓库后再补。

这个仓库页的目标不是做完整的安全治理平台，而是先提供一个可交付、可浏览、可解释的包目录，让团队能够：

- 知道仓库里有哪些 Feature 包
- 快速看出一个包大致是做什么的
- 看出它属于哪类 Feature
- 看出它是否支持 rollback
- 在元数据缺失时给出明确警告，而不是静默降级

当前框架仍在开发中，Feature 的能力边界、生命周期模型、权限治理模型都还不稳定。因此，这里的元数据设计采用“轻量但有方向”的策略：

- 先解决展示和基本分类
- 先解决 rollback 兼容性这种高价值信息
- 不先引入复杂、容易尴尬的权限声明系统
- 允许没有元数据的旧包继续工作，但会显示警告

## 当前实现位置

- 仓库扫描与聚合逻辑：`server.js`
- 仓库页面渲染：`public/index.html`
- 仓库入口：`prebuilt-agents/official/home/metadata.json`
- 仓库工作空间：`prebuilt-agents/official/feature-repository/metadata.json`
- 批量补元数据脚本：`scripts/enrich-feature-packages.mjs`

## 元数据文件

每个 Feature 包内可选包含一个文件：

`agentdev-feature.json`

它被打包在 tgz 的 `package/` 根目录下，与 `package.json` 同级。

在 Feature 项目源码目录中，它也位于项目根目录，与 `package.json` 同级。这样 `npm pack` 时可以直接把它带入产物。

例如：

```text
package/package.json
package/agentdev-feature.json
```

仓库页读取顺序如下：

1. 优先读取 `agentdev-feature.json`
2. 如果不存在，则回退读取 `package.json`
3. 使用 `package.json` 做有限推断
4. 在 UI 中标记警告，说明该包缺少专用元数据

## 设计原则

### 1. 元数据是“仓库可读描述”，不是强约束安全策略

当前的元数据首先是给仓库页、包管理视图和后续自动化流程看的。它可以帮助分类、筛选和解释 Feature，但不应该假装自己已经具备完整权限治理能力。

### 2. 元数据要允许缺失

仓库已经存在历史 `.tgz` 包，不能因为没有专用元数据就让它们不可见或不可用。缺失元数据时：

- 允许显示
- 允许回退推断
- 但必须显示警告

### 3. rollback 兼容性必须强制表达

这是当前最关键的兼容信息之一。无论 Feature 是否支持 rollback，都必须在兼容性标签中明确给出二选一结果：

- `supports-rollback`
- `no-rollback`

不能留空，不能模糊表述。

### 4. 分类标签优先表达“能力形态”

相比“这个包用了什么库”，当前更重要的是表达“这个 Feature 在系统里以什么方式工作”。因此元数据引入了 `featureTypes`。

## 当前元数据结构

当前仓库使用的元数据结构如下：

```json
{
  "schemaVersion": 1,
  "id": "shell-feature",
  "name": "shell-feature",
  "version": "0.1.0",
  "description": "Shell execution feature for AgentDev",
  "tags": ["agentdev", "feature", "shell"],
  "entry": "dist/index.js",
  "homepage": "",
  "repository": "",
  "agentdev": {
    "compatible": ">=0.1.0"
  },
  "featureTypes": ["tools"],
  "compatibility": {
    "rollback": false,
    "tags": ["no-rollback"]
  },
  "requirements": {
    "platforms": [],
    "node": "",
    "external": ["system-shell"],
    "services": []
  }
}
```

## 字段说明

### `schemaVersion`

当前元数据 schema 版本，当前固定为 `1`。

用途：

- 后续升级元数据结构时可做兼容分支
- 让仓库页或脚本明确知道自己在解析什么版本

### `id`

Feature 的稳定标识。当前通常取 npm 包名去掉 scope 后的尾部，例如：

- `@agentdev/shell-feature` -> `shell-feature`
- `@agentdev/qqbot-feature` -> `qqbot-feature`

要求：

- 应当稳定
- 应当适合作为前端列表项唯一标识
- 不应混入版本号

### `name`

展示名称。当前实现中通常与 `id` 相同，但它是独立字段，未来可以改成更友好的显示名。

### `version`

当前包版本，对应 tgz 内该版本的产物版本。

### `description`

Feature 简介，用于仓库卡片与详情页说明。应尽量描述“做什么”，而不是泛泛写成“AgentDev feature”。

### `tags`

普通标签，用于补充描述。它们不承担框架语义，不用于判断 rollback 或 Feature 类型。

当前通常来自 `package.json.keywords`。

### `entry`

包的主入口，一般取 `package.json.main`。

### `homepage` / `repository`

外部链接信息。当前用于仓库详情页中的外链按钮。

### `agentdev.compatible`

Feature 对 AgentDev 版本的兼容声明。当前直接沿用 `peerDependencies.agentdev` 的信息，例如：

```json
{
  "agentdev": {
    "compatible": ">=0.1.0"
  }
}
```

这个字段当前只做展示，不做强校验拦截。

## `featureTypes`

`featureTypes` 用于表达这个 Feature 在 AgentDev 中的能力形态，可多选。

当前允许的值只有以下几个：

- `tools`
- `mcp`
- `hooks`
- `control`
- `rollback`

### `tools`

表示该 Feature 直接提供非 MCP 的实际工具，通常对应：

- `getTools()`
- `getAsyncTools()`

这类 Feature 的主要能力体现为可调用工具。

### `mcp`

表示该 Feature 的主要能力来自 MCP 挂载出来的工具，而不是自己直接实现的普通 tools。

当前仓库内并没有大量依赖这一标签的包，但结构已经为它预留。

### `hooks`

表示该 Feature 主要通过 hook / lifecycle / reverse hook 机制参与运行，而不是仅仅提供工具。

### `control`

表示该 Feature 不只是“挂了一些 hook”，而且这些 hook 对流程有明显控制能力，例如：

- 阻断
- 审批
- 继续/结束流程决策
- 对 ReAct 循环产生明显控制

`control` 通常应当建立在 `hooks` 之上，但在结构上仍允许多标签独立表达。

### `rollback`

表示该 Feature 自身提供 rollback 相关能力，或者正确参与 rollback / restore 相关契约。

注意：

- `rollback` 是 Feature 类型标签
- `supports-rollback` / `no-rollback` 是兼容性标签

这两者不是一回事。

一个 Feature 理论上可能：

- 不属于 `rollback` 类型，但仍支持 rollback 兼容
- 属于 `rollback` 类型，并且当然应当带 `supports-rollback`

不过在当前项目阶段，最重要的是把兼容性信息表达清楚。

## `compatibility`

`compatibility` 表达当前仓库视角下最重要的兼容性结论。

当前结构为：

```json
{
  "compatibility": {
    "rollback": false,
    "tags": ["no-rollback"]
  }
}
```

### `compatibility.rollback`

布尔值，表示当前 Feature 是否支持 rollback 兼容。

当前这个值的意义是：

- `true`: 该 Feature 可以被视为支持 rollback / restore 相关契约
- `false`: 当前不支持，或至少没有声明为支持

### `compatibility.tags`

兼容性标签列表。当前最关键的强制标签为 rollback 二选一：

- `supports-rollback`
- `no-rollback`

这两个标签必须存在其一。

之所以同时保留布尔值和标签，是因为：

- 布尔值适合程序判断
- 标签适合前端直接展示和未来扩展

## `requirements`

`requirements` 当前只做“摘要表达”，不做严格环境治理。

结构如下：

```json
{
  "requirements": {
    "platforms": [],
    "node": "",
    "external": [],
    "services": []
  }
}
```

### `platforms`

平台摘要，例如：

- `win32`
- `darwin`
- `linux`

当前允许为空，表示没有明确声明。

### `node`

Node 版本需求摘要，例如：

- `>=20`

### `external`

外部资源或外部能力摘要，例如：

- `system-shell`
- `audio-output`
- `desktop-capture`
- `language-server`

这里不是权限系统，只是帮助用户快速理解依赖面。

### `services`

服务依赖摘要，例如：

- `network`
- `qqbot`

当前它表达“这个 Feature 大概率依赖这些服务能力”，而不是精确的联网策略配置。

## 当前推断策略

如果包内没有 `agentdev-feature.json`，系统会从 `package.json` 推断一部分信息。

当前主要推断内容有：

- 基础身份信息：`id`、`name`、`version`、`description`
- 普通标签：从 `keywords` 推断
- `agentdev.compatible`：从 `peerDependencies.agentdev` 推断
- `requirements`：根据依赖和包名做有限推断
- `featureTypes`：根据当前已知包名模式做有限推断
- `compatibility.tags`：至少补一个 rollback 二选一标签

### 当前 Feature 类型推断示例

- `shell-feature` / `websearch-feature` / `visual-feature` / `tts-feature` / `lsp-feature` / `memory-feature`
  - 推断为 `tools`
- `audio-feedback-feature` / `audit-feature` / `plugin-compat-feature`
  - 推断为 `hooks`
- `qqbot-feature`
  - 推断为 `hooks` + `control`

这套推断是当前项目内的工程性约定，不是通用标准。未来如果 Feature 形态变化，需要同步调整脚本与服务端逻辑。

## 为什么现在不做更复杂的权限模型

当前没有把元数据做成细粒度权限系统，原因很现实：

- 框架本身还在开发中
- Feature 能力边界还不稳定
- 细粒度权限很容易写得“看起来合理，实际使用尴尬”
- 如果现在过早做强约束，后续大概率会推翻

因此目前只保留：

- 类型分类
- rollback 兼容性
- requirements 摘要

这些信息足够支撑仓库展示和基本判断，但不会制造一种“已经治理完毕”的假象。

## 仓库页中的展示策略

当前仓库页采用以下策略：

### 卡片层

卡片只显示少量高价值信息：

- 名称
- 版本
- 简介
- 归档数 / 更新时间摘要
- `featureTypes` 标签
- rollback 兼容标签
- 警告提示（仅在有警告时出现）

卡片的目标是让人快速扫库，不是承载所有细节。

### 详情层

点击卡片后进入详情层，展示：

- 版本统计
- Feature 类型标签
- 兼容性标签
- requirements 摘要
- tags
- 版本列表
- 警告信息
- 外部链接

## 元数据缺失时的行为

如果一个包没有 `agentdev-feature.json`：

- 包仍然会显示在仓库页
- 系统会回退使用 `package.json`
- 系统会做有限推断
- UI 中会显示警告

这是为了兼容历史包和第三方包。

## 现有打包产物的补充方式

项目内提供了脚本：

```bash
npm run enrich:features
```

它会遍历 `resources/features/*.tgz`，解包后向每个包内写入 `agentdev-feature.json`，再重新打包。

这个脚本仍然有用，但它现在主要服务于历史包修复，不是推荐的主流程。新的推荐流程是：

1. 用 Feature 创建者初始化项目
2. 在项目根目录维护 `agentdev-feature.json`
3. 用 `featuredev_package_to_repository` 产出最终 tgz 并写入仓库

这个脚本当前的作用是：

- 给历史包批量补最小元数据
- 保证 rollback 兼容标签一定存在
- 把仓库页从“纯 package.json 信息”提升到“有明确结构的元数据”

## 当前已知限制

### 1. `featureTypes` 目前带有工程推断色彩

当前并没有对每个包做源码级深度分析，很多类型是通过已知包名和项目背景推断出来的。这对当前交付足够，但不应被误解为形式化验证结果。

### 2. `compatibility.rollback` 当前偏声明式

当前它表示“仓库层面认为支持 / 不支持”，而不是运行时严格校验过的结果。后续如果 rollback 机制更加稳定，可以补充更严格的验证流程。

### 3. `requirements` 只是摘要，不是权限系统

例如 `services: ["network"]` 只能说明“这个 Feature 大概率依赖网络能力”，不表示已经有域名白名单、流量控制、联网审批等机制。

## 后续演进方向

在不破坏当前 schema 的前提下，后续可以逐步增强：

- 增加更细的兼容性字段，如宿主版本、平台限制、模板要求
- 增加更明确的工具统计，如普通 tools 数量、MCP tools 数量、hook 数量
- 增加构建来源、签名、校验摘要
- 增加“宿主扫描结果”与“包内自声明”的区分
- 引入更强的 rollback 能力验证

但这些演进都应建立在框架行为先稳定的基础上。

## 当前结论

当前的 Feature 元数据不是终态，也不是安全治理终稿。它是一个面向交付的、最低必要但结构正确的方案：

- 让仓库页可用
- 让 Feature 可分类
- 让 rollback 兼容性可见
- 让历史包可兼容
- 给未来治理升级留下空间

如果后续要继续扩展，应优先保持这几点不变：

- 允许缺失元数据但必须警告
- rollback 兼容标签必须二选一
- `featureTypes` 专注表达能力形态
- `requirements` 在框架未稳定前保持摘要级别
