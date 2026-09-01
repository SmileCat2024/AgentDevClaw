# 工单 037：输入面触发权收敛（19 处手动调用 → 状态驱动渲染）

## 背景

工单 036（已合入 main，afd688f）把输入面重构为常驻 composer，`renderInputRequests`
内部变为幂等属性更新，但保留了旧架构的"手动戳"模式：约 19 处调用点分布在 10 个
文件，每处改完状态后都要手动 `lastRenderedInputSignature = ''`（或直接传新参数）
再调 `renderInputRequests()`。幂等化后这些调用无害，但"改状态的人必须记得戳渲染"
这个隐式契约仍在——新代码漏戳就会出界面不更新的 bug。

本票目标：**把"改状态 + 手动戳渲染"的配对模式收敛为单一状态驱动**，并让行为
契约 §8 的"事件 → 显示"映射保持不变。

- 仓库：/home/dev/AgentDevClaw（本 worktree）
- 工作目录：/home/dev/claw-037-input-triggers
- 前置：036 已合入（afd688f），`input-composer.js` 常驻 composer 与九级模式判定
  `resolveInputSurfaceMode` 已就位
- 行为契约基线：`docs/input-area-behavioral-contract.md` §8（事件→显示映射，
  覆盖面不得减少）+ §3 模式矩阵

## 调用点清单（重构对象，约 19 处 / 10 个文件）

| 域 | 场景 | 现状调用 |
|---|---|---|
| 轮询 poll（app-main.js） | inputRequests JSON 变化 | commitSessionViewPatch 回调内手动调 |
| 会话加载 agent-data-loader | loadAgentData 完成 | commit 回调内手动调 |
| 主视图渲染 app-ui.js | renderCurrentMainView / resetRuntimeBackedSurfaceState | 手动调（结构性） |
| runtime-status | calling 状态翻转 | 3 处手动 reset+调 |
| persistent-input | 提交成功 / 队列同步后模式翻转 | 2 处 |
| input-helpers | 提交成功乐观清空 | 2 处（applySessionViewPatch + render） |
| choice-input | 选项/收起/展开/拒绝 | 2 处（rerenderChoiceRequest 内 reset） |
| rollback-dialog | close 时恢复 | 1 处 |
| generative-ui-panel | input 型 action 提交后 | 1 处 |
| voice-input | 语音 pending 注入路径 | 注释引用 |

## 改动项

### A. 单一状态驱动入口（核心）

- 建立**输入面唯一的渲染触发通道**（可落在 input-composer.js 或新模块）：
  `applySessionViewPatch` / `commitSessionViewPatch` 写入 `inputRequests` 时
  自动触发输入面渲染（同轮去重），calling 状态翻转与队列同步通过同一入口
  声明变更。
- 渲染仍是同步、幂等的属性级更新（036 已具备），订阅只替代"手动 reset 签名
  + 手动调 render"的配对动作。
- 乐观即时更新必须保留：提交成功后的即时反馈（清空输入面、按钮切 stop）
  不允许退化为"等下一轮 poll"。

### B. 调用点处置清单

逐处处置 19 个调用点，最终报告必须包含完整清单（删除 / 改为状态写入 /
保留并注明理由）。预期形态：

- **删除**：纯"改状态后手动戳"的配对（提交成功、choice 交互、rollback 关闭、
  generative-ui、runtime-status 翻转中可由状态推导的）——状态写入本身触发渲染。
- **保留**：会话加载（loadAgentData）与主视图渲染（renderCurrentMainView）这类
  结构性时机可保留显式调用，但必须走同一入口。
- `lastRenderedInputSignature` / `lastRenderedInputMode` 若订阅模型下不再需要，
  可整体退役；对外函数（renderInputRequests 等）保留为订阅内部实现或薄包装。

### C. 行为契约回归

- 契约 §8 刷新触发源表逐行核对：收敛后每类事件的"显示结果"不变。
- 契约 §3 九级模式矩阵、§7 状态保持不回归（036 的既有测试全量保留并保持绿）。

## 明确非目标

- 不动 choice 卡、回退对话框、压缩卡、slash、meta bar、队列气泡的内部实现。
- 不改服务端与协议。
- 不动 local-features/**。
- work-group 输入系统不动。

## 验收命令

```bash
cd /home/dev/claw-037-input-triggers
npm test                      # 全量绿（含 036 的 frontend-input-composer 8 用例）
git diff --check
```

新增测试（进 `test/`，frontend-input- 前缀，沿用 vm 沙箱模式）：

1. 状态写入自动触发：applySessionViewPatch({ inputRequests }) 后输入面渲染
   无需手动 poke（订阅生效）；
2. 删除手动调用点后，各类事件（calling 翻转 / choice 交互 / 提交成功）输入面
   显示结果与契约 §8 映射一致（逐行锁死）；
3. 乐观即时性：提交成功后输入面更新不依赖 poll（同步或微任务内完成）。

## 约束

- 不得 reset / clean / 覆盖其他会话改动
- 不动 server/、local-features/、框架仓库、prebuilt-agents
- 允许修改范围：public/src/**、public/index.html、test/frontend-input-*、
  test/session-ui-context.test.js（如需同步）
- 不 commit 不 push，完成后输出最终报告（修改文件清单、验收输出、已验证项、
  未验证项、风险）
- 测试预算遵守 CLAUDE.md；行为契约 §3–§9 不得回归
