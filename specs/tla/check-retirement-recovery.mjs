import { checkProtocolModel } from './protocol-model-runner.mjs';
const base = { StopBeforeCommit: false, RecoverRegistration: true, FairRecovery: false, StopFails: false };
const checks = ['TypeOK', 'CommittedHeadSurvivesCrash', 'ReadyBeforeCommit'];
checkProtocolModel('RetirementRecovery', [
  { name: 'manual-window', constants: base, checks: [...checks, 'NoOldClaimAfterCommit'], violation: 'NoOldClaimAfterCommit' },
  { name: 'stop-failure', constants: { ...base, StopFails: true }, checks: [...checks, 'NoOldClaimAfterCommit'], violation: 'NoOldClaimAfterCommit' },
  { name: 'automatic-stop-first', constants: { ...base, StopBeforeCommit: true }, checks: [...checks, 'NoOldClaimAfterCommit'] },
  { name: 'bounded-recovery', constants: { ...base, FairRecovery: true }, checks, property: 'EventuallyDelivered' },
  { name: 'missing-registry-recovery', constants: { ...base, FairRecovery: true, RecoverRegistration: false }, checks, property: 'EventuallyDelivered', temporalFailure: true },
]);
