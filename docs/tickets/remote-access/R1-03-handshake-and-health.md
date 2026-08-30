# R1-03 — 连接握手与健康状态机

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md) 第 6、7 条
- **类型**：连接基础
- **前置**：R1-01；R1-02（managed 模式下隧道就绪才有意义，manual 模式可直接验证）

## 背景

隧道通不等于远程可用（远程 Claw 可能未启动），远程可用也不等于版本匹配。需要以现有远程端点组合出握手，并维护每条连接的状态机——这是"失败显式呈现"的数据源。

## 目标

握手三步，全部复用远程现有端点，**远程零改动**：

```text
1. GET /protoclaw/health     → 存活（隧道通但此步 ECONNREFUSED = 远程 Claw 未运行）
2. GET /protoclaw/app_info   → 版本身份（clawVersion + framework.version）
3. GET /api/agents           → Runtime 目录探测
```

连接状态机：

```text
configured → connecting → connected
                 ↘ disconnected → reconnecting → connecting
connected → degraded（隧道 up 但握手失败/超时）
```

## 执行步骤

1. 实现 `server/remote-connections/connection-health.js`：每条 enabled 连接周期性握手；间隔常量进 constants.js，节奏对齐前端轮询量级，不自创高频心跳。
2. 失败三分类并映射到 Phase 0 错误契约：
   - 隧道/网络不可达 → `transport_unavailable`（retryable）；
   - 隧道通但 health 不可达 → `target_not_found`（远程 Claw 未启动）；
   - health/app_info 成功但版本超出门槛 → 状态保持 connected，附 `versionWarning`（不阻断）。
3. 握手结果缓存每条连接的 `appInfo`（版本、名称）供 UI 与日志消费；这是连接元数据，不是业务状态镜像。
4. 恢复路径：从 disconnected/degraded 恢复时必须重新执行完整三步握手，不信任旧结果。
5. 每条连接独立探测：一条连接失败不影响其他连接与本地功能（隔离故障域）。
6. 单元测试：mock fetch 覆盖三分类、状态迁移、恢复重握手、版本警告路径。

## 验收标准

- 三种失败形态在状态数据中可区分，前端无需猜测。
- 断网 → 重连 → 自动恢复 connected，无需人工干预，无残留错误状态。
- 版本不匹配时连接可用且带警告标记。
- 远程 Claw 未启动时 10s 内状态收敛为明确 disconnected/degraded（非无限 connecting）。

## 明确不做

- 不新增远程端点（包括 `/protoclaw/capabilities`），不做协议版本协商。
- 不做 Feature 集合差异检测——按远程真实返回渲染，本地不补偿。
- 不缓存远程业务数据。
