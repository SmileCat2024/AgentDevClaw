# 020 — persistent-input.js 拆分（input-model-switcher）

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：2026-08-23 前端回涨文件调研 grill 会话（Q1-Q4、Q6）；行数与区段边界为该次快照
- **类型**：纯前端模块搬移（move not refactor）
- **前置**：019 完成后执行（同批串行，避免 index.html 加载序冲突；与 022 零交集可并行）

## 背景

`public/src/modules/persistent-input.js` 2026-07-04 拆出时约 500 行，当前 1,291 行。
回涨主因（git 查证）：

- 5ee7c26：vision 图片管线（附件上传 ~140 行）
- 07-26 系列（dc68dfd / 2352c2b / 856963e / 961427b / feeaae7）：**模型切换下拉 +
  thinking effort 切换器，合计 ~475 行**（最大增幅）
- 5c394ae：运行时长胶囊；e46bbc8 / c9276ad：user input 链路治理与 work-thread 承接

当前四域构成：输入框主体 ~140 / 附件图片上传 ~140 / **模型+思考强度切换器 ~475**（359-833）/
队列系统 ~300。两个切换器是挂在输入框工具栏上的独立组件，与输入框本体、队列仅有少量
状态交互。

## 执行步骤

1. 新建 `public/src/modules/input-model-switcher.js`，迁入（快照行号 359-833）：
   - model 切换：`_getInputAgentId` / `_getInputDefaultPresetName` /
     `_closeInputModelDropdown` / `_inputModelDropdownOutsideClick` /
     `_performInputModelSwap` / `updateInputModelSwitcher`
   - thinking effort 切换：`OPENAI_EFFORT_LABELS` / `ANTHROPIC_EFFORT_LABELS` /
     `_getCurrentPreset` / `_getCurrentPresetProtocol` / `_getEffortList` /
     `_getEffortLabel` / `_getCurrentThinkingEffort` / `_currentModelSupportsThinking` /
     `_closeThinkingEffortDropdown` / `_inputThinkingDropdownOutsideClick` /
     `_performThinkingEffortSwap` / `updateThinkingEffortSwitcher`
2. 两个切换器放同一文件（Q6 决策）：共享 `_getCurrentPreset` / 协议判定 /
   缓存读取链，拆两个文件会互引或复制读取逻辑。
3. 顶部注释写明依赖清单；`index.html` 将新 script 插在 `persistent-input.js` 之前
   （persistent-input 的 `renderPersistentInput` 运行时调用切换器渲染函数）。
4. 若 `_getInputAgentId` 等基础读取函数同时被留守侧（附件上传等）使用：
   留在 persistent-input.js，切换器侧直接全局引用，不复制。

## 验收标准

- 静态验证（grep 清单）：
  - 全部被迁符号在 `input-model-switcher.js` 有定义
  - `persistent-input.js` 对被迁符号零残留定义
  - 既有引用方零改动（调研证实外部引用方：`chat-context-bar.js` /
    `input-helpers.js` / `input-render.js` / `app-main.js`）
- 加载验证：启动后浏览器 console 零错误。
- 手工冒烟（逐项）：
  - model 下拉打开 / 切换预设 / 切换后发送一轮对话（确认热切换生效）
  - thinking effort 下拉切换（含切换到不支持思考的模型时的降级显示）
  - 输入框正常渲染、草稿恢复、图片附件添加与发送
  - 队列气泡出现 / 提交 / 清空
- `persistent-input.js` 行数回落至 ~820。

## 风险提示

- 区段行号为调研快照，以 grep 符号边界为准。
- `_performInputModelSwap` / `_performThinkingEffortSwap` 内含 agentId 解析与
  缓存刷新链，迁移时禁止顺手改逻辑；swap 后的联动刷新（renderAgentList 等）
  依赖全局函数，加载序已由既有 script 顺序保证。
