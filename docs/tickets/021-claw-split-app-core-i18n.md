# 021 — app-core.js 拆分（i18n）与全局状态增量纪律

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：2026-08-23 前端回涨文件调研 grill 会话（Q1-Q4）；I18N 区段纯数据性已核实
- **类型**：纯数据搬移（move not refactor）+ 文档约定
- **前置**：020 完成后执行（同批串行；与 022 零交集可并行）

## 背景

`public/src/app-core.js` 当前 1,996 行（2026-06-01 以来 41 个 feature commit 直加，
无一次专门重构）。构成：viewer fetch 代理 + web picker ~260 / invoke ~95 / 67 个 DOM
引用 ~65 / 全局状态声明 ~180 / runtime cache ~130 / **I18N 字典 ~718（36%）** /
工具函数 ~400。

I18N 区段（快照行号 882-1599）为纯 zh/en 双语字典，无任何函数；`t()` 为纯查表
函数（1600-1604）。二者是全文件最大且风险最低的可拆块。

app-core.js 是 80 个 modules 的共享底座（`currentRuntimeAgentId` 被 27 个文件引用、
`allAgents` 22 个），全量 ClawState 集中化已明确**不做**（高扰动、易引入 stale-读
bug）；改为增量纪律约束增长。

## 执行步骤

1. 新建 `public/src/i18n.js`：迁入 `const I18N = {...}`（完整 zh/en 双语字典）与
   `function t(key)`。不改动任何词条内容。
2. `index.html` 将 `i18n.js` 插在 `app-core.js` 之前（app-core 自身工具函数运行时
   调用 `t()`）。
3. `CLAUDE.md`「前端结构现状」章节追加状态纪律约定：

   > app-core.js 的全局状态区只减不增：新增前端状态默认放入所属 modules 文件
   > 的局部作用域，确需跨模块共享时使用 `window.ClawFW` 命名空间
   > （先例：modules/fw-config-panel.js），不再向 app-core.js 追加顶层 `let` 声明。

4. 本次不迁移既有状态（`currentRuntimeAgentId` 等保持原位）。

## 验收标准

- 静态验证（grep 清单）：
  - `const I18N` 与 `function t` 在 `i18n.js` 有定义，`app-core.js` 零残留
  - `test/frontend-*.test.js`（23 个）无 I18N / t() 引用（调研已证实），测试零改动、
    `npm run test:file -- test/frontend-core-helpers.test.js` 通过
- 加载验证：启动后浏览器 console 零错误。
- 手工冒烟（逐项）：语言切换 zh→en→zh，检查侧栏 / 设置面板 / 输入框工具栏 /
  右键菜单 / 会话列表的文案完整切换，无 key 裸露（`t('...')` 查表失败显示 key 本身）。
- `app-core.js` 行数回落至 ~1,270。

## 风险提示

- i18n.js 体量 ~725 行但纯数据，diff 审查重点仅在三处：字典首尾完整、`t()` 实现
  原样、app-core 残留清零。
- 若冒烟发现裸露 key，优先排查 script 加载序（i18n.js 必须先于 app-core.js），
  而非改 t() 实现。
