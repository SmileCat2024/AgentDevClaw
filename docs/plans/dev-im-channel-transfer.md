# IM 渠道线路转接 — 开发总纲

## 背景

IM 工作空间（门户代理 qqbot）当前是一个单一入口的通信代理，支持 QQ 和微信两个渠道。
产品方向是：门户代理作为"接待员"，可以将任意渠道"接线"到任意运行中的 agent session。

本次实现的核心是 **线路转接控制**：
1. 找到目标 session（当前限制：programming-helper 的活跃主对话）
2. 在目标 session 的 runtime 中动态注入渠道 feature（QQBotFeature / WeixinBot）
3. 管理完整生命周期：切换时先移除旧 feature，再挂载新 feature

## 拆分为 4 个子任务

| # | 子任务 | 核心文件 | 预估改动量 |
|---|--------|----------|-----------|
| 1 | 服务端：API 与配置模型扩展 | `server.js` | 中 |
| 2 | 前端：UI 下拉框与状态管理 | `app-ui.js`, `app-main.js`, `app-core.js` | 中 |
| 3 | 运行时：动态 feature 注入/移除 | `run-prebuilt-agent.js` | 大 |
| 4 | 门户代理：agent.js 适配 | `qqbot/agent.js` | 小 |

## 执行顺序

1 → 2 → 3 → 4（服务端先行，前端 UI 其次，运行时最后，agent 适配收尾）

但 1 和 2 可以由不同 agent 并行（前端 mock 数据先跑），3 和 4 也可以并行。
实际执行：先 1+2 并行，再 3+4 并行。

## 子文档索引

- [子任务 1：服务端 API 与配置模型](./dev-im-channel-transfer-1-server.md)
- [子任务 2：前端 UI 下拉框与状态管理](./dev-im-channel-transfer-2-frontend.md)
- [子任务 3：运行时动态 feature 注入/移除](./dev-im-channel-transfer-3-runtime.md)
- [子任务 4：门户代理适配](./dev-im-channel-transfer-4-agent.md)
