/**
 * Token count refresh route handler.
 *
 * Extracted from session.js to reduce file size. Handles the
 * /protoclaw/refresh_session_token_count endpoint which:
 * 1. Resolves model preset + provider config
 * 2. Reads session messages and transforms them for count_tokens API
 * 3. Calls external count_tokens API
 * 4. Writes updated usage stats back to the session file
 */

import path from 'path';
import { promises as fs } from 'fs';

import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  readSessionIndex,
  getPrebuiltAgentSessionDir,
} from '../shared/session-access.js';
import {
  readModelPresets,
  resolveSessionModelInfo,
} from './model-config.js';

/**
 * Transform raw session messages into the format expected by count_tokens API.
 *
 * Rules:
 * - system messages are accumulated and prepended to the first user/tool message
 * - tool role is remapped to 'user'
 * - array content blocks are flattened to text (using .text or JSON.stringify)
 * - non-string content is JSON.stringify'd
 * - if only system messages exist, a synthetic user message is created
 *
 * @param {Array} rawMessages - messages from session file
 * @returns {Array<{role: string, content: string}>} transformed messages
 */
export function transformMessagesForTokenCount(rawMessages) {
  const actualMessages = [];
  let systemParts = [];

  for (const m of rawMessages) {
    if (!m || m.content == null) continue;
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    let content;
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map(b => typeof b === 'string' ? b : (b?.text || JSON.stringify(b))).join('\n');
    } else {
      content = JSON.stringify(m.content);
    }
    // prepend system text to first user message
    let role = m.role;
    if (role === 'tool') role = 'user';
    if (role === 'user' && systemParts.length > 0) {
      content = systemParts.join('\n\n') + '\n\n' + content;
      systemParts = [];
    }
    actualMessages.push({ role, content });
  }
  // 如果只有 system 没有 user，补一条
  if (actualMessages.length === 0 && systemParts.length > 0) {
    actualMessages.push({ role: 'user', content: systemParts.join('\n\n') });
  }

  return actualMessages;
}

/**
 * Registers the token count refresh route.
 *
 * @param {object} app     Express app instance
 * @param {object} express Express module
 */
export function setupTokenRefreshRoute(app, express) {
  app.post('/protoclaw/refresh_session_token_count', express.json(), async (req, res, next) => {
    try {
      const { sessionId, agentId } = req.body || {};
      if (!sessionId || !agentId) {
        return res.status(400).json({ success: false, error: 'Missing sessionId or agentId' });
      }

      // 读取会话索引
      const index = await readSessionIndex(agentId);
      const sessionRecord = index.sessions.find(s => s.id === sessionId);
      if (!sessionRecord) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      // 复用 resolveSessionModelInfo 获取模型预设信息
      const modelInfo = await resolveSessionModelInfo(agentId, 'default');
      const presetName = modelInfo.presetName;
      const modelName = modelInfo.modelName;

      if (!presetName || !modelName) {
        return res.status(400).json({
          success: false,
          error: `Cannot determine model preset for agent ${agentId}`,
        });
      }

      // 读取模型预设配置（含 providers 和 countTokenPath）
      const presetsData = await readModelPresets();
      const preset = presetsData.presets.find(p => p.name === presetName);

      if (!preset) {
        return res.status(404).json({ success: false, error: `Model preset not found: ${presetName}` });
      }

      const countTokenPath = preset.countTokenPath || '/v1/messages/count_tokens';

      // 获取 provider 信息
      const provider = presetsData.providers.find(p => p.name === preset.providerName);
      if (!provider) {
        return res.status(404).json({ success: false, error: `Provider not found: ${preset.providerName}` });
      }

      const baseUrl = provider.endpoints?.[preset.protocol] || '';
      if (!baseUrl) {
        return res.status(400).json({ success: false, error: 'Provider base URL not configured' });
      }

      // 构建 count tokens API URL
      const countTokensUrl = baseUrl.replace(/\/+$/, '') + countTokenPath;

      // 读取会话文件中的实际消息
      const sessionPath = path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
      let sessionData = {};
      let actualMessages = [];
      try {
        sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
        const rawMessages = sessionData?.runtime?.context?.messages || [];
        actualMessages = transformMessagesForTokenCount(rawMessages);
      } catch {}

      // 如果没有消息，无法计数
      if (!actualMessages.length) {
        return res.status(400).json({
          success: false,
          error: '会话中没有可用的消息，无法计数',
        });
      }

      // 调用 count tokens API，使用实际消息
      try {
        const countRequest = {
          model: modelName,
          messages: actualMessages,
        };

        const response = await fetch(countTokensUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
          },
          body: JSON.stringify(countRequest),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Count tokens API failed: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        const tokenCount = result.input_tokens || result.inputTokens;

        if (typeof tokenCount !== 'number' || tokenCount < 0) {
          return res.status(500).json({
            success: false,
            error: 'Count tokens API did not return a valid token count',
            details: result,
          });
        }

        // 写入路径须与 summarizePrebuiltSession 读取路径一致: runtime.usageStats.lastRequestUsage
        if (!sessionData.runtime) sessionData.runtime = {};
        if (!sessionData.runtime.usageStats) sessionData.runtime.usageStats = {};
        sessionData.runtime.usageStats.lastRequestUsage = {
          inputTokens: tokenCount,
          outputTokens: 0,
          totalTokens: tokenCount,
        };
        sessionData.modelName = modelName;
        sessionData.updatedAt = new Date().toISOString();

        await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

        res.json({
          success: true,
          tokenCount,
        });
      } catch (fetchError) {
        return res.status(500).json({
          success: false,
          error: `Failed to call count tokens API: ${fetchError.message}`,
        });
      }
    } catch (error) {
      next(error);
    }
  });
}
