# 会话身份链路排查与修复

日期：2026-10-26

范围：编程小助手的项目/目录归属、共享进程重启、线程接续和侧栏投影。以 ADR-0010、ADR-0026、ADR-0032 的身份边界为依据。

## 结论

问题不只在侧栏重绘。持久会话 ID 在重启前后不变，但运行实例会被替换；旧实例异步收尾仍按会话 ID 查表，能够关闭已经注册的新实例。另有就绪接口漏字段、前端请求采用过期身份、宿主异步快照混合两个会话及线程归并猜测，使项目对话显示为目录、消失或重复。

下述修复均在本地工作树。隔离集成验证通过不等于当前运行服务已加载全部修改；服务端模块需要重启服务，runtime 脚本需要重启对应实例，前端需要重新加载脚本。未修改真实用户会话的项目归属，没有按目录反推项目 ID。

## 已确认并修复

| 触发条件 | 违反的行为 | 修复边界与回归证据 |
|---|---|---|
| 线程条目第一次按目录分组，之后收到正确项目字段 | 缓存分组覆盖新快照，只能刷新纠正 | live head 重新解析归属，缓存只保留排序锚与空窗形状；真实侧栏 HTML 回归 |
| 重启窗口只有宿主运行时，项目会话不在首页分页 | 合成条目缺项目 ID，宿主字段变化也不触发重绘 | 宿主透传项目/目录，加入渲染签名；分页缺席场景回归 |
| 创建、恢复等路径消费 `runtime_status` | 就绪条目省略项目 ID、目录及侧栏所属工作空间 | 就绪、启动、重启共用 `buildChildRuntimeAgent`；真实 HTTP 就绪响应先失败、修复后通过 |
| 点击 child 的重启菜单，缓存目录会话与点击目标不同 | 请求重启缓存会话而非点击的会话 | 显式 `sessionId` 优先；真实动作函数请求边界先失败、修复后通过 |
| 共享进程内重启挂载 UserInputFeature 的会话 | 旧输入 lease 被取消后，旧循环延迟退出，按同 ID 关闭新实例 | 主动销毁不重试输入；输入循环关闭必须匹配原 SessionLifecycle 实例。Chromium 点击重启、跨越原 500ms 收尾边界后检查 Viewer 存活、项目归属和两个会话的输入 lease；缺陷版本新实例消失 |
| 查询元数据期间主运行时从项目会话切到目录会话 | 返回新会话 ID，却带旧项目字段 | 切换完整会话字段投影，child 不再进入宿主状态覆盖循环；受控异步切换先失败、修复后通过 |
| 一个线程接续时另建无关会话 | 未知会话被任意接续线程吞并 | `source_session_id` 从索引经 discovery/wire 透传，仅按来源 head 关联；分支携带旧精简元数据时不视为原祖先的后继。无关会话可见性先失败、修复后通过 |
| 接续中途刷新，页面无线程条目缓存 | 占位缺项目归属 | 线程列表携带 `headProjectId`，与目录一起用于冷启动占位、加入签名；项目分组 HTML 先失败、修复后通过 |
| 宿主已知 head runtime，child 查询暂时缺席 | 线程占位和宿主合成运行条目各占一行 | child 与宿主合成条目统一经过线程成员过滤、缓存与锚定；单条目回归先失败、修复后通过 |

## 排查覆盖与边界

- **创建、分支、精简派生**：检查来源索引继承 `projectId` / `workspaceAgentId`、项目与目录同路径隔离、显式非法项目报错；运行既有项目会话生命周期回归。没有增加按工作空间当前选择补归属的路径。
- **保存与恢复**：核对 `session_meta_sync` 只合并活动元数据，保留项目归属；索引独立重读、discovery 与 connected 投影回读已有覆盖。
- **启动与 IPC**：检查注册前 runtime-identity 握手、共享 add/remove-session 与 READY、退出后释放、会话作用域寻址；真实 Viewer 与共享子进程验证。`runtime-identity-accepted` 还会被通用 IPC 分派器打印缺目标告警，但专用握手监听器已消费它；未把该告警认定为身份丢失根因，也未顺带修改协议。
- **线程与前端**：检查 head 成员过滤、未提交 successor、冷缓存占位、宿主合成、项目改名与转移、轮询合并和渲染去重。接续前 successor 归属改为来源事实，不再以“同工作空间存在挡板”推断。
- **真实环境**：只读观察到项目索引仍有项目 ID，而旧现场 Viewer 缺新实例；隔离环境复现的旧循环误关行为与此相符，但不能据此断言现场每次错误都只有这一个原因。

## 验证方法

相关回归：

```bash
node --test test/agent-lifecycle.test.js test/ph-project-frontend-projection.test.js \
  test/frontend-thread-succession-sidebar.test.js test/frontend-runtime-status.test.js \
  test/thread-routes-command-fields.test.js test/ph-project-session-lifecycle.test.js \
  test/ph-project-restart-runtime.mjs test/frontend-ctx-menu-items.test.js \
  test/session-helpers-pure.test.js test/ph-project-session-move.test.js \
  test/ph-project-rebind-retirement.test.js test/frontend-sidebar-freshness.test.js \
  test/remote-sidebar-projection.test.js test/frontend-sidebar-layout.test.js \
  test/frontend-thread-badge-residency.test.js test/workspace-agents-runtime.test.js
```

结果：431 项通过。浏览器脚本需要已安装的 Playwright Chromium，可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定现有可执行文件。脚本隔离数据目录、HTTP 端口和 Unix socket，不调用真实模型；兄弟会话及新实例的输入 lease 是就绪检查的观察点，不只检查页面存在。

`npm run test:core` 未全绿：21 项失败。在 `ff2477f` 的隔离归档副本中重跑失败文件，失败位置和名称完全相同。失败涉及 desktop-workspace、frontend-chat-render-signature、frontend-rollback-edit-buttons-race、ph-project-selector-ui、process-group、session-ui-context、thread-control；不将基线失败表述为通过。

`npm run check:cycles` 与 `git diff --check` 通过。修改文件的语法检查通过。ESLint 在 `ctx-menu-items.js` 报已有 `no-case-declarations` 错误，已对 HEAD 同文件复查得到同一错误；未扩大范围清理。

## 测试隔离事故

早期两次集成试跑隔离了 HTTP 端口和数据目录，但没有隔离 Viewer socket，测试进程占用了默认路径，退出后导致现有服务的新运行时连接被拒绝。该副作用来自测试操作，不作为产品缺陷。随后脚本固定使用临时目录内的 `AGENTDEV_UDS_PATH`。后续只读探测确认服务 PID 已变化、默认 socket 恢复可达；本次排查没有自行执行生产服务重启。

## 仍未完成的验收

- 当前真实用户环境在加载全部最新修改后，再次执行重启并确认持续存活。隔离验证没有替用户终止正在运行的真实会话。
- 未逐一运行全部模型、MCP、远程 Claw 或桌面安装包环境；远程侧栏验证只覆盖既有投影回归。
- 本报告不声称穷尽所有会话并发缺陷；已确认的问题有对应失败与修复证据，代码审阅未发现额外问题的部分仅代表本次排查范围。
