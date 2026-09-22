# 项目质量提升指南（2026-07-12）

> 创建日期：2026-07-12
> 前置文档：`docs/plans/2026-07-03-app-main-split-plan.md`、`docs/audits/test-coverage-audit-2026-07-04.md`、`docs/plans/2026-06-29-app-ui-split-plan-v2.md`、`docs/plans/2026-07-05-module-secondary-split-report.md`

---

## 一、当前进度总览（基于实际代码盘点）

### 1.1 server.js 拆分 — 已完成

| 维度 | 起点 | 现状 |
|------|------|------|
| server.js | 13,449 行 | **1,197 行** |
| 拆出模块 | 0 | 16 路由模块 + 10 shared 模块 |

### 1.2 app-main.js 拆分 — Phase A+B+C+D 全部完成

| 维度 | 起点 | 现状 |
|------|------|------|
| app-main.js | 8,517 行 | **3,647 行** |
| 拆出模块 | 0 | **14 个**（Phase A×7 + Phase B×5 + Phase C×1 + Phase D×1）|

已完成的模块清单：

| Phase | 模块 | 行数 | 完成日期 |
|-------|------|------|---------|
| A-1 | voice-input.js | 456 | 2026-07-10 |
| A-2 | choice-input.js | 305 | 2026-07-03 |
| A-3 | auto-title.js | 415 | 2026-07-11 |
| A-4 | ph-project-actions.js | 301 | 2026-07-03 |
| A-5 | external-runtime.js | 164 | 2026-07-03 |
| A-6 | rollback-dialog.js | 188 | 2026-07-03 |
| A-7 | recap-hint.js | 201 | 2026-07-03 |
| B-1 | runtime-status.js | 836 | 2026-07-12 |
| B-2 | ctx-menu-items.js | 875 | 2026-07-11 |
| B-3 | chat-scroll.js | 169 | 2026-07-04 |
| B-4 | persistent-input.js | 562 | 2026-07-10 |
| B-5 | input-helpers.js | 355 | 2026-07-07 |
| C | assembly-actions.js | 1,080 | 2026-07-04 |
| D | chat-renderer.js | 800 | 2026-07-09 |

**Phase A+B+C+D 全部完成。** app-main.js 从 8,517 行降到 3,647 行，仅保留计划中标注为"永久保留"的核心域。

### 1.3 app-ui.js 拆分 — Phase 1-3a 完成

| 维度 | 起点 | 现状 |
|------|------|------|
| app-ui.js | 9,871 行 | **2,725 行** |
| 拆出模块 | 24 | 24+（含 workspace-blocks.js, assembly-data.js）|

### 1.4 测试 — inline mirror 已清零，安全函数已覆盖

| 维度 | 审计时(7/4) | 现状 |
|------|------------|------|
| 测试用例总数 | 541 | **1,008** |
| inline mirror 测试 | 11 个 | **0**（全部改为直接 import）|
| 安全函数覆盖 | 零 | 已覆盖（XSS/注入/路径穿越/Session ID）|
| 零覆盖路由模块 | 8 个 | **0** |

### 1.5 结论

**前端拆分的主体工作已经完成。** app-main.js 从 8,517 行降到 3,647 行，所有 Phase A/B/C/D 已全部完成，仅保留计划中标注为"永久保留"的核心域（sidebar、poll、session switch、runWorkspaceAction、global event listeners、renderInputRequests、bootstrap）。

**下一步的质量提升工作应聚焦三个方向**（详见下文）。

---

## 二、工作方向 A：app-main.js Phase C — Assembly 操作提取（已完成）

> **状态**：✅ 已完成（2026-07-04，commit 33b6ca6）
> Phase C 在本指南创建时（2026-07-12）被发现已经落地。以下保留原始分析供参考。

### 2.1 现状

Phase C 是 app-main 拆分计划中唯一未执行的 Phase，原计划依赖 app-ui.js v2 Phase 3b 完成。现在 `assembly-data.js`（606 行）已经存在，说明 Phase 3b 已落地，**Phase C 的前置条件已满足**。

### 2.2 待提取内容

app-main.js 中与 assembly/workspace 装配相关的函数：

| 函数 | 说明 |
|------|------|
| `createAssemblyEnvironment` | 创建 assembly 运行环境 |
| `launchAssemblyInstance` | 启动 assembly 实例 |
| `getSavedAssemblyConfigs` | 读取已保存的 assembly 配置 |
| `canonicalizeAssemblyFeatureSelection` | 规范化 feature 选择 |
| `saveCurrentAssemblyConfig` | 保存当前 assembly 配置 |
| `resetAssemblyDraft` | 重置 draft |
| `switchAssemblyEditingTarget` | 切换编辑目标 |
| `toggleAssemblyControlPanel` | 切换控制面板 |
| `jumpAssemblyStage` | 跳转阶段 |
| `loadSavedAssemblyConfig` | 加载已保存配置 |
| `launchAssemblyConfig` | 启动配置 |
| `deleteSavedAssemblyConfig` | 删除已保存配置 |
| `launchSavedAssemblyRun` | 启动已保存运行 |
| `fwLaunchConfig` | Flow workspace 启动 |
| `fwResumeRun` | Flow workspace 恢复 |
| `deleteAssemblySessionRecord` | 删除 assembly 会话记录 |
| `loadAssemblySessionIntoDraft` | 加载会话到 draft |
| `stopAssemblySessionRuntime` | 停止 runtime |
| `chooseWorkspaceDirectory` | 选择工作目录 |
| `saveWorkspaceForm` | 保存表单 |
| `resetWorkspaceForm` | 重置表单 |

以及 `window.updateWorkspaceFormDraft`、`window.toggleWorkspaceSelection`、`window.applyWorkspaceBundle`。

### 2.3 执行步骤

> 参见 `docs/plans/2026-07-03-app-main-split-plan.md` 第四节 Phase C。

1. **grep 定位**：在当前 app-main.js（3,647 行）中搜索上述函数名，记录实际行号
2. **确认与 assembly-data.js 的交叉调用**：
   - `getWorkspaceFormDraft`、`normalizeAssemblyDraft`、`persistWorkspaceState` 等在 assembly-data.js 中
   - 提取后调用链变为 `assembly-data.js ← assembly-actions.js ← app-main.js`
3. **创建 `public/src/modules/assembly-actions.js`**
4. 剪切函数，在 app-main.js 原位加注释
5. 在 index.html 中插入 `<script>` 标签（在 assembly-data.js 之后）
6. 重启服务，验证 assembly 相关操作正常

### 2.4 风险评估

- **风险等级**：★★★★☆（高）
- **主要风险**：assembly 操作与 app-ui.js assembly data 层有 ~30 次跨文件调用，需要精确确认每个调用点
- **缓解**：assembly-data.js 已经独立，交叉调用点已经固定，比 Phase C 原计划预期的更容易

### 2.5 预期收益

Phase C 完成后，app-main.js 预估降至 **~2,600 行**，仅保留计划中的"永久核心域"。

---

## 三、工作方向 B：前端高频纯函数测试

### 3.1 现状

- 57 个前端模块文件，自动化测试仅 `test/frontend-core-helpers.test.js`（395 行，覆盖 app-core.js 纯函数）
- VM 沙箱基础设施已就绪：`test/helpers/frontend-vm.js`（169 行），提供 DOM stub、localStorage、window 等
- 前端改动（拆分、bug 修复）完全靠手动验证，回归风险无自动检测

### 3.2 测试基础设施

已有的 `frontend-vm.js` 沙箱支持：

```js
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const ctx = createFrontendSandbox();
ctx.loadSource('public/src/modules/markdown-utils.js');
ctx.run('escapeHtml("<script>")');  // → "&lt;script&gt;"
```

沙箱提供：document stub、window stub、localStorage、Map/Set/JSON/Promise、escapeHtml stub（可被模块定义覆盖）。

### 3.3 优先覆盖目标（按被引用频率排序）

#### 第一梯队：被 3+ 模块引用的纯函数

| 函数 | 所在文件 | 被引用方 | 安全相关 | 测试难度 |
|------|---------|---------|---------|---------|
| `escapeHtml` | markdown-utils.js | chat-renderer, ctx-menu-items, conversation-renderer, ... | **XSS** | 极低 |
| `renderMarkdown` | markdown-utils.js | chat-renderer, session-ui, wg-core | — | 低 |
| `parseToolResult` | markdown-utils.js | chat-renderer, debug-panels | — | 低 |
| `getToolDisplayName` | markdown-utils.js | chat-renderer, debug-panels | — | 低 |
| `getFeatureStatus` | app-core.js | feature-config, feature-setup-ui, debug-panels | — | 已覆盖 |
| `getRuntimeContextKey` | app-core.js | app-main, voice-input, runtime-status | — | 已覆盖 |

#### 第二梯队：安全相关或高频调用的近纯函数

| 函数 | 所在文件 | 说明 | 安全相关 |
|------|---------|------|---------|
| `sanitizeSessionFragment` | shared/string-helpers.js (服务端，但前端也有引用) | session ID 清理 | **注入** |
| `extractDisplayMathBlocks` | markdown-utils.js | 数学公式提取 | — |
| `normalizeWheelDeltaY` | chat-scroll.js | 滚动归一化 | — |

### 3.4 测试文件组织建议

```
test/
  frontend-core-helpers.test.js       ← 已有，app-core.js
  frontend-markdown-utils.test.js     ← 新增，markdown-utils.js
  frontend-chat-render-helpers.test.js ← 新增，chat-renderer.js 中的纯函数
```

### 3.5 测试编写模板

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadModule(path) {
  const ctx = createFrontendSandbox();
  // markdown-utils.js 依赖 escapeHtml 自定义（不从外部导入），
  // 所以直接加载即可，模块内会重新定义 escapeHtml
  ctx.loadSource(path);
  return ctx;
}

describe('markdown-utils: escapeHtml', () => {
  it('escapes HTML special characters', () => {
    const ctx = loadModule('public/src/modules/markdown-utils.js');
    assert.equal(ctx.run('escapeHtml("<script>")'), '&lt;script&gt;');
    assert.equal(ctx.run('escapeHtml(\'"quote"\')'), '&quot;quote&quot;');
  });

  it('handles null/undefined', () => {
    const ctx = loadModule('public/src/modules/markdown-utils.js');
    assert.equal(ctx.run('escapeHtml(null)'), '');
    assert.equal(ctx.run('escapeHtml(undefined)'), '');
  });
});
```

### 3.6 注意事项

1. **模块依赖链**：部分模块在顶层执行 DOM 查询（如 `document.getElementById`），沙箱的 stub 会返回空对象，不会报错。但如果模块在顶层调用 `.value` 或 `.classList.contains()` 等，需要增强 stub。
2. **`let`/`const` 变量**：在 VM context 中，`let`/`const` 声明的变量不会成为 context 属性。要读取它们需要通过 `ctx.run('variableName')` 而非 `ctx.variableName`。
3. **不需要覆盖 DOM 操作函数**：只测纯函数（输入→输出），不测需要真实 DOM 的渲染函数。

---

## 四、工作方向 C：session-helpers.js 补测

### 4.1 现状

- 文件位置：`server/routes/session-helpers.js`，**1,814 行**
- 已有测试文件间接导入它：`session-cleanup.test.js`、`session-extraction.test.js`、`session-model-meta.test.js`、`session-summary.test.js`
- 已 export 的纯函数：`extractTokenUsage`、`extractLastMessagePreview`、`resolveSessionModelFromRecord`、`selectEmptySessions`、`resolvePostCleanupState`、`searchInTextPure`
- **未 export 但可测试的纯函数**：`buildFeatureSessionTitle`、`buildNamedSessionTitle`、`buildLightPrebuiltSessionRecord`、`extractToolCallLabel`、`buildSessionTrimPreview`、`extractDomainsFromText`、`getSearchIndexPath`

### 4.2 需要补充 export 的函数

以下纯函数当前没有 `export`，需要添加 `export` 后才能直接 import 测试：

```js
// server/routes/session-helpers.js 中需要添加 export 的函数：

export function extractToolCallLabel(name, args) { ... }      // L326
export function buildSessionTrimPreview(messages) { ... }     // L342
export function extractDomainsFromText(text) { ... }          // L1652
export function buildLightPrebuiltSessionRecord(agentId, record) { ... }  // L247
```

### 4.3 测试覆盖矩阵

| 函数 | 类型 | 已有测试 | 需新增 | 优先级 |
|------|------|---------|--------|--------|
| `extractTokenUsage` | 纯函数 | 无 | 有 | 中 |
| `extractLastMessagePreview` | 纯函数 | 无 | 有 | 中 |
| `resolveSessionModelFromRecord` | 纯函数 | 已覆盖（session-model-meta.test.js）| — | — |
| `selectEmptySessions` | 纯函数 | 已覆盖（session-cleanup.test.js）| — | — |
| `resolvePostCleanupState` | 纯函数 | 已覆盖（session-cleanup.test.js）| — | — |
| `searchInTextPure` | 纯函数 | 已覆盖（间接）| — | — |
| `extractToolCallLabel` | 纯函数 | 无 | **有** | **高** |
| `buildSessionTrimPreview` | 纯函数 | 无 | **有** | **高** |
| `extractDomainsFromText` | 纯函数 | 无 | 有 | 中 |
| `buildLightPrebuiltSessionRecord` | 纯函数 | 无 | 有 | 低 |

### 4.4 测试用例设计

#### extractToolCallLabel（需先添加 export）

```js
describe('extractToolCallLabel', () => {
  it('extracts file name for read tool', () => {
    assert.equal(
      extractToolCallLabel('read', { filePath: '/foo/bar/baz.ts' }),
      'read baz.ts'
    );
  });
  it('handles Windows paths', () => {
    assert.equal(
      extractToolCallLabel('edit', { filePath: 'D:\\code\\file.js' }),
      'edit file.js'
    );
  });
  it('returns null for unknown tool', () => {
    assert.equal(extractToolCallLabel('unknown', {}), null);
  });
  it('returns null when args is not object', () => {
    assert.equal(extractToolCallLabel('read', null), null);
    assert.equal(extractToolCallLabel('read', 'string'), null);
  });
  it('extracts skill name for invoke_skill', () => {
    assert.equal(
      extractToolCallLabel('invoke_skill', { skill: 'claw-cli' }),
      'invoke_skill claw-cli'
    );
  });
});
```

#### buildSessionTrimPreview（需先添加 export）

```js
describe('buildSessionTrimPreview', () => {
  it('builds rounds from user-assistant message pairs', () => {
    const messages = [
      { role: 'user', content: 'Hello', turn: 1 },
      { role: 'assistant', content: 'Hi there', turn: 1 },
      { role: 'user', content: 'How are you?', turn: 2 },
      { role: 'assistant', content: 'Good', turn: 2 },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0].userPreview, 'Hello');
    assert.equal(rounds[0].assistantPreview, 'Hi there');
    assert.equal(rounds[0].suggestedTrim, true);  // 第 1 轮，被建议裁剪
    assert.equal(rounds[1].suggestedTrim, false); // 最近 2 轮不裁剪
  });

  it('handles empty messages', () => {
    assert.deepEqual(buildSessionTrimPreview([]), []);
  });

  it('captures tool call labels in assistant messages', () => {
    const messages = [
      { role: 'user', content: 'Read file', turn: 1 },
      {
        role: 'assistant', content: 'Reading', turn: 1,
        toolCalls: [{ name: 'read', args: { filePath: '/test.js' } }]
      },
    ];
    const rounds = buildSessionTrimPreview(messages);
    assert.equal(rounds[0].toolCalls[0].summary, 'read test.js');
  });
});
```

### 4.5 文件组织

创建 `test/session-helpers-pure.test.js`，专门覆盖 session-helpers.js 中的纯函数。不需要 mock 文件系统或 agent runtime——只测纯逻辑函数。

---

## 五、推荐执行顺序

```
第一步（可立即开始，互不阻塞）
 ├── B-1: 创建 frontend-markdown-utils.test.js（escapeHtml + renderMarkdown + parseToolResult）
 │        → 这是安全相关（XSS），ROI 最高
 │        → 使用已有 frontend-vm.js 沙箱，无需额外基础设施
 │
 ├── C-1: 给 session-helpers.js 的 4 个纯函数添加 export
 └── C-2: 创建 session-helpers-pure.test.js

第二步（依赖第一步完成）
 └── B-2: 扩展前端测试到 chat-renderer.js 纯函数

注：工作方向 A（Phase C assembly-actions 提取）已于 2026-07-04 完成，不再阻塞。
```

---

## 六、其他可选方向（低优先级，不阻塞上述工作）

| 方向 | 说明 | 优先级 |
|------|------|--------|
| work-group-ui.js 继续拆分 | 主文件 4,363 行 + wg-core 3,034 行仍偏大，但群聊功能在迭代中 | 低（等功能稳定）|
| open-sessions-tracker.js 补测 | 155 行新功能，零测试覆盖 | 低 |
| handoff-package.js 补测 | 649 行，仅有间接覆盖 | 低 |
| group-chat.js 架构改善 | 4,441 行，当前最大服务端模块 | 低（等功能稳定）|

---

## 七、快速验证命令

```bash
# 运行全部测试
npm test

# 只跑 core 测试
npm run test:core

# 只跑 feature 测试
npm run test:features

# 覆盖率报告
npm run test:coverage

# 检查前端文件行数
wc -l public/src/app-main.js public/src/app-ui.js public/src/app-core.js

# 检查已拆出模块数量
ls public/src/modules/*.js | wc -l
```

---

*本文档基于 2026-07-12 的代码盘点创建。执行者在开始工作前应先运行 `npm test` 确认全绿，再以实际代码行号为准。*
