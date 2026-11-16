import { createCompactResume } from './compact-resume.js';

const request = createCompactResume(window.createCompactResumeHost());
export const { createCompactedResumeSession } = request;
window.KernelState.defineKey('compact-resume', 'createCompactedResumeSession', createCompactedResumeSession);
window.KernelState.claim('compact-resume', {
  get: key => request[key],
  set: (key, value) => { request[key] = value; },
});
