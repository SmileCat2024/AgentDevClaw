/**
 * Input Gateway — 用户输入投递的统一线程路由网关
 *
 * 所有「以 runtime 为目标的用户输入」在服务端的必经点。收敛两类调用方：
 *   - 外部直投：Claw 前端 POST /api/agents/:viewerAgentId/user-turn（server.js 代理）
 *   - 内部调用：交互面板提交（ui-surfaces）、未来的 IM 渠道路由
 *
 * 路由规则（R6 队列化：域判定而非窗口判定）：
 *   收件会话是某活跃线程的 head
 *     → Thread Inbox 暂存 + 即时投递尝试。指令的去留时机（hold / 交接
 *       / rotation_failed / runtime 未就绪）由 deliverPendingCommands 在
 *       投递时按客观事实把关，网关不做第二重状态裁决——历史上「fresh
 *       挡板才转 Inbox」的窗口判定会让 hold / failed / closed 态的输入
 *       绕过全部行政检查直投旧 runtime（A11 旁路）。
 *   线程已 close（硬终态）
 *     → 显式拒绝 thread_closed；终态线程的指令入箱只会永久滞留。
 *   收件会话是线程历史成员（非 head）
 *     → 明确拒绝写入 session_not_head；历史 session 只读，调用方应切换
 *       到当前 head。
 *   其余一切情况（无线程 / 非 host / runtime 条目不存在）
 *     → 原样直投 viewer user-turn，行为与未接入线程时完全一致。
 *
 * 「非 head」不在此拦截：那是调用方 UI 上下文的路由问题（前端守卫
 * resolveThreadInputRoute 负责）；网关只拦「线程域归属」这一客观事实。
 *
 * 输入身份（kind）：'reminder'（机器通报）在直投域随 user-turn 契约原样
 * 透传（落地为带 source 的 system 消息，不响应输入租约）；在线程域映射为
 * WorkThread command 的 turn 身份槽位（'user_message' | 'reminder'），投递
 * 时经 bridge.submitTurn 原样转发——身份在直投 / 入箱两条路径都不丢失
 * （ADR-0024 决策 3）。
 *
 * 边界记录（A12 已知窗口）：runtime 条目被删除后（共享进程退出）网关
 * 无法从 viewerAgentId 反查 (agentId, sessionId)——请求体不含会话事实，
 * 只能回退直投，由 submitUserTurn 报出真实的运行时错误。窗口为毫秒级
 * 竞态（successor runtime 注册前），不做请求体接口扩展。
 *
 * IM 渠道（qqbot）当前经 CallArbiter 在 runtime 内路由，不经 viewer
 * user-turn。当 IM 线路绑定指向线程宿主（coder）时，应在 IM 的目标会话
 * 解析处改调本入口，而不是直投 runtime。
 */

import { getRuntimeByViewerAgentId } from '../shared/agent-access.js';
import { submitUserTurn, UserTurnDeliveryError } from '../shared/user-turn.js';
import { getThreadIntegration, isThreadHostSession } from './thread-integration.js';
import { getPhSessionGateInfo } from '../routes/ph-projects.js';

export { UserTurnDeliveryError };

/**
 * 投递一条用户输入。返回值 delivery 字段显式区分三种结果：
 *   - 'delivered' | 'queued' | 'input'：viewer 原生结果（直投成功/排队/槽位）
 *   - 'thread_queued'：已转入 Thread Inbox 暂存（附带 threadId / commandId）
 *
 * @param {object} [deps] 测试注入（生产调用不传，走默认单例）
 * @throws UserTurnDeliveryError 直投失败（网络/校验）、线程已关闭
 *   （thread_closed）或收件会话是历史成员（session_not_head）。
 */
export async function deliverUserInput(
  {
    viewerAgentId,
    text,
    images,
    source,
    sourceRef,
    // 输入身份（'user' 缺省 / 'reminder' 机器通报），随 user-turn 契约流动
    kind,
    capabilityActivations,
    turnMetadata,
  } = {},
  { integration = getThreadIntegration(), fetchImpl = fetch } = {},
) {
  const normalizedViewerId = String(viewerAgentId || '').trim();
  const normalizedText = typeof text === 'string' ? text : '';
  const normalizedImages = Array.isArray(images) ? images : [];
  // 输入身份词汇归一（ADR-0024 决策 3）：'reminder' 原样保留；缺失 / 'user' /
  // 未知值一律归一为普通用户输入——直投域省略 kind（user-turn 契约缺省），
  // 线程域映射为 command kind 'user_message'。归一必须发生在入箱前：
  // appendCommand 对未知 command kind 显式拒绝。
  const isReminder = kind === 'reminder';

  const route = await _resolveThreadRoute(normalizedViewerId, integration);
  if (route.route === 'rejected') {
    throw route.error;
  }
  if (route.route !== 'thread') {
    return submitUserTurn({
      agentId: normalizedViewerId,
      text: normalizedText,
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
      source,
      sourceRef,
      ...(isReminder ? { kind: 'reminder' } : {}),
      ...(Array.isArray(capabilityActivations) ? { capabilityActivations } : {}),
      ...(turnMetadata ? { turnMetadata } : {}),
    }, { fetchImpl });
  }

  return _stageThreadCommand({
    thread: route.thread,
    text: normalizedText,
    images: normalizedImages,
    source,
    sourceRef,
    isReminder,
    capabilityActivations,
    turnMetadata,
  }, integration);
}

/**
 * 线程寻址输入（threadId 为路由事实，ADR-0024 决策 3 的服务端一半）。
 *
 * 与 deliverUserInput 的区别只在「归属怎么证明」：本入口直接以 Thread 记录
 * 作为路由事实，不需要 runtime 反查——接续窗口里旧 head runtime 已退役、
 * 新 head 未 ready，runtime 不存在是**正常状态**，不该让输入无法被接住。
 * 接受性判定（closed / 归档 / 删除中 / PH 归属释放 / 非空校验）与入箱后的
 * 即时投递尝试，两条路径共用 _stageThreadCommand，不出现第二套语义。
 *
 * 送达与否是独立结果（返回 deliveryAttempt），不是接受与否的条件：
 * 未送达的指令留在 Inbox，由既有触发点（runtime ready / head 推进 /
 * 显式 deliver）补投。
 *
 * @param {object} input
 * @param {object} [deps] 测试注入（生产调用不传，走默认单例）
 * @throws UserTurnDeliveryError 线程不存在 / 终态 / 归档 / 删除中 / 参数问题
 */
export async function deliverThreadInput(
  {
    threadId,
    text,
    images,
    source,
    sourceRef,
    kind,
    capabilityActivations,
    turnMetadata,
  } = {},
  { integration = getThreadIntegration() } = {},
) {
  const tid = String(threadId || '').trim();
  if (!tid) {
    throw new UserTurnDeliveryError('threadId is required', {
      code: 'invalid_input',
      status: 400,
      retryable: false,
    });
  }
  const thread = await integration.core.getThread(tid);
  if (!thread) {
    throw new UserTurnDeliveryError(`Thread ${tid} not found`, {
      code: 'thread_not_found',
      status: 404,
      retryable: false,
    });
  }
  const rejection = await _threadAcceptanceVerdict(thread, integration);
  if (rejection) throw rejection;

  return _stageThreadCommand({
    thread,
    text: typeof text === 'string' ? text : '',
    images: Array.isArray(images) ? images : [],
    source,
    sourceRef,
    // 身份词汇归一与 deliverUserInput 同源：'reminder' 保留，其余一律普通用户输入
    isReminder: kind === 'reminder',
    capabilityActivations,
    turnMetadata,
  }, integration);
}

/**
 * 线程接受性判定（客观事实，与投递门禁分离）：线程不存在 / closed /
 * deleting / 归档 / PH 归属释放窗口 → 拒绝；其余入箱。
 *
 * 「非 head」不在本判定内：线程寻址的收件人就是线程自身，head 由记录决定；
 * 「是不是 head 会话」是 runtime 寻址路径才需要判的问题（见 _resolveThreadRoute）。
 *
 * @returns {UserTurnDeliveryError|null} 拒绝原因，可接受返回 null
 */
async function _threadAcceptanceVerdict(thread, integration) {
  // ticket 046：PH 归属释放窗口（项目改绑 / 会话归属移动，会话失效 → 归属
  // 落盘之间）拒绝新输入，杜绝输入落进即将按旧归属保存/执行的旧实例。
  const headSessionId = String(thread?.headSessionId || '').trim();
  const phOwnershipGate = headSessionId ? getPhSessionGateInfo(headSessionId) : null;
  if (phOwnershipGate) {
    return new UserTurnDeliveryError(phOwnershipGate.message, {
      code: phOwnershipGate.code,
      status: 409,
      retryable: false,
    });
  }
  // T005：删除中的线程拒绝新 send（begin 后 / seal 前线程未 closed，
  // 框架 appendCommand 不拒绝——入口层显式拒绝才是第一道门）。
  if (thread?.deleting === true) {
    return new UserTurnDeliveryError('Thread is being deleted: new input is rejected', {
      code: 'thread_deleting',
      status: 409,
      retryable: false,
    });
  }
  // 终态线程禁入：删除事务封存后 head 不变，指令入箱只会在无投递触发的
  // 状态下永久滞留。
  if (thread?.status === 'closed') {
    return new UserTurnDeliveryError(
      'This thread is closed; start a new session to continue the work',
      { code: 'thread_closed', status: 409, retryable: false },
    );
  }
  // T004：归档线程拒绝新 send（判定经 archive 单点，与 commands / deliver /
  // ACP resume 四入口共享同一事实）。
  if (typeof integration.archive?.resolveCommandRejection === 'function') {
    const rejection = await integration.archive.resolveCommandRejection(thread.threadId);
    if (rejection) {
      return new UserTurnDeliveryError(
        'This thread is archived; unarchive it before sending new messages',
        { code: rejection.code, status: rejection.status, retryable: false },
      );
    }
  }
  return null;
}

/**
 * 线程域输入的单一实现：入箱 + 即时投递尝试。
 *
 * deliverUserInput（runtime 寻址）与 deliverThreadInput（线程寻址）都收束到
 * 这里——「接受的判据」「入箱的形状」「投递尝试的时机」只有一份。
 */
async function _stageThreadCommand(
  {
    thread,
    text,
    images,
    source,
    sourceRef,
    isReminder,
    capabilityActivations,
    turnMetadata,
  },
  integration,
) {
  // 与 appendCommand 的 K8 同源：text / images / metadata 至少其一非空
  //（metadata-only 如仅携带会话引用；空文本占位 ' ' 由此放行）
  const hasTurnMetadata = !!(turnMetadata && typeof turnMetadata === 'object'
    && Object.keys(turnMetadata).length > 0);
  if (!String(text || '').trim() && images.length === 0 && !hasTurnMetadata) {
    throw new UserTurnDeliveryError('text or images must be provided', {
      code: 'invalid_input',
      status: 400,
      retryable: false,
    });
  }

  // viewer 方言（ImageInput[] 对象数组）→ command 方言（string[] 路径数组）：
  // 框架 appendCommand 只认字符串成员，对象原样传入会被整体滤成空数组——
  // image-only 输入（空白占位 text）随即触发 K8 空文本拒绝，text + images
  // 场景图片被静默丢弃（PH 线程宿主会话回归，2026-10-28）。缺 path 的对象
  // 成员无法寻址，过滤后重新计数；全滤空按无附件入箱。
  const commandImages = images
    .map((entry) => (typeof entry === 'string' ? entry : String(entry?.path || '').trim()))
    .filter(Boolean);

  const { command, duplicate } = await integration.core.appendCommand({
    threadId: thread.threadId,
    // turn 身份槽位（ADR-0024 决策 3）：reminder 与用户消息同享线程行政
    // 检查（交接窗口暂存而非误投旧 head），投递时经 bridge 原样转发。
    kind: isReminder ? 'reminder' : 'user_message',
    text,
    source: String(source || '').trim() || 'gateway',
    idempotencyKey: sourceRef ? `gw-${sourceRef}` : '',
    // 来源侧引用（ADR-0031 步骤一）：携带 sourceRef 的输入进入线程域后换得
    // 新 commandId，原始事件引用随指令记录持久化。宿主观察者结合来源、
    // metadata 中的工作引用与 pendingWakeups 关联等待关系；事件引用本身
    // 不是后台工作 ID。框架只透传不解释。
    ...(sourceRef ? { originSourceRef: sourceRef } : {}),
    ...(commandImages.length > 0 ? { images: commandImages } : {}),
    ...(Array.isArray(capabilityActivations) ? { capabilityActivations } : {}),
    // Thread Inbox command 契约携带 user-turn 自由元数据：随指令持久化，
    // 投递时经 bridge.submitTurn 原样转发（消费方如 session-reference 引用
    // 在线程域与直投域行为一致）
    ...(hasTurnMetadata ? { metadata: turnMetadata } : {}),
  });
  // 幂等命中既有指令时新 payload 不生效（appendCommand 契约）：携带的
  // metadata 若与已入箱值不同则留痕，重放方可见差异而非静默吞掉
  if (duplicate && hasTurnMetadata) {
    const existingMeta = command?.metadata ?? null;
    if (JSON.stringify(existingMeta) !== JSON.stringify(turnMetadata)) {
      console.warn('[input-gateway] duplicate command carries different turn metadata; existing entry wins:', {
        threadId: thread.threadId,
        commandId: command?.commandId,
      });
    }
  }

  // 竞态闭合：路由判定与 append 之间 succession 可能已完成（advanceHead
  // 已清挡板、applySessionSuccession 已投递过一轮）——补一次投递尝试。
  // 交接仍在进行时它被 deliver 序列的客观检查拦下（no-op），已完成时
  // 正好把刚落入的指令当场送达，不留无触发点的 pending。
  let deliveryAttempt = null;
  if (!duplicate && typeof integration.tryDeliver === 'function') {
    deliveryAttempt = await integration.tryDeliver(thread.threadId);
  }

  return {
    success: true,
    delivery: 'thread_queued',
    threadId: thread.threadId,
    commandId: command.commandId,
    duplicate,
    ...(deliveryAttempt ? { deliveryAttempt } : {}),
  };
}

/**
 * 反查 runtime 归属并判定线程域归属。
 *   - { route:'thread', thread }：活跃线程的 head——指令入箱；
 *   - { route:'rejected', error }：终态线程（closed）或历史成员——显式拒绝；
 *   - { route:'direct' }：其余一切（无线程 / 非 host / 条目不存在）——直投。
 * 网关的介入必须以确定的事实为前提；线程域内不做第二重状态裁决（R6）。
 *
 * runtime 寻址独有的判定只有「非 head」一项（收件会话是历史分片）；其余
 * 拒绝事实（删除中 / closed / 归档）与线程寻址路径共用 _threadAcceptanceVerdict。
 */
async function _resolveThreadRoute(viewerAgentId, integration) {
  if (!viewerAgentId) return { route: 'direct' };
  const runtime = getRuntimeByViewerAgentId(viewerAgentId);
  const agentId = String(runtime?.agentId || '').trim();
  const sessionId = String(runtime?.selectedSessionId || '').trim();
  // ticket 046：PH 归属释放窗口（项目改绑 / 会话归属移动，会话失效 → 归属
  // 落盘之间）拒绝新输入，杜绝输入落进即将按旧归属保存/执行的旧实例。窗口
  // 结束后 viewer 会话已移除，后续输入由 submitUserTurn 以 404/409 响亮失败
  // 并触发前端刷新。无窗口进行中时短路返回（空表零成本），网关热路径不付出
  // 查询开销。code/message 取自窗口事实（改绑 ph_project_rebind_in_progress /
  // 移动 ph_sessions_move_in_progress）。
  //
  // 本判定在归属反查之前：纯会话（无线程）的 PH 输入同样受该窗口保护。
  const phOwnershipGate = sessionId ? getPhSessionGateInfo(sessionId) : null;
  if (phOwnershipGate) {
    throw new UserTurnDeliveryError(
      phOwnershipGate.message,
      { code: phOwnershipGate.code, status: 409, retryable: false },
    );
  }
  if (!agentId || !sessionId || !isThreadHostSession(agentId)) {
    return { route: 'direct' };
  }

  let thread = await integration.core.findThreadByHeadSession(agentId, sessionId);
  if (!thread && typeof integration.findThreadBySession === 'function') {
    thread = await integration.findThreadBySession(agentId, sessionId);
  }
  if (!thread) return { route: 'direct' };

  // 非 head Session 仍可查看，但不能把新输入写入历史分片；不要静默转投
  // 当前 head，避免用户误以为自己仍在编辑历史现场。
  if (thread.headSessionId !== sessionId) {
    return {
      route: 'rejected',
      error: new UserTurnDeliveryError(
        'Historical thread sessions are read-only; open the current head session to continue',
        { code: 'session_not_head', status: 409, retryable: false },
      ),
    };
  }

  const rejection = await _threadAcceptanceVerdict(thread, integration);
  if (rejection) return { route: 'rejected', error: rejection };

  return { route: 'thread', thread };
}
