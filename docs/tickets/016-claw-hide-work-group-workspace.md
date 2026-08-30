# 016 — 工作群临时屏蔽（左侧列表隐藏）

- **仓库**：AgentDevClaw
- **决策依据**：2026-08-21 grill 会话确认——最简屏蔽，仅左侧列表；
  首页 Dashboard"工作群"卡片等其余入口**保持现状**（用户明确拍板范围外）
- **类型**：微改动（1 行常量 + 1 行测试断言）
- **优先级**：独立小票，随时可做

## 背景

工作群（work-group）为 Beta 功能，临时屏蔽其曝光：左侧列表不再显示
"工作群"工作空间条目，且左侧"工作群"分类分组整组消失。

复用现有机制，零新代码路径：`server/shared/constants.js:38` 的
`HIDDEN_PREBUILT_AGENT_IDS`（悬置空间 agent-creator / feature-creator /
flow-test 即用此机制屏蔽）。

- `getAgentsLight()`（`server/routes/agent-discovery.js:105`）按该集合
  过滤 `/protoclaw/get_prebuilt_agents` 返回，work-group 不再下发。
- 前端 `renderAgentGroup()`（`public/src/modules/sidebar-render.js:157`）
  对空分组自动 `display:none`，"工作群"分类分组（`public/index.html:105`）
  无需任何前端改动即消失。

不采用 metadata.json `enabled: false`：该字段只影响群聊身份注册
（`collectIdentitiesFromAgents` 跳过）与会话搜索，**不影响列表可见性**，
且属"功能禁用"语义，与"临时隐藏曝光、易于恢复"意图不符。

## 执行步骤

1. `server/shared/constants.js:38`：`HIDDEN_PREBUILT_AGENT_IDS` 集合
   追加 `'work-group'`。
2. `test/shared-modules.test.js` 的 "HIDDEN_PREBUILT_AGENT_IDS should
   include expected agents" 用例追加一行断言
   `assert.ok(HIDDEN_PREBUILT_AGENT_IDS.has('work-group'))`，把屏蔽
   意图固化为测试（现有断言为成员检查，不受影响）。
3. 若 work-group runtime 正在运行，先经 UI / API 停止，再改代码——
   屏蔽本身不会停止进程，避免 UI 已消失但子进程继续运行的幽灵状态。
4. 重启整个 Claw 服务（常量属 server.js 主进程模块，重启单个 agent
   无效）。

## 验收标准

- 左侧列表不再出现"工作群"工作空间条目；"工作群"分类分组整组消失。
- 其他工作空间（编程小助手 / Agent Studio / IM 渠道 / Runtime 配置等）
  列表显示不受影响。
- `npm run test:file -- test/shared-modules.test.js` 全绿（含新断言）。

## 风险提示

- **IM 可路由目标连带消失**：`/protoclaw/im_routable_targets` 走同一
  `getAgentsLight()` 数据源，work-group"管理员会话"（im.js 中
  `work-group-admin` 适配项）同步从 IM 接线员的可路由目标中消失。若
  存在绑定到该目标的 IM 线路，转接会失败——执行前确认无此类线路依赖。
- **数据与运行时不销毁**：群聊数据（用户目录 `GROUP_CHATS_ROOT`）保留
  不动；屏蔽不自动停止运行中的 runtime（见执行步骤 3 的人工动作）。
- **首页死入口（已接受）**：首页 Dashboard"工作群"卡片与"进入群聊"
  按钮保留（home-dashboard.js），点击后导航目标不在列表中，行为未定义。
  用户已确认此为范围外，不处理。
- **恢复**：从集合移除 `'work-group'` + 整服重启，即一行回退。本票定位
  "临时"，恢复无需新工单。
