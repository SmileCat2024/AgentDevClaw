# 群聊闭环：执行规格书

> **用途**：供执行 agent 逐条实现，不需额外猜测。
> **前置**：Phase 0（Identity Registry）+ Phase 1（群聊数据层 + Level 1 mention 派发）已完成。
> **依赖文档**：[2026-06-19-group-chat-implementation-plan.md](./2026-06-19-group-chat-implementation-plan.md)

---

## 总览

构建一个完整的群聊闭环：

```
用户建群（选成员） → @mention 派活 → agent 执行 → 状态可见 → @管理员 协调 → 摘要沉淀
```

8 个工作项，按依赖顺序分 4 批执行：

| 批次 | 工作项 | 依赖 |
|------|--------|------|
| Batch 1 | WI-1: 会话映射 + WI-2: 增强 dispatch | 无 |
| Batch 2 | WI-3: 建群选成员 UI + WI-4: 成员显示 | 无 |
| Batch 3 | WI-6: 管理员工具 Feature + WI-5: 管理员 Agent 定义 | WI-1/2 的 API |
| Batch 4 | WI-7: @管理员路由 + WI-8: summary 消息 | WI-5/6 |

---

## WI-1: 会话映射（server.js）

### 目标

群聊文件增加 `sessions` 字段，记录 `identityRef → sessionId` 映射。persistent 身份的 agent 在同一群聊内复用同一个 session。

### 数据结构变更

群聊 JSON（`~/.agentdev/AgentDevClaw/group-chats/<chatId>.json`）增加顶层字段：

```json
{
  "id": "chat-xxx",
  "name": "系统重构",
  "sessions": {
    "programming-helper:main": "session-aaa111"
  },
  "members": [...],
  "messages": [...]
}
```

- key = identityRef（如 `programming-helper:main`）
- value = prebuilt session ID（如 `session-1718793000123-a1b2c3`）
- one-shot 身份（explorer）不在此映射中——每次 @mention 都创建新 session

### 需要修改的位置

**文件**：`server.js`

**1. `readGroupChat()`**（约 line 6196）— 无需修改，JSON.parse 自然包含 `sessions` 字段。

**2. `writeGroupChat()`**（约 line 6204）— 无需修改，JSON.stringify 自然写入 `sessions` 字段。

**3. 新增函数：`resolveGroupChatSession(chatId, identityRef, sessionModel)`**

插入位置：`updateMessageRouting` 函数之后（约 line 6270 附近）。

```javascript
/**
 * 为群聊中的某个 identity 解析或创建 session。
 * - persistent: 首次创建，后续复用
 * - one-shot: 总是创建新的
 * 返回 { sessionId, isNew }
 */
async function resolveGroupChatSession(chatId, identityRef, sessionModel) {
  const chat = await readGroupChat(chatId);
  if (!chat) throw new Error(`Group chat not found: ${chatId}`);

  // one-shot: 总是创建新 session
  if (sessionModel === 'one-shot') {
    const workspaceId = identityRef.split(':')[0];
    const agent = await requireAgentLight(workspaceId);
    const session = await createPrebuiltSession(agent.id, {
      sessionType: 'exploration',
    });
    return { sessionId: session.id, isNew: true };
  }

  // persistent: 检查映射
  if (!chat.sessions) chat.sessions = {};
  const existing = chat.sessions[identityRef];
  if (existing) {
    // 验证 session 是否仍存在于 index 中
    const workspaceId = identityRef.split(':')[0];
    const index = await readSessionIndex(workspaceId);
    const found = index.sessions.find((s) => s.id === existing);
    if (found) {
      return { sessionId: existing, isNew: false };
    }
    // session 不存在了（可能被删除），重建
  }

  // 创建新 session 并存储映射
  const workspaceId = identityRef.split(':')[0];
  const agent = await requireAgentLight(workspaceId);
  const session = await createPrebuiltSession(agent.id, {});
  chat.sessions[identityRef] = session.id;
  await writeGroupChat(chat);
  return { sessionId: session.id, isNew: true };
}
```

**关键依赖**：
- `createPrebuiltSession(agentId, options)` — 已存在（line 3929），用于创建 session 记录
- `readSessionIndex(agentId)` — 已存在（line 2712），用于验证 session 存在
- `requireAgentLight(agentId)` — 已存在（line 4850），用于获取 agent 信息

---

## WI-2: 增强 dispatch（server.js）

### 目标

`dispatchGroupChatMessage` 改为：按 sessionModel 决定创建/复用 session，然后启动该 session 的 runtime，最后派发消息。

### 需要修改的位置

**文件**：`server.js`

**修改函数**：`dispatchGroupChatMessage`（约 line 6257）

当前逻辑（需替换的部分）：

```javascript
// 当前的步骤 1：找到或启动 agent runtime
let runtime = getAgentRuntime(workspaceId);
const isAlive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;
if (!isAlive) {
  const agent = await requireAgentLight(workspaceId);
  await startManagedAgent(agent);
  runtime = await waitForManagedRuntimeReady(workspaceId, 30000);
}
```

替换为：

```javascript
// 步骤 1：解析 identity 的 sessionModel
const identityRef = routing.targetIdentityRef;
const allIdentities = await buildAllIdentities(); // 已有的函数，返回所有 identities
const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
const sessionModel = identityInfo?.sessionModel || 'persistent';

// 步骤 2：解析或创建 session（使用 WI-1 的新函数）
const { sessionId, isNew } = await resolveGroupChatSession(chatId, identityRef, sessionModel);

// 步骤 3：找到或启动指定 session 的 runtime
let runtime = getAgentRuntime(workspaceId, sessionId);
const isAlive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;
if (!isAlive) {
  const agent = await requireAgentLight(workspaceId);
  await startManagedAgent(agent, sessionId);
  runtime = await waitForManagedRuntimeReady(workspaceId, 30000, sessionId);
  if (!runtime) {
    throw new Error('Agent runtime failed to become ready within 30s');
  }
}
```

**同步修改 routing 记录**：在 "delivered" 更新中，确保 `targetSessionId` 使用解析出的 `sessionId`：

```javascript
await updateMessageRouting(chatId, message.id, {
  status: 'delivered',
  targetSessionId: sessionId,  // ← 改为使用解析出的 sessionId
  dispatchedAt: Date.now(),
});
```

**注意**：`getAgentRuntime` 的第二个参数是 `sessionId`，当传入时按 `agentId + sessionId` 精确查找 runtime（line 7307-7311）。`startManagedAgent` 的第二个参数也是 `selectedSessionId`，会以该 session 启动 runtime。`waitForManagedRuntimeReady` 接受第三个参数 `sessionId`。

**关键依赖**：
- `buildAllIdentities()` — 已在 identities API 中使用，返回所有 identity 信息（含 sessionModel）
- `resolveGroupChatSession()` — WI-1 新增
- `getAgentRuntime(agentId, sessionId)` — 已存在（line 7307），传入 sessionId 时精确匹配
- `startManagedAgent(agent, sessionId)` — 已存在（line 5312），接受 selectedSessionId

---

## WI-3: 建群选成员 UI（work-group-ui.js）

### 目标

新建群聊时，从 identities API 拉取所有可用身份，以扁平列表（checkbox）形式让用户逐个选择。不预设哪些身份该选、不该选——全部列出，用户自选。

### 需要修改的位置

**文件**：`public/src/modules/work-group-ui.js`

**1. 修改 `handleNewChat()` 函数**（约 line 467）

当前实现使用 `prompt()` 输入群名。替换为一个模态对话框，包含：
- 群名输入框
- 身份列表（checkbox），从 `/protoclaw/identities` 加载
- 确认/取消按钮

```javascript
async function handleNewChat() {
  // 渲染建群模态框
  const modal = document.createElement('div');
  modal.className = 'wg-modal-overlay';

  const identityCheckboxes = identities.map((id) => {
    return `<label class="wg-modal-identity">
      <input type="checkbox" value="${esc(id.identityRef)}" />
      <span class="wg-modal-identity-name">${esc(id.displayName)}</span>
      <span class="wg-modal-identity-desc">${esc(id.description || '')}</span>
      <span class="wg-modal-identity-tag">${esc(id.sessionModel)}</span>
    </label>`;
  }).join('');

  modal.innerHTML = `
    <div class="wg-modal">
      <div class="wg-modal-title">新建群聊</div>
      <input type="text" class="wg-modal-input" data-wg-role="new-chat-name" placeholder="群聊名称" />
      <div class="wg-modal-section-title">选择成员</div>
      <div class="wg-modal-identity-list">${identityCheckboxes}</div>
      <div class="wg-modal-actions">
        <button class="wg-modal-btn cancel" data-wg-action="cancel-new-chat">取消</button>
        <button class="wg-modal-btn confirm" data-wg-action="confirm-new-chat">创建</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  // 事件处理通过 onContainerClick 的 data-wg-action 机制
  // 但模态框在 body 上，不在 .wg-app 内，需要单独绑定
  // 简化方案：直接在 modal 内绑定 onclick
}
```

**2. 在 `onContainerClick` 中增加模态框动作处理**

模态框不在 `.wg-app` 容器内（它在 `document.body` 上），因此现有的事件委托无法捕获。需要在创建模态框时直接绑定事件：

```javascript
// confirm 按钮
modal.querySelector('[data-wg-action="confirm-new-chat"]').addEventListener('click', async () => {
  const name = modal.querySelector('[data-wg-role="new-chat-name"]').value.trim();
  if (!name) return;

  const selected = Array.from(modal.querySelectorAll('input[type="checkbox"]:checked'))
    .map((cb) => cb.value);

  const members = [
    { identityRef: 'user', role: 'human' },
    ...selected.map((ref) => ({ identityRef: ref, role: 'agent' })),
  ];

  document.body.removeChild(modal);

  try {
    const chat = await apiPost('/protoclaw/group_chats', { name, members });
    await loadChatSummaries();
    refreshChatList();
    await selectChat(chat.id);
  } catch (err) {
    alert('创建群聊失败: ' + err.message);
  }
});

// cancel 按钮
modal.querySelector('[data-wg-action="cancel-new-chat"]').addEventListener('click', () => {
  document.body.removeChild(modal);
});
```

**3. 新增 CSS**（`public/styles/components.css`）

```css
/* ── 建群模态框 ── */
.wg-modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000;
}
.wg-modal {
  background: var(--bg-color); border-radius: 8px; padding: 20px;
  width: 420px; max-height: 80vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2);
}
.wg-modal-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
.wg-modal-input {
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--border-color); border-radius: 4px;
  font-size: 13px; margin-bottom: 16px; background: var(--bg-color); color: var(--text-primary);
}
.wg-modal-section-title { font-size: 13px; font-weight: 500; margin-bottom: 8px; color: var(--text-secondary); }
.wg-modal-identity-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
.wg-modal-identity {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  border-radius: 4px; cursor: pointer; font-size: 13px;
}
.wg-modal-identity:hover { background: var(--hover-bg); }
.wg-modal-identity-name { font-weight: 500; }
.wg-modal-identity-desc { color: var(--text-muted); font-size: 11px; flex: 1; }
.wg-modal-identity-tag { font-size: 10px; color: var(--text-muted); background: var(--hover-bg); padding: 1px 6px; border-radius: 3px; }
.wg-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.wg-modal-btn { padding: 6px 16px; border-radius: 4px; font-size: 13px; cursor: pointer; border: 1px solid var(--border-color); }
.wg-modal-btn.cancel { background: none; color: var(--text-secondary); }
.wg-modal-btn.confirm { background: var(--accent-color, #4a9eff); color: white; border: none; }
```

---

## WI-4: 成员显示增强（work-group-ui.js）

### 目标

群聊头部（awareness bar）显示真实的群成员。消息流中，agent 身份发出的消息（目前主要是管理员的 summary）显示对应的身份名。

### 需要修改的位置

**文件**：`public/src/modules/work-group-ui.js`

**1. `renderAwarenessBar(chat)` 函数**（约 line 143）

当前只显示 `role === 'agent'` 的成员。修改为显示所有非 human 成员，并区分身份类型：

```javascript
function renderAwarenessBar(chat) {
  const agentMembers = (chat.members || []).filter((m) => m.role !== 'human');
  const memberChips = agentMembers.map((m) => {
    const id = identities.find((i) => i.identityRef === m.identityRef);
    const name = id ? id.displayName : m.identityRef;
    const tag = id ? ` <span class="wg-member-tag">${esc(id.sessionModel)}</span>` : '';
    return [
      '<span class="wg-member-chip">',
      `<span class="wg-member-name">${esc(name)}</span>`,
      tag,
      '</span>',
    ].join('');
  }).join('');
  // ...rest unchanged
}
```

**2. 新增 CSS**（`public/styles/components.css`）

```css
.wg-member-tag {
  font-size: 10px; color: var(--text-muted);
  background: var(--hover-bg); padding: 1px 4px; border-radius: 3px; margin-left: 4px;
}
```

---

## WI-5: 管理员 Agent 定义（prebuilt-agents）

### 目标

创建独立的 `work-group-admin` prebuilt agent。

### 新建文件

**1. `prebuilt-agents/official/work-group-admin/metadata.json`**

```json
{
  "id": "work-group-admin",
  "kind": "agent",
  "name": "群管理员",
  "description": "群聊协调者，负责任务路由、工作摘要和状态监控",
  "version": "0.1.0",
  "icon": "users",
  "category": "workspace",
  "enabled": true,
  "modelPresets": {
    "default": "智谱GLM-4.7 Flash"
  },
  "features": [
    "group-admin"
  ],
  "identities": [
    {
      "id": "admin",
      "displayName": "管理员",
      "description": "群聊协调者，可以查看群状态、派发任务、生成摘要",
      "sessionModel": "persistent",
      "operations": ["status", "sessions", "send"]
    }
  ],
  "ui": {
    "entry": "sessions",
    "tabs": [
      {
        "id": "sessions",
        "label": { "zh": "对话", "en": "Sessions" }
      }
    ]
  }
}
```

**2. `prebuilt-agents/official/work-group-admin/agent.js`**

```javascript
/**
 * 群管理员 Agent
 *
 * 群聊系统的协调者，提供群聊管理工具。
 * 通过 GroupAdminFeature 暴露 gc_* 工具集。
 */
import { BasicAgent, TemplateComposer } from 'agentdev';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { GroupAdminFeature } from '../../../local-features/dist/group-admin/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

function readSystemPrompt() {
  if (!existsSync(SYSTEM_PROMPT_PATH)) return '';
  try {
    return readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  } catch {
    return '';
  }
}

const systemPrompt = readSystemPrompt();

const agent = new BasicAgent({
  id: 'work-group-admin',
  name: '群管理员',
  model: { /* 使用默认 modelPresets */ },
});

agent.use(new GroupAdminFeature());

agent.composer = new TemplateComposer({
  systemPrompt,
});

export default agent;
```

**3. `prebuilt-agents/official/work-group-admin/.agentdev/prompts/system.md`**

```markdown
# 群管理员

你是群聊系统的管理员，负责协调群聊中多个 Agent 的协作。

## 你的能力

- **查看群聊**：使用 `gc_overview` 查看所有群聊及其成员和状态
- **读取消息**：使用 `gc_messages` 读取指定群聊的最近消息
- **派发任务**：使用 `gc_dispatch` 向指定群聊中的 Agent 派发任务
- **生成摘要**：使用 `gc_summary` 向群聊写入一条工作摘要
- **查看状态**：使用 `gc_status` 查看所有 Agent 的运行状态

## 工作原则

1. 你的回复会直接写入群聊消息流，请保持简洁
2. 用户让你总结时，先用 `gc_messages` 读取消息，再用 `gc_summary` 写入摘要
3. 用户让你派发任务时，用 `gc_dispatch` 派发，不要自己执行编码任务
4. 你不直接编码，你是协调者
```

**4. 确认 `work-group-admin` 不在 `HIDDEN_PREBUILT_AGENT_IDS` 中**

检查 `server.js` line 56 附近：

```javascript
const HIDDEN_PREBUILT_AGENT_IDS = new Set(['agent-creator', 'flow-test']);
```

`work-group-admin` 不在此集合中，默认可见。但它也不需要出现在侧边栏——它通过群聊 @管理员 触发。

如果不想让它在侧边栏显示，可以加入 `HIDDEN_PREBUILT_AGENT_IDS`。但建议先不加，方便调试。

---

## WI-6: 管理员工具 Feature（local-features）

### 目标

创建 `GroupAdminFeature`，暴露 5 个工具供管理员 agent 使用。

### 新建文件

**1. `local-features/group-admin/src/index.ts`**

```typescript
/**
 * GroupAdminFeature - 群聊管理员工具集
 *
 * 提供群聊状态查看、消息读取、任务派发、摘要写入等工具。
 * 所有工具通过 HTTP API 调用 Claw server。
 */
import type { AgentFeature } from 'agentdev';

const SERVER_ORIGIN = process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';

export class GroupAdminFeature implements AgentFeature {
  readonly name = 'group-admin';

  private async apiGet(path: string): Promise<any> {
    const res = await fetch(`${SERVER_ORIGIN}${path}`);
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
    return res.json();
  }

  private async apiPost(path: string, body: any): Promise<any> {
    const res = await fetch(`${SERVER_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
    return res.json();
  }

  getTools() {
    return [
      {
        name: 'gc_overview',
        description: '查看所有群聊的概览，包括群名、成员、消息数、最近活动',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        handler: async () => {
          const data = await this.apiGet('/protoclaw/group_chats');
          const chats = data.chats || [];
          const lines = chats.map((c: any) => {
            return `【${c.name}】(id: ${c.id})\n  成员数: ${c.memberCount}, 消息数: ${c.messageCount}\n  最近: ${c.lastMessage?.text || '(无)'}`;
          });
          return { content: lines.join('\n\n') || '暂无群聊' };
        },
      },
      {
        name: 'gc_messages',
        description: '读取指定群聊的最近消息',
        inputSchema: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            limit: { type: 'number', description: '消息数量，默认 20' },
          },
          required: ['chatId'],
        },
        handler: async (input: { chatId: string; limit?: number }) => {
          const limit = input.limit || 20;
          const data = await this.apiGet(
            `/protoclaw/group_chats/${encodeURIComponent(input.chatId)}/messages?limit=${limit}`
          );
          const msgs = data.messages || [];
          const lines = msgs.map((m: any) => {
            const routing = m.routing ? ` [${m.routing.status}]` : '';
            return `[${new Date(m.timestamp).toLocaleString()}] ${m.from}: ${m.text}${routing}`;
          });
          return { content: lines.join('\n') || '暂无消息' };
        },
      },
      {
        name: 'gc_dispatch',
        description: '向指定群聊中的 Agent 派发任务',
        inputSchema: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            text: { type: 'string', description: '任务描述' },
            identityRef: { type: 'string', description: '目标身份，如 programming-helper:main' },
          },
          required: ['chatId', 'text', 'identityRef'],
        },
        handler: async (input: { chatId: string; text: string; identityRef: string }) => {
          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(input.chatId)}/messages`,
            {
              text: input.text,
              mentions: [{ identityRef: input.identityRef }],
            }
          );
          return { content: `已派发任务到 ${input.identityRef}，消息 ID: ${msg.id}` };
        },
      },
      {
        name: 'gc_summary',
        description: '向指定群聊写入一条工作摘要',
        inputSchema: {
          type: 'object',
          properties: {
            chatId: { type: 'string', description: '群聊 ID' },
            text: { type: 'string', description: '摘要内容' },
          },
          required: ['chatId', 'text'],
        },
        handler: async (input: { chatId: string; text: string }) => {
          const msg = await this.apiPost(
            `/protoclaw/group_chats/${encodeURIComponent(input.chatId)}/messages`,
            {
              text: input.text,
              from: 'work-group-admin:admin',
              kind: 'summary',
            }
          );
          return { content: `摘要已写入，消息 ID: ${msg.id}` };
        },
      },
      {
        name: 'gc_status',
        description: '查看所有可用身份及其运行状态',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        handler: async () => {
          const data = await this.apiGet('/protoclaw/identities');
          const ids = data.identities || [];
          const lines = ids.map((i: any) => {
            return `${i.displayName} (${i.identityRef})\n  ${i.description || ''}\n  session: ${i.sessionModel}`;
          });
          return { content: lines.join('\n\n') || '暂无可用身份' };
        },
      },
    ];
  }
}
```

**2. `local-features/group-admin/tsconfig.json`**

从 `local-features/dispatch/tsconfig.json` 复制，修改 `rootDir` 和 `outDir` 指向 `group-admin`。

**3. `local-features/group-admin/package.json`**

从 `local-features/dispatch/package.json` 复制，修改 name 为 `@claw/group-admin-feature`。

**4. 构建配置**

在 `local-features/tsconfig.json` 的 `include` 中添加：

```json
"group-admin/src/**/*.ts"
```

在 `package.json` 的 `build:local-features` 脚本中确认 tsup 会编译 group-admin。

**5. 构建验证**

```bash
npm run build:local-features
# 确认 local-features/dist/group-admin/src/index.js 存在
```

---

## WI-7: @管理员路由（server.js）

### 目标

当群聊消息的 mention 目标是 `work-group-admin:admin` 时，服务端自动启动管理员 runtime（如果未运行）并派发消息。这与普通 agent 的 dispatch 路径相同（WI-2），管理员就是一个普通的 prebuilt agent。

### 需要修改的位置

**文件**：`server.js`

**修改 `dispatchGroupChatMessage` 函数中的 identityRef 解析逻辑**

当前代码（WI-2 之后）使用 `routing.targetWorkspaceId` 来查找 agent。对于管理员：

- `identityRef` = `work-group-admin:admin`
- `targetWorkspaceId` = `work-group-admin`（split(':')[0]）

这已经能正确解析到 `work-group-admin` 作为 workspaceId。WI-2 的 `resolveGroupChatSession` 也会正确处理（创建 persistent session）。

**因此，@管理员路由不需要额外代码**。WI-2 的增强 dispatch 天然支持管理员——管理员就是一个 workspaceId 为 `work-group-admin` 的 prebuilt agent。

**唯一需要确认的点**：`buildAllIdentities()` 是否包含 `work-group-admin:admin`。

检查 identities API 的逻辑（`GET /protoclaw/identities`）：它扫描所有 prebuilt agents 的 `metadata.json`，读取 `identities` 数组。只要 WI-5 的 `metadata.json` 正确声明了 identities，管理员身份会自动出现在 identities 列表中。

### 需要补充的：POST messages 端点支持 `from` 和 `kind` 参数

**文件**：`server.js`

**修改 `POST /protoclaw/group_chats/:chatId/messages` 端点**（约 line 6533）

当前：

```javascript
const { text, mentions, links } = req.body || {};
```

增加 `from` 和 `kind`：

```javascript
const { text, mentions, links, from, kind } = req.body || {};
```

消息对象中：

```javascript
const message = {
  // ...
  from: from || 'user',  // ← 允许指定发送者
  kind: kind || 'text',  // ← 允许指定消息类型
  // ...
};
```

当 `from` 不是 `'user'` 时，不触发 dispatch（agent 写入的消息不需要再派发）。修改触发条件：

```javascript
// 异步派发（不阻塞响应）——仅 user 发送的带 mention 消息触发
if ((from || 'user') === 'user' && message.mentions.length > 0 && message.routing) {
  dispatchGroupChatMessage(chat.id, message).catch((err) => {
    console.error(`[GroupChat] dispatch failed for ${message.id}:`, err);
  });
}
```

同时，非 user 发送的消息不需要 routing 字段：

```javascript
if ((from || 'user') === 'user' && message.mentions.length > 0) {
  // 初始化 routing
  message.routing = { ... };
}
```

---

## WI-8: Summary 消息渲染（work-group-ui.js + server.js）

### 目标

`kind: 'summary'` 的消息在 UI 中有特殊样式（带左边框、不同背景色），区别于普通聊天消息。

### server.js

无需额外修改。WI-7 已经支持 `kind` 参数。Summary 消息就是一条 `kind: 'summary'`、`from: 'work-group-admin:admin'` 的普通消息。

### work-group-ui.js

**修改 `renderMessageBubble(chat, msg)` 函数**（约 line 175）

增加 summary 样式：

```javascript
function renderMessageBubble(chat, msg) {
  const isMe = msg.from === 'user';
  const isSummary = msg.kind === 'summary';
  const name = getMemberName(chat, msg.from);
  // ...

  // bubble class 增加 summary
  const bubbleClass = isSummary ? 'summary' : '';

  // 在 isMe 分支和 agent 分支的 bubble 中：
  `    <div class="wg-msg-bubble ${bubbleClass}">${esc(msg.text)}</div>`,
```

**新增 CSS**（`public/styles/components.css`）

```css
.wg-msg-bubble.summary {
  background: var(--hover-bg);
  border-left: 3px solid var(--accent-color, #4a9eff);
  font-size: 12px;
  line-height: 1.6;
}
```

**修改消息发送者的名称解析**

`getMemberName` 需要处理 agent 发送者：

```javascript
function getMemberName(chat, from) {
  if (from === 'user') return '我';
  // 查找群成员
  const m = (chat.members || []).find((mem) => mem.identityRef === from);
  if (m) {
    const id = identities.find((i) => i.identityRef === from);
    return id ? id.displayName : from;
  }
  // 非 group 成员的 agent 发送者（如管理员写 summary 时可能不在 members 列表中）
  const idInfo = identities.find((i) => i.identityRef === from);
  return idInfo ? idInfo.displayName : from;
}
```

---

## 执行顺序与验证检查点

### Batch 1：WI-1 + WI-2

**执行步骤**：
1. 在 `server.js` 中新增 `resolveGroupChatSession` 函数
2. 修改 `dispatchGroupChatMessage` 使用 session 映射

**验证**：
```bash
node -c server.js  # 语法检查
npm run test:core  # 回归测试
```

手动验证（需要运行 server）：
1. 创建群聊
2. 发送带 @mention 的消息
3. 检查 `~/.agentdev/AgentDevClaw/group-chats/<chatId>.json` 中是否有 `sessions` 字段
4. 再次发送 @mention，确认复用同一 session

### Batch 2：WI-3 + WI-4

**执行步骤**：
1. 重写 `handleNewChat` 使用模态框
2. 添加模态框 CSS
3. 修改 `renderAwarenessBar` 显示成员标签
4. 添加成员标签 CSS

**验证**：
- 打开 work-group workspace
- 点击 + 新建群聊
- 确认模态框显示身份列表
- 选几个身份、输入群名、创建
- 确认群聊头部显示选中的成员

### Batch 3：WI-6 + WI-5

**执行步骤**：
1. 创建 `local-features/group-admin/` 目录结构
2. 编写 `src/index.ts`、`tsconfig.json`、`package.json`
3. 更新 `local-features/tsconfig.json` include
4. 运行 `npm run build:local-features`
5. 创建 `prebuilt-agents/official/work-group-admin/` 目录结构
6. 编写 `metadata.json`、`agent.js`、`.agentdev/prompts/system.md`

**验证**：
```bash
npm run build:local-features
# 确认 dist/group-admin/src/index.js 存在
node -c prebuilt-agents/official/work-group-admin/agent.js  # 不行，ESM
# 手动检查 agent.js import 路径正确
```

### Batch 4：WI-7 + WI-8

**执行步骤**：
1. 修改 POST messages 端点支持 `from` 和 `kind`
2. 修改 dispatch 触发条件
3. 修改 `renderMessageBubble` 支持 summary 样式
4. 修改 `getMemberName` 处理 agent 发送者
5. 添加 summary 样式 CSS

**验证**：
```bash
node -c server.js
npm run test:core
```

手动验证：
1. 在群聊中 @管理员
2. 确认管理员 runtime 启动
3. 确认管理员能收到消息并回复
4. 确认 summary 消息有特殊样式

---

## 附录：现有函数速查

执行 agent 需要频繁引用的现有函数：

| 函数 | 位置 | 用途 |
|------|------|------|
| `readGroupChat(chatId)` | server.js ~6196 | 读取群聊 JSON |
| `writeGroupChat(chat)` | server.js ~6204 | 写入群聊 JSON |
| `appendGroupChatMessage(chatId, msg)` | server.js ~6210 | 追加消息 |
| `updateMessageRouting(chatId, msgId, update)` | server.js ~6220 | 更新 routing |
| `getAgentRuntime(agentId, sessionId)` | server.js ~7307 | 查找 runtime |
| `startManagedAgent(agent, sessionId)` | server.js ~5312 | 启动 runtime |
| `waitForManagedRuntimeReady(agentId, timeout, sessionId)` | server.js ~5249 | 等待 ready |
| `createPrebuiltSession(agentId, options)` | server.js ~3929 | 创建 session 记录 |
| `readSessionIndex(agentId)` | server.js ~2712 | 读取 session 索引 |
| `requireAgentLight(agentId)` | server.js ~4850 | 获取 agent 信息 |
| `buildAllIdentities()` | server.js identities API 中 | 聚合所有身份 |
| `sanitizeSessionFragment(str)` | server.js | 文件名安全化 |
| `getManagedRuntimeKey(agentId, sessionId)` | server.js ~707 | runtime key |
