/**
 * 线程关联查询路由（session-reference 关联注入的数据面）。
 *
 * GET /protoclaw/thread_relations
 *   ?threadId=wt-…            线程直连寻址（全局唯一）
 *   ?agentId=…&sessionId=…    会话反查所属线程（引用注入的解析路径）
 *
 * 返回线程身份（resolvedThreadId / 标题 / 代数）+ 一跳邻居（显式引用口径，
 * 方向 + 次数 + 最近时间）+ 所在关联群规模。投影未就绪时身份照常返回、
 * 关联字段缺席（partial: true）。投影语义见 projection.js 头注与
 * docs/plans/2026-11-14-session-reference-thread-cluster.md。
 */
import { getThreadRelations } from './projection.js';

export function setupSessionRelationsRoutes(app) {
  app.get('/protoclaw/thread_relations', async (req, res, next) => {
    try {
      const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
      if (!threadId.startsWith('wt-') && !(agentId && sessionId)) {
        res.status(400).json({ error: 'threadId (wt- prefixed) or agentId+sessionId is required' });
        return;
      }
      // refresh=1 强制增量刷新（测试 / 手动重建入口）；常规查询走 10min 新鲜度窗口。
      const force = req.query.refresh === '1';
      res.json(await getThreadRelations({ threadId, agentId, sessionId, force }));
    } catch (error) {
      next(error);
    }
  });
}
