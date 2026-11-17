# ADR 0051: 前端 ESM 绞杀者迁移

日期：2026-11-16
状态：实施中（P0、P1、P2 业务迁移已交付；P3 未实施。保留同步边界和验证限制见 [P2 交付记录](../plans/2026-11-17-frontend-esm-p2-acceptance.md)）
关联：[前端 classic-script 全局共享模式 ESM 渐进拆解计划](../plans/2026-11-16-frontend-esm-strangler-migration.md)（实施细节、阶段划分与工单组织的唯一权威）、[ADR-0044 右栏面板插件化与效果归属](0044-frontend-panel-plugins-and-effect-ownership.md)（P1 渲染入口域与其衔接；插件协议不在本决策改动范围）

## 背景与问题

public/src 采用 classic-script 全局共享模式：全部模块经 index.html 的 `<script>` 标签按固定顺序加载，模块间通信靠 window 上的全局变量与全局函数。以下是 2026-11-16 实测快照（数字会漂移，以基线文件为准）：

- 141 个文件约 8.6 万行，约 120 个 classic script 按固定顺序加载——**加载顺序就是依赖图**（例：`wg-core.js` 头部注释声明"必须在所有 `wg-*.js` 子文件之后加载"）。依赖关系没有任何语言级表达，全靠加载序、注释与人脑维护。
- 全局台账（`.frontend-globals-baseline.json`）：131 个文件、state 799 键 + behavior 2204 键挂在 window 上（其中活跃域 state 689 + behavior 1882，悬置域 state 110 + behavior 322）。`app-core.js` 单文件占 state 170 键 + behavior 75 键，是事实上的上帝模块。
- 耦合枢纽（fan-in 实测，引用文件数排除定义方）：`fetch` 94、`currentLanguage` 88、`escapeHtml` 80、`render` 57、`currentRuntimeAgentId` 48、`container` 42、`renderCurrentMainView` 40、`allAgents` 38、`poll` 36、`getCurrentAgentRecord` 33。
- 重灾消费方（fan-out 实测）：`app-ui.js` 引用 219 个外来全局、`app-main.js` 175、`workspace-actions.js` 99、`sidebar-render.js` 85。
- 112 个测试文件用 vm 沙箱（`test/helpers/frontend-vm.js` 的 `loadSource`）按真实加载序执行 classic 源码——测试面与加载顺序耦合，改加载序即碎测试。

现有防线（`check:frontend-globals` 的 state 层新增即失败、`frontend-script-tags-gate` 的装载清单纪律、ESLint ClawFW 下划线键 owner 规则）都在管增量；全局键的 ratchet 已就位，但存量没有收敛路径。

### 并行重写的教训

Vite + React 并行重写（2026-05 启动，已停摆）曾规划整壳 React 重写（`docs/plans/vite-migration-plan.md`），两条迁移分支（`codex/vite-migration-only`、`feat/vite-migration`）停在"开发进度暂存"；其执行日志自身记录了 React 面板与 classic 实现的功能漂移（缺统计卡、连接卡、用量卡等）。根因是**重写与重设计混在一起**：classic 侧持续演进，平行实现追不上，漂移不可收敛。整壳并行重写路线就此证伪。

与之相对，渐进路线已被反复验证：inline-events 迁移 8 批完成（基线仅剩 3 文件 11 处）、ClawHost 插件宿主带 4 个 APP 插件在产、三个 ratchet 门禁稳定运行。"配方 + 批次 + 门禁"的组织模式在本仓库有实跑记录。

问题归结为：如何在不冻结业务演进、不引入构建链、不重写渲染架构的前提下，把 classic-script 全局共享模式渐进拆解为显式 import/export 的模块图，且每步可回退、可度量。

## 决策

### 1. 原生 ESM，不引入构建器（D1）

模块图用浏览器原生 ESM（`<script type="module">` + import/export）表达，不引入 Vite / esbuild / 任何打包步骤。

理由：模块化工作与 bundler 无关——构建器改变的是打包体验，不拆全局；引入它只增加一条与目标正交的工程线。"静态文件免编译、改后重启 Claw 生效"是现网开发回路的前提，也是桌面包链路的前提，该性质必须保留。Vite 路线已试并停摆（见背景），不走回头路。

### 2. 绞杀者模式 + window 访问器兼容桥（D2）

不做大爆炸切换。新 ESM 域逐个接管（绞杀）classic 实现，迁移期内未迁移的消费方经 window 访问器兼容桥（`Object.defineProperty(window, key, { get, set })`）继续读写，语义完全不变。

理由：88 个文件裸读 `currentLanguage`，任何"一步全改"都会产生一次不可 review 的巨型变更；访问器让读写语义逐键保持，迁移得以按域分步推进、每步可独立回退。桥还有第二个价值：悬置域（本决策不动，见不做清单第 3 条）对内核键的读写全程被访问器兜住，悬置域文件永远不进迁移批次也不会断。

### 3. 迁移单元 = 域，内核先行（D3）

迁移以**域**为单位（markdown 工具、i18n、toast、DOM 引用、会话视图状态、身份解析、agent 列表与聚焦、渲染入口、编排等内核域；域清单初稿与最终键边界见计划文档，由其 P0.8 逐键定案），顺序上**内核域（最高 fan-in）先行**，排序原则："纯函数先行、状态桥随后、编排最后"。

理由：反方向（叶子先行）技术上可行——ESM 能解析全局词法绑定，先迁走的模块继续裸读 classic 全局即可存活——但那意味着门禁看不见、债务不减、反模式被制度化。内核先行保证每一步都在消灭最高 fan-in 的键，进度真实可度量。

### 4. 搬代码不改行为（D4）

每步只做一件事：移动代码 + 补 export + 挂桥，行为零变化。store / 订阅通知、渲染调度等重设计一律推迟到迁移完成后另行立项；既有行为契约（例如 ADR-0010 的侧栏统一投影模型）迁移前后不变。

理由：React 迁移漂移的根因就是重写与重设计混做。两件事拆开后，每步 diff 可 review、测试可对照、任意一步可 revert——每域一步一 commit，访问器桥在消费方归零前始终在，单域回滚不影响其他域。

### 5. 配方 + 批次工单组织（D5）

沿用 inline-events playbook 已被 8 批实跑校准的组织模式：配方文档统管转换规则与时序审计步骤，长尾批次经 claw-coder-dispatch 派发工单（工单只补文件清单与特殊说明），主助手按统一验收标准收货。

理由：这是仓库内唯一有批量实跑记录的迁移组织形态；工单模式把硬门禁（桥债建立期逐键审查增量、消费方收敛期即时撤桥，classic 台账键数净下降）内建进验收，进度不可伪造，防止半途而废产生 classic / ESM / 半 ESM 三套并存形态。

## 桥机制与时序规则（决策层概述）

**为什么必须有桥**——执行时序因果：

1. classic script 顶层代码在 deferred ESM 模块之前执行；
2. async 本身不保证晚于 ESM；但当前 `app-main.js` boot 与主 SSE 等待 auth ready，认证初始化等待 `DOMContentLoaded`，该事件等待静态非 async ESM 执行，因此正常主链已有传递顺序；
3. 因此：**在模块执行前被 classic 触达的状态与函数，须保持原时点可用**：状态可先注册真初值再认领，函数则必须有已核实的初始化顺序或保留唯一 classic 实现。

访问器桥解决值的持有与读写转发，不解决函数初始化的先后关系。classic 相预先注册真实初值时，状态可在 ESM 认领前读写；函数若仅在 ESM 中实现，调用前必须有可验证的初始化顺序，或暂留唯一 classic 实现。审计应覆盖同步首屏、已有认证门控以及绕过门控的实际事件入口，不能以缺少 import 边否认已经存在的 DOM 生命周期依赖。

**桥的形态**（决策级）：`kernel-state.js`（classic，哑存储）是桥接期状态的唯一物理持有方，经 `defineKey` 为每个桥键注册 window 访问器；ESM 域模块装载时 `claim` 认领本域，接管读写转发；终局（消费方归零）状态移入 ESM 模块内部、访问器撤除。bootstrap 级逻辑（`window.fetch` 的 base-path patch 等）永远保持 classic——它们必须在一切之前执行。

**R1–R4 时序规则存在的理由**：四条规则都是上述因果的逐场景落地，写入迁移配方，作为每域转换前的强制审计项——

- **R1**（classic 文件顶层对内核函数的调用 → 该函数保持 classic，直到其调用方完成转换）：守住加载期的同步调用；
- **R2**（boot 首轮触达）：沿真实 await 链核对是否已等待 ESM 执行；只有先于模块初始化的调用才同 R1，不能把所有 async boot 一概视为提前执行；
- **R3**（DOM 引用类键在 boot 由 classic 赋值，哑存储天然安全）：识别无需特殊处理的一类键，避免过度设计；
- **R4**（ESM 域模块首次执行时机 = 首个 import 它的模块执行时；index.html 的 module 入口登记进 `frontend-script-tags-gate`）：把 ESM 侧的执行时机钉进门禁，认领时序可审计。

访问器语义边角（strict 模式写必须成对提供 set、`configurable: true` 供终局撤桥、`enumerable: false` 与顶层 let 行为一致、每域转换前的写点清单审计）与桥的组成部分实现规格见计划文档"桥机制规格"节，本 ADR 不复制。

## 不做清单（显式边界）

1. 不改 innerHTML 渲染管线——不引入 React / diff / 虚拟 DOM。渲染架构是独立议题，且并行重写路线已被证伪。
2. 不引入构建器（无 Vite / esbuild / 打包步骤），保持"静态文件免编译、改后重启 Claw 生效"的开发回路与桌面包链路。
3. 不动悬置域：`wg-*`、`work-group-*`、`im-ui` / `im-actions`、`dispatch-ui` / `dispatch-actions`、`flow-editor.js`、`home-dashboard.js`、`resources-viewer.js`（与 `frontend-script-tags-gate` 的冻结清单同口径；work-group 刻意搁置）。
4. 不动后端、CSS、插件协议（ClawHost / render.js 模板 / panel 协议）。
5. 迁移期间不重设计行为：store / 订阅通知、渲染调度等重设计在迁移完成后另行立项。

## 后果

正面：依赖关系从加载顺序的隐式约定变为显式 import/export 模块图；状态获得唯一 owner，`app-core.js` 上帝模块随内核域抽取消解；进度有显式度量（桥债建立期单列增量、消费方收敛期注销兼容键，classic 台账键数净下降）；悬置域将来重做时直接以 ESM 起写，无缝消费已完成内核。

代价与风险：112 个 vm 沙箱测试文件随批迁移（loader helper 泛化后是机械工作，但量大）；时序破坏是最高风险——对策是 R1/R2 写进配方作强制审计、编排域（fan-in 最高、时序最敏感）最后动；访问器语义边角由桥契约测试覆盖；最大失效模式是半途而废产生第三套并存形态，靠硬门禁与已被 8 批验证的批次组织模式防住。
