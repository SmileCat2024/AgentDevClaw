# 040 — 工作空间内固定 Agent 会话与欢迎页正名

状态：已实现并验证。每个对话固定一个 Agent；不提供对话内切换或多 Agent 协作。

## 目标

工作空间可声明多个 Agent，每个有稳定 ID、名字和装配。新建对话选择 Agent，恢复、分支及接续保留绑定。欢迎语显示当前会话 Agent 名，不借用工作空间名或会话标题。OS 负责声明验证、绑定和通用渲染，工作空间掌握命名与装配。

## 约束与设计

- 工作空间 `agentId` 寻址、存储目录、侧栏层级保持不变。Agent 选择使用独立的 `workspaceAgentId`，不得复活 sessionType 身份推导或侧栏身份投影。
- 使用 `metadata.agents: [{ id, displayName }]` 与 `metadata.defaultAgentId` 声明；displayName 可复用项目现有多语言值契约。声明多项必须明确默认项；重复/空 ID、无效默认项、未知请求 Agent 应明确拒绝，不取第一项。
- 装配沿现有 `agent.js` 模块：支持命名导出 `agents`（ID 到 Agent 构造函数的映射）；既有 default export 维持 main 单 Agent。声明中非 main Agent 必须有明确装配，禁止静默运行 main。
- 既有未声明 agents 的工作空间按明确的旧单 Agent main 契约运行；旧会话缺失 workspaceAgentId 解析为 main，而非现时 defaultAgentId，避免日后调整默认导致旧会话换人。旧工作空间如需要多 Agent，必须保留 main 装配以恢复存量会话。新会话一律保存明确绑定。
- programming-helper 声明 main / 编程小助手，工作空间名仍为智能编码空间。不要为了演示给正式工作空间添加虚构 Agent；多 Agent 用测试 fixture 验证。
- 绑定以 session index 为权威，在新建、恢复、分支、handoff/rotation successor、轻记录和 wire 投影中贯通；同项目共享进程内每个 Session 分别解析自己的 Agent，禁止把首个会话选择当进程级选择。创建来源会话的派生操作不允许改变 Agent。
- 欢迎页按当前绑定 Session/Runtime 的 workspaceAgentId 读取所属工作空间声明，不使用宿主 activeSessionId、不用标题/name猜测。未知/尚未加载时不冒充其他 Agent。
- 前端新建入口复用既有选择弹窗/表单配方，多 Agent 时可选，单 Agent 无额外步骤；必须把选择传到真正创建端点。API与内部创建函数均需支持，未知ID报400类明确错误。
- 与 identities[] 群聊身份声明、APP治理/feature权限/配置模型保持边界，不借本票重构它们；补文档说明二者不是同一机制。

## 协作范围

目标仓库 D:/code/AgentDevClaw，当前分支直接施工，不创建worktree，不提交、不push、不重启用户服务，不触碰相邻AgentDev仓库。不得 reset/clean/checkout 覆盖其他会话工作。

修改范围为相关 server/scripts/public/prebuilt metadata/test/docs；欢迎态布局在 `public/styles/components.css`，新模块由 `public/index.html` 加载。其他会话改动保持不动。

## 验证与交付

- Node node:test + assert/strict；定向测试覆盖元数据验证、两Agent创建/恢复/共享进程启动装配隔离、非法Agent拒绝、分支和接续继承、wire与当前视图欢迎语、快速切换/宿主active漂移、不声明的旧工作空间和旧会话main语义、单Agent无额外交互。
- 运行相关现有 session/startup/shared-process/continuity/frontend 测试；再视情况跑 test:core，记录基线失败，不调大超时掩盖问题。
- 更新ADR-0025的多Agent实施状态，记录本票契约（独立协议/参考文档均可），并同步AGENT.md索引与前端渲染文档的命名规则。
- 最终报告列实际文件、契约/行为、验证结果、已知未验证点与重启范围；git diff --check。

## 验收记录

- `npm run test:core`：4749 项，4745 通过、4 跳过、0 失败（含真实共享 runtime 装配测试）；后续远程欢迎语用例另跑定向回归。
- `test/workspace-agents.test.js`：声明校验、默认项与旧会话语义、真实索引创建和恢复、分支、trim/summary 接续、wire、视图切换隔离及远程欢迎语。
- `test/workspace-agents-runtime.test.js`：真实 ViewerWorker + runtime 子进程，同进程分别加载 main/reviewer，未知 Agent 拒绝且有效会话继续存活；隔离数据目录、端口与 IPC 地址，不发模型请求。
- `test/welcome-browser-check.mjs`：真实 HTML/CSS 与欢迎函数，深浅双主题、1920×1080 至 375×667 的尺寸矩阵无欢迎区滚动；选择/取消、绑定名称和有消息时滚动恢复均通过。
- 新模块与测试 ESLint、`git diff --check`、`npm run check:cycles` 通过。
- 使用本机已有 Chromium（1208）运行浏览器验证；未重新安装浏览器资产，未重启用户服务，未对正式多 Agent 工作空间执行模型对话。极低窗口下右侧工具栏自身超高是独立布局问题，未纳入本票。
- 生效需要重启 Claw 服务并刷新页面；运行中的 agent 子进程需要重新启动后使用新的装配选择逻辑。
