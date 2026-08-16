# ADV 对 DSH 的差异化战略与架构调整规划（2026-08）

> 状态：战略定稿，分项实施中
> 关联文档：[feature-creator-plan.md](feature-creator-plan.md)（feature creator 专项方案）

## 1. 背景

### 1.1 撞车事件

DeepSeek 官方发布了 dsh（deepseek-harness），developer preview，基于 Cordis 运行时，架构口号是 "everything is a plugin"。其核心思想与 ADV 长期开发的方向高度一致：**真实 agent 需要能力的组装，组装过程会遇到依赖关系、钩子执行顺序等问题，框架要提供解决方案**。

dsh 走得更激进：所有东西（LLM adapter、tool registry、agent loop、沙箱、甚至 Web UI）都是可运行时替换的插件，用 realm/双平面/四种 dispatch mode/四层配置叠加来维护这一切的组合秩序。背后有学术论文背书（《A Programming Paradigm for Spatiotemporal Composability》），团队日均在 280 个 commit 量级。

### 1.2 竞争格局判断

- dsh 是**库思维推向极致**的 harness：服务"想改装 harness 本身"的人。它的官方插件教程第一步是 clone 整个仓库 + pnpm install。
- ADV 是**产品工厂思维**：feature 是粗粒度的能力包（工具+UI+skills+策略+配置整包），服务"要快速拼出能用的 agent"的人。`npx agentdev-create-feature` 零仓库依赖起步。
- 两者的插件不在同一层：dsh plugin 是 harness 内脏（零件），ADV feature 是 agent 能力（装备）。dsh 生态长大后的产出大部分走 MCP 中立层，与本项目的 feature 生态几乎不重叠。
- 类比定位：dsh 当 Unity（组装自由+生态市场），ADV 当 Unreal（含电池全家桶+成品品质）。不比轻、比交付完整。

### 1.3 本文档的目的

把与 dsh 竞争的**长期方向**和**立即补课清单**定稿，作为后续所有架构决策的检验基准。

## 2. 核心判据：什么样的差异是 dsh 追不上的

dsh 处于 preview 期，可以随意做破坏性修改——因此**任何"API 长什么样"的差异（命名、语法、UI 布局、脚手架命令），它一个版本周期就能抄走**。

真正追不上的差异只有一种：**实现它需要 dsh 公开放弃一个已经当成卖点承诺的东西**。

dsh 已公开承诺的不变量（均出自其 README / 文档 / 论文）：

| 不变量 | 出处 |
|---|---|
| 一切皆插件 | README 原话 |
| 会话日志只追加、不可修改 | "model-visible means logged" |
| LLM 请求是日志的纯函数 | reconstructability 不变量 |
| 运行时四层配置叠加（profile/bundle/patch/overlay） | "时空可组合" 论文的实体 |
| 插件贡献是"注册效果"，无状态契约 | Cordis 模型 |
| inspect-first：能力目录只能运行时查 | 官方 skill 教义 |

推翻任何一条的代价不是工程量，是公信力。**我们的每一张长期牌都必须落在这些不变量的反面。**

## 3. 三层差异化体系

```
范式层（论文锁死，dsh 结构性追不上）
  会话=状态机：活回滚 + feature 状态契约 + 副作用诚实
  组合=装配时：静态意图面 + 装配预检 + feature 可测试性

承诺层（时间换来的，dsh 一年内给不了）
  Feature API 冻结 + 语义化版本
  分层稳定契约（核心冻结 / 能力库宽松 / 宿主随意）

体验层（会被追上，用来在窗口期拉人）
  15 分钟热载开发循环、观测首屏、装配 GUI、token 归因
```

**检验纪律：对外每一句宣传，先问"dsb 补完体验层短板后这句话还成立吗"，成立才说。**

### 3.1 范式层详解

**会话是状态机，不是日志。**

dsh 的会话是 append-only log，"重来"只有 fork（开新会话，git branch 语义）。ADV 的会话支持活会话内回滚（undo 语义）：

- Step 级：react-loop 每 step 前 checkpoint（context + 全部 feature 状态快照）
- Call 级：rollbackToCall 增量回滚（v2 边界截断 + 运行态恢复），rollbackHistory 持久化
- 命名 checkpoint：模型在运行中用 checkpoint/rollback 工具自控修正
- feature 状态参与回滚：captureState/restoreState/beforeRollback/afterRollback——回滚时所有 feature 状态一起回到过去，全局一致
- 两级反悔结构：branch 管方向性重来（重、审计诚实），rollback 管高频局部反悔（轻、高效）。这是刻意设计，不合并。

dsh 做活回滚必须允许改日志——摧毁它崩溃恢复/审计/fork 的一整条产品线；做 feature 状态快照要给"注册效果"模型加状态机契约。两个都是地基级自推翻。

**组合发生在装配时，不是运行时。**

dsh 的插件在运行时 mount 时注册，顺序靠 realm/prepend/toolOrder 协调，错误在 mount 时报。ADV 的组合在装配时（编辑/预检阶段）完成解析：

- 三原语（观察/拦截/改写）在装配时静态可分析
- 依赖（inject）在装配时拓扑排序
- 冲突（policy 重复、命名重复）在装配时报错并给修复建议
- 错误暴露时机：dsh = "运行时报得很响"，ADV = "装配时就亮红"

dsh 要追就得删掉 overlay/patch 体系——那是它论文的实体。

### 3.2 承诺层详解

三层结构（核心框架 agentdev / 标准能力库 / 宿主 claw），各给一档稳定承诺：

| 层 | 内容 | 稳定性 |
|---|---|---|
| 核心框架 | AgentFeature 契约、执行循环、观测、时光机 | 冻结 + semver |
| 标准能力库 | 20 个自带 feature | 宽松，兼做"feature 该怎么写"的活教材 |
| 宿主产品 | claw 的装配/UI/流水线 | 随意，快速迭代 |

dsh 一切皆插件意味着 API 面是全运行时，冻结等于冻结一切，所以它只能预告 breaking changes。我们可以给生态作者 dsh 给不了的承诺。**对想攒生态的平台，稳定承诺比任何功能都值钱。**

### 3.3 体验层详解（窗口牌，做但不押注）

- dev 热载循环（详见工作项 B 与 feature-creator-plan.md）
- 观测首屏化（详见工作项 C）
- 装配 GUI 与 dry-run
- token 归因（usage 三级统计已内置，接 usage-ledger 做"每个 feature 花了多少 token"）

这些 dsh 都会补（工程量问题，非架构问题），作用是在窗口期内建立品类心智。

## 4. 立即补课：六大工作项

### A. 框架补课：三原语 + 顺序法则 + inject（一切的前提）

**现状诊断**（2026-08 代码级核实）：

- 钩子系统已有三原语雏形：`executeVoid`（观察者）、`executeDecision`（决策，Approve/Deny 短路 + Continue 传递）、`executeTransform`（链式变换，异常跳过不中断链）
- 但 kind 与 lifecycle 硬编码绑定（ToolFinished 永远是观察者、ToolUse 永远是决策），作者意图不显式
- 执行顺序 = features Map 插入序 = 装配顺序，无角色/优先级/依赖，跨 feature 顺序是隐式契约
- `getFeature` 是运行时软失败 locator（undefined 延迟爆炸）
- 宿主正向回调与 feature 反向钩子双轨并存，两套心智
- 已知坑：void 钩子意外返回 `'approve'` 字符串会静默短路同批观察者

**改造**（2026-08-15 审查修订：实现方式由装饰器改为静态声明）：

1. 三原语由作者静态声明：`static hooks: Record<methodName, { kind: 'observe' | 'guard' | 'transform', role?: 'policy' | 'advisor' }>`——kind 在类定义时即静态可读，这是装配预检与静态分析的前提。**不采用 @ 装饰器**：Claw 预制 agent 为纯 .js 无法消费装饰器，且静态声明对 JS/TS 等价、零运行时依赖。observe 类钩子执行后由框架直接丢弃返回值（消灭 void 钩子意外返回 `'approve'` 的短路坑）
2. `guard` 声明支持 `role: 'policy' | 'advisor'`：policy 先于 advisor 执行；一次装配出现两个 policy = 装配错误（报名报错，不许运行时碰运气）
3. `AgentFeature` 静态 `inject: string[]`：装配时拓扑排序初始化序，缺依赖 = 启动错误带修复建议；getFeature 降级为可选软查找
4. 双轨归一：宿主正向回调合并进 hooksRegistry 或明确标记为宿主私用
5. 返回值类型校验进生产（轻量警告）

**顺序三法则**（全部顺序语义，没有第四条）：

| 原语 | 顺序 |
|---|---|
| Observe | 无序（返回值被框架丢弃，对结果无影响；框架按拓扑序执行仅为日志可复现） |
| Guard | policy → advisor；首个 Approve/Deny 短路 |
| init / Transform | inject 拓扑序 / 装配序 |

**验收**：20 个自带 feature 全部迁移；README 印出"每原语一职责一顺序语义一错误时机"对照表；旧写法给出明确迁移报错。

**注意**：三原语必须设计成**装配时静态可分析**的形态——这是 D（装配预检）能查的东西，也是范式层牌成立的前提。只做语法糖不做静态化，这张牌就降级为 API 层差异被抄走。

### B. dev 热载通道（最锐的演示武器）

**现状诊断**：开发循环为"发布态流程错误地摊到每次改动上"：tsup build → npm pack → 入库 → rm node_modules + npm install → 重启 agent（丢会话），单轮 30s-2min。

**已有地基**（2026-08-15 复核修正，前三项实锤存在）：`mountFeature`（运行时挂载，agent 不重启，agent.ts L1534）、`removeFeature`（卸载工具+钩子+injectors，agent.ts L1215）、`captureState/restoreState`（状态快照，feature.ts L264/269；注意为可选方法，开工 B 前需摸底 20 个 feature 的实现覆盖率）。cache-busting import 为新实现项——此前记录的"flow.js 雏形"经两仓库排查不存在，予以撤销。

**改造**：

1. agentdev 新增 `reloadFeature(featureName, moduleUrl)`：remove（保留旧实例引用）→ cache-busting import → captureState 迁移 → mount；**init 失败自动回退旧实例**（新旧原子切换，比 dsh 的 undefine-重来更稳）
2. claw 提供 dev 通道：watch + 防抖 + TS 直载（Node 原生 strip-types，tsx 兜底）→ 调 reloadFeature → 保存即生效（2 秒内）
3. reload 事件进 debug 协议 + 时间线（自动 diff 前后工具列表/钩子注册）
4. 跨实例身份防御：框架内身份判断钉死在 `feature.name` 字符串键，不依赖 instanceof（cache-busting 每次产生新模块实例，同名类跨实例 instanceof 必失败）

**设计依据（信任域分离）**：dsh 的热插拔把"不可信代码注入活进程"当一等场景（所以有审批、无 import、多轮等待协议），官方自认动态模式只是 probing；正式开发又要 clone 全仓库。ADV 承认开发场景注入的是**本机可信源码**——免审批、完整 TS/npm 生态、秒级生效；不可信能力注入走 MCP 外部进程（进程边界即沙箱，plugin-compat-feature 已铺路）。

**验收**：对话中改 feature 源码保存 → 2 秒内生效 → 会话不丢 → init 失败自动回退，四条全过。

### C. 观测外露：15 分钟杀手场景

**现状诊断**：约 4400 行观测地基（debug-hub 1149 + viewer-worker 2608 + debugger-mcp 618；AsyncLocalStorage 日志作用域、console 全局桥接、hook inspector、跨进程输入请求恢复），但全部埋在框架层，新用户前十秒看不到任何一样。

**改造**：锁死单一场景——"写第一个 feature 的 15 分钟全程可见"：脚手架生成 → agent 挂载 → 首次工具调用 → 钩子触发 → 日志过滤，全部落在一条时间线上，人不切窗口。

这是六项中性价比最高的：东西已存在，缺的只是露出来。

### D. 装配预检：四查 + 修复建议 + dry-run

装配编辑时执行：

1. 依赖完整性：inject 图缺失/成环，报错带修复建议
2. policy 冲突：两个 policy 报 feature 名，要求二选一或改 advisor
3. 命名冲突：工具重名、prompt 段 id 重复、渲染槽位冲突
4. manifest 校验：schema + 默认值 + 表单预览

外加 dry-run 预览：装配完成后该 agent 将拥有的工具/skills/prompt 清单。

依赖 A 先落地（查的就是 A 产出的声明）。**验收：dsh 要 mount 时才报的错，ADV 在装配编辑时就亮红。**

### E. 时光机纪律：诚实回滚四件套

**已核实的破绽**：

- `rollbackToCall` v2 路径（agent.ts L806-816）截断 context 后被截消息从数组移除——**物理丢失**，违背自身"会话不可修改"原则（branch 的设计初衷）
- 副作用盲区：回滚不回滚 shell/HTTP/文件副作用，模型"忘记"已执行的操作，可能重复执行危险命令
- 白名单快照（captureState 手写）漏字段 = 静默残缺
- branch 缺 lineage/parent 引用；branch 后部分 turn 缺 checkpoint（findMissingCheckpoints 警告存在但未修复）

**四件套**：

1. **截断归档（tombstone）**：被截内容归档进会话文件旁的 tombstone 区，rollbackHistory 记录截断范围——任何回滚可回答"曾经发生过什么"
2. **副作用诚实卡**：回滚确认时列出不可撤销副作用清单（shell/HTTP/文件）；回滚完成后向模型注入现实快照（"以下副作用已发生，勿重复执行"）。**把最大安全坑变成最亮的产品点：反悔是诚实的反悔**。措辞纪律（2026-08-15 审查补充）：对外叙事须精确为"**回滚后**的现实快照注入"——dsh 的 TOOL_OUTCOME_UNKNOWN 已占崩溃恢复场景（结果未知，重试需验证），两者相邻不重叠，混用会显得没读懂对方
3. **深度预算**：回滚超过 N 次 call / 跨 compaction 边界 / 涉及未快照状态时，提示"这次建议开分支"——让"局部性"假设从直觉变成被守卫的不变量
4. **branch 修补**：parent lineage 引用 + 缺失 checkpoint 修补

### F. 持续：稳定性收口 + dsh 监控

1. **compaction 一族稳定性收口**（postmortem 清单逐项关闭）：trim 不稳定、语义错位、deterministic 设计等。这是所有牌的前提——观测品质会把崩溃放大成高清直播。
2. **dsh release note 双周监控**，重点盯两个前兆包：
   - `cordis-host-runner`（动态加载能力）动了 = 热载体验窗口收窄 → 加速 B/C **【2026-08-15 审查注记：已实质触发】**——`extensions/` 下 cordis-host-runner / cordis-client-runner / tool-cordis / ui-cordis 四包已落地，随 0.1.0-rc.5 于 08-13 npm 公开发布（全家族 221 包 public）。另出现官方 HMR（cordis-plugin-hmr + client/hmr），但其文档自认 "state lost, deliberately out" 与 "No failure rollback"——B 的差异化点仍成立，按预案加速 B/C
   - inspector 族（观测）动了 = 观测 UI 窗口收窄 → 加速 C（当前无名为 inspector 的包；观测走 runtime-diagnostics、session-telemetry、capability-seams 自动文档）

## 5. 零兼容债原则的正确用法

单人项目对大团队的唯一速度特权：**随时可以推翻重铸框架原语，不像 dsh 每 commit 都要维持 50+ 包内部一致性 + 生态迁移**。

但用法必须精确：

- **对内**：随时重铸。每季度审计一次"今天从零设计还会这样吗"，答案是否的直接推翻。
- **对外**：承诺一旦出口就进入冻结。三原语、Feature 契约、时光机语义，在窗口期内定型后就是给生态的 API 稳定承诺。

**零兼容债是窗口期内的燃料，不是常态。烧完窗口期，剩下的叫"稳定承诺"——那是 dsh 未来一年给不了的东西。**

时间窗口估计：dsh 已到 0.1.0-rc.5，按其活跃度 6-12 个月内出稳定版并承诺 API。窗口关闭前必须完成：A（补课）、B（热载）、C（观测外露），并用它们钉住品类心智。

## 6. 防守策略

### 6.1 价值长在地基里

判据：**砍掉 UI 后，这个功能在框架执行路径里占几行？**占得越多越防得住。

- 观测（AsyncLocalStorage 贯穿异步链、console 桥、hook 三层在执行器里）= 深嵌 ✓
- 时光机（checkpoint 在 react-loop、状态快照在 feature 契约）= 深嵌 ✓
- UI 糖衣（时间线渲染、装配界面）= 会被抄，不作为护城河

### 6.2 两层资产结构

agentdev 是独立 npm 包，不是 claw 私产。最坏情况下宿主产品层被碾压，agentdev 作为轻量框架（2026-08-15 复核：src/core 共 20118 行，其中核心执行路径约 1.6 万行、观测三件约 4375 行——此前"~12k"记录已过时）仍有独立生存空间。

### 6.3 威胁形态评估（2026-08 定稿）

| 威胁 | 评估 | 依据 |
|---|---|---|
| 大佬 fork dsh 砍复杂度做轻量版 | 死路 | dsh 价值密度在 Cordis 范式里，砍机制=留空壳；rebase 日均 280 commit 上游累死 |
| dsh 官方出 opinionated preset | 可能但有限 | 是"运行时组合的默认配置"，报错时机/概念税不变——Unity 出模板包，不是变 Unreal |
| 第三方用 dsh SDK 做 agent 产品 | 真威胁 | Python SDK/JSON-RPC 现成；防御 = 价值沉地基 + 品类心智 + 快速迭代 |

### 6.4 预警信号（触发即行动）

1. dsh 宣布稳定 API 承诺 → 窗口开始收窄，加速占位
2. dsh 生态出现"产品层"项目 → 48 小时内对标复盘
3. dsh 官方推出装配 UI 或观测 UI → 直接竞争开始，检查地基内嵌深度
4. 知名开发者/团队宣布基于 dsh 的产品 → 同 2

## 7. 不做清单（简单性即护城河）

- 不做 harness 内脏插槽（不开放换 agent loop、换 session log）
- 不做运行时 eval 动态插件（不可信注入走 MCP；信任域分离见 B）
- 不做多层配置叠加（配置保持一层）
- 不做通用插件化框架（那是 dsh 主场，用户不需要换 agent loop）
- 新互操作需求先问"现有接口（Decision 链、input-lease、call-arbiter）能不能表达"；非加不可时加**冻结接口**而非开放扩展点。目标：整个框架互操作面一页纸写完（dsh 光"新行为放哪"的表就 15+ 行）

## 8. 附：dsh 调查关键事实（2026-08，证据存档）

- 事件矩阵（自动生成）：`agent/pre-step` 一个 waterfall 切点 15 个第一方监听者；`session/event` 25 个；emit/waterfall/serial/parallel 四模式混用
- 官方承认注册顺序不可靠："registration order is a plugin-load artifact"（system-prompt README），为此发明 toolOrder 显式清单，且"改了列表的 waterfall 监听者自己负责确定性"——确定性责任转嫁给插件作者
- defensive-patterns.md 存在本身（33 行全是"实际发生过或差点发生的 bug"），含"followup 无因果归因""一个坏监听器不能饿死其他监听器"等
- 动态插件（cordis_mount）："disappears on restart. It is for probing, not for shipping a capability"——官方自认动态与正式形态存在能力断层
- 创造模式 skill（cordis-plugin-development，420 行）：第一军规 inspect-first（API 不可推断只能运行时查）；最难规则 realm/双平面（"the rule that catches people"），解法是"copy 现有 preset 再改"
- 会话模型：fork 是唯一"重来"方式。其持久化有两套（2026-08-15 复核修正，此前把 checkpoint 误记为压缩检查点）：session-checkpoint-policy 是崩溃恢复屏障（LLM 请求前/副作用工具 dispatch 前/step 边界落盘，恢复时给模型标注 TOOL_OUTCOME_UNKNOWN），compaction 是向前摘要——**两者皆非回滚**，与本项目时光机方向相反
- npm 形态（2026-08-15 新增）：全家族 221 包公开发布，README 主推 `npx @deepseek-ai/dsh web`——运行侧已零仓库起步；但两个插件教程仍要求 clone 全仓库 + source build（双面构建体系所致：host/client 两套 tsconfig 分别编译，本地插件的 client 半边需 bundle watcher 在场）
