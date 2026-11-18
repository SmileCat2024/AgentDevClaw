# 首屏加载专项（2026-11-18）

只处理“从打开页面到首屏可用”的加载成本，不含传输压缩（minify）与日常切换渲染（L3）。与
[前端 ESM 收敛剩余工作](2026-11-18-frontend-esm-convergence-remaining.md)（S1–S4）是两条正交的线：
S1–S4 改“模块之间怎么取用符号”，本文改“哪些模块进首屏、以什么属性加载”。唯一共享文件改动面的是
“入口拆分”，需与其串行。

## 现状实测（2026-11-18 工作树）

首屏由四段串成，`boot.js` 是最后一条 module 标签并触发首屏渲染，因此“整张模块图求值完”才出骨架：

| 段 | 规模 | 决定因素 |
|---|---|---|
| HTML 解析期阻塞脚本 | 24 个、gzip 233 KB | 无 `defer` 的 classic 在解析期同步执行 |
| 解析后、模块前的 defer | katex 76 KB | katex 两个 defer 标签 |
| module 图求值 | 207 文件 / 3.49 MB / gzip 1095 KB，最长链 **27 层** | 静态 import 图；14 个 module 入口中 13 个 ≤7 层，深链全部来自 `kernel-entry` |
| 首屏数据 | 约 20 个 API | 认证放行后的启动编排 |

`compression` 已启用；静态资源 `no-cache` + ETag（首次加载不省请求）；服务是 HTTP/1.1
（`app.listen`，无 h2）。

## 已落地

### 1. vendor 三个库改 `defer`

`marked` / `hljs` / `diff2html` 三个同步 vendor 脚本加 `defer`。`defer` 的 classic 与 module 同属
“解析完成后按文档顺序执行”的队列，相对顺序不变，只是解除对 HTML 解析的阻塞。

**其余 classic 脚本不可 `defer`**（实测改动后生产启动回归立即失败）：
`kernel-state` / `claw-host` / `right-panel-registry` / `action-dispatcher` 与悬置域脚本构成一张互相
依赖的网，靠“classic 解析相先于一切模块”这台机制抢跑：

- `right-panel-registry`（`ClawPanels`）在模块入口标签之后，被 `app-ui` 求值期取用；改成 `defer`
  后按文档序落到 `kernel-entry` 之后，`app-ui` 拿到 `undefined`，整张图中断（表现为
  `registerFeaturePanel` 读不到 `ClawPanels`、`startApplication` / `renderCurrentMainView` 未注册）。
- 同型：`resources-viewer` 解析期调 `ClawHost.panels.register`；`wg-*` / `im-*` / `dispatch-*` 消费
  `KernelState`。

要大面积 `defer`，前提是先把这些基础设施下沉到模块相（对应 S3/S4），不是加个属性的事。

### 2. 首屏 `modulepreload` 自动注入

`server/shared/modulepreload.js`：server 返回 `/` 与 `/index.html` 时，按**实时** import 图生成
`<link rel="modulepreload">` 注入 `</head>` 前。不落盘清单，图变了自动跟随（前端仍在改 import，
手写清单会持续冲突）。`CLAW_MODULEPRELOAD=0` 关闭；生成失败或未启用时静默回落 `express.static`。

缓存：TTL 内复用；到期对上一轮解析出的文件集合做 `size:mtime` 签名校验，签名变化才重新遍历
（新增 import 必然改动宿主文件的大小或 mtime，因此能触发重建）。当前注入 193 条（207 减 14 个入口），
生成 21 ms、命中 2 ms，HTML gzip 后约 +4 KB。

端到端验证（隔离实例，`AGENTDEV_DATA_DIR=/tmp/... PORT=14231 AGENTDEV_VIEWER_PORT=2031`）：193 条
preload 全部命中、页面零 `pageerror`、零 console error，`window.hljs.getLanguage('javascript')` 为真
（证明真实 hljs 覆盖了 index.html 内联兜底，defer 化未退化）。

## 实测结论：modulepreload 在 HTTP/1.1 下几乎拿不到远程收益

同一隔离实例，改前后各 3 次取中位数（Chromium，CDP 模拟 RTT）：

| 场景 | dcl | 首屏骨架 | 资源条目 |
|---|---|---|---|
| preload 开 · 本地 | 340 | 373 | 250 |
| preload 关 · 本地 | 376 | 417 | 250 |
| preload 开 · 50 ms RTT | 2451 | 2474 | 250 |
| preload 关 · 50 ms RTT | 2438 | 2468 | 250 |

本地有约 10%（≈40 ms）的收益；**50 ms RTT 下无可测收益**（差异在噪声内）。原因是 HTTP/1.1 的
六连接上限：首屏时间由“请求数 ÷ 6 × RTT”决定，modulepreload 只把排队提前，不减少请求数，也不消掉
传输排队。远程场景的主要成本是**请求数**（250），不是发现层数。可选方向：反向代理层开 HTTP/2（多路复用后才轮到瀑布成为主要
成本）；或批量减少首屏模块数。

## 评估后未做

- **katex 延后**：需要新增“加载完成后条件重渲染”机制（块级公式有 `math-render-fallback` 标记可判别，
  行内 `$...$` 没有标记），而重渲染本身要付全量 `<div>` 重建与滚动/焦点恢复；省下的解析成本
  （268 KB 源码）与新增的复杂度、首帧公式退化为原文的可见变化不匹配。
- **入口拆分（面板类模块改按需 `import`）**：单点收益与工程量不成比例。以 `model-settings` 为例，
  它求值末尾 `defineKey` + `claim` 三个桥键，消费方里有 classic 的 `home-dashboard`
  （`typeof openSettings === 'function'` 守卫，缺失即静默失效）与 `chat-renderer` 的
  `chat.openSettings` action；改成动态 import 需要“惰性代理 + 桥键接管”机制，而只省掉 250 个请求里的 1 个。
  要有效必须批量（数十个模块）并统一设计惰性面板装载，属独立立项。
- **diff2html 删除**：早期判断“`public/` 内零消费”是错的。消费方在框架 feature 模板
  （`@agentdevjs/core` 的 `edit/write/batch_replace.render.js` 直接调全局 `Diff2Html.html()`），这些模板经
  `/api/templates/feature` 下发、在浏览器执行，所以标签是运行前提。

## 验收

- `npm run test:core`：6660 项 / 6653 通过 / 3 失败（`desktop-workspace` Windows 已知目录、
  `process-group`×2、`thread-conversation-search` 三条长期平台项）/ 4 跳过；新增 8 项 modulepreload 单测全过。
- `node test/p2-production-boot-browser-check.mjs`：主链 PASS + 延迟相 7 面板 PASS，零 pageerror，
  requests 361（与改动前一致）。
- 隔离实例端到端：见上文。
