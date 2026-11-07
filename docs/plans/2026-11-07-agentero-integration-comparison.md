# Agentero 对接实测：Claw 三件套 vs dsh 插件包（ADR-0044 P6 样本）

> 2026-11-07 · 编程小助手工作空间 · 行数统计自本仓库与 agentero-dsh-plugin
> （D:\GithubDownload\agentero-dsh-plugin）当前源码。
> 背景：以 Agentero（外部产品，Rust CLI + sqlite vault + React UI）为样本，
> 对接进 Claw 插件化体系，对照 dsh 侧官方插件包的同等对接，记录实测成本
> 与体验差距。理论框架见 ADR-0044。

## 一、对接形态（本侧三件套）

| 面 | 形态 | 权威文件 | 后端 |
|---|---|---|---|
| Agent 工具 | local-feature（spawn CLI `--json` 薄包装） | `local-features/agentero/src/index.ts` | agentero CLI 官方契约 |
| 面板 UI | React 容器型 ESM 插件（懒装载） | `public/src/plugins/agentero-library/` | server 只读路由 |
| 数据面 | server 路由（node:sqlite 只读直查） | `server/routes/agentero.js` | `{vault}/.agentero/catalog.sqlite` |

vault 路径配置走 feature 四层作用域（`agentero.vaultPath`，设置菜单可改）。
面板与工具面互不依赖：面板不 spawn CLI，工具面不经 server 路由（各走
各的后端）。

## 二、成本实测

### 本侧（含测试）

| 部分 | 行数 | 说明 |
|---|---|---|
| feature 工具面 | 340 | 4 工具：papers / paper_get / paper_set_read / vault_info |
| server 数据面 | 174 | 2 只读端点：status / papers |
| 面板入口（重写） | 253 | 替换 dsh 客户端入口（client/index.ts，cordis apply 形态，225 行） |
| shim 三件 | 75 | store 30 + Toast 28 + 类型桩 17 |
| React 构建器 | 202 | esbuild + tailwind scope 后处理（公共基建，非 agentero 专属） |
| 测试 | 458 | feature 17 例 + 路由 11 例 + React 基建 6 例 |
| **新增小计** | **1502** | |
| 组件复用（拷贝零修改） | 1530 | 11 tsx + papers.ts + theme.css，仅 tailwind import 路径 1 行 |

宿主改动 8 文件，其中逻辑改动 3 处共约 23 行：agent.js 装配 +5、
panel-plugins 登记 +16、server.js 挂载 +2；其余为构建配置（package.json
scripts、build-all 链、tsconfig/barrel 登记）。

### dsh 侧（同源对照，packages/ 实测行数）

| 包 | 行数 | 职责 |
|---|---|---|
| host | 5212 | 5 个模型工具 + webServer 路由 + 注册（三面板共享） |
| library | 1507 | 本侧对等的面板组件（即上表复用的 1530 行来源） |
| notes | 1763 | 笔记面板（本侧未做） |
| pdf | 6034 | PDF 阅读器（本侧未做） |
| cordis.patch.yml | 9 | 装载声明：用户一行 `dsh plugin add` 装齐四包 |

同范围对齐（只算 library + host 中 library 相关部分）：dsh 作者侧约
1507 + host 路由/工具分摊；本侧作者侧 1502 新增 + 1530 复用。
**两侧量级相当**；差异不在行数，在下面第四节的责任位置。

## 三、React 搬迁实测

- 复用率：组件层 1530 行**零修改**（含 radix-ui 交互原语、lucide 图标、
  自绘 Button/Input）；结构性适配仅 2 处——删 dsh 入口换 Claw 入口、
  `shim/alias.json` 构建期拦截 dsh 宿主包。
- shim 面实测（75 行）：`createSnapshotStore`（快照 store）、`Toast`
  （自绘提示条）、类型桩。面板对 dsh 宿主的依赖收窄到 3 个包
  （store / primitives / slots），UI 主体全走通用 React 生态
  （radix-ui / lucide-react），不依赖 dsh 的 UI 库渲染。
- 构建产物：1680KB 未压缩（react 19.3.1 + react-dom + radix + lucide 全
  打入；保持可调试不 minify，本地服务无带宽压力）。懒装载：仅用户点开
  面板才拉取。
- 样式：tailwind v4 scoped 编译（`.agentero-library` 作用域，54KB），
  注入/移除随 mountBody/unmountBody 生命周期；frontend-globals 门禁
  dist 忽略域，react 运行时不进全局暴露扫描。
- 浏览器冒烟证据：fixture 3 篇全渲染（含标签 chips）、'GPT-4' 过滤
  1/3、console 零错误、关闭重开生命周期干净（style 元素移除未在浏览器
  层直接断言，由同款逻辑的 node 单测覆盖）。

## 四、整合责任位置（体验差距的根源）

| 用户动作 | dsh | Claw（本次官方集成后） |
|---|---|---|
| 安装 | `dsh plugin add` 一行（四包 + yml 原子装载） | 升级即有（三件套随版本发布），零配置零常驻进程 |
| 配置 | 宿主设置页 | feature 配置四层作用域 + 设置菜单 |
| 生效 | 重启宿主一次 | 面板立即可见；Agent 工具下个会话生效（ADR-0017 热挂否决） |

官方集成形态下两侧体验已对齐。**真实差距在第三方作者视角**：dsh 作者
发一个包 = 工具 + 路由 + UI 一次交付；Claw 的三个面分属三套机制
（feature / 路由改宿主 / ESM 插件清单），没有一个统一的"包"能声明三面
贡献——整合成本落在宿主侧而非插件作者侧（本次官方集成由本仓库承担）。
这是"大单元"要填的洞。

## 五、MCP 第三通道（Claw 独有）

agentero 自带 streamable HTTP MCP server（`agentero mcp serve`），Claw
MCP 网关原生支持该传输——零代码接入任何装了 MCPFeature 的 agent。实测
能力差异：`vault.search`（正文关键词检索，命中带物理页码）与 `page.read`
（按页阅读）**是 MCP surface 独有，CLI 无对应子命令**——本侧 feature
工具面只做元数据级检索。CLI 包装（spawn）与 MCP 两条路线的取舍：
本侧选 CLI 包装，换工具语义可控与无常驻进程；MCP 通道保留给需要正文
检索的场景（代价：serve 常驻 + vault 路径写死在启动参数）。

## 六、大单元验收指标（源自本次实测暴露的缺口）

1. **外部登记即见面板**——三面贡献随一个外部登记进 UI，不改宿主源码清单
2. **新会话即得工具**——feature 装载不重启服务（tgz 链路已备，契约待统一）
3. **数据面不依赖宿主发版**——外部插件可自带数据后端或受控贡献路由

## 七、已知边界

- 窄视口下的详情交互尚未完成浏览器验收。容器内边距和主题适配已有面板级修正；Claw 的窄窗级联会自动折叠右栏，需先验证窄窗打开面板的可达布局，再确认表格宽度与间距。
- 面板只读：写操作（导入/导出/标签/删除/下载）经 shim reject + Toast
  提示引导走 CLI / Agent 工具；面板未裁写按钮（组件保持上游原样）
- 正文检索 / 按页阅读不在工具面（见第五节）
- 分发环节缺失：本样本是仓库内集成（发版即用），第三方外部装载机制
  （`claw plugin add` 对等物）不存在——P3 懒装载执行层已备，差发现层
- fixture vault：3 篇（arXiv 1706.03762 / 2005.14165 / 2303.08774），
  真实 CLI 生成，位于 `~/.agentdev/AgentDevClaw/agentero-fixture-vault`
  （`agentero vault list` 可见）
