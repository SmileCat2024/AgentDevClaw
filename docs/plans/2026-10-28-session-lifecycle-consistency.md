# 运行中对话的生命周期一致性

## 目标与分层

关闭、归档、删除、接续和分支共用执行收敛及快照契约，不共用同一个业务动作。Thread 管成员关系、head、Inbox 和归档；Session 管持久内容；Runtime 管执行及资源。沿用 ADR-0002、0026、0032，不增加另一套线程状态机或持久化引擎，不实施 Proposed ADR-0033。

框架提供停止接收调用并等待执行收敛、保留上下文供最终保存的生命周期阶段；dispose 复用该阶段后释放资源。保存按实例串行，不能有旧快照覆盖最终快照。Claw CallArbiter 同步封闭新输入及续跑，等待当前 envelope 与完成回调。宿主等待在途状态请求和保存，最后保存，再 dispose；共享和独立进程均通过 session-scoped IPC 确认，不把 SIGTERM 发送成功当成停止完成。

## 操作契约

| 动作 | 共同能力与业务提交 |
| --- | --- |
| 关闭 Runtime | 封闭输入、取消当前轮及运行时队列、收敛并保存、释放资源；保留 Session/Thread，不把关闭当归档 |
| 归档 | Thread 先 seal 阻止派发并取消 pending；普通 Session 由服务端完成停止与索引归档，不依赖浏览器补停 |
| 删除 | 先封闭输入并确认 Runtime 收敛；停止失败不得删除 Session/Board 等数据。停止成功后清理；部分失败明确保留重试入口 |
| 手动/自动接续 | 共用旧 head 保存确认；失败不读旧快照继续变换；手动不播种续跑指令，自动播种 |
| 分支 | 原对话继续执行，只允许从可证明的完整边界复制；消息与 Feature 状态同一边界。分支预览绑定内容摘要，提交校验，不静默截取变化后的内容 |

关闭不会撤销已经发生的文件/API 副作用；后台资源按 Feature 的既有 onDestroy 生命周期释放。不可中断的资源不通过强杀共享进程伪造完成。错误应明确停留在失败/未确认状态。

## 实施与验收

1. 框架生命周期与保存顺序：活动调用、排队调用、失败保存、并发 dispose、最终快照、释放顺序。
2. 宿主收敛：CallArbiter 停止接收、禁止续跑/补投；状态变更请求完成后最终保存；真实 session-exited 回执。
3. 服务端接入：普通 Session 删除先停后删，线程清理不得越过失败停止，归档和接续共享同一停止确认。
4. 分支边界与前端：不可证明的末轮拒绝、历史完整轮允许、Feature/消息一致、预览过期明确拒绝。
5. 组合验证包含真实生产模块与可控异步进程边界，不只测试 stub 返回成功。保留已有调用协议必要部分，删除被替换的前端业务补停。

实施中不重启用户正在使用的服务，不操作真实用户会话；构建、隔离测试完成后说明生效要求。

## 实施状态与入口

- 框架 `packages/core/src/core/agent.ts`：`quiesce()` 永久关闭调用入口，等待活动调用及排队保存，保留 Context/Feature 供最终保存；`saveSession()` 串行化捕获与写入。运行快照增加可选 `callState`，旧快照不伪造结束事实。
- Claw `server/call-arbiter.js`、`scripts/run-prebuilt-agent.js`：关闭排队与续跑，等待完成回调和已接收的状态请求，最终保存后释放实例；关闭回执发送完成后才退出最后一个 Session 的进程。
- `server/routes/agent-lifecycle.js`、`agent-startup.js`：共享与独立进程共用 Session 回执；启动时常驻监听提前到达的关闭回执。进程退出但无回执明确失败，不再以快照时间接近推断最终保存成功。IPC 发送失败不冒充运行时已退役。
- `server/shared/session-operation.js`：宿主侧短期操作互斥，覆盖启动、普通归档/删除和线程成员清理期间的写入者替换窗口。线程持久状态仍由现有 Thread 模块持有；启动资格由 `thread-integration.assertSessionStartable` 读取既有归档、删除和接续事实。普通归档后需恢复才能启动；已删除 Session 不允许直接重新启动。
- `server/routes/session.js`：普通删除先停后删，归档及归档替换由服务端停止；手动线程接续停止失败不继续变换。前端 `reconcileArchivedSourceRuntime` 只更新投影，不再补发停止请求。
- `server/routes/session-branch.js`：使用匹配消息边界的增量/旧版检查点，或已结束的完整快照；不再拿分支前一轮的 Feature 状态搭配后一轮消息。预览响应与前端提交携带 `snapshotRevision`；旧调用方不传 revision 时仍执行边界验证。不能证明结束的运行中旧版快照末尾拒绝分支。

## 验证记录（2026-10-28）

- 生命周期相关定向回归：240 项通过，含真实共享宿主 IPC、真实 Session 文件回读、失败保留数据、提前回执、互斥与启动资格。日志：`.agentdev/temp/lifecycle-regression.log`。
- 框架生命周期定向测试 5 项通过，core 类型检查和构建通过；Claw local-features 构建通过。
- 所检查改动文件 ESLint：0 errors，22 warnings；import cycles：0 新增环；两个仓库 `git diff --check` 通过。
- 扩展检查没有全绿：Claw core 最新全量 22 项失败（5138 通过、4 跳过）；其中线程事件关联测试未返回异步上报 Promise，已对齐生产宿主回调契约并在定向回归中通过，修正后尚未再跑全量（`.agentdev/temp/lifecycle-core-final.log`）；Feature 全量 3 项失败（`lifecycle-features.log`）；框架 core 全量 2 项失败。已观察到标注渲染 VM 夹具缺 `scheduleReplay/window`、内存采样文件轮转断言、默认模型名称依赖配置、项目 UI 断言、Windows symlink 权限、定时/压力测试超时。监视删除与 SSE 两项全量失败在单独运行时通过，仍保留偶发失败记录，不以重跑代替归因。这些失败尚未全部完成基线对照，不宣称与本次改动全部无关。
- 尚未在用户服务上重启或验收。框架与 local-features 产物已构建；全部链路生效仍需在安全时机重启整个 Claw 服务。

## 侧栏关闭链路验收

停止保存完成不等于侧栏呈现已收敛。补充调查通过真实投影复现了两条重现路径：线程列表仍保留旧的 `headRuntimeRunning/lifeState` 时，运行时列表退场后又合成断连叶子；服务端排除 stopping 却未排除 stopped，Viewer 连接缓存滞后时，已关闭实例被重新分类成 viewer-only child。

实现沿既有权威关系收敛：托管运行时存活事实决定侧栏叶子，查询发布前复核异步读取期间的停止；线程只在明确接续/启动操作期间占位，不凭独立运行观察重建叶子。关闭回执后的刷新推进既有 mutation epoch，等待旧请求结束后补取新快照；删除固定等待和关闭隐藏 TTL，刷新失败不撤销已确认的关闭。按实例隐藏不影响同一 Session 后续启动的新实例。线程侧栏统一消费 `get_connected_agents` 中的运行时与 `sidebar_threads`，不再与独立线程轮询拼帧。`sidebar-snapshot.js` 对读取前后的线程呈现事实及 Runtime 身份/存活状态做一致性校验；变化时重读，持续变化明确拒绝本次读取，前端保留上一份完整列表。已 READY 的托管 successor 即使晚于 Viewer 列表注册也会被补入，因此接续挡板到新 head 在同一响应中交接，不再存在由两份前端快照错位造成的空帧。接续占位不靠前端 TTL；Thread SSE 触发同一快照读取。所有宿主按线程 `agentId` 归属处理，无 PH/Coder/Memo 特判。

验证：

- 相关回归最新 335 项通过（`.agentdev/temp/thread-projection-regression.log`）。`sidebar-thread-snapshot.test.js` 通过真实聚合→真实侧栏投影，分别验证 programming-helper、coder、memo、自定义宿主：接续前/中/提交、查询跨越提交、READY successor 不在 Viewer 快照、失败清挡板、归档并发、重新启动、冷缓存关闭及独立线程缓存错误。旧轮询失效、失败读取保留完整帧、新实例不误隐藏、关闭失败恢复可见均纳入回归。
- `test/ph-project-restart-runtime.mjs` 隔离浏览器验证通过：真实 Viewer、共享子进程、停止 HTTP、浏览器动作与侧栏渲染；关闭后连续刷新及页面重载不复活，兄弟 Session 保持可见。Windows 使用独立 named pipe，浏览器通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向本机 Edge。日志 `.agentdev/temp/sidebar-close-browser.log`。初次运行发现 fixture 的 Unix socket 路径不适用 Windows、Playwright 默认浏览器未安装、关闭导航 stub 缺失，已分别修正夹具与指定现有浏览器，不涉及用户服务。
- 同一浏览器脚本通过 `SIDEBAR_TEST_HOST=coder` 验证 Coder 的真实宿主寻址与独立进程，通过默认配置验证 PH 共享进程；接续使用真实 WorkThread begin/advance 与真实 successor 启动，侧栏每阶段单叶子，关闭后反复轮询/重载不复活，兄弟会话仍可见。日志 `thread-projection-browser.log`、`thread-projection-coder-browser.log`。没有调用实际模型。曾有一次浏览器测试耗时约 34s；加阶段探针后未复现，head 提交 114ms、关闭 258ms，后续完整运行恢复约 4s；原因尚未证实，保留偶发慢记录，临时探针已删除。
- 扩展前端/侧栏/线程回归 1998 项中 19 项失败：3 项侧栏夹具仍把线程放在旧独立缓存，已改为同响应字段并保留原单叶子断言，纳入上述通过回归；另 16 项在聊天渲染中因 `ClawAnnotations.scheduleReplay` 缺失失败，不在本轮改动路径，未修改，未完成独立基线对照（`thread-projection-expanded.log`）。不宣称扩展检查全绿。
- `git diff --check` 通过，import cycles 为 0。最新统一投影涉及文件 ESLint 0 errors / 9 warnings（`thread-projection-lint.log`）；此前关闭菜单检查保留 HEAD 已存在的 `_resolveCtxThread` switch 声明错误。本轮未重跑项目全量测试。

