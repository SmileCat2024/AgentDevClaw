# ADR 0028: Credential Recovery via setModel — 分层判据与运行中凭证失效恢复

日期：2026-10-15
状态：已接受（实施中）

## 背景与问题

OpenAI Codex OAuth 调查（对照 codex-rs `login/src/auth/manager.rs`）暴露两类问题：

**个案（Claw）**：`resolveModelPresetLLM` 仅在 runtime 启动时执行一次，access_token 作为字符串快照焊死在 LLM 实例里；OpenAI token 寿命约 1 小时，会话超过后所有请求 401 且无自愈路径。叠加跨进程 refresh_token 竞态——`refreshInFlight` 仅进程内去重，server 与多个 runtime 子进程共享同一 token 文件，同一旧 refresh_token 被用两次触发 OpenAI 判 `refresh_token_reused` 并吊销整个 token family——用户看到"UI 显示未过期、实际已失效、必须重登"。

**结构（分层缺判据）**：修这个 bug 时发现"运行中凭证失效的恢复动作锚在哪层"没有现成答案可引。ADR-0009 的资产/契约二分法覆盖了"切换模型"的静态分工，未覆盖"凭证在运行中失效"的动态恢复。

对照物：codex CLI 的做法是每次取 token 前解 JWT exp（5 分钟窗口）同步刷新、401 后走有限步骤恢复状态机（guarded reload → refresh → 重试）、refresh_token 按一次性对待（reuse/expired/invalidated 归 Permanent 要求重登）。

## 根本裁决

### 1. 分层判据四条（本 ADR 的第一产出）

| 判据 | 内容 |
|---|---|
| 语义归框架 | 契约、错误分类、生命周期编排、钩子签名 → AgentDev |
| 实现归应用层 | 资产保管（token 文件、presets.json）、IO（OAuth HTTP 往返、查表）、createLLM 参数 → Claw |
| 宿主够不着 = 下沉信号 | ADR-0009 的原始动机；"第二个消费者"限定为宿主/装配层（prebuilt / studio / plain / one-shot 四宿主），普通代码复用不触发下沉 |
| YAGNI 防线 | 其余一律先留应用层，不为假想的第二个消费者提前抽象 |

### 2. 核心不变量：LLM 实例 = 参数快照，凭证轮换 = 实例轮换

框架不认识 OAuth。任何认证策略（API key、OAuth、未来形态）收敛为 `ModelPresetResolver` 的实现细节；凭证轮换**不**通过 getter / 动态 apiKey 修改实例，而是 `setModel` 重 resolve 产生新实例（既有 ADR-0009 编排，无新 API）。把"取凭证的能力"以闭包塞进 llm 实例（getter 方案）被否决：凭证获取通道进入框架持有的对象，与 0009 "凭证永不进入 agent"的精神相悖，且让 llm 包对"凭证可能失效"产生语义认知——依赖方向错误。

该不变量的收益：llm 层收到的是干净通用的 API 参数；所有刷新、登录、认证策略的复杂度收敛在 Claw 的 resolver 与 token 管理里。前提是重 resolve 足够便宜（查表 + 读盘 + createLLM），成立。

### 3. 恢复编排（框架侧，AgentDev 仓库）

- **llm 包**：错误分类新增 `errorType: 'auth'`（HTTP 401/403）。429 留在现有 rate limit 语义，不混入。
- **core react-loop**：捕获 auth 错误 → `setModel(当前 presetName, { thinkingEffort: getLLMMeta().thinkingEffort, source: 'auth-recovery' })` → 重试一次 → 仍 auth 错误则本轮以 `auth_required` 终止。`setModel` 调用必须透传档位：不传 `opts.thinkingEffort` 时按 preset 默认档位重 resolve（agent.ts 现状），省略即静默重置用户运行档位。
- **session-events**：错误类别新增 `auth_required`（挂进现有 category/retryable 机制），恢复失败直达前端——Claw 前端据此弹"请重新登录"而非展示晦涩 401。"怎么引导重登"归 Claw。
- **边界**：每次 auth 错误仅一轮恢复，无冷却自动循环（凭证真死时循环只会打爆 auth 端点并掩盖事实；用户下次发消息自然构成下一轮机会，重试节奏由人驱动）。仅覆盖请求被拒形态的 401；流中途连接断开继续走 `connection_error` 语义。
- **`setModel` 返回 false 的消费**：resolver 返回 null（token 被清/未登录）→ false → 视为恢复不可行，轮以 `auth_required` 终止。

### 4. Claw 侧止血（先行，不依赖框架改动）

1. **刷新单点**：刷新职责收敛到 server 进程独占；runtime 子进程不直接 POST refresh，经既有 IPC 链路请求 server 代刷（消灭跨进程 reuse 竞态）。
2. **relogin 判定扩展**：`reloginRequired` 从仅 401/403 扩到 400 + `invalid_grant` / `refresh_token_reused`（OpenAI 对 reuse 实际返回 400 + invalid_grant，见 codex-rs `login/src/auth/manager.rs:1662-1663`）；命中即清 token 并提示重登。
3. **刷新窗口与兜底**：`REFRESH_SKEW_SECONDS` 120→300（对齐 codex 5 分钟窗口）；resolve 路径同步 await 刷新结果而非 fire-and-forget 返回旧 token；JWT 无 exp 时按 `last_refresh > 7 天`兜底刷新（对齐 codex 8 天兜底）。

实施顺序：止血三件套 → 框架 auth 语义与恢复编排 → 文档收尾。

### 5. 恢复失败直达前端

结构化 `auth_required` 让失败可行动：前端弹"重新登录"引导，而非让用户从 401 报错里猜。这是 ADR-0009 "失败不可达"教训在凭证域的延续。

## 落点索引

- 框架 llm：`AgentDev/packages/llm/src/`（openai / openai-responses / anthropic 错误分类）
- 框架 core：`AgentDev/packages/core/src/core/react-loop.ts`（恢复编排）、`session-events.ts`（auth_required）、`agent.ts`（复用 setModel，无签名变更）
- Claw：`server/oauth-codex.js`（窗口/判定/兜底/同步刷新）、`server/model-preset-resolver.js`、server↔runtime IPC 刷新单点
- 测试：框架 vitest（`AgentDev` 体系）+ Claw `test/oauth-codex.test.js`（node:test 扩展）
- 参照物：codex-rs `login/src/auth/manager.rs`（proactive_refresh_reason / UnauthorizedRecovery / refresh_token 错误分类）

## 修订（2026-10-18）：凭证变更主动推送

反应式恢复留有一个缺口：401 触发的前提是**旧凭证已失效**。用户主动换凭证（OpenCode 换 key、Codex 重登换账号、改 provider 的 apiKey）时旧凭证往往仍然有效——没有 401 就没有恢复触发，运行中会话的 LLM 实例（参数快照）会无限期继续用旧凭证，计费打到旧账号，直到重启 runtime 或手动切模型。

补齐：**凭证变更落盘点在 server 侧主动广播** `refresh-credentials` IPC 到全部运行中 runtime，runtime 侧同 preset `setModel`（`source: 'credential-refresh'`，档位透传纪律与 auth-recovery 一致）重 resolve 换新实例。触发点：

- `PUT /protoclaw/model_connections`：OpenCode apiKey / tier 变更（tier 决定 catalog baseUrl，同属连接字段）
- OAuth 登录完成（设备码 + 浏览器 PKCE 两条流，经 `oauth-codex.js` 的 credential change listener；**常规 token refresh 不触发**——那类轮换仍由 401 反应式路径覆盖，推送只造成实例 churn）
- `PUT /protoclaw/model_config`：既有 preset 的连接字段签名（provider / catalogProvider / baseUrl / apiKey / authType / clientId）或内联 defaultModel 的凭证字段变更；非连接字段（档位、置顶、窗口元数据）、新增 preset 不触发

边界：fire-and-forget 无回执；runtime 重 resolve 失败（preset 被删、凭证被清）保留旧实例，401 → auth-recovery 兜底语义不变。共享进程模式下广播按 runtime 记录逐条投递并盖各自 `__targetSessionId`，正确路由到各会话的 agent 实例。核心不变量不变：凭证轮换 = 实例轮换，推送只是新增的触发源，不引入 getter / 动态凭证通道。

落点：`server/shared/ipc.js`（`broadcastIPCToAllRuntimes`）、`server/oauth-codex.js`（listener）、`server/routes/model-config.js`（连接字段 diff）、`server/routes/oauth-codex.js`（装配接线）、`scripts/run-prebuilt-agent.js`（IPC 分支）；测试 `test/credential-refresh.test.js`。

## 与既有 ADR 的关系

- 延伸 ADR-0009：`setModel` 从"用户/Feature 切换模型"扩展为"凭证恢复的编排原语"；三不变量（资产归应用层、能力以接口注入、状态由 agent 自持）不变。
- 印证 ADR-0003：llm 包只加错误语义（零新依赖），core 编排复用既有 setModel。
