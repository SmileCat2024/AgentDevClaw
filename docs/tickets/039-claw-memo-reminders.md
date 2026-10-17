# 039 — memo 定时提醒：scheduled-trigger 机制件、memo-reminders feature 与应用装配

仓库：AgentDevClaw（`D:\code\AgentDevClaw`）
权威设计：[ADR-0030](../adr/0030-os-notification-delivery-and-app-adoption.md)（投递通道与权限）；应用侧产品切片经 2026-10-17 grill 会话裁决（本票"决策已定死"节固化）
前置：[038](038-claw-notification-foundation.md) 已合入（依赖其 `POST /protoclaw/app_notifications` 投递端点与 `notifications.reminder` 权限闸）

## 目标

memo 智能备忘录的定时提醒能力——ADR-0030 统一通知通道的第一个主动投递类消费者：

1. `local-features/scheduled-trigger`：通用持久定时机制件（feature 形态，装配即得）；
2. `local-features/memo-reminders`：memo 提醒业务 feature（工具面 + 数据面 + 到点投递）；
3. memo agent / metadata 装配 + runtime boot 自启；
4. memo 首页提醒列表 block。

## 决策已定死（不得偏离）

### 层级模型（提醒的归属与投递目标）

- **提醒是 APP 级资产，对线程零绑定**：数据落 `workspaces/memo/reminders.json`，条目不带线程身份字段；线程换代、rotation 均不需要提醒迁移逻辑。
- **投递时解析 APP 当前唯一活动线程**：agent 标投递经 `POST /threads/:threadId/input`（`kind=reminder`）唤醒活动线程 head，threadId 读服务端 memo-app 模块的 `activeThreadId`（`server/routes/memo-app.js` 的 app-state 权威）；rotation 换头对提醒无感。
- **投递瞬间活动线程悬空**（线程被删未换代、换代事务竞态）：direct 照弹 toast（无 threadId 落点则点击打开 memo 首页）；agent 标无处唤醒，**降级直弹登记文案**并标记已投递——通知必达优先于人格化，这是显式产品行为，不是静默吞掉。
- 提醒生死只由用户显式操作决定（完成 / 删除 / 清空），线程换代不触碰。

### 产品切片

- **提醒语义**：单次 + 简单循环，封闭枚举 `once | daily | weekly | monthly`（weekly 携带星期几集合），不上 cron / RRULE。
- **登记路径**：对话内自然语言是唯一 MVP 入口，LLM 解析成结构化登记；首页表单挂账不做。
- **到点判定**：登记时 agent 打标 `delivery: direct | agent`——"明天 9 点提醒我开会"类打 direct（到点直弹登记文案，零 LLM 成本）；"到点看看我今天该干嘛"类打 agent（到点唤醒生成后弹通知）。
- **管理面**：对话内工具 + 首页提醒列表 block（只读列表 + 完成勾选 + 删除），不做 snooze / 编辑表单。
- **时间基准**：`fire_at` 存本地时区 ISO（带偏移），展示按本地；不做时区旅行 / DST 特判。
- **过期补偿**：错过也应执行——重臂时 `fire_at` 已过的条目立即触发，toast/文案可标注"错过了预定时间"；不静默丢弃。

### 数据 schema（workspaces/memo/reminders.json）

条目字段：`id`、`content`（提醒文案）、`fire_at`（ISO 本地时区）、`recurrence`（`once | daily | weekly | monthly`）、`weekdays`（仅 weekly，数字数组 0–6）、`delivery`（`direct | agent`）、`status`（`scheduled | fired`）、`createdAt`。文件级读写串行（写时全量落盘，原子写：临时文件 + rename，照 memo-notes 存储先例）。

## 实施清单

### A. scheduled-trigger 机制件（local-features/scheduled-trigger）

- 通用持久定时：构造配置含数据文件路径与回调；臂/重臂/落盘/恢复全部内聚，业务零感知。
- 生命周期：feature `onInitiate` 时读盘重臂——`fire_at` 过期的条目**立即回调**（过期即发），未到的按最近到期时刻 setTimeout（长臂用分层：分钟内精确臂、以外用粗 tick 重算，避免超长 timer 漂移；实现自定，测试须可注入时钟）。
- 回调后由业务决定条目去留（循环类重算下次 fire_at 写回，机制件不解释业务规则——回调返回值/业务侧自行重写数据文件均可，接口从简）。
- 测试 `local-features/scheduled-trigger/test/`：mock.timers 驱动（禁真实 sleep >500ms），覆盖过期即发、精确触发、循环重臂由业务回写后再臂。
- 目录加入 `local-features/tsconfig.json` include。

### B. memo-reminders feature（local-features/memo-reminders）

- 工具面（LLM 调用）：`memo_create_reminder`（content / fire_at / recurrence / weekdays / delivery）、`memo_list_reminders`、`memo_complete_reminder`、`memo_delete_reminder`。工具描述写清相对时间解析依赖系统时间上下文（time-awareness 已注入）。
- 到点回调（direct）：`POST /protoclaw/app_notifications`（038 端点，`agentId=memo`、`type=reminder`、title/body、过期标注素材），鉴权照 internal-auth 先例。
- 到点回调（agent）：解析活动线程 → 有则 `POST /threads/:threadId/input`（`kind=reminder`，正文含提醒内容与"错过了预定时间"标注若有）；悬空则降级 direct 直弹登记文案。唤醒后 agent 的回复通知由 agent 轮回复写或前端既有呈现承接——**本期 agent 路径只担保唤醒投递成功**，回复弹出走现状会话呈现（在线投递语义）。
- runtime 身份（serverOrigin / agentId / sessionId）与装配参数形态照 ContextRotationTriggerFeature 先例（memo agent.js 现有装配）。
- 测试 `local-features/memo-reminders/test/`：工具面 CRUD、循环重算（daily/weekly/monthly 下次 fire_at 计算）、降级路径、schema 校验。

### C. memo 装配与 boot 自启

- `prebuilt-agents/official/memo/agent.js`：`this.use(new MemoRemindersFeature(...))`（含 scheduled-trigger 组装或内聚于该 feature，结构自定但两个 local-feature 目录分立）。
- `prebuilt-agents/official/memo/metadata.json`：description 去掉"提醒能力建设中"改为成品描述；home blocks 在 memo-notes 之后加 `{ "id": "memo-reminders", "type": "memo-reminders" }`。permissions / permissionDefaults 已由 038 声明，本票核对即可。
- `.agentdev/prompts/system.md`：补提醒工具用法（自然语言登记示例、direct/agent 打标判断标准、列表/完成/删除口径）。
- boot 自启：server 重启后 memo runtime 自动拉起（定时器住 runtime，这是提醒刚性的前提）。实现照 qqbot on-boot 先例（`server/routes/dispatch-engine.js` 的 on-boot schedule 模式 / 或 memo-app 服务端启动时 ensureHeadRuntime，**取最小实现**，不得新建进程监督机制——crash respawn 是挂账独立立项）。手工停止 runtime 后提醒随之停发（模型 A 语义），无隐藏后台。

### D. 首页提醒列表 block

- server：`server/routes/memo-app.js` 加提醒列表数据端点（读 `workspaces/memo/reminders.json`，照便签墙数据面先例）+ 完成 / 删除操作端点（写回同一文件，与 runtime 侧工具面共用存储模块——**注意并发**：server 与 runtime 两写方，写路径经同一原子写约定；若复用 runtime 侧存储实现不可行，server 侧 inline 最小实现并在两处注明同步约定）。
- 前端：新 block type `memo-reminders` 渲染（照 `public/src/modules/memo-notes-ui.js` 便签墙模式：只读列表 + 完成勾选 + 删除按钮，中英双语）。
- **改前必读**：`docs/reference/design-system.md`（视觉配方，复用既有控件）、`docs/reference/frontend-rendering-patterns.md`。

### E. 构建与测试

- `npm run build:local-features` 通过；新目录进 tsconfig include。
- `npm run test:features` 全绿；`npm test`（core）不回归。
- ESLint（local-features TS 纪律）：`createLogger()` 日志，禁 console。

## 边界（禁止项）

- 不改 AgentDev 框架仓库；不做 crash respawn / 进程监督（挂账）；不做 snooze / 首页登记表单 / IM 渠道推送（挂账）。
- 提醒数据不得落 OS 分区或全局用户数据分区（住 `workspaces/memo/`，APP 资产）。
- 不动 docs/（调度方收尾）；不动 038 已交付的投递端点语义（发现缺口报回，不就地改契约）。
- 禁 `git reset --hard` / `git clean` / 覆盖未归属改动；不自行 push。

## 验收

1. `npm run test:features` 全绿（含两个新目录测试）；`npm test` 不回归；
2. `npm run build:local-features` 产物更新；
3. 最终报告列出：修改文件清单、测试数量与结果、已验证项、未验证项（整服重启后冒烟属调度方补验：对话内登记提醒 → 到点 direct 弹 toast、agent 标唤醒会话、首页列表呈现与完成/删除、boot 后过期提醒补发）、风险。
