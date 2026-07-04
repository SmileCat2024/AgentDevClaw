/**
 * IM Channel Registry — single source of truth for all IM channel metadata.
 *
 * Every place that needs to know "what channels exist" should import from here
 * instead of hardcoding channel IDs, labels, or feature names.
 *
 * To add a new IM channel: add one entry to IM_CHANNELS below.
 */

// ── Channel definitions ──────────────────────────────────────────

export const IM_CHANNELS = Object.freeze([
  {
    id: 'qq',
    label: 'QQ',
    featureName: 'qqbot',
    packageName: '@agentdev/qqbot-feature',
    exportName: 'QQBotFeature',
    configEnv: null,           // QQ loads config from server API, not env var
    messageMode: 'onCall',     // uses feature.agentRef.onCall for CallArbiter routing
  },
  {
    id: 'weixin',
    label: '微信',
    featureName: 'weixin-bot',
    packageName: '@agentdev/weixin-bot',
    exportName: 'WeixinBot',
    configEnv: 'PROTOCLAW_WEIXIN_CONFIG_PATH',
    messageMode: 'handleMessage', // overrides feature.handleMessage for CallArbiter routing
  },
  {
    id: 'feishu',
    label: '飞书',
    featureName: 'feishu-bot',
    packageName: '@agentdev/feishu-bot',
    exportName: 'FeishuBot',
    configEnv: 'PROTOCLAW_FEISHU_CONFIG_PATH',
    messageMode: 'onCall',
  },
  {
    id: 'wecom',
    label: '企业微信',
    featureName: 'wecom-bot',
    packageName: '@agentdev/wecom-bot',
    exportName: 'WecomBot',
    configEnv: 'PROTOCLAW_WECOM_CONFIG_PATH',
    messageMode: 'onCall',
  },
]);

// ── Derived lookup structures ────────────────────────────────────

const _byId = new Map(IM_CHANNELS.map((ch) => [ch.id, ch]));

/**
 * Ordered list of channel IDs.
 * @returns {string[]}
 */
export function getIMChannelIds() {
  return IM_CHANNELS.map((ch) => ch.id);
}

/**
 * The first channel ID, used as a fallback default when no channel is selected.
 * @returns {string}
 */
export function getDefaultIMChannelId() {
  return IM_CHANNELS[0]?.id || '';
}

/**
 * Look up a channel definition by its ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getIMChannel(id) {
  return _byId.get(id);
}

/**
 * Get the display label for a channel ID.
 * @param {string} id
 * @returns {string} Label, or the raw id if unknown, or '' if falsy
 */
export function getIMChannelLabel(id) {
  if (!id) return '';
  return _byId.get(id)?.label || id;
}

/**
 * Set of all channel IDs, used to check whether an envelope source
 * originated from an IM channel (and thus the adapter already handled
 * the reply — dispatchIMCallFinish should skip it).
 *
 * @returns {Set<string>}
 */
export function getIMSourceValues() {
  return new Set(IM_CHANNELS.map((ch) => ch.id));
}
