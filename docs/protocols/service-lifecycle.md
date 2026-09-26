# Claw 服务生命周期契约

本文定义 Claw 服务进程的启动就绪、健康探测和有序关闭语义。桌面宿主及开发启动器可依赖该契约；它不替代 Agent runtime 自己的就绪状态。

## 宿主与进程裁决权

`npm start` 不再直接运行 server.js，而是经宿主（[scripts/run-supervised.js](../../scripts/run-supervised.js)）托管：

```
npm start → supervisor（宿主，持有终端）→ node server.js（被托管进程）
```

裁决权归属：宿主持有 server 进程树的生杀权；server.js 只拥有"尽力清理"的执行权，其清理进度**不构成任何一方的退出前提**。停机路径分三层防线，逐级兜底：

1. **宿主收割（主路径）**：宿主收到停机信号（Ctrl+C 等）后给 server 优雅窗口（`CLAW_SUPERVISOR_GRACE_MS`，默认 10s），窗口过后或再次收到信号时，无条件收割整棵进程树（Windows `taskkill /T /F`，见 [server/shared/process-tree.js](../shared/process-tree.js)）——server 自身与其 runtime 子进程一并终结。server 的清理挂住最多损失清理质量，不会造成端口残留。
2. **宿主死亡检测**：server 以 `CLAW_SUPERVISED=1` 被托管时，每 3 秒探测宿主进程存活（`process.kill(ppid, 0)`）。Windows 上父进程消亡既不发信号也不关闭子进程可见通道（匿名管道不产生 EOF，已实测证伪），只能主动探测；宿主无论以何种方式消亡，探测失败即触发自身有序关闭。
3. **宿主 health watchdog**：宿主周期探测 `GET /protoclaw/health`（默认 2s，`CLAW_SUPERVISOR_HEALTH_MS` 可调）。server 自主关闭（`POST /protoclaw/shutdown`）或清理挂死时不给宿主任何信号，停机信号路径的 grace 收割不会启动——watchdog 补上"宿主主动询问"的感知通道：ready 之后的连续探测失败、或 503 且 `state=shutting_down`，均按停机信号同等启动 grace 窗口。ready 之前的探测失败属启动期正常现象，不计数。
4. **启动自愈**（[server/boot/port-recovery.js](../boot/port-recovery.js)）：server 启动绑定端口前探测 `GET /protoclaw/health`——响应带 `state` 契约字段即本产品旧实例：先 `POST /protoclaw/shutdown` 优雅请退，宽限后仍存活则按响应中的 `pid` 收割其进程树；非 Claw 进程占用或不报告 pid 的过旧实例则报错退出，把决定权留给用户。

桌面化时 Electron/Tauri 主进程即同一宿主角色，直接复用该裁决权结构与 server 侧语义。

## 状态

| 状态 | 含义 |
|---|---|
| `starting` | ViewerWorker 已开始启动或服务正在执行启动初始化，但 HTTP listener 尚未确认可用 |
| `ready` | ViewerWorker 已启动、启动初始化已完成，HTTP listener 已触发 `listening` |
| `stopping` | 已接受关闭请求，停止接收新请求并清理托管资源 |
| `stopped` | 关闭清理已结束 |
| `failed` | 启动流程失败，尚未进入有序关闭 |

`GET /protoclaw/health` 是服务级探测：`ready` 时返回 HTTP 200 与 `{ ok: true, state: "ready", pid, appPort, viewerPort }`；其他状态返回 HTTP 503 与 `{ ok: false, state, pid, appPort, viewerPort }`。`pid` 供启动自愈识别并接管残留实例。该端点只表示 Claw 服务和 ViewerWorker 的启动屏障已越过，不表示任何特定 Agent 或模型提供方已就绪。

## 启动顺序

0. 启动自愈：探测应用端口是否残留占用，是本产品旧实例则接管（优雅请退 → 强杀进程树），非 Claw 占用则启动失败并报明占用者。
1. 启动 ViewerWorker；失败则启动失败，不对外宣布 ready。
2. 执行现有启动初始化（配置文件准备、会话/线程恢复等）。
3. 启动 HTTP listener 并等待 `listening` 事件；端口绑定错误视为启动失败。
4. 将服务状态置为 `ready`，随后执行不阻塞就绪的远程连接器与启动调度启动动作。

服务进程启动输出和健康 API 都以 HTTP listener 确认成功作为 ready 屏障。Agent 的 ready 仍由各 runtime 的状态与 Viewer 注册事实独立判定。

## 关闭顺序

HTTP `POST /protoclaw/shutdown` 返回 `{ ok: true }` 后请求有序关闭；SIGINT/SIGTERM 走同一清理流程。清理只执行一次，后续关闭触发复用同一结果。清理进度不构成进程退出的前提——挂住时由宿主收割兜底（见"宿主与进程裁决权"）：

1. 停止远程 Claw connector、连接健康轮询和隧道管理。
2. 关闭 SSE 长连接并停止接收新的 HTTP 请求。
3. 向仍存活的 Agent/assembly 子进程发送 SIGTERM；等待最多 `PROCESS_EXIT_WAIT_MS`，超时则发送 SIGKILL。
4. 等待 HTTP server 关闭：keep-alive 空闲连接主动收口（`closeIdleConnections`）；在途请求有 `HTTP_CLOSE_GRACE_MS`（2s）收尾窗口，超时后 `closeAllConnections` 强断。步骤 3 先于本步骤执行——runtime 的轮询/桥接连接是活跃长连接，若 close 先行会死等这些连接自然断开，而断开又依赖 runtime 被 kill，形成循环等待（实测复现过：`POST /protoclaw/shutdown` 后主端口停听但进程不死）。close 的完成不依赖任何外部连接的自觉。
5. 停止 ViewerWorker。
6. 清理结束后退出服务进程。

子进程按进程对象去重，以支持共享 runtime；关闭期间标记对应 runtime 为 stopped。若清理发生错误，服务以非零退出码结束。

## 边界与非目标

- 健康端点是服务进程健康探测，不是 readiness probe 的替代物；Agent runtime 仍用现有 runtime 状态接口确认。
- HTTP 服务关闭等待当前连接结束；SSE 会先主动关闭，keep-alive 空闲连接会主动收口（`closeIdleConnections`），其余长请求可能拖慢但不会阻塞最终退出（宿主收割兜底）。
- 该契约没有承诺保存正在执行的模型调用结果，也不承诺跨崩溃的 graceful shutdown。
- 当前端口配置与绑定行为保持既有约定；桌面版若需要动态端口、专用 loopback 绑定或 IPC 地址分配，应在独立改动中明确设计和测试，不可假设本契约已覆盖。
