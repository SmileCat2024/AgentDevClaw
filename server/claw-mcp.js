import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// --- Constants ---
const USER_DATA_ROOT = join(os.homedir(), '.agentdev', 'AgentDevClaw');
const WORKSPACES_ROOT = join(USER_DATA_ROOT, 'workspaces');
const PROGRAMMING_HELPER_DIR = join(WORKSPACES_ROOT, 'programming-helper');
const SESSIONS_DIR = join(PROGRAMMING_HELPER_DIR, 'sessions');
const HANDOFFS_DIR = join(USER_DATA_ROOT, 'context-handoffs', 'programming-helper');
const SERVER_URL = process.env.PROTOCLAW_SERVER_URL || 'http://127.0.0.1:1420';

// --- Helpers ---
function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function truncate(text, maxLen = 120) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '…';
}

// --- Data readers (same logic as claw.mjs) ---

function readSessionIndex() {
  const index = readJson(join(SESSIONS_DIR, 'index.json'));
  if (!index) return { activeSessionId: null, sessions: [] };
  const sessions = Array.isArray(index.sessions)
    ? index.sessions.filter(s => s && s.id && s.id !== 'legacy')
    : [];
  return { activeSessionId: index.activeSessionId, sessions };
}

function getExplorations() {
  const index = readSessionIndex();
  return index.sessions.filter(s => {
    const st = cleanText(s.sessionType);
    if (st === 'exploration') return true;
    if (st === 'sub' && s.metadata?.clean === true) return true;
    if (st === 'sub' && s.metadata?.sourceSessionId?.startsWith('__protoclaw-clean-')) return true;
    return false;
  });
}

function getSubs() {
  const index = readSessionIndex();
  return index.sessions.filter(s => {
    const st = cleanText(s.sessionType);
    if (st === 'sub' && s.metadata?.clean === true) return false;
    if (st === 'sub' && s.metadata?.sourceSessionId?.startsWith('__protoclaw-clean-')) return false;
    if (st === 'sub' && s.metadata?.resumeMode === 'one-shot') return true;
    return false;
  });
}

function findHandoffSummary(sessionId) {
  if (!sessionId) return null;
  if (!existsSync(HANDOFFS_DIR)) return null;

  let files;
  try {
    files = readdirSync(HANDOFFS_DIR)
      .filter(name => name.startsWith('handoff-') && name.endsWith('.json'))
      .map(name => join(HANDOFFS_DIR, name))
      .filter(filePath => statSync(filePath).isFile());
  } catch {
    return null;
  }

  let best = null;
  for (const filePath of files) {
    const handoff = readJson(filePath);
    if (!handoff || handoff.sourceSessionId !== sessionId) continue;
    const createdAt = handoff.createdAt || '';
    if (!best || createdAt > (best.createdAt || '')) {
      best = handoff;
    }
  }

  if (!best) return null;

  return {
    sessionId,
    handoffId: best.handoffId || '',
    handoffCreatedAt: best.createdAt || '',
    mode: best.mode || '',
    summaryText: cleanText(best.sourceSummary),
    importantFiles: Array.isArray(best.compactOutput?.importantFiles)
      ? best.compactOutput.importantFiles : [],
    importantSkills: Array.isArray(best.compactOutput?.importantSkills)
      ? best.compactOutput.importantSkills : [],
    seedMessages: Array.isArray(best.seedMessages) ? best.seedMessages : [],
    stats: best.stats || {},
    sessionTimestamp: best.sessionTimestamp || null,
    sessionTitle: best.sessionTitle || null,
    gitMeta: best.gitMeta || null,
  };
}

function loadSessionDetail(sessionId) {
  const filePath = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readJson(filePath);
  if (!raw) return null;

  const messages = Array.isArray(raw?.runtime?.context?.messages)
    ? raw.runtime.context.messages
    : [];
  const lastMessage = [...messages].reverse().find(
    m => m && typeof m.content === 'string' && m.role !== 'system'
  );

  return {
    id: sessionId,
    savedAt: raw.savedAt,
    messageCount: messages.length,
    lastMessage: lastMessage?.content
      ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 200)
      : '',
    messages,
  };
}

function loadFinalOutput(sessionId) {
  const detail = loadSessionDetail(sessionId);
  if (!detail) return null;
  const lastAssistant = [...detail.messages].reverse().find(
    m => m && m.role === 'assistant' && typeof m.content === 'string'
  );
  return lastAssistant?.content || null;
}

// --- MCP Server ---

export class ClawMCPServer {
  constructor() {}

  async handleRequest(req, res) {
    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    res.on('close', () => { void close(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      if (!res.writableEnded) {
        await close();
      }
    }
  }

  createServer() {
    const server = new McpServer(
      { name: 'claw-cli', version: '1.0.0' },
      { capabilities: { logging: {} } }
    );

    this.registerTools(server);
    this.registerResources(server);
    this.registerPrompts(server);
    return server;
  }

  registerTools(server) {
    // --- overview ---
    server.registerTool('overview', {
      title: 'Claw Status Overview',
      description: 'Get an overview of the claw workspace: working directory, exploration count, sub-agent count.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const state = readJson(join(PROGRAMMING_HELPER_DIR, 'state.json')) || { forms: {}, openDirectory: '' };
      const explorations = getExplorations();
      const subs = getSubs();
      const openDir = cleanText(state.openDirectory);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            workingDirectory: openDir || '(not set)',
            explorationCount: explorations.length,
            subAgentCount: subs.length,
          }, null, 2),
        }],
      };
    });

    // --- list_explorations ---
    server.registerTool('list_explorations', {
      title: 'List Explorations',
      description: 'List exploration records. Supports filtering by file path and keyword, with a limit cap.',
      inputSchema: z.object({
        limit: z.number().default(20).describe('Max records to return (default 20)'),
        file: z.string().optional().describe('Filter: match important files containing this substring'),
        keyword: z.string().optional().describe('Filter: match goal, summary text, or session title'),
      }),
    }, async ({ limit = 20, file: fileFilter, keyword }) => {
      let explorations = getExplorations();

      if (fileFilter || keyword) {
        explorations = explorations.filter(record => {
          if (fileFilter) {
            const handoff = findHandoffSummary(record.id);
            const files = handoff?.importantFiles || [];
            if (!files.some(f => f.toLowerCase().includes(fileFilter.toLowerCase()))) return false;
          }
          if (keyword) {
            const kw = keyword.toLowerCase();
            const goalMatch = (record.goal || '').toLowerCase().includes(kw);
            if (goalMatch) return true;
            const handoff = findHandoffSummary(record.id);
            const summaryMatch = handoff?.summaryText?.toLowerCase().includes(kw);
            const titleMatch = handoff?.sessionTitle?.toLowerCase().includes(kw);
            if (summaryMatch || titleMatch) return true;
            return false;
          }
          return true;
        });
      }

      const totalCount = explorations.length;
      const displayed = explorations.slice(0, limit);

      const records = displayed.map(record => {
        const handoff = findHandoffSummary(record.id);
        return {
          id: record.id,
          goal: cleanText(record.goal) || '(no goal)',
          status: record.status === 'locked' ? 'locked' : 'running',
          domains: Array.isArray(record.domains) ? record.domains : [],
          importantFiles: handoff?.importantFiles || [],
          hasSummary: !!handoff?.summaryText,
          summaryPreview: handoff?.summaryText ? truncate(handoff.summaryText, 200) : null,
          sessionTitle: handoff?.sessionTitle || null,
          timestamp: handoff?.sessionTimestamp || record.updatedAt || record.createdAt,
          gitMeta: handoff?.gitMeta || null,
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ total: totalCount, count: records.length, records }, null, 2),
        }],
      };
    });

    // --- list_sub_agents ---
    server.registerTool('list_sub_agents', {
      title: 'List Sub-agents',
      description: 'List sub-agent conversations derived from exploration records.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const subs = getSubs();
      const records = subs.map(record => ({
        id: record.id,
        goal: cleanText(record.goal) || '(no goal)',
        domains: Array.isArray(record.domains) ? record.domains : [],
        sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
          ? record.metadata.sourceExplorationIds : [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ total: records.length, records }, null, 2),
        }],
      };
    });

    // --- show ---
    server.registerTool('show', {
      title: 'Show Session Detail',
      description: 'Show detailed information about an exploration record or sub-agent conversation, including the full result or summary.',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to inspect'),
      }),
    }, async ({ sessionId }) => {
      const index = readSessionIndex();
      const record = index.sessions.find(s => s.id === sessionId);
      if (!record) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Session not found: ${sessionId}` }) }],
          isError: true,
        };
      }

      const sessionType = cleanText(record.sessionType);
      const isExploration = sessionType === 'exploration' || record.metadata?.clean === true;
      const goal = cleanText(record.goal) || '(no goal)';
      const detail = loadSessionDetail(sessionId);

      if (isExploration) {
        const handoff = findHandoffSummary(sessionId);
        let resultText = null;
        if (handoff?.summaryText) {
          resultText = handoff.summaryText;
        } else {
          resultText = loadFinalOutput(sessionId);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              type: 'exploration',
              id: sessionId,
              goal,
              status: record.status === 'locked' ? 'locked' : 'running',
              domains: Array.isArray(record.domains) ? record.domains : [],
              hasSummary: !!handoff?.summaryText,
              sessionTitle: handoff?.sessionTitle || null,
              timestamp: handoff?.sessionTimestamp || record.createdAt,
              gitMeta: handoff?.gitMeta || null,
              messageCount: detail?.messageCount || 0,
              result: resultText,
            }, null, 2),
          }],
        };
      } else {
        const finalOutput = loadFinalOutput(sessionId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              type: 'sub-agent',
              id: sessionId,
              goal,
              sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
                ? record.metadata.sourceExplorationIds : [],
              domains: Array.isArray(record.domains) ? record.domains : [],
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              messageCount: detail?.messageCount || 0,
              finalOutput,
            }, null, 2),
          }],
        };
      }
    });

    // --- spawn ---
    server.registerTool('spawn', {
      title: 'Spawn Exploration or Sub-agent',
      description: 'Spawn a new exploration (no parent context) or sub-agent (from exploration records). For exploration: pass empty explorationIds. For sub-agent: pass one or more exploration IDs as context.',
      inputSchema: z.object({
        goal: z.string().describe('The goal/task for the spawned agent'),
        explorationIds: z.array(z.string()).default([]).describe('Parent exploration IDs (empty = bare exploration spawn)'),
      }),
    }, async ({ goal, explorationIds = [] }) => {
      if (!cleanText(goal)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'goal is required' }) }],
          isError: true,
        };
      }

      const isExploration = explorationIds.length === 0;

      // Validate exploration IDs for sub-agent
      if (!isExploration) {
        const index = readSessionIndex();
        for (const expId of explorationIds) {
          const record = index.sessions.find(s => s.id === expId);
          if (!record) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: `Exploration not found: ${expId}` }) }],
              isError: true,
            };
          }
        }
      }

      try {
        const response = await fetch(`${SERVER_URL}/protoclaw/spawn_one_shot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal, explorationIds }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: errorBody.error || `HTTP ${response.status}` }) }],
            isError: true,
          };
        }

        const data = await response.json();
        const result = data.result;
        const sessionType = data.session?.sessionType || (isExploration ? 'exploration' : 'sub');

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: result.ok,
              sessionId: data.session.id,
              sessionType,
              durationMs: result.durationMs,
              response: result.ok ? result.response : undefined,
              error: result.ok ? undefined : result.error,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Spawn failed: ${error.message}` }) }],
          isError: true,
        };
      }
    });

    // --- compact ---
    server.registerTool('compact', {
      title: 'Generate Summary',
      description: 'Generate a summary (compact) for an exploration record. Only explorations can be compacted.',
      inputSchema: z.object({
        sessionId: z.string().describe('The exploration session ID to compact'),
      }),
    }, async ({ sessionId }) => {
      if (!cleanText(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'sessionId is required' }) }],
          isError: true,
        };
      }

      const index = readSessionIndex();
      const record = index.sessions.find(s => s.id === sessionId);
      if (!record) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Session not found: ${sessionId}` }) }],
          isError: true,
        };
      }

      const sessionType = cleanText(record.sessionType);
      if (sessionType !== 'exploration' && record.metadata?.clean !== true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Only exploration records can be compacted (type: ${sessionType})` }) }],
          isError: true,
        };
      }

      try {
        const resultPath = join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);
        const args = [
          join(process.cwd(), 'scripts', 'run-compact-mirror.js'),
          'prebuilt-agents/official/programming-helper',
          'programming-helper',
          sessionId,
          JSON.stringify({ sessionType }),
          resultPath,
        ];

        execFileSync('node', args, {
          cwd: process.cwd(),
          timeout: 120000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const result = readJson(resultPath);
        if (!result?.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Compact failed: no valid result' }) }],
            isError: true,
          };
        }

        // Persist handoff via server API
        try {
          const exportResp = await fetch(`${SERVER_URL}/protoclaw/context_handoffs/summary_export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              summaryText: result.summaryText,
              rawResponse: result.rawResponse || '',
              importantFiles: result.importantFiles || [],
              importantSkills: result.importantSkills || [],
              sessionTitle: result.sessionTitle || '',
              fileRanges: result.fileRanges || {},
              sessionTimestamp: result.sessionTimestamp || null,
              gitMeta: result.gitMeta || null,
            }),
          });

          if (!exportResp.ok) {
            const errBody = await exportResp.text();
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: `Summary save failed: ${exportResp.status} ${errBody}` }) }],
              isError: true,
            };
          }

          const exportResult = await exportResp.json();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                sessionId,
                summaryLength: cleanText(result.summaryText).length,
                sessionTitle: cleanText(result.sessionTitle),
                importantFiles: result.importantFiles || [],
                importantSkills: result.importantSkills || [],
                summaryText: result.summaryText,
                handoffPath: exportResult.handoffPath || null,
              }, null, 2),
            }],
          };
        } catch (exportErr) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Summary save failed: ${exportErr.message}` }) }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Compact failed: ${error.message}` }) }],
          isError: true,
        };
      }
    });

    // --- resume ---
    server.registerTool('resume', {
      title: 'Resume Sub-agent',
      description: 'Resume (append a message to) an existing sub-agent conversation. Only sub-agents can be resumed, not explorations.',
      inputSchema: z.object({
        sessionId: z.string().describe('The sub-agent session ID to resume'),
        message: z.string().describe('The message to append'),
      }),
    }, async ({ sessionId, message }) => {
      if (!cleanText(sessionId) || !cleanText(message)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'sessionId and message are required' }) }],
          isError: true,
        };
      }

      const index = readSessionIndex();
      const record = index.sessions.find(s => s.id === sessionId);
      if (!record) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Session not found: ${sessionId}` }) }],
          isError: true,
        };
      }

      const sessionType = cleanText(record.sessionType);
      if (sessionType === 'exploration' || record.metadata?.clean === true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Exploration records are locked and cannot be resumed. Only sub-agents can be resumed.' }) }],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${SERVER_URL}/protoclaw/resume_sub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: errorBody.error || `HTTP ${response.status}` }) }],
            isError: true,
          };
        }

        const data = await response.json();
        const result = data.result;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: result.ok,
              sessionId,
              durationMs: result.durationMs,
              response: result.ok ? result.response : undefined,
              error: result.ok ? undefined : result.error,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Resume failed: ${error.message}` }) }],
          isError: true,
        };
      }
    });
  }

  registerResources(server) {
    // claw://explorations — all exploration records
    server.registerResource('explorations', 'claw://explorations', {
      title: 'All Explorations',
      description: 'Complete list of exploration records with metadata.',
      mimeType: 'application/json',
    }, async (uri) => {
      const explorations = getExplorations();
      const records = explorations.map(record => {
        const handoff = findHandoffSummary(record.id);
        return {
          id: record.id,
          goal: cleanText(record.goal) || '(no goal)',
          status: record.status === 'locked' ? 'locked' : 'running',
          domains: Array.isArray(record.domains) ? record.domains : [],
          hasSummary: !!handoff?.summaryText,
          sessionTitle: handoff?.sessionTitle || null,
          timestamp: handoff?.sessionTimestamp || record.updatedAt || record.createdAt,
        };
      });
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(records, null, 2),
        }],
      };
    });

    // claw://sub-agents — all sub-agent conversations
    server.registerResource('sub-agents', 'claw://sub-agents', {
      title: 'All Sub-agents',
      description: 'Complete list of sub-agent conversations.',
      mimeType: 'application/json',
    }, async (uri) => {
      const subs = getSubs();
      const records = subs.map(record => ({
        id: record.id,
        goal: cleanText(record.goal) || '(no goal)',
        domains: Array.isArray(record.domains) ? record.domains : [],
        sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
          ? record.metadata.sourceExplorationIds : [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(records, null, 2),
        }],
      };
    });

    // claw://sessions/{sessionId} — detail for any session
    server.registerResource(
      'session-detail',
      new ResourceTemplate('claw://sessions/{sessionId}', { list: undefined }),
      {
        title: 'Session Detail',
        description: 'Detailed view of a session by ID.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const sessionId = typeof variables.sessionId === 'string'
          ? variables.sessionId
          : (Array.isArray(variables.sessionId) ? variables.sessionId[0] : String(variables.sessionId || ''));

        const index = readSessionIndex();
        const record = index.sessions.find(s => s.id === sessionId);
        if (!record) {
          return {
            contents: [{
              uri: uri.toString(),
              mimeType: 'application/json',
              text: JSON.stringify({ error: `Session not found: ${sessionId}` }),
            }],
          };
        }

        const sessionType = cleanText(record.sessionType);
        const isExploration = sessionType === 'exploration' || record.metadata?.clean === true;
        const detail = loadSessionDetail(sessionId);
        const goal = cleanText(record.goal) || '(no goal)';

        let result = {};
        if (isExploration) {
          const handoff = findHandoffSummary(sessionId);
          result = {
            type: 'exploration', id: sessionId, goal,
            status: record.status === 'locked' ? 'locked' : 'running',
            domains: Array.isArray(record.domains) ? record.domains : [],
            summary: handoff?.summaryText || null,
            importantFiles: handoff?.importantFiles || [],
            sessionTitle: handoff?.sessionTitle || null,
            gitMeta: handoff?.gitMeta || null,
            messageCount: detail?.messageCount || 0,
          };
        } else {
          result = {
            type: 'sub-agent', id: sessionId, goal,
            sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
              ? record.metadata.sourceExplorationIds : [],
            domains: Array.isArray(record.domains) ? record.domains : [],
            messageCount: detail?.messageCount || 0,
            finalOutput: loadFinalOutput(sessionId),
          };
        }

        return {
          contents: [{
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }
    );
  }

  registerPrompts(server) {
    server.registerPrompt('explore_codebase', {
      title: 'Explore Codebase',
      description: 'Start an exploration to understand a specific part of the codebase. Best practice: first check existing explorations, then spawn only if no relevant record exists.',
    }, async () => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need to explore the codebase. First, use the "list_explorations" tool to check if there are already relevant exploration records. If you find one that matches, use "show" to read its results. If none is relevant, use "spawn" to start a new exploration with a clear, modular goal. After the exploration completes, use "compact" to generate a summary for future reference.`,
          },
        }],
      };
    });

    server.registerPrompt('delegate_task', {
      title: 'Delegate Task to Sub-agent',
      description: 'Delegate a task to a sub-agent using existing exploration records as context. The sub-agent will have access to the full conversation history of the referenced explorations.',
    }, async () => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need to delegate a task to a sub-agent. First, use "list_explorations" to find relevant exploration records that provide context. Then use "spawn" with the relevant explorationIds and a clear goal. Use "show" to check the sub-agent's results when done. If the results are insufficient, use "resume" to continue the conversation.`,
          },
        }],
      };
    });
  }
}
