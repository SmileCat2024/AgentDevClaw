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
    "compatibility": { "rollback": false }
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

`type`、`capabilities`、`provides`、依赖、requirements 和 rollback 描述的是不同维度，不要把它们合并成一个自由文本分类。不要臆造依赖或能力；不能确定的项应先检查实现并询问用户。

## Agent Studio 打包检查

`studio_create_snapshot` 会从源码目录调用 Claw 的 packager。packager 会根据 `package.json` 生成旧版 `agentdev-feature.json` 的兼容摘要，因此 Registry 能读取，但 ADR-0017 的 Manifest v2 仍应直接写入 `package.json.agentdev`。创建快照前应检查：

1. `package.json.agentdev.schemaVersion` 为 `2`，元数据与实现一致；
2. `package.json.description`、`keywords`、`main`、`engines.agentdev` 已填写；
3. 运行 `npm pack --dry-run --json` 检查包内有 `package.json` 与 `dist/index.js`，以及 Feature 实际需要的技能/静态资源；
4. `package.json` 版本与即将快照的版本一致；改变元数据后重新构建、验证，再生成快照。

Agent Studio 的旧 packager 兼容文件不是 Manifest v2 的替代品。若 Repository 展示仍缺 `type`、`capabilities`、`provides` 等信息，应先检查生成 tgz 内的 `package.json.agentdev`；不要靠 Claw 根据包名猜测。
