# 后台任务面板的协议化接入

依据 ADR-0031 与实施计划。前置提交：7dc80b0（非阻塞监视）、e563e46（领域 Shell 组合），相关构建和225项领域测试已通过。

## 目标

框架 BackgroundAccess 只提供逻辑后台工作；Claw 定义展示协议、通信和渲染。Feature 可选按协议发布，不携带渲染模板。同类协议可供不同 Feature（例如 Bash/PowerShell）复用，但传输仍以 agentId/sessionId/featureId/channelId 隔离。统一后台任务面板发现并展示各协议来源。

进程类保留现有卡片、立即汇报、打断行为与徽标；智能体执行类仅展示，不添加任何反向控制按钮。面板关闭或投影失败不停止执行、观察、通知。

## 实现范围

允许修改 server/feature-communication-store.js、server/routes/feature-communication.js、local-features/shared/src/feature-communication.ts，增加必要的 Claw 面板协议类型/辅助文件；修改 PanelShellFeature、CoderMonitor、CapabilityShellFeature 及 programming-helper 装配，public/src/modules/bg-panel.js 与必要相邻面板宿主接线，以及对应测试/协议文档。不修改框架仓库，不修改领域 Shell 解析/dispatch等已提交实现，不碰输出风格文档。

先读完整相关文件、ADR-0018/0031、frontend-rendering-patterns 与 design-system，再实施。复用 feature-comms：通道声明携带可识别的协议与版本（最终字段命名由代码适配），Claw按协议选择渲染，不按Feature ID硬编码。来源标识进入卡片键/操作路由，两个同协议不同来源的同ID项不冲突。未知协议/版本显式说明不支持，不套进程模板。

进程协议可沿用当前快照/事件和请求面，尽量保持视觉。智能体协议至少身份、标题、关联执行、状态（提交/执行/挂起/接力/完成/失败/监视失联等）、摘要与时间，数据由真实监视器生成；不按线程idle猜完成。不要把监视失联等同于业务失败，不增加控制按钮。支持list快照对账/有界SSE增量、断线重连/迟到快照不覆盖新事件、来源消失/会话切换清理和徽标一致。可选装配无需新增全局配置层；编程小助手默认启用面板投影。不要构造假在监视状态掩盖接续断链。

## 验收

npm run build:local-features；定向node:test（含多来源同ID隔离、进程按钮路由、智能体无控制、协议未知/版本、空/错误/断线/切会话、投影失败不影响执行通知、挂起/接力/终态投影）；现有bg-panel/PanelShell/feature-comms回归；npm run check:cycles；git diff --check。添加隔离数据或frontend-vm测试，不读真实用户线程目录、不用长sleep。若有可用浏览器可做隔离呈现检查，禁止重启运行服务。

## 协作与交付

当前分支 v0.2.4，直接原目录 /home/dev/AgentDevClaw 施工；调度方只读审查其他区域，不与你同时改这些文件。不 reset/clean/checkout覆盖；既有 features/stylized-output/src/styles/clear-technical-writing.md 为他人工作，保持不动。不得commit/push/切分支或归档线程，调度方验收后负责。报告修改文件、真实验证命令/结果、未验证项、需重启范围。面板控制语义严格按本工单，不扩大范围。
