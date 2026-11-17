# P2 迁移：重启暂停交接

> 历史交接记录：下文为暂停及恢复期间快照，不再代表当前待办。当前实现、保留边界与最终验证以 [P2 交付记录](2026-11-17-frontend-esm-p2-acceptance.md) 为准；不要据本记录恢复旧工单。

暂停时间：2026-11-17 07:06 UTC。用户明确要求先终止、收拾现有任务，系统重启后继续。

## 2026-11-17 重启后接续状态（优先于下面暂停快照）

用户已要求继续 P2；HEAD 仍为 `c3e18d71`，原工作树保留，未恢复补丁。当前主助手寻址 `programming-helper/session-1794900884741-1bde56`。

### 10:09 UTC 验收更新

以下覆盖后面的派发时状态，相关四个实现线程均已验收归档：

- 输入返修 `wt-531d7149…`：主助手十四文件 **200/200、exit 0**。四个 choice 跨文件键具名导出；三处散装 window 面统一桥；ClawToast/poll 显式 import；choice 草稿模块私有且旧 host 已删；回退私有 400ms/30s 时序用 mock 时钟测，不再导出测试时间参数。
- 小 debug `wt-abd147d2…`：logs 保唯一 classic，mcp/preflight ESM；日志写函数 `setCurrentLogs` 搬到唯一同步 app-core 实现，overview-data 删除重复实现/桥。主助手六文件 **61/61**、隔离 Chromium 八项零错误通过；无效 browser executable 的失败清理也由主助手验证，exit 1 且无挂起。
- 深 debug `wt-496588a9…`：features-hooks 保 classic，overview ESM；active/aria-selected/节点身份原断言恢复。主助手六文件 **79/79**；严格版浏览器原样真实 index，模块前 hooks/inspector 与放行后共存均通过，pageerror/console error/unknownRequests 全空（日志 `.agentdev/temp/bg-output-20261117-100824-n51k8z.log`）。无错误过滤/无手工 import 注入生产接线。
- 入口 `wt-45633925…`：删 overview/mcp/preflight 三个 classic 标签，保 logs/features-hooks；两 debug bootstrap 经 p2-entry 进入图，choice/model 接线完成。主助手启动链+script gate **13/13** 与真实 index 主链、延迟模块七个 rail 点击全部 PASS（`.agentdev/temp/bg-output-20261117-100858-ts9fug.log`）。此为静态 HTTP 契约 mock，不覆盖真实 Claw/UDS。

仍在执行且不要巡查：撤桥补齐线程 `wt-efea8504…`；只读残余边界线程 `wt-58cfdca8-80d2-438f-9c17-b774850d8e2a`（指令 `p2-residual-action-thread-boundary-01`，commandId `cmd-740415d2-4dbb-4cd6-9cf1-98041e817233`）。后者给 workspace-actions/thread-store 的真实可迁主体与同步边界工单，不实施。它们交付后再审，必要范围仍需实现，不得因整页冒烟通过就宣布 P2 完成。全量 core、最终桥债基线与文档/成组本地提交尚未完成。


- PH 浏览器返修由主助手复跑 exit 0（`test/ph-project-browser-check.mjs`，日志 `.agentdev/temp/bg-output-20261117-094413-rs70qw.log`），原线程维持归档；单条移动经公开 ESM 导出，未覆盖菜单 DOM 点击的已知边界仍在。
- 缓存私有化新批 `wt-c930b418-9c83-45e2-a8a9-e3874dbb68d7` 已验收归档：模型/语音四个 ClawFW 缓存袋键移模块私有，无镜像；撤两条纯 ESM model 缓存函数桥，保留五个命名导出。主助手复跑七文件 **131/131、fail 0、exit 0**，保留引用身份/会话失效/失败语义。尚未单独提交。
- debug 已独立两轴交付后审核（规范 `wt-7a310b06…`、行为 `wt-4b62a729…`，均已归档）。Chromium 真实实验**证伪**“rail 点击晚于 ESM”：模块未求值时 logs/hooks/inspector 可见可点，抛 ReferenceError，HEAD 正常。必须保留真实早期入口的闭合依赖唯一 classic 实现，不允许加守卫跳过、隐藏按钮、ready 队列、延后注册或放行补画。若整文件保留，不能计作已迁完成。详情 `.agentdev/temp/p2-debug-spec-review.txt`。
- 输入独立交付后审核完成并归档，报告 `.agentdev/temp/p2-input-review.txt`：D4 主体成立，但需补 choice 命名导出/统一桥、ClawToast/poll 显式 import、去测试专用时间 API，并将唯一 choice 草稿状态私有化。
- 撤桥批第一次续做交付 61 键撤除与六散装函数治理；独立审核 `wt-1fadda06…` 已完成归档，报告 `.agentdev/temp/p2-bridge-review.txt`。真实消费归零及 PH 环顶层无互读成立，但五条纯 ESM window 依赖仍未收敛，已向原可运行线程继续返修。

### 正在执行的五个任务（互不重叠范围，交付后审核）

| 任务 | 当前线程 | 本次指令 |
|---|---|---|
| 撤桥补齐五个 ESM 依赖与报告纠错 | `wt-efea8504-ec25-4922-99de-0deaebc6d45b` | `p2-bridge-review-fix-02`，delivered=1 |
| 输入返修与 choice 草稿私有化 | `wt-531d7149-2dd4-44e7-b35a-ecacd2748984` | `p2-input-fix-replacement-01`，delivered=1 |
| debug 小批同步边界返修 | `wt-abd147d2-47c7-4493-a401-e8375f9dff22` | `p2-debug-small-fix-replacement-01`，delivered=1 |
| debug 深批同步边界与断言返修 | `wt-496588a9-2061-40ca-b1a6-79b634058bc6` | `p2-debug-deep-fix-replacement-01`，delivered=1 |
| 确定的输入入口接线与浏览器回归 | `wt-45633925-85b2-44f6-889b-d147e2f77d24` | `p2-entry-replacement-01`，delivered=1 |

四个替换线程的原因：旧输入/小debug/深debug/入口线程 unarchive 后 runtime 虽 connected/inputAccepted，但 command 持续 `runtime_not_accepting_input`；原指令 **attempts=0、pending，未运行**。尝试正式的 session 级 start/restart 后仍拒收，未改服务/框架代码或绕过 fencing。旧线程已重新归档，核对 **0 pending** 后才建立替代线程，不会双重施工。旧指令与会话仍可只读追溯。撤桥原线程可接受新指令，未替换。

入口新 owner 仅接 choice/model，**不提前整合 debug**，不等待/监视正在返修的模块；中间页面或 gate 红如实报告。debug 返修验收后再由主助手串行派最终接线。所有 owner 禁改基线/后端/CSS/他人工件，禁止全量 build/core 与共享文件变异；稳定树最终统一验证，不能把禁令下未跑变异当作缺陷要求其执行。

后续仍需：返修交付审核 → 剩余可迁域边界复核 → 最终入口与延迟模块真实交互 → 稳定树全量/门禁/必要变异 → 基线修剪与文档 → 已授权的有意义本地组合提交，不推送。`_chatLoadingTimeout` 保留理由审计发现无生产 classic 读，真实阻断为测试 helper/浏览器夹具；后续需统一处理（当前撤桥 owner 禁改 app-core，避免输入 owner 冲突）。


## 当前安全状态

- 本次 P2 相关七个未收口 Coder 线程全部已归档；执行中的撤桥任务已被中断。归档是暂停手段，**不是验收通过**。
- 主助手无运行中的后台 Bash 任务。未关闭正式 Claw 服务，未停止其他会话的 runtime 或来源不明进程。
- 未 reset、clean、checkout 覆盖或 stash 工作树；已有修改与新增源码完整保留。不为暂停而提交未验收业务代码，无本次 push。
- HEAD：`c3e18d71`；之前已提交 `56836cd0`（真实 ESM 隔离测试工具）和 `c3e18d71`（同步 bootstrap 状态消费接口）。其余迁移仍未提交。
- 暂停时 `git diff --check` 无输出。页面当前**不能视为可运行**：多个已转 ESM 文件还保留 classic 标签，统一生产接线未收口。

## 重启后首先阅读

1. `docs/plans/2026-11-16-frontend-esm-strangler-migration.md` §P2、`docs/plans/esm-migration-playbook.md`、ADR-0051。
2. 本交接文档与下列报告；随后重新核对 Git 状态/相关源码，不直接重放历史补丁。
3. 用户执行约定：大规模派 Coder；运行中静默等待，不巡查或干预（明显问题除外）；**交付后审核**，必要时原线程返修；已完成验收线程及时归档。提交按完整有意义组合，不按工单碎拆；未授权 push。

## 线程寻址与暂停状态

以下均已归档。需要继续原实现时先 `unarchive <threadId>`，再发送新的明确接续指令；不是重新发送旧工单。只需审核时直接 `result` 即可，无需启动 runtime。

| 任务 | threadId | 暂停前事实 / 下一步 |
|---|---|---|
| 冗余桥注销、ESM window 消费改 import、散装函数桥治理 | `wt-efea8504-ec25-4922-99de-0deaebc6d45b` | **执行中被中断，尚无完整交付**；已改多处源码/测试，必须先核对现有改动与原工单再续做，不覆盖他人工作 |
| choice-input / input-actions / rollback 尾批 | `wt-c416e905-28cf-4228-af25-a79aa59746b9` | 已交付，Coder 称171项通过，**主助手尚未验收**。新增 input-actions、chat-process-visibility、rollback-dialog-runtime；input-helpers 与 rollback-dialog 保留同步 classic 薄壳 |
| debug-logs / debug-preflight / debug-mcp | `wt-517b86e6-45c6-4868-ba65-79332e7accbd` | 已交付未主助手验收；新增 p2-debug-small-bootstrap；需复核解析相 rail 按钮能提前打开面板，报告“rail点击不会早于ESM”不应直接采信 |
| debug-overview / debug-features-hooks | `wt-f9b699b2-070d-44f1-a20e-528bb7c89f5b` | 已交付未主助手验收；新增 p2-w2-11-debug-deep-bootstrap；Coder 称66项定向通过 |
| 残余 classic 时序边界只读复核 | `wt-afb166d5-476e-40ce-a532-83645b82d622` | 第二轮修订报告已交付，未改仓库；部分判断仍需主助手审查，见下节 |
| PH 项目浏览器回归 | `wt-92e4bbb7-0e73-43f6-8670-65ceacb7084e` | 主助手首跑因 window.phOpenSessionMoveDialog 已撤桥而失败；Coder返修改真实ESM调用并收资源清理，称连续3次PASS；**主助手未复验返修版** |
| 生产加载入口与生产浏览器检查 | `wt-de177164-6558-4425-9296-91ebc0bee0ed` | 接线初版交付；boot-chain主助手3/3通过；browser check的600ms等待、桥数量阈值、启动失败资源泄漏已返修并代码审核，但整体验证仍被在飞模块未接线阻塞 |

已验收模型切换器线程 `wt-ebebacbc-07e5-4b8a-a5a1-b7181ef1f70e` 已归档：主助手108项通过。返修保留点击时失败提示语言、异步结束后菜单语言读取点，TDZ遮蔽错误修正；不需再派重复实现。

## 已保存报告和备份

均在仓库 `.agentdev/temp/`，不依赖 /tmp 在重启后仍存在：

- `p2-restart-input-actions-report.txt`
- `p2-restart-debug-small-report.txt`
- `p2-restart-debug-deep-report.txt`
- `p2-restart-ph-browser-report.txt`
- `p2-restart-bridge-report.txt`（中断任务，仅有早期回复，不代表没有代码改动）
- `p2-restart-boundary-report.txt`
- `p2-restart-git-status.txt`
- `p2-restart-tracked.patch`（全部 tracked 工作树差异，可能包含其他会话改动；**不要盲目apply**）
- `p2-restart-untracked-source.tar.gz`（public/test/docs 下未跟踪源码备份）
- `p2-restart-audit-artifacts.tar.gz`（此前 /tmp/p2audit、/tmp/p2r 的只读分析产物）
- `p2-restart-diff-check.txt`（暂停时为空）

原始对话可按线程/会话历史恢复。此前主助手上下文：programming-helper/session-1794898061799-e18514 与 session-1794896330455-a43bd1；Coder交付会话以各thread的result为准。

## 生产接线待办

入口为 `kernel-entry.js → p2-entry.js`。接线初版删除69条 classic 标签，但后续尾批尚未整合：

- 删除 `choice-input.js` 与 `input-model-switcher.js` classic 标签；choice已由 p2-w2-3b-input-bootstrap 导入，model需在p2-entry显式import。
- 删除五个debug文件 classic标签；导入 `p2-debug-small-bootstrap.js` 和 `p2-w2-11-debug-deep-bootstrap.js`。
- 保留 input-helpers、rollback-dialog 的同步 classic薄壳。
- 同步p2-entry头注过时的保留文件清单；对应过时test头注也需更新。
- 接线后运行script-tags gate、生产浏览器启动检查、输入/模型/项目交互与首屏延迟回归。不能只凭定向测试通过当作页面可用。

## 审核关键问题与剩余范围

- 桥债gate仍红：旧基线109个静态defineKey调用/33个claim；当前树持续变化且循环注册产生更多真实键。**不得直接上调掩盖冗余桥**。先撤无消费/纯ESM消费桥，审查真实必要增量，分别报告新增、注销、净值、真实键数与静态调用点。
- 撤桥会让“为桥而测”的既有测试失败，应同批改真实导出/行为断言；不恢复冗余window桥迁就测试。还需检查散装window直挂函数是否按配方治理。
- debug尾批的解析相rail点击属于真实事件入口，不因没有顶层调用就自动可迁。已在只读审计中发现todo-plan提前点击会ReferenceError；所有新迁debug需单独核对，不采信“点击一定晚于ESM”。
- input-actions交付仍报告ClawToast等已ESM能力走window、choice整域零命名导出且保留散装window API：需对配方和真实协议逐项审查，不能仅测试绿就验收。
- chat-scroll保留classic：focus/visibilitychange监听可在模块前触发，不能推迟、不能导出9个零消费私有键来伪装迁移完成。
- model/speech cache物理状态还在ClawFW；只读复核更正为可直接模块私有化（无需镜像），唯一额外生产写点为fw-config-panel占位；此批**尚未派发**。测试需移除直接ClawFW属性读写，改owner接口。
- thread-store/workspace-actions尚未迁。审计建议可迁，但thread-store定时器和visibilitychange时点“相对2s无实质影响”仍是未经接受的行为变化，不据此直接放行。workspace-actions需核对早期可点动作与必要桥消费。
- right-panel-registry别名退役为可选工作，不能无说明扩大本次范围。
- 真同步bootstrap与外部一次性入口（desktop-open、desktop-notify）、bg/genui同步注册、input-render等保留唯一classic实现；不加ready队列、补画或静默降级改变行为。

## 验证事实与恢复顺序

已知主助手通过：两波主体及跨批测试若干批（历史有266项、198项等，范围交叉不能相加）；model108项；boot-chain3项。**没有最终全量绿或完整生产浏览器验收**。

各Coder全量自报多轮失败数波动、甚至挂起，不能仅凭装载面grep认定“不是本批”。最终应在停止并行写入后的稳定树复跑，区分迁移相关/已有/环境并处理任务相关失败。inline-events、bridge-debt、script-tags此前均有红态。

重启后建议：
1. 核对本文件、git状态、原线程报告与相关最新代码；不自动恢复补丁/清理未知工作。
2. 对已交付输入/debug/PH批做交付后审核及定向复跑；问题沿原线程返修。
3. unarchive撤桥任务，按当前差异续做并验收；其原授权范围可从原会话T0读回。
4. 完成必要cache私有化与其它经证实可迁单元，明确真实同步保留边界，不擅自缩P2。
5. 串行整合生产加载入口，运行全量测试/门禁/真实隔离浏览器，修剪基线与文档。
6. 用户已授权逐步本地提交：按有意义、可运行、已验收组合提交；未授权推送。

暂停后不继续派工或验证，等用户在重启后明确继续。
