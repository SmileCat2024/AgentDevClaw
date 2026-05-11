# AgentDevClaw

`AgentDevClaw` 是 `ProtoClaw` 的纯 Web 改写版本。

目标不是给 `AgentDev` 原生 debugger 页面再套一层壳，而是：

- 保留 `ProtoClaw` 的独立调试 UI 和交互逻辑
- 去掉 Tauri
- 继续复用 `AgentDev` 的 `ViewerWorker`、调试会话、消息流、输入请求和模板接口

## 运行

```bash
npm install
npm run start
```

默认端口：

- Web UI: `http://127.0.0.1:1420`
- ViewerWorker: `http://127.0.0.1:2026`

## 当前结构

- `public/index.html`
  `ProtoClaw` 风格的独立调试前端主页面
- `public/src/tauri-bridge.js`
  兼容原页面调用方式的 Web invoke bridge，直接映射到当前服务
- `server.js`
  启动 `ViewerWorker`、管理预置 agent 进程，并把 `ProtoClaw` UI 所需接口代理到 `ViewerWorker`
- `scripts/run-prebuilt-agent.js`
  预置 agent 运行时
- `prebuilt-agents/`
  预置 agent 目录
- `resources/features/`
  项目内保存的预制 Feature tgz 包，供当前项目和后续用户创建 agent 时直接引用

## 当前实现边界

- 已支持预置 agent 列表、启动、连接到运行时会话
- 已把 `ProtoClaw` 页面依赖的核心 `/api/*`、模板、工具渲染资源代理到 `ViewerWorker`
- 当前仓库以前端独立渲染为主，`ViewerWorker` 只作为数据与调试协议提供者
