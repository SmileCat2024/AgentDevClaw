import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sessionRoutes = fs.readFileSync(new URL('../server/routes/session.js', import.meta.url), 'utf8');
const appMain = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const workspaceActions = fs.readFileSync(new URL('../public/src/modules/workspace-actions.js', import.meta.url), 'utf8');

describe('archive-and-replace contract', () => {
  it('branches raw message objects so image attachments before the cut remain intact', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/sessions/branch'");
    const end = sessionRoutes.indexOf("app.get('/protoclaw/session_summary'", start);
    const route = sessionRoutes.slice(start, end);
    assert.match(route, /const branchMessages = rawMessages\.slice\(0, cutMsgIndexEnd \+ 1\)/);
    assert.match(route, /context:\s*\{[\s\S]*messages:\s*branchMessages,[\s\S]*enrichedMessages:\s*branchEnriched/);
  });

  it('archives a branch source before sending the success response', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/sessions/branch'");
    const end = sessionRoutes.indexOf("app.get('/protoclaw/session_summary'", start);
    const route = sessionRoutes.slice(start, end);
    const archiveAt = route.indexOf('await archivePrebuiltSession(agentId, sourceSessionId, true, { includeSessions: false })');
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
    assert.match(appMain, /if \(isLiveCurrentSession && strategy && !options\.archiveOriginal && options\.useLiveCommand === true\)/);
  });

  it('correlates compact response timing on both sides of JSON parsing', () => {
    const start = appMain.indexOf('async function createCompactedResumeSession');
    const end = appMain.indexOf('// PH session list helpers', start);
    const compactClient = appMain.slice(start, end);
    assert.match(compactClient, /recordSidebarOperationCheckpoint\(operationId, 'request_dispatched'\)/);
    assert.match(compactClient, /recordSidebarOperationCheckpoint\(operationId, 'response_headers_received'/);
    assert.match(compactClient, /recordSidebarOperationCheckpoint\(operationId, 'response_body_parsed'/);
    assert.match(compactClient, /beginSidebarOperationMainThreadObservation\(operationId\)/);
  });

  it('uses delta responses for delete/archive mutations while preserving legacy full responses', () => {
    const deleteStart = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/delete'");
    const archiveStart = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/archive'", deleteStart);
    const todoStart = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/todo'", archiveStart);
    const deleteRoute = sessionRoutes.slice(deleteStart, archiveStart);
    const archiveRoute = sessionRoutes.slice(archiveStart, todoStart);
    assert.match(deleteRoute, /includeSessions:\s*req\.body\.responseMode !== 'delta'/);
    assert.match(archiveRoute, /includeSessions:\s*req\.body\.responseMode !== 'delta'/);
    assert.match(deleteRoute, /operationId:\s*trace\.operationId/);
    assert.match(archiveRoute, /operationId:\s*trace\.operationId/);
  });

  it('waits for the exact target runtime without a blocking full-list refresh', () => {
    const start = workspaceActions.indexOf('if (needsManagedSession)');
    const end = workspaceActions.indexOf("if (action.type === 'show_chat'", start);
    const managedFlow = workspaceActions.slice(start, end);
    assert.match(managedFlow, /waitForTargetRuntimeSession\(activeAgent\.id, targetSessionId/);
    assert.doesNotMatch(managedFlow, /await loadAgents\(\)/);
    assert.doesNotMatch(managedFlow, /waitForPrebuiltRuntimeSession/);
  });
});
