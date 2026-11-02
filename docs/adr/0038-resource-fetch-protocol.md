# 0038 — 资源读取协议：runtime 持有资产的跨边界只读资源面

- **Status**: Accepted（设计经 2026-11-02 grill 会话裁定；已实施并通过容器 E2E 12/12 验收，实施与验收细节见 [实施计划](../plans/2026-11-02-resource-fetch-protocol.md)）
- **Date**: 2026-11-02
- **来源**: 2026-11-02 grill 会话（通信构成心智模型 → 资源读取协议落地拷问）+ 会话 session-1793550281349-fe8081 T4–T7 的容器模板缺口定位

## Context

Feature 渲染模板链路现状（全部在 AgentDev 框架）：`agent.ts` 从 `feature.getPackageInfo().root`（realpath）收集 `templateMounts` + `templateEntries`，随 `registerAgent` 上报 → `ViewerWorker`（packages/viewer）按 `GET /api/templates/feature?agentId=…` 向前端下发「模板名 → `/tpl/{mountId}/{rel}`」映射；`handleTplAsset` 服务 `/tpl/` 请求——**用 viewer worker 自己的文件系统读 mount root 下的文件**，mountId 为根路径哈希（跨 agent 共享浏览器模块缓存）。

容器 runtime（ADR-0037）暴露该链路的同机隐式假设：runtime 注册的 mount root 是容器内路径（`/app/…`），宿主上的 ViewerWorker 按自己的文件系统解析必然落空，模板映射缺失、前端回退默认渲染。同类缺口不止模板——未来前端展示 Skill 内容（`collectFeatureSkills` 的 `dirname(source)/skills` 目录）同属「runtime 持有、前端只读消费」的资源。

本篇与既有通信的关系（上轮会话确立的心智模型）：**底层传输统一、业务协议按数据语义分开**。资源读取是独立的一类业务协议——只读、URL 寻址、可缓存、有 MIME 与路径约束——不属于 feature-comms 的状态事件模型（尽力而为投影），也不属于对话输入或 capability 命令。底层传输复用 viewer 控制连接上的 host-request 通道（ADR-0037 M6 后续），不新增连接。

## Decision

### 1. 资源身份模型：`/res/{agentId}/{rootId}/{rel}`

runtime 把模板挂载点泛化为**资源根**（resource root）上报；URL 按 `agentId + rootId + 相对路径` 寻址。取代 `/tpl/{mountId}/{rel}`（mountId 为根路径哈希、与 agent 无关）。

选 agentId 限定的理由：路径哈希在容器形态下是**正确性缺陷**——不同容器内同路径（`/app/…`）内容不同，跨 agent 复用同一 mountId 会串缓存；agentId 限定归属后，本地多 agent 共享同一宿主包根只是浏览器模块缓存重复（内容一致，无正确性问题），是小代价。

rootId 语义：**runtime 会话内稳定即可**（沿用注册顺序），不做跨重启稳定承诺——缓存与 URL 同随 runtime 生命周期失效，两者一致。

### 2. 取数模式：纯拉（pull），worker 不持内容

浏览器 GET `/res/{agentId}/{rootId}/{rel}` → ViewerWorker 复用 host-request 下发通路（与 `POST /api/agents/:id/host-request` 同一机制，进程内直调）向 runtime 发 `resource.fetch`（payload `{rootId, rel}`）→ runtime handler 在已声明根内解析读取 → 返回 `{ok, data(base64)}` 或 `{ok:false, code}`。60s 超时自结算、连接断开即 NAK、runtime 错误透传——全部复用既有语义，零新增超时/失败机制。MIME 由 worker 按 URL 扩展名推断（js/mjs/json/map/css/markdown/png/webp/svg，未知 octet-stream），runtime 契约保持最小。

不选推送（注册时上报内容/清单）：模板与 chunk 首次访问才需要，低频小文件；断连时前端回退默认渲染是既有降级，无需宿主离线兜底。

### 3. 统一回源，无双路径

本地（UDS）、容器、外部 runtime（TCP）同链路：**worker 永远经 host-request 回源，不再本地 readFile**。资源根路径从此不出 runtime——注册载荷只上报 rootId 集合与 entries（容器路径仅存留于 runtime 侧日志）。capability 503 的教训即双路径分叉（「本地假设 IPC 存在」），本协议单一实现路径。

### 4. 授权边界是框架语义：资源根只能落在 feature 包根内

资源根唯一来源：`feature.getPackageInfo().root`（现状模板 mount 即如此）。未来 feature 显式追加「公开资源目录」（如 Skill 展示）必须以包根为前缀。路径穿越防护保留在 runtime 侧（resolve 后必须仍在根内，越界 403）。由此浏览器不可能经 URL 参数读到任意容器文件——授权不依赖宿主逐根配置，也不让 runtime 自由声明任意目录。

### 5. 分发组合：类型化 handler 插在最前

现状 `DebugHub.setHostRequestHandler` 为 per-agent 优先、全局 fallback；Claw 宿主（`run-prebuilt-agent.js`）注册的是**全局** handler（feature-comms / capability 分发）。若框架 Agent 直接注册 per-agent handler 会遮蔽它。

新增类型化分发层：host-request 帧到达时按 `payload.requestType` 查类型化 handler 命中则分发，未命中走 per-agent → 全局（现状语义不变）。框架 `Agent.start()` 注册类型化 `resource.fetch`；Claw 宿主全局 handler 零改动、不受影响。feature-comms / capability 的线上 payload 本就携带 requestType，与该分发天然对齐。

### 6. 缓存与降级

不建 worker 侧内容缓存；`Cache-Control: no-cache` 与现状一致（开发态 dist 重建后浏览器可协商更新）。未注册 rootId / runtime 断连 / 超时 → 404，前端回退默认渲染（现状降级行为不变）。内容指纹 URL（不可变缓存）为后续增强，非本轮。

### 7. 范围：协议通用，本轮只接模板消费者

`/tpl/` 直接退役不留别名（模板 URL 由 worker 生成、前后端同版本发布、无外部消费者；两套前端——Claw `template-engine.js` 与框架 viewer 页——均按不透明 URL 消费）。Skill 展示等未来消费者按同一模型「再注册一类资源根」接入，不为本轮预留专用端点。

## Consequences

- **正面**：容器模板缺口按协议收口而非点状补丁；授权边界成为框架语义（包根前缀），Claw 零配置；通道复用（host-request）不新增连接与超时机制；类型化分发为后续按 requestType 组合多业务提供模式。
- **代价**：跨仓改动（框架 AgentDev 为主，Claw 侧文档与 E2E）；每次资源请求一跳 runtime 往返——本地 UDS 毫秒级、资源低频，可忽略；本地多 agent 共享包根时浏览器模块缓存重复。
- **风险**：rootId 会话内语义意味着 URL 不跨 runtime 代稳定——与缓存失效策略一致，无违约面；类型化分发是 host-request 的新语义，需与 Claw 全局 handler 组合回归（同帧既有 feature-comms/capability 用例必须保持绿）。
- **非目标**：不决定 Skill 前端展示形态（消费者定形后另行接入）；不做内容指纹缓存与 worker 侧内容缓存；不改变 feature-comms / capability / user-turn 的既有协议。

## 实施进展

见 [docs/plans/2026-11-02-resource-fetch-protocol.md](../plans/2026-11-02-resource-fetch-protocol.md)。
