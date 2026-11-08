# Feature 包元数据（Claw 仓库契约）

Agent Studio 产出的 Feature 会被 Claw 仓库浏览、筛选和装配。元数据契约属于 Claw，不应把实现或修改回流到 AgentDev 框架仓库。

## 唯一权威来源

包根目录的 `package.json` 使用 `agentdev` 字段声明 Feature 元数据。不要生成或维护第二份 `agentdev-feature.json` 文件；`npm pack` 自然会把 `package.json` 纳入 tgz。

```json
{
  "name": "@agentdevjs/my-feature",
  "version": "0.1.0",
  "description": "清楚说明这个 Feature 提供什么能力、何时使用。",
  "main": "dist/index.js",
  "keywords": ["agentdev", "feature", "my-feature"],
  "engines": {
    "agentdev": "^0.1.0"
  },
  "agentdev": {
    "schemaVersion": 2,
    "id": "my-feature",
    "displayName": { "zh": "我的 Feature", "en": "My Feature" },
    "type": "ability",
    "capabilities": ["tools"],
    "provides": {
      "tools": ["my_tool"],
      "skills": [],
      "commands": [],
      "hooks": true,
      "mcp": false
    },
    "depends": [],
    "requirements": { "external": [], "services": [], "platforms": [], "node": "" },
    "compatibility": { "rollback": false },
    "export": "MyFeature",
    "ui": {
      "panels": [
        {
          "id": "my-panel",
          "pluginId": "my-panel",
          "entry": "index.js",
          "scope": "assembly",
          "label": { "zh": "我的面板", "en": "My Panel" },
          "order": 90
        }
      ]
    },
    "server": { "entry": "index.js", "prefix": "my-feature" }
  }
}
```

## 填写要求

- `id` 必须与 Feature 实例的 `name` 一致；稳定、小写 kebab-case。
- `displayName` 用中英文准确命名，供 Claw 界面展示。
- `type` 选择一个：`ability`（能力）、`governance`（治理）、`interface`（接口）、`system`（系统）。不要用能力列表代替类型。
- `capabilities` 从 `tools`、`policy`、`commands`、`skills`、`mcp` 中选择零个或多个，依据实际提供能力，不按包名猜测。
- `provides` 描述运行时形态：列出工具名、技能名、命令名，并如实设置 hooks / mcp 布尔值。
- `depends` 列出 `static inject` 依赖（`{ "id": "dependency-name", "range": "*" }`）。
- `requirements` 说明实际依赖的平台、Node 版本、外部程序与服务。
- `compatibility.rollback` 必须明确为布尔值。
- 顶层 `description` 写清用户能获得的价值；`keywords` 用于搜索。
- `engines.agentdev` 写兼容的 AgentDev 版本范围。

### 三面静态声明（schemaVersion 3，全部可选）

插件包（ADR-0045）除 Feature 工具面外还可携带 UI 面与数据面，三者同包分发。没有对应实现就不要声明：

- `export`：Feature class 的导出名。入口（`main` 指向的模块）除 Feature class 外还有其他导出、且没有 default 导出时**必填**——否则 `$mount` 装配后 runtime 启动会失败（无法唯一确定 Feature 导出）。入口只有 default 导出或唯一导出时可省略。
- `ui.panels[]`：UI 面声明。`id`/`pluginId` 全局唯一；`entry` 是 `client/` 目录（预构建自包含 ESM，浏览器无 npm 解析，React 等依赖必须打进产物）下的入口相对路径；`scope`：`assembly`（默认，仅装配了此插件的工作空间可见）或 `global`（所有界面可见）；`label` 中英文供右栏按钮展示。
- `server`：数据面声明。`prefix` 单段小写（路由最终挂载在 `/protoclaw/plugin/<prefix>/` 下）；`entry` 是 `server/` 目录（导出 `registerRoutes(router, context)` 的 ESM 模块）下的入口，默认 `index.js`。

`studio_create_feature` 的 `featureExport` / `uiPanels` / `serverFace` 参数对应以上三项，会写入 `package.json.agentdev` 并经快照链路进入 tgz 顶层 `agentdev-feature.json`。声明与实现不符会在装配或加载时 fail fast，不要提前声明未实现的面。

`type`、`capabilities`、`provides`、依赖、requirements 和 rollback 描述的是不同维度，不要把它们合并成一个自由文本分类。不要臆造依赖或能力；不能确定的项应先检查实现并询问用户。

## Agent Studio 打包检查

`studio_create_snapshot` 会从源码目录调用 Claw 的 packager。packager 从 `package.json` 生成 tgz 顶层 `agentdev-feature.json`（供 Claw 仓库/catalog 读取），其中 `export` / `ui` / `server` / `settings` 直接提取自 `package.json.agentdev`。 `settings` 必须是 JSON Schema object 形态（字段声明在 `settings.properties.<字段名>` 下，与框架 `getFeatureManifest()` 产出一致）；扁平直挂的形态会被配置聚合链判为无配置项。创建快照前应检查：

1. `package.json.agentdev.schemaVersion` 为 `3`，元数据与实现一致；三面声明（`export` / `ui` / `server`）与实际构建产物（`dist/` / `client/` / `server/`）对应；
2. `package.json.description`、`keywords`、`main`、`engines.agentdev` 已填写；
3. 运行 `npm pack --dry-run --json` 检查包内有 `package.json`、`agentdev-feature.json`、`dist/index.js`，以及声明了的面目录（`client/` / `server/`）与 Feature 实际需要的技能/静态资源；
4. `package.json` 版本与即将快照的版本一致；改变元数据后重新构建、验证，再生成快照。

若 Claw 仓库展示仍缺 `type`、`capabilities`、`provides` 或三面声明未生效，应先检查生成 tgz 内 `package.json.agentdev` 与顶层 `agentdev-feature.json` 是否一致；不要靠 Claw 根据包名猜测。
