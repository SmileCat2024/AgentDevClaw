# 桌面打包前置：只读化验证结论与组装缺口

状态：**验证已完成（2026-09-26）**。本文记录"安装目录只读"地基的验收结果、验证中暴露的组装链缺口（D1–D3），以及框架包 vendor 化（tgz 快照）的既定方向。桌面化整体路线见 [service-lifecycle 契约](../protocols/service-lifecycle.md) 与 AGENT.md。

## 验证结论：安装目录只读语义通过

在发布态布局（registry 依赖 + 预构建产物）+ 全目录拒写 ACL（25917 文件）下完成全链路冒烟：服务启动 health ready → UI 渲染 → 创建会话 → runtime 全功能就绪（工具注册、dispatch/bridge/mailbox 循环）。**整个周期对安装目录的写入为 0**；会话数据全部落在 `AGENTDEV_DATA_DIR` 指向的数据目录。"资源只读、数据独立"（[配置边界收敛](2026-09-25-app-config-and-data-boundaries.md)）自此验收。

验证环境对多实例的要求：`AGENTDEV_DATA_DIR` 隔离数据目录（UDS 管道名自动派生）+ 独立 `PORT`/`AGENTDEV_VIEWER_PORT`。注意本机若残留用户级环境变量 `AGENTDEV_UDS_PATH`，会劫持管道派生（explicit 分支优先），多实例场景需清掉。

## 组装链缺口（验证实测发现）

**D1 · 开发态 package-lock 污染组装**。开发态 lock 中 `@agentdevjs/*` 是 `"link": true, resolved: "../AgentDev/..."`；新环境按此 lock `npm install` 在相邻仓库存在时静默物化 junction（偏离 registry），在无相邻仓库环境（打包 CI）直接安装失败。打包流程必须基于干净解析的 lock，不可沿用开发 lock。

**D2 · Claw HEAD 依赖未发布框架 API**。`local-features` 源码使用 registry 0.1.1 尚不存在的 `bgObserver` 系列、`CallStartContext.metadata`（shell-feature 后台面板镜像工作引入）。纯 registry 组装不了当前 HEAD。短期以相邻源码 junction 绕过（`agentdev:local` 语义），根治走下方 vendor 化或框架发版。

**D3 · 仓库携带用户配置与凭据（已处置，2026-09-26）**。仓库 `.agentdev/` 与 `config/` 整体在 `.gitignore` 内，凭据本就不会进 git/git archive，风险面为"整目录复制式打包"与本地磁盘卫生。处置已完成：迁移清单内的死副本（八个 IM/模型/gateway/remote 配置、`agent-configs/`、`config/default.json`、`config/presets.json`）与遗留运行数据（旧 sessions、audit.db、GROUP.md、trace/日志、dispatch 票据、visual-cache/tts/mcps/images/resources）共 23 项移入回收站；活数据此前已核对全部存在于用户数据目录。保留：`.agentdev/temp`（会话 shell 输出落盘，项目级设计）、`.agentdev/claw-workspace`（本仓库自身作为工作项目的 docset）、`.agentdev/skills`（SkillFeature 扫描 `workspaceDir/.agentdev/skills`，活数据）、`.agentdev/tickets/acceptance-report-T007.md`（git 追踪的验收记录，内容无凭据）。清理中顺带发现并修复：`/protoclaw/render_conversation` 写 `process.cwd()/.agentdev/temp`，打包后 cwd 为只读安装目录会写入失败，已改落 `USER_DATA_ROOT/temp`（server 侧唯一一处 cwd 写入）。

## Tauri 2a 渲染兼容性切片（已通过，2026-09-26）

[desktop/](../../desktop/) 落地最小 Tauri 2 壳：窗口直接加载本机 Claw 服务（`http://127.0.0.1:1420`），无 sidecar、无打包、无系统集成。WebView2 对现有前端（玻璃质感、环境光、滚动、面板）渲染正常（用户实测验收）。壳的启动方式：先 `npm start` 起服务，再 `cd desktop && cargo run`。同批删除了 ProtoClaw 时代的孤儿 `public/src/tauri-bridge.js`（活代码零引用）。

## Tauri 2b sidecar 生命周期切片（已通过，2026-09-26）

Tauri 主进程接管宿主角色，裁决权结构与三层防线零改动沿用（契约见 [service-lifecycle.md](../protocols/service-lifecycle.md) 桌面宿主章节）：spawn `node scripts/run-supervised.js`，等服务端口可连接后建窗口；窗口关闭 → `POST /protoclaw/shutdown` → supervisor 善后退出，宽限后 `taskkill /T /F` 最终兜底。supervisor 侧新增 ppid watchdog（`CLAW_SUPERVISOR_HOST_PING_MS`，默认 3s）检测宿主死亡，检测到后先 POST 优雅请退再收割，Tauri 被强杀全树也能自清。

E2E 实测（独立 `PORT`/`AGENTDEV_VIEWER_PORT`/`AGENTDEV_UDS_PATH`/`AGENTDEV_DATA_DIR` 隔离运行）：窗口关闭全树 454ms 退出；宿主 taskkill /F 单杀全树 1.1s 自清；并存实例不受影响。验证中实锤两个问题并修复：窗口创建必须在事件循环启动后经 AppHandle 代理投递（run() 前主线程直接 build 会因 WebView2 初始化挂死）；双实例并存因 ViewerWorker UDS 管道全局单例而失败（已记入契约"边界与非目标"，单实例语义属打包阶段）。

当前形态仍为开发切片：node 取 PATH、仓库根取编译期路径。下一步：第 3 步组装链（D1/D2 vendor 化 + Node 随包分发）。

## 第 3 步组装链：vendor tgz + Node 随包分发（已通过，2026-09-26）

[scripts/pack-desktop.mjs](../../scripts/pack-desktop.mjs)（`npm run pack:desktop`）产出可独立运行的发布树 `dist/desktop-staging/`（gitignore），即 tauri bundler 的输入：

- **D1/D2 消解**：相邻 AgentDev 构建后 18 个 `@agentdevjs/*` 各自 `npm pack` 进 `vendor/`，staging 根声明改 `file:vendor/*.tgz` 实体安装（npm 对 tgz 无 junction 语义）；不带开发 package-lock，现场干净解析。features/* 子包的 core devDep 同步改指 vendor tgz——子包独立 install，semver 声明会从 registry 解析回已发布旧版（D2 在子包层复现）。staging 必须位于仓库内部深层目录（`dist/` 下），否则 features 构建的相邻仓库探测会以 junction 劫持 vendor 副本。
- **组装自检**：实体校验（无 junction、版本与 tgz 一致）+ 隔离端口冒烟（bundled node 直启 supervisor → health ready → POST shutdown → 退出码 0）内建于脚本，当前全程 2m35s。
- **Node 随包分发**：拷贝打包机 node 至 `runtime/node.exe`；桌面壳（`CLAW_DESKTOP_ROOT` 指向发布树）解析顺序为托管树 `runtime/node` 优先、缺失回退 PATH。实测 PATH 剥离 node 后整条服务链（supervisor/server/agent runtime）全部跑在 bundled node 上。
- **E2E 实锤并修复**：Tauri 默认"最后一个窗口关闭才退出"被 Windows 挂靠进程的辅助顶层窗口（ConPTY 的 PseudoConsoleWindow，隐藏 conhost 派生）挂住——WM_CLOSE 后主窗销毁、进程不退。修复：退出由主窗口 CloseRequested 显式裁决（`app.exit(0)` 走既有 Exit 清理链），不依赖窗口数归零。
- E2E 结果：staging + bundled node + 无 node PATH 下，窗口关闭全树 446ms 退出、端口释放、并存实例无恙。

已知待办（bundler 阶段）：staging 600MB 需瘦身（devDependencies、playwright 浏览器等）；node 版本应改 pinned 下载而非打包机现场拷贝；provisioner 运行时 `npm install` 离线化（用户无 npm 场景）仍未解。

## 既定方向：框架包 vendor 化（tgz 快照）——已落地，见"第 3 步组装链"

打包输入从"registry 已发布版本"解耦为"相邻框架源码构建即可"：打包时对相邻 AgentDev 仓库构建 → 各包 `npm pack` 产出 tgz → 安装包内按 `file:*.tgz` 安装（npm 对 tgz 是实体安装，无 junction 语义，lock 天然为实体 resolved）。与 `resources/features/*.tgz` 的 feature 仓库模式同构——框架包纳入同一套 tgz 资产管理。

效果：未发版 API、私有改动直接进包（D2 类阻塞消失）；lock 为实体 resolved（D1 消解）；发版节奏不再约束可打包性。

## 顺带修复（验证中实锤的关闭链缺陷）

- **shutdown 死锁（D4）**：`httpServer.close` 死等 runtime 活跃轮询连接、runtime kill 又排在 close 之后——循环等待，实测 `POST /protoclaw/shutdown` 后进程不死。修复：清理序列重排为"先终结 runtime、再关 HTTP"，close 增加 `HTTP_CLOSE_GRACE_MS`（2s）收尾窗口 + `closeAllConnections` 强断。
- **宿主对自主关闭无监督（D5）**：server 自主关闭不给 supervisor 信号，grace 收割永不启动。修复：supervisor 增加 health watchdog（周期探测，ready 后连续失败或 `state=shutting_down` 即启动 grace）。
