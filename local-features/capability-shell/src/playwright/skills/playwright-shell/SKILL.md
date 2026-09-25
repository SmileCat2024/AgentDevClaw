---
name: playwright-shell
description: "浏览器页面取证与受控会话（playwright-shell feature 内嵌技能）：用 playwright_shell 工具完成单次渲染取证（截图/PDF/HAR，可带 --profile 登录档案与 --viewport-size/--color-scheme/--wait-for-timeout/--paper-format 等渲染参数）与多步页面交互（导航/输入/点击/悬停/下拉/标签页/网络抓包/控制台），并支持持久化登录档案（open --profile 会话与产物动词 --profile 共用，登录态跨会话留存）；含动词用法、refs 纪律、URL 引号纪律、资产缺失修复、会话收尾与超时纪律。适用于对网页做取证留存或按步骤完成页面任务。"
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
| `screenshot '<url>' <out.png> [flags]` | URL → PNG（产物 = 路径 + 字节数） |
| `pdf '<url>' <output.pdf> [flags]` | URL → PDF（仅 Chromium 资产） |
| `har '<url>' <output.har> [flags]` | URL → HAR 网络活动（附 PNG 侧产物） |

产物动词通用 flags：`--profile=<名称>`（登录档案渲染）；`--viewport-size=<宽,高>`（手机/宽屏取证，如 375,667）；`--color-scheme=<light|dark>`（暗色页）；`--wait-for-timeout=<ms>`（等页面渲染再取，懒加载/动画场景截图空白时加，≤10000）；`--ignore-https-errors`（自签证书站点）。screenshot 另有 `--full-page`（整页滚动区）；pdf 另有 `--paper-format=<A4|Letter|Legal|Tabloid|Ledger|A0-A6>`（缺省 Letter，国内场景常用 A4）。

**会话动词（受控多步）**：

| 动词 | 用法 |
|---|---|
| `open '<url>' [--headed] [--browser=chrome] [--profile=<名称>]` | 启动/重启受控会话并导航（默认 headless；--headed 需显示环境；--profile 使用持久化登录档案） |
| `goto '<url>'` | 当前会话内导航 |
| `go-back` / `go-forward` / `reload` | 浏览器历史后退/前进/重载（reload 后 refs 失效，重新 snapshot） |
| `snapshot` | 输出页面完整可交互树（含 ref 编号与可见文本）——**交互前必看**（不接受参数） |
| `find '<text>'` | 页面内搜索元素，返回匹配节点与 refs |
| `fill <ref> '<text>'` | 往输入框填字面量文本 |
| `press <key>` | 按键（Enter/Tab/Escape/方向键等白名单） |
| `click <ref>` | 点击元素（链接/按钮；target=_blank 的链接会开新 tab） |
| `hover <ref>` | 悬停元素（触发悬停菜单、tooltip 等 hover 才出现的内容） |
| `select <ref> '<value>'` | 下拉框选择选项（值为选项文本或 value） |
| `capture` | 截当前会话页面为 PNG（留存登录后/交互后的当前画面；输出给保存路径） |
| `resize <宽> <高>` | 调整视口尺寸（会话中途切手机/宽屏布局） |
| `tab-list` / `tab-select <n>` / `tab-new '<url>'` / `tab-close <n>` | 标签页列出/切换/新开/关闭 |
| `requests` / `request <n>` | 列出/查看网络请求（API 抓包：页面调了什么接口、返回什么） |
| `console` | 页面控制台消息（JS 报错——页面白屏/异常排错第一现场） |
| `dialog-accept` / `dialog-dismiss` | 处理阻塞交互的页面弹窗（alert/confirm） |
| `cookie-list` | 列出会话 cookie（登录态排错：票据在不在） |
| `close` | 收尾会话并回收浏览器进程（**多步会话用完必须 close**；--profile 档案不受影响） |
| `profile-list` | 列出已有的持久化登录档案及各自用过的站点（`→` 后为站点域名，据此自动匹配任务站点与档案，无需用户指名） |

会话一次只持有一个 default 会话；open 已开会话前先 close。会话浏览器进程由 daemon 管理，close 后整组回收。

## 会话纪律

1. **先观察后动作**：交互前先 snapshot（或 find）拿 refs，再 click/fill。ref 是页面上下文的一部分——导航后 refs 会变，不要复用旧页面的 ref。
2. **输入是字面量**：fill 的文本整体加引号（`fill e37 '王者荣耀'`）；提交用 `press Enter` 或点击提交按钮的 ref。
3. **新 tab 要切**：点击后 URL 没变多半是新开 tab——`tab-list` 看清单，`tab-select <n>` 切过去再 snapshot。
4. **用完 close**：多步会话结束必须 close（否则浏览器驻留占资源；异常退出时 feature 销毁会兜底回收，但不要依赖兜底）。
5. **读取内容用 snapshot 输出**：页面正文（含标题/段落）在 snapshot 树里可直接读；超长输出会自动落盘（报文给完整文件路径，可分段查看）。
6. **超时唯一闸门是工具 timeout 契约**；会话命令是快命令（转发给常驻 daemon），超时一般只影响当前一步。
7. **要登录态就带 profile**：任务涉及已登录站点时，会话用 `open '<url>' --profile=<名称>`，一次性取证用 `screenshot '<url>' <out.png> --profile=<名称>`（pdf/har 同），不要裸跑。先用 profile-list 查已有档案——输出里 `→` 后是该档案用过的站点域名，按任务站点自动匹配；对不上号再问用户。

## 登录态与 profile（持久化档案）

- `open '<url>' --profile=<名称>` 使用持久化登录档案：档案目录在用户数据目录下（报文与 `env` 输出给出根目录位置），浏览器在该目录里保留 cookie、localStorage 等站点数据——**登录态跨会话有效**。名称只允许字母/数字开头，含字母/数字/下划线/连字符，长度 1-64。
- 产物动词（screenshot / pdf / har）的 `--profile=<名称>` 用**同一档案空间**：渲染即退出，但登录态读写同一档案目录——登录站点的取证截图/PDF/HAR 直接带 profile 渲染，不必开会话。带档案渲染完成后可能多等十几秒返回（报文附 `note:` 回收说明属正常回收，不是卡死），产物不受影响。
- 会话级登录票据也跨重启保留：每次带档案渲染/打开时，shell 会自动把档案 cookie 库中的会话级 cookie 翻转为持久化（阿里云等把登录票据设为会话级 cookie 的站点因此无需每次重登）。报文出现 `warn: 会话级 cookie 保活跳过` 时，该轮重启周期内此类登录态可能丢失。
- 首次使用：加 `--headed` 起有头窗口，由人工完成登录（含人机验证），`close` 收尾后登录态已留在档案里。
- 之后复用：`open '<url>' --profile=<名称>`（默认 headless 即可）或产物动词带 `--profile=<名称>`，直接以已登录身份操作/渲染。
- close 不清除档案；要"忘记"某站点登录态需人工删除对应档案目录。
- 档案自动匹配：带档案的 open/goto/screenshot/pdf/har 访问过的域名会记入档案（最近在前，限量 20 个），profile-list 展示 `档案 → 站点`。给任务选档案时优先按站点匹配，而不是档案名语义。
- 同一档案同时只能被一个浏览器使用：用 `--profile=<名称>` 开新会话或跑产物动词前，先 close 旧会话（产物动词失败报文附 hint 时首先怀疑档案被占用）。
- 档案即活凭据：不要把档案目录指向真实浏览器的用户数据目录；档案名按用途命名（如 `work`、`shop-a`）。

## headless 与 headed

- 默认 headless（全自动取证）。`open --headed` 开有头窗口：Windows/macOS 使用系统桌面；Linux 需要 `DISPLAY` 或 `WAYLAND_DISPLAY`，无桌面时由人工用 `xvfb-run` 包裹。
- **headed 的用途**：人工可接管（如站点人机验证）、人工演示。无人值守的 agent 会话用默认 headless。
- 部分站点对 headless 有反自动化检测（如百度搜索触发安全验证页）：这是站点策略不是故障；headed + 人工接管是合法路径，headless 下换等效入口（如站内搜索）或如实报告卡点。

## 故障表

| 现象 | 判定与处置 |
|---|---|
| `verdict: 后端缺失`（env） | 后端 playwright npm 包未装：人工在运行环境 `npm install --save-exact playwright@<pin>`，重跑 env |
| `verdict: 浏览器资产缺失` | 人工以资产目录为 `PLAYWRIGHT_BROWSERS_PATH` 执行 `npx playwright install chromium-headless-shell`；版本与 env 报文里的后端版本匹配 |
| 会话后端缺失（open 等报文） | @playwright/cli npm 包未安装：人工在运行环境 `npm install --save-exact @playwright/cli@<pin>`（v2 会话后端）；装完重试 |
| `当前没有已开启的会话` | 先 open 再交互；close 后的会话要重新 open |
| open 带 --profile 失败且报文提到档案/用户数据目录 | 该档案可能仍被占用：先 close 旧会话再重开；仍失败则换档案名或人工核查档案目录锁 |
| 产物动词带 --profile 失败且报文附 hint | 档案被占用（最常见：open 会话未 close）：先 close 再重试，或换档案 |
| 站点要求重新登录（明明带过 profile） | 服务端会话可能已失效（过期/2FA/风控踢下线）：加 --headed 人工重登一次，档案会记住新登录态 |
| 站点弹出人机验证（如百度安全验证） | 反自动化策略，不是故障：headed 模式人工接管过验证；或换等效入口（如站内搜索）。不要反复重试同形请求 |
| `click` 后页面没动 | 链接可能开了新 tab：tab-list + tab-select 切换 |
| snapshot 输出过大被截断 | 报文含完整落盘路径，分段读取文件 |
| 未知动词报文 | 按报文里的可用动词清单与指引自我纠正（交互面只有 snapshot/find/fill/press/click/tab 系列） |
| URL 含 `&` 被拒 | 已知边界：换无查询分隔符的 URL 或改用页面可直达地址 |

## 边界（先读）

- 本 shell 的会话是**单会话受控模型**：一个 shell 实例一个 default 会话；不支持多会话并行、不支持连接外部浏览器（attach）。登录态留存只经 `open --profile` 持久化档案进入动词面；state-save/load 快照与 cookie 细粒度操作不入表。
- 任意 JS 执行（eval/run-code）、请求改写（route）、用例录制（codegen）、录屏（video）等官方能力不收编——需要时人工在终端用官方工具。
- 浏览器资产下载安装属装配期人工动作（env 报文给修复指引）。

## 与官方资料的关系（先读）

- 官方（microsoft/playwright-cli 仓库）自带面向其会话 CLI 的 skill，命令面与本 shell 不同（官方是 playwright-cli 原生命令，本 shell 是收编后的动词面）。以本 skill 与 help 报文为准，检索到的官方命令先对照动词表，表外命令会被结构化拒绝。
- 边界是确定性拒绝，不是沙箱：动词表之外的动词一律拒绝并附指引，不要绕。
