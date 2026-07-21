import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';

function runIsolatedReadModelSmoke(homeDir) {
  const script = `
    import path from 'path';
    import { promises as fs } from 'fs';
    import { pathToFileURL } from 'url';

    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'server', 'routes', 'session-helpers.js')).href;
    const { createSessionHelpers, SIDEBAR_SESSION_META_VERSION } = await import(moduleUrl);
    const helpers = createSessionHelpers({
      readWorkspaceState: async () => ({ forms: {}, openDirectory: '' }),
      writeWorkspaceState: async () => ({}),
      discoverAgents: async () => [],
      enrichAgent: async (value) => value,
      startManagedAgent: async () => null,
      waitForManagedRuntimeReady: async () => null,
    });
    const first = await helpers.listPrebuiltSessions('programming-helper');
    const indexPath = path.join(process.env.USERPROFILE, '.agentdev', 'AgentDevClaw', 'workspaces', 'programming-helper', 'sessions', 'index.json');
    const persisted = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    const handoffPath = path.join(process.env.USERPROFILE, '.agentdev', 'AgentDevClaw', 'context-handoffs', 'programming-helper', 'handoff-old.json');
    await fs.unlink(handoffPath);
    const second = await helpers.listPrebuiltSessions('programming-helper');
    process.stdout.write(JSON.stringify({
      first: first.sessions[0],
      second: second.sessions[0],
      persisted: persisted.sessions[0],
      expectedVersion: SIDEBAR_SESSION_META_VERSION,
      firstCount: first.sessions.length,
      persistedCount: persisted.sessions.length,
      indexPath,
    }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NODE_TEST_CONTEXT: 'sidebar-read-model-smoke',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `isolated smoke exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`invalid isolated smoke output: ${stdout}\n${stderr}\n${error.message}`));
      }
    });
  });
}

describe('programming-helper sidebar production read model', () => {
  it('migrates legacy metadata once and serves later lists from the index', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-sidebar-read-model-'));
    try {
      const root = path.join(homeDir, '.agentdev', 'AgentDevClaw');
      const sessionsDir = path.join(root, 'workspaces', 'programming-helper', 'sessions');
      const handoffsDir = path.join(root, 'context-handoffs', 'programming-helper');
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.mkdir(handoffsDir, { recursive: true });
      const savedAt = Date.parse('2026-01-02T00:00:00.000Z');
      await fs.writeFile(path.join(sessionsDir, 'legacy-session.json'), JSON.stringify({
        savedAt,
        runtime: {
          context: {
            messages: [
              { role: 'user', content: 'legacy question' },
              { role: 'assistant', content: 'legacy answer' },
            ],
          },
          usageStats: {
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        },
      }), 'utf8');
      await fs.writeFile(path.join(sessionsDir, 'index.json'), JSON.stringify({
        revision: 1,
        activeSessionId: 'legacy-session',
        sessions: [{
          id: 'legacy-session',
          title: 'Legacy session',
          sessionType: 'main',
          archived: true,
          todo: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }), 'utf8');
      await fs.writeFile(path.join(handoffsDir, 'handoff-old.json'), JSON.stringify({
        sourceSessionId: 'legacy-session',
        createdAt: '2026-01-03T00:00:00.000Z',
        sourceSummary: 'summary',
        compactOutput: { sessionTitle: 'Legacy summary' },
        stats: { synthetic: false },
      }), 'utf8');

      const result = await runIsolatedReadModelSmoke(homeDir);
      assert.equal(result.firstCount, 1, `unexpected isolated index at ${result.indexPath}`);
      assert.equal(result.first.archived, true);
      assert.equal(result.first.todo, false);
      assert.equal(result.first.hasSummary, true);
      assert.equal(result.first.messageCount, 2);
      assert.equal(result.first.preview, 'legacy answer');
      assert.equal(result.persisted.hasSummary, true);
      assert.equal(result.persisted.sidebarMetaVersion, result.expectedVersion);
      assert.equal(result.second.hasSummary, true, 'second list must use the persisted index after handoff scan input is removed');
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
