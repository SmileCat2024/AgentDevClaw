/**
 * 会话标题能力（ADR-0041 决策 3）。
 *
 * 本模块只提供「怎么做」，不判断「该不该做」：何时生成、用什么提示词、
 * 选哪个模型、是否更新已有标题，全部由调用方（应用装配层 / 路由）决定。
 * OS 侧的职责收敛为三件事——按明确身份定位会话、把生成参数带到执行端、
 * 在校验通过的条件下把结果写成 Session 的标题。
 *
 * 两个能力：
 *
 *   generateSessionTitle  按会话生成。OS 读会话内容、调用模型、校验并落盘；
 *                         提示词规则 / 模型角色 / 上下文范围参数化，缺省值
 *                         等于 ADR-0041 改造前的硬编码行为。
 *   writeSessionTitle     直接写入。调用方自带标题文本，OS 只做格式校验与
 *                         来源标记。应用自己算好标题时用它，不必走模型。
 *
 * 不传参数的旧调用方行为不变，这是本模块的兼容底线。
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { validateTitleText, MAX_TITLE_LENGTH } from './title-text.js';
import {
  SESSION_TITLE_STATE,
  isTitleUserOwned,
  normalizeSessionTitleState,
} from './session-access.js';

/** 标题来源：谁写的，决定后续可否被自动更新。 */
export const TITLE_SOURCE = Object.freeze({
  /** 应用策略写入（生成或直接提交）——可被后续策略更新。 */
  APP: 'app',
  /** 用户手动改名——受覆盖保护。 */
  USER: 'user',
});

/**
 * 生成参数缺省值：与 ADR-0041 改造前的硬编码行为逐项一致。
 * 旧调用方不传 params 时，走的仍是这套值，行为不变。
 */
export const DEFAULT_TITLE_PARAMS = Object.freeze({
  /** 模型角色，经 resolveAgentModelLLM 解析。 */
  modelRole: 'system',
  /** 额外标题规则，追加在内置 TITLE_RULES 之后；空串表示只用内置规则。 */
  instructions: '',
  /** 上下文范围。 */
  contextRange: Object.freeze({
    recentMessages: 32,
    includeFirstUserMessage: true,
  }),
});

/**
 * 归一化生成参数。非法值逐项回落到缺省值，不回落到"空"——调用方写错一个
 * 字段不应该让生成退化成不带上下文或没有规则的样子。
 */
export function normalizeTitleParams(params) {
  const input = params && typeof params === 'object' ? params : {};
  const modelRole = String(input.modelRole || '').trim() || DEFAULT_TITLE_PARAMS.modelRole;
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';
  const range = input.contextRange && typeof input.contextRange === 'object'
    ? input.contextRange
    : {};
  const recent = Number(range.recentMessages);
  return {
    modelRole,
    instructions,
    contextRange: {
      recentMessages: Number.isFinite(recent) && recent > 0
        ? Math.min(Math.floor(recent), 200)
        : DEFAULT_TITLE_PARAMS.contextRange.recentMessages,
      includeFirstUserMessage: range.includeFirstUserMessage === undefined
        ? DEFAULT_TITLE_PARAMS.contextRange.includeFirstUserMessage
        : range.includeFirstUserMessage === true,
    },
  };
}

// 校验规则与 mirror 子进程同源（见 title-text.js）。
export { validateTitleText, MAX_TITLE_LENGTH };

/** Session 记录是否允许被这次写入改写（ADR-0041 决策 5）。 */
export function canOverwriteTitle(record, { allowUserOverride = false } = {}) {
  if (!record) return false;
  if (isTitleUserOwned(record) && !allowUserOverride) return false;
  return true;
}

/**
 * 建立标题能力。
 *
 * 依赖全部注入，测试可替换执行端而不必启动真实子进程。生产装配见
 * `createDefaultSessionTitleDeps()`。
 *
 * @param {object} deps
 * @param {(agentId: string, sessionId: string) => Promise<object|null>} deps.findRecord
 * @param {(agentId: string, mutator: Function) => Promise<object>} deps.updateIndex
 * @param {(request: object) => Promise<{ title: string }>} deps.runGeneration
 */
export function createSessionTitleService(deps) {
  const { findRecord, updateIndex, runGeneration } = deps;

  /**
   * 按会话生成标题。
   *
   * @returns {Promise<
   *   { ok: true, title: string, changed: boolean, skipped?: string } |
   *   { ok: false, reason: string }
   * >}
   *   `skipped` 表示按契约主动放弃（用户已接管），不是失败。
   */
  async function generateSessionTitle({ agentId, sessionId, params, allowUserOverride = false }) {
    const record = await findRecord(agentId, sessionId);
    if (!record) {
      return { ok: false, reason: 'session_not_found' };
    }
    // 跳过要发生在调用模型之前：既省掉无意义的模型调用，也避免迟到的结果
    // 与用户的选择竞争。
    if (!canOverwriteTitle(record, { allowUserOverride })) {
      return { ok: true, title: record.title || '', changed: false, skipped: 'user_owned_title' };
    }

    let generated;
    try {
      generated = await runGeneration({
        agentId,
        sessionId,
        params: normalizeTitleParams(params),
      });
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }

    const validated = validateTitleText(generated?.title);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason };
    }
    return applyTitle({
      agentId,
      sessionId,
      title: validated.title,
      source: TITLE_SOURCE.APP,
      allowUserOverride,
    });
  }

  /**
   * 直接写入标题：调用方自带文本，不经过模型。
   *
   * @returns {Promise<
   *   { ok: true, title: string, changed: boolean, skipped?: string } |
   *   { ok: false, reason: string }
   * >}
   */
  async function writeSessionTitle({
    agentId, sessionId, title, source = TITLE_SOURCE.APP, allowUserOverride = false,
  }) {
    const record = await findRecord(agentId, sessionId);
    if (!record) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (!canOverwriteTitle(record, { allowUserOverride })) {
      return { ok: true, title: record.title || '', changed: false, skipped: 'user_owned_title' };
    }
    const validated = validateTitleText(title);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason };
    }
    return applyTitle({
      agentId,
      sessionId,
      title: validated.title,
      source: source === TITLE_SOURCE.USER ? TITLE_SOURCE.USER : TITLE_SOURCE.APP,
      allowUserOverride,
    });
  }

  /**
   * 落盘。写在索引事务内二次判定来源——生成期间用户可能刚改过名，
   * 此时迟到的结果必须丢弃，而不是覆盖用户的选择。
   */
  async function applyTitle({ agentId, sessionId, title, source, allowUserOverride }) {
    const nextState = source === TITLE_SOURCE.USER
      ? SESSION_TITLE_STATE.USER
      : SESSION_TITLE_STATE.AUTO;
    const updatedIndex = await updateIndex(agentId, (index) => {
      const at = index.sessions.findIndex((session) => session.id === sessionId);
      if (at === -1) return index;
      if (!canOverwriteTitle(index.sessions[at], { allowUserOverride })) return index;
      index.sessions[at].title = title;
      index.sessions[at].titleState = nextState;
      index.sessions[at].updatedAt = new Date().toISOString();
      return index;
    });
    const updated = updatedIndex.sessions.find((session) => session.id === sessionId) || null;
    // 被挡下时落盘的仍是原值；回报实际生效的标题，避免调用方乐观写入一个
    // 并未保存的值。
    const applied = String(updated?.title || '').trim();
    const effective = applied || title;
    return { ok: true, title: effective, changed: effective === title };
  }

  return { generateSessionTitle, writeSessionTitle };
}

/**
 * 生产装配：把子进程执行端接到默认依赖上。
 *
 * 子进程方式保持不变（标题生成需要恢复完整会话上下文，走独立进程可避免
 * 与 runtime 的模型实例互相影响）。参数经 optionsJson 下发，脚本端按缺省值
 * 兼容旧调用。
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {string} options.mirrorScriptPath
 * @param {number} options.timeoutMs
 * @param {Promise<object>} options.sessionAccess  session-access 模块（延迟导入）
 * @param {() => Record<string, string>} options.childEnv
 * @param {(agentId: string) => Promise<{ relativeDir: string }>} options.resolveAgentDir
 * @param {() => string} [options.serverOrigin]
 */
export function createDefaultSessionTitleDeps({
  projectRoot,
  mirrorScriptPath,
  timeoutMs,
  sessionAccess,
  childEnv,
  resolveAgentDir,
  log = console.log,
}) {
  return {
    findRecord: (agentId, sessionId) => sessionAccess.findPrebuiltSessionRecordShared(agentId, sessionId),
    updateIndex: (agentId, mutator) => sessionAccess.updateSessionIndex(agentId, mutator),

    async runGeneration({ agentId, sessionId, params }) {
      const agent = await resolveAgentDir(agentId);
      if (!agent?.relativeDir) {
        throw new Error('Agent directory not resolved');
      }
      // 新创建的会话（尤其 trim / summary 衍生会话）在 runtime 首次保存前
      // 磁盘上没有 JSON，mirror 子进程加载会 ENOENT。提前给明确错误。
      try {
        await fs.access(sessionAccess.getPrebuiltSessionFilePath(agentId, sessionId));
      } catch {
        throw new Error('Session file not yet written to disk');
      }

      const resultDir = path.join(os.tmpdir(), `title-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
      const resultPath = path.join(resultDir, 'result.json');
      await fs.mkdir(resultDir, { recursive: true });

      const child = spawn(
        process.execPath,
        [mirrorScriptPath, agent.relativeDir, agentId, sessionId, JSON.stringify({ maxAttempts: 3, params }), resultPath],
        {
          cwd: path.join(projectRoot, 'server'),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: childEnv(),
        },
      );

      let stderr = '';
      let timedOut = false;
      let exitCode = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderr += text;
        for (const line of text.split('\n')) {
          if (line.trim()) log(`[title-mirror] ${line.trimEnd()}`);
        }
      });

      await new Promise((resolve, reject) => {
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          exitCode = code;
          resolve();
        });
      });

      // 成败以落盘的 result.json 为准：writeFileSync 在子进程任何退出路径之前
      // 同步完成。Windows 上退出阶段可能因 libuv 与 keep-alive socket 的竞态
      // fail-fast（退出码非零），此时结果已完整写盘，不能按退出码判失败。
      try {
        const raw = await fs.readFile(resultPath, 'utf8');
        const parsed = JSON.parse(raw.trim());
        const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
        if (!title) {
          throw new Error('Title generation returned empty result');
        }
        return { title };
      } catch (error) {
        if (timedOut) {
          throw new Error(`Title generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
        }
        if (error?.message === 'Title generation returned empty result') throw error;
        throw new Error(stderr.trim() || `run-title-mirror exited with code ${exitCode}`);
      } finally {
        await fs.rm(resultDir, { recursive: true, force: true }).catch(e => console.warn(e));
      }
    },
  };
}

/**
 * 状态判定辅助：调用方判断某会话此刻是否还该起名时用它，不要比对标题文本。
 * @returns {'placeholder'|'auto'|'user'|null}  null 表示来源未知（改造前记录）
 */
export function readTitleState(record) {
  return normalizeSessionTitleState(record?.titleState);
}
