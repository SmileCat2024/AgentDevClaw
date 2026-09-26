# Feature 安装与激活分离：设计决策与实施记录

状态：**切片 1–4 已完成并 E2E 验收（2026-09-26）**。本文记录"安装前移"重构的动机、分层承诺与既定决策，供后续维护对照。

## 动机：执行点放错主客位置

原实现把"安装"（重操作：npm provision、网络、数十秒）与"激活"（轻操作：从缓存环境挂载 feature）捆绑，整体推迟到 agent 启动期（`pendingFeatureMounts` → provisioner）。后果：

- 反馈断裂：面板点"安装"只写声明（毫秒），真实安装失败发生在下次重启，错误离操作很远；
- 启动被安装污染：首次挂载组合时 agent 就绪要等几十秒 npm install；
- 打包桌面应用放大问题：用户"第一次挂载"发生在无明确 UI 反馈的启动期。

重构后分工：**重操作发生在有 UI 反馈的按钮时刻（install API 复用同一 provisioner），启动只做轻消费（缓存命中秒级挂载），启动期自愈链保留为兜底**（手工改配置/迁移机器/环境被删时重建）。

## 分层承诺（L0–L2）

| 层 | 场景 | 承诺 |
|---|---|---|
| L0 | 内置 Agent + 随包生态 | 零依赖零网络；装配线永不运行（静态装配不经过 provisioner） |
| L1 | 导入现成 tgz / 商店安装 | 首次装配需联网；npm 随包分发（`runtime/` 内置）；vendor 声明解析；来源不明 tgz 给完整性提示 |
| L2a | Studio 验证与入仓 | 产品能力，继承内置工具链（Test Runtime 用 `process.execPath`） |
| L2b | Studio 源码编写与构建 | 生产者机器需 node/git，缺什么明确提示 |

调研印证（DSH / openclaw）：核心依赖随包不经过包管理器、插件安装用内置工具链且 PATH 只注入装配进程、registry 精确版本 + `--ignore-scripts` + 完整性校验。Claw 现状已具备最后一组（强制精确版本、ignore-scripts、同版本不同字节拒绝）。

## 既定决策（2026-09-26 对齐）

- 安装等待：同步阻塞 + 按钮秒计时（"安装中… 12s"）；进度流留待使用反馈再评估，接口形状不变。
- 安装中关弹窗：服务端单飞队列继续跑完，重开商店从 overview 自然看到结果（`installing` 状态）。
- 环境缺失警告（Q3=C）：轻量黄色横幅"插件环境需要恢复：下次启动时自动完成，不影响已装配声明" + "立即恢复"按钮（调 rebuild API）；不用"待重建"等工程术语。
- 升级路径：本轮不做，移除→添加过渡。
- npm/node 随包版本：pinned 下载（pack:desktop 下载缓存，首跑联网），不用打包机现场。
- 移除操作：保持前端直写配置层，不收口 API。
- 官方货架（`resources/features/*.tgz`）**不进用户商店货架**（既有刻意设计：它们是官方 agent 静态装配的原料）；商店可安装区 = 用户导入的 tgz + builtin 静态开关。

## 实施切片

- **切片 1（`c680ddb`）**：provisioner 支持 vendor 声明（打包树 `file:vendor/*.tgz` → 读 tgz 实体版本参与依赖 hash，manifest sha256 digest 保证同版本重打包缓存失效）+ npm 内置解析（`runtime/npm-cli.js` 优先，PATH 兜底）。E2E：staging 树 PATH 仅 System32 下首装 16.3s、二次 0s 缓存命中。
- **切片 2（`6ae0c95`）**：`POST /api/feature-store/install`（provision 成功才写声明，原子性）与 `/rebuild`；服务端单飞（进行中第二请求 `install_busy`）；overview 增 `envReady`（身份级组合 hash → 环境 lock 存在性）与 `installing`。
- **切片 3（`8eb6a59`）**：商店三态（`+ 添加` → `安装中… Ns` 禁用 → 已装配/失败横幅+重试）；builtin 卡片走瞬时声明路径（静态装配开关，无中间态，与 tgz 卡片交互刻意不同）；挂载页环境恢复横幅；文案区分"安装立即完成，对新会话生效"。
- **切片 4（本轮）**：双形态 E2E（staging 打包树实测）+ 断网场景验证；修复全新数据目录首装 ENOENT（声明写入前自建父目录）；npm fetch 重试收敛（断网失败 8min+ → ~70s）。

## E2E 验收（2026-09-26，隔离实例实测）

隔离要点：`AGENTDEV_DATA_DIR` + 独立 `PORT`/`AGENTDEV_VIEWER_PORT` + `AGENTDEV_UDS_PATH=''`（清空继承值，让数据根派生接管）+ `CLAW_SUPERVISOR_HOST_PING_MS` 调大（临时父进程场景豁免 ppid watchdog）。两个脚印：bash 工具环境无法创建命名管道（任何名字 EACCES），隔离实例须用 PowerShell 拉起；agent 工具会话继承主实例的 `AGENTDEV_UDS_PATH`，不显式清空会撞全局管道。

验收通过项：tgz 安装三态全周期（`安装中… 1s` → 已装配 `@agentdevjs/memory-feature@0.1.0`，真实 provision + lock 落盘）；失败原子性（安装失败声明不落盘）；环境恢复流（删环境目录 → 警告横幅 → 立即恢复 → 进行态 → lock 重建、横幅消失）；builtin 与 tgz 声明共存。

验收中实锤并修复：

- **install 链 builtin 过滤缺失**：身份已有 builtin 声明（如 playwright-shell）时安装仓库包，plan 构造把无 package 字段的 builtin 条目也送进解析器，报"包不存在：undefined"。修复：与 rebuild/readiness 同口径过滤（含回归测试）。
- **invoke() 端口白名单**：`app-core.js` 的 HTTP 回退硬编码 `port === '1420'`，任何非默认端口实例（自定义 PORT/隔离/反代）`loadAgents` 全链失败。修复：判定改为 http(s) 协议（相对 fetch 自然同源）。
- **tauri-bridge.js 残留 script 标签**：2a 删除文件时漏了 `index.html` 的引用（404 + MIME 报错刷屏）。教训：删除资产的"零引用"检查必须覆盖 HTML script/link 标签，不能只查 JS import。
- **builtin 挂载徽标 `undefined@undefined`**：挂载页对 builtin 条目渲染 `package@version` 徽标。修复：builtin 只显示"扩展"来源徽标。
- **全新数据目录首装 ENOENT**（切片 4，staging 实测）：install 声明写入绕过 PUT 路由的目录预建，`feature-config/` 父目录不存在时 `writeFileSync` 直接 ENOENT——打包形态首次安装必炸（开发态夹具预建了层文件，单测未覆盖）。修复：`writeDeclaration` 自建父目录（与 PUT 写入链同口径），含回归测试。
- **断网下 npm 重试链过长**（切片 4 实测）：npm 默认 fetch 重试（retries=2, maxtimeout=60s）在 registry 不可达时多包重试超 8 分钟不放，同步等待的安装语义不可接受。修复：provisioner 注入 `--fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=15000`，断网失败 ~70s 暴露。

## 切片 4 双形态 E2E（staging 打包树实测，2026-09-26）

环境：`dist/desktop-staging`（vendor 声明 + pinned bundled node/npm）、PATH 仅 `C:\Windows\System32`、PowerShell 拉起隔离实例。结果：

- **install 全链**：memory-feature 经 bundled npm 完成环境 provision（registry 传递依赖 zod/@hono 等真实拉取），声明原子落盘，`runtime-lock` hash 与 digest 一致；二次调用 416ms 缓存命中。
- **overview**：mounts（repository 声明、missing=false）+ packages（用户货架）+ envReady（main ready/hasEnv、coder 无声明 ready）+ installing 单飞状态，全部正确。
- **断网**（registry 指死端口 + 空 npm cache，等价新机器真实断网）：安装失败返回真实 npm 错误（ECONNREFUSED，`network` 分类正则命中）、声明不落盘、已装配包 envReady 不受影响（离线可复用）；失败时长收敛后 ~70s。
- 测试脚注：npm 用户级 cache 会在断网时回退命中（开发机上"断网"模拟必须同时清 cache 才真实）；`HTTPS_PROXY` 环境变量对 npm 11 的 registry 请求不生效，模拟网络故障用 `npm_config_registry` 指死端口最可靠。

## 剩余待办

- provisioner 完全离线（L1 无网机器）——远期，不承诺；
- 来源不明 tgz 的完整性提示（openclaw 式哈希确认）——随安全批次；
- Studio L2b 的环境检测提示。
