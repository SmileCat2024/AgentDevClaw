# ADR-0055: 插件数据面子进程化——plugin-host 进程模型与 IPC 安全

日期：2026-11-21
状态：Accepted（2026-11-21 实施落地：24 项数据面测试通过，agentero 0.3.2 隔离实例端到端回归通过）
关联：[ADR-0045](0045-external-plugin-package-and-workspace-assembly.md)（本篇修订其"server 面在主进程内执行"的信任模型段落）、
[ADR-0052](0052-plugin-model-and-mental-model.md)（数据面对象模型与生命周期矩阵）、
[ADR-0037](0037-runtime-execution-environment-unification.md)（平台持有进程裁决权的既有先例）、
[ADR-0027](0027-agent-os-consent-governance-and-runtime-quota.md)（治理面的后续会师点）

## 背景

数据面（插件包 server 面，`/protoclaw/plugin/<prefix>/*`）当前的执行模型：挂载器在
server.js 主进程内 `await import()` 插件的 `server/index.js`，把其 `registerRoutes`
注册的路由函数直接挂进 Express——插件 handler 是宿主进程内的普通函数，持有真实的
req/res 对象，无序列化边界。

这是 ADR-0045 的显式信任决策（"server 面与工具面同级信任，当作本机代码"），但三面
的隔离程度因此严重不均：工具面有 per-runtime 进程隔离，数据面与 UI 面（另案）为零
隔离。风险不对称集中在数据面：第三方代码与全部会话数据、配置文件、其他插件共享同
一进程与事件循环——同步阻塞一次即卡死整个 Claw 服务，一个插件的内存泄漏拖垮全部
工作空间。宿主已有的防护（路由路径校验、prefix 全局唯一、digest guard、连续异常
熔断）全部是进程内逻辑层，挡不住崩溃类故障。

成品化定位要求补齐 OS 隐喻的第三件套（进程模型与包管理已有，权限模型缺失），数据
面出进程是其中风险最不对称、且业界模式最成熟的一步：VSCode Extension Host
（子进程 + 显式注册接口 + 父进程持有裁决权，运行多年）与 MCP stdio server（数据面
逻辑跑独立进程、宿主经 stdin/stdout 通信）同构，本篇为照图纸施工，非新发明。

## 决策

### 1. 数据面迁入统一 plugin-host 子进程

server.js 以 `fork` 拉起唯一的 plugin-host 子进程，所有装配插件的数据面代码在
其中执行；宿主只保留一层薄代理（HTTP 路由 → IPC 转发）。选统一进程而非每插件一
进程：隔离目标先是"插件执行与宿主服务"的分离（崩溃/泄漏/阻塞不再影响 server），
插件互相之间暂不隔离，与 VSCode 全扩展共享一个 Extension Host 同构；结构上按包
分进程保留演进空间，不在本篇承诺。

### 2. 宿主侧收口：digest 校验、配置合成、路由匹配不离开主进程

代理层在转发前完成三件事：digest guard（沿用 settingsDigest 校验）、配置四层
合成（`getConfig(req)` 语义保持"每请求现读"，做法改为宿主每请求合成后随消息下发
快照）、路由匹配（宿主确定"哪个包、哪个相对子路径"后才下发）。插件进程因此拿不到
配置文件路径、配置树读取能力，也无法构造对其他插件路由或宿主接口的请求——收权
点即安全点。

### 3. 插件契约零改动

`registerRoutes(router, context)` 形态原样保留：plugin-host 内的适配层构造同款
router（get/post/put/delete、相对路径校验）与 context（`getConfig(req)` 返回随
请求下发的快照），插件源码（如 agentero）与 manifest 均不修改。契约的兼容性由
适配层测试钉住。

### 4. IPC 通道与消息协议：无私网、无鉴权协议，安全在白名单

- **通道**：Node 父子 IPC（`process.send`）。内核保证父子私有，不存在网络暴露面，
  因此不发明握手或 token 协议；plugin-host 禁止监听任何 TCP/Unix 端口（写入契约：
  子进程宿主代码不出现 `net.createServer`）。未来若远程化（plugin-host 跑在另一台
  机器）再引入 WebSocket + 随机 token，随机性即凭证（VSCode `createRandomIPCHandle`
  同哲学），不在本篇。
- **消息**：白名单类型（`http-request` / `http-response` / `chunk` / `log` /
  `ready` / `shutdown` / `cancel`），宿主与子进程两侧同款校验，未知类型丢弃并记日志；每个
  请求带单调 requestId 关联 + 超时（30s，超时回 504 并以 `cancel` 消息通知子进程放弃该请求）；二进制
  （如 PDF）走 Buffer 分块消息（requestId 关联的 `chunk` 序列 + end），不做整体缓冲。
- **能力面**：反向调用（子进程 → 宿主）白名单当前为空（仅 log）。将来新增任何
  能力必须显式注册为命名接口并单独过 ADR（VSCode RPCProtocol `set(identifier)`
  显式注册表的对位：没给的接口不可达，能力收窄不靠鉴权靠"没有"）。
- **边界声明**：插件代码与 plugin-host 宿主层同进程，IPC 引用由宿主层持有、
  不暴露给插件对象，但这只是软边界——威胁模型是"信任的插件出 bug"，不是"恶意
  插件主动刺探"；硬边界由进程级权限（`--permission`，见"后续"）承接。

### 5. 生命周期：宿主持有进程裁决权

spawn 预启动（装配/服务启动时，不让冷启动延迟落在用户首次点开面板上）；关闭走
shutdown 消息 + 宽限期优雅退出，exit 后仍存活的僵尸强杀（VSCode issue #194477
教训：exit 事件不等于真退出）；崩溃指数退避自动重启，连续崩溃对齐既有包级熔断
语义回 503。**remount（装配/导入/删除/层编辑触发的重建）= 预启新进程、就绪后
原子切换、再回收旧进程**——数据面在装配变化期间保持可用，消除服务窗口；顺带
天然规避 ESM import 缓存导致的子进程内换版不生效问题。plugin-server-bus 的
dirty 信号链与消费方不变，仅 remount 的执行体从"进程内重挂"换成"换进程"。

## 对上层的影响

- 前端协议、manifest 契约、插件源码：零变化。
- 错误形态：插件异常从进程内 500 堆栈变为超时 / 503 / 子进程崩溃重启，错误分类
  与观测方式随之变化；plugin-host 的 stdout/stderr 收进宿主日志域（claw-logger），
  IPC 侧增加每类消息计数与慢请求日志。
- remount 期间数据面无服务窗口（预启切换设计下对用户不可见，但测试需覆盖切换
  瞬间在途请求的处置）。
- 既有数据面测试的驱动方式从进程内调用改为走代理，需适配；新增子进程崩溃恢复、
  超时、跨进程 digest 校验、分块流式用例。

## 后续会师（不在本篇范围）

进程级硬边界：Node 20+ `--permission` 模型（`--allow-fs-read=<声明目录>`、禁
child_process）把"数据面只能读自己声明的目录"从约定变成系统级强制——它是插件
manifest 权限声明（安装时授权面）的执行机制，两线在彼处合流；先验证 win32 兼容性。

## 实施步骤

全部落地（2026-11-21）：

1. plugin-host 子进程宿主脚本（`server/feature-runtime/plugin-host/plugin-host-child.js`）：
   mounts 清单装载、逐包 import、本地路由表、router/context 适配层、IPC 请求循环；
2. 宿主侧管理器与代理层（`plugin-host-manager.js` + `plugin-server.js` 改造）：digest 校验、
   配置合成下发、请求转发、超时、崩溃处理，熔断语义移入子进程适配层保持；
3. remount 预启新进程 + 原子切换 + 旧进程宽限回收（`replacePluginHost`）；
4. 测试：既有 18 项全过（契约零变化），新增 6 项（子进程隔离事实 / 崩溃退避恢复 /
   超时 504 / 分块流式 / removeHeader 透传 / POST body）；
5. agentero 0.3.2 端到端回归（隔离实例）：导入装配、四层配置合成、digest guard、
   sqlite 查询、PDF 流式、kill plugin-host 后 0.5s 内自动恢复，全部实测通过。
