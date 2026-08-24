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
 *   loadSessionDetail(sid) — 读取会话消息
 *   http(path, opts)       — 调用 server API
 *   projectRoot            — Claw 项目根路径
 *   workspaceId            — 当前工作空间 ID
 */

import { cleanText } from '../claw-core.mjs';

export default {
  id: 'programming-helper',
  name: '编程助手',
  description: '代码编写、调试与知识沉淀',
  agentDir: 'prebuilt-agents/official/programming-helper',

  operations: [
    // ── overview ──────────────────────────────────────────────
    {
      name: 'overview',
      description: '工作空间概览：工作目录',
      params: [],
      execute: async (ctx) => {
        const state = ctx.readWorkspaceState();
        const openDir = cleanText(state.openDirectory);
        return {
          workingDirectory: openDir || '(not set)',
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
  ],
};
