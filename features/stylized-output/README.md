# stylized-output

输出风格库 + 确认签名门禁。用户用 markdown 预置输出风格；风格被选中后，模型的每一次最终回复都必须调用签名工具逐字默写该风格的确认签名，验证通过才允许结束本轮回复。

## 目录约定

- `<workspaceDir>/.agentdev/output-style/*.md` —— 每个平铺 md 文件 = 一种风格（非递归、忽略点开头的文件）。

## 风格选择的生命周期（会话作用域，不落盘）

风格选择是**会话内存状态**（`activeStyleName`），没有任何磁盘存储：

- 选择/清除的唯一写入入口是 `configure` capability（Claw 面板 / slash，人工操作，即时生效）；模型侧没有设置风格的工具。
- 同一会话内随 Feature 状态快照（`captureState` / `restoreState`）持久：Runtime 停止重启恢复 stateful 会话时，选择一并还原。
- 新会话一律从"未选择"开始——工作区目录里的任何遗留状态都不会让新对话先入为主地继承某个风格。
- 内存中选中的风格文件被删除/改名时，下次扫描自动按未选择处理（门禁旁路）并记录警告。

## 风格文件格式

```markdown
---
name: 简洁汇报
description: 一句话描述。
signature: 我确认本回复已经过逐句删减，没有一个多余的字。
---

（正文：风格规则）
```

frontmatter 必填 `name` / `description` / `signature`（均为单行字符串，含冒号时建议加引号）；缺字段或重名的文件会被忽略并记录警告。`signature` 是确认签名：一句简短但独特的声明句，是本 Feature 的核心创新——模型必须逐字默写它作为合规证明。

## 行为

1. **注入**：风格被选中时，风格全文（frontmatter 原文 + 正文 + 签名要求）以 system 消息注入上下文；风格或其文件内容变化时重新注入（内容指纹去重）。
2. **签名工具 `sign_output_style`**：模型逐字默写当前风格的 signature，并必填 `interrupt`（打断）布尔字段；规范化空白后全等比对。匹配 → 本轮放行；不匹配 → 报错并要求核对原文（不泄露正确签名）。`interrupt` 缺失 → 按 `false` 生效，并经调用改写（ADR-0023 effectiveCall，工具声明 `rewritable`）把 assistant 历史中的本次调用修正为显式 `interrupt=false`，下一轮模型看到的就是已补全的调用；填了但非布尔值 → 直接拒绝。未启用风格时调用会得到明确的"无需签名"拒绝。
3. **空正文打断降级（防"假签名提早打断"）**：`interrupt=true` 仅在随本调用一并输出了非空回复正文时才生效。ToolUse 钩子在签名工具执行前从 context 捕获本步 assistant 正文（react-loop 保证本步消息先于工具执行写入）；捕获到空白正文时，打断被强制降级为 `false` 并同样经 effectiveCall 改写调用历史——签名本身仍记为通过，本轮继续，工具结果勒令模型在下一步直接输出最终回复正文、不再调用任何工具，以自然收尾步结束。模型"先签名后输出"与"输出+签名同步"两种习惯都正确闭环，空正文提早打断不再产生残缺/为空的最终回复。捕获事实缺失（非标准执行链直调，`signStepContent` 为 null）时不判断，保持现状行为。
4. **打断（`interrupt=true` 的签名）**：签名通过且未降级的本步（带工具调用）guard 返回 Deny 直接结束本轮——随签名工具调用一并给出的正文即最终回复，省去签名后的又一次模型调用。子代理、wait 等机制活跃时不干预，请求保持挂起，待机制收敛后的下一个 StepFinish 再生效。
5. **门禁（StepFinish guard）**：风格启用期间，无工具调用的自然结束步必须已签名通过；否则拦截结束、注入勒令补签的 system 消息并强制再跑一轮。连续拦截达到 `maxSignatureBlocks`（默认 5，1–10）后放行并告警，防死循环。子代理、wait、后台唤醒机制活跃时不干预。
6. **管理工具 `list_output_styles` / `show_output_style`（只读）**：模型可主动列出全部风格（名称 / 描述 / 是否启用），或查看指定风格（缺省当前风格）的完整说明原文（frontmatter + 正文 + signature）。上下文中的风格说明被精简或遗失时，凭这两个工具即可重新核对签名原文与风格要求。
7. **会话状态**：风格选择与签名凭证均为会话内存态；签名凭证与打断请求按「每条最终回复」重置（CallStart 清零，打断被消费或风格切换时也清零），随会话快照持久化，跨会话不继承。本步正文捕获（`signStepContent`）是步级暂态，不参与快照。

## 公共 API（供控制面 / 其他 Feature 使用；模型不可见）

- `getStyles()` / `getActiveStyle()` / `getStatus()`
- `setActiveStyle(name | null)` —— 设置/清除当前风格（会话内存态，立即生效，不落盘）；面板 capability 的写入入口，清单外的风格名会被拒绝
- `setMaxSignatureBlocks(value)` —— 调整签名拦截上限（1–10 钳制）

对外控制链路是 `configure` capability（Claw 面板 / slash）：读取门禁状态、切换风格、调整签名拦截上限。

## 测试

自动化测试：`node --test test/stylized-output.test.js`（构建 dist 后运行），覆盖：

- ToolUse 钩子只对签名调用捕获本步正文；尾部无 assistant 消息按空白处理
- 空正文 + `interrupt=true` → 强制降级为 `false`：effectiveCall 改写、签名仍记为通过、打断请求不置位、结果勒令下一步输出最终回复正文
- 非空正文 + `interrupt=true` → 打断正常生效
- 捕获事实缺失（未经标准执行链直调）→ 不降级，保持现状行为
- `interrupt=false` → 提示立即产出最终回复正文
- 签名不匹配 → 拒绝，不受 interrupt 影响

风格启用后的门禁/签名正向路径依赖面板 capability 人工启用，Test Runtime 中无自动化入口，回归以面板人工验证为准（历史人工场景：`style-gate-bypass-when-unset` 未选择风格旁路放行；`style-gate-signed-finish` 未启用时签名被拒；`style-gate-forces-sign` 新会话不携带风格选择）。