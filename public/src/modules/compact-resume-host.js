import { createCompactResume } from './compact-resume.js';

const request = createCompactResume(window.createCompactResumeHost());
export const { createCompactedResumeSession } = request;
