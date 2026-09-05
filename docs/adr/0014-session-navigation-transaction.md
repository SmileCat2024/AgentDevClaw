# ADR-0014 — 会话导航事务：导航生命周期的统一封装

- 状态：Proposed
- 日期：2026-09-06

## 问题：导航是散装的

前端所有"把用户带到一个会话/视图"的路径，是在半年里逐事故修补出来的。
每条路径各自组合了身份解析、等待、切换、守卫、loading、失败呈现，没有共享
的骨架。具体表现为六类重复与漂移（2026-09-06 全量盘点）：

### 1. 等待 runtime 就绪的实现有四种

| 实现 | 使用方 |
|---|---|
| `waitForTargetRuntimeSession(agentId, sessionId, attempts)` | session-mutation |
| `waitForPrebuiltRuntimeSession(agentId)` | prebuilt start |
| `RemoteConnections.waitForRuntimeForSession(sessionId, attempts)` | 远程 activate/create/trim/compact |
| 手写 20 × 500ms 轮询 `get_connected_agents` | ctx-menu restart |

语义相同（"等 runtime 出现在列表里"），实现各自演化。ctx-menu restart 的
手写轮询每 500ms 拉一次全量 agent 列表（P0-2 优化前是 3.5MB/次），是性能
优化的漏网之鱼。

### 2. 切换调用混用

同一个语义（"等待完成 → 切换视图"），远程 create 走 `requestSwitch`
（经 pending slot，最新者胜 + setTimeout(0) 窗口守卫），远程 compact 却
直接 `switchAgent`（无 slot、无串行化）。前者正确，后者在快速连续操作时
没有保护。

### 3. 守卫语义混用，靠手工复制维护

`_navigationGuardEpoch` 比较模式（`const _navGuard = epoch; ...await...;
if (_navGuard !== epoch) return;`）在 **9 个文件出现 25+ 次**。其中混入了
两种不同语义：

- "用户是否又点了别处"（导航守卫本意）；
- "用户是否仍在源 runtime 视图"（mutation 替换场景的
  `sourceRuntimeId` 检查，仅 session-mutation 有）。

第四轮导航 bug（新会话不自动进入）的根源正是把宿主快照的
`runtime_session_id`（资源投影）当"用户所在视图"传给了后者。守卫本身没错，
错在每次手工组装时没有类型系统或结构强制区分这两种身份。

### 4. 身份解析重复

- `result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId
  || result?.agent?.id` fallback 链在 6+ 处重复；
- child runtime → `parent_id` 宿主解析在 ctx-menu 的 restart/stop/
  archive 三动作 + ctx-menu-handlers 两处手写。2026-09-06 的"关闭会话
  无反应"bug 正是其中一处漏配（stop 漏了 child 分支，服务端静默 no-op）。

### 5. loading 管理不一致

`beginChatLoadingSession()` 有的入口调（trim/branch/open），有的不调
（restart、远程 create）。不调的入口在慢启动时视图悬空在旧内容上。

### 6. 失败呈现随手写

`window.alert`（trim/compact/create）、`ClawToast`（compact 成功路径）、
`showAgentStartError`（prebuilt start）、静默 console.warn
（`navigateToSessionMutationTarget` 返回 false 时用户无任何反馈）。

## 方案：NavigationHandle 导航事务

不是把六套守卫合并成一个 epoch（它们保护不同边界，合并不可行），而是引入
**导航事务对象**，把"声明意图 → 解析身份 → 等待就绪 → 提交切换 → 收尾"
的完整生命周期封装为一个句柄，守卫成为事务的内置属性而非调用点手工组装。

```js
const tx = beginNavigation({
  intent: 'open-session',        // 语义标签：日志、失败呈现分派
  hostAgentId: 'programming-helper',  // 宿主身份（本地 id 或远程命名空间 id）
  sessionId: targetSessionId,    // 目标会话；空 = 视图级导航
  sourceRuntimeId,               // 可选：用户发起时所在 runtime 视图
  waitFor: 'local-runtime',      // 'none' | 'local-runtime' | 'remote-runtime'
  loading: 'chat-surface',       // 事务期间持有的 loading 面（可空）
  onFail: 'toast',               // intent 注册的默认失败呈现，可覆盖
});

const runtimeRef = await tx.resolveRuntime();  // 统一四种等待实现
if (runtimeRef && tx.stillValid()) {           // 统一守卫
  await tx.commitSwitch(runtimeRef);           // 统一切换（最新者胜）
}
tx.settle(outcome);  // 'ok' | 'aborted' | 'failed' — loading/operation/失败呈现收尾
```

### 设计决策

**守卫成为事务属性**。`stillValid()` 内部检查三件事：导航 epoch 未变
（用户没点别处）、`sourceRuntimeId` 若声明则仍为当前视图（用户没离开源）、
目标 session/runtime 未被更新的事务取代。第四轮 bug 那类"传错身份"从
"每次调用点手工组装"变为"事务构造时一次声明"。

**commitSwitch 统一走 requestSwitch 语义**（pending slot + 最新者胜）。
`switchAgent` 保留为 L0 同步切换（用户直接点击）与事务 commit 的底层实现。
直接 `switchAgent` 的 B 类调用点（远程 compact 等）收编后自然获得串行保护。

**等待原语收敛为一个 resolveRuntime**。本地（child/prebuilt 扫描）、远程
（命名空间目录轮询）作为策略实现注入；ctx-menu restart 的手写轮询消亡，
改走 `get_connected_agents` 增量或 runtime_status 探测。

**身份解析收敛为 resolveNavigationIdentity**。child→parent、runtime
fallback 链、远程命名空间解析集中一处；ctx-menu 三动作共享同一解析。

**失败呈现按 intent 注册**。`beginNavigation` 的 intent 对应默认呈现
策略（mutation → toast；用户点击 → inline 错误卡；后台 → 仅日志），
调用点可覆盖。静默失败不再可能出现。

**与悬置工作空间隔离**。assembly-actions 的三处入口保留现状不收编
（悬置区域不引入新复杂度）。

### 不做的事

- 不把六套守卫合并成一个 epoch——sessionViewToken 保护视图提交、
  sidebarMutationEpoch 保护乐观投影合并、switchEpoch 保护切换后的数据
  载入，边界不同，全部保留为底层机制，事务只是它们的组合者。
- 不新建状态机库或 Promise 编排层——事务是普通对象 + 现有原语组合，
  保持可单独调用、可渐进收编。
- 不改服务端契约——本 ADR 是前端壳层内部结构收敛。

## 迁移顺序（风险递增，每阶段可独立验收）

1. **Phase 1 — 等待原语收敛**：`resolveRuntime` 落地，吸收四种等待实现；
   ctx-menu restart 手写轮询改调统一原语。纯收敛，行为不变。
   验收：等待实现数 = 1；restart 路径测试绿。
2. **Phase 2 — 身份解析收敛**：`resolveNavigationIdentity` 落地，ctx-menu
   三动作 + mutation 路径改调。验收：`parent_id ||` 手写解析 = 0 处。
3. **Phase 3 — 会话 mutation 入口收编**：create/open/trim/branch/compact
   五入口改为声明式事务调用。验收：五入口的 `_navGuard` 手写比较清零。
4. **Phase 4 — 其余入口收编**：远程 activate/create、stop 后继、通知点击、
   焦点恢复。验收：`_navigationGuardEpoch` 的模块外引用 → 0（成为事务
   内部实现细节）。
5. **Phase 5 — 清理**：删除收编后无调用方的旧等待函数与散装守卫代码。

每阶段跑既有回归（frontend-ctx-menu-items / frontend-poll-session-
consistency / sidebar-operations / frontend-core-helpers），行为不变的
阶段以"日志序列不变"为验收基线。

## Considered Options

- **维持现状 + 每次事故修补**：过去半年的模式。每个 bug 修完都要在 25+
  处守卫比较里找同类隐患（本次盘点已发现远程 compact 缺串行保护、
  restart 缺 loading 两处未爆雷的漂移）。成本随入口数线性增长，rejected。
- **全量重写导航层（大爆炸）**：一次性替换所有入口。风险不可控——导航是
  最高频用户路径，任何回归都是 P0。rejected。
- **仅统一守卫（只做 epoch 封装）**：不动等待与身份解析。守卫 bug 会减少，
  但四种等待、身份漂移、失败呈现的重复仍在，下一轮事故只是换个位置。
  作为独立步骤被 Phase 1-4 包含，不单独立项。

## 关联

- ADR-0010 侧栏统一投影：本 ADR 处理投影之外的导航行为层。
- ADR-0011/0012 远程写适配与历史呈现：远程命名空间身份解析是
  resolveNavigationIdentity 的一部分。
- `docs/frontend-rendering-patterns.md` §"会话切换与异步渲染不变量"：
  三条不变量（getRuntimeContextKey 只作 cache key、乐观渲染先行、
  runtimeId 优先寻址）全部保留，事务在其上封装。
