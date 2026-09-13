# ADR 0017: Feature Manifest v2（并入 package.json）与宿主侧 Feature Registry

日期：2026-09-13
状态：已接受（P1 待实施）
取代：`docs/feature-metadata.md` 所描述的 `agentdev-feature.json`（schemaVersion 1）规范地位

## 背景与问题

Feature 的元信息现状是三套平行体系互相不认识：

1. **npm package.json**：tgz catalog 扫描的事实真相。官方 14 个 tgz 中 10 个仅有 package.json；另 4 个（feishu-bot / rokid-bot / wecom-bot / weixin-bot）含 enrich 脚本时代补写的 v1 manifest，其中 weixin-bot 已发生 manifest 与 package.json 的版本漂移（0.2.0 vs 0.1.0）及 manifest 被打入 `dist/` 的泄漏——双真相源的漂移已是现实，不是假设。
2. **`agentdev-feature.json`（v1）**：主要由 Studio 打包链路产出；`featureTypes` / `requirements` 靠包名正则推断（`inferFeatureTypes`），不是声明。
3. **运行时 `AgentFeature` 接口**：`name` / `description` / `getCapabilities()` / `getFeatureManifest()`；inspector snapshot 透出 name / status / 计数 / description / tools，但不携带包名、版本、来源等注册级元数据。

同时，一个 Agent 实际挂载的 feature 来自六条互不相识的路径：框架 core 直出、`@agentdevjs/*` 生态包、Claw `local-features/`、Claw 根级 `features/`、agent.js 内部类、tgz 仓库解析。六路汇入 inspector 后只剩 kebab 短名 + 源码路径，Features 面板一屏平铺 20+ 卡片，无组织维度；`prebuilt-agents/*/metadata.json` 的 features 短名列表已与真实装配脱节（如已废弃的 `audit` 仍残留）。

根因：**Feature 没有统一的、静态可扫描的注册身份**。面板组织、用户侧挂载入口、feature 仓库管理、Studio 闭环都是这一缺失的受害者。

## 决策

### 1. Manifest v2 并入 `package.json`，独立清单文件退役

对齐 VS Code 扩展（扩展元数据内嵌 package.json：顶层 `displayName` / `categories` / `contributes` / `engines.vscode`）与 babel / jest（以工具名做命名空间字段）的行业惯例：

```jsonc
{
  "name": "@agentdevjs/shell-feature",
  "version": "0.1.0",
  "engines": { "agentdev": "^0.1.0" },   // 替换 v1 的 agentdev.compatible
  "agentdev": {                           // 命名空间字段，schemaVersion 于其内声明
    "schemaVersion": 2,
    "id": "shell",                        // 与运行时 AgentFeature.name 对齐
    "displayName": { "zh": "Shell 执行", "en": "Shell" },
    "capabilities": ["tools", "policy"],  // ★ 多值能力标签（受控词表，见决策 2）
    "provides": {                         // 细粒度形态清单（tools/skills/commands 支持 glob）
      "tools": ["bash", "read", "edit", "trash_*"],
      "skills": [], "commands": [],
      "hooks": false, "mcp": false, "gateway": false
    },
    "depends": [{ "id": "memory", "range": "*" }],  // 对应 static inject + 版本范围
    "requirements": { "external": ["system-shell"] },  // 沿袭 v1 摘要语义
    "compatibility": { "rollback": false }            // 沿袭 v1
  }
}
```

收益：name / version / description / keywords 单一真相，双写漂移结构性消失；`npm pack` 天然携带（`files` 白名单不再需要维护 manifest 条目）；catalog 每 tgz 只解一个 entry。

迁移与退役：

- v1 的 `agentdev-feature.json` 字段一次性搬入 `agentdev` 命名空间字段；官方 tgz 的权威修改位置在 `AgentDev/packages/*` 各包的 package.json，随发版重新 pack。
- `ensureFeatureProjectManifest` 改为校验 / 补写 package.json 的 `agentdev` 字段；`FEATURE_MANIFEST_NAME` 常量与 `enrich-feature-packages.mjs` 脚本随迁移退役。
- `schemas.js` 增加 v2 校验；catalog 优先读 `agentdev` 字段，缺失时回退 v1 / 纯 package.json 并在 UI 标记元数据不完整（沿袭 v1"允许缺失但必须警告"原则）。
- legacy ESM 模块形态（本就不能快照）允许不带静态元信息。
- 存量清理：4 个含 v1 manifest 的官方 tgz 在权威源补 v2 后需清理包内残留并修复 `dist/` 泄漏；`enrich:features` 脚本退役时同步清理其历史产物。
- v2 校验规则增加一致性检查：打包时 `agentdev` 字段的 version 必须与 package.json 顶层 version 一致（weixin-bot 的实际漂移即此类缺陷）。

### 2. 实现形态是多值能力标签，不作面板主分组轴；主分组轴为来源

**修订（P1 实施中推翻初版裁决）**：初版把实现形态定为单值 `category` 并直接作面板主分组，实施后被推翻——tools / commands / mcp 这些词描述的是**能力**，而一个 feature 天然可同时具备多种能力（shell 既提供工具又挂守卫钩子；IM 接线员既是渠道又提供工具）。单值归类迫使做"主要供给形态"的主观裁决，正是应当避免的漂移源。

修正后的模型：

- **能力标签 `capabilities`：多值数组**（受控词表，可从 `provides` 静态推导），描述 feature 具备哪些形态的能力；在详情层展示，不作分组因素。
- **面板主分组轴 = `provenance`（来源）**：单值、正交、天然互斥（一个 feature 只有一个来源），且直接回应原始诉求"区分官方与自己加的"。

能力词表（七类，受控）：

| capability | 形态语义 |
|---|---|
| `tools` | 提供可调用工具（getTools / getAsyncTools） |
| `policy` | 挂生命周期钩子做观察 / 守卫 / 改写 |
| `commands` | 提供 capability 命令 / 配置面 |
| `skills` | 注入技能 / 知识内容 |
| `gateway` | 长驻外部连接 + 消息路由 |
| `mcp` | 挂载 MCP server |
| `protocol` | 宿主协议参与（continuity、dispatch、技能加载机制等给体系看的） |

- 缺省推导规则（静态、可复现，写入规范）：由 `provides` 清单逐项映射，如 `hooks: true → policy`、`mcp: true → mcp`。v1 的包名正则推断仅保留在迁移工具里，运行时不得回退到猜包名。
- 个案裁决须记录理由：如 `SkillFeature` 标 `protocol` 而非 `skills`——它是宿主的技能加载机制，不是内容供给；`skills` 留给以注入技能内容为主要供给的 feature。
- v1 `featureTypes`（tools/mcp/hooks/control/rollback 五值多选）由 `capabilities` 取代——初版 `provides` + 单值 `category` 的组合废弃；`compatibility.rollback` 独立保留。

### 3. displayName 与机器 id 分离，支持 i18n

- `id` 是机器标识（kebab-case，对齐运行时 `AgentFeature.name`）；面板与目录显示 `displayName`，支持 `{ "zh": ..., "en": ... }` 或纯字符串。
- 面板、详情弹窗、仓库页均以 displayName 为主、id 为辅。

### 4. Provenance 是宿主侧投影，不进 manifest

对齐 VS Code"来源 = 安装通道，不自我申报"的原则：来源由装配路径决定，由 Claw 宿主投影：

| provenance | 判定 | 徽章（zh） |
|---|---|---|
| `builtin` | 框架自有包直出：`@agentdevjs/core`、`@agentdevjs/mcp`（UserInputFeature、LspFeature、MCPFeature 等） | 框架 |
| `ecosystem` | 独立 feature 生态包（`@agentdevjs/*-feature`，可插拔能力包） | 生态 |
| `local` | Claw 仓库 local-features / 根级 features | Claw |
| `inline` | agent.js 内部类 / 包装类 | 宿主 |
| `packaged` | tgz 仓库解析（detail.channel 区分 official / custom） | 已安装 |

边界原则：**框架运行必需的自有包（core / mcp）= builtin；可插拔能力包 = ecosystem**。以"是否框架自有包"划界而非"是否 core"，消除 `@agentdevjs/mcp` 这类非 core 自有包的归类歧义。

manifest 不携带 provenance 字段——feature 作者无法正确申报自己的安装位置。inspector 面板由宿主映射表（P1）与统一 Registry（P3）注入。

### 5. Claw 侧统一 Feature Registry（P3）

新建宿主侧聚合层，把六路来源投影成统一记录（`{ id, manifest, provenance, detail: { channel, path, version } }`）：

- 扫描源：tgz catalog（复用现有）+ `local-features/` + 根级 `features/` + core / 生态包清单。
- 同名冲突显式化：现状 catalog 中 custom 静默覆盖 official，Registry 层必须暴露冲突并由用户裁决。
- Registry 是编程小助手用户侧 feature 挂载入口、feature 仓库页升级的数据底座。
- 命名注意：本 Registry 与 ADR-0007 已落地的 Capability Registry 同名不同物——前者是 Feature 的安装目录与来源投影（宿主侧、跨进程），后者是进程内能力注册表（框架侧）。代码与文档行文以 FeatureRegistry / CapabilityRegistry 全称区分。

### 6. 挂载语义：仅装配级，不做热挂载

- **装配级**：修改 agent 的 feature 装配，新会话 / 重建会话生效（等价"安装扩展后重载窗口"）。prebuilt metadata 的 features 短名数组迁移到与 `normalizeAgentMetadata` 一致的对象格式，统一契约后开放受控的追加挂载配置面。
  - 已知标识断层（显式承认，P3 设计时裁决）：两套标识体系不同——对象格式以 npm `package + version` 为键、无 runtime name 字段，而 core 内置 feature（todo / lsp / skill 等）没有独立 npm 包，无法用该格式表达。统一格式必须先裁决 runtime name 的落点（新增字段，或经 `package + export` 映射推导）。
  - 防线缺失：现状 prebuilt metadata 经 agent-discovery 读取时完全不过 schema 校验，"装配与声明脱节"（如已废弃 feature 残留）无机制拦截。统一契约落地时应同步补上 metadata 的 schema 校验。
- **运行时热挂载明确不做**（负面清单）：涉及会话状态一致性与工具注册时序，收益不抵复杂度。会话内控制走既有 tool / hook 级 enable/disable IPC。

### 7. 版本策略

- tgz 链路的不可变快照纪律（同版本不同字节拒绝、sha256 内容寻址）原样保留。
- local / core 直出的 feature 不逐目录 semver——Registry 投影携带宿主（Claw / 框架）发版版本作为派生版本。
- 兼容性经 `engines.agentdev` 表达，Registry 可据此对 Studio 快照做框架升级后的兼容检查。

### 8. 目录收敛

根级 `features/`（force-continuation、step-rotating-model、tickets-build-flow）并入 `local-features/`，六路来源收敛为五路。迁移涉 import 路径与打包清单，单独排期。

### 9. 分期

| 期 | 内容 |
|---|---|
| P1 面板可见性 | 宿主映射表（seed）注入 provenance / displayName / capabilities；面板按来源分组折叠。不依赖 v2 规范，不动框架 |
| P2 规范落地 | manifest v2 定义 + 校验 + 存量迁移 + feature-repository 页升级展示 |
| P3 统一 Registry | 聚合层 + 冲突显式化 + 编程小助手装配级挂载入口 |
| P4 制造端对齐 | Studio 脚手架产出 v2；agent-creator / flow 遗产按新语义重新设计 |

## 备选方案（rejected）

- **独立 `manifest.json`（Chrome / PWA 惯例）**：只是换名字，package.json 与清单的双真相源、version 双写、files 白名单维护问题全部保留。
- **以"用户可理解的能力域"为分类主轴**：抽象层过早且无法静态验证，必然漂移成自由标签云；能力域交给 tags 与 capability 面（slash 菜单）表达。
- **运行时热挂载**：见决策 6，负面清单。
- **local-features 逐目录 semver**：为形式发明假版本号；派生版本 + engines 兼容检查已满足治理需求。
- **provenance 写入 manifest**：feature 作者无法正确申报安装位置，自我申报必然漂移。

## 不变量

- Feature 静态元信息的唯一载体是 package.json 的 `agentdev` 命名空间字段（+ `engines.agentdev`）；不再引入第二份清单文件。
- `capabilities` 取值只能来自受控词表；运行时不得以包名正则推断。
- provenance 只能由宿主（装配层 / Registry）判定，feature 声明不参与。
- 映射表 / Registry 中未命中的 feature 必须可见（兜底分组），不得因元数据缺失而隐藏。
- tgz 仓库同版本不可变纪律不变；已废弃 feature 不得出现在任何装配面。
