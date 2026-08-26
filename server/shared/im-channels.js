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
    packageName: '@agentdevjs/qqbot-feature',
    exportName: 'QQBotFeature',
    configEnv: null,           // QQ loads config from server API, not env var
    messageMode: 'onCall',     // uses feature.agentRef.onCall for CallArbiter routing
    category: 'primary',
  },
  {
    id: 'weixin',
    label: '微信',
    featureName: 'weixin-bot',
    packageName: '@agentdevjs/weixin-bot',
    exportName: 'WeixinBot',
    configEnv: 'PROTOCLAW_WEIXIN_CONFIG_PATH',
    messageMode: 'handleMessage', // overrides feature.handleMessage for CallArbiter routing
    category: 'primary',
  },
  {
    id: 'feishu',
    label: '飞书',
    featureName: 'feishu-bot',
    packageName: '@agentdevjs/feishu-bot',
    exportName: 'FeishuBot',
    configEnv: 'PROTOCLAW_FEISHU_CONFIG_PATH',
    messageMode: 'onCall',
    category: 'primary',
  },
  {
    id: 'wecom',
    label: '企业微信',
    featureName: 'wecom-bot',
    packageName: '@agentdevjs/wecom-bot',
    exportName: 'WecomBot',
    configEnv: 'PROTOCLAW_WECOM_CONFIG_PATH',
    messageMode: 'onCall',
    category: 'primary',
  },
  {
    id: 'rokid',
    label: 'Rokid 眼镜',
    featureName: 'rokid-bot',
    packageName: '@agentdevjs/rokid-bot',
    exportName: 'RokidBot',
    configEnv: 'PROTOCLAW_ROKID_CONFIG_PATH',
    messageMode: 'onCall',
    category: 'secondary',
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
 * Channels in the 'primary' category — shown directly in the IM config UI.
 * Useful when a frontend wants to render a compact primary list and tuck
 * new/experimental channels under a "more" fold.
 * @returns {object[]}
 */
export function getPrimaryIMChannels() {
  return IM_CHANNELS.filter((ch) => (ch.category || 'primary') === 'primary');
}

/**
 * Channels in the 'secondary' category — shown under a "more" fold in the UI.
 * @returns {object[]}
 */
export function getSecondaryIMChannels() {
  return IM_CHANNELS.filter((ch) => ch.category === 'secondary');
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
