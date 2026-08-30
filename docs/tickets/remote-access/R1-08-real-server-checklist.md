# R1-08 — 真服务器验收清单（手动执行）

- **前置**：本地 Lab 验证（[R1-08-local-lab.md](R1-08-local-lab.md)）七项故障矩阵全部通过后进行。
- **环境**：用户现有远程服务器（可公网 SSH 访问、其上已 `npm start` 运行 Claw）。
- **本工单范围声明**：按调度方收窄决定，本文档只沉淀清单与期望，不代执行；将来由用户照单逐项勾选。
- **记录表**：最后一节。每完成一项在 `[ ]` 打 x 并记录观察值。

## 0. 基线测量

```bash
# 公网 RTT 基线（影响轮询体感预期）
ping <server-host>
# 远程 Claw 存活确认
ssh <user>@<server-host> "curl -s http://127.0.0.1:1420/protoclaw/health"
```

- [ ] 期望：health 返回 `{"ok":true,...}`；RTT 数值填入记录表
- [ ] 记录远程侧 claw 版本：`ssh <user>@<server-host> "node -e \"console.log(require('<repo>/package.json').version)\""`（用于核对版本警告是否该出现）

## 1. 添加 managed 连接

本地 Claw（1420）→「远程服务器」面板 → 添加：

| 字段 | 值 |
|---|---|
| 连接 ID | `prod-1`（示例） |
| 别名 | 真实服务器名 |
| 模式 | 托管隧道 |
| 本地端口 | `22101`（冲突时让面板自动分配下一个空闲端口） |
| SSH 主机 / 用户 / 端口 | 真实值；密钥须已配好免密（managed 以 BatchMode 兼容方式运行） |

启用连接后台tail诊断：

```bash
# sshd 侧由本地 spawn 的 ssh 进程持有转发；
curl -s http://127.0.0.1:1420/protoclaw/remote_connections | jq '.tunnels["prod-1"]'
```

- [ ] 期望：`tunnel: "up"` 且有 pid；健康状态经周期握手转为 connected
- [ ] 若密钥不合法：状态必须显式 disconnected/down 且 stderr 尾部可见认证错误——**不允许**长时间停在 starting 或假 up

## 2. 握手与身份

```bash
curl -s -X POST http://127.0.0.1:1420/protoclaw/remote_connections/prod-1/handshake | jq '.status'
```

- [ ] 期望：`state: "connected"`、`appInfo.clawVersion/frameworkVersion` 与 §0 记录一致、`lastConnectedAt` 刷新
- [ ] 版本主/次不一致时：connected 保持 + `versionWarning` 存在 + 面板 ⚠ 标记

## 3. 工作空间分组出现

- [ ] 期望：左侧列表出现「<别名>：<项目名>」分组，与会话的 openDirectory 叶段一致；与本地同名项目不同组（groupKey 带 `remote:<connId>:` 前缀）

## 4. 只读视图打开

- [ ] 期望：点击远程条目进入远程 Agent 视图；URL/寻址使用 `remote:<connId>:<agentId>` 不透明 ID；消息流、Todo、Hook Inspector 渲染正常
- [ ] 输入区禁用且文案为「远程操作将在下一阶段开放」

## 5. 消息流实时刷新

- [ ] 在**另一台终端**向远程会话发送一条输入（或等待已有会话轮转），本地只读视图下一轮询内出现新消息（Phase 1 轮询节奏，秒级）
- [ ] 消息体内嵌的模板 URL 能加载（代理重写回环生效），Feature 渲染块显示正常

## 6. 模板 / Feature 面板渲染

- [ ] 期望：以远程实际 Feature 集合渲染；本地缺失的 Feature 不做补偿、不白屏

## 7. 写操作拦截复核

浏览器 DevTools Network 中对远程 agent 触发一次尝试性写（若 UI 已全禁用则跳过）或直接：

```bash
curl -s -X POST -H 'content-type: application/json' -d '{"text":"hi"}' \
  http://127.0.0.1:1420/api/agents/remote%3Aprod-1%3A<agentId>/input | jq '{ok,code,retryable}'
```

- [ ] 期望：403 + `code:"remote_write_disabled"` + `retryable:false`
- [ ] 远程侧零感知：远程 Claw 日志/会话无任何写入痕迹

## 8. 断网恢复

```bash
# 远程侧模拟网络中断（择一）：断开公网 / iptables 临时 DROP 22 端口约 30s
sudo iptables -I INPUT -p tcp --dport 22 -j DROP && sleep 30 && sudo iptables -D INPUT -p tcp --dport 22 -j DROP
```

- [ ] 中断期：本地 UI 连接标记「已断开」，分组保留最后已知身份（banner「最后在线」），本地 Agent 完全不受影响
- [ ] 恢复后 ≤ ~15s（退避 + 握手周期）：自动回到「已连接」，零人工操作；下一次轮询直接读到远程当前真值（无追赶、无旧数据残留）

## 9. 断开重连（连接生命周期）

- [ ] 面板点删除连接：SSH 子进程被 SIGTERM 终止（本地 `tasklist`/`ps` 核实无残留 ssh 转发进程）；左侧分节移除
- [ ] 重新添加同名连接 → 全链路（§2–§6）快速重放一遍通过

## 10. 体感记录表

| 项 | 数值 |
|---|---|
| 公网 RTT（ping） | ___ ms |
| 冷握手耗时（添加连接 → UI 显示已连接） | ___ s |
| 分组出现在列表的延迟 | ___ s |
| 消息流端到端延迟（远程动作 → 本地可见） | ___ s |
| 模板 URL 加载成功率 | ___ % |
| 断网恢复到 connected 的耗时 | ___ s |
| 轮询体感主观评价（卡顿/流畅） | ___ |

验收口径：轮询节奏下无明显卡顿；§1–§9 无一项出现静默失败或假成功。
