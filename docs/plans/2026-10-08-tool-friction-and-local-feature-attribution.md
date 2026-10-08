# 工具摩擦治理与本地 feature 增补：归属记录

日期：2026-10-08
状态：已实施
关联决策：ADR-0023（工具调用历史改写，仅其通道被复用）

## 为什么有这份文档

2026-10-06 至 10-08 的提交序列里，有几处改动搭随 ADR-0021 / 0022 / 0023 的实施 PR 进入，但自身没有被任何 ADR 或计划裁决。它们实现干净、测试完备，问题只在**归属**：未来按 ADR 回滚会连带撤掉这些未记录的决策，审查也无法从 Spec 轴判定它们是否达成目标。

本文件为这些改动补上决策归属与边界。内容按"实际落地的决策是什么、边界在哪、回滚代价是什么"记录，不重复实现细节。

## 一、edit 撤除读前置守卫（框架 core，提交 `3aec945`）

**决策**：`edit` 不再要求"先读后改"，也不做读后陈旧检测（staleness）。`write` 保留两条守卫。同时匹配侧引入行尾三侧对称归一并收紧转义错位处理。

**证据与边界**：

- 撤除依据是历史会话统计：76% 的 edit 失败源自这两条守卫，且集中在 trim 后的长会话——模型为绕开守卫转向未经审计的 `sed`/`perl` 写操作，安全收益为负。
- 撤除后 edit 的安全边界由**精确匹配 + 唯一性要求**承担：`oldString` 必须唯一命中，多处命中直接报错引导补上下文，不自动选择。错报比错写安全。
- `write` 的守卫不动：它是新建/覆盖文件的主路径，读前置在那里仍有防护价值。
- 转义错位处理改为前置探测（`unescapeEscapedSequences`）：仅当反转义形态在文件中唯一命中时才归一，且对 `oldString` 与 `newString` 同构处理，消除"匹配侧宽容、写入侧原样"的不对称（历史事故：转义形态的 `newString` 把字面反斜杠写进文件）。
- 行尾三侧对称归一（内容 / `oldString` / `newString`）后写回按目标文件行尾风格还原：模型侧 `oldString` 常带 read 输出残留的 `\r`，不归一则 CRLF 文件精确匹配必失败。

**回滚代价**：恢复守卫即恢复"长会话 edit 失败 → 模型转向 shell 写操作"的失效模式；框架侧无需数据迁移。

**测试**：`edit-guards-and-crlf.test.ts`、`edit-escape-normalization.test.ts`、`path-argument.test.ts`（框架 core）。

## 二、新增 `batch_replace` 工具（框架 core，提交 `7f6708a`）

**决策**：为机械式批量改写（import 路径改名、API 改名、重复措辞修正）提供一个受监管的替代品，取代 `sed -i` 循环与一次性 codemod 脚本。

**边界（均为显式设计并落到工具描述）**：

- 默认字面匹配；正则需显式 `regex: true`。
- 文件选择走 glob，永远排除 `node_modules`/`.git`/`dist` 等构建缓存目录，另接受调用方 `exclude`。
- 匹配文件数超过 500 直接拒绝执行，引导收窄 glob——避免一次调用扫全仓库。
- 单文件超过 10MB 跳过；含 NUL 的二进制文件跳过。
- 字面模式下 `\n` `\r\n` `\t` 以字面两字符形态到达且原样零命中时，`find`/`replace` 同构反转义后重试；反转义出的 LF 形态多行 `find` 在 CRLF 文件上零命中时换算为 `\r\n`，替换结果与文件行尾一致。
- 返回逐文件命中数与 diff 摘要（diff 超预算置 `diffTruncated`），改动对模型与审计流同时可见。
- 写后刷新读取状态，避免后续 `write` 的陈旧检查误拒。

**与 ADR-0023 的关系**：`batch_replace` 复用 `withDisplay` 通道给前端传结构化结果，但**不受** `rewritable` / `effectiveCall` 影响——它与调用改写能力无直接关系。此前误按"ADR-0023 附带交付"归类。

**回滚代价**：撤销即回到无受监管的 shell 批量写路径。

**测试**：`batch-replace.test.ts`（框架 core，14 用例）。

## 三、`craft-awareness` 本地 feature（Claw，提交 `f6eba62` / `2013eca` / `35fdb92`）

**决策**：把系统提示词里被稀释的通用写作准则，改为在"模型正在做这件事"的那一刻注入一条聚焦提醒。机制与内容分离：触发判定在代码（`CraftEntry`），注入正文在 `knowledge/<id>.md`。

首个条目 `doc-reader-awareness`：write 写出成规模文档（markdown/txt，默认 ≥30 行）或 edit 编辑此类文件成功后，注入"文档读者视角"写法标准。每会话每条目最多注入一次；冷却状态经框架原生 feature 快照（`captureState` / `restoreState`）随会话持久化，runtime 重启后不重复提醒。

**边界**：注入失败不阻断工具结果，只降级为本轮不注入（observe 语义）。新增素养提醒 = 代码加条目 + `knowledge/` 放对应 md，机制不动。

**测试**：`local-features/craft-awareness/test/`（309 行）。

## 四、`session-reference` 读取预算与翻页（Claw，提交 `9caa79e`）

**决策**：在既有三级读取协议（`session_list` → `session_read_overview` → `session_read_turn`）上补两处可用性增强：

- `read_turn` 单轮正文超预算（`TURN_DETAIL_MAX_CHARS = 40_000`）时首尾各保留一半、中段省略并明示省略字符数——单轮正文的主体常是巨型工具结果，中段是价值最低的部分。
- `session_list` 支持 `offset`，与既有 `limit` 配合翻页。

**边界**：仍为纯读取视图，不落盘任何中间材料；投影复用框架 trim 引擎的纯函数，与会话接续链路共享投影逻辑但不共享任何链路。

**测试**：`local-features/session-reference/test/`。

## 五、输入框统一 slash prompt 提交路径（Claw，提交 `1bcaf7c`）

**决策**：持久输入框与三态输入框的发送按钮此前直接调各自的提交函数，绕过了 slash prompt（挂 pill 的能力激活）的注入路径，导致 prompt 类能力经按钮发送时丢激活。改为统一经 `window.ClawSlash.submitWithPendingPrompts` 提交，能力不可用时回退原提交函数。

**边界**：`submitWithPendingPrompts` 缺席（slash 模块未加载）时回退直连提交，模块可独立移除。

**测试**：`frontend-input-composer.test.js`。

## 后续约束

- 新增功能进入任一 ADR 的实施 PR 序列时，若不属于该 ADR 授权范围，须先在本文件或新 ADR 补归属，再合入。
- 本文件所列决策的边界若被后续改动放宽（如 `batch_replace` 上调 500 文件上限、edit 恢复守卫），须在此更新并说明新依据。
