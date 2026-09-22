# 子任务 1：服务端 API 与配置模型扩展

## 目标

1. 扩展 `im-workspace.config.json` 的数据模型，每个 channel 增加 `boundSession` 字段
2. 扩展 `buildIMWorkspaceBundle()` 返回 `connectableSessions`（programming-helper 的活跃主对话列表）
3. 新增 API：`POST /protoclaw/im_transfer` 执行线路转接
4. 新增 API：`POST /protoclaw/im_transfer/disconnect` 执行线路断开

## 文件

**唯一修改文件**: `D:\code\AgentDevClaw\server.js`

## 详细步骤

### 步骤 1：扩展 normalizeIMChannelConfig（约 L1007）

当前 `normalizeIMChannelConfig` 只返回 `{ label, role, note }`。

需要扩展为：

```js
function normalizeIMChannelConfig(raw = {}, defaults = {}) {
  return {
    label: typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : String(defaults.label || ''),
    role: typeof raw.role === 'string' && raw.role.trim()
      ? raw.role.trim()
      : String(defaults.role || ''),
    note: typeof raw.note === 'string' ? raw.note.trim() : String(defaults.note || ''),
    // 新增：线路绑定目标
    boundSession: normalizeBoundSession(raw.boundSession),
  };
}

function normalizeBoundSession(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!agentId || !sessionId) return null;
  return { agentId, sessionId };
}
```

### 步骤 2：扩展 buildIMWorkspaceBundle（约 L1134）

在 `buildIMWorkspaceBundle` 中增加查询 programming-helper 的活跃主对话。

当前代码：
```js
async function buildIMWorkspaceBundle(agentId = 'qqbot') {
  const [workspaceConfig, qqConfig, weixinConfig, index] = await Promise.all([
    readProjectIMWorkspaceConfig(),
    readProjectQQBotConfig(),
    readProjectWeixinConfig(),
    readSessionIndex(agentId).catch(() => ({ sessions: [], activeSessionId: null })),
  ]);
  // ... build and return bundle
}
```

修改为额外查询 programming-helper 的 session：

```js
async function buildIMWorkspaceBundle(agentId = 'qqbot') {
  const [workspaceConfig, qqConfig, weixinConfig, index, phIndex] = await Promise.all([
    readProjectIMWorkspaceConfig(),
    readProjectQQBotConfig(),
    readProjectWeixinConfig(),
    readSessionIndex(agentId).catch(() => ({ sessions: [], activeSessionId: null })),
    // 新增：获取 programming-helper 的会话列表
    readSessionIndex('programming-helper').catch(() => ({ sessions: [], activeSessionId: null })),
  ]);

  // ... 原有 sessions 处理 ...

  // 新增：筛选 programming-helper 的可连接 session
  // 条件：sessionType === 'main'，且有活跃 runtime
  const connectableSessions = (phIndex?.sessions || [])
    .filter(s => s.sessionType === 'main')
    .map(s => ({
      id: s.id,
      title: s.title || s.id,
      updatedAt: s.updatedAt || null,
    }))
    .filter(s => s.id);

  // ... 在返回对象中增加 connectableSessions ...
  return {
    // ... 原有字段 ...
    connectableSessions,
  };
}
```

注意：runtime 存活判断用 `listAgentRuntimes('programming-helper')` 做交叉过滤更好，
但当前测试阶段可以先返回所有 main session，前端显示 runtime 状态标记即可。

### 步骤 3：新增线路转接 API

在 IM workspace API 区域（约 L6099 之后）添加两个新端点。

#### 3a. POST /protoclaw/im_transfer

```js
app.post('/protoclaw/im_transfer', express.json(), async (req, res, next) => {
  try {
    const { channelId, agentId, sessionId } = req.body || {};
    if (!channelId || !agentId || !sessionId) {
      return res.status(400).json({ error: 'channelId, agentId, sessionId are required' });
    }

    // 1. 验证目标 runtime 存在且存活
    const runtime = getAgentRuntime(agentId, sessionId);
    if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
      return res.status(409).json({ error: `Target runtime ${agentId}::${sessionId} is not running` });
    }

    // 2. 更新配置：channel 绑定到目标 session
    const config = await readProjectIMWorkspaceConfig();
    if (!config.channels[channelId]) {
      return res.status(400).json({ error: `Unknown channel: ${channelId}` });
    }
    config.channels[channelId].boundSession = { agentId, sessionId };
    await writeProjectIMWorkspaceConfig(config);

    // 3. 向目标 runtime 发送注入指令（通过 IPC）
    // 具体实现在子任务 3 的 run-prebuilt-agent.js 中
    if (runtime.process && typeof runtime.process.send === 'function') {
      runtime.process.send({
        type: 'im:transfer',
        channelId,
        imChannelType: channelId, // 'qq' or 'weixin'
      });
    }

    // 4. 如果该 channel 之前绑定了其他 runtime，向旧 runtime 发送移除指令
    // 这里的逻辑需要在配置更新前先读旧值
    // 见下方改进版

    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({ success: true, bundle });
  } catch (error) {
    next(error);
  }
});
```

改进版：需要在更新前先读旧绑定，给旧 runtime 发断开指令：

```js
app.post('/protoclaw/im_transfer', express.json(), async (req, res, next) => {
  try {
    const { channelId, agentId, sessionId } = req.body || {};
    if (!channelId || !agentId || !sessionId) {
      return res.status(400).json({ error: 'channelId, agentId, sessionId are required' });
    }

    const config = await readProjectIMWorkspaceConfig();
    if (!config.channels[channelId]) {
      return res.status(400).json({ error: `Unknown channel: ${channelId}` });
    }

    // 读取旧绑定，如果存在则先断开
    const oldBound = config.channels[channelId].boundSession;
    if (oldBound && oldBound.agentId && oldBound.sessionId) {
      const oldRuntime = getAgentRuntime(oldBound.agentId, oldBound.sessionId);
      if (oldRuntime?.process && typeof oldRuntime.process.send === 'function'
          && !(oldRuntime.process.exitCode !== null || oldRuntime.stopped)) {
        oldRuntime.process.send({ type: 'im:disconnect', channelId });
      }
    }

    // 验证新目标 runtime
    const runtime = getAgentRuntime(agentId, sessionId);
    if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
      return res.status(409).json({ error: 'Target runtime is not running' });
    }

    // 更新配置
    config.channels[channelId].boundSession = { agentId, sessionId };
    await writeProjectIMWorkspaceConfig(config);

    // 向新目标 runtime 发送注入指令
    runtime.process.send({
      type: 'im:transfer',
      channelId,
      imChannelType: channelId,
    });

    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({ success: true, bundle });
  } catch (error) {
    next(error);
  }
});
```

#### 3b. POST /protoclaw/im_transfer/disconnect

```js
app.post('/protoclaw/im_transfer/disconnect', express.json(), async (req, res, next) => {
  try {
    const { channelId } = req.body || {};
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }

    const config = await readProjectIMWorkspaceConfig();
    if (!config.channels[channelId]) {
      return res.status(400).json({ error: `Unknown channel: ${channelId}` });
    }

    const bound = config.channels[channelId].boundSession;
    if (bound && bound.agentId && bound.sessionId) {
      const runtime = getAgentRuntime(bound.agentId, bound.sessionId);
      if (runtime?.process && typeof runtime.process.send === 'function'
          && !(runtime.process.exitCode !== null || runtime.stopped)) {
        runtime.process.send({ type: 'im:disconnect', channelId });
      }
    }

    config.channels[channelId].boundSession = null;
    await writeProjectIMWorkspaceConfig(config);

    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({ success: true, bundle });
  } catch (error) {
    next(error);
  }
});
```

### 步骤 4：normalizeIMWorkspaceConfig 中保留 boundSession

当前 `normalizeIMWorkspaceConfig`（L1019）通过 `normalizeIMChannelConfig` 处理每个 channel，
由于步骤 1 已经扩展了 `normalizeIMChannelConfig` 来处理 `boundSession`，
这一步无需额外改动，只需要确认 `normalizeIMChannelConfig` 的 `raw` 参数包含了 `boundSession` 字段。

检查：当前 L1023-1026 循环中，`channelValue` 会传入 `normalizeIMChannelConfig`。
只要配置文件中的 `boundSession` 字段被正确传入即可。

## 验证

1. 手动修改 `.agentdev/im-workspace.config.json` 添加 `boundSession` 字段，启动服务确认不会报错
2. `GET /protoclaw/im_workspace_bundle` 返回中包含 `connectableSessions` 数组
3. `POST /protoclaw/im_transfer` 能正确更新配置并发送 IPC（此时 runtime 端还没处理，但不会崩溃）
4. `POST /protoclaw/im_transfer/disconnect` 能正确清除绑定
