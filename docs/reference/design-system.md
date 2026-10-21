# 前端设计系统（Claw 主前端）

> 状态：活文档。最后更新：2026-10-21。
>
> 本文写给 coding agent 与新进开发者，**修改任何 Claw 前端（`public/`）的样式、新增任何 UI 控件之前先读本文**。渲染机制、workspace 切换、数据加载时序等行为层问题见 [frontend-rendering-patterns.md](frontend-rendering-patterns.md)；工具卡片的内容层契约见 [tool-rendering.md](../protocols/tool-rendering.md)——本文只管视觉层。
>
> 本文的规范全部**归纳自现有代码的既成事实**，不是设计稿。发现代码与本文冲突时：代码代表多数先例则修正本文；否则修代码对齐本文。

## 0. 最高优先级约束

1. **先复用，后创造**。新增任何控件前，先在 §2 配方清单里找同类；命中就直接复用类名或照抄配方。**禁止自造同类控件的新形态**（自造文字箭头、自画图标、新按钮样式都属于此类）。找不到同类才新造，且新形态要有明确理由。
2. **配方是完整属性集**。"对齐某个配方"意味着颜色、圆角、字号、字重、字距、hover 态**全部**一致——只对齐颜色形状、漏掉字体字距不算对齐。
3. **违反本文视同缺陷，不是风格偏好**。认为某条规范该改，先改本文并说明理由，再改代码。

## 1. 视觉语言基调

- **深色玻璃质感**是主语言：面板与浮层用 `--glass-bg` + `backdrop-filter: blur(var(--glass-blur)) saturate(1.2~1.3)` + `--glass-border` 三件套，页面底是静态 ambient 光晕（`--ambient-*`），不跟随交互移动。
- 颜色基调克制：中性深灰底、三级文字层次、**唯一强调蓝 `#6391ff`**（hover `#5078e6`）。不引入第二种品牌色；语义色（success/error/warning）只做状态，不做装饰。
- 基调：简约、大气、现代化。装饰靠层次与光感，不靠彩块，避免花里胡哨的堆料与廉价的纯色填充。
- 深浅双主题是常态而非可选：所有新样式必须双主题验证（§6.2）。

## 2. 配方清单

定义位置以类名 grep 为准（文件 + 大致区段），不记行号。先例是"这样写已经被项目接受"的证据。

### 2.1 按钮

| 配方 | 类名 / 位置 | 关键属性 | 用途与规则 |
|---|---|---|---|
| 主按钮 | `.settings-btn-primary`（layout.css 设置区段） | `.settings-btn` 基座（padding 9px 20px / radius 10 / 14px/600）+ `#6391ff`，hover `#5078e6` | 表单提交、主动作。**项目里只有一种主按钮蓝**，任何"蓝色主按钮"都是这个配方 |
| 次级按钮 | `.settings-btn-secondary`（layout.css 设置区段） | 同基座 + `rgba(255,255,255,0.06)` 半透明底，hover 0.10；light 主题 `#f0f0f0`/`#e4e4e4` | 取消、辅助动作 |
| banner 按钮（PH） | `.ph-banner-btn`（components.css PH Banner 区段） | 高 36 / padding 0 18 / 13px/600 / radius 10 / 玻璃白底 | **只用于对话视图 PH banner 内**；`.secondary` 变体去底去影 |
| 工作空间 hero 按钮 | `.workspace-action`（components.css workspace 区段） | radius 8 / padding 8×16 / 13px/500 / 半透明底 | 工作空间首页 hero 的动作钮，`.secondary` 弱化。与 `.ph-banner-btn` 是**并行的两族 banner 按钮**——按所在 surface 选族，不要互相照抄 |
| 返回/关闭按钮 | `.feature-detail-close`（layout.css feature-detail 区段） | **32×32 / radius 999px 圆形 / 玻璃微底 / SVG 图标** | 弹窗与二级页的返回、关闭。**最高频违反项**：不要自造 `‹ 返回` 文字按钮或幽灵矩形按钮，先例遍布 feature-store、模型配置、MCP 网关等弹窗 |
| 悬浮动作按钮 | `.settings-fab`（components.css 设置区段） | 沿用主按钮蓝配方 + `position: absolute; right: 48px; bottom: 44px` | 设置弹窗右下角主动作。right 48 = 窗口 padding 24 + 内容 padding 24（对齐列表右缘，不是随手数字）；存在时内容区需预留 padding-bottom 防遮挡（配套 `:has()` 规则） |

### 2.2 容器

| 配方 | 类名 / 位置 | 关键属性 | 用途与规则 |
|---|---|---|---|
| 设置弹窗 | `.feature-detail-window`（layout.css feature-detail 区段） | `min(100%, 720px)` / radius 20 / 玻璃三件套 + saturate(1.3) / padding 24 / 顶部径向光 | **全部设置类弹窗的统一壳**。更大规格用同配方改宽：IDE 风格 `.ph-settings-window`（1040×820）、auth 520、登录卡 400 |
| 工作空间 banner | `.ph-banner`（components.css PH Banner 区段） | radius 20 / padding 24×28 / 多层径向光 + 深底 / blur(16px) saturate(1.2) / title 20px/750 | 工作空间首页的头部横幅，规格大气（比设置弹窗内卡片大一号）；窄屏响应式降 padding（媒体查询随配方） |
| 首页卡片 | `.workspace-launch-card`（components.css workspace 区段） | radius 20 / padding 24 / min-height 220 / 顶部 2px 高光线 / inset 顶光 | 工作空间首页功能卡；`.primary` 变体加蓝色径向光 |
| 玻璃胶囊 | `.call-elapsed-capsule`（components.css 调用状态区段） | radius 999 / padding 4×11 / 13px/500 / 玻璃底 + saturate(1.3) / inset 1px 白描边 | 悬浮于滚动内容之上的状态胶囊（时长、计数类）；accent 变体叠靛蓝半透明。承载它的 `.input-meta-bar` 绝对定位在输入槽位上方，不撑高槽位；显隐不改变欢迎标题、输入卡及跟随按钮位置 |
| 悬浮几何基线 | `#user-input-container`（components.css composer 区段） | `position: absolute; bottom: var(--composer-bottom)`（50px）/ z-index 1000 / 钉主内容列 | 主内容列底部悬浮输入条（对话 composer、APP 首页快记条）的统一几何：**不进滚动内容流**（进内容流会随内容高度被推走）；整条空白带 `pointer-events: none`、可交互体恢复 `auto`；滚动容器按悬浮体最大高度留底 padding 让位。**无消息欢迎/加载态例外**：composer 作为主内容列的固定尺寸 flex 子项参与排版（仍在聊天容器外），欢迎区使用其上方剩余空间；底部间距仍取同一 `--composer-bottom`，与消息态输入卡坐标一致；有消息后恢复悬浮几何 |

### 2.3 区段与文字结构

| 配方 | 类名 | 关键属性 | 规则 |
|---|---|---|---|
| 区段容器 | `.settings-section` | flex column / gap 12 | 设置页区块的标准骨架；分区间距 16、标题到内容 12 |
| 区段标题 | `.settings-section-title` | 13px/600 / `text-transform: uppercase` / `letter-spacing: 0.5px` / 次级色 | **uppercase + letter-spacing 只用于英文标签**。中文标题禁用这两个属性——中文会被逐字撑开，项目里没有这种风格 |
| 子级标签 | `.settings-subsection-label` | 11px/600 / uppercase / 0.4px / opacity 0.7 | 同上，仅限英文短标签 |
| 消息列宽 | `.message-row` 等 | `max-width: 800px; margin: 0 auto` | 对话流所有行级元素的统一列宽，新元素跟随 |

### 2.4 输入框

| 配方 | 类名 / 位置 | 关键属性 | 规则 |
|---|---|---|---|
| 正文输入 | `.user-input-textarea`（components.css composer 区段） | 16px / line-height 1.6 / padding 0 / min-height 单行行框 / `box-sizing: border-box` | 对话与快记类输入的排版基准；排版与盒子高度解耦（§6.4） |
| 表单输入 | `.workspace-form-textarea`（components.css 表单区段） | 见先例 | 设置类表单的多行输入 |

### 2.5 颜色与玻璃 token（base.css）

token 双主题成对定义（`:root` 深色 / `body[data-theme="light"]`），**新样式只允许引用 token，不允许裸写色值**（`#6391ff` 主按钮蓝等配方内既有常量除外）：

- 文字三级：`--text-primary` / `--text-secondary` / `--text-muted`（`--text-tertiary` 是未定义的残留引用，裸用处实际回落初始值；勿新增引用）
- 面：`--panel-bg` / `--bg-secondary` / `--input-card-bg` + `--border-color`
- 交互：`--hover-bg` / `--active-bg` / `--accent-bg` / `--accent-text`
- 玻璃三件套：`--glass-bg` / `--glass-blur` / `--glass-border`
- 玻璃卡的**不透明近似值**：`--diff-gutter-bg`（横向滚动内容必须被不透明遮罩盖住的地方用，半透明底遮不住）
- 背景光晕：`--ambient-glow-*` / `--ambient-base` / `--ambient-vignette`（只用于 body 背景，不抬升页面基色）
- 语义色：`--success-color` / `--error-color` / `--warning-color`

## 3. 场景参照系（何时用哪套）

同类控件在不同场景有不同规格，**选错参照系 = 返工**：

| 场景 | 容器参照 | 卡片规格 | 按钮参照 | 参照先例 |
|---|---|---|---|---|
| 设置弹窗内部 | `.feature-detail-window` | 紧凑：radius 10~12 / padding 12~20 / 12~13px 文字 | `.settings-btn-*` | 模型配置、MCP 网关、auth 弹窗 |
| 工作空间首页 | 页面级 | 大气：radius 20 / padding 24×28 / title 20px/750 | `.workspace-action`（hero 内）/ `.ph-banner-btn`（PH banner 内） | 编程小助手 banner、workspace 卡片 |
| 对话流内 | `.message-row`（800px 列） | 跟随消息卡规格 | 胶囊与行内操作 | 工具卡、时长胶囊 |

判断口径：弹窗是"操作台"，密度优先；工作空间首页是"门户"，气势优先。不确定时找同场景先例对齐，不要跨场景照搬。

## 4. 节奏表（现有代码的事实分布）

以下是**归纳**出来的既有规律，供新代码取值；不是新发明的体系，存量异值不要求批量改。

**字号**（正文 px 制，`rem` 仅存于个别历史文件）：

- 正文四档：**11 / 12 / 13 / 14**（合计占绝对主力；12 最小可读辅助，14 正文默认——body 基准 14px）
- 次级：15 / 16（强调正文、次级标题）
- 展示级：18 / 20 / 22 / 24（banner 标题、大数字）
- **禁止新增半 px 值**（11.5 / 12.5 等）：存量是肉眼微调的历史痕迹，不是体系的一部分；需要区分层级时用整档或字重/颜色区分

**圆角**：

- 控件档：4 / 6（小输入、复选）/ 8（列表项、输入）/ 10（按钮）/ 12（卡片）
- 容器档：14 / 16 / 18 / 20（大卡片、弹窗、banner）——弹窗与 banner 统一 20
- 胶囊档：`999px`（圆钮、状态胶囊）
- 映射规则：控件越小档位越低；跨档混用相邻值（如卡片 12 + 内部按钮 8）是正常层次

**间距**（gap / padding 主力）：

- 2 / 4 / 6 / 8 / 10 / 12 / 16，8 是绝对众数；偶数为主，4 的倍数优先
- 设置页节奏（既有注释成文）：分区间 16，标题到内容 12
- 大容器 padding：20 / 24 / 28（banner 24×28、弹窗 24、首页卡 24）

**宽度档位**：

- 对话列：800px（`max-width`，居中）
- 标准设置弹窗：`min(100%, 720px)`；IDE 风格 1040×820；auth 520；登录卡 `min(100%, 400px)`
- **禁止对文本输入框、内容列硬编码固定宽度**（反例：固定 880px 阅读宽；输入框 420→320→260px 三连缩）——用 `max-width` / `min()` / 弹性布局表达"不超多宽"，不是"必须多宽"

## 5. 视觉术语 → CSS 机制对照

"居中"、"对齐"这类视觉语言与 CSS 属性不是一一对应的（"居中"一词就可能对应下表四种机制），**动手前先查 computed style 确认机制，不要连猜连改**：

| 用户说 | 候选机制 | 判别 |
|---|---|---|
| "居中" | ① 文字水平居中 `text-align: center` ② 块级水平居中 `margin: 0 auto` / `justify-content` ③ 弹性垂直居中 `align-items` ④ 绝对定位居中 | 先看说的是**文字**还是**容器**；再取元素查 computed style 确认机制，不要凭代码直觉连改多个属性 |
| "没对齐 / 对齐 XX" | 边框 + padding 的累计偏移 | 用标尺工具量实际像素（历史：2px 边框 + 16px padding = 18px 偏移肉眼可见但 grep 不出来） |
| "间距不协调" | gap / margin / padding 三者叠加 | 逐层列 computed 值再调，禁止盲调数字循环 |
| "字太大了 / 跟着变" | 等比缩放携带文字（SVG `width:100%`） | 见 §6.1 |
| "格格不入" | 大概率是没走配方 | 对照 §2 逐项检查 |

## 6. 硬约束

### 6.1 字号稳定性

- **禁止 `viewBox` + `width: 100%` 的 SVG 携带文字**：容器宽于设计宽时文字被等比放大（400px 设计宽放进 ~700px 容器，全部文字放大 1.75 倍）。图内必须有文字时用 HTML 定位叠加，SVG 只画图形。
- 文字尺寸不随窗口宽度变化；需要响应的是容器位置与换行，不是字号。
- 窄屏不溢出：文本容器给 `min-width: 0` + 截断/换行策略，Stat 卡类布局要验证窄屏下文字不叠压。

### 6.2 双主题验证

- 每个新组件/改色，**深色与亮色主题都要看一眼**再交付。深色下可读的次级色，换到亮色底上可能不足（时长胶囊、hljs 亮色主题都出过这类问题）。
- 新样式写法：引用 §2.5 token 天然双主题；确需写死，必须成对提供 `body[data-theme="light"]` 覆盖。

### 6.3 图标

- 图标用 SVG，线宽与尺寸跟同场景既有图标一致；**禁止用文字符号（`‹` `›` `×` `+`）冒充图标**——文字符号与 SVG 图标并排时体量失衡、风格不统一。
- 32×32 圆形图标钮走 `.feature-detail-close` 配方；行内小图标参照 `.session-title-ai-btn` / rail 图标。

### 6.4 输入排版

- **排版与盒子高度解耦**：字号 / 行高只描述文字本身（如 16px / 1.6），控件高度由 padding、min-height 或同排最高的控件撑起。**禁止用放大的 line-height 硬撑控件高度**——行距会随行数逐行放大，且首行光标与字形贴行框边缘。
- 输入字段自带垂直呼吸（垂直 padding），不与行框零余量贴合：`overflow` 滚动容器里，零余量的盒高经亚像素取整即可产生可见裁切。

## 7. CSS 工程陷阱

1. **特异度反杀**：容器想给所有子元素垫 `position: relative` 时，`> *:not(.x):not(.y)`（0,2,0）会压过单类选择器（0,1,0），把窗口级 `absolute` 元素（footer / FAB）覆盖成 relative，布局整坏。豁免写法参照 `.feature-detail-window` 的 `:not()` 链（layout.css feature-detail 区段，带注释）。
2. **源序反杀**：同特异度按源序，**覆盖规则必须写在被覆盖规则之后**。`.ph-settings-content.settings-scroll-quiet` 必须留在基础规则之后（components.css 设置区段注释"历史事故，勿移回"）。
3. **UA 默认值**：`button` 默认 `align-items: center`、默认字体不继承——新按钮要显式 `font: inherit` 或走配方基座；诊断"不居中"先确认是不是 UA 默认值在起作用，不是所有偏差都来自自己的 CSS。
4. **继承漏网**：`text-transform: uppercase` / `letter-spacing` 会继承到中文并产生破坏性效果（§2.3）；嵌套元素显式重置这两个属性。
5. **编辑事故**：对 CSS 文件做块级替换时，先确认目标块完整闭合（`}` 配对），整条规则可能在替换中被吞掉、控件回落 UA 默认样式。改完 grep 类名确认规则仍在。
6. **无通用工具类**：项目没有全局 `.hidden` 之类显隐工具类，显隐用成对声明（`.x.hidden { display: none }`，先例 `workspace-tabs-bar`）——单写 `.hidden` 类名没有规则命中。
7. **flex item 宽度基准**：行布局（row）容器里的子项主轴宽度不再自动拉满，`min(Npx, 100%)` 类宽度上限依赖父级有显式宽度基准（如 `width: 100%`）——宽度异常先查父级 display 与宽度，不是改子级。
8. **浅色主题特异度**：`body[data-theme="light"] .x` 是 0,2,1，会压过无界单类覆盖（0,1,0）——覆盖浅色规则必须带同样的 `body[data-theme="light"]` 前缀伴生选择器（§6.2 要求成对提供的机制原因）。

## 8. Do / Don't 速查

**Do**

- 新控件先 grep 同类（返回按钮、主按钮、胶囊、卡片都有现成配方）
- 颜色只走 token；配方内既有常量（主按钮蓝）原样照抄
- 弹性宽度（`max-width` / `min()`），双主题验证，窄屏过目
- 间距字号取节奏表整档值，偶数优先
- 输入框排版走 §2.4 配方，高度由 padding / min-height 撑（§6.4）
- 悬浮控件走 §2.2 悬浮几何（absolute 钉主内容列），不进滚动内容流
- 对话流内新元素跟随 800px 列宽

**Don't**

- 不要自造文字箭头 / 文字符号图标 / 新按钮形态 / 新胶囊样式
- 不要裸写色值、硬编码输入框宽度、新增半 px 字号
- 不要给中文加 uppercase / letter-spacing
- 不要让 SVG 等比缩放携带文字
- 不要只对齐配方的颜色而漏掉字体字距（配方是完整属性集）
- 不要跨场景照搬规格（弹窗卡 ≠ 工作空间 banner；两族 banner 按钮按 surface 选）
- 不要用放大的 line-height 撑输入框高度；不要单写 `.hidden` 类名（无通用工具类）
