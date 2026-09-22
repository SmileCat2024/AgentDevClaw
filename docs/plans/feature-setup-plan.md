# Feature Setup 工作空间计划书

> 本文档记录从 LSP 启动崩溃问题出发，到系统级 Feature 配置管理机制的完整规划。
> 包含问题分析、设计决策过程、实现计划和后续方向。

---

## 一、起因：LSP Feature 启动崩溃

### 1.1 现象

`programming-helper` 启动后使用 LSP 工具时，进程崩溃：

```
Error: spawn typescript-language-server ENOENT
  code: 'ENOENT'
  syscall: 'spawn typescript-language-server'
```

### 1.2 根因分析（三层问题叠加）

| 层 | 位置 | 问题 |
|---|------|------|
| 依赖缺失 | `AgentDev/package.json` | LspFeature 被 export 为框架内置 feature，但 `vscode-jsonrpc` 和 `vscode-languageserver-types` 未声明在 dependencies 中 |
| which() 是 stub | `AgentDev/src/features/lsp/servers.ts:147-150` | `which()` 永远返回传入的 command 字符串本身，不管实际存不存在。导致"二进制不存在就 fallback 到 npx"的逻辑永远不触发 |
| spawn 无 error handler | `servers.ts` 所有 spawn 调用 | `spawn()` 返回的 ChildProcess 没注册 `error` 事件。ENOENT 变成 unhandled error，直接崩进程 |

### 1.3 更深层的问题

LSP Feature 假设了"外部二进制已经装好"。但：

- LSP 服务器是机器级二进制（typescript-language-server、gopls、clangd 等），装一次全局可用
- 14 个语言服务器全部有这个问题——不是 TypeScript 独有的
- "发现、安装、管理外部资源"不是框架该管的事

这引出了一个更一般性的问题：**AgentDev 框架里那些依赖外部资源的 Feature，资源配置该由谁管？**

---

## 二、设计思考

### 2.1 讨论过的方案

**方案 A：留在框架内置，框架自己管发现和安装**

LSP Feature 自己实现 which()、自动下载、PATH 探测等逻辑。

问题：框架不该假设环境。14 种语言服务器的安装方式各不相同（npm、go install、apt、brew），全塞进框架会让 agentdev 包越来越重，且每个消费方（不只是 Claw）都要承担这些依赖。

**方案 B：移到 Claw local-feature**

把 LSP 从框架内置移到 Claw 的 `local-features/lsp/`。

问题：LSP 的通信协议层（JSON-RPC 客户端、LSP 协议封装）对所有消费方都有价值，不该只留在 Claw 侧。

**方案 C（采纳）：框架只提供协议层，产品侧管资源**

框架的 LspFeature 只负责"拿到配置后怎么和 LSP 服务器通信"。外部资源（二进制路径、安装、发现）由产品层（Claw）通过配置表单管理。

### 2.2 核心设计原则：扁平表单

这个系统的本质是：

```
Feature 声明配置需求（getFeatureManifest）
  → Claw 提供表单界面让用户填值
  → 运行时通过 FeatureInitContext.featureConfig 或构造函数传给 Feature
  → Feature 拿到值就用，没拿到就优雅降级
```

不引入 Driver Layer、Registry 抽象、能力协议。就只是 Feature 声明配置 → 表单 → 运行时消费。

这与 `driver-feature-vision.md` 的核心判断一致：

> "先提炼共性行为，不要先提炼设备 taxonomy"
> "先提高可观测性，不要急着提高抽象浓度"

表单就是这个原则的最扁落地。

### 2.3 系统级配置 vs 项目级配置

当前 flow-workspace 中已经有 feature config 表单（audio-feedback 的 enabled/volume/audioPath 等）。但它是**项目级**的——每个 Agent Project 有自己的 feature-configs。

新增的是**系统级**配置：

| 维度 | flow-workspace 的 feature config | 新工作空间的 feature config |
|---|---|---|
| 作用域 | 项目级（每个 Agent Project 不同） | 系统级（所有 agent 共享） |
| 典型内容 | "这个项目用哪些 feature"、"mCP 的额外配置" | "LSP 二进制在哪"、"音量全局默认值" |
| 持久化位置 | workspace state 的 forms['feature-configs'] | 全局配置目录 |
| 变更频率 | 切换项目时变 | 装机时设一次很少动 |

两者不冲突，自然叠加：系统级配置提供默认值，项目级配置可以覆盖。

### 2.4 短期策略

现阶段不讨论系统配置和 flow 项目配置之间的层级关系——还没到必须决策的点。

短期只做一件事：**让 programming-helper 能读到 LSP 等系统级 Feature 的配置**。

不需要新抽象、不需要改框架核心。就是让 programming-helper 的 agent.js 多读一份配置、多传几个参数。和 flow-workspace 已经在做的 `getFeatureConfigFromWorkspace()` 模式完全一样。

等第二个、第三个 agent 也需要类似处理时，再考虑是否要抽共享工具函数。

---

## 三、工作空间命名与定位

### 3.1 名称

**`feature-setup`**

理由：
- 表达的是"给 Feature 做初始配置"这件事
- 没有引入"Driver"、"Registry"等高浓度概念
- 和现有命名风格一致（`flow-workspace`、`dispatch-console`）
- "setup"暗示的是一次性/低频配置，不是持续运行的管理界面

### 3.2 定位

- 是 Claw 的一个预制 workspace，不是框架层的东西
- 当前只负责系统级 Feature 配置
- 纯表单，没有运行时，没有动态内容
- 配置值通过现有的 manifest → featureConfig 管线传到运行时

### 3.3 未来可能但不急于做的

- 系统级 vs 项目级配置的合并策略
- Feature 二进制的自动下载
- 更丰富的 manifest schema（嵌套、数组）
- 统一的"Feature 资源管理"概念抽象

---

## 四、当前可配的系统 Feature 清单

通过代码分析，以下 Feature 有外部资源依赖或运行时配置需求：

### 4.1 短期可配（有明确的外部资源需求）

| Feature | 外部资源 | 配置字段 | 当前状态 |
|---------|----------|----------|----------|
| **LSP** | 14 个语言服务器二进制 | 每个服务器的 `binary` 路径（file 类型） | 无 manifest，which() 是 stub，崩进程 |
| **Audio Feedback** | 音频文件路径 | `enabled`、`volume`、`audioPath` | 已有 manifest，已在 flow-workspace 中工作 |
| **Memory** | CLAUDE.md / 工作目录 | `filename`、`sourceRoot` | 无 manifest |
| **Shell** | shell 二进制、权限范围 | `workspaceDir`、允许的命令范围 | 无 manifest |

### 4.2 中期可配（可能有配置需求但当前不急）

| Feature | 潜在配置 | 说明 |
|---------|----------|------|
| **WebSearch** | 搜索引擎选择、API key | 当前硬编码 |
| **TTS** | 语音引擎选择、语速 | 已有 config 结构 |
| **Visual** | 截图工具路径 | 可能依赖外部工具 |
| **Skill** | 技能目录、发现规则 | 当前从 feature 包自动发现 |

### 4.3 建议的优先级

1. **LSP**：最紧迫，当前直接崩进程，且 14 个语言服务器都有问题
2. **Audio Feedback**：已有 manifest，只需从系统级读取默认值
3. **Shell**：安全敏感，未来可能需要配置权限范围
4. 其余按需跟进

---

## 五、实现计划

### Phase 1：LSP 崩溃修复（AgentDev 框架侧）

**目标**：让 LSP Feature 在二进制不存在时优雅降级，不崩进程。

#### 5.1.1 修复 `which()` 

文件：`D:\code\AgentDev\src\features\lsp\servers.ts`

当前：
```typescript
function which(command: string): string | undefined {
  // Simple implementation
  return command;
}
```

改为：使用 Node.js 的 `child_process.execSync('which ...')` 或 `fs.access()` 实际检测二进制是否存在。在 Windows 上用 `where` 命令，在其他系统上用 `which`。

#### 5.1.2 给所有 spawn 加 error handler

文件：`D:\code\AgentDev\src\features\lsp\servers.ts`

每个 `spawn()` 调用后立即加：
```typescript
proc.on('error', (err) => {
  // 记录日志但不崩进程
});
```

这是一个重复模式（14 个服务器都有），可以抽一个 `safeSpawn()` 辅助函数。

#### 5.1.3 让 LspFeature 优雅降级

文件：`D:\code\AgentDev\src\features\lsp\index.ts`

当 `spawnServer()` 失败时，应该：
- 标记为 broken（已有）
- 日志明确告知哪个服务器不可用
- 工具执行时返回友好错误而非崩溃

#### 5.1.4 重建 AgentDev dist

修改源码后在 `D:\code\AgentDev` 执行 `npm run build`，Claw 侧消费重建后的 dist。

**已完成的前置修复**：
- `vscode-jsonrpc` 和 `vscode-languageserver-types` 已加入 AgentDev 的 `package.json` dependencies
- AgentDev dist 已重建

### Phase 2：LspFeature 声明 Manifest（AgentDev 框架侧）

**目标**：让 LspFeature 通过 `getFeatureManifest()` 暴露配置需求。

文件：`D:\code\AgentDev\src\features\lsp\index.ts`

新增 `getFeatureManifest()` 方法，声明 14 个语言服务器的配置字段：

```typescript
getFeatureManifest(): FeatureManifestDefinition {
  return {
    schemaVersion: 1,
    settings: {
      properties: {
        typescriptBin: {
          type: 'file',
          title: 'TypeScript Language Server',
          description: 'typescript-language-server 二进制路径。留空则自动从 PATH 查找。',
          placeholder: '未配置时自动查找',
        },
        pyrightBin: { /* ... */ },
        goplsBin: { /* ... */ },
        // ... 其余服务器
      },
    },
  };
}
```

运行时消费逻辑：`onInitiate()` 中从 `ctx.featureConfig` 读取用户配置的路径，优先于 which() 的自动发现结果。

### Phase 3：Programming Helper 读取配置（Claw 侧）

**目标**：让 programming-helper 在实例化 LspFeature 时传入系统级配置。

文件：`D:\code\AgentDevClaw\prebuilt-agents\official\programming-helper\agent.js`

改动模式与 flow-workspace 的 `getFeatureConfigFromWorkspace()` 一致：

```javascript
// 读取系统级 feature 配置
const systemFeatureConfig = readSystemFeatureConfig();
const lspConfig = systemFeatureConfig['lsp'] || {};

this.use(new LspFeature({
  workdir: workspaceDir,
  ...lspConfig,  // 用户配置的二进制路径等
}));
```

`readSystemFeatureConfig()` 读取全局配置文件（路径如 `~/.agentdev/AgentDevClaw/feature-setup.json`）。

### Phase 4：Feature Setup 工作空间 UI（Claw 侧）

**目标**：提供可视化界面管理系统级 Feature 配置。

#### 5.4.1 创建预制 workspace

新建：`D:\code\AgentDevClaw\prebuilt-agents\official\feature-setup\`

```
feature-setup/
  metadata.json     ← workspace 定义
  agent.js          ← 最小 agent（可能不需要复杂逻辑）
```

`metadata.json` 结构：

```json
{
  "id": "feature-setup",
  "kind": "workspace",
  "name": { "zh": "功能配置", "en": "Feature Setup" },
  "description": { "zh": "管理系统级功能配置", "en": "Manage system-level feature settings" },
  "icon": "settings",
  "category": "system",
  "enabled": true,
  "features": [],
  "ui": {
    "entry": "home",
    "tabs": [
      { "id": "home", "label": { "zh": "功能配置", "en": "Features" } }
    ],
    "home": {
      "blocks": [
        {
          "id": "feature-configs",
          "type": "config-editor",
          "visibility": "tab:home",
          "title": { "zh": "系统功能配置", "en": "System Feature Settings" }
        }
      ]
    }
  }
}
```

#### 5.4.2 服务端接口

在 `server.js` 中新增：

- `GET /protoclaw/system_feature_config` — 读取全局配置
- `PUT /protoclaw/system_feature_config` — 保存全局配置
- `GET /protoclaw/system_feature_manifests` — 聚合所有有 manifest 的 Feature 的配置定义

配置持久化位置：`~/.agentdev/AgentDevClaw/feature-setup.json`

#### 5.4.3 前端渲染

在 `app-ui.js` 中新增一个 block 渲染器或复用现有 config-editor 类型，用于：

1. 请求 `system_feature_manifests` 获取所有 Feature 的配置定义
2. 请求 `system_feature_config` 获取当前值
3. 按 Feature 分组渲染表单
4. 保存时调用 `PUT system_feature_config`

---

## 六、验证计划

### Phase 1 验证

1. 在未安装 typescript-language-server 的机器上启动 programming-helper
2. 触发 LSP 工具调用（如 lsp_hover）
3. 预期：不崩进程，返回友好错误信息

### Phase 2 验证

1. 调用 `GET /protoclaw/flow_capabilities?agentId=programming-helper`
2. 检查返回的 `featureManifests` 中是否包含 LSP 的 manifest
3. 预期：manifest 中有 14 个 file 类型的配置字段

### Phase 3 验证

1. 手动编辑全局配置文件，设置 typescriptBin 路径
2. 启动 programming-helper，触发 LSP 工具
3. 预期：LSP 使用配置中指定的二进制路径

### Phase 4 验证

1. 在 Claw UI 左侧列表中看到 "功能配置" workspace
2. 点击进入，看到按 Feature 分组的配置表单
3. 修改 LSP 二进制路径并保存
4. 启动 programming-helper，验证使用新路径

---

## 七、关键设计决策记录

> 本节记录讨论过程中做出的关键判断及其理由，便于后续接手者理解"为什么这样选"。

### 7.1 为什么 LSP 留在框架内置而不移到 Claw local-feature

LSP 的通信协议层（JSON-RPC 客户端、LSP 请求/响应封装）对所有 agentdev 消费方都有价值。只有"资源发现和管理"属于产品层。拆开会增加维护成本，且 LSP 协议封装本身没有 Claw 特定的依赖。

### 7.2 为什么不引入 Registry / Driver Layer 抽象

当前系统里需要配置外部资源的 Feature 数量有限（LSP、Audio、Shell），它们的配置需求差异很大（二进制路径 vs 音量 vs 权限），强行统一到一个 Registry 接口会增加不必要的间接层。表单 + featureConfig 管线已经跑通（audio-feedback 验证过），不需要新机制。

### 7.3 为什么短期只给 programming-helper 做处理

flow-workspace 的 feature config 注入已经走通了（MCP 配置、audio-feedback 配置），证明"agent.js 在加载时读配置并传给 Feature"这个模式是可行的。programming-helper 是第二个消费方，复制同样的模式即可。等第三个、第四个消费方出现时再考虑抽共享函数，避免过早抽象。

### 7.4 为什么用 "feature-setup" 而不是 "driver-workspace"

"Driver" 概念在 `driver-feature-vision.md` 中已有讨论，但当前共识是"不宜过早定义设备分类"。用 "feature-setup" 表达的是更中性的事实——这是给 Feature 做初始配置的地方。如果未来系统演化出更明确的"驱动角色"分类，重命名成本低。

### 7.5 系统级配置与项目级配置的关系暂不决策

两者的持久化位置、合并策略、优先级关系都是真实问题，但当前只有 programming-helper 一个消费方。等 flow-workspace 中的 agent 也需要读系统级配置时，再决策合并策略。

---

## 八、与已有文档的关系

- 本计划是 `driver-feature-vision.md` 的**第一个落地动作**——把"系统级 Feature 配置"从理念变成可工作的代码
- 本计划与 `flow-feature-mode-dual-surface-design-plan.md` 是**平行关系**——后者管 Flow 编排层，本计划管系统资源配置层
- 本计划不改 AgentDev 框架核心（`AgentFeature` 接口、`FeatureInitContext`、`featureConfig` 管线），只改具体 Feature 的实现

---

## 九、文件清单

### AgentDev 框架侧（`D:\code\AgentDev`）

| 文件 | 改动 |
|------|------|
| `package.json` | 已完成：添加 vscode-jsonrpc 和 vscode-languageserver-types 依赖 |
| `src/features/lsp/servers.ts` | Phase 1：修复 which()、给 spawn 加 error handler |
| `src/features/lsp/index.ts` | Phase 1：优雅降级；Phase 2：新增 getFeatureManifest()、从 featureConfig 读路径 |
| `src/features/lsp/client.ts` | Phase 1：处理连接失败 |

### Claw 产品侧（`D:\code\AgentDevClaw`）

| 文件 | 改动 |
|------|------|
| `prebuilt-agents/official/programming-helper/agent.js` | Phase 3：读取系统级配置并传给 LspFeature |
| `prebuilt-agents/official/feature-setup/metadata.json` | Phase 4：新建 workspace 定义 |
| `prebuilt-agents/official/feature-setup/agent.js` | Phase 4：新建最小 agent |
| `server.js` | Phase 4：新增系统级配置的读写接口和 manifest 聚合接口 |
| `public/src/app-ui.js` | Phase 4：新增系统级配置表单的渲染逻辑 |
