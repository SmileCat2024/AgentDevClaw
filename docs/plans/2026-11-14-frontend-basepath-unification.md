# 前端 base-path 统一化：子路径部署的系统性修复方案

日期：2026-11-14
状态：P1–P4 已实施（本文档含实施记录）；P5 可选增强未实施

## 实施记录（2026-11-14）

**代码改动**（前端全部为静态文件，`no-cache` 协商缓存，浏览器刷新即生效）：

| 文件 | 改动 |
|---|---|
| `public/src/modules/claw-host.js` | `loadPlugin()` import 前过 `__PROTOCLAW_APP_URL__` 归一化 |
| `public/index.html` | bootstrap 补 EventSource 构造器 patch（与 fetch patch 同层） |
| `public/src/modules/voice-input.js` / `sidebar-operations.js` | WS / sendBeacon URL 过 helper |
| `annotations.js` / `bg-panel.js` / `feature-communication.js` / `sse-client.js` | 4 处 EventSource 使用点显式 helper 化（不依赖构造器 patch 兜底） |
| `test/frontend-claw-host.test.js` | +2 用例：装载必经 helper 且返回值流向 import；helper 缺席容错 |
| `test/base-path-deployment.test.js` | +3 用例：EventSource patch 前缀改写 / 恒等 / 缺席守卫 |
| `test/base-path-gate.test.js` | 新增门禁：4 条规则 + 规则自测 + public/ 全量扫描零违规（已做变异验证：注入坏形态能精确抓到） |
| `/etc/nginx/sites-available/aitennis.conf` | 撤除 `/protoclaw/`、`/api/agents/` 历史特判与当日两条 `/src/` 临时桥，仅剩 `/advclaw/` 前缀代理（改前备份 `aitennis.conf.bak.20261114_182955`） |

**验证证据链**：

1. 单测：bootstrap 映射行为、loadPlugin 收口、门禁辨别力（规则自测 + 真实变异）——全绿。
2. 零特判网关模拟（本地反代仅前缀转发）：探针页 `import('/advclaw/src/panel-plugins/git.js')` 与 memo 插件（含内部依赖链 notes/reminders/overview/settings）装载成功；真实页面 163 请求零脱离前缀。
3. 线上真实 nginx（撤特判后）：页面 163 请求零脱离前缀、零 404。

**回归说明**：全量 `test:core` 存在 6 个失败（react-panels 构建产物缺失 ×3、Windows 路径假设 ×3），均为存量环境类，与本次改动零交集；本次改动面相关测试全绿。

**遗留**：P5 未实施；P3-7 的取证手法未固化进 `claw-test-isolation` 技能手册（手法记录见本文档附录，需要时可迁移）；用户浏览器需刷新一次拉取新前端。

## 背景与问题

### 现象

网关子路径部署（nginx `location /advclaw/ { proxy_pass http://127.0.0.1:14200/; }`）下，右侧面板插件装载失败：

```
[claw-host] 插件装载失败： panel-git /src/panel-plugins/git.js
TypeError: Failed to fetch dynamically imported module: http://<host>/src/panel-plugins/git.js  (404)
[claw-host] 插件装载失败： panel-session-controls /src/panel-plugins/session-controls.js  (同上)
```

请求脱离 `/advclaw` 前缀落到网关根 location（另一服务），404。

### 既有机制（2026-07-18，commit 63c05b2e "fix: support gateway subpath deployments"）

`public/index.html` 头部 `app-base-bootstrap` 内联脚本建立了三件套：

1. 从 `location.pathname` 自动推导 `basePath`，动态注入 `<base href>` 标签——救 `index.html` 里的 `./` 相对引用（script/link 标签）；
2. monkey-patch `window.fetch`——把所有站点根绝对路径（`/api/...`、`/protoclaw/...`）字符串/Request 重写为带前缀路径。**300+ 处绝对路径 fetch 全靠这层活着**；
3. 暴露 `window.__PROTOCLAW_BASE_PATH__` 与 `window.__PROTOCLAW_APP_URL__(path)` helper（应用内路径 → 带前缀路径）。

测试 `test/base-path-deployment.test.js` 覆盖了 bootstrap 自身行为。

### 浏览器实证（2026-11-14，本地子路径反代 + Chromium headless HAR 取证）

用临时反代（`/advclaw/` → 14200，根路径模拟他服务返回 404）复现线上环境，探针页实证：

| 事实 | 结论 |
|---|---|
| 全部静态资源（`./` 相对引用）200，`document.baseURI` = `.../advclaw/` | base 标签注入生效，相对引用正常 |
| 经 fetch patch 的 API 请求全部带前缀（`/advclaw/protoclaw/...`、`/advclaw/api/...`） | fetch patch 有效 |
| **`import('/src/modules/panel-plugins.js')` 请求了无前缀的 `/src/...` → 404** | **classic script 的动态 import 不跟随动态插入的 base 标签**（Chromium 实测） |
| 无 patch 时 `fetch('/protoclaw/...')` 也不带前缀 | URL 解析规则：`/` 开头的 path-absolute 不继承 base 的路径部分——**base 标签救不了绝对路径**，fetch 全靠 patch |

### 绕过面清单（当前部署下逐通道判定）

| 通道 | 使用点 | 现状保护 | 子路径下（无网关特判） |
|---|---|---|---|
| 静态 script/link（`./` 相对） | index.html | base 标签 | ✅ 正常 |
| fetch 站点根绝对路径 | 全前端 300+ 处 | fetch patch | ✅ 正常 |
| `import()` 动态模块装载 | `claw-host.js loadPlugin()`（面板插件 + 全部 APP 插件唯一装载入口）；`template-engine.js`（已手工过 helper，唯一例外） | 无 | ❌ 404（本次事故） |
| `import()` 装载的清单 URL | `panel-plugins.js`（ADR-0044 P3/P4）、`plugin-manifest.js`（memo / claw-guide / agent-studio / coder）、server 下发 `/protoclaw/feature-assets/...`（ADR-0045，`plugin-ui.js` 拼径） | 无 | ❌ 同上（memo 等 APP 插件一并受影响，尚未触发） |
| EventSource（SSE） | `sse-client.js`、`annotations.js`、`feature-communication.js`、`bg-panel.js`，均 `/protoclaw/...` | 无（线上靠网关 `/protoclaw/` 根级特判兜住） | ❌ 脱离前缀 |
| WebSocket | `voice-input.js` 手拼 `location.host + '/protoclaw/speech_stream'` | 无（同上） | ❌ 脱离前缀 |
| sendBeacon | `sidebar-operations.js` `/protoclaw/sidebar_diagnostics/events` | 无（同上） | ❌ 脱离前缀 |

### 漂移根因（组织层）

63c05b2e 那轮修复是「逐点撒 helper」打法：修了当轮已知的 6 处，但机制无门禁——此后新增的装载点（panel-plugins、plugin-manifest 扩容、feature-ui-registry、claw-host loadPlugin）全部绕过 helper。**没有机器防线，同类问题必然随演进复发。**

## 业界做法对照

| 方案 | 代表 | 要点 | 对本项目适用性 |
|---|---|---|---|
| 构建期注入 base | Vite `base`、webpack `publicPath`、CRA `homepage` | 产物里的资产 URL 构建期改写；部署路径变则需重建 | ❌ `public/` 是无构建 classic script 直接 serve |
| 服务端配置声明 | Grafana `root_url` + `serve_from_sub_path`、Jenkins `--prefix`、JupyterHub `--base-url` | base 是服务端声明的配置，渲染时注入/路由挂前缀，前端不猜测 | ⚠️ 可行但要用户配置 + server 改造，留作 P5 可选增强 |
| 框架统一改写 | **Next.js `basePath`、Nuxt `router.base`** | **业务代码写应用内路径，框架在装配/加载的单一位置统一映射到部署路径；业务无感、天然不漏** | ✅ **本方案主形态**：映射收口到装载入口 + 引导层 patch，而非使用点逐个改 |
| 相对路径 + base 标签 | GitHub Pages 子目录 SPA 常见 | 全相对引用 | ❌ 实证失败：base 救不了 `/` 绝对路径与动态 import |
| API patch 兜底 | 少数 legacy 系统 | patch 能覆盖的面有限 | ⚠️ 仅作为引导层收口手段之一（fetch 已有、EventSource 待补），不作为唯一防线 |

**取舍结论**：学 Next.js basePath 的哲学——「使用点声明应用内路径，宿主统一映射」。base 来源暂保留 bootstrap 自动探测（零配置、已验证覆盖常见反代形态：nginx sub-path / Traefik / 容器平台 path-based routing）；映射收口在少数几个宿主级位置；用静态扫描门禁替代人肉纪律。服务端声明式配置（Grafana 模式）作为后续增强，兼容自动探测。

## 设计定案

| 决策点 | 定案 | 理由 |
|---|---|---|
| base 来源 | 保留 bootstrap 自动探测，不引入服务端配置 | 零运维；已验证形态覆盖；Grafana 式注入留 P5 |
| 权威映射 API | `window.__PROTOCLAW_APP_URL__`（现状沿用，语义不变） | 已有消费者与测试；重命名收益小迁移大 |
| `import()` 收口位置 | **`claw-host.js loadPlugin()` 内统一归一化**（`__PROTOCLAW_APP_URL__?.(url) \|\| url`） | 唯一插件装载宿主入口；一处改动同时治好面板插件、全部 APP 插件、server 下发 URL；使用点（三个清单）保持纯声明不动 |
| EventSource | bootstrap 内 patch 构造器（与 fetch patch 同层并列，同源 `/` 开头路径才改写） | 4 处使用点全是 `/protoclaw/` 根路径；构造器级收口让新代码写根路径也天然正确，杜绝逐点漂移 |
| WebSocket / sendBeacon | 使用点过 helper（WS 拼径处、beacon 调用处各 1 处） | 点少且形态特殊（手拼 origin），不值得 patch |
| server 下发 URL 协议 | 不变：`/protoclaw/feature-assets/...` 应用内路径，消费端 loadPlugin 归一化 | 「URL 相对站点根（应用根）」声明语义保持；部署前缀是前端宿主职责，server 不感知 |
| 防漂移门禁 | 新增静态扫描测试（先例：script-tags-gate、frontend-globals ratchet）：拦截裸 `import('/...')`、`new EventSource('/...')`、`sendBeacon('/...')`、`WebSocket` 手拼根路径字面量 | 与上轮修复的本质区别：机器防线替代记性 |
| 网关要求 | 前端收编后撤除 `/protoclaw/`、`/api/agents/` 根级特判，仅留前缀代理一条 | 项目对网关零特殊要求（本次目标） |
| 根部署兼容 | basePath 为空时全链路恒等 | 现有 base-path-deployment.test.js 恒等语义用例已覆盖，扩展保持 |

## 实施清单

### P1 — 修复本次事故（最小面）

1. `claw-host.js loadPlugin()`：`await import(url)` 前过 `window.__PROTOCLAW_APP_URL__?.(url) || url`（与 template-engine.js:252 现有写法同构）。
2. `test/frontend-claw-host.test.js` 增用例：注入 fake helper 断言装载 URL 被改写；helper 缺席时行为不变。

> 用户侧行为说明：`loadState` 的 failed 态不自动重试，部署修复后已报错页面需刷新一次。

### P2 — 剩余通道收编

3. `app-base-bootstrap` 补 EventSource 构造器 patch（仅同源、`/` 开头字符串路径；basePath 为空时恒等）。`withBasePath` 复用现有实现。
4. `voice-input.js` WS 拼径过 helper；`sidebar-operations.js` sendBeacon 过 helper（或统一改走同文件已有的 fetch keepalive 路径）。

### P3 — 门禁与测试固化

5. 新增 `test/base-path-gate.test.js` 静态扫描 `public/src/**`：
   - 裸 `import(` 或 `await import(` 后跟 `/` 开头字符串字面量 → 拦截（合法例外：已过 helper 的调用、claw-host loadPlugin 收口点白名单）；
   - `new EventSource('/...)`、`navigator.sendBeacon('/...)`、`new WebSocket` 含根路径拼接 → 拦截。
6. `test/base-path-deployment.test.js` 扩展：EventSource patch 行为用例（vm 沙箱，同 bootstrap 既有测法）。
7. 端到端取证手法固化：子路径反代脚本 + 探针页 + HAR 断言，写入 `claw-test-isolation` 技能手册（手动验收用，不进 npm test——依赖 playwright 资产）。本次调查的探针实现可直接复用（临时文件 `/tmp/subpath-proxy.mjs` 的思路，见附录）。

### P4 — 部署侧简化（运维动作）

8. 网关撤除 `/protoclaw/`、`/api/agents/` 根级特判，仅保留：

```nginx
location /advclaw/ { proxy_pass http://127.0.0.1:14200/; }
```

验收后再撤，撤除后按 P3-7 手法回归一轮。

### P5 — 可选增强（后续独立决策）

9. helper 契约写入 `docs/reference/frontend-rendering-patterns.md`（新增「资源定位与部署前缀」节）并考虑 ADR 化。
10. Grafana 式服务端声明 base（环境变量 → serve index.html 时注入），兼容并优先于自动探测：覆盖「pathname 与真实挂载点不一致」的异形代理。

## 验收标准

1. 子路径反代（**仅前缀代理、零根级特判**）下：面板插件（git / session-controls）装载成功；memo / coder / agent-studio APP 插件装载成功；SSE 连接、语音 WS、诊断 beacon 全部带前缀。
2. 根路径部署行为零变化（`npm run test:core` 全绿，含既有 base-path 用例）。
3. `base-path-gate` 扫描零违规。
4. 网关配置缩减为单条前缀代理后，上述 1 仍成立。

## 附录：本次取证手法（可复现）

- 临时子路径反代：node:http 脚本，`/advclaw/*` 剥前缀转发 127.0.0.1:14200，其余路径 404 模拟网关根 location 他服务。
- 探针页（反代内联路由）：复刻 bootstrap 的 base 注入，观测三类解析——动态 import、绝对路径 fetch、EventSource。
- 取证：playwright `har` 动词抓网络（本地 headless chromium），按请求 URL 前缀与状态码判定各通道行为。
