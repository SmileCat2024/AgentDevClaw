# 019 — model-settings.js 拆分（oauth-flow + proxy-overlay）

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：2026-08-23 前端回涨文件调研 grill 会话（Q1-Q4）；文件行数与区段边界为该次快照
- **类型**：纯前端模块搬移（move not refactor）
- **前置**：无（本票为 019→020→021 串行序列的第一张；与 022 零交集可并行）

## 背景

`public/src/modules/model-settings.js` 2026-07-05 从 settings-overlay.js 拆出时约 562 行，
当前 1,360 行。回涨主因（git 查证）：

- 07-26 系列（dc68dfd / feeaae7 / 8bf5a9e）：thinking effort 热切换 + 自定义下拉 + 面板布局重构
- 0eae8bb：proxy 设置拆成独立 overlay，**但代码留在本文件**
- 08 月系列（b8bd6e2 / d321520）：OAuth 登录流程持续迭代

当前三段几乎零耦合：

| 子域 | 区段（快照行号） | 行数 |
|---|---|---|
| 设置面板主体（overlay + 预设 CRUD） | 9-773 | ~700 |
| OAuth 登录流程（轮询 / provider 解析 / 登录 UI） | 774-1132 | ~360 |
| 代理设置面板（独立 overlay + 保存 / 测试） | 1132-1360 | ~230 |

## 执行步骤

1. 新建 `public/src/modules/oauth-flow.js`，迁入（快照行号 774-1132）：
   `checkOAuthProxy` / `renderOAuthLoginArea` / `getEditingProviderName` /
   `resolveOpenCodeProtocolClient` / `oauthProviderNeedsSave` / `pollOAuthLogin` /
   `refreshOAuthStatus`
2. 新建 `public/src/modules/proxy-overlay.js`，迁入（快照行号 1132-1360）：
   `ensureProxyHost` / `openProxySettings` / `closeProxySettings` /
   `renderProxyOverlay` / `_loadProxyPanel` / `_saveProxy` / `_testProxy` / `_proxyStatus`
3. 两个新文件均按既有 SOP 顶部注释写明依赖清单（全局依赖 + 跨文件依赖）。
4. `index.html` 将两个新 script 紧邻 `model-settings.js` 插入（依赖方向为
   model-settings → oauth-flow / proxy-overlay 的运行时调用，加载序不敏感，
   按目录习惯排在 model-settings.js 之前）。
5. 迁移期间发现的被迁函数与留守函数互调：保持全局函数形态直接互调，
   不引入 import/模块化改造。

## 验收标准

- 静态验证（grep 清单，逐条通过）：
  - 每个被迁符号在对应新文件有定义：`grep -l "function pollOAuthLogin" modules/oauth-flow.js` 等
  - `model-settings.js` 对被迁符号零残留定义
  - 既有引用方零改动：`app-ui.js` 引用了部分 oauth/proxy 符号（调研已证实），
    确认其未被修改
- 加载验证：启动后浏览器 console 零错误。
- 手工冒烟（逐项）：
  - 设置面板开合、模型预设增删改查
  - OAuth 登录入口渲染、登录状态刷新
  - 代理面板打开 / 保存 / 连接测试 / 关闭
- `model-settings.js` 行数回落至 ~770。

## 风险提示

- 区段行号为调研快照，执行时以 grep 符号边界为准，不盲信行号。
- `pollOAuthLogin` 存在轮询定时器，确认迁移后无重复轮询（打开面板一次只一个 interval）。
