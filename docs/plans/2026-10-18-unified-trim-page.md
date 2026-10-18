# 实施计划：统一精简页面（比例精简 + 卡片式左右布局）

日期：2026-10-18
状态：已实施
范围：会话右键「精简历史」两入口（仅精简 / 精简并归档）的 UI 重构与比例精简策略；摘要、分支入口与对话框不动；精简引擎与 AgentDev 框架零改动

## 0. 设计决策

1. **吸收范围**：统一页面只收精简家族两入口；入口仅预置「归档原会话」勾选状态（仅精简→不勾；精简并归档→勾上），页内可改。
2. **两模式共存**：按轮次模式（默认，逐轮勾选，支持非连续保留）+ 按比例模式，页内切换；命名面向用户，「按轮次 / 按比例」相对成对，默认项排在左侧。
3. **比例语义**：目标 = 精简后估算总长（系统前言 + 头部折叠残留 + 保留区）≤ 原始总长的 X%；字符口径；摘要生成后的实际长度不计入约束（UI 标注「摘要另计」）。
4. **头部处置 = 现有引擎语义**：保留区外对话文本（user / assistant）保留，工具活动折叠为一行注记。不加「彻底删除」开关。
5. **切点规则**：切线优先落轮边界；单轮体量过大无法达标时才切入轮内；工具调用与结果消息同进同退（不产生孤儿对）。
6. **页面形态**：与模型配置窗同款尺寸（`.ph-settings-window`：**固定 1040×820 居中弹层**，不随内容收缩），卡片内左右布局——左栏为**统一时间轴**：垂直轴线贯穿，系统上下文、切点、轮次全部是轴上节点（同一视觉语法）；轮节点 = 用户输入摘要（定位主锚）+ 副行「第 N 轮 · 工具注记 · 占比」，不展示 assistant 回复正文、工具参数与结果内容。切点上下轮次默认全部可见，为用户判断切点提供相邻语境。状态由轴点表达：精简侧空心淡化、保留侧实心；切点只在一个真实边界处显示橙色标记（轮间显示在两轮之间，轮内显示在 assistant 回复/工具段后），避免重复表达。仅当切线落入轮内（单轮巨上下文）时，该轮自动展开轮内详情：assistant 回复为锚点节点 + 工具段（连续调用聚合 + 体量），工具段尾即切点。按轮次模式共享同一时间轴骨架，保留原有轮次复选框及每轮「精简到此处」操作。
7. **比例控件**：滑动条为主（拖动即时重算），数值输入框为辅；不允许只有键盘输入。
8. **交互反馈**：切点在时间轴上唯一标记（「保留从这里开始 · 释放 X%」），切点上下轮次默认可见；右栏实时读数；滑杆定位切线与点击轮节点/工具段「从此保留」双向联动，按轮次模式保留每轮「精简到此处」；全部纯前端重算，不重复请求。
9. **右栏配置项**：模式切换、比例滑动条 + 数值框、生成摘要（默认不勾）、归档原会话（按入口预置）、保留最近技能调用（行为不变）。
10. **删除项**：旧逐轮精简对话框整体删除，由按轮次模式替换；`.trim-*` CSS 与分支对话框共用，保留。
11. **不动项**：`/trim` slash 快捷路径、`CTX_SESSION_OPS_AGENTS` 白名单（programming-helper + agent-studio）、远程转发模式、应用后行为（后继会话 + 自动切换 + 可选归档）、上下文护栏提示（后续迭代再接）。
12. **默认值**：比例默认 30%，记住上次使用值（localStorage）。

## 1. 现状基准（2026-10-18 读码验证）

### 1.1 入口与提交链路

- 入口：`public/src/modules/ctx-menu-items.js` 精简子菜单两 action（`trim` / `trim-and-archive`）→ `window.openTrimDialog(agentId, sessionId, archiveAfter)`（`public/src/modules/session-dialogs.js`）。
- 预览：`GET /protoclaw/session_trim_preview`（`server/routes/session.js:451`，远程身份经 `resolveForwardHostTarget` 转发远程同名路由）→ 纯函数 `buildSessionTrimPreview`（`server/routes/session-helpers-pure.js:260`）。返回轮级数据：`rounds[]`（`roundIndex / turnStart / turnEnd / msgIndexStart / msgIndexEnd / userPreview / assistantPreview / toolCalls[{name,summary}] / messageCount / charCount / charPercent / cumulativePercent`，全部 `suggestedTrim=true`）+ `preamblePercent`。
- 提交：`window.submitTrimCompact()` → `createCompactedResumeSession`（`public/src/app-main.js:412`，参数 `extraPolicy`）→ `POST /protoclaw/context_handoffs/compact_and_resume`（`server/routes/session.js:1470`，含远程转发、幂等键、归档原会话、血缘通知）→ 框架 `TrimTranscriptWithSummaryTransformation` → `writeTrimWithSummaryHandoffPackage`（`server/context-continuity/handoff-package.js`）落盘 handoff 并创建后继会话。
- 现有 policy 形态：`{ preservedTurns, preservedMsgRanges: Array<[start,end]>, keepRecentSkillInvokes }`。

### 1.2 引擎语义（`AgentDev/packages/core/src/core/continuity/transforms/trim-transcript.ts`，与 Claw `handoff-package.js` 同源）

- `preservedMsgRanges` 按**消息索引**任意生效（轮内区间可用，已读码验证）；命中区间的消息原样保留。
- 区间外：`includeUserMessages / includeAssistantMessages` 默认 true → 对话文本保留；工具调用与结果按 `assistantToolCallMode / toolMessageMode: 'fold'` 折叠——连续工具活动合并为一条 `[Folded tool activity]` 注记，每个调用摘要上限 `maxFoldedToolChars: 240`，同名摘要去重。
- `keepRecentSkillInvokes` 在折叠区内仍保护最近 N 次 `invoke_skill` 调用对。

### 1.3 对话框资产

- `public/index.html:410-447` `#trim-dialog`（`.trim-dialog / .trim-overlay / .trim-panel`，`.trim-panel` 为 720×700，与 `.feature-detail-window` 同尺寸）；`#branch-dialog`（449-468）共用同一套类。
- CSS 在 `public/styles/components.css:7204` 起 `.trim-*` 系列。
- `session-dialogs.js` 同时承载 trim 与 branch 两套对话框逻辑；trim 部分含提交编排（navGuard、归档乐观回滚、sidebar operation 状态机、远程切换分支）。

## 2. 目标行为（用户视角）

1. 右键会话 →「精简历史」→ 仅精简 / 精简并归档：两入口都打开统一精简页面，唯一差异是「归档原会话」勾选预置。
2. 页面为固定 1040×820 居中卡片：左栏按轮展示会话记录，默认只显示轮号、用户输入摘要、至多三种工具名及调用次数；展开单轮后显示聚合工具名和安全切点。右栏为配置区。
3. 默认按轮次模式：逐轮勾选（非连续可选）、「精简到此处」，行为对齐旧对话框。
4. 切到按比例模式：拖动滑动条（或输入数值，或点击轴上轮节点「从此保留」），切点标记与读数即时变化；读数展示「保留 X% · 保留 Y 条消息 · 估算 Z 字符 · 释放 W%」；切点上下轮次均保持可见。
5. 点「确认精简」：创建后继会话并切换，可选归档原会话——与现状一致。

## 3. 实施切片

每片独立可验收、可 revert。PR-1/PR-2 无 UI 依赖可先行；PR-3 依赖 1+2；PR-4 收口。

### PR-1 服务端消息级预览

- `server/routes/session-helpers-pure.js`：新增 `buildSessionTrimMessagePreview(messages)`：顶层消息投影数组，每条含 `index`（全局消息索引，与引擎 rawMessages 严格对齐，无 role 的脏消息原位保留）、`role`、`turn`（原始值）、`roundIndex`（轮归属，preamble 为 null）、`charCount`（含工具体积）、`contentCharCount`（纯对话文本体积——折叠残留估算需要「对话文本保留 / 工具活动折叠」分账）、`preview`（≤200 字符，user/assistant）、`toolCalls[{id?, name, summary}]`（summary 为引擎括号格式 `read(a.js)`，前端残留估算可直接拼接）、`toolCallId`（tool 结果消息，安全切点配对判定）。纯函数，复用 `estimateMessageCharCount / extractToolCallLabel` 的工具口径。
- `server/routes/session.js` `session_trim_preview` 响应新增顶层 `messages` 与 `preambleCharCount`；`rounds` 字段原样保留（旧客户端与按轮次模式兼容）。
- 测试：扩展 `test/session-helpers-pure.test.js`——消息级字段完整性、索引连续性、轮归属正确、空会话与无工具轮边界。

### PR-2 比例计算核心（前端纯函数，可测）

- 新文件 `public/src/modules/trim-ratio-core.js`：DOM 无关纯函数，文件尾以 `typeof window !== 'undefined'` 守卫挂 `window.TrimRatioCore`；node:test 直接 import（`frontend-vm.js` 沙箱测试先例）。
- 函数面：
  - `safeCutCandidates(messages)`：全部安全切点（切点前无悬空 tool_use——扫描时维护 pending 工具 id 集合，清零处即安全）；每个候选标注 `roundBoundary: boolean`（是否轮边界）。
  - `estimateFoldResidue(msgs)`：头部折叠残留估算，对齐引擎行为——对话文本字符 + 连续工具块合一注记（每调用摘要 ≤240 字符、同名去重、注记固定开销）。
  - `ratioToCut(messages, preambleCharCount, ratio)`：在安全候选中取满足 `前言 + 残留(头) + 原样(尾) ≤ ratio × 总长` 的最大保留区；两级优先（轮边界候选 → 全部候选）。候选先做**帕累托过滤**（头→尾扫维护 runningMin，kept ≥ 已见最小保留的候选剔除）：折叠残留随切割量增长会催生「切得更多反而保留不减」的坏切点（微型工具对折叠注记反超原样体积、切到轮头反而更长），未过滤时比例增大瞬间轮边界优先会把切点拉到更靠下的坏轮头（视觉下移）；过滤后 kept 关于 cutIndex 严格递减，切点随比例单调上移。连最小保留都无法达标时返回链尾（kept 最小候选）并标记 `unmet: true`。
  - `cutToRatio(messages, preambleCharCount, cutIndex)`：反向换算（点击设切点后回写滑动条）。
- 测试：`test/trim-ratio-core.test.js`——孤儿对不产生、轮边界优先、残留估算随切点单调、比例↔切点往返一致、单轮巨上下文场景（切点落入轮内）、极端比例（5% / 95%）、切点随比例单调上移（坏轮头被帕累托过滤）。

### PR-3 统一精简页面

- `public/index.html`：`#trim-dialog` 替换为 `#trim-page`（overlay 沿用 `trim-dialog / trim-overlay / trim-panel` 三层；panel 内改为左右 grid：左 `1fr`、右 `240px`）。
- 新模块 `public/src/modules/trim-page.js`：`window.openTrimPage(agentId, sessionId, archiveAfter)`。
  - 数据：打开时拉一次 `session_trim_preview`；比例模式全部用 `TrimRatioCore` 本地重算。
  - 左栏：轮分组卡片 → 消息行（工具调用折叠行、行内展开明细）；切线注记条；线以上整体淡化 + 折叠开关；消息行 hover 提供「设为切点」。
  - 右栏：模式切换（按轮次默认）、滑动条 + 数值框双向绑定（范围 5–95、步进 1）、生成摘要（默认不勾）、归档原会话（入口预置）、保留最近技能调用步进器、实时读数块、确认/取消。
  - 按轮次模式：逐轮勾选（非连续）+「精简到此处」；读数复用同一读数块（按勾选集合计算）。
  - 提交编排：从 `session-dialogs.js` `submitTrimCompact` **原样迁移**（navGuard / `markSessionArchivedForMutation` 回滚 / sidebar operation 状态机 / 远程分支切换），不重写逻辑。比例模式 policy = `{ preservedMsgRanges: [[cutIndex, lastMessageIndex]], keepRecentSkillInvokes }`（不发 `preservedTurns`）；按轮次模式 policy 与现状一致。
  - localStorage：`claw.trimPage.ratio` 记住上次比例值。
- CSS：`components.css` 新增 `.trim-page-*` 系列，复用既有视觉配方（卡片参照模型配置窗 `.ph-settings-window`，分页器参照 `.usage-info-segment`，控件沿用现 `.trim-*`），不新造同类控件。
- i18n：模块内 `currentLanguage === 'zh'` 双语，模式同 `ctx-menu-items.js`。

### PR-4 入口切换、旧对话框删除、兼容收口

- `ctx-menu-items.js`：两处 trim action（runtime 叶子与会话条目菜单）改调 `window.openTrimPage`。
- `session-dialogs.js` 删除 trim 相关代码（`openTrimDialog / submitTrimCompact / trimDialogState` 及事件绑定），branch 部分保留；`index.html` 删 `#trim-dialog` 块；`.trim-*` 共用 CSS 保留。
- 远程兼容：预览响应无 `messages` 字段（旧远程端）时，比例模式置灰并提示「远程端版本过旧，暂不支持比例精简」，按轮次模式照常（`rounds` 兼容字段仍在）。
- 自检：`/trim` slash、摘要/分支入口、assembly 会话排除、已归档会话平铺菜单均不受影响。

## 4. 负面清单（本计划不做）

- 不改摘要 / 分支的入口、对话框与流程。
- 不改精简引擎、框架、`compact_and_resume` 协议。
- 不加「彻底删除头部」开关与骨架模式。
- 不接入上下文护栏「建议精简」提示入口。
- 不做比例的全局设置项（只做 localStorage 记忆，看使用反馈再议）。

## 5. 验收清单

- [ ] `npm run test:file -- test/session-helpers-pure.test.js`、`npm run test:file -- test/trim-ratio-core.test.js` 全绿；`npm test` 无回归。
- [ ] 重启 Claw 服务后：右键「仅精简」「精简并归档」均打开统一页面，归档勾选预置正确。
- [ ] 滑动条拖动、数值输入、点击设切点三者联动，读数即时更新且标注「估算」。
- [ ] 单轮巨上下文会话：切点落入轮内，原始指令保留在结果会话中（对话文本不丢）。
- [ ] 按轮次模式非连续勾选 + 摘要 + 归档组合提交成功，后继会话内容符合预期。
- [ ] 旧对话框不再出现；分支对话框不受影响。
- [ ] 远程会话：新远程端功能正常；旧远程端比例模式置灰提示、按轮次模式可用。

## 6. 风险与备注

- **读数为估算**：折叠残留按引擎规则估算，与引擎产物非字节一致；UI 明示「估算」。
- **提交编排迁移**：`submitTrimCompact` 的导航/回滚/侧栏状态机逻辑原样搬移，回归重点是归档失败回滚与远程 trim 切换两条路径。
- **生效方式**：前端 CSS / JS 改动需重启 Claw 服务（项目约定，经 server 重新 serve）。
- **性能**：消息级预览payload大于轮级，长会话（数千消息）下左栏渲染需要虚拟滚动评估——首版先以折叠默认态 + 分批渲染兜底，超出预期再引入虚拟列表。
