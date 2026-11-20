# ADR-0054: 静态装配清单化——装配全面清单驱动

日期：2026-11-20
状态：Accepted（main / coder 先行实施，其余 agent 增量迁移）
关联：[ADR-0052](0052-plugin-model-and-mental-model.md)（内置能力与官方可选插件的对象模型）、
[ADR-0046](0046-plugin-management-product-system.md)（$mount 装配声明与默认装配源）、
[ADR-0028](0028-credential-recovery-and-layering-criteria.md)（框架/应用分层判据）

## 背景

装配的事实存在两种表达形态，认识论是分裂的：

- **动态挂载半边**（外部插件 / 官方可选插件）：`$mount` 声明是配置层里的数据，
  builtin 工厂表（`builtinOptionalFeatures`）是 agent.js 的静态导出，catalog 是
  tgz 注册表。宿主按清单挂载，商店按清单直读（`collectScopeMounts` 零构造）。
- **静态装配半边**（`use()` 产品本体）：装配的唯一表达是 agent.js 构造函数里的
  命令式代码。读取这份事实只能执行它——商店 overview 的
  `collectBaseFeatures` 每请求实例化两个完整 Agent 类（main 27 + coder 15 个
  feature 实例）只为枚举清单。

执行换检查付出过真实代价：d3f03f7f（构造即建面板投影，缺会话身份抛错）证明
"构造无外部副作用"只是约定，修法是给假 runtime 注入 `mode: 'overview'` 并让
Agent 学会识别"我是被建出来展示用的"。这违背"静态装配优先"的立意——静态装配
清单是由模块图唯一决定的静态事实，不应以每请求的运行时执行来重新推导。

## 决策

### 1. 装配全面清单驱动

两类装配统一为"根据清单挂载、根据清单装配"：

- 动态半边维持 `$mount` 声明（不动）；
- 静态半边转成清单：agent.js 导出 `staticFeatureManifest`，构造函数消费清单
  挂载。装配事实从此可直接作为数据读取，不再需要执行构造来检查。

### 2. 清单条目形态（对齐 builtinOptionalFeatures 先例）

```js
export const staticFeatureManifest = [
  { name: 'mcp', create: (ctx) => new MCPFeature(/* 编织后的参数 */) },
  // ...
];
```

- **数组序即挂载序**：钩子注册序与上下文注入器序有语义（如 OutputGuard 刻意
  靠前），顺序即清单顺序，写入即所见。
- **`create(ctx)` 工厂**收装配上下文，逐条目的配置编织逻辑（runtimeIdentity、
  merge 后的层配置、外层 config 展开）随条目内聚，不再散在构造函数主线。
- ctx 契约：`{ workspaceDir, runtimeIdentity, merged, config }`；模块级常量
  （数据根路径、prompt 路径）由工厂闭包持有，不进 ctx。

### 3. 消费位置：构造函数侧共享 helper

`server/shared/static-assembly.js` 的 `mountStaticFeatureManifest(agent,
manifest, ctx)` 在构造函数内（`super()` 之后）执行清单。不变量：**任何构造点
都得到完整装配**——测试、工具、未来消费方直接 `new AgentClass()` 不会拿到
裸 Agent。宿主（run-prebuilt-agent）对静态清单零感知，`$mount` 挂载链路与
fail-fast 语义不变。

（否决"宿主侧挂载静态清单"：会把装配从 Agent 身份割裂给构造方，多个构造点
需要各自记得挂载，且宿主要新增对 ctx 内部字的读取面。）

### 4. fail-fast 取代静默覆盖

- 清单内条目重名：抛错（`use()` 的 Map 静默覆盖从此不可达）。
- 工厂产出实例 `name` 与条目键不一致：抛错（与宿主挂载 builtin 的同名校验
  同口径）。

### 5. 商店读取改清单直读

- `collectBaseFeatures`：清单直读（零构造）；description / surface 声明面
  计数经**每进程一次**的中性 ctx 实例化提取并缓存（"feature 定义即唯一
  权威"保持——展示元数据仍来自真实实例的自声明）。
- 中性 ctx（`merged: {}`、空 sessionId 的 runtimeIdentity）使展示面成为
  feature 的**静态声明面**，不再随用户配置层漂移——今天的行为（构造读真实
  层）本身是执行换检查的副产物。
- builtin 货架合成与 surface 提取同口径做每进程缓存（原实现每请求对每个
  builtin 工厂实例化两次）。
- `mode: 'overview'` 防御分支随商店构造消亡一并移除（CapabilityShellFeature
  的面板开关回归本义：有 sessionId 即建面板）。

### 6. 迁移与边界

- **先行**：main（programming-helper）与 coder——商店 overview 的两个消费
  身份，异常所在地。
- **增量迁移**：其余 agent（qqbot / memo / agent-studio 等）按同模式跟进，
  本 ADR 不设时限；未迁移 agent 行为不变。
- **框架下沉暂缓**：清单 helper 属应用层可达成的能力，按 ADR-0028 判据
  （宿主/装配层够得着不是下沉信号）留在 Claw；若未来框架将清单消费纳入
  Agent 基类，`staticFeatureManifest` 导出形态即为迁移面。

## 后果

- 商店 overview 请求路径零 Agent 构造、零 feature 实例化（首开后缓存）；
  server 进程对运行时类的触碰收敛为惰性一次的展示元数据提取。
- "构造无外部副作用"约定的爆炸半径从每请求缩小到每进程一次；新增静态
  feature = 清单加一行 + 工厂内聚配置，装配顺序一目了然。
- 清单与真实装配不可能漂移——清单**就是**装配的执行来源（与
  f8b62126 当年规避的"平行清单"不同，此处不存在第二份需要同步的事实）。
- 静态清单是代码内数据（工厂闭包），不是 JSON：条目形态保持
  builtinOptionalFeatures 的先例，表达力覆盖多源配置编织。
