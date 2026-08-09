/**
 * IM Bridge — extracted from run-prebuilt-agent.js (L308-577).
 *
 * Handles two concerns:
 *  1. IM result delivery via callfinish — mirrors completed call results
 *     to the active IM channel when the call originated from a non-IM source.
 *  2. IM Line Carrier mount — dynamically mounts/unmounts carrier features
 *     (QQBot / WeixinBot) on a running agent when an IM line is bound.
 *
 * The factory receives a mutable context object whose `agent` and
 * `callArbiter` properties are populated later by the main runtime.
 */

import { getIMSourceValues, getIMChannel } from '../server/shared/im-channels.js';

const IM_REPLY_POLICY = {
  /**
   * IM sources that already handle their own reply — skip callfinish delivery.
   * Derived from the channel registry so it stays in sync automatically.
   */
  IM_SOURCES: getIMSourceValues(),
  /** Maximum character length for IM result delivery before truncation */
  MAX_IM_RESULT_LENGTH: 1500,
  /** Maximum length for error messages sent to IM */
  MAX_IM_ERROR_LENGTH: 500,
};

/**
 * Truncate text for IM delivery, adding an ellipsis indicator.
 */
function truncateForIM(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n...(结果已截断，完整内容请查看调试面板)';
}

/**
 * @param {object} ctx - mutable runtime context
 * @param {string} ctx.agentId
 * @param {string|null} ctx.sessionId
 * @param {boolean} ctx.IS_EXPLORATION
 * @param {string} ctx.SERVER_ORIGIN
 * @param {object|null} ctx.agent - set during main()
 * @param {object|null} ctx.callArbiter - set during main()
 */
export function createIMBridge(ctx) {
  let _mountedCarrierFeature = null; // tracks currently mounted carrier name

  // ── IM result delivery via callfinish ──────────────────────────────
  //
  // When a call completes via the arbiter, this dispatcher decides whether
  // the result should be mirrored to the active IM channel.
  //
  // Rules:
  //  - IM-originated calls (source=qq|weixin): the Feature's own gateway
  //    adapter already handles the reply — do NOT double-send.
  //  - Non-IM-originated calls (dispatch, viewer-input, system):
  //    deliver result to IM if the runtime has an active IM channel
  //    and at least one prior IM peer is known.

  /**
   * Dispatch a completed call envelope's result to IM.
   * Called from the callFinished listener.
   *
   * @param {object} envelope - The finished envelope from CallArbiter
   */
  async function dispatchIMCallFinish(envelope) {
    const agent = ctx.agent;
    if (!agent || typeof agent.sendIMMessage !== 'function') {
      return;
    }

    // Skip IM-originated calls — the Feature adapter handles its own reply.
    if (IM_REPLY_POLICY.IM_SOURCES.has(envelope.source)) {
      return;
    }

    const channel = typeof agent.getActiveIMChannel === 'function'
      ? agent.getActiveIMChannel()
      : null;

    if (!channel) {
      return;
    }

    // Determine result text
    let resultText = '';

    if (envelope.status === 'failed') {
      const errorText = envelope.error || '未知错误';
      resultText = `⚠ 调用失败: ${truncateForIM(errorText, IM_REPLY_POLICY.MAX_IM_ERROR_LENGTH)}`;
    } else if (envelope.status === 'completed') {
      const raw = envelope.result || '';
      if (!raw) {
        // Successful but empty result — skip IM notification for success with no content
        return;
      }
      resultText = truncateForIM(raw, IM_REPLY_POLICY.MAX_IM_RESULT_LENGTH);
    } else {
      return;
    }

    try {
      const delivered = await agent.sendIMMessage(resultText);
      if (delivered) {
        console.log(`[IM-CallFinish] delivered result to ${channel} (source=${envelope.source}, status=${envelope.status})`);
      } else {
        console.warn(`[IM-CallFinish] skipped result delivery to ${channel} (source=${envelope.source})`);
      }
    } catch (err) {
      console.error('[IM-CallFinish] failed to deliver result to IM:', err);
    }
  }

  // ── IM Transfer: Dynamic feature injection/removal ──────────────────
  //
  // Manages dynamic IM feature injection into the current runtime.
  // Triggered by IPC messages from server.js when a channel is transferred
  // to or disconnected from this runtime's session.

  // ── IM Line Carrier Mount ──────────────────────────────────────────
  //
  // When a line is bound to this session, the carrier feature (QQBotFeature
  // or WeixinBot) is dynamically mounted on THIS agent. The gateway receives
  // IM messages and routes them through the CallArbiter for serialization.
  //
  // Carrier features do NOT use agentdev hooks or tools — they only provide
  // a gateway that calls agentRef.onCall(text). This makes dynamic mounting
  // safe even after the agent is already running.

  /**
   * Dynamically mount a carrier feature on this running agent.
   * Works because carrier features only provide a gateway (no hooks/tools).
   */
  async function mountCarrierFeature(carrier) {
    const agent = ctx.agent;
    if (!agent || ctx.IS_EXPLORATION) return;

    if (_mountedCarrierFeature === carrier) {
      console.log(`[IM-Line] Carrier "${carrier}" already mounted, skipping`);
      return;
    }

    try {
      console.log(`[IM-Line] Mounting carrier="${carrier}" dynamically...`);

      const ch = getIMChannel(carrier);
      if (!ch) {
        console.error(`[IM-Line] Unknown carrier: "${carrier}"`);
        return;
      }

      const mod = await import(ch.packageName);
      const CarrierClass = mod[ch.exportName];

      // ── Config loading ──
      let feature;
      if (ch.configEnv === null) {
        // QQ loads config from server API
        const cfgResp = await fetch(`${ctx.SERVER_ORIGIN}/protoclaw/qqbot_config`);
        const qqCfg = cfgResp.ok ? await cfgResp.json() : {};
        feature = new CarrierClass({
          appId: qqCfg?.appId || '',
          clientSecret: qqCfg?.clientSecret || '',
          configPath: qqCfg?.configPath || '',
          accountId: qqCfg?.accountId || '',
          markdownSupport: qqCfg?.markdownSupport ?? true,
        });
      } else {
        feature = new CarrierClass({
          configPath: process.env[ch.configEnv] || '',
        });
      }

      await agent.mountFeature(feature);
      await feature.startGateway(agent);

      // ── Message routing through CallArbiter ──
      if (ctx.callArbiter) {
        if (ch.messageMode === 'handleMessage') {
          // Weixin: override handleMessage (uses weixin-specific API client)
          const { WeixinApiClient } = mod;
          feature.handleMessage = async (msg) => {
            if (!msg || msg.message_type !== 1) return;
            const text = WeixinApiClient.extractText(msg);
            if (!text) return;

            // 设置 WeixinBot 的 turn context，使 @CallStart 和 upload_attachment 工具生效
            feature._currentTurnCtx = {
              fromUserId: msg.from_user_id,
              contextToken: msg.context_token,
            };
            feature._pendingMedia = [];

            try {
              const entry = ctx.callArbiter.enqueue({
                source: ch.id,
                sourceRef: msg.from_user_id || '',
                text,
              });
              const finished = await ctx.callArbiter.waitForCompletion(entry.id);
              const resp = finished.status === 'failed' || finished.status === 'cancelled'
                ? `处理失败: ${finished.error || '未知错误'}`
                : (finished.result || '处理完成');
              if (resp) {
                await feature.apiClient.sendTextMessage(msg.from_user_id, resp, msg.context_token);
              }
              // flush 所有待发送的媒体附件
              await feature.flushPendingMedia();
            } finally {
              feature._currentTurnCtx = null;
              feature._pendingMedia = [];
            }
          };
        } else {
          // QQ/Feishu/Wecom: use agentRef.onCall
          feature.agentRef = {
            onCall: async (text) => {
              const entry = ctx.callArbiter.enqueue({ source: ch.id, text });
              const finished = await ctx.callArbiter.waitForCompletion(entry.id);
              if (finished.status === 'failed' || finished.status === 'cancelled') {
                throw new Error(finished.error || 'unknown error');
              }
              return finished.result || '处理完成';
            },
          };
        }
      }

      _mountedCarrierFeature = carrier;
      console.log(`[IM-Line] ✓ ${ch.label} dynamically mounted + gateway started`);
    } catch (err) {
      console.error(`[IM-Line] Failed to mount carrier "${carrier}":`, err);
    }
  }

  /**
   * Check at startup if this session is bound to an IM line.
   */
  async function mountIMLineCarrierIfBound() {
    if (!ctx.sessionId || ctx.IS_EXPLORATION) return;

    try {
      const resp = await fetch(`${ctx.SERVER_ORIGIN}/protoclaw/im_line_binding?agentId=${ctx.agentId}&sessionId=${ctx.sessionId}`);
      if (!resp.ok) return;
      const binding = await resp.json();
      if (!binding?.carrier) return;
      console.log(`[IM-Line] Startup binding found: carrier="${binding.carrier}"`);
      await mountCarrierFeature(binding.carrier);
    } catch (err) {
      console.error('[IM-Line] Failed to check startup binding:', err);
    }
  }

  /**
   * Handle an IPC message for this session's IM bridge.
   * Called by the central IPC dispatcher (not registered on process directly).
   */
  function handleIPCMessage(msg) {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'mount-im-carrier' && msg.carrier) {
        console.log(`[IM-Line] IPC received: mount carrier "${msg.carrier}"`);
        mountCarrierFeature(msg.carrier).catch(err => {
          console.error('[IM-Line] Dynamic mount failed:', err);
        });
      } else if (msg.type === 'unmount-im-carrier') {
        console.log('[IM-Line] IPC received: unmount carrier');
        if (!_mountedCarrierFeature) return;
        const carrier = _mountedCarrierFeature;
        try {
          const featureName = getIMChannel(carrier)?.featureName || '';
          const agent = ctx.agent;
          if (typeof agent?.removeFeature === 'function') {
            agent.removeFeature(featureName);
          } else {
            // fallback: 手动清理工具和 feature
            const feature = agent?.features?.get?.(featureName);
            if (feature && typeof feature.onDestroy === 'function') {
              feature.onDestroy({ agent }).catch(err => {
                console.warn(`[IM-Line] onDestroy error for ${featureName}:`, err.message);
              });
            }
            agent?.features?.delete?.(featureName);
          }
          _mountedCarrierFeature = null;
          console.log(`[IM-Line] ✓ Carrier "${carrier}" unmounted and gateway stopped`);
        } catch (err) {
          console.error(`[IM-Line] Unmount error for "${carrier}":`, err);
        }
      } else if (msg.type === 'todo-control') {
        // 设置/取消 TODO 中断目标
        const todoFeature = ctx.agent?.features?.get?.('todo');
        if (todoFeature && typeof todoFeature.setInterruptTarget === 'function') {
          todoFeature.setInterruptTarget(msg.taskId || null);
        } else {
          console.warn('[IPC] Todo feature not found or does not support setInterruptTarget');
        }
      }
  }

  return {
    dispatchIMCallFinish,
    mountCarrierFeature,
    mountIMLineCarrierIfBound,
    handleIPCMessage,
  };
}
