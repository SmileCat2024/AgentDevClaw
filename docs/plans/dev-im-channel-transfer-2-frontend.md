# 子任务 2：前端 UI 下拉框与状态管理

## 目标

在 IM 工作空间配置面板的每个渠道卡片下方，添加一个下拉框，展示当前可连接的 programming-helper 主对话列表，用户选择后触发线路转接。

## 文件

- `D:\code\AgentDevClaw\public\src\app-ui.js` — UI 渲染
- `D:\code\AgentDevClaw\public\src\app-main.js` — 操作处理
- `D:\code\AgentDevClaw\public\src\app-core.js` — 状态扩展（可选，可能不需要改）

## 详细上下文

### 当前 UI 渲染入口

`renderIMWorkspaceConfigEditor(block)` 位于 `app-ui.js` L2337-2457。

当前结构：
```
<div class="im-workspace-channel-grid">
  <section class="im-workspace-channel-card">  <!-- QQ 渠道卡 -->
    <div class="im-workspace-channel-head">...</div>
    <div class="workspace-config-grid">
      ... fields (appId, clientSecret, accountId, markdownSupport)
    </div>
  </section>
  <section class="im-workspace-channel-card">  <!-- 微信渠道卡 -->
    <div class="im-workspace-channel-head">...</div>
    ... weixin actions html
  </section>
</div>
<section class="workspace-section">  <!-- 接待员身份区 -->
  ...
</section>
```

**需要在每个 `</section>` 之前（渠道卡片闭合标签前），添加线路绑定下拉框。**

### 当前前端状态

`imWorkspaceState` 位于 `app-core.js` L331：
```js
let imWorkspaceState = {
  data: null,
  draft: null,
  loading: false,
  saving: false,
  binding: false,
  polling: false,
  error: '',
  savedAt: null,
  weixinQrDialogOpen: false,
};
```

`normalizeIMWorkspaceBundleData(raw)` 位于 `app-ui.js` L1470-1530：
将服务端返回的 bundle 数据标准化。

`getIMWorkspaceDraft()` 返回当前 draft 或 data 或空对象。

### 当前操作处理

`window.updateIMWorkspaceField(fieldPath, value)` 位于 `app-main.js` L2815：
支持 dot-path 更新 draft 中的嵌套字段。

`window.scheduleIMWorkspaceAutoSave()` L2848：
250ms 延迟后调用 `saveIMWorkspaceConfig()`。

`window.saveIMWorkspaceConfig()` L2867：
PUT 到 `/protoclaw/im_workspace_bundle`。

## 详细步骤

### 步骤 1：扩展 normalizeIMWorkspaceBundleData（app-ui.js L1470）

在 channels 标准化中增加 `boundSession` 字段，在顶层增加 `connectableSessions`。

```js
// 在 channels 对象中，每个 channel 增加 boundSession
qq: {
  label: ...,
  role: ...,
  note: ...,
  boundSession: raw?.channels?.qq?.boundSession
    ? normalizeBoundSessionData(raw.channels.qq.boundSession) : null,
},
weixin: {
  label: ...,
  role: ...,
  note: ...,
  boundSession: raw?.channels?.weixin?.boundSession
    ? normalizeBoundSessionData(raw.channels.weixin.boundSession) : null,
},

// 新增顶层字段
connectableSessions: Array.isArray(raw?.connectableSessions)
  ? raw.connectableSessions.map(s => ({
      id: typeof s?.id === 'string' ? s.id : '',
      title: typeof s?.title === 'string' ? s.title : '',
      updatedAt: s?.updatedAt || null,
    })).filter(s => s.id)
  : [],
```

辅助函数：
```js
function normalizeBoundSessionData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  if (!agentId || !sessionId) return null;
  return { agentId, sessionId };
}
```

**位置**：在 `normalizeIMWorkspaceBundleData` 函数内部的 `workspaceConfig.channels` 块中添加。

注意：`raw` 参数中的 `channels` 来自 `raw.workspaceConfig.channels`，不是顶层 `raw.channels`。
当前代码中 `const channels = workspaceConfig?.channels`（L1472），所以 `boundSession` 应该从 `channels.qq.boundSession` 读取。

### 步骤 2：添加线路绑定下拉框 UI（app-ui.js renderIMWorkspaceConfigEditor）

在每个渠道卡片（QQ 和微信）的 `</section>` 闭合标签前，添加线路绑定下拉框。

**具体位置**：
- QQ 卡片：L2428 的 `'</div>'` (config-grid 闭合) 之后，L2429 的 `'</section>'` 之前
- 微信卡片：L2435 的 `weixinActionsHtml` 之后，L2436 的 `'</section>'` 之前

封装一个渲染函数：

```js
function renderChannelBindingDropdown(channelId, draft) {
  const channel = draft.workspaceConfig?.channels?.[channelId];
  const boundSession = channel?.boundSession;
  const sessions = draft.connectableSessions || [];

  const currentId = boundSession ? `${boundSession.agentId}::${boundSession.sessionId}` : '';
  const options = [
    '<option value="">-- 未连接 --</option>',
    ...sessions.map(s => {
      const val = `programming-helper::${s.id}`;
      const selected = currentId === val ? ' selected' : '';
      return `<option value="${escapeHtml(val)}"${selected}>${escapeHtml(s.title || s.id)}</option>`;
    }),
  ].join('');

  const boundLabel = boundSession
    ? `<span class="im-binding-status bound">已连接: ${escapeHtml(boundSession.sessionId.slice(0, 20))}...</span>`
    : '<span class="im-binding-status unbound">未连接</span>';

  return [
    '<div class="im-channel-binding">',
    '<div class="im-channel-binding-header">',
    '<span class="im-channel-binding-label">线路连接</span>',
    boundLabel,
    '</div>',
    '<select class="workspace-config-select" onchange="window.handleIMTransferChange(\'' + channelId + '\', this.value)">',
    options,
    '</select>',
    '</div>',
  ].join('');
}
```

然后在 `renderIMWorkspaceConfigEditor` 中调用：
- QQ 卡片区域：在 fields 渲染后加入 `renderChannelBindingDropdown('qq', draft)`
- 微信卡片区域：在 weixinActionsHtml 后加入 `renderChannelBindingDropdown('weixin', draft)`

### 步骤 3：添加前端操作处理（app-main.js）

在 `window.saveIMWorkspaceConfig` 之后（约 L2902 后）添加：

```js
window.handleIMTransferChange = async (channelId, compositeValue) => {
  // compositeValue 格式: "agentId::sessionId" 或空字符串
  if (!compositeValue) {
    // 断开连接
    try {
      const response = await fetch('/protoclaw/im_transfer/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      if (payload.bundle) {
        const bundle = normalizeIMWorkspaceBundleData(payload.bundle);
        imWorkspaceState.data = bundle;
        imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
      }
    } catch (error) {
      console.error('Failed to disconnect IM channel:', error);
      imWorkspaceState.error = error.message || String(error);
    }
    renderCurrentMainView();
    return;
  }

  const [agentId, sessionId] = compositeValue.split('::');
  if (!agentId || !sessionId) return;

  try {
    const response = await fetch('/protoclaw/im_transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, agentId, sessionId }),
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    if (payload.bundle) {
      const bundle = normalizeIMWorkspaceBundleData(payload.bundle);
      imWorkspaceState.data = bundle;
      imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
    }
  } catch (error) {
    console.error('Failed to transfer IM channel:', error);
    imWorkspaceState.error = error.message || String(error);
  }
  renderCurrentMainView();
};
```

### 步骤 4：CSS 样式（public/styles/components.css）

添加下拉框区域样式：

```css
.im-channel-binding {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--workspace-border, #2a2a3e);
}

.im-channel-binding-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.im-channel-binding-label {
  font-size: 12px;
  color: var(--workspace-text-secondary, #8888aa);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.im-binding-status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}

.im-binding-status.bound {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.im-binding-status.unbound {
  background: rgba(100, 116, 139, 0.15);
  color: #64748b;
}
```

## 验证

1. 启动服务，打开 IM 工作空间
2. QQ 和微信渠道卡片下方各出现"线路连接"下拉框
3. 下拉框内容列出 programming-helper 的活跃主对话
4. 选择一个 session 后，配置被更新
5. 清空选择后，绑定被移除
