# 内联事件迁移配方（Phase C 内联事件面 · 批 8 起工单共用）

> 本文档是给派发工单的转换规范，由批 1-7 的实践提炼。工单只补充本线的文件清单与特殊说明，转换规则以本文档为准。历史先例：批 1 `299bad3a`、批 2 `532079bc`、批 3 `20147817`、批 4 `1234cd15`、批 5 `d9783e39`、批 6 `3312ef5b`、批 7 `bed8877b`。

## 目标

把模块模板字符串里的内联事件处理器（`onclick="..."` 等属性形态与 `setAttribute('onclick', ...)` 注入形态）转换为 `data-action` 声明 + 集中注册的处理器，消除模板对全局函数的字符串引用。

## 转换配方

1. **命名空间**：`data-action="<模块缩写>.<动作驼峰名>"`，如 `phSettings.close`、`wsBlocks.saveForm`、`sessions.switchTab`。同一模块全部动作共用一个命名空间。
2. **处理器注册**：文件尾部（模块顶层）`window.ClawFW.actions.registerMany({ ... })` 集中注册；handler 签名 `(el, event, ...args)`，`el` 是命中的元素。
3. **参数传递**：
   - 字符串参数 → 独立 `data-*` 属性，模板侧经 `escapeHtml(...)` 编码，handler 侧 `el.dataset.<name>` 读取（camelCase 属性 → dataset 驼峰转换注意）。
   - 数字参数 → `data-args='[123]'` JSON 数组，handler 展开。
   - `this.value` / `this.checked` → `el.value` / `el.checked`；`this.dataset.x` → `el.dataset.x`（原 `data-x` 属性保留）。
4. **事件类型**：
   - 默认已绑定 click/change/input/dblclick/keydown/focusout，无需声明。
   - 需要精确化时用 `data-event="input"` / `data-event="change"` 等限定（空格分隔多类型，如 `"input keydown focusout"`）。
   - 表单控件建议声明精确类型：文本类 `"input"`、select 类 `"change"`——避免 keydown 用旧值回写噪声。
   - `focusout` 只对显式声明了它的元素生效（协议守卫，防渲染重入）。
   - `<details>` 的 `ontoggle` 不冒泡 → `data-event="toggle"`，模块内 `ClawFW.actions.bindEventType('toggle', true)` 扩绑捕获（先例：debug-features-hooks）。
   - 需要 bindEventType 新类型时**报告回来由主助手改 action-dispatcher.js**（禁区）。
5. **键盘可达性**：菜单项/卡片的 `onkeydown` Enter/Space 激活 → `data-key-activate` 声明属性（先例：session-list-render 的菜单项）；内部按钮按键不触发外层的守卫语义已内建。
6. **防默认提交**：`onsubmit="return false"` → 渲染后处理段元素级 `addEventListener('submit', e => e.preventDefault())`（先例：session-dialogs、ph-thread-history）。
7. **stopPropagation 前缀**：委托模型取最近 data-action 祖先，天然等价，直接删；纯挡板（无动作只阻止冒泡，如 overlay 的 window 点击）→ 保留为 no-op 或带守卫的 action（先例：`wsBlocks.repoDetailsClose` 的 `event.target === el` 守卫）。
8. **hover 视觉效果**：`onmouseenter/onmouseover` 变色类 → CSS `:hover` 规则（layout.css），不进分发器（先例：model-settings 的眼睛按钮）。
9. **动态拼接函数名**（`'window.' + fn + '(...)'`）→ 调用方显式传 action 名（先例：ph-settings 策略卡）。
10. **setAttribute 注入形态**：`el.setAttribute('onclick', 'fn()')` → `el.dataset.action = '<ns>.<name>'`（先例：choice-input）。
11. **一元 `+` 开头的模板数组元素**：行首 `+` 会与上一行拼接成 NaN，转换时确保每行以引号或 `+`（二元）开头——写完自查 `node --check`。

## 函数收敛规则

- 模块内定义、全仓消费面为零的 `window.X = ...` → 收敛为模块级 `const X = ...`（声明处就地改，时序等价）。
- **有消费面的函数保留 window 导出**（其他模块 / 已完成批次的注册块经 window 转调），handler 内 `window.X(...)` 转调。消费面查询：`grep -rn "X" public/ test/ --include="*.js"` 排除本模块后看是否有点调。
- 定义在其他模块的函数：handler 经 `window.X(...)` 转调，注释标注定义域（随定义域批次收敛）。

## 测试改造规则

- 系统性找装载本线模块的测试：`grep -rln "modules/<模块名>.js" test/*.test.js`（不按测试文件名猜——历史上名字不含模块名的测试装载过模块）。
- 装载模块的测试若在模块顶层注册前无 `ClawFW`：装载序列最前面补 `ctx.loadSource('public/src/modules/action-dispatcher.js')`（真实生产加载顺序第一位）。**先查该测试是否已预载，重复装载会双绑定监听**。
- 直调已收敛 window 函数的用例 → 改 `window.ClawFW.actions.invoke('<ns>.<name>', { dataset: {...} })`（真实按钮路径，先例：frontend-input-convergence 的 choice 域）。
- 断言旧 onclick 字符串形态的用例 → 改断言 `data-action` / `data-*` 形态（承诺不变：按钮存在且动作可寻址）。
- 测试的 document 桩若缺 `addEventListener` → 补齐真实 document 形状（不是绕过分发器）。

## 验证要求（每模块完成后）

1. `node --check <file>` 语法。
2. 内联清零：gate 同款正则 `on(?:click|change|input|...)="[^"]*"` 与 `setAttribute\(\s*['"]on(?:click|...)` 在本模块零命中。**注释里也不要留 `onclick="` 字面量**（gate 正则会命中），用「内联事件」措辞。
3. 目标测试全绿（本线相关 test 文件）。
4. 变异验证抽查（每线至少 2 项）：删一个注册键 → gate 覆盖测试（`test/frontend-inline-events-gate.test.js` 单跑覆盖断言会失败——注意 ratchet 断言此时必红是预期，基线未更新，只看覆盖断言）；加假 onclick → ratchet 拒绝。**变异恢复用文件备份 cp，严禁 git restore / checkout（会回滚整批未提交改动——历史事故）**。
5. lint 本线文件无新增 error/warning（与 HEAD 基线对照）。
6. 不跑全家回归（主助手验收时统一跑）；不更新 `.inline-events-baseline.json`（禁区）。

## 禁区（所有工单）

- `.inline-events-baseline.json`、`test/frontend-inline-events-gate.test.js`、`public/src/modules/action-dispatcher.js`、`public/index.html`
- 不属于本线清单的任何 public/src 文件与 test 文件
- 不 commit / push / 建分支；工作区当前有其他会话的未提交改动（server/、docs/、AGENT.md 等），不要动它们
- 悬置域文件（im-ui、dispatch-*、wg-*、work-group-*、flow-*、home-dashboard、resources-viewer）即使看到内联也不转

## 报告要求

完成后报告：每文件转换处数（与工单预期数对照）、收敛的 window 函数清单与消费面证据、测试改造清单、变异验证结果、未验证项与原因（如浏览器不可达的界面链路）。
