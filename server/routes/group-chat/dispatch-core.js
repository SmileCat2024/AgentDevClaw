// dispatch-core.js — created by Phase 2 extraction
import path from 'path';
import { promises as fs } from 'fs';

import { GROUP_CHATS_ROOT, VIEWER_ORIGIN, GROUP_CHAT_CALL_TIMEOUT_MS } from '../../shared/constants.js';
import { log } from '../../shared/string-helpers.js';
import { readSessionIndex } from '../../shared/session-access.js';
import { composeDispatchPrompt, aggregateSessionPool, groupByLineage } from './pure-functions.js';
import {
  formatSessionLabel,
  formatCatchUpPrompt,
  composeGroupMemory,
  formatGroupInfoBlock,
  formatGroupMemoryPrompt,
  processAttachmentsForInjection,
  buildGroupDispatchSystemMessage,
} from './format-helpers.js';

export function createDispatchCoreModule(deps) {
  const {
    readGroupChat,
    writeGroupChat,
    appendGroupChatMessage,
    updateMessageRouting,
    listGroupChats,
    collectIdentities,
    requireAgentLight,
    getManagedRuntimeKey,
    getAgentRuntime,
    startManagedAgent,
    waitForManagedRuntimeReady,
    readAnnotations,
    enqueueGcInbox,
    // from session-resolver module
    resolveGroupChatSession,
    ensureAdminRuntime,
    // from awareness module
    buildThreadSituation,
    formatAdminThreadSituation,
  } = deps;

  /**
   * 管理员上下文完整性保证（基础语义）。
   *
   * 这是管理员被唤醒时的唯一上下文准备通道。所有向管理员投递消息的路径
   * —— dispatchToIdentity（直接派发 / execute 模式）、
   *    notifyAdminForActivity（plan 模式动态通知）、
   *    notifyAdminForObservation（plan 模式观察通知）——
   * 都必须经过此函数。
   *
   * 保证三条不变量：
   * 1. catch-up：管理员离开后错过的群聊消息全部补全
   * 2. 群记忆：新 session 时注入历史摘要
   * 3. 水位线：lastActiveAt 在每次调用后正确推进
   *
   * 函数内部读取最新群聊状态（避免调用方传入 stale 对象），计算后写回。
   *
   * @param {string} chatId - 群聊 ID
   * @param {Array}  allIdentities - collectIdentities() 结果（避免重复调用）
   * @param {number} currentMessageTimestamp - 触发本次唤醒的消息时间戳（catch-up 上界）
   * @param {string} currentMessageId - 触发本次唤醒的消息 ID（排除自身）
   * @param {boolean} isNew - 管理员 session 是否为本次新建
   * @param {boolean} [includeCurrentMessage=false] - 是否将触发消息本身纳入 catch-up
   *        （非 @admin 直达场景需要 true，使触发消息内容进入 system-reminder 而非 user 块）
   * @returns {string|null} 合并后的上下文前缀文本（群记忆 + catch-up），无内容时返回 null
   */
  async function prepareAdminContext(chatId, allIdentities, currentMessageTimestamp, currentMessageId, isNew, includeCurrentMessage = false) {
    const identityRef = 'work-group:admin';
    const chat = await readGroupChat(chatId);
    if (!chat) return null;
  
    const sections = [];
  
    // ── 新 session：群聊基本信息 + GROUP.md + 群记忆 ──
    // 这些是静态/半静态背景，只在 session 首次注入，避免每轮重复污染
    if (isNew) {
      // 群聊基本信息
      sections.push(formatGroupInfoBlock(chat));
  
      // GROUP.md
      try {
        const mdPath = path.join(GROUP_CHATS_ROOT, chatId, 'GROUP.md');
        const mdContent = await fs.readFile(mdPath, 'utf-8');
        if (mdContent && mdContent.trim()) {
          sections.push(`─── 群聊背景 ───\n${mdContent}`);
          log('GroupChat', `GROUP.md injected (${mdContent.length} chars) for new admin session`);
        }
      } catch {
        // GROUP.md 不存在或不可读，跳过
      }
  
      // 群记忆（近期消息摘要，标注时间范围）
      const mem = chat.adminMemory || { range: '3d' };
      const range = mem.range || '3d';
      const groupMemory = await composeGroupMemory(chat, range, { includeAnnotations: true, collectIdentities, readAnnotations });
      groupMemory.chatId = chatId;
      const memoryPrompt = formatGroupMemoryPrompt(groupMemory, range);
      if (memoryPrompt) {
        sections.push(memoryPrompt);
        log('GroupChat', `group memory pre-injected for new admin session (${groupMemory.messageCount} messages, range=${range})`);
      }
    }
  
    // ── 每次激活：注入当前工作线程态势 ──
    // 保持原有“两层结构”不变：线程态势属于 system-reminder 中的环境证据，
    // user 块仍只承载真实用户请求或一句事件触发描述。管理员先知道“现在怎样”，
    // 再通过下方 catch-up 理解“刚刚发生了什么”。
    try {
      const situation = await buildThreadSituation(chat, allIdentities);
      sections.push(formatAdminThreadSituation(situation));
    } catch (err) {
      log('GroupChat', `admin thread situation build failed: ${err.message}`, 'warn');
    }
  
    // ── catch-up：补上管理员离开后错过的全部群聊消息（含事件消息）──
    // 首轮（新 session 且无历史水位线）跳过 catch-up，群记忆已覆盖历史
    if (!chat.lastActiveAt) chat.lastActiveAt = {};
    const lastActive = chat.lastActiveAt[identityRef] || 0;
    if (!(isNew && lastActive === 0)) {
      const catchUpMessages = (chat.messages || []).filter(
        (m) => {
          if ((m.timestamp || 0) <= lastActive) return false;
          // includeCurrentMessage=true 时，触发消息本身纳入 catch-up（进入 system-reminder），
          // 使 user 块只需承载事件通知而非原始内容
          if (includeCurrentMessage) return true;
          if ((m.timestamp || 0) >= (currentMessageTimestamp || Date.now())) return false;
          if (m.id === currentMessageId) return false;
          return true;
        }
      );
      if (catchUpMessages.length > 0) {
        // 合并批注到 catch-up 消息（仅管理员注入）
        const annotations = await readAnnotations(chatId);
        if (Object.keys(annotations).length > 0) {
          catchUpMessages.forEach((m) => {
            if (annotations[m.id]) m._annotation = annotations[m.id];
          });
        }
        const catchUpPrompt = formatCatchUpPrompt(catchUpMessages, allIdentities, chatId, chat.name);
        if (catchUpPrompt) {
          sections.push(catchUpPrompt);
          log('GroupChat', `catch-up merged into admin context: ${catchUpMessages.length} messages`);
        }
      }
    }
  
    // ── 推进水位线 ──
    chat.lastActiveAt[identityRef] = currentMessageTimestamp || Date.now();
    await writeGroupChat(chat);
  
    return sections.length > 0 ? sections.join('\n\n') : null;
  }
  
  async function dispatchToIdentity(chatId, message, chat, identityRef, composedPrompt, sessionOptions = {}, opts = {}) {
    const workspaceId = identityRef.split(':')[0];
    log('GroupChat', `dispatching message ${message.id} to ${workspaceId} (${identityRef}) sessionOpts=${JSON.stringify(sessionOptions)}`);
  
    // 1. 解析 identity 的 sessionModel
    const allIdentities = await collectIdentities();
    const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
    const sessionModel = identityInfo?.sessionModel || 'persistent';
  
    // 2. 解析或创建 session（传入 sessionOptions）
    const { sessionId, isNew } = await resolveGroupChatSession(chatId, identityRef, sessionModel, sessionOptions);
    log('GroupChat', `resolved session ${sessionId} (isNew=${isNew}) for ${identityRef}`);
  
    // 3. 找到或启动指定 session 的 runtime
    let runtime = getAgentRuntime(workspaceId, sessionId);
    const isAlive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;
  
    if (!isAlive) {
      try {
        const agent = await requireAgentLight(workspaceId);
        log('GroupChat', `starting agent ${workspaceId} session=${sessionId} for dispatch`);
        await startManagedAgent(agent, sessionId);
        runtime = await waitForManagedRuntimeReady(workspaceId, 30000, sessionId);
        if (!runtime) {
          throw new Error('Agent runtime failed to become ready within 30s');
        }
      } catch (err) {
        log('GroupChat', `failed to start agent: ${err.message}`, 'error');
        await updateMessageRouting(chatId, message.id, {
          status: 'failed',
          error: `Failed to start agent: ${err.message}`,
          completedAt: Date.now(),
        });
        return;
      }
    }
  
    // 4. 确保 runtime ready
    if (!runtime.viewerAgentId) {
      const ready = await waitForManagedRuntimeReady(workspaceId, 15000, sessionId);
      if (!ready?.id) {
        await updateMessageRouting(chatId, message.id, {
          status: 'failed',
          error: 'Agent runtime not ready (no viewerAgentId)',
          completedAt: Date.now(),
        });
        return;
      }
      runtime = getAgentRuntime(workspaceId, sessionId);
    }
  
    const viewerAgentId = runtime?.viewerAgentId;
    if (!viewerAgentId) {
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: 'No viewerAgentId available',
        completedAt: Date.now(),
      });
      return;
    }
  
    // 5. 上下文完整性：
    // - 管理员：catch-up + 群记忆 + GROUP.md + 群聊基本信息
    // - 被派发 agent：群聊 system 上下文块（交代群聊背景、发送者身份、回复可见性）
    // 这些内容通过 contextText 分离传递，bridge 在 CallStart 时注入为 system 消息，
    // 而不是混入用户消息。
    const runtimeKey = getManagedRuntimeKey(workspaceId, sessionId);
  
    let fullPrompt = composedPrompt;
    let contextText = null;
  
    if (identityRef === 'work-group:admin') {
      contextText = await prepareAdminContext(
        chatId, allIdentities,
        message.timestamp || Date.now(), message.id, isNew,
        opts.includeCurrentMessage || false,
      );
      // systemNote 作为 system 层辅助信息注入（如审批拒绝上下文）
      if (opts.systemNote) {
        contextText = contextText ? `${opts.systemNote}\n\n${contextText}` : opts.systemNote;
      }
    } else {
      // 被派发的 agent：注入群聊 system 上下文块
      contextText = buildGroupDispatchSystemMessage(chat, message, allIdentities);
    }
  
    // 6. 通过 gc inbox 投递实际消息（context 通过 contextText 字段分离传递）
    // 附件作为独立字段传递，不再混入用户消息文本
    // 处理附件内容，实现渐进式加载
    const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
    
    enqueueGcInbox(runtimeKey, {
      id: message.id,
      text: fullPrompt,
      contextText,
      gcChatId: chatId,
      gcIdentityRef: identityRef,
      attachments: processedAttachments,
      textInCatchUp: opts.includeCurrentMessage || false,
    });
    log('GroupChat', `message ${message.id} enqueued to gc inbox for ${workspaceId}/${sessionId}`);
  
    // 6. 更新 routing 状态（含 sessionTitle 供 dispatch 卡片展示）
    // 查找 session 标题用于展示
    let resolvedSessionTitle = sessionId;
    try {
      const idx = await readSessionIndex(workspaceId);
      const rec = idx.sessions.find((s) => s.id === sessionId);
      if (rec) resolvedSessionTitle = rec.title || rec.taskTitle || sessionId;
    } catch {}
  
    await updateMessageRouting(chatId, message.id, {
      status: 'delivered',
      targetSessionId: sessionId,
      targetSessionTitle: resolvedSessionTitle,
      dispatchedAt: Date.now(),
    });
  
    // 6.5. 追加"任务已启动"事件卡片（以 agent 身份发送，便于追踪）
    // 管理员自身不需要 task_started 卡片——它是协调者，不是执行者
    // 管理员发起的 dispatch 已经有 dispatch 卡片传达了完整信息，不再追加冗余事件
    if (identityRef !== 'work-group:admin' && message.from !== 'work-group:admin') {
      await appendGroupChatMessage(chatId, {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        from: identityRef,
        text: '',
        kind: 'event',
        event: {
          type: 'task_started',
          identityRef,
          identityName: identityInfo?.displayName || workspaceId,
          sessionId,
          sessionTitle: resolvedSessionTitle,
          workspaceId,
        },
        mentions: [],
        links: [],
        timestamp: Date.now(),
        routing: null,
      });
      log('GroupChat', `event card appended: task_started for ${identityRef} in ${chatId}`);
    }
  
    // 6.6. 规划模式下不再单独通知 task_started 事件
    // plan 模式的通知已在 dispatchGroupChatMessage 的 plan 分支合并投递
    // （notifyAdminWithPrompt 包含了"@了X + X已开始处理"的完整信息）
  
    // 7. 后台跟踪完成状态 + task 完成检测
    trackGroupChatDispatch(chatId, message.id, workspaceId, viewerAgentId, {
      identityRef,
      sessionId,
      sessionTitle: resolvedSessionTitle,
      identityName: identityInfo?.displayName || workspaceId,
    });
  
    return { sessionId, sessionTitle: resolvedSessionTitle, isNew, workspaceId, viewerAgentId };
  }
  
  /**
   * 群聊消息派发入口。
   * 根据群的主动性模式决定路由策略：
   * - assist: 直接派发到目标 agent
   * - plan: 直接派发 + 通知管理员观察
   * - execute: 转发给管理员协调
   */
  async function dispatchGroupChatMessage(chatId, message, sessionOptions = {}) {
    const routing = message.routing;
    if (!routing || !routing.targetWorkspaceId) return;
  
    const chat = await readGroupChat(chatId);
    const chatName = chat?.name || '';
    const initiativeMode = chat?.initiativeMode || 'assist';
    const autonomyMode = chat?.autonomyMode || 'auto';
    const targetIdentityRef = routing.targetIdentityRef;
    const targetIsAdmin = targetIdentityRef === 'work-group:admin';
  
    // @管理员 → 始终直接派发给管理员
    if (targetIsAdmin) {
      const prompt = composeDispatchPrompt(message);
      let opts = {};
      // 拒绝审批派发的消息：附带 systemNote 让管理员理解拒绝上下文
      if (message.rejectDispatchId) {
        const pendingMsg = (chat?.messages || []).find((m) => m.id === message.rejectDispatchId);
        if (pendingMsg) {
          const pTargetRef = pendingMsg.mentions?.[0]?.identityRef || pendingMsg.routing?.targetIdentityRef;
          const pTargetInfo = (await collectIdentities()).find((i) => i.identityRef === pTargetRef);
          const pTargetName = pTargetInfo?.displayName || pTargetRef;
          opts.systemNote = [
            '─── 派发请求被拒绝 ───',
            `被拒绝的派发目标：${pTargetName}（${pTargetRef}）`,
            `被拒绝的派发内容：${(pendingMsg.text || '').slice(0, 300)}`,
            `原派发消息 ID: ${message.rejectDispatchId}`,
          ].join('\n');
        }
      }
      await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions, opts);
      return;
    }
  
    // 管理员发出的派发消息 → 直接到达目标，不再经过模式路由。
    // 否则在 execute 模式下，admin dispatch → 新消息 → 又路由回 admin → 无限循环。
    if (message.from === 'work-group:admin') {
      const prompt = composeDispatchPrompt(message);
      await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
      return;
    }
  
    switch (initiativeMode) {
      case 'execute': {
        // 执行模式：转发给管理员协调
        log('GroupChat', `execute mode: routing to admin for ${message.id}`);
        const allIdentities = await collectIdentities();
        const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
        const targetName = targetInfo?.displayName || targetIdentityRef;
  
        // user 块仅保留事件通知，用户原话由 catch-up（含触发消息）注入 system-reminder
        const coordinatorPrompt = `用户 @了 ${targetName}`;
  
        // 更新 routing 目标为管理员
        await updateMessageRouting(chatId, message.id, {
          targetIdentityRef: 'work-group:admin',
          targetWorkspaceId: 'work-group',
          routedByMode: 'execute',
        });
        await dispatchToIdentity(chatId, message, chat, 'work-group:admin', coordinatorPrompt, {}, { includeCurrentMessage: true });
        break;
      }
  
      case 'plan': {
        // 规划模式：直接派发 + 单一通知管理员
        const prompt = composeDispatchPrompt(message);
        const dispatchResult = await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
  
        // 异步通知管理员（合并：观察 + 任务启动信息，一次 call 搞定）
        const allIdentities = await collectIdentities();
        const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
        const targetName = targetInfo?.displayName || targetIdentityRef;
  
        // user 块：仅保留事件通知，用户原话由 catch-up（含触发消息）注入 system-reminder
        let observationText = `用户 @了 ${targetName}`;
  
        // 附件摘要：显示附件数量和名称
        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
          const attNames = message.attachments.map(a => a.name).join(', ');
          observationText += `  [附件: ${attNames}]`;
        }
  
        // system 层：派发状态，与 gc_dispatch 工具返回的信息丰富度保持一致
        let systemNote;
        if (dispatchResult) {
          const action = dispatchResult.isNew
            ? `已建立新工作「${dispatchResult.sessionTitle}」`
            : `指令已进入已有工作「${dispatchResult.sessionTitle}」`;
          systemNote = [
            '─── 自动派发状态 ───',
            `目标：${targetName}（${targetIdentityRef}）`,
            `操作：${action}`,
            `消息 ID: ${message.id}`,
            `系统已自动将此消息派发给 ${targetName}，你不需要重复派发。`,
          ].join('\n');
        } else {
          systemNote = [
            '─── 自动派发状态 ───',
            `目标：${targetName}（${targetIdentityRef}）`,
            `状态：会话启动可能失败，请关注。`,
            `消息 ID: ${message.id}`,
          ].join('\n');
        }
  
        notifyAdminWithPrompt(chatId, message, chat, observationText, systemNote).catch((err) => {
          log('GroupChat', `admin observation notify failed: ${err.message}`, 'warn');
        });
        break;
      }
  
      case 'assist':
      default: {
        // 辅助模式：直接派发
        const prompt = composeDispatchPrompt(message);
        await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
        break;
      }
    }
  }
  
  /**
   * 统一管理员通知通道：向管理员投递一条自定义 prompt（合并到一次 call）。
   * 内部调用 prepareAdminContext 保证 catch-up + 群记忆完整性。
   * 用于替代 notifyAdminForObservation，避免产生多次碎片化 call。
   */
  async function notifyAdminWithPrompt(chatId, message, chat, promptText, systemNote) {
    const allIdentities = await collectIdentities();
  
    const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
    let runtime;
    try {
      runtime = await ensureAdminRuntime(chatId, sessionId);
    } catch (err) {
      log('GroupChat', `notifyAdminWithPrompt: failed to start runtime: ${err.message}`, 'warn');
      return;
    }
  
    let contextText = await prepareAdminContext(
      chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
    );
  
    // systemNote 作为 system 层辅助信息注入，与 catch-up / 群记忆并列，
    // 避免辅助性内容混入 user 块导致模型困惑。
    if (systemNote) {
      contextText = contextText
        ? `${systemNote}\n\n${contextText}`
        : systemNote;
    }
  
    const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
    // 处理附件内容，实现渐进式加载
    const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
    enqueueGcInbox(runtimeKey, {
      id: `obs-${message.id}`,
      text: promptText,
      contextText,
      gcChatId: chatId,
      gcIdentityRef: 'work-group:admin',
      attachments: processedAttachments,
      textInCatchUp: true,
    });
    log('GroupChat', `notifyAdminWithPrompt enqueued for admin`);
  }
  
  /**
   * 规划模式下，通知管理员观察群内活动。
   * 不创建 routing，只投递一条观察消息到管理员的 gc inbox。
   */
  async function notifyAdminForObservation(chatId, message, chat, targetIdentityRef) {
    const chatName = chat?.name || '';
    const allIdentities = await collectIdentities();
    const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
    const targetName = targetInfo?.displayName || targetIdentityRef;
  
    let observationText = `[观察] 用户 @了 ${targetName}：${message.text || ''}`;
    
    // 附件摘要：显示附件数量和名称
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      const attNames = message.attachments.map(a => a.name).join(', ');
      observationText += `  [附件: ${attNames}]`;
    }
    
    const observationPrompt = [
      observationText,
      '',
      `系统已将此消息派发给 ${targetName}，会话已启动。你不需要重复派发。`,
    ].join('\n');
  
    // 确保管理员 runtime 存在
    const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
    let runtime;
    try {
      runtime = await ensureAdminRuntime(chatId, sessionId);
    } catch (err) {
      log('GroupChat', `admin observation: failed to start runtime: ${err.message}`, 'warn');
      return;
    }
  
    // 上下文完整性：经统一通道补全 catch-up + 群记忆（含触发消息本身）
    const contextText = await prepareAdminContext(
      chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
    );
  
    const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
    // 处理附件内容，实现渐进式加载
    const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
    
    enqueueGcInbox(runtimeKey, {
      id: `obs-${message.id}`,
      text: observationPrompt,
      contextText,
      gcChatId: chatId,
      gcIdentityRef: 'work-group:admin',
      attachments: processedAttachments,
      textInCatchUp: true,
    });
    log('GroupChat', `observation notify enqueued for admin`);
  }
  
  /**
   * 规划模式下，通知管理员观察一般群聊活动（非 @mention 消息）。
   * 用于纯讨论消息、agent 回复等。
   */
  async function notifyAdminForActivity(chatId, message, chat) {
    const chatName = chat?.name || '';
    const allIdentities = await collectIdentities();
    const senderInfo = allIdentities.find((i) => i.identityRef === message.from);
    const senderName = message.from === 'user'
      ? '用户'
      : (senderInfo?.displayName || message.from);
  
    let activityDesc;
    const sessionLabel = formatSessionLabel(message.routing?.targetSessionTitle, message.routing?.targetSessionId);
    if (message.kind === 'event') {
      const evtSession = formatSessionLabel(message.event?.sessionTitle, message.event?.sessionId);
      const evtName = message.event?.identityName || '';
      switch (message.event?.type) {
        case 'task_started':
          activityDesc = `系统事件：${evtName}${evtSession} 已开始处理`;
          break;
        case 'session_interrupted':
          activityDesc = `系统事件：${evtName}${evtSession} 会话已被管理员中断`;
          break;
        case 'agent_offline':
          activityDesc = `系统事件：${evtName}${evtSession} 进程已退出`;
          break;
        case 'session_continued': {
          const reason = message.event?.reason || '';
          const reasonMeanings = {
            trim: '精简历史后已由新上下文接管',
            summary: '摘要交接后已由新上下文接管',
            branch: '已创建新的并行工作线程',
          };
          const meaning = message.event?.threadDisposition === 'new_thread'
            ? '已从历史上下文派生新的并行工作线程'
            : (reasonMeanings[reason] || '当前上下文入口已更新');
          const archiveNote = message.event?.archived ? '，原会话已归档，不再接收新任务' : '';
          const threadTitle = message.event?.threadTitle || message.event?.sessionTitle || '未命名工作';
          activityDesc = `系统事件：${evtName} · 工作线程「${threadTitle}」${meaning}${archiveNote}`;
          break;
        }
        case 'session_archived':
          activityDesc = `系统事件：${evtName}${evtSession} 会话已归档，不再接收新任务`;
          break;
        case 'session_unarchived':
          activityDesc = `系统事件：${evtName}${evtSession} 已取消归档，可以继续接收任务`;
          break;
        case 'task_completed': {
          const taskTitle = message.event?.taskTitle || '';
          const threadTitle = message.event?.threadTitle || message.event?.sessionTitle || '未命名工作';
          activityDesc = `系统事件：${evtName} · 工作线程「${threadTitle}」Task 完成：${taskTitle}`;
          break;
        }
        default:
          activityDesc = `系统事件：${evtName}${evtSession}`;
          break;
      }
    } else if (message.from === 'user') {
      activityDesc = `用户发送了消息`;
    } else {
      activityDesc = `${senderName}${sessionLabel} 回复了`;
    }
  
    // 附件摘要：显示附件数量和名称
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      const attNames = message.attachments.map(a => a.name).join(', ');
      activityDesc += `  [附件: ${attNames}]`;
    }
  
    // user 块仅保留事件通知，原始内容由 catch-up（含触发消息）注入 system-reminder
    const activityPrompt = activityDesc;
  
    // 确保管理员 runtime 存在
    const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
    let runtime;
    try {
      runtime = await ensureAdminRuntime(chatId, sessionId);
    } catch (err) {
      log('GroupChat', `admin activity: failed to start runtime: ${err.message}`, 'warn');
      return;
    }
  
    // 上下文完整性：经统一通道补全 catch-up + 群记忆（含触发消息本身）
    const contextText = await prepareAdminContext(
      chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
    );
  
    const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
    // 处理附件内容，实现渐进式加载
    const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
    
    enqueueGcInbox(runtimeKey, {
      id: `act-${message.id}`,
      text: activityPrompt,
      contextText,
      gcChatId: chatId,
      gcIdentityRef: 'work-group:admin',
      attachments: processedAttachments,
      textInCatchUp: true,
    });
    log('GroupChat', `activity notify enqueued for admin: ${activityDesc.slice(0, 50)}`);
  }
  
  async function findChatsBySessionId(sessionId) {
    const chatList = await listGroupChats();
    const matches = [];
  
    for (const summary of chatList) {
      if (summary.archived) continue;
      const chat = await readGroupChat(summary.id);
      if (!chat) continue;
  
      let foundRef = null;
  
      // Source 1: chat.sessions 映射
      for (const [identityRef, sid] of Object.entries(chat.sessions || {})) {
        if (identityRef === 'work-group:admin') continue;
        if (sid === sessionId) {
          foundRef = identityRef;
          break;
        }
      }
  
      // Source 2: importedSessions
      if (!foundRef && Array.isArray(chat.importedSessions)) {
        for (const imp of chat.importedSessions) {
          if (imp.sessionId === sessionId) {
            foundRef = imp.identityRef || `${imp.workspaceId}:main`;
            break;
          }
        }
      }
  
      // Source 3: 消息 routing
      if (!foundRef) {
        for (const msg of (chat.messages || [])) {
          if (msg.routing?.targetSessionId === sessionId) {
            const ref = msg.routing.targetIdentityRef;
            if (ref && ref !== 'work-group:admin') {
              foundRef = ref;
              break;
            }
          }
        }
      }
  
      if (foundRef) {
        matches.push({ chat, identityRef: foundRef });
      }
    }
  
    return matches;
  }
  
  /**
   * 会话血缘继承：当上下文管理操作（trim/compact/summary/branch）产生新 session 时，
   * 自动将新 session 关联到原 session 所属的群聊，并通知管理员。
   *
   * 核心流程：
   * 1. 反查 fromSessionId 关联的群聊
   * 2. 在群聊中写入血缘记录、更新活跃头部、追加事件消息（原子写入）
   * 3. plan/execute 模式下通知管理员
   *
   * 如果 fromSessionId 不属于任何群聊，静默跳过。
   *
   * @param {object} params
   * @param {string} params.agentId        — workspace ID（如 'programming-helper'），用于解析 session 标题
   * @param {string} params.fromSessionId  — 源 session ID
   * @param {string} params.toSessionId    — 新 session ID
   * @param {string} params.reason         — branch | summary | trim
   * @param {boolean} [params.archived]   — 原会话是否已被归档
   * @param {number} [params.trimCutRounds] — trim 操作精简的轮次数
   */
  async function notifySessionLineage({ agentId, fromSessionId, toSessionId, reason, archived = false, trimCutRounds } = {}) {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  
    const matches = await findChatsBySessionId(fromSessionId);
    if (matches.length === 0) return;
  
    const allIdentities = await collectIdentities();
  
    for (const { chat, identityRef } of matches) {
      try {
        const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
        const identityName = identityInfo?.displayName || identityRef.split(':')[1] || identityRef;
        const workspaceId = identityRef.split(':')[0];
  
        // 读取新 session 和原 session 的标题
        let sessionTitle = null;
        let fromSessionTitle = null;
        try {
          const sessionIndex = await readSessionIndex(workspaceId);
          const toRecord = sessionIndex?.sessions?.find((s) => s.id === toSessionId);
          sessionTitle = toRecord?.title || null;
          const fromRecord = sessionIndex?.sessions?.find((s) => s.id === fromSessionId);
          fromSessionTitle = fromRecord?.title || null;
        } catch {}
  
        // 原子写入：血缘记录 + 活跃头部更新 + 事件消息
        if (!Array.isArray(chat.sessionLineage)) chat.sessionLineage = [];
        chat.sessionLineage.push({
          from: fromSessionId,
          to: toSessionId,
          reason,
          timestamp: Date.now(),
          identityRef,
        });
  
        // 更新活跃头部
        if (!chat.sessions) chat.sessions = {};
        chat.sessions[identityRef] = toSessionId;
  
        // 基于更新后的血缘图解析稳定线程引用。线性 successor 继承原线程引用，
        // branch 或旧节点再派生得到新的引用。事件与管理员/UI 因而指向同一工作。
        let threadRef = null;
        let threadTitle = sessionTitle || fromSessionTitle || null;
        let threadDisposition = 'head_advanced';
        try {
          const projected = await groupByLineage(
            aggregateSessionPool(chat, allIdentities),
            chat.sessionLineage,
            allIdentities,
            undefined,
            { activeSessions: chat.sessions, messages: chat.messages },
          );
          const targetThread = projected.find((thread) => thread.lineageHeadId === toSessionId && thread.identityRef === identityRef);
          if (targetThread) {
            threadRef = targetThread.threadRef;
            threadTitle = targetThread.threadTitle || targetThread.activeHeadTitle || threadTitle;
            if (targetThread.threadRef === `${identityRef}::${toSessionId}`) {
              threadDisposition = 'new_thread';
            }
          }
        } catch {}
  
        // 追加事件消息
        const eventMessage = {
          id: `evt-lineage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chatId: chat.id,
          from: identityRef,
          text: '',
          kind: 'event',
          event: {
            type: 'session_continued',
            identityRef,
            identityName,
            threadRef,
            threadTitle,
            threadDisposition,
            sessionId: toSessionId,
            sessionTitle,
            fromSessionId,
            fromSessionTitle,
            toSessionId,
            reason,
            archived,
            ...(trimCutRounds != null ? { trimCutRounds } : {}),
            workspaceId,
          },
          mentions: [],
          links: [],
          timestamp: Date.now(),
          routing: null,
        };
  
        if (!Array.isArray(chat.messages)) chat.messages = [];
        chat.messages.push(eventMessage);
  
        await writeGroupChat(chat);
        log('GroupChat', `session lineage: ${fromSessionId} → ${toSessionId} (${reason}) in chat ${chat.id}`);
  
        // 不主动唤醒管理员：session lifecycle 事件降级为纯水位线捕获，
        // 仅写入 chat.messages，等下一次管理员因其他原因被唤醒时由 catch-up 自然带入。
      } catch (err) {
        log('GroupChat', `session lineage failed for chat ${chat.id}: ${err.message}`, 'error');
      }
    }
  }
  
  /**
   * 会话归档状态通知：当用户直接归档或取消归档一个会话时，
   * 向关联群聊推送对应事件。
   *
   * 与 notifySessionLineage 的区别：
   * - 不创建新会话，不更新活跃头部
   * - 归档时从活跃头部映射中移除该 session（如果有）
   * - 事件 type 为 session_archived / session_unarchived
   *
   * @param {object} params
   * @param {string} params.agentId        — workspace ID
   * @param {string} params.sessionId      — 被归档的 session ID
   * @param {boolean} params.archived      — true 为归档，false 为取消归档
   */
  async function notifySessionArchived({ agentId, sessionId, archived = true }) {
    if (!sessionId) return;
  
    const matches = await findChatsBySessionId(sessionId);
    if (matches.length === 0) return;
  
    const allIdentities = await collectIdentities();
  
    for (const { chat, identityRef } of matches) {
      try {
        const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
        const identityName = identityInfo?.displayName || identityRef.split(':')[1] || identityRef;
        const workspaceId = identityRef.split(':')[0];
  
        let sessionTitle = null;
        try {
          const sessionIndex = await readSessionIndex(workspaceId);
          const record = sessionIndex?.sessions?.find((s) => s.id === sessionId);
          sessionTitle = record?.title || null;
        } catch {}
  
        // 归档当前入口时移除旧映射；取消归档不强行抢占同身份的当前入口。
        if (archived && chat.sessions && chat.sessions[identityRef] === sessionId) {
          delete chat.sessions[identityRef];
        }
  
        const eventMessage = {
          id: `evt-${archived ? 'archive' : 'unarchive'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chatId: chat.id,
          from: identityRef,
          text: '',
          kind: 'event',
          event: {
            type: archived ? 'session_archived' : 'session_unarchived',
            identityRef,
            identityName,
            sessionId,
            sessionTitle,
            workspaceId,
          },
          mentions: [],
          links: [],
          timestamp: Date.now(),
          routing: null,
        };
  
        if (!Array.isArray(chat.messages)) chat.messages = [];
        chat.messages.push(eventMessage);
  
        await writeGroupChat(chat);
        log('GroupChat', `session ${archived ? 'archived' : 'unarchived'}: ${sessionId} in chat ${chat.id}`);
  
        // 同 notifySessionLineage：不主动唤醒管理员，由 catch-up 自然带入。
      } catch (err) {
        log('GroupChat', `session archive-state notification failed for chat ${chat.id}: ${err.message}`, 'error');
      }
    }
  }
  
  /**
   * 通过 ViewerWorker /running 端点检测 agent 运行状态变化。
   * 当 agent 从 running → idle 时，标记消息为 completed。
   * Agent 回复通过 GroupChatBridgeFeature 的 CallFinish piggyback 写回群聊。
   *
   * Phase 2: 同时轮询 ViewerWorker 的 todo plan，检测新完成的 task，
   * 向关联群聊推送 task_completed 事件。
   *
   * @param {string} chatId
   * @param {string} messageId
   * @param {string} workspaceId
   * @param {string} viewerAgentId
   * @param {{ identityRef: string, sessionId: string, sessionTitle: string, identityName: string }} [sessionInfo]
   */
  function trackGroupChatDispatch(chatId, messageId, workspaceId, viewerAgentId, sessionInfo) {
    let wasRunning = false;
    const startTime = Date.now();
    const TIMEOUT_MS = GROUP_CHAT_CALL_TIMEOUT_MS;
  
    // Phase 2: task 完成检测状态
    const knownCompletedTaskIds = new Set();
    // 先把派发前已经完成的 Task 作为 baseline，避免同一线程再次派发时把旧完成项
    // 全部重新广播。轮询会等待 baseline 尝试结束；失败时仍可继续跟踪本轮变化。
    const taskBaselineReady = seedCompletedTaskBaseline(viewerAgentId, knownCompletedTaskIds);
  
    const interval = setInterval(async () => {
      // 超时保护
      if (Date.now() - startTime > TIMEOUT_MS) {
        clearInterval(interval);
        await updateMessageRouting(chatId, messageId, {
          status: 'failed',
          error: 'Agent call timeout (15min)',
          completedAt: Date.now(),
        });
        return;
      }
  
      try {
        // 检查 runtime 是否还活着
        const runtime = getAgentRuntime(workspaceId);
        if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
          if (wasRunning) {
            // Agent 曾经运行过，现在进程已退出
            clearInterval(interval);
            await updateMessageRouting(chatId, messageId, {
              status: 'completed',
              completedAt: Date.now(),
            });
          }
          return;
        }
  
        // 检查 ViewerWorker 的 running 状态
        const currentViewerId = runtime.viewerAgentId || viewerAgentId;
        const res = await fetch(
          `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(currentViewerId)}/running`
        );
        if (!res.ok) return;
        const data = await res.json();
        const isRunning = data.running === true || data.callActive === true;
  
        if (isRunning) {
          wasRunning = true;
  
          // Phase 2: 轮询 todo plan，检测新完成的 task
          if (sessionInfo) {
            await taskBaselineReady;
            await pollTaskCompletion(chatId, currentViewerId, sessionInfo, knownCompletedTaskIds);
          }
        } else if (wasRunning) {
          // Agent 曾在运行，现在空闲 → 完成
          // 在清除 interval 前做最后一次 task 轮询（agent 刚结束，可能完成了最后一个 task）
          if (sessionInfo) {
            await taskBaselineReady;
            await pollTaskCompletion(chatId, currentViewerId, sessionInfo, knownCompletedTaskIds);
          }
          clearInterval(interval);
          await updateMessageRouting(chatId, messageId, {
            status: 'completed',
            completedAt: Date.now(),
          });
          log('GroupChat', `message ${messageId} completed`);
        }
      } catch {
        // 网络错误等，继续重试
      }
    }, 3000);
  }
  
  async function seedCompletedTaskBaseline(viewerAgentId, knownCompletedTaskIds) {
    if (!viewerAgentId) return;
    try {
      const res = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/todo`);
      if (!res.ok) return;
      const todoPlan = await res.json();
      for (const task of (Array.isArray(todoPlan?.tasks) ? todoPlan.tasks : [])) {
        if (task.status === 'completed') knownCompletedTaskIds.add(String(task.id));
      }
    } catch {}
  }
  
  const _gcEventIdempotencyKeys = new Set();
  
  async function appendUniqueGroupChatEvent(chatId, eventMessage) {
    const key = eventMessage?.event?.idempotencyKey;
    if (!key) {
      await appendGroupChatMessage(chatId, eventMessage);
      return true;
    }
    if (_gcEventIdempotencyKeys.has(key)) return false;
    const chat = await readGroupChat(chatId);
    if ((chat?.messages || []).some((message) => message?.event?.idempotencyKey === key)) {
      _gcEventIdempotencyKeys.add(key);
      return false;
    }
    // 单进程内先占位，避免两个并发 tracker 在文件写入前同时通过检查。
    _gcEventIdempotencyKeys.add(key);
    try {
      await appendGroupChatMessage(chatId, eventMessage);
      return true;
    } catch (error) {
      _gcEventIdempotencyKeys.delete(key);
      throw error;
    }
  }
  
  /**
   * Phase 2: 轮询 ViewerWorker 的 todo plan，检测新完成的 task。
   * 对每个新完成的 task，写入 task_completed 事件并通知管理员。
   *
   * @param {string} chatId
   * @param {string} viewerAgentId
   * @param {{ identityRef: string, sessionId: string, sessionTitle: string, identityName: string }} sessionInfo
   * @param {Set<string>} knownCompletedTaskIds — 已知已完成 task ID 集合（跨轮次保持）
   */
  async function pollTaskCompletion(chatId, viewerAgentId, sessionInfo, knownCompletedTaskIds) {
    try {
      const res = await fetch(
        `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/todo`
      );
      if (!res.ok) return;
      const todoPlan = await res.json();
      const tasks = Array.isArray(todoPlan?.tasks) ? todoPlan.tasks : [];
  
      let owningThread = null;
      try {
        const chat = await readGroupChat(chatId);
        const allIdentities = await collectIdentities();
        const projected = await groupByLineage(
          aggregateSessionPool(chat, allIdentities),
          chat.sessionLineage,
          allIdentities,
          undefined,
          { activeSessions: chat.sessions, messages: chat.messages },
        );
        const candidates = projected.filter((thread) =>
          thread.identityRef === sessionInfo.identityRef
          && (thread.lineageHeadId === sessionInfo.sessionId
            || thread.lineage?.some((node) => node.sessionId === sessionInfo.sessionId))
        );
        owningThread = candidates.find((thread) => thread.lineageHeadId === sessionInfo.sessionId)
          || candidates.find((thread) => thread.isCurrent)
          || candidates[0]
          || null;
      } catch {}
  
      for (const task of tasks) {
        if (task.status !== 'completed') continue;
        const taskId = String(task.id);
        if (knownCompletedTaskIds.has(taskId)) continue;
  
        // 新完成的 task
        knownCompletedTaskIds.add(taskId);
  
        const eventMessage = {
          id: `evt-task-${Date.now()}-${taskId}-${Math.random().toString(36).slice(2, 6)}`,
          chatId,
          from: sessionInfo.identityRef,
          text: '',
          kind: 'event',
          event: {
            type: 'task_completed',
            identityRef: sessionInfo.identityRef,
            identityName: sessionInfo.identityName,
            threadRef: owningThread?.threadRef || null,
            threadTitle: owningThread?.threadTitle || sessionInfo.sessionTitle,
            sessionId: sessionInfo.sessionId,
            sessionTitle: sessionInfo.sessionTitle,
            taskId,
            taskTitle: task.subject || task.description || `Task #${taskId}`,
            idempotencyKey: `task_completed:${sessionInfo.sessionId}:${taskId}`,
            workspaceId: sessionInfo.identityRef.split(':')[0],
          },
          mentions: [],
          links: [],
          timestamp: Date.now(),
          routing: null,
        };
  
        const appended = await appendUniqueGroupChatEvent(chatId, eventMessage);
        if (appended) {
          log('GroupChat', `task_completed event: ${sessionInfo.identityName} completed "${eventMessage.event.taskTitle}"`);
        }
      }
    } catch {
      // 网络错误等，静默跳过
    }
  }

  return {
    prepareAdminContext,
    dispatchToIdentity,
    dispatchGroupChatMessage,
    notifyAdminWithPrompt,
    notifyAdminForObservation,
    notifyAdminForActivity,
    findChatsBySessionId,
    notifySessionLineage,
    notifySessionArchived,
    trackGroupChatDispatch,
    seedCompletedTaskBaseline,
    appendUniqueGroupChatEvent,
    pollTaskCompletion,
  };
}
