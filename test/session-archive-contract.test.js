import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sessionRoutes = fs.readFileSync(new URL('../server/routes/session.js', import.meta.url), 'utf8');
const appMain = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

describe('archive-and-replace contract', () => {
  it('archives a branch source before sending the success response', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/sessions/branch'");
    const end = sessionRoutes.indexOf("app.get('/protoclaw/session_summary'", start);
    const route = sessionRoutes.slice(start, end);
    const archiveAt = route.indexOf('await archivePrebuiltSession(agentId, sourceSessionId, true)');
    const responseAt = route.indexOf('res.json({');
    assert.ok(archiveAt >= 0, 'branch route must archive the source');
    assert.ok(responseAt > archiveAt, 'branch response must be sent after archive settles');
    assert.match(route, /archive:\s*\{[\s\S]*requested:[\s\S]*succeeded:[\s\S]*error:/);
  });

  it('returns the authoritative archive outcome from compact_and_resume', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/context_handoffs/compact_and_resume'");
    const end = sessionRoutes.indexOf("app.post('/protoclaw/context_handoffs/summary_resume'", start);
    const route = sessionRoutes.slice(start, end);
    assert.match(route, /res\.json\(\{[\s\S]*\.\.\.result,[\s\S]*archive:\s*\{/);
    assert.match(route, /succeeded:\s*archiveOriginal\s*\?\s*didArchive\s*:\s*null/);
  });

  it('does not use the unverifiable live shortcut for archive-and-replace', () => {
    assert.match(appMain, /if \(isLiveCurrentSession && strategy && !options\.archiveOriginal\)/);
  });
});
