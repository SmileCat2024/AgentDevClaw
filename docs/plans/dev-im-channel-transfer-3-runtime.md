# 子任务 3：运行时动态 Feature 注入/移除

## 目标

在 `run-prebuilt-agent.js` 中处理来自 server.js 的 IPC 消息 `im:transfer` 和 `im:disconnect`，
实现向目标 runtime 进程动态注入和移除 IM 渠道 feature 的能力。

核心循环：
1. 收到 `im:transfer` → 在当前 agent runtime 中实例化并挂载指定渠道 feature → 启动 gateway
2. 收到 `im:disconnect` → 找到已挂载的渠道 feature → 停止 gateway → 从 agent 中移除

## 文件

**唯一修改文件**: `D:\code\AgentDevClaw\scripts\run-prebuilt-agent.js`

## 详细上下文

### 当前 IPC 消息处理

`run-prebuilt-agent.js` 是预制 agent 的 runtime 进程启动脚本。它通过 `process.send()` / `process.on('message')` 与父进程（server.js）通信。

当前脚本中已有 IPC 消息处理（搜索 `process.on('message')`），需要在此基础上新增 `im:transfer` 和 `im:disconnect` 消息的处理。

### Feature 动态挂载的可行性

根据之前的调研：
1. `agent.use(feature)` 将 feature 存入内部 Map，key 为 feature 名称
2. `agent.ensureFeatureTools()` 有 `featureToolsReady` 一次性锁，调用后新 feature 的 tools/hooks 不会被注册
3. 但 IM feature（QQBotFeature / WeixinBot）的 `getTools()` 返回 `[]`，`onInitiate()` 是 no-op
4. 它们只需要 `startGateway(agent)` 就能工作
5. 因此，即使在 `featureToolsReady = true` 之后动态 `agent.use()` + `startGateway()` 也能正常工作

### 关键已有变量

在 `run-prebuilt-agent.js` 顶部区域：
- `agent` — 当前 agent 实例
- `sessionId` — 当前 session ID
- `sessionStore` — session 存储后端
- `callArbiter` — 调用仲裁器（可能为 null）

### CallArbiter 处理 IM 消息的模式

当前 IM 消息通过 CallArbiter 序列化（约 L228-262）：
```js
const entry = this._callArbiter.enqueue({ source: 'weixin', sourceRef: msg.from_user_id, text });
const finished = await this._callArbiter.waitForCompletion(entry.id);
```

动态注入的 feature 的 gateway 消息处理器也需要走 CallArbiter（如果存在），
否则 IM 消息会和 viewer-input / dispatch 消息产生竞态。

### 重要：转移场景的 CallArbiter 问题

当线路转接到 **另一个 agent 的 runtime** 时：
- 门户代理（qqbot）有自己的 CallArbiter
- 目标 agent（如 programming-helper）也有自己的 CallArbiter（如果有的话）

IM gateway 消息应该走目标 agent 的 CallArbiter（因为 IM 消息将成为该 agent 的输入源之一）。

如果目标 agent 没有 CallArbiter（当前 programming-helper 不会创建 CallArbiter），
则 IM 消息直接调用 `agent.onCall(text)`。

## 详细步骤

### 步骤 1：添加 IM feature 动态挂载能力

在 `run-prebuilt-agent.js` 中添加一个 `imTransferManager` 对象，管理当前 runtime 上的动态 IM feature。

```js
// ── IM Transfer: Dynamic feature injection/removal ──────────────────

const imTransferManager = {
  _mountedFeatures: new Map(), // channelId -> { feature, gatewayStarted }

  async injectChannel(channelId) {
    // 如果已经挂载了同一渠道，先跳过
    if (this._mountedFeatures.has(channelId)) {
      console.log(`[IM-Transfer] Channel ${channelId} already mounted, skipping`);
      return;
    }

    if (!agent) {
      console.error('[IM-Transfer] No agent available for injection');
      return;
    }

    let feature = null;

    try {
      if (channelId === 'qq') {
        // 动态导入 QQBotFeature
        const { QQBotFeature } = await import('@agentdev/qqbot-feature');
        const config = await loadQQConfig(); // 需要读取 QQ 配置
        feature = new QQBotFeature({
          appId: config.appId,
          clientSecret: config.clientSecret,
          configPath: resolveQQConfigPath(),
          accountId: config.accountId,
          markdownSupport: config.markdownSupport,
        });
      } else if (channelId === 'weixin') {
        // 动态导入 WeixinBot
        const { WeixinBot } = await import('@agentdev/weixin-bot');
        feature = new WeixinBot({
          configPath: resolveWeixinConfigPath(),
        });
      } else {
        console.error(`[IM-Transfer] Unknown channel: ${channelId}`);
        return;
      }

      // 挂载到 agent（即使 featureToolsReady 已锁也不影响 IM feature）
      agent.use(feature);

      // 为 feature 的 gateway 消息处理器设置 CallArbiter 路由
      if (channelId === 'qq') {
        await this._startQQGateway(feature);
      } else if (channelId === 'weixin') {
        await this._startWeixinGateway(feature);
      }

      this._mountedFeatures.set(channelId, { feature, gatewayStarted: true });
      console.log(`[IM-Transfer] Channel ${channelId} injected successfully`);
    } catch (err) {
      console.error(`[IM-Transfer] Failed to inject channel ${channelId}:`, err);
      // 清理：如果 feature 已挂载但 gateway 启动失败
      if (feature) {
        try { agent._features?.delete(feature.constructor.name); } catch {}
      }
    }
  },

  async _startQQGateway(feature) {
    await feature.startGateway(agent);
    // 如果当前 runtime 有 CallArbiter，设置路由
    if (callArbiter) {
      feature.agentRef = {
        onCall: async (text) => {
          const entry = callArbiter.enqueue({ source: 'qq', text });
          const finished = await callArbiter.waitForCompletion(entry.id);
          if (finished.status === 'failed') {
            throw new Error(finished.error || 'unknown error');
          }
          return finished.result || '处理完成';
        },
      };
    }
  },

  async _startWeixinGateway(feature) {
    const { WeixinApiClient } = await import('@agentdev/weixin-bot');
    const originalHandleMessage = feature.handleMessage.bind(feature);
    feature.handleMessage = async (msg) => {
      if (msg && msg.from_user_id) {
        // 记录 IM peer（如果 agent 有 setLastIMTarget 方法）
        if (typeof agent.setLastIMTarget === 'function') {
          agent.setLastIMTarget(msg.from_user_id, msg.context_token);
        }
      }

      if (!callArbiter) {
        return originalHandleMessage(msg);
      }

      if (!msg || msg.message_type !== 1) return;
      const text = WeixinApiClient.extractText(msg);
      if (!text) return;

      const entry = callArbiter.enqueue({
        source: 'weixin',
        sourceRef: msg.from_user_id || '',
        text,
      });
      const finished = await callArbiter.waitForCompletion(entry.id);
      const responseText = finished.status === 'failed'
        ? `处理失败: ${finished.error || '未知错误'}`
        : (finished.result || '处理完成');

      if (feature.apiClient && typeof feature.apiClient.sendTextMessage === 'function') {
        await feature.apiClient.sendTextMessage(msg.from_user_id, responseText, msg.context_token);
      }
    };

    await feature.startGateway(agent);
  },

  async removeChannel(channelId) {
    const mounted = this._mountedFeatures.get(channelId);
    if (!mounted) {
      console.log(`[IM-Transfer] Channel ${channelId} not mounted, nothing to remove`);
      return;
    }

    try {
      // 停止 gateway（如果 feature 有 stopGateway 方法）
      if (typeof mounted.feature.stopGateway === 'function') {
        await mounted.feature.stopGateway();
      } else if (typeof mounted.feature.stop === 'function') {
        await mounted.feature.stop();
      }

      // 从 agent 中移除
      if (agent?._features) {
        agent._features.delete(mounted.feature.constructor.name);
      }

      this._mountedFeatures.delete(channelId);
      console.log(`[IM-Transfer] Channel ${channelId} removed successfully`);
    } catch (err) {
      console.error(`[IM-Transfer] Failed to remove channel ${channelId}:`, err);
    }
  },
};
```

### 步骤 2：读取 IM 配置的辅助函数

在 `imTransferManager` 之前，添加两个辅助函数来读取 QQ 和微信配置：

```js
async function loadQQConfig() {
  try {
    const resp = await fetch('http://127.0.0.1:1420/protoclaw/qqbot_config');
    if (!resp.ok) return {};
    return await resp.json();
  } catch { return {}; }
}

function resolveQQConfigPath() {
  const { existsSync } = require('fs');
  const { join } = require('path');
  const candidates = [
    join(process.env.PROTOCLAW_ROOT || '.', '.agentdev', 'qqbot.config.json'),
  ];
  return candidates.find(p => existsSync(p)) || candidates[0];
}

function resolveWeixinConfigPath() {
  const { join } = require('path');
  return join(process.env.PROTOCLAW_ROOT || '.', '.agentdev', 'weixin-bot.config.json');
}
```

注意：`run-prebuilt-agent.js` 使用 ESM (`import`)，需要用对应的导入语法。
检查文件顶部的导入方式再决定使用 `import` 还是 `require`（通过 `createRequire`）。

实际上 `run-prebuilt-agent.js` 已经有 `QQBotFeature` 和 `WeixinBot` 的间接引用（通过 agent 实例），
但因为是不同的 runtime 进程，需要自己导入。

**更简洁的方案**：直接从 server.js 通过 HTTP API 获取配置数据，
而不是在 runtime 进程中读文件系统。因为 runtime 进程可能没有正确的配置路径。

```js
async function loadIMChannelConfig(channelId) {
  try {
    const serverOrigin = process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420';
    const resp = await fetch(`${serverOrigin}/protoclaw/im_workspace_bundle`);
    if (!resp.ok) return {};
    const bundle = await resp.json();
    if (channelId === 'qq') return bundle.qqConfig || {};
    if (channelId === 'weixin') return bundle.weixinConfig || {};
    return {};
  } catch { return {}; }
}
```

但 QQBotFeature 构造需要 `configPath` 参数（文件路径），不是纯配置对象。
所以 runtime 进程确实需要知道配置文件路径。

**最终方案**：通过 IPC 消息传递配置信息。

在 server.js 的 `POST /protoclaw/im_transfer` 中，IPC 消息体增加配置字段：

```js
runtime.process.send({
  type: 'im:transfer',
  channelId,
  imChannelType: channelId,
  qqConfig: channelId === 'qq' ? await readProjectQQBotConfig() : undefined,
  qqConfigPath: channelId === 'qq' ? PROJECT_QQBOT_CONFIG_PATH : undefined,
});
```

runtime 端直接使用传入的配置构造 feature。

### 步骤 3：注册 IPC 消息监听

找到 `process.on('message', ...)` 的位置（或新增一个），添加 IM transfer 消息处理：

```js
process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'im:transfer') {
    console.log(`[IM-Transfer] Received transfer request: channel=${msg.channelId}`);
    await imTransferManager.injectChannel(msg.channelId, msg);
  }

  if (msg.type === 'im:disconnect') {
    console.log(`[IM-Transfer] Received disconnect request: channel=${msg.channelId}`);
    await imTransferManager.removeChannel(msg.channelId);
  }
});
```

### 步骤 4：修改 injectChannel 接收 IPC 配置

更新 `injectChannel` 方法签名，接受 IPC 消息中的配置：

```js
async injectChannel(channelId, ipcMsg = {}) {
  // ... 同上，但使用 ipcMsg 中的配置代替读文件 ...
  if (channelId === 'qq') {
    const { QQBotFeature } = await import('@agentdev/qqbot-feature');
    feature = new QQBotFeature({
      appId: ipcMsg.qqConfig?.appId || '',
      clientSecret: ipcMsg.qqConfig?.clientSecret || '',
      configPath: ipcMsg.qqConfigPath || '',
      accountId: ipcMsg.qqConfig?.accountId || '',
      markdownSupport: ipcMsg.qqConfig?.markdownSupport ?? true,
    });
  }
  // ... 同上 ...
}
```

### 步骤 5：callFinished IM 结果投递扩展

当前 `dispatchIMCallFinish()` 在 `run-prebuilt-agent.js` L433 处理非 IM 来源的 call 完成后的 IM 投递。

当 runtime 被转接后，这个函数需要能够找到动态挂载的 feature 来发送消息。

修改思路：`imTransferManager` 应该暴露一个 `sendToChannel(channelId, text, userId)` 方法。

```js
// 在 imTransferManager 中添加
async sendToChannel(channelId, text, userId) {
  const mounted = this._mountedFeatures.get(channelId);
  if (!mounted?.feature) return false;

  if (channelId === 'weixin' && mounted.feature.apiClient) {
    await mounted.feature.apiClient.sendTextMessage(userId, text, '');
    return true;
  }

  // QQ 没有 proactive send API
  console.log(`[IM-Transfer] Cannot proactively send to QQ (limitation)`);
  return false;
},
```

## 关于 CallArbiter 的注意事项

如果目标 runtime（如 programming-helper）本身没有创建 CallArbiter（`callArbiter` 为 null），
则 IM gateway 的消息处理器会直接调用 `agent.onCall(text)`。
这和当前 QQ 微信消息不经过 CallArbiter 的行为一致。

问题是：如果 viewer-input 和 IM 消息同时到达，可能产生竞态。
但在测试阶段这是可接受的，后续可以给目标 runtime 也添加 CallArbiter。

## 验证

1. 在 programming-helper 的一个主对话 runtime 中，通过 IPC 发送 `im:transfer` 消息
2. 观察 runtime 日志，确认 feature 被正确挂载和 gateway 启动
3. 通过微信发送消息，确认消息到达目标 runtime 的 `onCall`
4. 发送 `im:disconnect`，确认 gateway 停止和 feature 移除
5. 再次发送微信消息，确认不再被该 runtime 处理
