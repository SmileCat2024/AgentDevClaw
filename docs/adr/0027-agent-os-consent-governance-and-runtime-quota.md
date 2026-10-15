# ADR 0027: Agent OS 治理面——同意模型与 per-workspace runtime 配额

日期：2026-10-15  
状态：已接受

## 背景与问题

Coder 是无人值守自主编码 APP（ADR-0025），会话只能经调度面创建——`coder_shell`（编程小助手 main agent 的领域工具）、`claw` CLI、ACP 适配器三个渠道，全部经 HTTP 收敛到 server 的 `POST /protoclaw/prebuilt_sessions`。每个会话 spawn 一个 runtime 子进程（node 进程 + LLM 消费），head runtime 常驻到线程归档 / rotation 才退役。当前对"同时存活多少个 runtime"没有任何上限：调度方连环派发（包括 agent 幻觉）可以无限制堆进程。

事实基础（读代码核验）：

- 所有 runtime 拉起路径——会话创建、ACP、服务重启恢复、调度引擎、群聊、IM、memo、线程接续与 activate——收敛于 `startManagedAgent`（server/routes/agent-startup.js）单点。只在某个路由（如 session create）拦限会被其余路径击穿。
- 本地认证是全 server 共享一个内部令牌（`PROTOCLAW_INTERNAL_TOKEN`，spawn 子进程时经 env 注入）：server 无法区分调用方，请求内的 `source` 字段是自报家门、未经认证。
- 现有配置层：`metadata.json`（工作空间作者声明，如 visibility）、`workspace-settings.json`（用户覆盖，目前仅呈现策略）、`workspaces/<id>/feature-config/agent.json`（runtime 装配配置）。

限制数量只是表象，更上游的问题是：谁能创建谁的 agent（调用权）。本 ADR 裁决治理模型的定位，并落定配额——治理面的第一个原语。

## 决策

### 1. 治理哲学：同意模型，不做遏制

权限与配额的价值定位是**用户确认与有序扩展**：让用户的意图始终在场，让系统扩展有序可见。不是防御 agent 恶意——主 agent 拿到满 bash 权限后，对 agent 的绝对技术防御不存在；把工程预算押在赢不了的战场上，不如花在同意机制上。因此：

- 善意假设：治理面防失控、防意外，不防对抗。
- prompt injection 退出技术层射程（有意取舍）；缓解手段是用户确认检查点，不是让系统"防住"。
- 蓝本取 Android 形——manifest 声明 + 用户同意 UX；不取其沙箱野心。与 ADR-0007"entryPoints 是契约约束兼访问控制，不是安全边界"的立场连续。
- 治理面 = 两级同意机制：**配额是一次性策略同意**（用户设一次、批量生效），**权限提示是逐次行动同意**。配额越完善，逐次打扰越少——防同意疲劳是第一设计约束。

### 2. 治理只发生在内核边界

OS 词汇对照（glossary 同步收录）：程序 = agent 装配（agent.js + features + metadata.json）；进程 = runtime 子进程；syscall 边界 = server HTTP/IPC API；内核 = Claw server。配额、权限、审计等治理原语只属于内核边界（server）；应用自律（feature 层预检）不构成强制——CLI 与 ACP 不经过任何 feature。

### 3. 配额：per-workspace 存活 runtime 数，缺省不限

- 计数对象：存活 runtime 子进程数（≈活跃线程的 head runtime；rotation 窗口的新旧并存见第 5 节豁免）。
- 键：agentId（workspace）。权限项定义由 OS 注册，工作空间通过 `metadata.json` 声明自己使用的权限项。Coder 声明 `maxLiveRuntimes`，是首个消费者；编程小助手不声明该项，因此不展示其工作空间设置，也不执行该项配额。不引入"子代理"新分类——与 ADR-0025 身份收敛到 APP 粒度的方向一致。
- 强制点：`startManagedAgent` 单点，覆盖全部拉起路径。
- 缺省：不配置即不限制，行为与现状一致。
- 存储：`workspace-settings.json` 新增 resourcePolicy 节（用户层工作空间资产，与呈现策略覆盖同文件同语义层）。
- 编辑面：全局设置 → 工作空间页；关联宿主也可提供工作空间专属设置面。当前 Coder 同时由全局工作空间设置与智能编码空间的“Coder 策略”页编辑，两者共用 `workspace-settings.json` 中同一权限值。
- 远程主机各管各的配额（远程 Claw 的 server 强制自己主机的）。

### 4. 超限行为：单配额、双角色

系统里只有一个配额值、一处强制。它对用户是策略表达，对调度方是结构化拒绝信号：拒绝报文含当前 runtime 数与可行动建议（归档腾位 / 询问用户 / 放弃）；收到报文后怎么应对是应用层语义，内核不管。不存在"OS 兜底大配额 + 应用自限小配额"两套值。

不排队（掩盖背压，watch 语义被迫复杂化）；不静默驱逐 idle runtime（未经同意动用户可见线程）。

### 5. 存量豁免与 rotation 豁免

- 配额只约束未来 spawn：调低配额不追溯击杀存活 runtime，随归档 / rotation 自然收敛。
- rotation / 接续 spawn（successor 接替旧 head 的短暂重叠窗口）豁免配额——它是生命周期接续不是扩编，且满配额时被拦会死锁线程精简。豁免依据是调用方传给内核的意图标记；内核不反推意图，调用方声明。

### 6. 身份升级缝与三面模型

调用 server API 的主体分三面：**宿主面**（server 内部路由，恒可信）、**用户面**（CLI / ACP / UI，代表用户本人）、**应用面**（runtime 内 feature 的 HTTP 调用，唯一需要管束的面）。当前共享令牌让三面不可分。本期不建身份基建，但为将来按同意模型归因（"这个请求来自 memo 的 runtime"）留缝：

- 配额检查接口签名留调用方身份可选参数位，不写成只认 agentId 的布尔函数。
- 未来授权存储按"主体 → 被授权动作"结构设计，不做全局开关。
- per-child credential（server spawn 时逐子进程发唯一令牌）定位为**诚实的归因工具**——令牌只需对诚实应用可靠，不需对抗伪造。这是治理面升级的唯一 seam，设计时不得堵死。

## 实施顺序

1. **配额模块 + 内核检查**：读 resourcePolicy；在 `startManagedAgent` 加配额判定；调用方传意图标记（rotation 类豁免）；接口签名留身份参数位。
2. **结构化拒绝报文**：含配额值、当前存活数、可行动建议；对 agent 调度方可读可行动。
3. **配置与 UI**：`workspace-settings.js` 扩展 resourcePolicy 节（读写 + 校验）；设置 → 工作空间页数值字段。
4. **调度方预检**：coder_shell 读配额做友好预检提示（UX 层，不承担强制）。
5. **测试**：覆盖满配额拒绝、存量豁免（调低配额不击杀）、rotation 豁免、重启恢复不击穿四条路径。

## 验收不变量

- 任何渠道（coder_shell / CLI / ACP / 群聊 / 恢复 / activate）拉起 runtime 都过同一配额判定；不存在绕过 `startManagedAgent` 检查的 spawn 路径。
- 满配额时新建线程的 spawn 被拒并返回结构化报文；rotation / 接续 spawn 不被拦。
- 调低配额不击杀存活 runtime；其后的新增 spawn 按新值判定。
- 无配置（缺省）时行为与现状一致：不限，热路径零额外行为。
- 拒绝报文是结构化数据（非裸错误字符串），调度方 agent 可解析并行动。

## 不做清单

- 不引入"子代理"新分类或 APP 之下的身份层（配额与未来权限的治理单位都是 workspace）。
- 不建排队队列；不自动驱逐 / 归档 idle runtime。
- 不做应用层第二套配额值。
- 本期不建 per-child credential、权限授予 UI、安装时同意流程——独立 ADR 后行。
- 不为 prompt injection 做技术层防御。
- 不做跨 workspace 的全局总配额。

## 权限模型骨架与后续边界（挂账）

未来权限模型 ADR 的既定输入，本期不实施。统一骨架（2026-10-15 定稿）：

- **权限项 = OS 定义的封闭枚举，每项带类型化值**（布尔 = 授予 / 拒绝；数值 = 上限）。runtime 并发上限是第一个数值型权限项，即本 ADR 落地的 resourcePolicy；未来权限项（可访问范围、可调用服务等）都是往枚举加项，不改模型。
- **主体钉死**：申请的主体是应用作者（metadata.json 声明：需要什么、建议默认值、建议编辑面）；设置的主体是用户（在任意编辑面改实际值）。方向不可逆流——应用只能申请，不能自授。
- **关联工作空间的管理关系**：工作空间可管理其明确关联的子工作空间配置。例如，Coder 是智能编码空间关联的工作空间（metadata 的 `host` 关系），因此智能编码空间可在自身设置面板提供 Coder 策略入口；系统设置与宿主设置操作同一份 Coder 用户配置。此管理关系只授权宿主提供业务编辑面，不取代用户同意，也不转移 OS 的最终强制权。
- **展示策略管编辑面，不管可见性**：工作空间可声明哪些权限项在自己的业务页面呈现编辑控件（编辑面路由，拟名 `editingSurface`，与 workspaceVisibility 命名对齐）；全局设置恒保留全量只读审计视图——编辑位置迁就业务语义，知情权不迁就。
- **三层结构**：作者声明（metadata.json）→ 用户覆盖（workspace-settings.json resourcePolicy）→ 内核强制；未来权限项一律走此三层，不新造通道。
- **立项条件**：第二个权限项（第一个真实跨应用需求）出现时激活。单一权限项不足以校准枚举抽象，已落地的配额保持现形态不重构。

既有子问题（随权限模型 ADR 一并裁决）：

- 治理定位沿用同意模型（第 1 节）；第三方工作空间的同意检查点 = 安装时（feature 仓库 tgz 安装即同意时刻），不是运行时沙箱。
- per-child credential 是归因基建（区分应用面与用户面），不是遏制手段。
- 委托链授权（coder 替编程小助手干活时，授权随链继承还是每跳重授权）在权限模型立项时必须显式裁决。
- 治理面边界 = 经 `startManagedAgent` 的 runtime；应用内自 spawn 的子进程（如 agent-studio 的 studio-sandbox Test Runtime，由 dev agent 进程内 feature 直接拉起）不在此列，收编与否随权限模型 ADR 裁决，配额本期不追。

## 后果

**正面**：资源失控有了内核级闸门，覆盖全部创建渠道；治理面获得统一哲学（同意模型）与统一词汇（OS 对照），后续权限、审计讨论有共同基准；权限模型的定位与升级缝提前锁定，治理面不会碎片化生长。

**代价**：`startManagedAgent` 增加同步判定与意图标记参数，全部调用路径进入测试面；`workspace-settings.json` 语义从呈现策略扩展到资源策略（仍是用户层工作空间资产，语义连续）；拒绝路径要求各调度方（coder_shell / CLI / ACP）能消费结构化报文。

## 关联

- [ADR-0007](0007-capability-registry-as-control-plane.md)：能力控制面与"entryPoints 不是安全边界"的立场，本 ADR 的同意模型是其治理层延伸。
- [ADR-0017](0017-feature-manifest-and-registry.md)：manifest 声明制，权限模型蓝本的注册半边。
- [ADR-0018](0018-feature-panel-communication-transport.md)：声明制授权记录的先例。
- [ADR-0024](0024-app-workspace-eternal-thread-model.md)、[ADR-0025](0025-coder-workspace-promotion.md)：APP 型工作空间与 coder 升格——配额的治理单位由此确定。
