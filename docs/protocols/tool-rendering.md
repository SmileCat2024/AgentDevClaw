# 工具调用与结果的渲染约定

面向为 Claw 对话界面编写 `*.render.ts` 模板的 Feature 作者。它是推荐的组合约定，不是强制的 DOM schema：工具模板可以自定义布局和样式。框架内置的 `grep`、`glob`、`ls`、`read`、`edit`、`write` 模板是可参考的实现。

## 宿主与模板的职责

- 宿主在调用区提供 `.tool-call-container > .tool-header + .tool-content`，在结果区提供 `.message-row.tool > .message-content > .tool-result-header + .tool-result-body`。两类卡片同构：标题条用次级文字色并以下划分隔线与正文隔离，正文区用主文字色。状态、工具名称、复制操作、折叠/展开和聊天滚动由宿主负责；模板只返回 call/result 的内容 HTML，不要重复绘制整套宿主标题。
- 宿主对调用与结果提供同一层玻璃底色、默认留白和轻边界。模板可以覆盖样式，但一般不需要再包一层卡片、底色和完整边框。需要分组时优先用标题、行间距或细分隔线；错误与增删差异可以保留语义色。
- 长内容默认折叠：超过高度阈值的消息行（工具结果行、含调用卡的 assistant 行）由宿主整体自动折叠，展开/收起按钮统一挂在行级（块外），用户选择跨重渲染记忆；模板不必（也不应）实现自己的折叠，调用卡内也没有独立折叠。模板不宜再设置固定 `max-height` + `overflow-y:auto`，否则鼠标滚动落在内层时会卡在第二条滚动轨道。超宽代码/差异表允许在结果区横向滚动；需要交互视口（画布、地图等）的 Feature 可自行设计滚动区域。
- 正文使用宿主文字颜色 `--text-primary` / `--text-secondary`，状态使用 `--success-color` / `--error-color` / `--warning-color`。普通文字继承宿主字体；路径、代码、行号用 `ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace`，避免在模板内硬编码多个字号和互相冲突的字体。深浅主题都要检查对比度。
- 模板输出会作为 HTML 插入页面。所有外部数据（包括路径、行号和属性值）都要 HTML 转义；不要把工具结果原文拼进事件处理器或 `style` 属性。

## 官方内容样例

文件搜索结果的内容层可以参考 `../AgentDev/packages/core/src/features/opencode-basic/templates/grep.render.ts`：按文件分组、路径作为次级标题、行号用 `data-line`、末尾显示总数/截断提示。`glob.render.ts` 和 `ls.render.ts` 分别提供文件列表与目录树示例。对应默认样式在 `public/styles/components.css` 的 `.tool-search-*` / `.tool-file-*` / `.tool-tree`；同一套类在框架 DebugHub Viewer 的 `packages/viewer/src/viewer-html/css.ts` 中也有样式。若自定义模板不使用这些类，宿主仍会正常显示其 HTML，不会改写或强制套用内容结构。

文件差异示例见 `edit.render.ts` / `write.render.ts`：Diff2Html 负责生成差异行和文件元信息，Claw 的工具结果区样式让文件内容嵌入现有宿主表面而非再套一个文件卡片。模板里不必复制 Diff2Html 的外框。

工具需要给人看结构化信息、给模型看紧凑文本时，用框架的 `withDisplay(text, display)` 分离双通道：文本一字不动进 LLM 上下文，display 对象经消息的 display 字段到达前端并与模板数据合并。示例见 `../AgentDev/packages/shell-feature/src/templates/bg-list.render.ts` 与 `bg-status.render.ts`（对应工具在 `bg-tools.ts` 中的 withDisplay 装配）；模板必须为没有 display 的历史会话保留纯文本回退分支。`bash.render.ts` 演示了同一模板按数据形态分流（后台启动卡 / 前台输出文本）。

验收时至少检查：短结果、长结果及默认折叠/展开、超长路径/代码行、错误与空结果、深浅主题；同时确认纵向只有聊天滚动轨道、横向滚动不截断内容。主前端的模板入口在 `public/src/modules/template-engine.js`，结果行在 `public/src/modules/chat-renderer.js`；DebugHub Viewer 是独立渲染管线，不要把它的 CSS 当作主前端样式。
