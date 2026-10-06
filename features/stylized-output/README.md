# stylized-output

输出风格库 + 确认签名门禁。用户用 markdown 预置输出风格；风格被选中后，模型的每一次最终回复都必须调用签名工具逐字默写该风格的确认签名，验证通过才允许结束本轮回复。

## 目录约定

- `<workspaceDir>/.agentdev/output-style/*.md` —— 每个平铺 md 文件 = 一种风格（非递归、忽略点开头的文件）。
- `<workspaceDir>/.agentdev/output-style/.current-style` —— 当前选中的风格名；文件缺失、空、`none`/`off` 均视为未选择（门禁旁路）。

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
2. **签名工具 `sign_output_style`**：模型逐字默写当前风格的 signature；规范化空白后全等比对。匹配 → 本轮放行；不匹配 → 报错并要求核对原文（不泄露正确签名）。
3. **门禁（StepFinish guard）**：风格启用期间，无工具调用的自然结束步必须已签名通过；否则拦截结束、注入勒令补签的 system 消息并强制再跑一轮。连续拦截达到 `maxSignatureBlocks`（默认 5，1–10）后放行并告警，防死循环。子代理、wait、后台唤醒机制活跃时不干预。
4. **管理工具 `list_output_styles` / `show_output_style`（只读）**：模型可主动列出全部风格（名称 / 描述 / 是否启用），或查看指定风格（缺省当前风格）的完整说明原文（frontmatter + 正文 + signature）。上下文中的风格说明被精简或遗失时，凭这两个工具即可重新核对签名原文与风格要求。
5. **会话状态**：签名凭证按「每条最终回复」重置（CallStart 清零），随会话 checkpoint 持久化。

## 公共 API（供未来控制面 / 其他 Feature 使用；模型不可见）

- `getStyles()` / `getActiveStyle()` / `getStatus()`
- `setActiveStyle(name | null)` —— 写入 `.current-style` 并即时生效

对外控制链路（Claw 面板 / capability / slash）本期不设计。

## 测试

`style-gate-signed-finish`、`style-gate-forces-sign`、`style-gate-bypass-when-unset`（Agent Studio 项目 force-continuation 下）。