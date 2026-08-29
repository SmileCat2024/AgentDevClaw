# 消息轮询的增量探测：probe + tail

Claw 前端对选中 agent 的 `/messages` 轮询是全量重拉：每 300ms（忙碌态）把整个
转录（上限 10k 条 / 50MB）重新传输、重新 `JSON.parse`、逐条 diff。会话越长
浪费越大，而每个周期真正变化的通常只有最后一条消息（流式输出）或零条。

改为**探测 + 按需取增量**：ViewerWorker 在消息推送时刻（新旧数组都在手上）
一次性算出变更分类，前端先轻量探测，只在变化时按分类取增量，客户端拼回完整
数组后走原有提交与渲染路径。轮询间隔、渲染状态机、代理层均不变。

## 变更分类（changeKind）——跨仓库契约

| changeKind | 语义 | 前端取法 | 渲染分支（现有） |
|---|---|---|---|
| `append` | 只在尾部新增，前缀不变 | `?since=<旧count>` | appendNewMessages |
| `tail` | 条数不变，最后一条被改写（流式输出） | `?tail=1` | updateLastMessage |
| `rewrite` | 中段替换 / 条数减少（rollback、compact、修剪） | 全量 | renderCurrentMainView |

- 分类由 ViewerWorker 在 `handlePushMessages` 推送时刻计算并存于 session；
  这同时修正现有盲区——"中段变化但 count 与末条签名均不变"目前会被
  `hasMessagesChanged` 静默丢弃（只比 count + 末条签名）。
- 前端校验 `delta.length === count - since`：不匹配即降级全量拉。校验失败
  不是错误路径，是让服务端分类 bug 显形并保正确性的断言。
- 连续失配或 count 归零（Worker 重启）→ 全量拉一次重建基线，恢复探测。

## probe 载体

探测数据（`{ count, changeKind, sinceIndex, fakeFullBytes }`）挂在
`/overview` 响应的 HTTP 组装层（`getMergedOverview`），不进 session 存储、
不进框架 `AgentOverviewSnapshot` 类型。前端 `normalizeOverviewSnapshot` 剥离
未知字段、`getOverviewSignature` 不受污染——overview 通道天然每周期必达，
未变化周期零额外请求、零新路由，远程代理白名单（`messages`/`overview`）
原样覆盖。

字节计量：`enforceMemoryLimits` 已逐条 `JSON.stringify` 算字节，顺手增量维护
session 总字节缓存，探测周期零新增序列化。`fakeFullBytes`（假想全量字节数）
随探测下发，前端据此计算节省比例。dev 计量默认关闭（URL 开关），console.debug
输出每次刷新的实际字节 / 假想全量 / 变更类型——这份数据是将来评估 SSE 的依据。

## Considered Options

- SSE / WebSocket 推送：延迟更优（~0ms vs ≤300ms），但代理层是缓冲式
  `fetch`+`arrayBuffer`，流式透传需重写；前端轮询竞态状态机（token/epoch/
  三分支 diff）需按事件时序重构。收益比不抵风险比，列为后续演进——若计量
  显示大增量频繁或延迟成为痛点再启动，本方案的分类契约与取数语义直接复用。
- 独立 probe 端点（`?probe=1`）：每周期多一个请求，无补偿优势，rejected。
- 前端只拉增量不拼全量：渲染状态机的三分支消费完整数组，拼接是保持
  "渲染零改动"的代价，几十字节的重复不可观测。
