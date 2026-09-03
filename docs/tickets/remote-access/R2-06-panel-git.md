# R2-06 — 面板资源远程扩列：源代码管理（git 路由族）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0011（适配套路）、ADR-0008 #5（host 默认本地、远程必须显式）、ADR-0006（显式资源寻址）
- **类型**：protoclaw 域远程转发（目录寻址 host 域）
- **前置**：R2-01 / R2-02 已合入 main（转发模式定型）
- **状态**：已立项待派发

## 背景

右侧「源代码管理」面板（git-panel）的操作全部落在本地磁盘目录：`POST /protoclaw/git/<op>`，身份输入是 `body.dir`（项目目录绝对路径），服务端 `validateDir` + `resolveGitRoot` 后执行 git 命令。远程会话的项目目录在远程机上（catalog 的 `projectDir` 即远程本地路径），本地执行必然失败（目录不存在）。远程适配 = 前端带命名空间会话身份 + 服务端按连接转发，`dir` 原样透传（它是远程机的合法路径，远程端 `validateDir` / `resolveGitRoot` 照常执行，远程零改动）。

## 范围（`server/routes/git.js` 全部 POST 端点）

| 端点 | 读/写 |
|---|---|
| `/protoclaw/git/status` | 读 |
| `/protoclaw/git/graph`、`/branches`、`/commit_files` | 读 |
| `/protoclaw/git/stage`、`/unstage`、`/commit`、`/discard`、`/branch`、`/stash` | 写 |

（以 `server/routes/git.js` 实际注册为准，施工前逐个清点，全部接入同一分支模式。）

## 关键语义边界（施工前必读）

- **身份必须显式（ADR-0008 #5）**：git 端点现状只认 `body.dir`（目录），无身份字段。禁止从目录字符串猜连接——前端调用点必须携带当前会话的宿主级命名空间身份（`agentId` 字段，与 R2 系列身份纪律一致）；服务端 `resolveForwardHostTarget(agentId)` 派生连接后转发，`dir` 原样（已是远程本地路径）。未知 / 停用连接按 `RequestTargetError` 契约（404 / 503 retryable）。
- **远程零改动**：远程端 `git.js` 路由本就存在，`validateDir` / `resolveGitRoot` 在远程机对远程路径照常校验。本地**不复刻**任何 git 逻辑。
- **写幂等闸**：stage / commit / discard / branch / stash 等 git 写端点的远程分支补幂等键（`x-idempotency-key`），照 R2 系列既定模式；status / graph / branches / commit_files 等读端点不强制。
- **discard 是破坏性写**：核实前端既有确认流，不新增确认层、不静默放行（失败契约三分类呈现）。
- 本地分支字节级不动：本地身份（无 agentId 或非命名空间）走既有路径。
- capability 门控：git 操作属 host 写能力——远程会话无 `write` 能力时面板降级（照能力矩阵既有形态），有写能力则与本地一致、不出现远程标识。

## 服务端改动

- `server/routes/git.js`：全部端点远程命名空间分支（识别 body 命名空间身份 → `resolveForwardHostTarget` → `forwardProtoclawRoute`，body 原样转发——`dir` 是远程本地路径，远程端自己解析；身份字段 `bareId` 展开）。
- 写端点幂等闸。

## 前端改动

- `public/src/modules/git-panel.js`：请求体补命名空间身份字段（当前会话的宿主级命名空间 agentId；本地身份原样带，服务端忽略）；`dir` 来源核实——远程会话应为 catalog projectDir（远程路径），本地会话不变。
- 写操作幂等键补齐（既有 operationId 体系）。

## 测试

- git 端点转发用例（转发形状 / dir 原样 / 身份剥壳 / 契约失败 / 本地分支零网络 / 非远程身份不改写 body）。
- 全量回归 + eslint + `git diff --check`。

## 验收标准

- 本地 git 面板行为不变；远程会话的源代码管理面板显示远程仓库状态，stage / commit 在远程端执行成功。
- 失败三分类契约形态正确（连接断开时 git 面板显式报错，不静默）。

## 明确不做

- 不做远程 git 的文件内容查看 / diff 渲染增项（面板现有能力原样转发）。
- 不动 `validateDir` / `resolveGitRoot` 本地逻辑。
- 文件结构面板（workspace_data host 域 enrich）不在范围，后续批次。
