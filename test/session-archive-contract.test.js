import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sessionRoutes = fs.readFileSync(new URL('../server/routes/session.js', import.meta.url), 'utf8');
const appMain = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const workspaceActions = fs.readFileSync(new URL('../public/src/modules/workspace-actions.js', import.meta.url), 'utf8');
const sessionDialogs = fs.readFileSync(new URL('../public/src/modules/session-dialogs.js', import.meta.url), 'utf8');
const sessionMutation = fs.readFileSync(new URL('../public/src/modules/session-mutation.js', import.meta.url), 'utf8');
const sidebarOperations = fs.readFileSync(new URL('../public/src/modules/sidebar-operations.js', import.meta.url), 'utf8');
const sidebarRender = fs.readFileSync(new URL('../public/src/modules/sidebar-render.js', import.meta.url), 'utf8');

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
    const end = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/activate'", start);
    const route = sessionRoutes.slice(start, end);
    assert.match(route, /res\.json\(\{[\s\S]*\.\.\.result,[\s\S]*archive:\s*\{/);
    assert.match(route, /succeeded:\s*archiveOriginal\s*\?\s*didArchive\s*:\s*null/);
  });

  it('manual compact honors the thread succession lifecycle (R8 / K2 / K14)', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/context_handoffs/compact_and_resume'");
    const end = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/activate'", start);
    const route = sessionRoutes.slice(start, end);

    // K14：线程历史棒次会话显式拒绝 compact（静默 no-op 会产生孤儿 successor）
    assert.match(route, /findThreadBySession[\s\S]*?session_not_head/);

    // R8：线程域手动接力退役旧 head runtime（flush 语义），且只在挡板立起
    // 后执行——纯 session 的手动 compact 不得被动停 runtime
    assert.match(route, /successionGate\.applied[\s\S]*?stopManagedAgent\(preferredAgentId,\s*sessionId\)/);

    // K2：detached job 失败必须落 rotation_failed（挡板不得滞留至 stale）
    const detachedCatch = route.slice(route.indexOf('.catch(async (error) => {'));
    assert.ok(detachedCatch.length > 1, 'detached job failure path must exist');
    assert.match(detachedCatch, /failSessionSuccession/);
  });

  it('does not archive the original session when thread succession fails to land', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/context_handoffs/compact_and_resume'");
    const end = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/activate'", start);
    const route = sessionRoutes.slice(start, end);
    // 推进失败（applied=false + handoff_failed）时线程仍指向原会话，
    // 归档会挖掉线程的 head——跳过归档并写明原因。
    assert.match(route, /successionBlocked/);
    assert.match(route, /thread succession failed[^']*archive skipped/);
  });

  it('does not use the unverifiable live shortcut for archive-and-replace', () => {
    // live 命令捷径（/compact-summary-resume 进程内路径）已整体移除：
    // 所有压缩续接（含归档替换）一律走 server 同步端点。
    assert.doesNotMatch(appMain, /useLiveCommand/);
    assert.doesNotMatch(appMain, /compact-summary-resume/);
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

  it('uses delta responses and starts the replacement runtime for active delete/archive mutations', () => {
    const deleteStart = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/delete'");
    const archiveStart = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/archive'", deleteStart);
    const todoStart = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/todo'", archiveStart);
    const deleteRoute = sessionRoutes.slice(deleteStart, archiveStart);
    const archiveRoute = sessionRoutes.slice(archiveStart, todoStart);
    assert.match(deleteRoute, /includeSessions:\s*req\.body\.responseMode !== 'delta'/);
    assert.match(archiveRoute, /includeSessions:\s*req\.body\.responseMode !== 'delta'/);
    assert.match(deleteRoute, /deleted\.wasActiveSession/);
    assert.match(deleteRoute, /await startManagedAgent\(agent, targetSessionId\)/);
    assert.match(archiveRoute, /archived && result\.wasActiveSession/);
    assert.match(archiveRoute, /await startManagedAgent\(agent, targetSessionId\)/);
    assert.match(deleteRoute, /operationId:\s*trace\.operationId/);
    assert.match(archiveRoute, /operationId:\s*trace\.operationId/);
  });

  it('continues active-session mutations into the exact replacement runtime', () => {
    assert.match(sessionMutation, /async function navigateToSessionMutationTarget/);
    assert.match(sessionMutation, /waitForTargetRuntimeSession\(agentId, targetSessionId, 50/);
    assert.match(sessionMutation, /await requestSwitch\(targetRuntimeId, 'session-mutation-target'\)/);
    assert.match(workspaceActions, /void navigateToSessionMutationTarget\(activeAgent\.id/);
  });

  it('waits for the exact target runtime without a blocking full-list refresh', () => {
    const start = workspaceActions.indexOf('if (needsManagedSession)');
    const end = workspaceActions.indexOf("if (action.type === 'show_chat'", start);
    const managedFlow = workspaceActions.slice(start, end);
    assert.match(managedFlow, /finishSidebarOperation\(sidebarOperation\.operationId, 'settled'\);/);
    assert.doesNotMatch(managedFlow, /await waitForTargetRuntimeSession/);
    assert.doesNotMatch(managedFlow, /waitForPrebuiltRuntimeSession/);
  });

  it('keeps readiness observation bounded and separate from session-operation settlement', () => {
    const start = sidebarRender.indexOf('async function waitForTargetRuntimeSession');
    const end = sidebarRender.indexOf('\nasync function loadAgents()', start);
    const readinessWait = sidebarRender.slice(start, end);
    assert.match(readinessWait, /attempt < attempts/);
    assert.match(readinessWait, /return null;/);
    assert.doesNotMatch(readinessWait, /for \(;;\)/);
  });

  it('settles a committed replacement before independently cleaning up its source runtime', () => {
    for (const client of [workspaceActions, sessionDialogs]) {
      assert.match(client, /requestArchivedSourceRuntimeCleanup\(/);
      assert.doesNotMatch(client, /settleSessionReplacementMutation/);
      assert.doesNotMatch(client, /phase:\s*'source-stopping'/);
    }
    assert.match(sessionMutation, /function requestArchivedSourceRuntimeCleanup/);
    assert.doesNotMatch(sidebarOperations, /source_stop_timeout/);
    assert.doesNotMatch(sidebarOperations, /settleSidebarSourceOperation/);
  });
});
