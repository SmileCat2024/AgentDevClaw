# 工单 035：coder_shell 会话动词、create 预校验与引号 glob 修复

## 背景（真实事故驱动）

另一个 agent 用 coder_shell 派发工单时撞上机制断层（两次复现，已读 server 源码定位）：

1. **无会话创建动词**：`create` 要求 sessionId 是已存在的 Coder 会话，但 8 个动词里没有创建会话的动词。纯 agent 调度方（无人在 Web UI 旁建会话）陷入死循环：create → send 报 `runtimeWake=failed (head_session_missing)` → 按故障表"归档重建"→ 重建仍缺会话。事故中 agent 只能从 `/proc/<pid>/environ` 取 token 直调 REST 才解围。
2. **create 不做会话预校验**：对不存在的 sessionId 照样建出 `status=open` 的僵尸线程，失败延迟到 send 的 runtimeWake 阶段才暴露。
3. **引号内 glob 误伤**：工单文本含 markdown 加粗 `**...**`，`structure.ts` 的 `containsGlob` 对解析后 token 无差别拒绝 `*`，而 bash 语义里引号内的 `*` 是字面量。真实工单文本几乎必含 markdown/代码，这个误伤会持续咬人。

事故中 agent 的临时解法（读进程 env 取 token 直调 REST）证明端点契约可用，但要把它变成合法动词，不能让每个 agent 都去读 `/proc`。

- 仓库：/home/dev/AgentDevClaw（本 worktree）
- 工作目录：/home/dev/claw-035-session-verb
- 允许修改范围：`local-features/capability-shell/**`、`docs/tickets/035-*.md`
- 前置：033（26f13f8）、034（a272d6f）均已合入 main

## 改动项

### A. 新动词 `new-session`（最优先）

```
new-session <agentId> ['标题']
```

- adapter 直调 `POST /protoclaw/prebuilt_sessions`，body：`{ agentId, sessionType: 'coder', title? }`。
  契约以 CLI 为准：`bin/claw.mjs` 655-674 行（`--dir` 映射为 body 的 `openDirectory`，本动词 v1 不暴露目录参数，会话绑定 agent 工作空间目录即可）。
- 响应解析：`threadId` 在 `session` 对象**之前**（服务端为截断安全特意如此排列）。输出两行：

  ```
  sessionId=<session.id>
  threadId=<threadId>          # 为 null 时追加提示：未自动建线，用 create <agentId> <sessionId> 手动建线
  ```

- verbs 常量列表从 8 个更新为 9 个；`coder-policy.ts` 增加 new-session 声明（agentId literal 必填、title 可选、usage 字符串）。

### B. create 会话预校验（消灭僵尸线程）

- create adapter 在 POST `/protoclaw/threads` 之前先 `GET /protoclaw/prebuilt_sessions/:sessionId`（端点行为以 server/routes/session.js:155 起的实现为准核实；若该路径不存在则找等价的会话查询端点）。
- 会话不存在（404）→ 返回结构化拒绝文案：说明会话不存在、先用 `new-session` 创建，**不建线程**。
- 会话存在但 agentId 不匹配 → 同样拒绝并说明。
- 查询失败（server 错误）不阻塞建线：按原逻辑继续（网络错误不该放大成功能缺失），但响应中附注会话未验证。

### C. 引号内 glob 字符放行（修复 markdown 误伤）

- `structure.ts`：现状 `containsGlob` 对每个解析后 token 无差别拒绝 `* ?`，导致单引号内的 markdown/代码文本被误杀。
- bash 语义：引号内（单引号、双引号）的 `* ?` 不触发 glob，是字面量。修正为**引号区域感知**：
  - 参照同文件 `containsDollarOutsideSingleQuotes` 的逐字符扫描模式，实现"引号外 glob 字符"检测：单引号区域（无转义、无嵌套）与双引号区域内的 `* ? [ ]` 放行；
  - 删除（或改造为仅对引号外原文调用）token 级 `containsGlob` 检查；
  - 保留现有语义：裸 `ls *`、`rm ?` 引号外使用仍拒绝；`'.[:5]'`（jq 过滤器，工单验收用例）继续放行；
  - 双引号内放行是安全的：变量 `$` 已在原文扫描道拒绝，引号内无展开注入面。
- 测试必须覆盖：`send wt-x key '工单 **LAND** 判决'` 放行；裸 `ls *` 拒绝；`grep '*' file`（引号内）放行。

### D. 技能文档同步（local-features/capability-shell/skills/claw-coder-dispatch/SKILL.md）

- 动词表 8→9：补 `new-session <agentId> ['标题']` 行（语义：创建 Coder 会话并自动建线，返回 sessionId + threadId）；
- `create` 小节措辞更新：`sessionId` 无可用会话时先用 `new-session` 创建；create 仅用于给已存在会话加线程；
- 故障表 `head_session_missing` 行：补一句"若环境无可用 Coder 会话，先 `new-session` 再派发"（消除死循环）；
- 调度流程小节相应更新（new-session 是标准第一步）。
- 使用者视角文案，不写实现细节（不要出现 token、/proc、端点路径等）。

## 验收命令

```bash
cd /home/dev/claw-035-session-verb
npm run build:local-features
npm run test:features   # 基线 221 全绿 + 新增用例全绿
git diff --check
```

新增测试（进 `local-features/capability-shell/test/`）：

1. new-session adapter：契约映射（body 含 sessionType:'coder'）、响应解析（threadId 前置）、null threadId 提示；
2. create 预校验：会话不存在 → 拒绝且不发 POST；会话存在 → 正常建线；查询网络失败 → 不阻塞建线；
3. 引号 glob：`'**bold**'` 放行、裸 `*` 拒绝、`'.[:5]'` 放行（既有用例不回归）。

## 约束

- 不得 reset/clean/覆盖其他会话改动
- 不动 server/ 与框架仓库
- 技能文档改动保持使用者视角（本轮已按此心智清理过，延续该风格）
- 完成报告列出：修改文件、测试数量、已验证/未验证项

## 验收证据基线

- 事故线程：wt-adb1f63f（僵尸，已归档）、wt-056e8c1a（僵尸）；成功案例 session-1788233352978-7f9c0c
- 误伤案例：工单文本含 `**LAND**` 被语法道以 glob 拒绝
