import { checkProtocolModel } from './protocol-model-runner.mjs';
const base = { KeepReceipt: false, ChangeGeneration: false, InboxRetry: false };
const checks = ['TypeOK', 'InboxDeliveredNotRetried', 'GenerationRejectsOldInput', 'NoDuplicateExecution'];
checkProtocolModel('DedupContinuity', [
  { name: 'evicted-and-receipt-lost', constants: base, checks, violation: 'NoDuplicateExecution' },
  { name: 'receipt-retained', constants: { ...base, KeepReceipt: true }, checks },
  { name: 'normal-inbox-retry', constants: { ...base, InboxRetry: true }, checks },
  { name: 'successor-generation', constants: { ...base, ChangeGeneration: true }, checks },
]);
