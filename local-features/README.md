# local-features

Claw 仓库自有的 feature 与包装层源码（TypeScript，编译产物在 `dist/`，消费方统一 import `local-features/dist/<pkg>/src/index.js`）。

构建：`npm run build:local-features`；测试：`npm run test:features`。

## 分层结构

### 基础层（通用能力与协议）

被多个 agent 共享、不绑定具体应用场景。**基础层不得依赖应用层。**

| 包 | 职责 |
|---|---|
| `continuity-participant/` | continuity 协议消费层：`declareContinuity` 从框架 `agentdev` 消费，保留 Claw 协议命名空间（`claw.*`）与字段 key 读旧写新兼容（`__agentdev_continuity__` / 旧 `__claw_continuity__`），让 feature 状态可跨 trim/summary/分支迁移 |
| `feature-wrappers/` | 框架自带 feature 的薄包装（继承 + declareContinuity 叠加 Claw 协议，不复制实现）。当前含 `ControlledTodoFeature`（todo 中断控制 + 状态迁移）、`ContinuityAwareOpencodeBasic`（先读后写保护状态迁移）。消费方：编程小助手、`agents/coder` |

### 应用层（Claw 应用化 feature）

专门适配 Claw 产品场景的 feature。

| 包 | 职责 | 状态 |
|---|---|---|
| `dispatch/` | 调度系统核心（定时调度、调用信封） | 活跃 |
| `group-admin/` | 工作群管理员工具集 | 活跃 |
| `checkpoint/` | 会话检查点与回滚 | 活跃 |
| `context-compaction-mirror/` | 上下文精简镜像 | 活跃 |
| `context-compaction-control/` | 上下文精简控制 | 活跃 |
| `context-guard/` | 上下文防护 | 活跃 |
| `conversation-export/` | 对话导出 | 活跃 |
| `generative-ui/` | 可视化交互面板 feature | 活跃 |
| `github/` | GitHub 工具集 | 活跃 |
| `flow/` | Flow 运行时核心 | 悬置 |
| `feature-dev/` | Feature Creator 后端 | 悬置 |
| `agent-dev/`、`agent-studio/` | Agent 装配/调试工具 | 悬置 |

## 新增包的约定

1. 判断归属：通用包装/协议 → 基础层；Claw 场景专属 → 应用层；在上表登记
2. `local-features/tsconfig.json` 的 `include` 添加 `./<pkg>/src/**/*.ts`（及 `test/**/*.ts`）
3. 有测试时在 `local-features/tsconfig.json` 的 `include` 添加 `./<pkg>/test/**/*.ts`；`test:features` 会自动发现已编译的测试产物
4. 遵循统一日志契约（agent 侧禁 console，用 createLogger），存量 console 进 eslint ratchet 清单
