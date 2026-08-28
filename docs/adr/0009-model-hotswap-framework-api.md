# ADR 0009: Model Hot-Swap as a Framework API — Assets Stay Hosted, State Lives on the Agent

日期：2026-08-26
状态：已接受（已落地）

## 背景与问题

"切换模型 / 切换思考档位"曾是宿主手艺活：`run-prebuilt-agent.js` 的 IPC handler 里写死三步——`resolveModelPresetLLM` 查表造客户端 → `agent.setLLM` → 手动回写宿主私有副本 `this.resolved` / `this.resolvedUsageModel`。问题有三：

1. **Feature 够不着**：查表函数活在宿主进程内，任何想在运行中换模型的 Feature（如 step 级模型轮转）都必须私搭链路。
2. **双份记账**：agent 身上有 `_llmMeta`（setLLM 时宿主贴的标签），宿主还私记一份，每次切换两边各记一遍，永远存在漂移窗口。
3. **失败不可达**：`/protoclaw/swap_model` 的 `ok` 只表示 IPC 消息送达；preset 名打错、OAuth token 缺失，前端照样显示"切换成功"。

另一个被这次治理一并收编的旧缺口：无 preset 配置的 agent（qqbot / agent-studio）走 `resolveGlobalDefaultLLM` 兜底，返回 `presetName: ''`——一个"匿名模型"，整条以 presetName 为锚的显示与档位切换链路对它全部失锚（输入框模型显示为空的根因）。

## 根本裁决

### 1. 三不变量：资产归应用层，能力以接口注入，状态由 agent 自持

| 层 | 职责 |
|---|---|
| 应用层（Claw） | 资产：presets.json、apiKey / OAuth token 的编辑与保管；resolver 的**实现**（查表、取凭证、createLLM） |
| 框架（core） | 契约与编排：`ModelPresetResolver` 接口 + `agent.setModel` / `setThinkingEffort`（resolve → setLLM → 贴标 → 通知 → 推 Overview） |
| agent | 状态唯一权威：`getLLMMeta()`；凭证永不进入 agent（会话快照、调试视图跟着 agent 走，钥匙进去就是泄漏） |

与 `llm` 构造注入、`sessionStore` 注入同一模式：框架定义动作，应用注入能力。core 零重依赖（ADR-0003）不受影响——接口中 llm 的类型复用 `AgentConfig['llm']`，实现留在 Claw。

### 2. 一键方法，不让消费者编排

`setModel(presetName, { thinkingEffort?, source? })` 返回 boolean（解析失败 = false，不抛）；未注入 resolver 时抛错（装配缺失应显式失败）。`setThinkingEffort(effort)` 独立成方法：档位固化在 LLM 实例构造里，调档位 = 按当前 presetName 重 resolve，语义正交不靠参数区分。宿主 IPC、Feature 进程内调用消费同一入口。

### 3. source 字段本期定形

切换发起方标记（`'boot'` / `'user'` / `'feature:<name>'`）写入 `_llmMeta`，`onLLMSwap` 钩子签名不动。未来轮转类 Feature 的"用户手动切 vs Feature 切"让位策略读 `getLLMMeta().source`，无需再改行为语义。

### 4. 宿主小抄退役

`this.resolved` / `this.resolvedUsageModel` 删除。usage 归因、session meta sync、swap-thinking 锚点全部改读 `agent.getLLMMeta()`。启动路径保留局部变量（构造前 agent 不存在，构造期注入与运行期 API 本来就是两条合理路径）。

### 5. 全局默认具名（`__default__`）

`resolveGlobalDefaultLLM` 返回 `presetName: '__default__'` 并补全 protocol 等字段；适配对象 `modelPresetResolver` 在 resolve 层路由该别名。从此全局默认与普通 preset 同链路：显示有锚、`setThinkingEffort` 可重造，前端零特判。

### 6. swap IPC 升级 request/reply

复用 force-continuation / context-guard 的回执模式，抽出通用能力 `requestRuntimeAck`（`server/shared/ipc.js`）：requestId 注入、type + requestId 匹配回执、超时兜底。runtime 执行 `setModel` / `setThinkingEffort` 后回 `model-swap-result`；前端拿到的 `ok` 从"消息送达"变为"切换生效"，失败原因直达 toast。

### 7. 四个 agent 宿主统一注入

run-prebuilt-agent、run-studio-runtime（两模式）、run-plain-agent、run-one-shot-agent 构造时全部注入 `modelResolver: modelPresetResolver`——同一批 Feature 装配在哪个宿主里行为一致。辅助进程（recap / title mirror、inprocess-summary）无 agent 实例，继续直接 import 解析函数。

## 落点索引

- 框架契约：`AgentDev/packages/core/src/core/types.ts`（`ModelPresetResolver` / `ResolvedModelPreset` / `LLMMeta.source|provider` / `AgentConfig.modelResolver`）+ `agent.ts`（`setModel` / `setThinkingEffort`）
- Claw 实现：`server/model-preset-resolver.js`（`GLOBAL_DEFAULT_PRESET_NAME` / `modelPresetResolver`）
- 回执链路：`server/shared/ipc.js` `requestRuntimeAck` + `server/routes/model-config.js` 两个 swap 端点 + `scripts/run-prebuilt-agent.js` handler
- 测试：框架 `test/model-preset-swap.test.ts`（vitest）；Claw `test/model-preset-resolver.test.js`（`__default__` 用例）、`test/model-swap-ack.test.js`（回执链路）

## 后续（不属于本 ADR）

`ModelPresetResolver` 的 `list()`（preset 枚举，供面板 / Feature 拉清单）在真正需要时追加——接口加方法零破坏。
