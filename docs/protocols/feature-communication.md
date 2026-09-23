# Feature-Panel 通信基座（feature-comms 通道）接入指引

状态：现行（设计裁决见 [ADR-0018](../adr/0018-feature-panel-communication-transport.md)）
最后更新：2026-09-23

面向两类接入者：想让运行时 Feature 状态实时上板的 **Feature 作者**，与想订阅通道的 **面板作者**。参考实现：`local-features/shell-bg-comms`（Feature 侧）+ `public/src/modules/bg-panel.js`（面板侧）。

## 何时用 / 何时不用

用：把 Feature 进程内实时状态（任务登记表、执行进度、连接状态）投影到浏览器面板；面板向 Feature 发低频定向请求（查看详情、触发控制动作）。

不用：Feature 间进程内协作（走 CapabilityRegistry，ADR-0007）；需要可靠投递/持久化的队列（通道是有界尽力而为投影，状态真值必须留在 Feature 自己的工具面，如 `bg_status`）；面板主动推送内容给用户（走 generative-ui）。

## 端点契约

通道四元组：`agentId` / `sessionId` / `featureId` / `channelId`。featureId 必须等于 feature 的 `name`（runtime IPC 按它定位 `onHostRequest` 宿主）。

| 端点 | 方向 | 认证 | 说明 |
|---|---|---|---|
| `POST /protoclaw/feature-comms/declare` | Feature → server | internal | 声明即授权记录；校验 runtime 存活 |
| `POST /protoclaw/feature-comms/publish` | Feature → server | internal | `kind: snapshot \| event`，负载 ≤256KB；未声明拒绝 |
| `GET /protoclaw/feature-comms/stream` | 面板 → server | 用户会话 | SSE；未声明 404。事件：`event`/`snapshot`/`resync`/`closed`；`Last-Event-ID` 续接 |
| `GET /protoclaw/feature-comms/snapshot` / `events` | 面板 → server | 用户会话 | 非流式读取（调试/降级用） |
| `GET /protoclaw/feature-comms/channels` | 面板 → server | 用户会话 | 列出会话已声明通道 |
| `POST /protoclaw/feature-comms/request` | 面板 → server | 用户会话 | `{requestType, payload}` → runtime IPC → `onHostRequest`；runtime 不在返回 `runtime_not_connected` |

## Feature 侧接入

```ts
import { FeatureCommunicationClient } from '../../shared/src/feature-communication.js';

const client = new FeatureCommunicationClient(serverOrigin, {
  agentId, sessionId, featureId: this.name, channelId: 'my-channel',
});
await client.declareChannel({ title: '面板标题' });     // 先声明（构造期 fire-and-forget + 惰性补声明均可）
await client.publishEvent('progress', { done: 3, total: 10 });  // 事件 = 增量
await client.publishSnapshot({ tasks: [...] });          // 快照 = 全量（消费端 resync 对齐）
```

请求面实现 `onHostRequest`（Claw 宿主层钩子约定，duck-typing 分发，暂不在框架 `AgentFeature` 接口内）：

```ts
async onHostRequest(requestType: string, payload: unknown) {
  switch (requestType) {
    case 'list': return { ok: true, items: [...] };
    default: return { ok: false, code: 'operation_unavailable', error: '...' };
  }
}
```

约定：

- **身份来源**：从 agent.js 装配层的 `runtimeIdentity`（agentId/sessionId/serverOrigin）传入 feature 构造函数，不要从环境变量猜。
- **声明时机**：构造期声明一次（runtime 进程内构造时 server 侧注册已完成）；失败静默，首个观察事件时 `ensureDeclared` 补声明。
- **尽力而为**：发布失败必须吞掉——通道是镜像面，绝不能因面板链路故障影响 feature 本身。
- **生命周期自动绑定**：进程退出、共享会话摘除会自动 `closeSession`（清声明、推 `closed` 给订阅者、拒绝挂起请求），feature 侧无需清理代码。
- **高频事件要节流**：通道不做速率控制，输出类事件按 ~1s 节流（参考 BgRegistry observer 的做法），终态事件不节流。

## 面板侧接入

参考 `modules/bg-panel.js` 全流程。要点：

1. **寻址纪律**（对齐 session-controls-panel）：`agentId` = `focusedAgentId`（本地宿主逻辑 id），`sessionId` = `getRuntimeWorkspaceSessionId(currentRuntimeAgentId) || getActiveWorkspaceSessionId()`；远程命名空间会话（`isRemoteNamespaceAgentId`）与本机通道不兼容，降级为"不可用"空态，不猜目标。
2. **订阅**：`new EventSource('/protoclaw/feature-comms/stream?' + 四元组参数)`（同源 cookie 自动携带）；监听 `event`（data JSON 内含 `type`/`data`）、`resync`（拉请求面对齐）、`closed`（会话终结，展示终态并停订）。
3. **初始对齐**：订阅建立后经 `request` 拉全量（如 `list`），事件只做增量更新。
4. **生命周期**：`onOpen` 建订阅、`onClose` 拆订阅；面板常开时用定时守卫检测焦点会话变化重订；面板被取消激活（`activeFeaturePanel` 不再是本面板）自动拆订阅。
5. **注册**：`app-ui.js` 经 `registerFeaturePanel` 声明 `when`（agentIds/surfaces）与 i18n 元数据；开合钩子在 `modules/debug-panel-host.js` 的 `toggleFeaturePanel` 显式接线（git/genui/bg 先例）。

## 已知限制（接入前读一遍）

- 通道是 server 进程内存态：server 重启通道清空，Feature 的补声明逻辑会重建，但期间面板需自行降级。
- 事件缓冲有界（默认 256/通道）：越界消费端收 `resync`，面板必须实现"请求面对齐"路径。
- `onHostRequest` 未进框架接口：生态包实现它没有类型可依（ADR-0018 决策 5 的已知缺口）。
- 通道无 TTL / 总量上限（生产观察项）。
