/**
 * ConversationExportFeature — 对话导出渲染
 *
 * 提供 export_conversation 工具：输入 sessionId，将对话渲染为自包含 HTML，
 * 写入 cwd/.agentdev/temp/，返回文件绝对路径。
 *
 * 渲染逻辑在服务端（server/conversation-renderer.js），通过
 * POST /protoclaw/render_conversation 端点调用。
 */

import type { AgentFeature, Tool } from 'agentdev';

export class ConversationExportFeature implements AgentFeature {
  readonly name = 'conversation-export';

  getTools(): Tool[] {
    return [
      {
        name: 'export_conversation',
        description:
          '将指定会话的完整对话记录渲染为精美的 HTML 文件（包含用户消息、AI 回复、工具调用过程、思考过程等），保存到本地并返回文件路径。' +
          '生成的 HTML 文件可直接用浏览器打开，也可通过 upload_attachment 发送给 IM 用户。' +
          '支持渲染历史会话和当前会话。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '要导出的会话 ID',
            },
            agentId: {
              type: 'string',
              description: '会话所属的 agent ID（可选，默认为当前 agent）',
            },
            lastNCalls: {
              type: 'number',
              description: '只渲染最近 N 轮对话（可选，默认渲染全部）',
            },
          },
          required: ['sessionId'],
        },
        execute: async (args: any) => {
          const { sessionId, agentId, lastNCalls } = args || {};
          if (!sessionId) {
            return { error: 'sessionId is required' };
          }

          const serverOrigin =
            process.env.PROTOCLAW_SERVER_ORIGIN || `http://127.0.0.1:${process.env.PORT || 1420}`;

          try {
            const body: Record<string, unknown> = { sessionId };
            if (agentId) body.agentId = agentId;
            if (typeof lastNCalls === 'number' && lastNCalls > 0) body.lastNCalls = lastNCalls;

            const resp = await fetch(`${serverOrigin}/protoclaw/render_conversation`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });

            const data = await resp.json();

            if (!resp.ok) {
              return { error: data.error || `渲染失败 (${resp.status})` };
            }

            const sizeKb = (data.size / 1024).toFixed(1);
            return {
              success: true,
              text: `对话已渲染为 HTML 文件。\n路径: ${data.path}\n大小: ${sizeKb} KB\n消息数: ${data.messageCount}`,
              path: data.path,
              filename: data.filename,
              size: data.size,
              messageCount: data.messageCount,
            };
          } catch (err: any) {
            return { error: `导出失败: ${err.message || err}` };
          }
        },
      },
    ];
  }
}
