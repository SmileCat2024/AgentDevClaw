# 前端 classic-script 全局共享模式 ESM 渐进拆解（绞杀者路线）

日期：2026-11-16
状态：方向已批准（四项决策全部确认，见「核心决策」），P0 未实施

---

## 背景与动机

### 现状（2026-11-16 实测快照）

- `public/src` 141 个文件约 8.6 万行，约 120 个 classic script 按**固定顺序**在 index.html 加载——加载顺序就是依赖图（例：`wg-core.js` 头注明言"必须在所有 wg-*.js 子文件之后加载"）。
- 前端全局台账（`.frontend-globals-baseline.json`）：131 个文件、state 799 键 + behavior 2204 键挂在 window 上。`app-core.js` 单文件占 state 170 键 + behavior 75 键，是事实上的上帝模块。
- 耦合枢纽（fan-in 实测，引用文件数排除定义方）：`fetch` 94、`currentLanguage` 88、`escapeHtml` 80、`render` 57、`currentRuntimeAgentId` 48、`container` 42、`renderCurrentMainView` 40、`allAgents` 38、`poll` 36、`getCurrentAgentRecord` 33。
- 112 个测试文件用 vm 沙箱（`test/helpers/frontend-vm.js` 的 `loadSource`）按真实加载序执行 classic 源码——测试面与加载顺序耦合。
- 重灾消费方（fan-out）：`app-ui.js` 引用 219 个外来全局、`app-main.js` 175、`workspace-actions.js` 99、`sidebar-render.js` 85。

现有防线已经在管增量：`check:frontend-globals`（state 层新增即 exit 1）、`frontend-script-tags-gate`（装载清单纪律）、ESLint ClawFW 下划线键 owner 规则。本计划的目标是**把存量拆掉**，而不是继续只靠围栏。

### 先行尝试与教训

**Vite + React 并行重写（2026-05 启动，已停摆）**：`docs/plans/vite-migration-plan.md` 规划了整壳 React 重写；分支 `codex/vite-migration-only`、`feat/vite-migration` 停在"开发进度暂存"；执行日志（`vite-migration-execution-log.md`）自身记录了 React 面板与 classic 实现的功能漂移（缺统计卡、连接卡、用量卡等）。教训：**整壳并行重写必然漂移失速**——重写与重设计混在一起，classic 侧持续演进，平行实现追不上。

**渐进路线已被反复验证**：inline-events 迁移 8 批完成（`.inline-events-baseline.json` 仅剩 3 文件 11 处）；ClawHost 插件宿主带 4 个 APP 插件在产；三个 ratchet 门禁稳定运行。本计划沿用这套"配方 + 批次 + 门禁"的组织模式。

---

## 目标与非目标

**目标**：把 public/src **活跃域**的 classic-script 全局共享模式渐进拆解为原生 ESM 模块图（显式 import/export、状态唯一 owner），消除"加载顺序即依赖图"；全程系统可运行、每步可回退、门禁可度量。

**非目标**（明确排除）：

1. 不改 innerHTML 渲染管线——不引入 React/diff/虚拟 DOM。渲染架构是独立议题，且并行重写路线已被证伪。
2. 不引入构建器（无 Vite/esbuild/打包步骤），保持"静态文件免编译、改后重启 Claw 生效"的开发回路与桌面包链路。
3. 不动悬置域：`wg-*`、`work-group-*`、`im-ui` / `im-actions`、`dispatch-ui` / `dispatch-actions`、`flow-editor.js`、`home-dashboard.js`、`resources-viewer.js`（与 `frontend-script-tags-gate` 的冻结清单同口径；work-group 刻意搁置）。
4. 不动后端、CSS、插件协议（ClawHost / render.js 模板 / panel 协议）。
5. 迁移期间不重设计行为：store/订阅通知、渲染调度等重设计在迁移完成后另行立项。

---

## 核心决策（2026-11-16 已批准）

| # | 决策 | 决定性理由 |
|---|---|---|
| D1 | **原生 ESM，不引入构建器** | 模块化工作与 bundler 无关；构建器只改打包体验，不拆全局。免编译性质是现网开发回路与桌面包的前提。Vite 路线已试并停摆。 |
| D2 | **绞杀者模式 + window 访问器兼容桥** | 88 个文件裸读 `currentLanguage`，不可能一步全改；访问器（`defineProperty(window, key, {get,set})`）让未迁移消费方读写语义完全不变，迁移可按域分步推进。 |
| D3 | **迁移单元 = 域，内核先行** | 叶子先 ESM 化的结局是模块里继续裸读 classic 全局续命（技术上可行：ESM 能解析全局词法绑定），但门禁看不见、债务不动、反模式制度化。内核先行每步都在消灭最高 fan-in。 |
| D4 | **搬代码不改行为** | 每步只做一件事：移动代码 + export + 挂桥，行为零变化。React 迁移漂移的根因就是重写与重设计混做。 |
| D5 | **配方 + 批次工单组织** | 沿用 inline-events playbook 已被 8 批实跑校准的模式：配方文档统管转换规则，批次工单派发（claw-coder-dispatch），主助手验收。 |

---

## 桥机制规格（本计划最关键的技术设计）

### 为什么需要桥（时序因果）

1. classic script 顶层代码在 deferred ESM 模块**之前**执行；
2. `app-main.js` 的 boot 是 async IIFE，首轮 `loadAgents()` 等调用发生在 boot 微任务窗口——同样**早于** deferred ESM 执行；
3. 因此：**任何 classic 代码同步触达的东西（状态与函数）都不能先于其调用方变成 ESM**。

桥的三个组成部分：

```
┌─ kernel-state.js（classic，哑存储 + 访问器注册 + 认领协议）────────┐
│  store:   Map<domain:key, value>      ← 桥接期状态的唯一物理持有方    │
│  defineKey(domain, key, initial):                                        │
│    Object.defineProperty(window, key, {                                  │
│      get: claimed ? impl.get(key) : store.get(...),                      │
│      set: claimed ? impl.set(key, v) : store.set(...),                   │
│      configurable: true,          // 终局撤除需要                        │
│      enumerable: false,           // 与原顶层 let 一致，不进 for-in      │
│    })                                                                    │
│  claim(domain, impl): ESM 域模块装载时接管该域读写                       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **裸标识符兼容原理**：classic 顶层 `let currentLanguage` 移除后，88 个文件的裸读 `currentLanguage` 沿作用域链落到 window 属性（访问器），读写都不用改。
- **哑存储保持 classic**：保证 early-boot（ESM 未执行）阶段访问器背后有真值可读写。
- **认领（claim）**：ESM 域模块装载时接管该域 get/set；终局（消费方全部迁移）时状态移入 ESM 模块内部、访问器撤除。认领后 classic 写方的赋值经 setter 转发进 ESM 状态，双向持续生效。
- **fetch patch 等 bootstrap 逻辑**（index.html 内联 `app-base-bootstrap`、app-core 对 `window.fetch` 的 base-path patch）永远保持 classic——它们必须在一切之前执行。

### 时序规则（写入迁移配方，每域转换前审计）

- **R1**：classic 文件**顶层**（函数体外）对内核函数的调用 → 该函数保持 classic 定义，直到其调用方完成转换。
- **R2**：boot 微任务窗口（`app-main.js` async IIFE 首轮）触达的函数（`loadAgents`、`loadFeatureTemplateMap`、`waitForViewerReady` 等）同 R1。
- **R3**：DOM 引用类键（`container` 等）在 boot 时由 classic 赋值，哑存储天然安全。
- **R4**：ESM 域模块的首次执行时机 = 首个 import 它的模块执行时；index.html 的 module 入口登记进 `frontend-script-tags-gate`。

### 访问器语义边角（契约测试覆盖）

- strict 模式下对只 getter 属性赋值会抛错 → `set` 必须始终成对提供；
- `configurable: true`（终局 `delete window.x` 撤桥需要）；
- `enumerable: false`（避免 for-in / Object.keys 噪声，与顶层 let 行为一致）；
- 每域转换前 grep 写点清单（谁赋值、赋什么类型），确认 setter 语义（如 DOM 引用、Map/Set、原始值）无特例。

---

## 阶段划分

### P0 地基（一次工程，全部为新增，不动存量消费方）

| # | 交付物 | 说明 |
|---|---|---|
| 0.1 | `public/src/modules/kernel-state.js` | 哑存储 + `defineKey` / `claim` / 桥键计数导出；classic，加载序插在 i18n/app-core 之后（script-tags-gate 更新基线并注明理由） |
| 0.2 | 桥契约测试 | `test/kernel-bridge.test.js`：get/set 转发、认领前后语义、strict 写、delete、枚举不可见、early-boot 可用（在模块执行前读值） |
| 0.3 | 《ESM 迁移配方》 | `docs/plans/esm-migration-playbook.md`，对齐 inline-events playbook 形态（骨架见附录 B） |
| 0.4 | 测试 loader helper | 泛化 `test/helpers/memo-plugin-loader.js` → 通用 ESM 模块加载器（真实 `import()` + stub 注入 + 唯一 query 绕模块缓存） |
| 0.5 | 门禁扩展 | `frontend-script-tags-gate` 增加 `<script type="module">` 入口登记规则（classic 标签维持只减不增）；新增"桥债"指标：统计 `defineKey` 注册数与 `claim` 认领数，ratchet 基线要求**每批之后桥键数不升**（口径独立于现有两层台账，不玩口径游戏——访问器键本质仍是全局状态，必须显式上报并趋于下降） |
| 0.6 | ADR | 撰写 ADR（编号取当前最大 +1）：前端模块化路线——绞杀者 + 访问器桥 + 不引入构建器，记录 D1–D5 与 Vite 停摆教训 |
| 0.7 | 收尾归档 | Vite 半途分支打 tag 归档后删除；`AGENT.md` 前端节补一句指向本文档与 ADR（`vite-migration-plan.md` 的悬置标注已随本文档完成） |
| 0.8 | 域分桶定案 | 以附录 A 的域初稿为底，结合台账逐键核对，产出 P1 各域的最终键清单与迁移顺序确认 |

### P1 内核域抽取（9 域，每域独立一步，一步一 commit）

顺序按「纯函数先行、状态桥随后、编排最后」排列；每步交付 = 代码移动 + ESM export + 桥挂载 + 消费方零改动 + 测试迁移 + 台账修剪。

| 序 | 域 | 主要键（fan-in） | 落点 | 备注 |
|---|---|---|---|---|
| 1 | markdown / HTML 工具 | `escapeHtml`(80)、`renderMarkdown`(11)、`renderer`(19)、`splitMarkdownBlocks` 等 | `markdown-utils.js` → ESM | 纯函数为主（26 export + 1 域内状态 `_currentBleed` + 2 处顶层挂载副作用随迁），首战验证配方与桥全链路 |
| 2 | i18n / 环境 | `currentLanguage`(88)、`currentTheme`、`t`（超短键，未计入 fan-in 快照，迁移时一并处理） | `i18n.js` + `theme-lang.js` 合并为 ESM | 访问器 get/set 桥的首个实战 |
| 3 | toast | `ClawToast`(23) | `toast-notify.js` → ESM | 独立小域，练手 |
| 4 | DOM 引用 | `container`(42)、`sidebar`(24)、`sidebarToggle`、`featurePanel*` 族、`projectDocsetOverlay/Sheet/Toggle`、`workspaceTabsBar`、`ctxMenu` 等 | 新 ESM `dom-refs` 域 + 桥 | boot 赋值，哑存储天然承接；`featurePanelWidth` 是状态需甄别 |
| 5 | 会话视图状态 | `captureSessionViewToken`(12)、`readCurrentSessionViewState`(12)、`applySessionViewPatch`(11)、`commitSessionViewPatch`、版本计数等 | `session-view-state.js` → ESM | 已高度内聚，天然先例 |
| 6 | 身份解析 | `getRuntimeId`(16)、`getRuntimeWorkspaceSessionId`(12)、`getLogicalAgentId`(11)、`getRuntimeContextKey`、viewer 绑定族（`setViewerSessionBinding` / `_viewerSessionBindings`）、`findAgentByIdentity`、`resolveIdentityAliases` 等 | 从 app-core 抽出 ESM `identity` 域 | 与域 7 的边界在 P0.8 定案 |
| 7 | agent 列表与聚焦 | `allAgents`(38)、`focusedAgentId`(25)、`loadAgents`(22)、`renderAgentList`(22)、`pendingPrebuiltAgentIds`、分组计数等 | `sidebar-render` 数据面 + app-core 状态合出 ESM `agent-store` 域 | 大域；`loadAgents` 受 R2 约束，须先审 boot 时序 |
| 8 | 渲染入口 | `renderCurrentMainView`(40)、`renderFeaturePanel`(21)、`activeFeaturePanel`(20)、`lastRenderedWorkspaceHtml`(13)、`selectWorkspaceSurface`、`setPreferredUnitMode` 等 | app-ui 抽出 ESM `render-entry` 域，分发继续走 ClawHost.blocks | 与 ADR-0044 面板体系衔接 |
| 9 | 编排（poll / switch） | `poll`(36)、`getCurrentAgentRecord`(33)、`switchAgent`(16)、`currentRuntimeAgentId`(48)、`currentMessages`(19)、`requestSwitch`、切换守卫族等 | app-main 核心抽 ESM `orchestration` 域 | **最后动**：扇出最大、时序最敏感（frontend-rendering-patterns.md 全篇竞态记录的主战场）；`currentRuntimeAgentId` / `currentMessages` 的归属（并入本域还是会话视图域）在 P0.8 定案 |

### P2 长尾批次（活跃域约 90 个 modules 文件）

- 每批 3–6 个文件 + 对应测试文件，按 fan-out **升序**（便宜的先做：先清小消费方，批内可归零的桥键即时注销）。
- 批次工单经 claw-coder-dispatch 派发，转换规则以《ESM 迁移配方》（P0.3）为准，工单只补充文件清单与特殊说明——完全复刻 inline-events 的组织形态。
- 禁区（每张工单）：悬置域文件、`kernel-state.js`、`action-dispatcher.js`、`index.html`、全部 ratchet 基线文件（frontend-globals / inline-events / import-cycles / kernel-bridge / script-tags）、对应 gate 测试、不属于本批清单的任何文件。
- 预计 15–25 批；先跑 1–2 批试运行校准配方，确认节奏后再放量连续派发。

### P3 终局

- 哑存储状态下沉进各 ESM 域模块，访问器桥全撤（`delete window.x`）；
- `app-core.js` / `app-ui.js` / `app-main.js` 消解为薄壳（仅保留 bootstrap 级逻辑）或删除；
- index.html 只剩：内联 bootstrap + 悬置域 classic 标签 + module 入口；
- 门禁终态：活跃域 classic 文件数 = 0、桥键注册数 = 0、台账只剩悬置域条目；
- 悬置域将来自行重做时直接以 ESM 起写，无缝消费已完成内核。

---

## 度量与验收

**每批（工单验收标准）**：

1. `node --check` 全部通过；
2. 本批目标测试迁移完成且全绿（vm 沙箱 → 真实 import + stub）；
3. `test:core` 全量绿；
4. `check:frontend-globals --update-baseline` 修剪（state/behavior 键数净下降）；
5. 桥债指标不升；
6. 变异抽查（对齐 inline-events 配方做法：删注册键 / 注入坏形态，验证门禁抓得到；恢复用文件备份，严禁 git restore）。

**阶段级**：

- P1 完成：`app-core.js` ≤ 300 行（从 1547 行）、内核域全部 ESM 化、桥键数有初值并开始下降；
- P3 完成：活跃域 classic 文件 = 0、桥键 = 0、index.html 加载清单收敛到 module 入口 + 悬置域。

**回滚**：每域一步一 commit；访问器桥在消费方归零前始终在，任意一步可独立 revert 而不影响其他域。

---

## 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 时序破坏（classic 顶层 / boot 窗口调用已 ESM 化的函数） | 高 | 规则 R1/R2 写进配方为强制审计步骤；P1 顺序已按此排（编排域最后）；boot 时序专项测试在 P0 建立 |
| 访问器语义边角（strict 写 / delete / 枚举 / 意外 shadow） | 中 | 每域转换前 grep 写点清单；桥契约测试全覆盖；访问器统一经 `defineKey` 注册，禁止散装 defineProperty |
| 测试迁移量（112 文件） | 中 | 批内同步迁移，计入工单预算；loader helper 泛化后是机械工作 |
| 悬置域引用的内核键在迁移中断裂 | 中 | 桥访问器全程兜住悬置域的读写（这正是桥的第二个价值）；悬置域文件永不进批 |
| 域边界切错返工 | 低 | P0.8 逐键定案 + 每域独立 commit，切错只回滚单域 |
| 半途而废变成第三套并存形态 | 中 | 桥债指标单调下降是硬门禁；每批都在消灭可见键数，进度不可伪造；配方与工单模式已被 inline-events 8 批验证可持续 |

---

## 附录 A：数据快照（2026-11-16，漂移以基线文件为准）

- 台账：131 文件 / state 799 / behavior 2204；活跃域 state 689 + behavior 1882；悬置域 state 110 + behavior 322。
- fan-in 前 10：`fetch` 94（app-core base-path patch + auth-client）、`currentLanguage` 88、`escapeHtml` 80、`render` 57、`currentRuntimeAgentId` 48、`container` 42、`renderCurrentMainView` 40、`allAgents` 38、`poll` 36、`getCurrentAgentRecord` 33。
- fan-out 前 5：`app-ui.js` 219、`app-main.js` 175、`work-group-ui.js` 171（已死文件，不在本计划范围，随 work-group 域重做处理）、`workspace-actions.js` 99、`sidebar-render.js` 85。
- `app-core.js` state 170 键初分：视口跟随 17、折叠偏好 4、会话缓存 5、导航守卫 6、常量 10、其余约 128（agent 列表、右键菜单、面板 DOM、docset、IM 状态等大杂烩）。

## 附录 B：《ESM 迁移配方》骨架（P0.3 产出全文）

1. **转换步骤**：域文件 → ESM（`export` 化）→ 状态迁入哑存储桶 + `defineKey` → 函数内对外全局引用改为经桥或 import → 装载时 `claim` → 消费方清单核对（grep 消费面）→ 台账修剪。
2. **时序审计**：R1/R2/R3/R4 逐条过，触线项的处理路径。
3. **测试改造**：本批文件的沙箱测试 → 真实 import + stub；`grep -rln "modules/<模块名>.js" test/*.test.js` 找装载方（不按文件名猜）；断言从全局函数直调改为 import 后调用。
4. **禁区**：见 P2 节。
5. **验证要求**：见「度量与验收·每批」。
6. **报告要求**：每文件转换处数、桥键挂载/注销清单与消费面证据、测试改造清单、变异验证结果、未验证项与原因。
