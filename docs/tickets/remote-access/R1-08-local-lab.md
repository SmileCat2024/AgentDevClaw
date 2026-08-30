# R1-08 — 本地第二实例验证环境（Local Lab）

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md)
- **类型**：Phase 1 验收环境与故障注入结果记录
- 真实服务器验收见 [R1-08-real-server-checklist.md](R1-08-real-server-checklist.md)（手动清单，本机实验不涉及外网）。

## 1. 数据目录隔离机制（AGENTDEV_DATA_DIR）

### 结论

原实现**不支持** env 覆盖（此前不存在 `AGENTDEV_DATA_DIR` / `AGENTDEV_HOME`），数据根在多个进程入口独立构造。本次补齐了最小覆盖，语义为：

> 设置 `AGENTDEV_DATA_DIR` 后，整个 Claw 数据根重定向到该目录；未设置时保持 `~/.agentdev/AgentDevClaw` 默认布局，行为零变化。仅用于多实例/测试场景。

### 单一权威解析点

`server/shared/constants.js` 导出：

```js
export function resolveUserDataDir(env = process.env) {
  const override = typeof env.AGENTDEV_DATA_DIR === 'string' ? env.AGENTDEV_DATA_DIR.trim() : '';
  return override ? path.resolve(override) : path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
}
export const USER_DATA_ROOT = resolveUserDataDir();
```

所有数据根构造位置统一经由它解析（或同语义内联，仅限 TS 独立构建处）：

| 进程入口 | 文件 |
|---|---|
| Claw server 全部派生路径（remote-connections.json、prebuilt-sessions、workspaces、threads、group-chats、images、user-features、runtime-envs、oauth-tokens…） | `server/shared/constants.js` |
| CLI / MCP 共享核心 | `server/claw-core.mjs` |
| claw CLI config-groups | `bin/claw.mjs` |
| 预制 agent runtime | `scripts/run-prebuilt-agent.js` |
| one-shot runtime | `scripts/run-one-shot-agent.js` |
| mirror runtime（title/recap） | `scripts/mirror-runtime.js` |
| plain agent runner | `scripts/run-plain-agent.js` |
| feature-setup 迁移脚本 | `scripts/migrate-feature-setup-sparse.mjs` |
| 各预制 agent（programming-helper 主/coder、qqbot、agent-studio、agent-creator、feature-creator、flow-workspace） | `prebuilt-agents/official/*/agent.js`（相对引用 `server/shared/constants.js`） |
| local-features TS（无法跨构建边界复用 JS helper，按同语义内联） | `local-features/{agent-dev,feature-dev}/src/index.ts`、`local-features/agent-studio/src/project-store.ts` |

子进程（agent runtime / mirror）由 server spawn 时继承环境变量，隔离自动向下游传播。

单元测试：`test/user-data-dir.test.js`（默认布局回退、空白/非字符串忽略、trim、相对路径 cwd 解析）。

### 有意共享、不随该变量迁移的路径（边界声明）

- `PROJECT_ROOT/.agentdev/*.json`（qqbot / weixin / feishu / wecom / rokid / im-workspace / mcp-gateway / remote-claw 配置）与 `config/default.json` —— 项目级配置。同一 checkout 双实例共享即够用；需要彻底隔离时克隆第二个 checkout。
- `.agentdev/agent-dev|feature-dev`（装配安装根，非 Claw 会话数据）。

## 2. 启动第二实例（实例 B）

前置条件（本机已满足）：Windows OpenSSH Server 已安装且 sshd 服务运行中（`Get-Service sshd` 应为 Running），`ssh localhost` 可登录。

PowerShell（仓库根 D:\code\AgentDevClaw 下执行）：

```powershell
$env:PORT='1430'
$env:AGENTDEV_VIEWER_PORT='2030'
$env:AGENTDEV_DATA_DIR="$env:USERPROFILE\.agentdev\AgentDevClaw-lab"
npm start
```

Git Bash 等价形式：

```bash
PORT=1430 AGENTDEV_VIEWER_PORT=2030 AGENTDEV_DATA_DIR=~/.agentdev/AgentDevClaw-lab npm start
```

启动后核对隔离生效：

- [ ] `%USERPROFILE%\.agentdev\AgentDevClaw-lab\` 出现（首次访问相应功能后逐步生成子目录）
- [ ] 实例 A 的数据目录 `%USERPROFILE%\.agentdev\AgentDevClaw\` 未新增 B 的会话文件
- [ ] 实例 B Web UI 位于 http://127.0.0.1:1430 ，A 仍为 http://127.0.0.1:1420

清理：直接 Ctrl-C 停止实例 B；如需重来删除 `-lab` 目录即可（不影响主实例）。

## 3. manual 连接验证全链路

在实例 A（1420）的「远程服务器」面板添加连接：

| 字段 | 值 | 说明 |
|---|---|---|
| 连接 ID | `lab-b` | URL 安全字符 |
| 别名 | `Lab-B` | 侧栏分组显示为 `Lab-B：<项目>` |
| 模式 | 手动隧道 | 隧道由用户自建，Claw 只读本地端口 |
| 本地端口 | `22101` | 必须落在保留区间 22100–22199 |
| 远程应用端口 | `1430` | 指向实例 B 的 APP_PORT |

建立隧道（本机 sshd 充当"远程"，端口转发到实例 B）：

```bash
ssh -N -L 127.0.0.1:22101:127.0.0.1:1430 localhost
```

期望行为：

- [ ] 握手完成后管理面板状态变「已连接」（三步握手 health → app_info → agents 全部经 22101 打到 1430）
- [ ] 左侧列表出现「远程工作空间」分组，条目形如 `Lab-B：<项目名>`
- [ ] 点击远程条目进入只读视图：消息流 / Todo / Hook Inspector 正常渲染
- [ ] 输入区显式禁用，占位文案为「远程操作将在下一阶段开放」
- [ ] 断开 ssh 进程后分组保留身份并显示断开状态（不消失、不伪造在线）

无 SSH 的等价模拟（可选，需管理员 PowerShell），效果与隧道一致：

```powershell
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=22101 connectaddress=127.0.0.1 connectport=1430
# 移除：netsh interface portproxy delete v4tov4 listenport=22101 listenaddress=127.0.0.1
```

> 注：受 `ConnectionStore.assertPortConflicts` 约束，连接本地端口必须在 22100–22199 区间且不得等于本实例 APP_PORT/VIEWER_PORT，因此不能把 `localPort` 直接填 1430 来"零隧道"连第二实例。

## 4. 故障注入矩阵（七项逐项结论）

判定口径：自动化 = mock/spawn 级单元测试长期驻留于 `npm run test:core`；本地实测 = 按 §2/§3 环境执行的进程级操作。"静默失败"/"假成功"视为缺陷。

| # | 注入 | 期望（工单原文） | 验证方式 | 结果 |
|---|---|---|---|---|
| 1 | 杀掉 managed SSH 进程 | disconnected → 退避重连 → 恢复后自动 connected | 自动化：`tunnel-manager.test.js`「unexpected exits as down + exponential backoff」+ 新增「spawn failure … not a silent up」（child error/ENOENT 显式 down，不停留 up）；connection-health 周期探测自动恢复由「probes on start, recovers automatically」覆盖。本地实测：`taskkill /PID <ssh pid> /F` 后观察 | **通过** |
| 2 | 停止远程 Claw（隧道 up） | target_not_found，UI 明示"远程 Claw 未运行" | 自动化：`connection-health.test.js`「tunnel-up network errors → target_not_found / degraded」「HTTP-failing health → target_not_found」。UI：catalog section 带 degraded + error，前端显示「已降级」横幅（rcon_banner_degraded）；关闭实例 B 的 uv 端口监听即可复现 | **通过** |
| 3 | 断网 30s 后恢复 | ServerAlive 检测断开，恢复后零代码回到真值 | 自动化：传输中断分类（transport_unavailable/disconnected）+ 「recovery requires a full re-handshake」×2 + catalog「每次聚合都重新拉取远程真值」（无缓存 ⇒ 恢复后下一轮询即真值，无追赶代码）。真实断网依赖网卡操作，落地为本地实测：停 sshd 服务（`Stop-Service sshd`）30s 再启动，观察 disconnected → 自动 connected | **通过**（恢复逻辑自动化；网卡级中断为本地实测步骤） |
| 4 | 版本不匹配（mock app_info） | connected + 警告标记，只读不受影响 | 自动化：version gate 五项（主/次漂移警告、补丁差异不警告、警告清除、framework 独立警告，状态保持 connected）。UI：管理面板 ⚠「版本不匹配」标记（rcm-version-warn）；聚合仅以 state==='connected' 判定，warning 为旁路字段不影响只读拉取 | **通过** |
| 5 | 配置中删除正在使用的连接 | 后续请求 target_not_found，UI 优雅降级不白屏 | 自动化组合：store 删除持久化（connection-store.test）、health/tunnel 同步移除（drop removed / stops child）、路由层 unknown connection → 404 target_not_found 且 disabled → 503 transport_unavailable（remote-passthrough.test「maps remote routing failures」）。前端零镜像：catalog 快照外的分节被移除、纯条件渲染（renderRemoteSidebarZone 空分区 teardown），无白屏路径。本地实测：面板删除连接后立刻点击旧条目应弹 toast「该连接当前不可用…」 | **通过** |
| 6 | 两条连接一条挂起 | 挂起连接独立超时，另一条完全不受影响 | 自动化：`remote-catalog.test.js`「挂起连接在独立超时后降级返回，不阻塞其他连接」（每连接独立 AbortController）；health 层「keeps one failing connection from affecting another」 | **通过** |
| 7 | Phase 1 写操作 input/interrupt | 本地拦截 remote_write_disabled，远程零感知 | 自动化：`remote-passthrough.test.js`「rejects remote write methods locally … never forwards」——POST input/interrupt/queue-input、DELETE agent、PUT todo 全部 403 + code=remote_write_disabled + retryable=false + operationId 回显，fetch 断言零调用（远程零感知）；白名单外读同样本地拒绝 | **通过** |

### 审计结论

- 七项均无"静默失败"或"假成功"；唯一发现的薄弱点是 managed 隧道 spawn 失败（ENOENT 类）错误事件路径此前无测试驻留，本轮已补测试并确认实现正确（显式 down + 退避）。
- 路由级集成（server.js 组装后的 DELETE/handshake HTTP 行为）无独立单测 harness，属既有边界；由 §3/§4 本地实测步骤兜底。

## 5. 可重复快速回归清单

每次改动远程连接相关代码后，按序执行：

1. `npm run test:core` —— 含 tunnel/health/catalog/passthrough/request-target/store/resolver 全套自动化矩阵。
2. 重启实例 B 与实例 A（改前端/框架 dist 需整服重启；仅 agent/local-feature 改动重启对应 runtime）。
3. 按 §3 建立 manual 隧道 → 确认 connected 与分组渲染。
4. 抽查矩阵 #2/#5（停 B 再启 B；删连接再访问旧条目）。
5. 默认关闭态检查：清空 `AGENTDEV_DATA_DIR` 环境（或不配任何连接）冷启动 → 左侧列表与 Phase 1 前完全一致（远程分区 zero DOM：`renderRemoteSidebarZone` 在空分区时 teardown 且不留占位节点——前端代码审读确认 + `/protoclaw/remote_catalog` 无连接时返回 `{connections:[]}`）。
