/**
 * 线程关联查询路由（session-reference 关联注入的数据面）。
 *
 * GET /protoclaw/topic_groups
 *   ?agentId=programming-helper&projectId=…|openDirectory=…
 *   返回当前范围内全部显式会话引用连通分量（主题簇），按真实会话更新时间
 *   倒序，已合并簇标注（title 自定义值优先、summary）。
 *
 * PUT /protoclaw/topic_groups/:topicId
 *   body { title?, summary? }（至少其一；空串 = 清除该字段，两者皆空 = 删除标注）
 *   更新一个已存在主题簇的标题 / 简介。簇成员由会话引用客观决定，本端点
 *   只写标注（topic-notes），不能创建、删除或重组簇。
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
import express from 'express';
import { getThreadRelations, getTopicGroups } from './projection.js';
import { loadTopicNotes, resolveTopicNote, saveTopicNote } from './topic-notes.js';
import { USER_DATA_ROOT } from '../shared/constants.js';

const text = value => (typeof value === 'string' ? value.trim() : '');

export function setupSessionRelationsRoutes(app, { dataRoot = USER_DATA_ROOT } = {}) {
  app.get('/protoclaw/topic_groups', async (req, res, next) => {
    try {
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : 'programming-helper';
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
      const openDirectory = typeof req.query.openDirectory === 'string' ? req.query.openDirectory.trim() : '';
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      res.json(await getTopicGroups({ agentId, projectId, openDirectory, dataRoot, force: req.query.refresh === '1' }));
    } catch (error) {
      next(error);
    }
  });

  app.put('/protoclaw/topic_groups/:topicId', express.json(), async (req, res, next) => {
    try {
      const agentId = text(req.query.agentId) || 'programming-helper';
      const topicId = text(req.params.topicId);
      if (!topicId) return res.status(400).json({ error: 'topicId is required' });
      const body = req.body || {};
      const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
      const hasSummary = Object.prototype.hasOwnProperty.call(body, 'summary');
      if (!hasTitle && !hasSummary) return res.status(400).json({ error: 'provide at least one of title or summary' });
      if (hasTitle && typeof body.title !== 'string') return res.status(400).json({ error: 'title must be a string' });
      if (hasSummary && typeof body.summary !== 'string') return res.status(400).json({ error: 'summary must be a string' });
      // 簇必须真实存在于当前 agent 范围（全域，不按项目过滤）——工具面与
      // 看板都以该列表为准，不允许对悬空 id 写标注。
      const { groups } = await getTopicGroups({ agentId, dataRoot });
      const group = groups.find(entry => entry.id === topicId);
      if (!group) return res.status(404).json({ error: 'topic not found in current scope' });
      // 只更新提供的字段：未提供的字段保留现有标注（含继承来的值）。
      const notes = await loadTopicNotes(dataRoot, agentId);
      const existing = resolveTopicNote(notes, { clusterId: topicId, memberThreadIds: group.threadIds });
      const title = hasTitle ? text(body.title) : (existing?.title || '');
      const summary = hasSummary ? text(body.summary) : (existing?.summary || '');
      await saveTopicNote({ dataRoot, agentId, clusterId: topicId, title, summary, threadIds: group.threadIds });
      const fallbackTitle = group.fallbackTitle || '';
      res.json({
        ok: true,
        topic: { id: topicId, title: title || fallbackTitle, summary, customTitle: Boolean(title) },
      });
    } catch (error) {
      next(error);
    }
  });

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
