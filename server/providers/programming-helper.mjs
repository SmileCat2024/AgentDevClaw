/**
 * programming-helper provider
 *
 * 编程助手工作空间的全部 CLI 操作。
 *
 * Provider 接口约定：
 *   id          — 工作空间唯一标识（与 server.js WORKSPACE_SESSION_AGENT_IDS 中的 agentId 一致）
 *   name        — 显示名称
 *   description — 简短描述
 *   operations  — 操作数组，每个操作 { name, description, params, execute(ctx, params) }
 *
 * ctx 对象提供（见 claw-core.mjs createContext）:
 *   readWorkspaceState()   — 读取 workspace state.json
 *   readSessionIndex()     — 读取 sessions/index.json
 *   getExplorations()      — 过滤出探索记录
 *   getSubs()              — 过滤出子代理对话
 *   loadSessionDetail(sid) — 读取会话消息
 *   loadFinalOutput(sid)   — 最后一条 assistant 消息
 *   findHandoffSummary(sid)— 查找 handoff 摘要
 *   http(path, opts)       — 调用 server API
 *   execFileSync(...)      — 子进程执行
 *   getSessionsDir()       — 会话文件目录
 *   projectRoot            — Claw 项目根路径
 *   workspaceId            — 当前工作空间 ID
 */

import { cleanText, truncate } from '../claw-core.mjs';
import { join } from 'path';
import { readFileSync } from 'fs';
import os from 'os';

export default {
  id: 'programming-helper',
  name: '编程助手',
  description: '代码编写、调试、子代理探索与知识沉淀',
  agentDir: 'prebuilt-agents/official/programming-helper',

  operations: [
    // ── overview ──────────────────────────────────────────────
    {
      name: 'overview',
      description: '工作空间概览：工作目录、探索记录数、子代理数',
      params: [],
      execute: async (ctx) => {
        const state = ctx.readWorkspaceState();
        const explorations = ctx.getExplorations();
        const subs = ctx.getSubs();
        const openDir = cleanText(state.openDirectory);
        return {
          workingDirectory: openDir || '(not set)',
          explorationCount: explorations.length,
          subAgentCount: subs.length,
        };
      },
    },

    // ── explorations ──────────────────────────────────────────
    {
      name: 'explorations',
      description: '列出探索记录，支持文件和关键字筛选',
      params: [
        { name: 'limit', required: false, description: '最大返回数（默认 20）' },
        { name: 'file', required: false, description: '文件名筛选' },
        { name: 'keyword', required: false, description: '关键字筛选' },
      ],
      execute: async (ctx, { limit = 20, file: fileFilter, keyword } = {}) => {
        let explorations = ctx.getExplorations();

        if (fileFilter || keyword) {
          explorations = explorations.filter(record => {
            if (fileFilter) {
              const handoff = ctx.findHandoffSummary(record.id);
              const files = handoff?.importantFiles || [];
              if (!files.some(f => f.toLowerCase().includes(fileFilter.toLowerCase()))) {
                return false;
              }
            }
            if (keyword) {
              const kw = keyword.toLowerCase();
              if ((record.goal || '').toLowerCase().includes(kw)) return true;
              const handoff = ctx.findHandoffSummary(record.id);
              if (handoff?.summaryText?.toLowerCase().includes(kw)) return true;
              if (handoff?.sessionTitle?.toLowerCase().includes(kw)) return true;
              return false;
            }
            return true;
          });
        }

        const totalCount = explorations.length;
        const displayed = explorations.slice(0, limit);

        const records = displayed.map(record => {
          const handoff = ctx.findHandoffSummary(record.id);
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

        return { total: totalCount, count: records.length, records };
      },
    },

    // ── subs ──────────────────────────────────────────────────
    {
      name: 'subs',
      description: '列出子代理对话',
      params: [],
      execute: async (ctx) => {
        const subs = ctx.getSubs();
        const records = subs.map(record => ({
          id: record.id,
          goal: cleanText(record.goal) || '(no goal)',
          domains: Array.isArray(record.domains) ? record.domains : [],
          sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
            ? record.metadata.sourceExplorationIds : [],
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));
        return { total: records.length, records };
      },
    },

    // ── show ──────────────────────────────────────────────────
    {
      name: 'show',
      description: '查看探索记录或子代理的详细信息',
      params: [
        { name: 'sessionId', required: true, description: '会话 ID' },
      ],
      execute: async (ctx, { sessionId } = {}) => {
        const index = ctx.readSessionIndex();
        const record = index.sessions.find(s => s.id === sessionId);
        if (!record) {
          return { error: `Session not found: ${sessionId}` };
        }

        const sessionType = cleanText(record.sessionType);
        const isExploration = sessionType === 'exploration' || record.metadata?.clean === true;
        const goal = cleanText(record.goal) || '(no goal)';
        const detail = ctx.loadSessionDetail(sessionId);

        if (isExploration) {
          const handoff = ctx.findHandoffSummary(sessionId);
          let resultText = null;
          if (handoff?.summaryText) {
            resultText = handoff.summaryText;
          } else {
            resultText = ctx.loadFinalOutput(sessionId);
          }
          return {
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
          };
        } else {
          const finalOutput = ctx.loadFinalOutput(sessionId);
          return {
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
          };
        }
      },
    },

    // ── spawn ─────────────────────────────────────────────────
    {
      name: 'spawn',
      description: '启动探索对话（无父上下文）或子代理（从探索记录派生）',
      params: [
        { name: 'goal', required: true, description: '目标描述' },
        { name: 'from', required: false, description: '父探索 ID（逗号分隔），留空=裸探索' },
      ],
      execute: async (ctx, { goal, from } = {}) => {
        const explorationIds = from
          ? from.split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const isExploration = explorationIds.length === 0;

        // 校验探索 ID
        if (!isExploration) {
          const index = ctx.readSessionIndex();
          for (const expId of explorationIds) {
            const record = index.sessions.find(s => s.id === expId);
            if (!record) {
              return { error: `Exploration not found: ${expId}` };
            }
          }
        }

        const { ok, data } = await ctx.http('/protoclaw/spawn_one_shot', {
          method: 'POST',
          body: { goal, explorationIds, agentId: ctx.workspaceId },
        });

        if (!ok) {
          return { error: data?.error || `HTTP error` };
        }

        const result = data.result;
        const sessionType = data.session?.sessionType || (isExploration ? 'exploration' : 'sub');

        return {
          ok: result.ok,
          sessionId: data.session.id,
          sessionType,
          durationMs: result.durationMs,
          response: result.ok ? result.response : undefined,
          error: result.ok ? undefined : result.error,
        };
      },
    },

    // ── compact ───────────────────────────────────────────────
    {
      name: 'compact',
      description: '对探索记录生成结构化摘要',
      params: [
        { name: 'sessionId', required: true, description: '探索记录 ID' },
      ],
      execute: async (ctx, { sessionId } = {}) => {
        const index = ctx.readSessionIndex();
        const record = index.sessions.find(s => s.id === sessionId);
        if (!record) {
          return { error: `Session not found: ${sessionId}` };
        }

        const sessionType = cleanText(record.sessionType);
        if (sessionType !== 'exploration' && record.metadata?.clean !== true) {
          return { error: `Only exploration records can be compacted (type: ${sessionType})` };
        }

        const agentDir = ctx.agentDir || 'prebuilt-agents/official/programming-helper';
        const resultPath = join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);
        const args = [
          join(ctx.projectRoot, 'scripts', 'run-compact-mirror.js'),
          agentDir,
          ctx.workspaceId,
          sessionId,
          JSON.stringify({ sessionType }),
          resultPath,
        ];

        ctx.execFileSync('node', args, {
          cwd: ctx.projectRoot,
          timeout: 120000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // 读取结果
        let result;
        try {
          result = JSON.parse(readFileSync(resultPath, 'utf8'));
        } catch {
          return { error: 'Compact failed: no valid result' };
        }
        if (!result?.ok) {
          return { error: 'Compact failed: no valid result' };
        }

        // 持久化到服务端
        const { ok: exportOk, data: exportData } = await ctx.http('/protoclaw/context_handoffs/summary_export', {
          method: 'POST',
          body: {
            sessionId,
            summaryText: result.summaryText,
            rawResponse: result.rawResponse || '',
            importantFiles: result.importantFiles || [],
            importantSkills: result.importantSkills || [],
            sessionTitle: result.sessionTitle || '',
            fileRanges: result.fileRanges || {},
            sessionTimestamp: result.sessionTimestamp || null,
            gitMeta: result.gitMeta || null,
          },
        });

        if (!exportOk) {
          return { error: `Summary save failed: ${exportData?.error || 'unknown'}` };
        }

        return {
          ok: true,
          sessionId,
          summaryLength: cleanText(result.summaryText).length,
          sessionTitle: cleanText(result.sessionTitle),
          importantFiles: result.importantFiles || [],
          importantSkills: result.importantSkills || [],
          summaryText: result.summaryText,
          handoffPath: exportData?.handoffPath || null,
        };
      },
    },

    // ── create_session ───────────────────────────────────────
    {
      name: 'create_session',
      description: '为指定项目路径创建新的编程助手会话',
      params: [
        { name: 'path', required: true, description: '项目路径（openDirectory）' },
      ],
      execute: async (ctx, { path: openDirectory } = {}) => {
        const dir = cleanText(openDirectory);
        if (!dir) {
          return { error: 'Project path is required' };
        }

        const { ok, data } = await ctx.http('/protoclaw/prebuilt_sessions', {
          method: 'POST',
          body: {
            agentId: ctx.workspaceId,
            openDirectory: dir,
          },
        });

        if (!ok) {
          return { error: data?.error || `HTTP ${data?.status || 'error'}` };
        }

        const session = data.session || {};
        const status = data.status || {};
        return {
          ok: true,
          sessionId: session.id || '',
          title: session.title || '',
          openDirectory: session.openDirectory || dir,
          runtimeStatus: status.status || 'unknown',
          viewerAgentId: status.viewerAgentId || '',
          createdAt: session.createdAt || '',
        };
      },
    },

    // ── resume ────────────────────────────────────────────────
    {
      name: 'resume',
      description: '在子代理对话上追加指令',
      params: [
        { name: 'sessionId', required: true, description: '子代理会话 ID' },
        { name: 'message', required: true, description: '追加的指令内容' },
      ],
      execute: async (ctx, { sessionId, message } = {}) => {
        const index = ctx.readSessionIndex();
        const record = index.sessions.find(s => s.id === sessionId);
        if (!record) {
          return { error: `Session not found: ${sessionId}` };
        }

        const sessionType = cleanText(record.sessionType);
        if (sessionType === 'exploration' || record.metadata?.clean === true) {
          return { error: 'Exploration records are locked and cannot be resumed. Only sub-agents can be resumed.' };
        }

        const { ok, data } = await ctx.http('/protoclaw/resume_sub', {
          method: 'POST',
          body: { sessionId, message },
        });

        if (!ok) {
          return { error: data?.error || `HTTP error` };
        }

        const result = data.result;
        return {
          ok: result.ok,
          sessionId,
          durationMs: result.durationMs,
          response: result.ok ? result.response : undefined,
          error: result.ok ? undefined : result.error,
        };
      },
    },
  ],
};
