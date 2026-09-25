/**
 * playwright_shell 策略声明（ticket 036 v1；v2 扩展受控会话交互）
 *
 * 领域定位：浏览器页面取证（v1 单次渲染产物）+ 受控页面会话交互（v2）。
 *
 * 动词表 v3 = one-shot 产物动词（screenshot / pdf / har / env；渲染参数面
 * --viewport-size / --color-scheme / --wait-for-timeout / --paper-format /
 * --ignore-https-errors）+ 会话动词（open / goto / go-back / go-forward /
 * reload / snapshot / find / fill / press / click / hover / select /
 * tab-list / tab-select / tab-new / tab-close / resize / capture（截当前页）/
 * requests / request / console / dialog-accept / dialog-dismiss /
 * cookie-list / close）+ profile-list（登录档案清单）：
 * 会话动词转发官方会话型 CLI（@playwright/cli）的 daemon 子命令，跨调用
 * 共享同一页面，refs 机制（click/fill/hover/select 只接受 snapshot 输出里
 * 出现过的元素引用）是防注入核心。
 *
 * 双模式：open 默认 headless；--headed 在 Windows/macOS 使用系统桌面，
 * Linux 需要 DISPLAY/WAYLAND_DISPLAY 或外部 xvfb-run，本 shell 不自动拉起 X server。
 * 登录态留存：open --profile=<名称> 使用持久化档案目录（用户数据目录语义，
 * 登录态跨会话有效），profile 名称走白名单校验；产物动词（screenshot/pdf/har）
 * 的 --profile=<名称> 桥接同一档案空间（one-shot CLI 的 --user-data-dir），
 * 登录站点取证不必开会话；state/cookie 细粒度操作仍不入表。动词表从领域需求反推，不等于后端 CLI 子命令面：任意 JS 执行
 * （eval / run-code）、用例录制（codegen）、GUI 查看器等不入表
 * （unknownVerbHints 给结构化指引）。
 *
 * adapter 后端 v2 = 双后端：one-shot CLI（playwright npm 包，产物动词）
 * + 会话 daemon（@playwright/cli，会话动词）。CLI 是实现细节，报文不出现
 * 原生命令面。
 *
 * 已知边界（拍板接受，基座另票放宽）：含查询分隔符 & 的 URL 即使加引号，
 * 也会被结构道原文扫描确定性拒绝（& 后台特征扫描引号盲）——动词描述与
 * 技能文档写明该边界，模型可自我纠正（去掉查询串或改写任务）。
 */

import type { CapabilityShellPolicy } from '../types.js';

export const PLAYWRIGHT_SHELL_NAME = 'playwright_shell';

export const PLAYWRIGHT_SHELL_DESCRIPTION = [
  '浏览器页面取证与受控会话：两组动词——',
  '(1) 一次性产物取证：screenshot / pdf / har 把 URL 渲染成可留存文件（渲染即退出，浏览器不驻留），',
  '可带 --profile=<名称> 以持久化登录档案渲染（登录站点取证）、--viewport-size=<宽,高>、',
  '--color-scheme、--wait-for-timeout（懒加载等待）、--ignore-https-errors、pdf 另有 --paper-format；',
  '(2) 受控会话交互：open / goto / go-back / go-forward / reload / snapshot / find / fill / press / click /',
  'hover / select / tab-list / tab-select / tab-new / tab-close / resize / capture（截当前页）/',
  'requests / request（网络抓包）/ console / dialog-accept / dialog-dismiss / cookie-list / close，',
  '跨调用共享同一页面会话（多步导航、输入、点击、读取页面内容），close 显式收尾。',
  '持久化登录档案：open --profile=<名称> 让登录态与站点数据跨会话留存',
  '（首次可加 --headed 人工登录，之后 headless 复用），产物动词的 --profile=<名称> 用同一档案空间；',
  'profile-list 列出已有档案。',
  '会话动词里的 click/fill/hover/select 只接受 snapshot/find 输出里的元素 ref（如 e37、f3e949）——',
  '不能凭空构造选择器；URL 参数必须整体加引号；含查询分隔符 & 的 URL 不支持（确定拒绝）。',
  '产物动词（v1）强制产物落在 workspace 内，成功报文 = 路径 + 字节数；会话动词直接回页面状态文本。',
  '首次使用或遇到拒绝报文时，先用 invoke_skill 激活 playwright-shell 技能——',
  '它是本工具的权威用法手册（动词用法、会话纪律、refs 用法、取证纪律与故障处置）。',
].join('\n');

/** env 动词缺失资产时的统一修复指引（人工动作；安装不进动词表）。 */
export const PLAYWRIGHT_ENV_FIX_GUIDANCE =
  '浏览器资产缺失或与后端版本不匹配：属装配期人工动作，不在本 shell 动词表内。' +
  '由人工在运行环境安装（命令与步骤见技能 playwright-shell「故障处置·浏览器资产缺失」），' +
  '完成后重新运行 env 确认 verdict=ok 再调用产物动词。';

/**
 * 动词表（v1，4 个 + 管线级 help）。
 * 超时唯一闸门 = Tool.timeout 契约，动词表不承载任何时间 flag。
 */
export function createPlaywrightShellPolicy(): CapabilityShellPolicy {
  return {
    name: PLAYWRIGHT_SHELL_NAME,
    description: PLAYWRIGHT_SHELL_DESCRIPTION,
    verbs: {
      'env': {
        description: '报告后端与浏览器资产状态（包版本、CLI 入口、资产目录、已装浏览器与匹配判定）；缺失时附人工修复指引，动词调用不裸抛',
        params: [],
        usage: 'env',
        adapter: { key: 'playwright:env' },
      },
      'screenshot': {
        description: '渲染 URL 为 PNG 截图文件（headless 一次性取证；产物强制 workspace 内，成功报文 = 路径 + 字节数）。--profile=<名称> 以持久化登录档案渲染（与 open 共用档案空间，登录站点取证用）；--viewport-size=<宽,高> 指定视口（手机/宽屏取证）；--wait-for-timeout=<ms> 等页面渲染再截（懒加载/动画，≤10000）；--color-scheme=<light|dark>；--ignore-https-errors 容忍自签证书站点',
        params: [
          { name: 'url', kind: 'literal' },
          { name: 'output', kind: 'path' },
        ],
        flags: ['--full-page', '--ignore-https-errors', '--profile=', '--viewport-size=', '--color-scheme=', '--wait-for-timeout='],
        usage: "screenshot '<url>' <output.png> [--full-page] [--profile=<名称>] [--viewport-size=<宽,高>] [--color-scheme=<light|dark>] [--wait-for-timeout=<ms>] [--ignore-https-errors]",
        adapter: { key: 'playwright:screenshot' },
      },
      'pdf': {
        description: '渲染 URL 为 PDF 文档（仅 Chromium 后端；非 chromium 资产时返回结构化错误，不裸抛）。--profile=<名称> 以持久化登录档案渲染；--paper-format=<纸型> 指定纸型（Letter/Legal/Tabloid/Ledger/A0-A6，缺省 Letter）；--viewport-size/--color-scheme/--wait-for-timeout/--ignore-https-errors 同 screenshot',
        params: [
          { name: 'url', kind: 'literal' },
          { name: 'output', kind: 'path' },
        ],
        flags: ['--ignore-https-errors', '--profile=', '--viewport-size=', '--color-scheme=', '--wait-for-timeout=', '--paper-format='],
        usage: "pdf '<url>' <output.pdf> [--profile=<名称>] [--paper-format=<A4>] [--viewport-size=<宽,高>] [--color-scheme=<light|dark>] [--wait-for-timeout=<ms>] [--ignore-https-errors]",
        adapter: { key: 'playwright:pdf' },
      },
      'har': {
        description: '访问 URL 并把网络活动录成 HAR 文件（同次渲染附一张 viewport PNG 侧产物，路径随报文给出）。--profile=<名称> 以持久化登录档案渲染；--viewport-size/--color-scheme/--wait-for-timeout/--ignore-https-errors 同 screenshot',
        params: [
          { name: 'url', kind: 'literal' },
          { name: 'output', kind: 'path' },
        ],
        flags: ['--ignore-https-errors', '--profile=', '--viewport-size=', '--color-scheme=', '--wait-for-timeout='],
        usage: "har '<url>' <output.har> [--profile=<名称>] [--viewport-size=<宽,高>] [--color-scheme=<light|dark>] [--wait-for-timeout=<ms>] [--ignore-https-errors]",
        adapter: { key: 'playwright:har' },
      },
      // ===== v2 会话动词（转发官方会话型 CLI daemon；refs 防注入） =====
      'open': {
        description: '启动受控页面会话并导航到 URL（默认 headless；--headed 需要显示环境：宿主桌面或外部 xvfb，本 shell 不自动拉起 X server）。--profile=<名称> 使用持久化登录档案：首次自动创建，之后登录态/站点数据跨会话留存。已有会话时先用 close 收尾再开',
        params: [
          { name: 'url', kind: 'literal' },
        ],
        flags: ['--headed', '--browser=', '--profile='],
        usage: "open '<url>' [--headed] [--browser=chrome|firefox|webkit|msedge] [--profile=<名称>]",
        adapter: { key: 'playwright:open' },
      },
      'goto': {
        description: '在当前会话里导航到 URL（页面在会话内切换，refs 上下文随页面刷新）',
        params: [
          { name: 'url', kind: 'literal' },
        ],
        usage: "goto '<url>'",
        adapter: { key: 'playwright:goto' },
      },
      'snapshot': {
        description: '输出当前页面完整可访问性树（含元素 ref 编号与可见文本）——交互前必看；click/fill 的 ref 都从这里来',
        params: [],
        usage: 'snapshot',
        adapter: { key: 'playwright:snapshot' },
      },
      'find': {
        description: '在当前页面按文本/正则搜索元素，返回匹配节点及其 ref（定位输入框、按钮、链接、板块标题）',
        params: [
          { name: 'text', kind: 'literal' },
        ],
        usage: "find '<text>'",
        adapter: { key: 'playwright:find' },
      },
      'fill': {
        description: '往 ref 对应的输入框填写文本（文本是字面量）；填写后通常用 press Enter 提交或 click 提交按钮',
        params: [
          { name: 'ref', kind: 'ref' },
          { name: 'text', kind: 'literal' },
        ],
        usage: "fill <ref> '<text>'",
        adapter: { key: 'playwright:fill' },
      },
      'press': {
        description: '在当前焦点元素上按键（Enter 提交搜索/表单等）',
        params: [
          { name: 'key', kind: 'literal', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'] },
        ],
        usage: 'press <key>',
        adapter: { key: 'playwright:press' },
      },
      'click': {
        description: '点击 snapshot 输出里的元素（只接受已出现的 ref，不能凭空构造）',
        params: [
          { name: 'ref', kind: 'ref' },
        ],
        usage: 'click <ref>',
        adapter: { key: 'playwright:click' },
      },
      'hover': {
        description: '悬停在 snapshot 输出里的元素上（触发悬停菜单、tooltip 等 hover 才出现的内容）',
        params: [
          { name: 'ref', kind: 'ref' },
        ],
        usage: 'hover <ref>',
        adapter: { key: 'playwright:hover' },
      },
      'select': {
        description: '在 ref 对应的下拉框里选择选项（值为选项文本或 value）',
        params: [
          { name: 'ref', kind: 'ref' },
          { name: 'value', kind: 'literal' },
        ],
        usage: "select <ref> '<value>'",
        adapter: { key: 'playwright:select' },
      },
      'go-back': {
        description: '后退到上一页（浏览器历史）',
        params: [],
        usage: 'go-back',
        adapter: { key: 'playwright:go-back' },
      },
      'go-forward': {
        description: '前进到下一页（浏览器历史）',
        params: [],
        usage: 'go-forward',
        adapter: { key: 'playwright:go-forward' },
      },
      'reload': {
        description: '重新加载当前页面（refs 上下文随刷新失效，交互前重新 snapshot）',
        params: [],
        usage: 'reload',
        adapter: { key: 'playwright:reload' },
      },
      'capture': {
        description: '截取当前会话页面为 PNG（留存登录后/交互后的当前画面；CLI 自动落盘并在输出给出路径）',
        params: [],
        usage: 'capture',
        adapter: { key: 'playwright:capture' },
      },
      'resize': {
        description: '调整当前会话视口尺寸（会话中途切换手机/宽屏布局）',
        params: [
          { name: 'width', kind: 'literal' },
          { name: 'height', kind: 'literal' },
        ],
        usage: 'resize <宽> <高>',
        adapter: { key: 'playwright:resize' },
      },
      'requests': {
        description: '列出当前页面自加载以来的全部网络请求（编号列表，API 抓包排查用）',
        params: [],
        usage: 'requests',
        adapter: { key: 'playwright:requests' },
      },
      'request': {
        description: '查看指定编号网络请求的完整详情（请求/响应头与正文；编号来自 requests 输出）',
        params: [
          { name: 'index', kind: 'literal' },
        ],
        usage: 'request <编号>',
        adapter: { key: 'playwright:request' },
      },
      'console': {
        description: '列出页面控制台消息（JS 报错、警告——页面白屏/异常排错第一现场）',
        params: [],
        usage: 'console',
        adapter: { key: 'playwright:console' },
      },
      'dialog-accept': {
        description: '接受页面弹窗（alert/confirm 阻塞交互时）',
        params: [],
        usage: 'dialog-accept',
        adapter: { key: 'playwright:dialog-accept' },
      },
      'dialog-dismiss': {
        description: '拒绝页面弹窗（alert/confirm 阻塞交互时）',
        params: [],
        usage: 'dialog-dismiss',
        adapter: { key: 'playwright:dialog-dismiss' },
      },
      'cookie-list': {
        description: '列出当前会话的全部 cookie（登录态排错：票据在不在、过期没有）',
        params: [],
        usage: 'cookie-list',
        adapter: { key: 'playwright:cookie-list' },
      },
      'tab-list': {
        description: '列出当前会话的所有标签页（点击 target=_blank 的链接会开新 tab，点完要用 tab-select 切过去）',
        params: [],
        usage: 'tab-list',
        adapter: { key: 'playwright:tab-list' },
      },
      'tab-select': {
        description: '切换到指定编号的标签页（编号来自 tab-list 输出）',
        params: [
          { name: 'index', kind: 'literal' },
        ],
        usage: 'tab-select <编号>',
        adapter: { key: 'playwright:tab-select' },
      },
      'tab-new': {
        description: '新开一个标签页并导航到 URL（打开后再 tab-select 切过去）',
        params: [
          { name: 'url', kind: 'literal' },
        ],
        usage: "tab-new '<url>'",
        adapter: { key: 'playwright:tab-new' },
      },
      'tab-close': {
        description: '关闭指定编号的标签页（编号来自 tab-list 输出；关错用 tab-new 重开）',
        params: [
          { name: 'index', kind: 'literal' },
        ],
        usage: 'tab-close <编号>',
        adapter: { key: 'playwright:tab-close' },
      },
      'close': {
        description: '结束当前会话并回收浏览器进程（多步会话用完必须收尾；未开会话时幂等）。--profile 档案目录不受 close 影响，登录态留存',
        params: [],
        usage: 'close',
        adapter: { key: 'playwright:close' },
      },
      'profile-list': {
        description: '列出已有的持久化登录档案及各自用过的站点（→ 后为站点域名）。任务涉及登录站点时先跑本动词，按站点自动匹配档案',
        params: [],
        usage: 'profile-list',
        adapter: { key: 'playwright:profile-list' },
      },
    },
    // 双模式并行性：产物动词各自独立起浏览器（无共享态），会话动词共享
    // daemon 会话——都必须串行。未声明 parallelizable，串行由基座默认承担。
    // 显式排除动词的结构化指引（v3：hover/select/go-back/go-forward/reload/
    // tab-new/tab-close/resize/capture/requests/request/console/dialog-*/
    // cookie-list 已入表；其余官方会话命令面维持排除，模型可自我纠正）。
    unknownVerbHints: {
      'type': 'type 逐键输入不入本 shell；输入文本用 fill（配 press Enter 提交）。',
      'dblclick': 'dblclick 不入本 shell 动词表；本 shell 的会话交互面为 snapshot/find/fill/press/click/hover/select。',
      'eval': 'eval 允许执行任意页面 JS，被本 shell 显式排除（注入面不可控）；读页面内容用 snapshot/find。',
      'codegen': 'codegen 是交互式用例录制器（打开录制窗），不入本 shell；需人工在终端执行。',
      'state-save': 'state-save 保存存储快照，不入本 shell；登录态留存用 open --profile=<名称>（持久化档案，跨会话有效），profile-list 可查已有档案。',
      'state-load': 'state-load 加载存储快照，不入本 shell；登录态留存用 open --profile=<名称>（持久化档案，跨会话有效）。',
      'route': 'route 是请求 mock/拦截，不入本 shell 动词表（取证场景不做请求改写）；网络活动查看用 requests/request。',
      'run-code': 'run-code 允许执行任意 Playwright 代码，被本 shell 显式排除（注入面不可控）；观察与交互用 snapshot/find/fill/click/press。',
      'tracing-start': 'tracing-start 不入本 shell：trace 调试属测试开发场景，人工在终端执行。',
      'video-start': 'video-start 不入本 shell：录屏属会话扩展能力，不入动词表。',
      'attach': 'attach 连接外部浏览器（CDP），不入本 shell：受控会话只连本 shell 自己启动的浏览器。',
      'delete-data': 'delete-data 清理会话用户数据，不入本 shell；会话数据由 close 收尾回收。',
      'kill-all': 'kill-all 是内部兜底命令，不对模型暴露；会话收尾用 close。',
      'close-all': 'close-all 批量收尾由内部生命周期管理承担，动词面只提供 close（单会话收尾）。',
      'list': 'list 是会话清单查询（内部管理用），动词面不透出；要查持久化登录档案用 profile-list。',
      'install': 'install 不入动词表：浏览器资产下载安装属装配期/人工动作。先运行 env 查看资产状态，'
        + '缺失时按报文与技能 playwright-shell「故障处置」表由人工安装，完成后再调用产物动词。',
      'install-browser': 'install-browser 不入动词表：浏览器资产下载属装配期/人工动作（见 install 指引）。',
      'install-deps': 'install-deps 不入动词表：系统依赖安装需要 sudo，属人工动作，不在本 shell 执行。',
      'uninstall': 'uninstall 不入动词表：属装配期/人工维护动作，不在本 shell 执行。',
      'test': 'test 是 Playwright 测试运行器，不入本 shell：本 shell 只做浏览器页面取证（screenshot / pdf / har）。',
      'show-trace': 'show-trace 打开 GUI 查看器，不入本 shell；需人工在桌面环境执行。',
      'show-report': 'show-report 打开 GUI 报告，不入本 shell；需人工在桌面执行。',
      'mcp': 'mcp 启动常驻 MCP server，不入本 shell（本 shell 是单次命令，无常驻服务）。',
      'cli': 'cli 是后端原生命令透传入口，被本 shell 显式排除：能力面只由本 shell 动词表决定。',
    },
  };
}
