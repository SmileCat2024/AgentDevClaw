import { checkProtocolModel } from './protocol-model-runner.mjs';
const base = { CarryOpenNotice: false, ProtectOpen: true, FairDelivery: false, Manual: false, LoseNotice: false, LegacyUnattributable: false };
const checks = ['TypeOK', 'NoSilentLoss', 'AtMostOneReissue', 'DeliveredNoticeIsNotDiscovery', 'ManualDoesNotSeedNotice'];
checkProtocolModel('UnresolvedLifecycle', [
  { name: 'retained-and-resolved', constants: base, checks: [...checks, 'ExplicitResolutionStaysClosed'] },
  { name: 'legacy-resolution-reopened', constants: { ...base, LegacyUnattributable: true }, checks: [...checks, 'ExplicitResolutionStaysClosed'], violation: 'ExplicitResolutionStaysClosed' },
  { name: 'second-head-notice-gap', constants: base, checks: [...checks, 'OpenNoticeFollowsHead'], violation: 'OpenNoticeFollowsHead' },
  { name: 'carry-open-current', constants: { ...base, CarryOpenNotice: true }, checks: [...checks, 'OpenNoticeFollowsHead'] },
  { name: 'carry-open-manual-no-model-start', constants: { ...base, CarryOpenNotice: true, Manual: true }, checks },
  { name: 'mutation-prune-open', constants: { ...base, ProtectOpen: false }, checks, violation: 'NoSilentLoss' },
  { name: 'manual-no-model-start', constants: { ...base, Manual: true }, checks },
  { name: 'fair-notice-delivery-control', constants: { ...base, FairDelivery: true }, checks, property: 'EventuallySeen' },
  { name: 'lost-notice-no-rediscovery', constants: { ...base, FairDelivery: true, LoseNotice: true }, checks, property: 'EventuallySeen', temporalFailure: true },
]);
