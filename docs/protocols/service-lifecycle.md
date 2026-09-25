# Claw 服务生命周期契约

本文定义 Claw 服务进程的启动就绪、健康探测和有序关闭语义。桌面宿主及开发启动器可依赖该契约；它不替代 Agent runtime 自己的就绪状态。

## 状态

| 状态 | 含义 |
|---|---|
| `starting` | ViewerWorker 已开始启动或服务正在执行启动初始化，但 HTTP listener 尚未确认可用 |
| `ready` | ViewerWorker 已启动、启动初始化已完成，HTTP listener 已触发 `listening` |
| `stopping` | 已接受关闭请求，停止接收新请求并清理托管资源 |
| `stopped` | 关闭清理已结束 |
| `failed` | 启动流程失败，尚未进入有序关闭 |

`GET /protoclaw/health` 是服务级探测：`ready` 时返回 HTTP 200 与 `{ ok: true, state: "ready", appPort, viewerPort }`；其他状态返回 HTTP 503 与 `{ ok: false, state, appPort, viewerPort }`。该端点只表示 Claw 服务和 ViewerWorker 的启动屏障已越过，不表示任何特定 Agent 或模型提供方已就绪。

## 启动顺序

1. 启动 ViewerWorker；失败则启动失败，不对外宣布 ready。
2. 执行现有启动初始化（配置文件准备、会话/线程恢复等）。
3. 启动 HTTP listener 并等待 `listening` 事件；端口绑定错误视为启动失败。
4. 将服务状态置为 `ready`，随后执行不阻塞就绪的远程连接器与启动调度启动动作。

服务进程启动输出和健康 API 都以 HTTP listener 确认成功作为 ready 屏障。Agent 的 ready 仍由各 runtime 的状态与 Viewer 注册事实独立判定。

## 关闭顺序

HTTP `POST /protoclaw/shutdown` 返回 `{ ok: true }` 后请求有序关闭；SIGINT/SIGTERM 走同一清理流程。清理只执行一次，后续关闭触发复用同一结果：

1. 停止远程 Claw connector、连接健康轮询和隧道管理。
2. 关闭 SSE 长连接并停止接收新的 HTTP 请求。
3. 向仍存活的 Agent/assembly 子进程发送 SIGTERM；等待最多 `PROCESS_EXIT_WAIT_MS`，超时则发送 SIGKILL。
4. 停止 ViewerWorker。
5. 清理结束后退出服务进程。

子进程按进程对象去重，以支持共享 runtime；关闭期间标记对应 runtime 为 stopped。若清理发生错误，服务以非零退出码结束。

## 边界与非目标

- 健康端点是服务进程健康探测，不是 readiness probe 的替代物；Agent runtime 仍用现有 runtime 状态接口确认。
- HTTP 服务关闭等待当前连接结束；SSE 会先主动关闭。其他长请求会影响 HTTP close 完成时间。
- 该契约没有承诺保存正在执行的模型调用结果，也不承诺跨崩溃的 graceful shutdown。
- 当前端口配置与绑定行为保持既有约定；桌面版若需要动态端口、专用 loopback 绑定或 IPC 地址分配，应在独立改动中明确设计和测试，不可假设本契约已覆盖。
