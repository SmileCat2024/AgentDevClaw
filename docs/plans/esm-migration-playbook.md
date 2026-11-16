# ESM 迁移配方（前端 classic → ESM · 批次工单共用）

> 本文档是给派发工单的转换规范（plan P0.3）。工单 = 本配方 + 本批文件清单 + 特殊说明（本批 domain 命名、预期转换处数、豁免项、显式授权的例外行），转换规则一律以本文档为准，工单不重复配方内容。
>
> 上位依据：[2026-11-16-frontend-esm-strangler-migration.md](2026-11-16-frontend-esm-strangler-migration.md)（机制规格、阶段划分、验收口径的唯一权威）、[ADR-0051](../adr/0051-frontend-esm-strangler-migration.md)（决策 D1–D5，与本配方冲突时以上两者为准并报告）。
>
> 实现权威：桥机制 `public/src/modules/kernel-state.js` + 契约测试 `test/kernel-bridge.test.js`（`defineKey` / `claim` / `stats()` 的最终语义，含 claim 初值语义——本配方只引用不复制）；测试装载 `test/helpers/esm-module-loader.js`；桥债口径 `test/kernel-bridge-debt-gate.test.js`。
>
> 适用范围：P1 内核域抽取与 P2 长尾批次的每一次域转换。禁区见第四节，工单不得越界。

## 目标

把本批文件从 classic-script 全局共享模式转换为原生 ESM：显式 import/export、状态唯一 owner、迁移期内未转换消费方经 window 访问器桥读写语义完全不变（搬代码不改行为，D4）。每批收工时：本批文件脱离 window 台账、桥键注册数净值不升、目标测试全部迁移到真实 import 路线。

## 一、转换步骤

按步 1–7 顺序执行（步 7 只产出移交清单，不改文件）；**步 1 动手前必须先完成第二节的时序审计**，审计结论进报告。每步给出自查方式。

### 步 1 域文件 → ESM（export 化）

- 原位转换：文件路径、文件名、既有函数名与键名全部不变（重命名是另一张工单的事）。
- 跨文件键（函数、常量、状态）全部改为命名 `export`；仅本文件使用的辅助函数/常量保持模块私有，不导出。
- `import` 相对路径必须带 `.js` 扩展名（浏览器原生 ESM 与 Node 真实 import 均要求）。
- 只做移动与导出化，不改任何逻辑与文案；模板里对全局函数的字符串引用（内联事件残留）不转——那是已收尾的 inline-events 迁移线，不在本配方改动面。
- 自查：`node --check public/src/modules/<文件>.js` 逐个通过（仓库根 `type: module`，按 ESM 语法校验，classic 与 ESM 文件都适用）；对照消费面清单确认没有漏导出的跨文件键。

### 步 2 状态迁入哑存储桶 + KernelState.defineKey

用第二节的消费面结论给每个键分类：

- 消费面为零的键 → 收敛为模块私有（模块作用域 `const`/`let`），不注册、不上桥。
- 有未转换消费方的键 → **桥键**。桥键统一经 `KernelState.defineKey(domain, key, initialValue)` 注册，状态键与函数键同制（只读的函数也是键，初值为函数引用）。禁止散装 `Object.defineProperty` 造访问器、禁止散装 `window.X = ...` 造桥——台账与桥债两本口径都收不进，claim 转发语义也拿不到。
- `domain` 命名以工单特殊说明为准（P0.8 域清单定案）；工单未给时用「域文件名去扩展名」并在报告注明。
- `initialValue` = 原声明初值；原声明带初始化副作用（如 DOM 查询）的，在注册处等价重建。
- 唯一注册制：同一键只在一处注册；window 键名全名唯一，跨域同名同样抛错（契约测试钉住）。
- 注册相位（注册行放在哪、何时执行）由时序审计判定：该键在 classic 相（加载期顶层 / boot 微任务窗口）无触达点 → 注册行放域模块顶层（ESM 相执行）；存在 classic 相触达点而需要 classic 相注册 → 触线，按第二节处理路径报告（工单不改 kernel-state.js、不改 index.html）。
- 自查：`grep -c "KernelState.defineKey(" <本批文件>` 与报告的桥键清单行数一致。

### 步 3 函数内对外全局引用改为经桥或 import

对本批文件内引用的每个外来键，按目标现状三选一：

1. 目标已 ESM（有命名导出）→ `import { x } from './x.js'`。
2. 目标在 window 上可达 → 显式 `window.X(...)`，行尾注释标注定义域与预计收敛批次（如 `// 桥接期：定义于 app-core（编排域收敛时移除）`）。window 可达形态：已上桥的键、classic 顶层 `function` 声明、`var` 声明、`window.*` 赋值。
3. 目标是仍 classic 的顶层 `let`/`const`/`class` 词法绑定（未上桥）→ **转换阻断**：ESM 里裸标识符虽能沿全局词法环境解析到它，但那是门禁看不见的债务（禁止保留）；显式 `window.X` 又取不到词法绑定。停下报告主助手并附引用证据，处理路径由主助手定（定义方提前进本批 / 先桥接该键 / 调整批次顺序）。工单特殊说明显式列为「允许裸引用续命的过渡键」的除外——必须带 `// TODO(esm-migration): 经桥收敛于 <域>` 注释。

- 自查：转完跑步 5 的 grep，本批文件对外来键的裸引用零命中（豁免清单除外）。

### 步 4 ESM 域模块装载时 KernelState.claim

- 域模块顶层（紧跟本域注册行之后）一次性 claim 本域全部键；claim 无 unclaim，不回头。
- 生产代码不 import kernel-state.js：它由 index.html 的 classic 标签先于一切域模块加载，模块内直接用 `window.KernelState`（测试里的预挂方式见第三节）。
- impl 样板（模块内状态 = 终局形态的雏形）：

```js
const state = {}; // 本域唯一真相源；域内逻辑直读直写，不再经 window
window.KernelState.claim('<domain>', {
  get: (key) => state[key],
  set: (key, value) => { state[key] = value; },
});
```

- claim 初值语义（吸收式：认领时哑存储现值经 impl.set 一次性推入域模块，所有权完整转移）以 kernel-state.js 头注释与 `test/kernel-bridge.test.js` 为准，本配方不复述。
- claim 之后：域模块自身代码对本域键直读写模块状态；`window.<键>` 访问器只服务未迁移的 classic 消费方；已转换消费方一律走 import。
- 自查：claim 的 domain 与步 2 注册 domain 一致；本批测试里「认领后双向转发」用例通过。

### 步 5 消费方清单核对（grep 消费面 + 写点清单审计）

对本批每个键（含函数键）执行：

```bash
grep -rnw '<键名>' public/ test/ --include='*.js'
```

排除定义文件后逐条命中分类：裸读 / 裸写 / 显式 `window.<键>` / 字符串假阳性（模板字符串、data-action 名、注释、同名局部变量——逐行人工核对）。每键结论三选一并进报告：

1. 全部消费方已 import → 桥键注销：删除对应 `defineKey` 调用。注册行位置决定操作方式——注册行在本批清单文件内 → 直接删；注册行在本批清单外的文件（典型：P1 已转换的内核域模块，本批转换其最后一个消费方时触发）→ 报告主助手并附归零证据，由主助手定处理方式（把该文件的注销行纳入工单授权，或验收时处理），工单不擅改；classic 相注册行在 kernel-state.js → 同走报告。注销口径以 `test/kernel-bridge-debt-gate.test.js` 头注释为准（删 defineKey 调用 + `delete window.<key>`）。
2. 存在未转换消费方 → 桥键保留，列出消费方清单（这就是消费面证据）。
3. 零消费面 → 键收敛为模块私有，确认其从台账消失（步 6 核对）。

写点清单（谁赋值、赋什么类型、什么时相）已在第二节产出，此处对表核对 setter 语义无特例：原始值、DOM 引用、Map/Set 引用都要能经 `set(key, value)` 原样转发。

### 步 6 台账修剪

- 工单内运行 `npm run check:frontend-globals`（**不带** `--update-baseline`）：
  - 「新增全局状态」必须为零；
  - 「存量键已消失」清单必须与本批预期消失键一致（本批转换文件从台账整体消失或按桥键清单部分消失），逐条对表；偏差即漏改。
- `--update-baseline` 与全部基线文件属禁区（见第四节）→ 修剪在验收时由主助手执行；工单报告给出净下降数（state X 键 / behavior Y 键）。

### 步 7 装载接线登记（移交项，工单不执行）

- `public/index.html` 与 script-tags gate 属禁区：classic 标签的移除与 `<script type="module">` 入口的添加由主助手验收时接线。
- 工单在报告交付接线清单：每个转换文件一行——建议删除的 classic 标签（原位置）、module 入口建议位置（原位替换）、该文件 import 的其他模块相对路径（供装载排序参考）。
- 接线完成前浏览器端到端处于「预期不工作」状态——记入未验证项，不算本批失败。

## 二、时序审计（R1–R4 + S，每批动手前强制）

背景因果（plan「桥机制规格」）：classic 顶层代码先于 deferred ESM 执行；`app-main.js` 的 boot 是 async IIFE，首轮调用发生在 boot 微任务窗口，同样早于 deferred ESM。因此**任何被 classic 代码同步触达的状态与函数，都不能先于其调用方变成 ESM**——「异步就安全」的直觉不成立。

审计产出物（进报告）：一张「键 × 触达点」表，每行：键名、定义文件、读写点清单（文件 + 位置：顶层 / boot 窗口 / 事件回调）、赋值形态（原始值 / DOM 引用 / Map/Set / 函数 / null 重置）、触线结论与处理路径。

先盘键清单：本批每个文件的顶层声明与 `window.*` 赋值（check:frontend-globals 同款分层口径），逐键跑步 5 的消费面 grep，然后逐条过以下规则：

### R1 classic 文件顶层对内核键的调用

- 审计：仍 classic 的文件里，函数体**外**直接调用/读写的本域键（grep 命中行看缩进与所在函数判定；顶层 IIFE 视同顶层；拿不准按触线保守处理）。
- 触线处理：该键保持 classic 定义，本批不转；域模块经 `window.<键>` 显式转调并注释；待调用方完成转换的批次收敛注销。

### R2 boot 微任务窗口触达

- 审计：grep `app-main.js` 的 boot async IIFE 首轮同步调用链（历史已知触达键：`loadAgents`、`loadFeatureTemplateMap`、`waitForViewerReady`——以当前源码重新 grep 为准，不背快照）。本域键出现在该链上 → 同 R1 触线。

### R3 DOM 引用类键

- 识别：键值来自 DOM 查询（getElementById / querySelector 类）。
- 处理：这类键由 classic 在加载/boot 相赋值，哑存储天然承接（classic 相注册时写值落哑存储，claim 吸收）；若审计判定可走 ESM 相注册，初值用等价重建查询（deferred 执行时 DOM 已就绪）。初值无法幂等重建且已有 classic 相写点 → 触线报告。

### R4 ESM 首次执行时机与 module 入口

- 本文件转 ESM 后，其顶层语句的执行时相从「加载序」变为「首个 import 它的模块执行时」（deferred）。
- 审计：逐条盘点被转换文件的顶层语句（立即执行的初始化、addEventListener 注册、依赖加载序的语句），判断从加载相延迟到模块执行相是否等价。
- 触线处理：不等价的顶层语句 → 停下报告（处理路径：维持该文件 classic / 主助手调整装载方案；工单不得自行改 index.html）。等价的 → 进步 7 接线清单；gate 登记由主助手按 P0.5 规则处理。

### S 附加审计：sloppy → strict（展开项）

ESM 文件永远是 strict 模式，无 `'use strict'` 的 classic 文件是 sloppy——转换即 strict 化，属行为面变化，必须显式审计：

- `grep -n "'use strict'" <文件>` 无命中的文件视为 sloppy，排查三类 sloppy 依赖：未声明变量的赋值（隐式全局）、对只读属性的静默失败赋值、`with` 语句（`grep -n "with ("`）；另查顶层 `this` 引用（classic 顶层 `this` 是 window，ESM 顶层是 undefined）与函数体内裸 `this` 的非方法调用形态。
- 触线处理：发现 sloppy 依赖 → 停下报告（消除依赖属行为修正，须主助手单独裁定，不得在本批顺手修）。

触线不阻断本批其余键的转换：触线键按各处理路径保持 classic，其余键照常推进。

## 三、测试改造

三套装载路线分工（`test/helpers/esm-module-loader.js` 头注释为权威）：

- `esm-module-loader`（真实 import）：模块全局裸引用面 ⊆ window/document 桩面——**本批默认路线**。
- `load-esm-plugin`（`test/helpers/load-esm-plugin.js`，沙箱源码变换）：模块裸引用超出 window/document 桩面、需在沙箱注入面解析任意宿主全局时用。
- `frontend-vm`（`ctx.loadSource`）：classic script 专用——本批转换文件不再可用。

### 找装载方（系统性 grep，不按文件名猜）

```bash
grep -rln "modules/<模块名>.js" test/*.test.js
```

历史上名字不含模块名的测试装载过模块，必须系统性找；命中的测试文件全部进本批改造清单。

### 真实 import 路线（默认）

loader API（以 helper 实现为准）：

- `installBrowserStubs({ window, document }?)` → 返回 `cleanup()`。在 globalThis 装最小 window + document 桩；两张覆盖表浅覆盖（值 `=== undefined` 表示从桩上删除该键，模拟能力缺席）；cleanup 恢复调用前的全局（含「原本没有 window / document」的情形）。
- `loadModuleOnce(relativePath, { window, document, installGlobals }?)` → `Promise<{ module, cleanup }>`。真实动态 import 仓库内文件，`relativePath` 相对仓库根（如 `'public/src/modules/<域>.js'`）；每次调用以唯一 query 绕开 Node ESM 模块缓存，拿全新实例——**模块级状态不跨调用共享**；默认自动装桩，调用方已自装时传 `installGlobals: false`（此时忽略 window/document 覆盖表，返回的 cleanup 为无操作，全局归调用方清理）；import 失败自动恢复全局再抛。

骨架（域模块 + 桥）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

test('本域 claim 后双向转发', async () => {
  const cleanup = installBrowserStubs();
  try {
    await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
    const { module } = await loadModuleOnce('public/src/modules/<域>.js', { installGlobals: false });
    assert.equal(typeof module.<导出名>, 'function');
    window.<桥键> = <值>;                      // classic 写方 → setter 转发
    assert.equal(module.<读状态导出>(), <值>); // 经模块状态读回
  } finally {
    cleanup();
  }
});
```

改造规则：

- 断言从全局函数直调改为 import 后调用（`module.<导出>`）——ESM 的真实调用路径是导入值，不是 window。
- 同一用例内多次操作复用同一次 `loadModuleOnce` 返回的 `module` 引用；需要重置模块状态就重新 load（唯一 query 语义保证拿到全新实例）。
- 域模块 import 的其他已转换模块沿 import 链真实执行并各自 claim——桩面按整条链核对，cleanup 在 finally / after() 里执行（AGENT.md 测试规则：restore 全局补丁）。
- 「未迁移 classic 消费方经桥读写语义不变」由 `test/kernel-bridge.test.js` 钉住，本批测试不重复。
- 测试格式沿用仓库统一口径：node:test + node:assert/strict，不引入新框架；测试文件位置与命名不变。

### load-esm-plugin 路线（例外）

判据：模块源码的全局裸引用面超出 `installBrowserStubs` 的桩面（如 localStorage、CustomEvent 等桩上没有的全局）→ 用 load-esm-plugin 沙箱变换，把缺失的宿主全局注入沙箱注入面。用此路线的文件逐个在报告注明原因；能收窄到桩面内的，优先改回真实 import 路线。

### 阻断

本批文件的既有 vm 沙箱测试必须全部迁移完才能收工：classic `loadSource` 对 `export` 语法直接 SyntaxError，留着必碎。

## 四、禁区（所有工单）

- 悬置域文件：`wg-*`、`work-group-*`、`im-ui.js` / `im-actions.js`、`dispatch-ui.js` / `dispatch-actions.js`、`flow-editor.js`、`home-dashboard.js`、`resources-viewer.js`——即使看到问题也不转。
- `public/src/modules/kernel-state.js`（classic 相注册/注销需求走报告规则；仅工单特殊说明显式授权的注册行可改，授权范围外仍禁改）。
- `public/src/modules/action-dispatcher.js`、`public/index.html`。
- 全部 ratchet 基线文件：`.frontend-globals-baseline.json`、`.inline-events-baseline.json`、`.import-cycles-baseline.json`、`.kernel-bridge-baseline.json`、`.script-tags-baseline.json`（`KERNEL_BRIDGE_UPDATE_BASELINE=1` 写基线同属主助手权限）。
- gate 测试：`test/frontend-script-tags-gate.test.js`、`test/check-frontend-globals.test.js`、`test/kernel-bridge-debt-gate.test.js`、`test/kernel-bridge.test.js`（桥契约不属于批次范围）。
- 不属于本批清单的任何 public/src 文件与 test 文件。
- 不 commit / push / 建分支；工作区其他未提交改动（server/、docs/、AGENT.md 等）不碰。

### 变异恢复纪律

变异验证需要临时改坏文件时：先 `cp <文件> <仓库根>/.mig-tmp/<文件名>.bak`，改坏 → 跑 → 从备份 `cp` 回 → `diff` 确认还原 → 收尾删除 `.mig-tmp`。**严禁用 git restore / git checkout 恢复——会回滚整批未提交改动（历史事故）**。备份不得放进 public/，文件名不得以 .js 结尾（防被门禁扫描与静态服务误拾）。

## 五、验证要求（每批收工前逐条执行）

1. **语法**：`node --check` 本批全部改动文件（转换后模块 + 测试文件）逐个通过。
2. **目标测试**：本批迁移后的测试逐个全绿——`npm run test:file -- test/<迁移的测试文件>.test.js`；装载仍 classic 相邻文件的其他受影响测试重跑确认不碎。
3. **全量回归**：`npm run test:core` 跑一遍。除桥债 gate 一条断言外必须全绿：`test/kernel-bridge-debt-gate.test.js` 的 **claimed 断言红是预期**（每转换一个含桥键的域 +1 次 claim，基线未上调）——如实记入报告；**registered 断言红是真失败信号**（新增注册未抵平），停下报告主助手。全绿终审由主助手验收时上调基线后确认。
4. **台账修剪核对**：`npm run check:frontend-globals`（不带 --update-baseline）——新增 state 为零、消失键清单与本批预期一致；报告给出净下降数（state X / behavior Y）。
5. **桥债净值不升**：报告本批 `defineKey` 注册与注销逐键清单，注册净值 ≤ 0（新增注册必须有批内注销抵平）；做不到 → 停下报告主助手，不得硬闯。claimed 变化按第 3 条口径处理。
6. **变异抽查** ≥ 2 项，至少覆盖「接口面」与「claim/桥语义」两类，验证门禁抓得到：
   - 接口面：删/改一个命名导出 → 本批测试 import 侧报 `does not provide an export named`（预期红点：SyntaxError 行）。
   - claim 语义：把 impl.set 改成空函数 → 「认领后 classic 写方转发」断言红（预期红点：该断言）。
   - 桥键注册：注释一行 defineKey → 跑仍装载 classic 消费方的沙箱测试（若本批涉及）→ 消费方裸读红；无可达 catcher → 如实记未验证。
   - 台账回归：把一个已收敛键改回顶层声明 → `check:frontend-globals` 报新增 state 且 exit 1。
   - 注意区分两种红：变异验证的预期断言红 vs 基线未更新造成的 ratchet 红——报告写明看哪条断言/哪段输出。恢复按第四节备份纪律。

## 六、报告要求

完成后逐项报告：

1. **每文件转换处数**：export 化处数、引用改写处数（import / `window.X` 分列）、`defineKey` / `claim` 位置；与工单预期数对照，偏差要解释。
2. **桥键挂载/注销清单与消费面证据**：逐键列出 domain:key、initialValue、注册相位、消费面 grep 命中分类摘要；注销键附归零证据。
3. **时序审计结论表与接线清单**：第二节产出的「键 × 触达点」表；步 7 的 index.html 接线清单（删哪些 classic 标签、module 入口建议位置）。
4. **测试改造清单**：改造文件、每文件装载路线（真实 import / load-esm-plugin 及原因）、断言改写要点。
5. **变异验证结果**：逐项变异、预期失败点、实际输出摘要、还原确认（diff 干净）。
6. **未验证项与原因**：浏览器端到端（index.html 接线属主助手权限）、其余如实列——未验证就说未验证，已有失败不得写成通过。
