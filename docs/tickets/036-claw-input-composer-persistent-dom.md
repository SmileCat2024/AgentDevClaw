# 工单 036：输入区 Composer 常驻化（消灭整块销毁重建）

## 背景（现状调查结论，已完成）

主前端聊天输入区当前是"轮询驱动的整块 DOM 重建"模型：`renderInputRequests()`
（`public/src/modules/input-render.js`）在签名变化时 `innerHTML = ''` 整块重建输入面，
每次重建销毁 textarea，焦点/IME/选中态全部丢失。代码里已经堆了四层对抗性补丁：

1. 重建前记录焦点+光标、重建后恢复（input-render.js）；
2. 草稿缓存放全局（且住在 voice-input.js 里）供重建回填；
3. 销毁前 `_storeVisibleSessionInputDraft` 抢救草稿；
4. 提交路径 await 后必须重新 `getElementById` 找 live 元素并校验 sessionKey
   （三处注释原话"await 期间输入面可能整块重建"）。

重建由 19 处手动调用点触发（分布 10 个文件），每处都手动
`lastRenderedInputSignature = ''` 再调 render。persistent / requests 两个模式
是两份复制粘贴的 toolbar 模板（重复 DOM id）。轮询每周期 JSON.stringify 对比
inputRequests，任何变化都触发整块重建——这就是用户感知的"事件打断输入框"。

**行为契约已就绪**：`docs/input-area-behavioral-contract.md`（本次一并落盘）。
它是本票的验收基线：§3–§9 的可观察行为全部保持，§11 列出的实现手段可自由更换。

- 仓库：/home/dev/AgentDevClaw（本 worktree）
- 工作目录：/home/dev/claw-036-input-composer
- 允许修改范围：`public/src/**`、`public/index.html`、`test/frontend-*.test.js`
  （新增测试文件名以 `frontend-input-` 开头）
- 前置：无（行为契约文档已在 main）

## 目标（一句话）

输入面 composer 卡（textarea + 工具栏）在同一会话内**常驻 DOM**：模式翻转
（persistent ↔ requests）只改属性与显隐，不再销毁重建；会话切换时重绑会话身份
（sessionKey / 提交端点 / 草稿），同样不销毁元素。

## 改动项

### A. Composer 常驻挂载（核心）

- `#user-input-container` 内的输入卡改为**常驻元素**：首次渲染挂载一次，
  之后模式变化只做属性级更新：
  - persistent ↔ requests：仅切换提交端点（user-turn / input+requestId）、
    textarea id、keydown 绑定、placeholder、footer 动作按钮显隐；
  - readonly / hidden / 压缩状态卡 / choice 卡 / 回退对话框接管：composer
    整体隐藏（class 或 style），不用清空重建；这些互斥卡的渲染逻辑保持现状；
  - 会话切换：更新 `dataset.sessionKey`，按契约保存旧 key 草稿、恢复新 key 草稿。
- **模式翻转（同会话 persistent ↔ requests）不再触发任何 DOM 重建**；
  焦点、IME 组合态、光标、选中态自然保留。
- 现有外部 API 契约不变：`renderInputRequests` / `getInputRenderSignature`、
  `getInputSurfaceMode`、`renderPersistentInput` 等被 19 处调用的函数继续存在、
  继续可调（内部实现换成常驻更新；签名机制可保留为 no-op/短路，也可换成
  精确 diff，实现自选，但外部调用方一行不改）。

### B. 双模板合一

- persistent 与 requests 两份复制粘贴的 toolbar 模板（attach/模型/思考/语音/
  发送 五按钮）合并为一个 composer 组件，persistent 与 requests 只是提交端点
  与 footer 动作不同。
- 消除重复 DOM id（`input-model-switch-btn` / `input-thinking-btn` 同时出现在
  两个模板）。
- index.html 的 script 加载顺序保持有效（新模块插在依赖其全局符号的模块之前，
  加载序是承重的）。

### C. 会话草稿缓存迁移

- `_sessionInputCache` 及 `_cacheSessionInput` / `_restoreSessionInputDraft` /
  `_storeSessionInputDraft` / `_storeVisibleSessionInputDraft` 从
  `voice-input.js` 迁到 composer 模块（语音模块按原全局符号 re-export 兼容，
  或全量更新引用方——二选一，以引用方零行为变化为准）。
- 迁移后语音模块不再拥有 composer 草稿状态；`_pendingVoiceResults`（跨会话
  语音结果暂存）留在 voice-input.js。

### D. 常驻化后失效的 hack 清理

仅删除**因 A 落地而确认失效**的补丁，删除前逐项确认对应场景已由常驻 DOM
天然覆盖：

- 焦点/光标记录恢复（input-render.js 的 hadInputFocus 块）——同会话不再重建
  后失效；会话切换场景的焦点策略按契约 §7 保留（不抢占他处焦点）；
- `_storeVisibleSessionInputDraft` 销毁前抢救逻辑；
- 提交路径的 live 元素重查（§6.1 第 11 条契约场景随重建消失；若仍有 await
  后写回 DOM 的路径，保留校验）；
- 语音按钮跨重建重绑 `_reattachVoiceInputUi`（composer 不再重建后失效，
  保留空实现或删引用，以引用方零残留为准）。
- 签名比对机制（`getInputRenderSignature` / `lastRenderedInputSignature`）：
  若常驻更新不再需要"整块重建 or 跳过"的判定，可退化为模式变更检测；
  外部调用方（手动 reset 签名再调 render 的 19 处）不需要改动——reset 变成
  幂等无害操作即可。**不要求本票收敛 19 处调用点**（后续票）。

## 明确非目标（不做）

- 不改 19 处调用点的收敛（后续票）。
- 不动 choice 选择卡、回退对话框、压缩状态卡的内部实现（只保证与常驻
  composer 的互斥显示关系不变）。
- 不动 slash 菜单（document 级，依赖 `.user-input-textarea` class 契约——
  常驻化后该 class 必须继续存在且全局唯一于 composer textarea）。
- 不动 work-group（wg-*）输入系统。
- 不改服务端路由与协议（API 形状见契约文档 §2）。
- 不动 local-features/**（另一工单正在施工 capability-shell，禁止触碰）。
- 不动 voice-input.js 的录音/ASR 逻辑本身（只迁草稿缓存）。

## 行为契约（验收基线）

`docs/input-area-behavioral-contract.md`（本票随附落盘）是唯一行为基线。
重点验收条款：

- §3 显示模式矩阵（9 级优先级不变）；
- §6.1 第 11 条 live 元素契约（常驻化后此场景应消失，但不得引入"已发送
  文本残留/复活"新回归）；
- §7 状态保持表逐项成立（草稿/焦点/语音意图/附件/队列/打断粘性/计时起始）；
- §8 刷新触发源的事件覆盖面不得减少；
- §9 错误与降级路径逐条保持；
- §12 已知怪癖不得恶化。

## 验收命令

```bash
cd /home/dev/claw-036-input-composer
npm test                      # 全量绿（含既有 34 个 frontend-* vm 沙箱测试）
git diff --check
```

新增测试（进 `test/`，沿用 frontend-* vm 沙箱模式，参考
`test/frontend-interrupt-voice-lifecycle.test.js` 的沙箱与 overrides 方式）：

1. 模式翻转不重建：persistent ↔ requests 切换时 composer 元素身份不变
   （同一 DOM 节点引用）；
2. 会话切换：草稿按 sessionKey 保存/恢复、不串会话；提交后草稿键删除；
3. 草稿迁移后 voice-input.js 的 re-export 与既有引用零行为变化；
4. 模式判定矩阵（§3 九级优先级）纯函数用例锁死。

## 约束

- 不得 reset / clean / 覆盖其他会话改动
- 不动 server/、local-features/、框架仓库
- 默认不 commit 不 push：完成后输出最终报告（修改文件清单、验收命令输出、
  已验证项、未验证项、风险），commit/push 由调度方验收后执行
- 测试预算遵守 CLAUDE.md（单用例 <100ms、单文件墙钟 <1.5s、node:test + assert/strict）
