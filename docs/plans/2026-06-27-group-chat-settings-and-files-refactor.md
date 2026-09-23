# 群聊设置页与文件面板重构设计

> **日期**：2026-06-27
> **状态**：方案已确认，待实施
> **参与**：产品方向讨论 + 架构推演
> **前置文档**：
> - [group-chat-command-center-design.md](./group-chat-command-center-design.md) — 群聊指挥台产品设计主文档
> - [group-chat-session-pool-data-link.md](./group-chat-session-pool-data-link.md) — 会话池数据链路
> - [2026-06-22-admin-layered-memory-design.md](./2026-06-22-admin-layered-memory-design.md) — 管理员分层记忆模型

---

## 目录

1. [背景与范围](#1-背景与范围)
2. [当前问题全景](#2-当前问题全景)
3. [新设计方案：三面板架构](#3-新设计方案三面板架构)
4. [各模块详细设计](#4-各模块详细设计)
5. [实施计划](#5-实施计划)
6. [代码索引](#6-代码索引)

---

## 1. 背景与范围

### 1.1 当前阶段

群聊模块已完成基础建设：消息流、态势感知层（成员 chip + hover popover）、@mention 路由、管理员分层记忆、会话池聚合、GROUP.md 文档体系。这些部分已符合产品预期，不在本次重构范围内。

本次重构聚焦于**群聊的"管理面"体验**——用户在创建群聊、管理群成员、配置群聊属性、浏览和编辑群资料文件时，与系统交互的全部界面。

### 1.2 不在本次范围内

以下能力已落地且符合预期，不做改动：

- 态势感知区（awareness bar）：成员 chip 聚合状态、hover popover 会话列表
- @mention 系统：群成员解析、@mention picker
- 消息流渲染：消息卡片、事件消息、附件展示
- 输入区：contenteditable 编辑器、链接/附件管理、语音输入
- 管理员会话管理：catch-up 机制、上下文滚动、健康度监控
- 轮询与数据加载链路

### 1.3 核心产品语义回顾

> 群聊不是"多 Agent 自动编排器"，而是让用户低成本指挥、监控、协调多个 Agent 的即时通讯式工作空间。人仍然是唯一 orchestrator。

成员模型：
- `user`（"我"）：固定在群里，代表人类用户，不可移除。
- `work-group:admin`（管理员）：固定在群里，群聊协调层，不可移除，不出现在"可添加成员"候选里。
- 普通 Agent 身份：需要用户手动拉入，不能默认全量导入。

设置页定义：群聊长期属性与行为边界面板。不承载消息级操作、运行态查看、派发控制等功能。

---

## 2. 当前问题全景

### 2.1 设置页问题

#### 2.1.1 成员管理"太表单"，缺乏 IM 群管理体感

**现状**：设置页的"群成员" section 在 `renderGroupMemberRows()` 中渲染为纯文字行（名称 + 描述 + 移除按钮），添加成员用 `<select>` 下拉框 + "添加"按钮。

**代码位置**：`work-group-ui.js` L793-836

```javascript
// 当前成员行渲染（纯文字，无头像）
function renderGroupMemberRows(chat) {
  return members.map((m) => {
    return [
      '<div class="wg-settings-member-row">',
      '  <div class="wg-settings-member-main">',
      `    <span class="wg-settings-row-name">${esc(name)}</span>`,
      `    <span class="wg-settings-row-role">${esc(desc)}</span>`,
      '  </div>',
      canRemove ? `  <button ...>移除</button>` : '',
      '</div>',
    ].join('');
  }).join('');
}

// 当前添加成员（下拉框，不像"拉人进群"）
function renderAddMemberControl(chat) {
  return [
    '<div class="wg-add-member-row">',
    `  <select ...>${options}</select>`,
    '  <button ...>添加</button>',
    '</div>',
  ].join('');
}
```

**问题**：
- 没有头像。在 IM 群聊产品里，成员没有视觉标识，只有纯文字。
- 添加成员是后台管理面板式的 `<select>` 交互，不像"邀请进群"。
- 固定成员（user/admin）和可移除成员视觉上没有分层。

#### 2.1.2 设置页信息架构是"平铺大杂烩"

**现状**：`renderSettingsPanel()` 将 7 个 section 一字排开，无信息层次。

**代码位置**：`work-group-ui.js` L854-925

当前结构：
```
群信息 → 群资料 → GROUP.md → 模式设置 → 管理员记忆 → 管理员模型 → 群成员 → 解散
```

**问题**：
- "群成员"被埋在第七位，放在所有管理员配置之后。在群聊产品里，"谁在群里"应是第一视觉重心。
- GROUP.md 以裸 textarea 呈现，标题暴露内部技术名词。
- 管理员相关的三个 section（模式设置、管理员记忆、管理员模型）分散在三个独立板块，但属于同一概念域。
- 没有群资料卡片头部（群头像、群名、成员数等"身份"锚点）。

#### 2.1.3 模式设置在两处重复

**现状**：`renderGroupHeader()` 在群头部已展示主动性模式 + 自决权模式（快速下拉切换），`renderSettingsPanel()` 里又重复了一遍。

**代码位置**：
- 群头部模式下拉：`work-group-ui.js` L282-297（`renderGroupHeader`）
- 设置页模式下拉：`work-group-ui.js` L888-891

两处底层都调 `_wgSettingsChange` 写入同一数据源，但视觉上重复展示造成认知负担。

#### 2.1.4 设置页 GROUP.md 编辑器与文件面板割裂

**现状**：GROUP.md 在设置页是一个 textarea（`work-group-ui.js` L882-886），独立于文件面板的编辑器。两套编辑 UI、两套保存逻辑、用户体验割裂。

GROUP.md 的加载和自动保存在：
- `loadGroupMd()` L2317
- `_wgMdAutoSave()` L2360

---

### 2.2 建群弹窗问题

**现状**：`handleNewChat()` 构建一个模态框。

**代码位置**：`work-group-ui.js` L2528-2609

```
[群聊名称输入框]
[固定成员：我、管理员]
[工作目录选择器]
[身份 checkbox 列表]
[取消] [创建]
```

**问题**：
- 身份选项是纯文字 checkbox，没有头像、没有 workspace 来源标识。多个编程小助手实例仅凭 displayName 难以区分。
- 工作目录选择是必经步骤但放在中间，对"先建个群试试"的场景提高了创建门槛。
- 没有"群简介"输入。建群时应让用户写一句话描述（对应 GROUP.md 初始内容），而不是建完再去设置页编辑。

---

### 2.3 文件面板问题

#### 2.3.1 单 panel 内栈式导航，查看时列表消失

**现状**：`renderFilesPanel()` 使用 `_filesPanelView` 状态在 'list' 和 'detail' 之间切换。

**代码位置**：`app-ui.js` L8599-8702

当用户打开一个文件进入 detail 视图后，文件列表消失。想换文件需要点"返回"回到列表，丢失列表滚动位置。

#### 2.3.2 GROUP.md 不在文件面板中

**现状**：GROUP.md 有独立的 API 和编辑 UI。

| 文件类型 | 物理路径 | API |
|---------|---------|-----|
| GROUP.md | `~/.agentdev/AgentDevClaw/group-chats/<chatId>/GROUP.md` | `/group_chats/:chatId/group_md` |
| 资源文件 | `<workDir>/.agentdev/resources/<filename>` | `/group_chats/:chatId/resources/:name` |

GROUP.md 和资源文件在物理上分离（一个是群聊级数据，一个是项目级数据），在 UI 上也完全隔离。GROUP.md 只能在设置页的 textarea 中编辑，资源文件只能在文件面板中编辑。

#### 2.3.3 新建文件强制命名

**现状**：`createFileInPanel()` 要求用户先在输入框中键入文件名才能创建。

**代码位置**：`app-ui.js` L8540-8584

```javascript
async function createFileInPanel() {
  const input = document.querySelector('[data-files-role="new-name"]');
  const rawName = (input?.value || '').trim();
  if (!rawName) {
    input.focus();
    input.classList.add('files-input-error');
    return;  // ← 没有名字就不创建
  }
  // ...
}
```

用户必须先想一个名字，操作摩擦高。更好的做法是自动生成默认名，后续可改。

#### 2.3.4 无法跨群浏览文件

**现状**：文件面板完全绑定当前 `chatId`（`loadFilesPanelResources()` 从 `window.WorkGroupUI.getActiveChatId()` 获取）。切换群聊时整个面板重置。

**代码位置**：`app-ui.js` L8401-8444

没有"看看其他群的文件"的能力。如果用户在 A 群工作时想参考 B 群的资料，必须先切到 B 群、打开文件面板、找到文件、看完再切回来。

#### 2.3.5 无重命名能力

资源文件创建后无法重命名。`validateResourceName()` 只在创建时校验，没有 rename API。

**代码位置**：`server.js` L6605-6617

---

### 2.4 右侧面板（feature panel）架构现状

**Rail button 定义**：`index.html` L122-201

当前右侧 rail 有 8 个 button，通过 `data-panel` 属性关联到 `featurePanels` 注册表：

```
workspace | monitor | hooks | inspector | logs | mcp | files | settings
```

**可见性控制**：`app-ui.js` L6140-6170（`renderCurrentMainView`）

- 调试类面板（workspace/monitor/hooks/inspector/logs/mcp）只在 AI 对话 surface 显示
- `files` 和 `settings` 面板只在群聊工作空间（`isWorkGroup`）显示

**Panel 注册**：`app-ui.js` L8713-8746（`featurePanels` 对象）

每个 panel 是 `{ title, render }` 结构，`renderFeaturePanel()` 根据 `activeFeaturePanel` 调用对应 render 函数。

**切换逻辑**：`app-ui.js` L9158-9164（`toggleFeaturePanel`）

同一时间只能打开一个 panel。再次点击已激活的 button 则关闭。

---

## 3. 新设计方案：三面板架构

### 3.1 核心决策：将"文件列表"与"文件查看/编辑"拆分为两个独立 panel

**设计思路**：

当前 `files` panel 试图在一个空间里同时承担"文件浏览"和"文件编辑"两种职责。栈式 push/pop 导航导致查看文件时列表消失，想换文件要返回、重新找。

将这两种职责拆分为两个独立的右侧 panel tab：

| 新 Panel | 职责 | Rail Button |
|---------|------|-------------|
| **资料**（resources） | 文件列表、群切换、GROUP.md 置顶条目、新建文件、拖拽源 | `data-panel="resources"` |
| **文档**（viewer） | 文件内容查看/编辑、markdown 预览、自动保存、底部操作栏 | `data-panel="viewer"` |

原有的 `files` panel 被拆分，`settings` panel 保留但重构内容。

群聊工作空间的右侧 rail 变为三个 tab：

```
[资料]  [文档]  [设置]
```

**为什么不用横向 tab 条**：

feature panel 默认 500px 宽（`--feature-panel-width`，可 resize）。在 500px 内，横向 tab 条最多放 3-4 个文件名（含 padding/关闭按钮），第 5 个就溢出滚动。文件名长了会截断，辨识度极差。

横向 tab 是给 1200px+ 编辑器窗口设计的。在侧栏里，两个独立 panel tab 的切换（一次点击）比 tab 条内的文件切换更稳定、更可扩展。

**为什么不用快速切换器 dropdown**：

虽然 dropdown 能解决空间问题，但切换需要两次点击（打开 dropdown → 选文件），且列表状态在 detail 视图下不可见。

拆成两个 panel 后：
- 想换文件？点"资料"tab，列表原封不动等在那里，滚动位置保留。
- 想继续编辑？点"文档"tab，文件内容原封不动。
- 切换是零成本的，一次点击，无中间状态。

这本质上就是把 VS Code 的"侧边文件树 + 主编辑区"模型，映射到了右侧 panel tab 系统里。

### 3.2 三面板跳转关系

```
     点击文件               点击"编辑"
资料 ──────────→ 文档 ←────────── 设置
 ↑                                     │
 └────── 点击"打开文件" ──────────────┘

资料 ←── 切换 tab ──── 文档
```

- **资料 → 文档**：点击列表中的文件，写入共享文档状态，自动切换到"文档"tab
- **设置 → 文档**：GROUP.md 卡片点"编辑"，在"文档"tab 打开 GROUP.md
- **设置 → 资料**：群资料库卡片点"打开文件"，切到"资料"tab
- **文档 → 资料**：想换文件时，点"资料"tab

### 3.3 共享文档状态

"资料"和"文档"两个 panel 需要共享一个"当前打开的文件"状态。这个状态在 `app-ui.js` 的模块作用域维护：

```javascript
// ── 文档查看器共享状态 ──
let _viewerFile = null;        // 当前文件名（或 'GROUP.md'）
let _viewerContent = '';       // 文件内容
let _viewerChatId = null;      // 文件来源群聊 ID（支持跨群查看）
let _viewerIsGroupMd = false;  // 是否为 GROUP.md（决定 API 路由）
let _viewerPreview = false;    // markdown 预览模式
let _viewerAutoSaveTimer = null;
```

任何来源（资料列表点击、设置页跳转、消息附件点击）都可以写入这个状态并切换到"文档"tab。

---

## 4. 各模块详细设计

### 4.1 资料面板（resources）

#### 布局

```
┌──────────────────────────────────────┐
│ [支付重构群 ▼]              [+ 新建]  │  ← 群切换器 + 新建按钮
├──────────────────────────────────────┤
│                                      │
│ ┌ GROUP.md ──────────────────────┐  │  ← 置顶卡片
│ │ # 支付系统重构                  │  │  带内容预览（前两行）
│ │ 对 auth 和 payment...      [→] │  │  点击 → 在"文档"tab 打开
│ └────────────────────────────────┘  │
│                                      │
│ 资源文件 (3)                         │  ← section 标题
│ ┌────────────────────────────────┐  │
│ │ api-spec.md       2.1KB  06/27  │  │  点击 → 在"文档"tab 打开
│ │ notes.txt         340B   06/26  │  │  可拖拽 → 输入区
│ │ config.json       1.2KB  06/25  │  │  hover 显示删除按钮
│ └────────────────────────────────┘  │
│                                      │
└──────────────────────────────────────┘
```

#### 设计思路

**群切换器**：顶部是一个下拉选择器，显示当前群名。点击展开所有群列表（来自 `GET /protoclaw/group_chats`），每行显示群名、文件数、workDir。选择后，文件列表刷新到该群上下文，GROUP.md 和资源文件都跟着切换。

这解决了"跨群浏览"需求。用户不需要离开资料面板就能查看其他群的文件。切换是纯前端上下文切换，资料面板的视图状态（滚动位置、展开状态）在切回原群时恢复。

**GROUP.md 置顶**：GROUP.md 在文件列表最前面始终显示为一个独立卡片，带内容预览（前两行截断）。视觉上与普通资源文件有区分（卡片样式 vs 列表行）。点击进入"文档"tab 编辑。不可删除、不可重命名。

**GROUP.md 纳入统一列表的 API 方案**：

服务端 `GET /protoclaw/group_chats/:chatId/resources` 改为在返回列表最前面包含 GROUP.md 虚拟条目：

```json
{
  "resources": [
    {
      "name": "GROUP.md",
      "isGroupMd": true,
      "size": 320,
      "mtime": 1782600000000,
      "ext": ".md",
      "preview": "# 支付系统重构\n对 auth 和 payment..."
    },
    // ... 实际资源文件
  ]
}
```

前端加载内容时根据 `isGroupMd` 路由到 `/group_md` API 还是 `/resources/:name` API。保存同理。GROUP.md 的物理路径不需要改变。

**新建文件零摩擦**：点击"+ 新建"后，后端自动创建文件，默认名 `note-MMDD-HHmm.md`（日期+时间，避免重名）。前端立即写入共享文档状态并切换到"文档"tab 进入编辑。不再有强制命名输入框。后续可通过"文档"tab 的重命名功能改名。

**拖拽支持**：每个资源文件行（GROUP.md 除外）保持 `draggable="true"` + `dataTransfer.setData('application/x-claw-resource', name)` 的拖拽能力（已有逻辑），支持拖入输入区成为附件。

#### 服务端改动

1. `GET /resources` API 增强：在返回列表前读取 GROUP.md，构造虚拟条目（含 `isGroupMd: true` 和 `preview` 字段）

   **改动位置**：`server.js` L8236-8264（`app.get('/protoclaw/group_chats/:chatId/resources')`）

2. 新建文件 API 增强：支持不传文件名时自动生成默认名

   **改动位置**：`server.js` L8295（`app.put('/protoclaw/group_chats/:chatId/resources/:name')`）新增一个 `POST /resources` 端点用于自动命名创建

3. 资源重命名 API（新增）

   新增 `POST /protoclaw/group_chats/:chatId/resources/:name/rename`，body: `{ newName }`

#### 前端改动

1. 新建 `renderResourcesPanel()` 替代原 `renderFilesPanel()` 的列表视图部分
2. 群切换器组件
3. GROUP.md 置顶卡片渲染
4. 新建文件流程改为"自动命名 + 立即编辑"
5. 注册到 `featurePanels` 的 `resources` key

---

### 4.2 文档面板（viewer）

#### 布局

```
┌──────────────────────────────────────┐
│ api-spec.md              [预览] 已保存 │  ← 文件名（只读）+ 编辑/预览切换 + 保存状态
├──────────────────────────────────────┤
│                                      │
│  # API 规范                           │
│                                      │
│  ## 认证接口                          │  编辑模式：textarea
│  POST /api/auth ...                   │  预览模式：渲染后 markdown
│                                      │
│                                      │
├──────────────────────────────────────┤
│ [插入消息]               [复制内容]   │  ← 底部操作栏
└──────────────────────────────────────┘
```

空状态（未打开任何文件时）：

```
┌──────────────────────────────────────┐
│                                      │
│         从"资料"面板选择一个文件       │
│                                      │
└──────────────────────────────────────┘
```

#### 设计思路

**整个空间都是编辑区**：因为拆分了 panel，文档面板不再需要文件列表、返回按钮、新建输入框等元素。整个 500px 宽度的 panel body 都是文件内容的展示/编辑空间。

**文件名头部**：显示当前文件名（只读）。GROUP.md 显示为"GROUP.md · 群文档"。普通文件显示文件名。如果来源群与当前群不同（跨群查看），追加来源群名标记。

**编辑/预览切换**：保留现有的 markdown 预览切换逻辑（`_filesTogglePreview`）。.md 文件支持预览，其他文件只有编辑模式。

**底部操作栏**：
- "插入消息"：将当前文件内容加入输入区的 `pendingAttachments`（等效于拖拽，但用按钮触发）。适合"正在编辑文件时发现需要发给 agent"的场景。
- "复制内容"：复制到剪贴板，用户自行粘贴。

**自动保存**：保留现有 1s debounce 自动保存逻辑。GROUP.md 走 `/group_md` API，资源文件走 `/resources/:name` API。

#### 与现有代码的关系

当前 `app-ui.js` 中的文件编辑逻辑（`selectFileInPanel`、`saveFileInPanel`、`_filesAutoSave`、`_renderFilesDetailView`）大部分可复用。主要改动：

1. 移除 `_filesPanelView` 的 'list'/'detail' 切换逻辑
2. `_renderFilesDetailView()` 改名为 `renderViewerPanel()`，独立注册为 panel
3. 内容加载/保存逻辑根据 `_viewerIsGroupMd` 路由到不同 API
4. 新增底部操作栏渲染和事件绑定

---

### 4.3 群聊设置面板（settings，重构）

#### 新布局

```
┌──────────────────────────────────────┐
│ [群头像] 群名称（可编辑）              │  ← 群资料卡片头部
│         3 名成员 · 创建于 06/27        │
│         工作目录: d:/code/xxx         │
├──────────────────────────────────────┤
│                                      │
│ 成员 (3)                    [+ 添加] │  ← 成员区（第一视觉重心）
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐         │  头像网格
│ │ 我 │ │管理│ │编程│ │ +  │         │  微信/QQ 风格
│ │群主│ │员  │ │助手│ │添加│         │  固定成员不可移除
│ └────┘ └────┘ └────┘ └────┘         │  agent 成员 hover 显示移除
│                                      │
├──────────────────────────────────────┤
│                                      │
│ 群简介                      [编辑]   │  ← GROUP.md 只读展示
│ 这是用于重构支付系统的群...           │  显示前 2-3 行摘要
│                                      │  点击"编辑" → 跳到"文档"tab
│                                      │
│ 群资料库                  [打开文件]  │  ← 文件面板入口
│ 5 个文件 · d:/code/xxx/.agentdev/... │  点击 → 跳到"资料"tab
│                                      │
├──────────────────────────────────────┤
│                                      │
│ 管理员配置                       ▼  │  ← 可折叠（默认收起）
│ 主动性: 辅助                         │  展开后显示完整配置
│ 自决权: 直接执行                      │
│ 记忆范围: 最近 3 天                   │
│ 上下文限制: 100000 tokens             │
│ 模型预设: 全局默认                    │
│                                      │
├──────────────────────────────────────┤
│ [解散此群聊]                          │  ← 危险区
└──────────────────────────────────────┘
```

#### 设计思路

**群资料卡片头部**：打开设置页，第一眼看到群的"身份"——群头像（生成式：首字母 + hash 配色）、群名（可编辑）、成员数、创建时间、工作目录。这是视觉锚点，建立群的认知。

**成员是第一视觉重心**：从第七位提升到第二位（仅次于群资料卡片）。用头像网格展示，微信/QQ 风格。固定成员（我、管理员）和 agent 成员视觉分层：
- 固定成员有角色 badge（"群主"、"管理员"），不显示移除按钮
- Agent 成员显示 workspace 来源，hover 时显示移除按钮
- 网格末尾始终有一个"+"添加按钮

**生成式头像**：不需要用户上传图片。头像由成员名首字母/首字 + 基于名称 hash 的配色自动生成。参考 Discord/GitHub 的默认头像方案。

**添加成员弹窗**：点击"+"按钮打开 overlay（不是 inline `<select>`）：
```
┌──────────────────────────────────────┐
│ 添加成员                              │
│ [搜索...]                             │
│                                      │
│ ○ 编程小助手 · 主代理                  │  带头像 + 描述
│   擅长编码、调试、重构                 │
│ ● 探索代理                            │  已选（当前群成员中）
│   只读分析、知识收集                   │  禁用或标记"已在群中"
│                                      │
│ [取消]  [确定]                        │
└──────────────────────────────────────┘
```
支持搜索、多选。已在群中的身份标记为禁用或"已在群中"。

**GROUP.md 从设置页 textarea 变为只读卡片**：
- 设置页只展示 GROUP.md 的摘要（前 2-3 行），加一个"编辑"按钮
- 点击"编辑" → 写入共享文档状态（`_viewerFile = 'GROUP.md'`, `_viewerIsGroupMd = true`）→ 切换到"文档"tab
- 设置页不再有 GROUP.md 的 textarea、自动保存逻辑、`loadGroupMd()` 等代码
- 设置页只负责"连接关系和入口"，不负责文件内容编辑

**管理员配置折叠区**：将原来的三个独立 section（模式设置、管理员记忆、管理员模型）合并为一个可折叠区块，默认收起。展开后显示所有管理员相关配置。这样做的原因：
- 管理员配置是"长期设置"，不是每次打开设置页都要调的
- 折叠后减少视觉噪音，让成员管理和群简介更突出
- 模式设置不再重复展示（群头部已有快速切换入口）

**模式设置去重**：设置页不再展示主动性模式和自决权模式的下拉框。这两个设置已经在群头部有快速切换入口（`renderGroupHeader` L282-297），设置页重复展示只会造成困惑。如果用户需要完整描述，展开管理员配置折叠区可以看到带描述的选项。

#### 设置页改动涉及的全局函数

以下函数的行为或存在性会受影响：

| 函数 | 当前位置 | 改动 |
|------|---------|------|
| `renderSettingsPanel()` | `work-group-ui.js` L854 | 重写整个布局 |
| `renderGroupMemberRows()` | L793 | 重写为头像网格 |
| `renderAddMemberControl()` | L822 | 删除，替换为添加成员弹窗 |
| `renderFilesBridgeSection()` | L838 | 保留，改为 GROUP.md 摘要 + 跳转入口 |
| `loadGroupMd()` | L2317 | 移除（GROUP.md 编辑迁移到文档面板） |
| `_wgMdAutoSave()` | L2360 | 移除 |
| `handleSettingsFieldChange()` | L2286 | 保留，可能调整字段处理 |
| `renderAdminModelOptions()` | L743 | 保留，移入折叠区 |
| `_wgGetSettingsHtml` | L3559 | 保留入口，返回新 HTML |
| `_wgSettingsInit` | L3564 | 简化（不再加载 GROUP.md） |

---

### 4.4 建群弹窗优化

#### 新布局

```
┌──────────────────────────────────────┐
│ 新建群聊                              │
│                                      │
│ [群头像预览]  群名称（输入框）         │  ← 生成式头像预览 + 名称
│                                      │
│ 群简介（可选）                        │  ← 新增：一句话描述
│ [textarea: 这个群是干什么的...]       │  对应 GROUP.md 初始内容
│                                      │
│ ── 固定成员 ──                        │
│ [头像] 我（群主）                     │
│ [头像] 管理员（固定入群）              │
│                                      │
│ ── 选择成员 ──                        │
│ [搜索...]                             │
│ [头像] ○ 编程小助手 · 主代理           │  带头像 + checkbox
│ [头像] ○ 探索代理                     │
│                                      │
│ ── 工作目录（可选）──                 │  ← 改为可选，降低创建门槛
│ [选择项目目录...]  [选择]             │
│                                      │
│ [取消]  [创建]                        │
└──────────────────────────────────────┘
```

#### 设计思路

**群头像预览**：输入群名时实时生成头像预览（首字母 + hash 配色），给用户即时的视觉反馈。

**群简介**：新增一个"群简介"输入框，建群时写入 GROUP.md 初始内容。这样用户在建群阶段就能表达"这个群是干什么的"，而不是建完之后再去设置页编辑。

**身份选项带头像**：checkbox 列表中的每个身份都显示生成式头像 + workspace 来源标识，不再只是纯文字。

**工作目录改为可选**：当前位置从"必经步骤"变为"可选配置"。用户可以先建空群、不设工作目录、之后再补。创建按钮在有群名时就可用，不依赖工作目录。

---

### 4.5 文件面板与输入区的联动设计

#### 当前联动

| 操作 | 触发 | 代码位置 |
|------|------|---------|
| 拖文件到输入区 | 从文件面板列表拖拽 → `.wg-input-area` | `work-group-ui.js` L3256-3297 |

拖拽使用自定义 dataTransfer 类型 `application/x-claw-resource`，drop 时从 API 获取文件内容，加入 `pendingAttachments`。

#### 规划中的联动

| 操作 | 触发 | 效果 |
|------|------|------|
| 拖文件到输入区 | 从"资料"面板拖拽 | 文件内容成为附件（保留） |
| 快速插入 | "文档"面板底部"插入消息" | 当前文件加入 pendingAttachments（新增） |
| 复制内容 | "文档"面板底部"复制内容" | 复制到剪贴板（新增） |
| 附件回溯 | 点击消息中的附件 chip | 在"文档"面板打开该文件（后续可做） |

**设计思路**：拖拽适合"浏览时顺手扔进去"（用户在资料面板扫文件，看到有用的就拖到输入区）。快速插入适合"正在编辑文件时发现需要发给 agent"（用户在文档面板编辑，发现需要把当前文件发给某个 agent）。

这两个操作路径覆盖了"从文件到消息"的主要场景。消息附件回溯（从消息到文件）是反向路径，后续阶段补充。

---

## 5. 实施计划

### Phase 1：设置页重构

**目标**：设置页从"平铺表单"变为"IM 群管理"体验。

**工作项**：

1. **群资料卡片头部**
   - 生成式头像组件（首字母 + hash 配色）
   - 群名、成员数、创建时间、工作目录展示

2. **成员头像网格**
   - 重写 `renderGroupMemberRows()` → 头像网格布局
   - 固定成员（user/admin）角色 badge
   - Agent 成员 workspace 来源标识
   - Hover 显示移除按钮
   - "+"添加按钮

3. **添加成员弹窗**
   - 搜索框 + 身份列表（带头像）
   - 多选 + 确认
   - 已在群中的身份标记

4. **GROUP.md 只读卡片**
   - 展示前 2-3 行摘要
   - "编辑"按钮 → 写入共享文档状态 + 切换到"文档"tab（Phase 2 完成后生效，Phase 1 先跳到旧的文件面板）

5. **管理员配置折叠区**
   - 合并三个 section 为可折叠区块
   - 默认收起

6. **移除重复的模式设置**
   - 设置页不再展示主动性/自决权模式下拉框

**涉及文件**：
- `work-group-ui.js` — 重写 `renderSettingsPanel()` 及相关函数
- `work-group.css` — 新增头像网格、折叠区样式
- `app-ui.js` — `_wgGetSettingsHtml` / `_wgSettingsInit` 调整

### Phase 2：资料/文档双面板拆分

**目标**：将"文件列表"和"文件查看/编辑"拆分为两个独立 panel。

**工作项**：

1. **新建 `resources` panel（资料面板）**
   - 群切换器
   - GROUP.md 置顶卡片
   - 资源文件列表
   - 新建文件（自动命名）
   - 拖拽支持保留

2. **新建 `viewer` panel（文档面板）**
   - 共享文档状态
   - 文件名头部
   - 编辑/预览切换
   - 自动保存（GROUP.md 走 group_md API，资源走 resources API）
   - 底部操作栏（插入消息 / 复制内容）
   - 重命名能力

3. **服务端 API 调整**
   - `GET /resources` 增强：返回 GROUP.md 虚拟条目
   - 新增 `POST /resources` 端点：自动命名创建
   - 新增 `POST /resources/:name/rename`：重命名

4. **Rail button 调整**
   - `index.html`：`files` button 拆为 `resources` + `viewer` 两个 button
   - `app-ui.js`：`featurePanels` 注册 `resources` 和 `viewer`
   - `renderCurrentMainView`：可见性控制更新

5. **共享文档状态**
   - `_viewerFile`、`_viewerContent`、`_viewerChatId`、`_viewerIsGroupMd`
   - 跨 panel 读写
   - 群切换时处理自动保存 flush

**涉及文件**：
- `app-ui.js` — 新建 panel 渲染函数、共享状态、事件绑定
- `index.html` — 新增 rail button
- `server.js` — API 增强
- `work-group.css` — 新 panel 样式
- `work-group-ui.js` — `openFilesPanel()` 改为切换到 `resources` panel

### Phase 3：联动增强

**目标**：打通文件面板与消息流的双向联动。

**工作项**：

1. 底部操作栏实现（插入消息 / 复制内容）
2. 附件 chip 点击跳回文档面板
3. 拖拽视觉反馈增强（drop zone 高亮）
4. 文件列表内容预览（前两行）

---

## 6. 代码索引

### 6.1 前端 — 群聊 UI 主体

**文件**：`public/src/modules/work-group-ui.js`（3615 行）

| 功能 | 函数 | 行号 | 说明 |
|------|------|------|------|
| 模式定义 | `INITIATIVE_MODES` / `AUTONOMY_MODES` | L16-26 | 主动性/自决权模式常量 |
| 群头部 | `renderGroupHeader()` | L282 | 群名 + 模式快速切换下拉 |
| 模式下拉 | `renderModeDropdown()` | L299 | 群头部的模式下拉组件 |
| 管理员 chip | `renderAdminChip()` | L329 | 态势层管理员状态 chip |
| 成员聚合状态 | `getMemberAggregateStatus()` | L370 | running/idle/offline 聚合 |
| **态势层渲染** | `renderAwarenessBar()` | L379 | 成员级 chip + hover popover |
| 管理员模型选项 | `renderAdminModelOptions()` | L743 | 模型预设下拉选项 |
| **身份判定** | `isManageableGroupIdentity()` | L760 | 判断是否可管理的普通 agent 身份 |
| **成员规范化** | `normalizeGroupMembers()` | L764 | 固定插入 user + admin，去重 |
| 可添加身份 | `getAvailableMemberIdentities()` | L786 | 过滤已在群中的身份 |
| **成员行渲染** | `renderGroupMemberRows()` | L793 | ← Phase 1 重写为头像网格 |
| **添加成员控件** | `renderAddMemberControl()` | L822 | ← Phase 1 替换为弹窗 |
| 文件桥接区 | `renderFilesBridgeSection()` | L838 | ← 改为 GROUP.md 摘要卡片 |
| **设置面板** | `renderSettingsPanel()` | L854 | ← Phase 1 重写整个布局 |
| 设置字段变更 | `handleSettingsFieldChange()` | L2286 | 群名/模式/记忆/模型等字段保存 |
| GROUP.md 加载 | `loadGroupMd()` | L2317 | ← Phase 2 移除（迁移到 viewer panel） |
| GROUP.md 自动保存 | `_wgMdAutoSave()` | L2360 | ← Phase 2 移除 |
| 工作目录变更 | `changeWorkDir()` | L2386 | 弹出目录选择器 |
| 打开文件面板 | `openFilesPanel()` | L2448 | ← 改为切换到 resources panel |
| **建群弹窗** | `handleNewChat()` | L2528 | ← 优化：头像 + 群简介 + 可选目录 |
| 群聊切换 | `selectChat()` | L1418 | 缓存清除 + 数据重载 + 渲染 |
| 拖拽接收 | `onContainerDrop()` | L3275 | 接收文件面板拖拽，加入附件 |
| 设置面板对外接口 | `_wgGetSettingsHtml` | L3559 | 注册到 featurePanels.settings.render |
| 设置面板初始化 | `_wgSettingsInit` | L3564 | 加载 GROUP.md + 模型选项 |
| 设置面板刷新 | `_wgSettingsRefresh` | L3569 | 字段变更后刷新 |

### 6.2 前端 — 文件面板（app-ui.js）

**文件**：`public/src/app-ui.js`（9777 行）

| 功能 | 函数 | 行号 | 说明 |
|------|------|------|------|
| **资源加载** | `loadFilesPanelResources()` | L8401 | ← Phase 2 拆分到 resources panel |
| **文件选择** | `selectFileInPanel()` | L8446 | ← Phase 2 改为写入共享文档状态 |
| **文件保存** | `saveFileInPanel()` | L8488 | ← Phase 2 复用，根据 isGroupMd 路由 |
| 自动保存 | `_filesAutoSave()` | L8514 | 1s debounce 自动保存 |
| 文件删除 | `deleteFileInPanel()` | L8522 | |
| **文件创建** | `createFileInPanel()` | L8540 | ← Phase 2 改为自动命名 |
| **面板渲染** | `renderFilesPanel()` | L8599 | ← Phase 2 拆分为 resources + viewer |
| 列表视图 | `_renderFilesListView()` | L8635 | ← Phase 2 迁移到 resources panel |
| **详情视图** | `_renderFilesDetailView()` | L8667 | ← Phase 2 迁移到 viewer panel |
| **Panel 注册** | `featurePanels` | L8713 | ← 新增 resources / viewer |
| **面板渲染入口** | `renderFeaturePanel()` | L9085 | 通用 panel 渲染引擎 |
| **Panel 切换** | `toggleFeaturePanel()` | L9158 | rail button 点击处理 |
| **Rail button 可见性** | `renderCurrentMainView()` | L6138 | files/settings 只在群聊显示 |
| **Rail button 事件** | L9325 | L9325 | 各 panel 的打开时初始化逻辑 |
| 文件选择（window） | `_filesSelect` | L9339 | |
| 文件删除（window） | `_filesDelete` | L9340 | |
| 文件创建（window） | `_filesCreate` | L9344 | |
| 返回列表（window） | `_filesBack` | L9345 | ← Phase 2 移除（不再需要返回） |
| 预览切换（window） | `_filesTogglePreview` | L9359 | |

### 6.3 前端 — HTML 结构

**文件**：`public/index.html`

| 元素 | 行号 | 说明 |
|------|------|------|
| `#feature-panel` | L110 | 右侧面板容器（500px，可 resize） |
| `#feature-panel-body` | L115 | 面板内容区 |
| `.right-rail` | L122 | 右侧 rail button 容器 |
| `#rail-files` | L168 | files panel button ← Phase 2 拆分 |
| `#rail-settings` | L177 | settings panel button |

### 6.4 前端 — 样式

**文件**：`public/styles/work-group.css`（3118 行）

| 样式 | 行号 | 说明 |
|------|------|------|
| `.wg-settings-panel` | L1870 | 设置面板容器 |
| `.wg-settings-section` | L1874 | 设置面板 section |
| `.wg-settings-section-title` | L1878 | section 标题 |
| `.wg-settings-field` | L1887 | 字段行 |
| `.wg-settings-input` | L1899 | 输入框/下拉框统一样式 |
| `.wg-settings-member-row` | L1932 | ← Phase 1 替换为头像网格样式 |
| `.wg-settings-member-main` | L1941 | |
| `.wg-member-remove-btn` | L1949 | |
| `.wg-add-member-row` | L1964 | ← Phase 1 移除 |
| `.wg-settings-empty-note` | L1974 | |
| `.wg-settings-danger` | L2179 | 解散群聊危险区 |

**文件**：`public/styles/layout.css`

| 样式 | 行号 | 说明 |
|------|------|------|
| `.feature-panel` | L330 | 右侧面板容器（width: 0 → .open 时 500px） |
| `.feature-panel.open` | L342 | `--feature-panel-width: 500px` |
| `.feature-panel-header` | L367 | 面板头部（64px 高） |
| `.feature-panel-body` | L387 | 面板内容区 |

### 6.5 服务端 — 群聊 API 与存储

**文件**：`server.js`（13060 行）

| 功能 | 函数/路由 | 行号 | 说明 |
|------|----------|------|------|
| **群聊存储根** | `GROUP_CHATS_ROOT` | L57 | `~/.agentdev/AgentDevClaw/group-chats` |
| 群聊文件路径 | L6516 | L6516 | `<root>/<chatId>.json` |
| **群聊读取** | `readGroupChat()` | L6551 | JSON 文件读取 |
| **群聊写入** | `writeGroupChat()` | L6563 | JSON 文件写入 |
| **身份收集** | `collectIdentities()` | L6407 | 从 prebuilt-agents 收集可用身份 |
| 身份 API | `GET /identities` | L6440 | 返回所有可用身份列表 |
| **资源目录** | `getResourcesDir()` | L6596 | `<workDir>/.agentdev/resources` |
| **资源名校验** | `validateResourceName()` | L6605 | 校验+默认扩展名 |
| 消息追加 | `appendGroupChatMessage()` | L6623 | append-only 消息写入 |
| 记忆范围解析 | `parseMemoryRange()` | L6648 | 1d/3d/1w/all → ms |
| **成员规范化** | `normalizeGroupChatMembers()` | L8098 | 固定插入 user + admin（服务端兜底） |
| **建群** | `POST /group_chats` | L8118 | 创建群聊 |
| 读群聊 | `GET /group_chats/:chatId` | L8145 | |
| 更新群聊 | `PUT /group_chats/:chatId` | L8155 | |
| **GROUP.md 数据目录** | `getGroupChatDataDir()` | L8195 | `<root>/<chatId>/`（GROUP.md 物理位置） |
| **GROUP.md 读取** | `GET /group_chats/:chatId/group_md` | L8199 | |
| **GROUP.md 写入** | `PUT /group_chats/:chatId/group_md` | L8216 | |
| **资源列表** | `GET /group_chats/:chatId/resources` | L8236 | ← Phase 2 增强：含 GROUP.md 虚拟条目 |
| **资源读取** | `GET /group_chats/:chatId/resources/:name` | L8271 | |
| **资源写入** | `PUT /group_chats/:chatId/resources/:name` | L8295 | ← Phase 2 新增自动命名端点 |
| **资源删除** | `DELETE /group_chats/:chatId/resources/:name` | L8319 | |

### 6.6 关联文档

| 文档 | 路径 | 说明 |
|------|------|------|
| 群聊产品设计主文档 | `docs/plans/group-chat-command-center-design.md` | 产品哲学、核心概念、@mention 语义、演进路径 |
| 会话池数据链路 | `docs/plans/group-chat-session-pool-data-link.md` | 态势感知、成员 popover、中断控制、会话解析 |
| 管理员分层记忆 | `docs/plans/2026-06-22-admin-layered-memory-design.md` | 群记忆组装、catch-up 机制、GROUP.md 注入 |
| 前端渲染机制 | `docs/reference/frontend-rendering-patterns.md` | 会话切换、去重策略、异步渲染约束 |

---

## 附录 A：GROUP.md 物理路径设计决策

### 问题

GROUP.md 和资源文件在不同的物理位置：

| 文件 | 路径 | 生命周期 |
|------|------|---------|
| GROUP.md | `~/.agentdev/AgentDevClaw/group-chats/<chatId>/GROUP.md` | 绑定单个群聊 |
| 资源文件 | `<workDir>/.agentdev/resources/<filename>` | 绑定 workDir，多群共享 |

如果将 GROUP.md 移到 `<workDir>/.agentdev/resources/GROUP.md`，则同 workDir 的多个群会共享同一个 GROUP.md，这是错误的——每个群有独立的上下文。

### 决策：保持物理路径不变，API 层虚拟化

GROUP.md 的物理位置不变（`group-chats/<chatId>/GROUP.md`）。在 API 层面，`GET /resources` 返回的列表中包含 GROUP.md 作为虚拟条目（`isGroupMd: true`）。前端根据 `isGroupMd` 标记路由到 `/group_md` API 还是 `/resources/:name` API。

这样：
- 物理隔离正确（每群独立 GROUP.md）
- UI 统一（用户在资料面板看到 GROUP.md 和资源文件在一起）
- API 兼容（现有 `/group_md` 端点不变）

---

## 附录 B：生成式头像方案

### 需求

群成员需要一个视觉标识（头像），但不要求用户上传图片。

### 方案

参考 Discord/GitHub 的默认头像方案：

1. **取标识符**：成员名的首字母或首字（如"编"→ 编，"admin" → A）
2. **Hash 配色**：对成员名做简单 hash，映射到预设的 8-12 种颜色
3. **CSS 渲染**：纯 CSS 实现，圆形背景 + 居中文字

```css
.wg-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  /* background-color 由 JS 根据 hash 设置 */
}
```

预设色板（暗色主题友好）：
```
#5865F2 #57F287 #FEE75C #EB459E
#ED4245 #F47B67 #3BA55D #FAA61A
#9B59B6 #1ABC9C #E67E22 #3498DB
```

### 特殊成员

- `user`（"我"）：固定使用品牌色或用户自定义色
- `work-group:admin`（管理员）：固定使用管理色（如金色/紫色），与普通 agent 区分

---

## 附录 C：Phase 1 实施检查清单

实施 Phase 1（设置页重构）时，以下检查点需逐项确认：

- [ ] 生成式头像组件实现（纯函数：name → { initials, color }）
- [ ] `renderSettingsPanel()` 重写为新布局
- [ ] 群资料卡片头部渲染（头像 + 群名 + 成员数 + 工作目录）
- [ ] 成员头像网格渲染（固定成员 badge + agent 成员 hover 移除）
- [ ] 添加成员弹窗（搜索 + 多选 + 已在群中标记）
- [ ] GROUP.md 只读卡片（摘要 + 编辑跳转）
- [ ] 管理员配置折叠区（合并三 section，默认收起）
- [ ] 模式设置从设置页移除（群头部保留）
- [ ] `_wgSettingsInit` 简化（不再加载 GROUP.md）
- [ ] `_wgMdAutoSave` / `loadGroupMd` 标记为待移除（Phase 2 正式移除）
- [ ] CSS 新增头像网格、折叠区、群资料卡片样式
- [ ] 切群时设置面板状态正确刷新（不串数据）
- [ ] 设置变更后面板刷新正常（字段保存 → UI 同步）
