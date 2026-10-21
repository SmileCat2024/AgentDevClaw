# 工作空间内 Agent 声明与会话绑定

工作空间是 OS 的应用单元；Agent 是工作空间内持有名字和装配的对话实体。每个对话在创建时固定绑定一个 Agent，恢复、分支和接续保持该绑定。本契约不提供对话内切换或多 Agent 同时参与。

## 声明

工作空间 `metadata.json` 声明 Agent 清单和默认项。`name` 是工作空间名称，`displayName` 是 Agent 名称，二者互不替代。

```json
{
  "id": "example-workspace",
  "name": "示例工作空间",
  "defaultAgentId": "main",
  "agents": [
    { "id": "main", "displayName": "执行助手" },
    { "id": "reviewer", "displayName": { "zh": "审查助手", "en": "Reviewer" } }
  ]
}
```

- ID 在工作空间内唯一，使用字母、数字、下划线或连字符，首字符须为字母或数字。
- 名称是非空字符串或非空语言映射。
- 多 Agent 必须声明有效的 `defaultAgentId`；单项清单可省略默认项。
- 空清单、重复 ID、无效默认项和未知请求 ID 均明确报错，不按清单顺序猜测。

## 装配

沿用工作空间的 `agent.js` 入口，命名导出 `agents` 映射到具体构造函数。

```js
export default MainAgent;
export const agents = { main: MainAgent, reviewer: ReviewerAgent };
```

`main` 可沿用 default export；既有仅命名导出一个构造函数的单 Agent 模块也可继续使用。非 `main` Agent 必须有同 ID 的映射，缺少装配会使启动失败，不运行其他 Agent 代替。

共享进程只共享进程资源，每个 Session 分别根据自身绑定选择构造函数。模型预设、权限、Feature 配置仍采用工作空间作用域；本契约不引入 Agent 级配置作用域。

## 会话权威与寻址

`POST /protoclaw/prebuilt_sessions` 可传 `workspaceAgentId`；未传时采用声明的默认项。多 Agent 工作空间的通用新建对话入口先让用户选择，单 Agent 没有额外步骤；应用自有创建事务也可显式传该字段，或使用其声明默认项。

会话索引中的 `workspaceAgentId` 是绑定权威。轻记录、会话详情、child runtime 投影与 handoff 的 `sourceRecord` 保留该字段。运行时启动从会话索引读取，不从进程首会话、标题或 `sessionType` 推导。

- 从来源会话创建时继承来源 Agent；显式要求改为另一 Agent 将被拒绝。
- 分支复制绑定；精简、摘要和线程接续经来源会话创建后继，保持绑定。
- 欢迎页按当前 Session 的绑定读取所属工作空间 Agent 名称。未知或尚未加载时显示通用“新对话”，不借宿主当前活动会话的名字。
- OS 寻址仍为工作空间 `agentId` + `sessionId` / `runtimeId`；Agent ID 不产生侧栏层级，也不改变存储目录。
- `identities[]` 是群聊身份发现声明，不负责创建或绑定对话；`sessionType` 仅保留运行形态标签。

## 存量约定

未声明 `agents` 的工作空间具有单 Agent `main`，名字沿用工作空间名。存量会话缺少 `workspaceAgentId` 时归属 `main`，与当前默认项无关。为已有工作空间扩展多 Agent 时，须保留 `main` 的声明和装配，才能继续恢复旧会话；不会把旧会话静默转给新默认 Agent。

实现入口：`server/shared/workspace-agents.js`、`server/routes/session-helpers.js`、`scripts/run-prebuilt-agent.js`、`scripts/run-one-shot-agent.js`、`public/src/modules/workspace-agents.js`。
