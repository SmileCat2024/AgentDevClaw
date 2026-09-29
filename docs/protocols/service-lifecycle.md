# Claw 服务生命周期契约

本文定义 Claw 服务进程的启动就绪、健康探测和有序关闭语义。桌面宿主及开发启动器可依赖该契约；它不替代 Agent runtime 自己的就绪状态。

## 宿主与进程边界

`npm start` 不再直接运行 server.js，而是经宿主（[scripts/run-supervised.js](../../scripts/run-supervised.js)）托管：

```
npm start → supervisor（启动与诊断）→ node server.js（服务）
```

supervisor 只负责启动 server、记录日志和只读健康探测，不拥有终止 server 或其子进程的权限。探测超时、父进程消失、启动端口被占用都不能触发关停或进程树收割。服务只响应明确的用户退出请求或操作系统直接发给服务的关闭信号；有序关闭只清理服务自己管理的 Agent/runtime 子进程。

1. **显式退出**：用户从 UI 选择退出时调用 `POST /protoclaw/shutdown`；终端 Ctrl+C 或操作系统直接向 server 发来的 SIGINT/SIGTERM 也会触发同一有序清理。关停端点要求同源请求并拒绝 Agent runtime 共用的 internal bearer token。supervisor 收到显式信号时只转发有序关闭请求；等待超时只记录告警，不发送信号、不杀进程树。
2. **只读健康观测**：supervisor 周期探测 `GET /protoclaw/health`（默认 2s，`CLAW_SUPERVISOR_HEALTH_MS` 可调；单次探测超时 3s，`CLAW_SUPERVISOR_PROBE_MS` 可调）。`shutting_down`、持续超时或暂时不可达只写入诊断日志，不触发关闭。启动、显式关停请求、退出码、health 不可达/恢复事件追加落盘至数据根下的 `logs/supervisor.log`（数据根默认 `~/.agentdev/AgentDevClaw`，可由 `AGENTDEV_DATA_DIR` 覆盖；`CLAW_SUPERVISOR_LOG` 可覆盖日志路径，设为 `off` 禁用）。
3. **端口冲突**（[server/boot/port-recovery.js](../boot/port-recovery.js)）：启动前只探测端口；若已有服务占用，当前启动明确失败并保留冲突进程原状。禁止通过 `/protoclaw/shutdown` 接管已有实例，禁止按 PID 收割进程树。

## 桌面宿主（Tauri）

桌面主进程保持窗口与服务的独立生命周期：关闭窗口仅隐藏到系统托盘，不关闭服务；只有用户从设置或托盘选择退出时才进入有序停机。健康超时不授予关闭或收割服务树的权限：

```
claw-desktop.exe（Tauri 主进程）
  └─ node scripts/run-supervised.js（启动与诊断）
       └─ node server.js（服务）
```

- **启动**：Tauri 主进程先请求 `GET /protoclaw/health`。本机已有 ready Claw 服务时只打开前台并连接该服务，不再启动第二个服务实例；否则 spawn supervisor（`CREATE_NO_WINDOW`、stdout/stderr 持续排空防管道写满），等待 Claw health ready 后创建窗口。若启动的 supervisor 退出但端口上已有 ready Claw 服务，桌面壳保留并连接该服务，避免前台随启动冲突闪退。
- **单实例**：重复运行桌面 exe 不产生第二实例。新进程不进入启动流程（不探测服务、不 spawn supervisor），把激活转交给已运行实例后退出；已运行实例将主窗口带回前台（托盘隐藏状态同样恢复）。首实例窗口尚未创建（仍在等待服务就绪）时忽略激活，窗口随后续就绪流程创建。
- **WebView 权限**：桌面壳对本壳托管的 Claw 服务源（`127.0.0.1:PORT`）自动授予全部 WebView 权限（通知、麦克风、剪贴板等），不弹权限询问——前端 `Notification.requestPermission()`（首次发送时请求）直接得到 granted，会话完成通知在桌面端与浏览器端行为一致。窗口内导航到其他来源时回落 WebView2 默认行为；已保存的授权/拒绝偏好（WebView2 profile 内）优先于该处理器。
- **关窗与恢复**：主窗口关闭请求只隐藏窗口；supervisor 和服务继续运行。托盘左键或“打开工作台”恢复原窗口与会话。
- **退出**：设置里的“退出程序”请求 server 自主有序关闭；托盘“退出程序”由宿主发同样请求。即使当前桌面壳没有自己启动的 supervisor，用户明确选择退出时也可向已确认 ready 的本机 Claw 服务发送该请求。server 退出后桌面壳随之退出。等待超时后只对自己创建的 supervisor 子树执行最终清理；连接到已有服务时不会按 PID 或进程树强杀它。健康探测、端口冲突和父进程状态不会触发关停。
- **异常宿主退出**：不根据 ppid 消失自动关停或收割服务。若桌面主进程被强制结束，server 可能继续运行；用户可通过正常的 UI 退出流程关闭它。

发布形态从安装目录 `app/` 加载服务资源，优先使用随包 Node；开发形态从仓库加载，Node 缺失时取 PATH。端口沿用 `PORT`/`AGENTDEV_VIEWER_PORT`（默认 1420/2026）；动态端口分配尚未实现，见“边界与非目标”。

## 状态

| 状态 | 含义 |
|---|---|
| `starting` | ViewerWorker 已开始启动或服务正在执行启动初始化，但 HTTP listener 尚未确认可用 |
| `ready` | ViewerWorker 已启动、启动初始化已完成，HTTP listener 已触发 `listening` |
| `stopping` | 已接受关闭请求，停止接收新请求并清理托管资源 |
| `stopped` | 关闭清理已结束 |
| `failed` | 启动流程失败，尚未进入有序关闭 |

`GET /protoclaw/health` 是只读服务级探测：`ready` 时返回 HTTP 200 与 `{ ok: true, state: "ready", pid, appPort, viewerPort }`；其他状态返回 HTTP 503 与 `{ ok: false, state, pid, appPort, viewerPort }`。`pid` 仅用于诊断，不授予调用方关停或终止该进程的能力。该端点只表示 Claw 服务和 ViewerWorker 的启动屏障已越过，不表示任何特定 Agent 或模型提供方已就绪。

## 启动顺序

0. 只读检查应用端口：端口空闲则继续；端口占用则报冲突并结束本次启动，不调用占用进程的控制接口。
1. 启动 ViewerWorker；失败则启动失败，不对外宣布 ready。
2. 执行现有启动初始化（配置文件准备、会话/线程恢复等）。
3. 启动 HTTP listener 并等待 `listening` 事件；端口绑定错误视为启动失败。
4. 将服务状态置为 `ready`，随后执行不阻塞就绪的远程连接器与启动调度启动动作。

服务进程启动输出和健康 API 都以 HTTP listener 确认成功作为 ready 屏障。Agent 的 ready 仍由各 runtime 的状态与 Viewer 注册事实独立判定。

## 关闭顺序

HTTP `POST /protoclaw/shutdown` 返回 `{ ok: true }` 后请求有序关闭；SIGINT/SIGTERM 走同一清理流程。清理只执行一次，后续关闭触发复用同一结果。清理只处理 server 自己管理的资源；外部 supervisor 不收割服务进程树：

1. 停止远程 Claw connector、连接健康轮询和隧道管理。
2. 关闭 SSE 长连接并停止接收新的 HTTP 请求。
3. 向仍存活的 Agent/assembly 子进程发送 SIGTERM；等待最多 `PROCESS_EXIT_WAIT_MS`，仍未退出时再向该 runtime 子进程发送 SIGKILL。这是用户明确关闭服务后的定向清理，不按健康探测或端口冲突触发。
4. 等待 HTTP server 关闭：keep-alive 空闲连接主动收口（`closeIdleConnections`）；在途请求有 `HTTP_CLOSE_GRACE_MS`（2s）收尾窗口，超时后 `closeAllConnections` 强断。步骤 3 先于本步骤执行——runtime 的轮询/桥接连接是活跃长连接，若 close 先行会死等这些连接自然断开，而断开又依赖 runtime 被关闭，形成循环等待（实测复现过：`POST /protoclaw/shutdown` 后主端口停听但进程不死）。
5. 停止 ViewerWorker。
6. 清理结束后退出服务进程。

子进程按进程对象去重，以支持共享 runtime；关闭期间标记对应 runtime 为 stopped。若清理发生错误，服务以非零退出码结束。

## 边界与非目标

- 健康端点是服务进程健康探测，不是 readiness probe 的替代物；Agent runtime 仍用现有 runtime 状态接口确认。探测结果只用于观察与诊断。
- HTTP 服务关闭等待当前连接结束；SSE 会先主动关闭，keep-alive 空闲连接会主动收口（`closeIdleConnections`），其余长请求可能拖慢关闭。超时由调用方记录，不转化为进程终止授权。
- **双服务实例并存不支持**：ViewerWorker 的 UDS 命名管道（`\\.\pipe\agentdev-viewer`，`AGENTDEV_UDS_PATH` 可覆盖）与端口一样是全局单例地址，第二个服务实例会启动失败。桌面启动会先探测 ready 服务并复用其前台入口，桌面壳自身经单实例插件只保留一个实例（重复运行只激活已有窗口，见上文）；这不代表第二个服务实例。测试或并存需求须同时覆盖 `PORT`、`AGENTDEV_VIEWER_PORT`、`AGENTDEV_UDS_PATH`、`AGENTDEV_DATA_DIR`。
- 该契约没有承诺保存正在执行的模型调用结果，也不承诺跨崩溃的 graceful shutdown。
- 当前端口配置与绑定行为保持既有约定；桌面版若需要动态端口、专用 loopback 绑定或 IPC 地址分配，应在独立改动中明确设计和测试，不可假设本契约已覆盖。
