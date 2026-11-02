# 资源读取协议实施计划

- **Date**: 2026-11-02
- **Status**: 实施中
- **决策依据**: [ADR-0038 资源读取协议](../adr/0038-resource-fetch-protocol.md)

## 背景与目标

Feature 渲染模板的 `/tpl/{mountId}/{rel}` 资产由 ViewerWorker 在自己的文件系统读取 mount root，容器 runtime 注册的容器内路径（`/app/…`）宿主不可见，模板映射缺失。本计划把模板资产读取改造为 ADR-0038 的资源读取协议：URL 换为 `/res/{agentId}/{rootId}/{rel}`，ViewerWorker 经 host-request 通道（`resource.fetch`）向 runtime 回源读取，本地 / 容器 / 外部 runtime 同链路。

范围：协议按通用资源面实施，但只接模板消费者；Skill 展示等未来消费者按同一模型另行接入。

## 阶段一：框架侧（AgentDev 仓库）

### 1.1 类型化 host-request 分发（`packages/core/src/core/debug-hub.ts`）

- 新增类型化 handler 注册表：`requestType → handler`（`setHostRequestTypeHandler(requestType, handler)`）。
- host-request 帧分发顺序调整为：类型化 handler（按 `payload.requestType` 命中）→ per-agent handler → 全局 handler。后两级语义不变。
- 动机：Claw 宿主（`run-prebuilt-agent.js`）以全局 handler 承载 feature-comms / capability 分发；框架若直接注册 per-agent handler 会遮蔽它。类型化分支插在最前，两不相扰。

### 1.2 资源根收集与 `resource.fetch` handler（`packages/core/src/core/agent.ts`）

- 现有 `templateMounts`（realpath 后的 feature 包根数组）泛化为资源根：收集逻辑不变（唯一来源 `feature.getPackageInfo().root`），rootId 沿用注册顺序（数组下标），会话内稳定。
- `Agent.start()` 注册类型化 `resource.fetch` handler：payload `{rootId, rel}` → 根内 resolve（越界返回 `forbidden`）→ 读文件 → `{ok, data(base64)}`；未知 rootId / 文件缺失返回 `not_found`。handler 与根表随 Agent 生命周期。
- 注册载荷调整：`templateMounts: string[]` 改为 `resourceRoots`（rootId 标识，不向 worker 传递可服务化的宿主路径）；`templateEntries` 的 `{mount, rel}` 改为 `{root, rel}`。

### 1.3 传输与 worker（`packages/core/src/core/claw-debug-client.ts`、`packages/viewer/src/viewer-worker.ts`）

- `claw-debug-client.ts`：注册载荷字段随 1.2 更名透传。
- `viewer-worker.ts`：
  - `handleGetFeatureTemplates`（`GET /api/templates/feature?agentId=…`）：URL 生成改为 `/res/{agentId}/{rootId}/{rel}`。
  - `/res/{agentId}/{rootId}/{rel}` 路由取代 `handleTplAsset`：进程内直调 host-request 下发通路向目标 runtime 发 `resource.fetch`（复用既有 pendings / 60s 超时 / 断连 NAK 机制）→ base64 解码回体；MIME 按 URL 扩展名推断（`.js`/`.mjs` → `application/javascript`，`.json`/`.map` → `application/json`，`.css` → `text/css`，`.md` → `text/markdown`，图片类型映射，未知 `application/octet-stream`）；`Cache-Control: no-cache`。
  - runtime 断连 / 未注册 rootId / 超时 / runtime 错误 → 404（前端回退默认渲染为既有行为）。
  - `handleTplAsset` 与 `/tpl/` 匹配分支删除，不留别名。
- `packages/viewer/src/viewer-html/js-templates.ts`：模板 URL 按不透明消费，核对无 `/tpl/` 前缀假设，注释同步。

### 1.4 框架测试

- `packages/viewer/test/viewer-worker-template-mounts.test.ts` 重写为回源模式：注册 → `/res/` URL → 经（伪 runtime handler）取回字节的往返；多根隔离；路径穿越变体（`..`）返回 403 语义；未知 rootId 404；断连 NAK → 404；超时 → 404。
- `packages/core/test/feature-template-resolvability.test.ts`：mount 协议断言更新为资源根协议。
- 新增类型化分发组合测试：同一 DebugHub 上 `resource.fetch` 类型化 handler 与全局 handler（模拟 Claw 宿主）各自可达、互不遮蔽。
- AgentDev `npm run build` 全量通过。

## 阶段二：Claw 侧

- `public/src/modules/template-engine.js`：URL 按不透明消费已核实（仅注释提及 `/tpl/`），同步注释即可，无行为改动。
- 文档同步：`docs/protocols/tool-rendering.md` 模板 URL 契约更新；ADR-0037 开放点加指向；AGENT.md ADR 索引补 0038。
- 依赖框架发版或本地 junction 生效（开发态按仓库约定走相邻仓库 build）。

## 阶段三：容器 E2E（`scripts/e2e-container-phase.mjs`）

新增场景（复用四场景基建与容器镜像构建）：

1. 容器 runtime 启动 → `GET /api/templates/feature` 返回 `/res/` URL → 请求该 URL 经宿主 ViewerWorker 回源取到模板字节（内容与容器内文件一致）。
2. 根外路径（构造越界 rel，含 `..` 穿越变体）被 runtime 拒绝，HTTP 403 语义。
3. 停止容器 runtime 后请求 `/res/` URL 得 404（断连降级；前端回退默认渲染为既有行为，E2E 断言止于 404）。

验收前置：重建容器镜像（镜像含新框架 dist 与 runtime 代码），Claw 服务重启加载新框架。

## 验收门槛

- 框架 viewer / core 相关单测全绿（含既有 feature-comms / capability host-request 用例不回归——类型化分发不得破坏既有分发语义）。
- 真容器内模板实际渲染（场景 1）。
- 根外路径被拒（场景 2）。
- 断连降级（场景 3）。

## 验收记录（2026-11-02）

- **框架单测**：定向套件全绿（core resource-serve / debug-hub 类型化分发 / 模板可解析性 26 例 + viewer /res/ 回源协议 8 例）。全量 core+viewer 套件中 3 处失败均已实证定性、与本次改动无关：skills-loader 符号链接去重 1 例为 HEAD 存量（stash 后同败）；workthread-differential 随机序列 1 例为种子抖动（单独复跑通过）；另有本机全局 `AGENTDEV_VIEWER_HTTP_BIND=0.0.0.0` 会让起真实 ViewerWorker 的测试拿到 401，`env -u` 去掉后全绿。
- **容器 E2E**：`node scripts/e2e-container-phase.mjs` **12/12**（新增场景 ⑥，既有 11 场景无回归）。⑥ 实测：模板映射产出 `/res/<agentId>/0/...` URL，经平台端口跨容器边界回源取回 1682 字节真实模板内容；未注册 rootId 与百分号编码穿越路径均 404 且无内容泄漏。
- **E2E 抓到并修复的组合缺陷**：worker 初版把回源帧发成嵌套 `{requestType, payload:{rootId,rel}}`，而类型化分发按 `payload.requestType` 匹配后把整帧对象交给 handler，runtime 侧 `serveResourceFetch` 在顶层取不到 `rootId/rel` 判 `invalid`。两层单测各自喂了自洽形状，未暴露组合错位。修为拍平契约 `{requestType, rootId, rel}`（`requestType` 为类型化分发保留键），viewer 单测同步锁定该 wire 契约。
- **覆盖边界**：越根 `forbidden→403` 与断连→404 由框架单测覆盖；E2E 探针覆盖未注册根与编码穿越（均为 404）。前端回退默认渲染为既有降级行为，未在 E2E 断言。
- **E2E 取 viewerAgentId 的方式**：容器形态下创建响应不带该字段（经 ticket 身份交接异步到达，且 viewer id 槽位跨 agent 复用），脚本从平台日志按「`Viewer Agent ID: <id>` → `创建新会话: <sessionId>`」就近配对解析。

## 风险与回滚

- 类型化分发改动 host-request 公共路径：既有 5 例 viewer host-request 用例 + debug-hub 用例是回归护栏。
- rootId 为注册顺序下标：URL 不跨 runtime 代稳定，与缓存随生命周期失效一致；无持久消费者（模板 URL 每次经 API 映射获取）。
- 回滚 = 框架回退提交 + 重建；Claw 侧无行为改动，回滚面集中在框架仓库。
