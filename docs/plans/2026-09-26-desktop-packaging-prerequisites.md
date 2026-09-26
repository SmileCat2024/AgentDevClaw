# 桌面打包前置：只读化验证结论与组装缺口

状态：**验证已完成（2026-09-26）**。本文记录"安装目录只读"地基的验收结果、验证中暴露的组装链缺口（D1–D3），以及框架包 vendor 化（tgz 快照）的既定方向。桌面化整体路线见 [service-lifecycle 契约](../protocols/service-lifecycle.md) 与 AGENT.md。

## 验证结论：安装目录只读语义通过

在发布态布局（registry 依赖 + 预构建产物）+ 全目录拒写 ACL（25917 文件）下完成全链路冒烟：服务启动 health ready → UI 渲染 → 创建会话 → runtime 全功能就绪（工具注册、dispatch/bridge/mailbox 循环）。**整个周期对安装目录的写入为 0**；会话数据全部落在 `AGENTDEV_DATA_DIR` 指向的数据目录。"资源只读、数据独立"（[配置边界收敛](2026-09-25-app-config-and-data-boundaries.md)）自此验收。

验证环境对多实例的要求：`AGENTDEV_DATA_DIR` 隔离数据目录（UDS 管道名自动派生）+ 独立 `PORT`/`AGENTDEV_VIEWER_PORT`。注意本机若残留用户级环境变量 `AGENTDEV_UDS_PATH`，会劫持管道派生（explicit 分支优先），多实例场景需清掉。

## 组装链缺口（验证实测发现）

**D1 · 开发态 package-lock 污染组装**。开发态 lock 中 `@agentdevjs/*` 是 `"link": true, resolved: "../AgentDev/..."`；新环境按此 lock `npm install` 在相邻仓库存在时静默物化 junction（偏离 registry），在无相邻仓库环境（打包 CI）直接安装失败。打包流程必须基于干净解析的 lock，不可沿用开发 lock。

**D2 · Claw HEAD 依赖未发布框架 API**。`local-features` 源码使用 registry 0.1.1 尚不存在的 `bgObserver` 系列、`CallStartContext.metadata`（shell-feature 后台面板镜像工作引入）。纯 registry 组装不了当前 HEAD。短期以相邻源码 junction 绕过（`agentdev:local` 语义），根治走下方 vendor 化或框架发版。

**D3 · 仓库携带用户配置与凭据**。仓库 `.agentdev/` 下存有历史运行时写入的模型配置（`default.json`）、全套 IM 渠道配置与 `agent-configs/`。复制仓库或打包都会带上它们——**安装包不得携带用户凭据**。处置：打包清单显式排除；仓库内这批历史文件应择机清理（迁移已完成，程序不再读取旧位置）。

## 既定方向：框架包 vendor 化（tgz 快照）

打包输入从"registry 已发布版本"解耦为"相邻框架源码构建即可"：打包时对相邻 AgentDev 仓库构建 → 各包 `npm pack` 产出 tgz → 安装包内按 `file:*.tgz` 安装（npm 对 tgz 是实体安装，无 junction 语义，lock 天然为实体 resolved）。与 `resources/features/*.tgz` 的 feature 仓库模式同构——框架包纳入同一套 tgz 资产管理。

效果：未发版 API、私有改动直接进包（D2 类阻塞消失）；lock 为实体 resolved（D1 消解）；发版节奏不再约束可打包性。

## 顺带修复（验证中实锤的关闭链缺陷）

- **shutdown 死锁（D4）**：`httpServer.close` 死等 runtime 活跃轮询连接、runtime kill 又排在 close 之后——循环等待，实测 `POST /protoclaw/shutdown` 后进程不死。修复：清理序列重排为"先终结 runtime、再关 HTTP"，close 增加 `HTTP_CLOSE_GRACE_MS`（2s）收尾窗口 + `closeAllConnections` 强断。
- **宿主对自主关闭无监督（D5）**：server 自主关闭不给 supervisor 信号，grace 收割永不启动。修复：supervisor 增加 health watchdog（周期探测，ready 后连续失败或 `state=shutting_down` 即启动 grace）。
