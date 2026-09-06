---
name: playwright-shell
description: "浏览器页面取证与受控会话（playwright-shell feature 内嵌技能）：用 playwright_shell 工具完成单次渲染取证（截图/PDF/HAR）与多步页面交互（导航/输入/点击/读取内容）；含动词用法、refs 纪律、URL 引号纪律、资产缺失修复、会话收尾与超时纪律。适用于对网页做取证留存或按步骤完成页面任务。"
---

# 浏览器页面取证与会话 Skill

本 Skill 配套 `playwright_shell` 工具（playwright 领域 shell，v2：产物取证 + 受控会话）。

调用工具前先读完本文。shell 负责动词面与确定性拒绝，本文承载调度纪律与故障处置。

## 适用范围与限制（先读）

- **两组动词**：(1) 一次性产物取证（screenshot / pdf / har）——单页渲染即退出；(2) 受控会话交互（open/goto/snapshot/find/fill/press/click/tab-list/tab-select/close）——跨调用共享同一页面，做多步导航/输入/点击/读取。
- **动作面受 refs 约束**：click/fill 只接受 snapshot/find 输出里的元素 ref（如 `e37`、`f3e949`）。不能凭空构造 CSS 选择器——这是防注入核心约束，也是规范：先 snapshot/find 看到元素，再拿 ref 交互。
- **任意 JS 执行不入表**（eval/run-code 显式排除）：读页面内容用 snapshot/find，不要试图 eval。
- **URL 必须整体加引号**；含查询分隔符 `&` 的 URL 被确定拒绝（已知边界，换无查询分隔符的地址）。
- **只接受 http:// 与 https://**；`file://`/`data:` 拒绝。

## 动词用法

全部操作经 `playwright_shell({ command })`，command 是一条命令字符串。会话动词输出为结构化文本（页面状态 + Snapshot 文件路径 + Events）。

**产物动词（一次性）**

| 动词 | 语义 |
|---|---|
| `env` | 报告后端版本、CLI 入口、浏览器资产与匹配判定（verdict）；首次使用先跑 |
| `screenshot '<url>' <out.png> [--full-page]` | URL → PNG（产物 = 路径 + 字节数） |
| `pdf '<url>' <output.pdf>` | URL → PDF（仅 Chromium 资产） |
| `har '<url>' <output.har>` | URL → HAR 网络活动（附 PNG 侧产物） |

**会话动词（受控多步）**：

| 动词 | 用法 |
|---|---|
| `open '<url>' [--headed] [--browser=chrome]` | 启动/重启受控会话并导航（默认 headless；--headed 需显示环境） |
| `goto '<url>'` | 当前会话内导航 |
| `snapshot [--depth=N]` | 输出页面完整可交互树（含 ref 编号与可见文本）——**交互前必看** |
| `find '<text>'` | 页面内搜索元素，返回匹配节点与 refs |
| `fill <ref> '<text>'` | 往输入框填字面量文本 |
| `press <key>` | 按键（Enter/Tab/Escape/方向键等白名单） |
| `click <ref>` | 点击元素（链接/按钮；target=_blank 的链接会开新 tab） |
| `tab-list` / `tab-select <n>` | 列出/切换标签页（点击开新 tab 后先 tab-list 再 select） |
| `close` | 收尾会话并回收浏览器进程（**多步会话用完必须 close**） |

会话一次只持有一个 default 会话；open 已开会话前先 close。会话浏览器进程由 daemon 管理，close 后整组回收。

## 会话纪律

1. **先观察后动作**：交互前先 snapshot（或 find）拿 refs，再 click/fill。ref 是页面上下文的一部分——导航后 refs 会变，不要复用旧页面的 ref。
2. **输入是字面量**：fill 的文本整体加引号（`fill e37 '王者荣耀'`）；提交用 `press Enter` 或点击提交按钮的 ref。
3. **新 tab 要切**：点击后 URL 没变多半是新开 tab——`tab-list` 看清单，`tab-select <n>` 切过去再 snapshot。
4. **用完 close**：多步会话结束必须 close（否则浏览器驻留占资源；异常退出时 feature 销毁会兜底回收，但不要依赖兜底）。
5. **读取内容用 snapshot 输出**：页面正文（含标题/段落）在 snapshot 树里可直接读；超长输出会自动落盘（报文给完整文件路径，可分段查看）。
6. **超时唯一闸门是工具 timeout 契约**；会话命令是快命令（转发给常驻 daemon），超时一般只影响当前一步。

## headless 与 headed

- 默认 headless（全自动取证）。`open --headed` 开有头窗口（需要显示环境：宿主桌面 DISPLAY，或人工用 `xvfb-run` 包裹）。
- **headed 的用途**：人工可接管（如站点人机验证）、人工演示。无人值守的 agent 会话用默认 headless。
- 部分站点对 headless 有反自动化检测（如百度搜索触发安全验证页）：这是站点策略不是故障；headed + 人工接管是合法路径，headless 下换等效入口（如站内搜索）或如实报告卡点。

## 故障表

| 现象 | 判定与处置 |
|---|---|
| `verdict: 后端缺失`（env） | 后端 playwright npm 包未装：人工在运行环境 `npm install --save-exact playwright@<pin>`，重跑 env |
| `verdict: 浏览器资产缺失` | 人工以资产目录为 `PLAYWRIGHT_BROWSERS_PATH` 执行 `npx playwright install chromium-headless-shell`；版本与 env 报文里的后端版本匹配 |
| 会话后端缺失（open 等报文） | @playwright/cli npm 包未安装：人工在运行环境 `npm install --save-exact @playwright/cli@<pin>`（v2 会话后端）；装完重试 |
| `当前没有已开启的会话` | 先 open 再交互；close 后的会话要重新 open |
| 站点弹出人机验证（如百度安全验证） | 反自动化策略，不是故障：headed 模式人工接管过验证；或换等效入口（如站内搜索）。不要反复重试同形请求 |
| `click` 后页面没动 | 链接可能开了新 tab：tab-list + tab-select 切换 |
| snapshot 输出过大被截断 | 报文含完整落盘路径，分段读取文件 |
| 未知动词报文 | 按报文里的可用动词清单与指引自我纠正（交互面只有 snapshot/find/fill/press/click/tab 系列） |
| URL 含 `&` 被拒 | 已知边界：换无查询分隔符的 URL 或改用页面可直达地址 |

## 边界（先读）

- 本 shell 的会话是**单会话受控模型**：一个 shell 实例一个 default 会话；不支持多会话并行、不支持连接外部浏览器（attach）、不支持登录态留存（state-save/load 不入表）。
- 任意 JS 执行（eval/run-code）、请求改写（route）、用例录制（codegen）、录屏（video）等官方能力不收编——需要时人工在终端用官方工具。
- 浏览器资产下载安装属装配期人工动作（env 报文给修复指引）。

## 与官方资料的关系（先读）

- 官方（microsoft/playwright-cli 仓库）自带面向其会话 CLI 的 skill，命令面与本 shell 不同（官方是 playwright-cli 原生命令，本 shell 是收编后的动词面）。以本 skill 与 help 报文为准，检索到的官方命令先对照动词表，表外命令会被结构化拒绝。
- 边界是确定性拒绝，不是沙箱：动词表之外的动词一律拒绝并附指引，不要绕。
