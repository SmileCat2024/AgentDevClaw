/**
 * Git 面板路由（feature 无关，产品 Chrome 层）
 *
 * POST /protoclaw/git/status   body: { dir }            → 仓库状态（porcelain 解析）
 * POST /protoclaw/git/stage    body: { dir, files? }    → 暂存指定文件（缺省 = 全部暂存）
 * POST /protoclaw/git/unstage  body: { dir, files? }    → 取消暂存（缺省 = 全部取消）
 * POST /protoclaw/git/commit   body: { dir, message }   → 提交暂存区
 * POST /protoclaw/git/discard  body: { dir, files: [] } → 丢弃工作区/暂存区改动（不可逆）
 *
 * ── 远程命名空间分支（ADR-0011）──────────────────────────────
 * 全部端点均按同一套路接入远程命名空间分支：请求体 agentId 携带宿主级
 * 命名空间身份（remote:<connId>:<hostId>）→ resolveForwardHostTarget 派生
 * 连接 → forwardProtoclawRoute 转发远程同名路由，body 原样转发（dir 是远程
 * 机本地路径，远程端自己 validateDir/resolveGitRoot），身份字段 bareId 展开。
 * 写端点（stage/unstage/commit/discard/branch/stash）远程分支强制幂等键
 * （400 idempotency_key_required）；读端点（status/graph/branches/
 * commit_files）不强制。本地身份（无 agentId 或非命名空间）走既有本地
 * git 执行路径，字节级不动。
 *
 * ── 实现来源声明 ──────────────────────────────────────────────
 * status porcelain 解析器（FileStatusSummary / StatusSummary /
 * parseStatusSummary / splitLine / LineParser / parseStringResponse /
 * parseCommitResult）与各操作命令的构造，移植自 simple-git（git-js）原版实现：
 *   https://github.com/steveukx/git-js  (MIT License, Copyright Steve King)
 * 按原样搬运其经测试的解析逻辑，仅做 TS → JS 直译与本项目风格适配。
 * 命令对照（与 simple-git 任务构造一致）：
 *   status:  git status --porcelain -b -u --null
 *   add:     git add -- <paths>            （全部暂存: git add -A）
 *   reset:   git reset --mixed -- <paths>  （全部取消: git reset --mixed）
 *   commit:  git -c core.abbrev=40 commit -m <message>...
 *   checkout:git checkout -- <paths>
 *   clean:   git clean -f -d -- <paths>
 */

import { promises as fs } from 'fs';
import path from 'path';
import { runCommand } from './fs-operations.js';
import {
  bareId,
  resolveForwardHostTarget,
  forwardProtoclawRoute,
  readForwardTargetError,
} from '../shared/remote-forward.js';
import { buildLocalFailureResponse, readOperationMetadata } from '../shared/operation-contract.js';

// ═══════════════════════════════════════════════════════════════
// 移植自 simple-git：utils（util.ts / argument-filters.ts / line-parser.ts / task-parser.ts）
// ═══════════════════════════════════════════════════════════════

const NULL = '\0';

function toLinesWithContent(input = '', trimmed = true, separator = '\n') {
  return input.split(separator).reduce((output, line) => {
    const lineContent = trimmed ? line.trim() : line;
    if (lineContent) {
      output.push(lineContent);
    }
    return output;
  }, []);
}

function asArray(input) {
  return Array.isArray(input) ? input : [input];
}

function filterType(input, filter, def) {
  if (filter(input)) {
    return input;
  }
  return arguments.length > 2 ? def : undefined;
}

function filterString(input) {
  return typeof input === 'string';
}

class LineParser {
  constructor(regExp, useMatches) {
    this._regExp = Array.isArray(regExp) ? regExp : [regExp];
    this.matches = [];
    this.useMatches = useMatches || (() => { throw new Error('LineParser:useMatches not implemented'); });
  }

  parse = (line, target) => {
    this.resetMatches();

    if (!this._regExp.every((reg, index) => this.addMatch(reg, index, line(index)))) {
      return false;
    }

    return this.useMatches(target, this.prepareMatches()) !== false;
  };

  resetMatches() {
    this.matches.length = 0;
  }

  prepareMatches() {
    return this.matches;
  }

  addMatch(reg, index, line) {
    const matched = line && reg.exec(line);
    if (matched) {
      this.pushMatch(index, matched);
    }

    return !!matched;
  }

  pushMatch(_index, matched) {
    this.matches.push(...matched.slice(1));
  }
}

function parseStringResponse(result, parsers, texts, trim = true) {
  asArray(texts).forEach((text) => {
    for (let lines = toLinesWithContent(text, trim), i = 0, max = lines.length; i < max; i++) {
      const line = (offset = 0) => {
        if (i + offset >= max) {
          return;
        }
        return lines[i + offset];
      };

      parsers.some(({ parse }) => parse(line, result));
    }
  });

  return result;
}

// ═══════════════════════════════════════════════════════════════
// 移植自 simple-git：responses/FileStatusSummary.ts
// ═══════════════════════════════════════════════════════════════

const fromPathRegex = /^(.+)\0(.+)$/;

class FileStatusSummary {
  constructor(filePath, index, working_dir) {
    this.path = filePath;
    this.index = index;
    this.working_dir = working_dir;
    if (index === 'R' || working_dir === 'R') {
      const detail = fromPathRegex.exec(filePath) || [null, filePath, filePath];
      this.from = detail[2] || '';
      this.path = detail[1] || '';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 移植自 simple-git：responses/StatusSummary.ts
// ═══════════════════════════════════════════════════════════════

function renamedFile(line) {
  const [to, from] = line.split(NULL);

  return {
    from: from || to,
    to,
  };
}

function parser(indexX, indexY, handler) {
  return [`${indexX}${indexY}`, handler];
}

function conflicts(indexX, ...indexY) {
  return indexY.map((y) => parser(indexX, y, (result, file) => result.conflicted.push(file)));
}

const statusParsers = new Map([
  parser(' ', 'A', (result, file) => result.created.push(file)),
  parser(' ', 'D', (result, file) => result.deleted.push(file)),
  parser(' ', 'M', (result, file) => result.modified.push(file)),

  parser('A', ' ', (result, file) => {
    result.created.push(file);
    result.staged.push(file);
  }),
  parser('A', 'M', (result, file) => {
    result.created.push(file);
    result.staged.push(file);
    result.modified.push(file);
  }),

  parser('D', ' ', (result, file) => {
    result.deleted.push(file);
    result.staged.push(file);
  }),

  parser('M', ' ', (result, file) => {
    result.modified.push(file);
    result.staged.push(file);
  }),
  parser('M', 'M', (result, file) => {
    result.modified.push(file);
    result.staged.push(file);
  }),

  parser('R', ' ', (result, file) => {
    result.renamed.push(renamedFile(file));
  }),
  parser('R', 'M', (result, file) => {
    const renamed = renamedFile(file);
    result.renamed.push(renamed);
    result.modified.push(renamed.to);
  }),
  parser('!', '!', (result, file) => {
    (result.ignored = result.ignored || []).push(file);
  }),

  parser('?', '?', (result, file) => result.not_added.push(file)),

  ...conflicts('A', 'A', 'U'),
  ...conflicts('D', 'D', 'U'),
  ...conflicts('U', 'A', 'D', 'U'),

  [
    '##',
    (result, line) => {
      const aheadReg = /ahead (\d+)/;
      const behindReg = /behind (\d+)/;
      const currentReg = /^(.+?(?=(?:\.{3}|\s|$)))/;
      const trackingReg = /\.{3}(\S*)/;
      const onEmptyBranchReg = /\son\s(\S+?)(?=\.{3}|$)/;

      let regexResult = aheadReg.exec(line);
      result.ahead = (regexResult && +regexResult[1]) || 0;

      regexResult = behindReg.exec(line);
      result.behind = (regexResult && +regexResult[1]) || 0;

      regexResult = currentReg.exec(line);
      result.current = filterType(regexResult?.[1], filterString, null);

      regexResult = trackingReg.exec(line);
      result.tracking = filterType(regexResult?.[1], filterString, null);

      regexResult = onEmptyBranchReg.exec(line);
      if (regexResult) {
        result.current = filterType(regexResult?.[1], filterString, result.current);
      }

      result.detached = /\(no branch\)/.test(line);
    },
  ],
]);

function parseStatusSummary(text) {
  const lines = text.split(NULL);
  const status = {
    not_added: [],
    conflicted: [],
    created: [],
    deleted: [],
    modified: [],
    renamed: [],
    files: [],
    staged: [],
    ahead: 0,
    behind: 0,
    current: null,
    tracking: null,
    detached: false,
  };

  for (let i = 0, l = lines.length; i < l;) {
    let line = lines[i++].trim();

    if (!line) {
      continue;
    }

    if (line.charAt(0) === 'R') {
      line += NULL + (lines[i++] || '');
    }

    splitLine(status, line);
  }

  return status;
}

function splitLine(result, lineStr) {
  const trimmed = lineStr.trim();
  switch (' ') {
    case trimmed.charAt(2):
      return data(trimmed.charAt(0), trimmed.charAt(1), trimmed.slice(3));
    case trimmed.charAt(1):
      return data(' ', trimmed.charAt(0), trimmed.slice(2));
  }

  function data(index, workingDir, filePath) {
    const raw = `${index}${workingDir}`;
    const handler = statusParsers.get(raw);

    if (handler) {
      handler(result, filePath);
    }

    if (raw !== '##' && raw !== '!!') {
      result.files.push(new FileStatusSummary(filePath, index, workingDir));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 移植自 simple-git：parsers/parse-commit.ts
// ═══════════════════════════════════════════════════════════════

const commitParsers = [
  new LineParser(/^\[([^\s]+)( \([^)]+\))? ([^\]]+)/, (result, [branch, root, commit]) => {
    result.branch = branch;
    result.commit = commit;
    result.root = !!root;
  }),
  new LineParser(/\s*Author:\s(.+)/i, (result, [author]) => {
    const parts = author.split('<');
    const email = parts.pop();

    if (!email || !email.includes('@')) {
      return;
    }

    result.author = {
      email: email.substr(0, email.length - 1),
      name: parts.join('<').trim(),
    };
  }),
  new LineParser(
    /(\d+)[^,]*(?:,\s*(\d+)[^,]*)(?:,\s*(\d+))/g,
    (result, [changes, insertions, deletions]) => {
      result.summary.changes = parseInt(changes, 10) || 0;
      result.summary.insertions = parseInt(insertions, 10) || 0;
      result.summary.deletions = parseInt(deletions, 10) || 0;
    }
  ),
  new LineParser(
    /^(\d+)[^,]*(?:,\s*(\d+)[^(]+\(([+-]))?/,
    (result, [changes, lines, direction]) => {
      result.summary.changes = parseInt(changes, 10) || 0;
      const count = parseInt(lines, 10) || 0;
      if (direction === '-') {
        result.summary.deletions = count;
      } else if (direction === '+') {
        result.summary.insertions = count;
      }
    }
  ),
];

function parseCommitResult(stdOut) {
  const result = {
    author: null,
    branch: '',
    commit: '',
    root: false,
    summary: {
      changes: 0,
      insertions: 0,
      deletions: 0,
    },
  };
  return parseStringResponse(result, commitParsers, stdOut);
}

// ═══════════════════════════════════════════════════════════════
// 路由层：薄封装（命令构造对照 simple-git 任务）
// ═══════════════════════════════════════════════════════════════

async function runGit(args, cwd) {
  const { stdout } = await runCommand('git', args, { cwd });
  return stdout;
}

/**
 * 解析目录所属 git 仓库根；非仓库返回 null（stderr 特征判别）。
 *
 * 结果缓存：仓库根几乎不变，命中缓存后正常刷新路径不再跑 rev-parse，
 * 把该命令的失败面压缩到趋零（仅首次解析）；非仓库负结果短 TTL 缓存，
 * 不阻碍 git init 后的重新识别。空输出属异常（瞬时故障），原地重试
 * 一次后仍空才报错。
 */
const rootCache = new Map(); // dir → { root: string|null, at: number }
const ROOT_TTL_MS = 10 * 60 * 1000; // 仓库根缓存有效期（过期后重验一次）
const ROOT_NEG_TTL_MS = 30 * 1000;  // 非仓库负结果有效期

async function resolveGitRootUncached(dir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stdout = await runGit(['rev-parse', '--show-toplevel'], dir);
      // --show-toplevel 的斜杠方向随 git 版本/调用环境不定（2.47 msys 输出
      // 正斜杠），归一为平台原生分隔符，保证与 path.resolve 产物可比较
      const root = path.normalize(stdout.trim());
      if (root) return root;
      // 空输出属异常（stdout 未收齐/瞬时故障），重试一次
    } catch (error) {
      const message = String(error?.message || error || '');
      if (/not a git repository|no git repository/i.test(message)) {
        return null;
      }
      throw error;
    }
  }
  throw new Error('git rev-parse returned empty output');
}

async function resolveGitRoot(dir) {
  const now = Date.now();
  const hit = rootCache.get(dir);
  if (hit) {
    const ttl = hit.root === null ? ROOT_NEG_TTL_MS : ROOT_TTL_MS;
    if (now - hit.at < ttl) return hit.root;
  }
  const root = await resolveGitRootUncached(dir);
  rootCache.set(dir, { root, at: now });
  return root;
}

/** 校验请求目录并归一化；非法时抛 statusCode=400 错误 */
async function validateDir(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const error = new Error('dir is required');
    error.statusCode = 400;
    throw error;
  }
  const resolved = path.resolve(raw);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const error = new Error('dir is not a directory');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

/** 校验文件路径数组：过滤非法项并限量 */
function normalizeFiles(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    const error = new Error('files must be an array of paths');
    error.statusCode = 400;
    throw error;
  }
  const files = input.map((f) => String(f || '').trim()).filter(Boolean);
  if (files.length !== input.length) {
    const error = new Error('files contains invalid entries');
    error.statusCode = 400;
    throw error;
  }
  if (files.length > 5000) {
    const error = new Error('too many files');
    error.statusCode = 400;
    throw error;
  }
  return files;
}

/** 状态序列化为纯 JSON（files 保留 from 字段用于 rename 展示） */
function serializeStatus(status) {
  return {
    ...status,
    isClean: status.files.length === 0,
    files: status.files.map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir, from: f.from || null })),
  };
}

/** porcelain 状态查询（不含 -b 分支头），供 discard 分类使用 */
async function statusFilesAt(root) {
  const text = await runGit(['status', '--porcelain', '-u', '--null'], root);
  return parseStatusSummary(text).files;
}

/** 判断是否冲突状态（porcelain: DD/AU/UD/UA/DU/AA/UU） */
function isConflictCode(index, workingDir) {
  return index === 'U' || workingDir === 'U'
    || (index === 'A' && workingDir === 'A')
    || (index === 'D' && workingDir === 'D');
}

function routeError(res, error) {
  const status = Number(error?.statusCode) || 500;
  res.status(status).json({ error: String(error?.message || error || 'git operation failed') });
}

// ═══════════════════════════════════════════════════════════════
// 远程命名空间分支（ADR-0011 protoclaw 域适配套路，ADR-0008 #5：host 默认
// 本地、远程必须显式）
//
// git 端点是 host-plane 目录寻址操作（body.dir = 执行 git 的目录）。远程会话
// 的目录（catalog projectDir）是远程机本地路径，本地无法校验——身份必须显式
// 携带：请求体 agentId 为 remote: 命名空间 id → resolveForwardHostTarget 派生
// 连接 → forwardProtoclawRoute 转发远程同名路由。body 原样转发（dir 是远程机
// 本地路径，远程端自己 validateDir/resolveGitRoot，本地不复刻任何 git 逻辑），
// 身份字段 bareId 展开。本地身份（无 agentId 或非命名空间）走既有本地路径，
// 字节级不动（agentId 被本地分支忽略）；远程身份也永不 fallback 到本地执行
// （ADR-0008 #1），未知/停用连接按 RequestTargetError 契约（404 / 503
// retryable）呈现。
// ═══════════════════════════════════════════════════════════════

// ADR-0011：远程写幂等闸（写端点集合；status/graph/branches/commit_files 读
// 端点不强制）。远程目标 + 无 idempotencyKey → 400 且请求不过隧道；本地路径
// 保持现状不强制（session.js / proxy.js 同族契约）。
const GIT_WRITE_OPS = new Set(['stage', 'unstage', 'commit', 'discard', 'branch', 'stash']);

function requireRemoteGitIdempotencyKey(req, res) {
  const metadata = readOperationMetadata(req);
  if (metadata.idempotencyKey) return true;
  res.status(400).json({
    ok: false,
    code: 'idempotency_key_required',
    retryable: false,
    operationId: metadata.operationId || null,
    message: 'Remote write operations require an idempotency key (x-idempotency-key)',
    error: 'Remote write operations require an idempotency key (x-idempotency-key)',
  });
  return false;
}

/**
 * 识别 body 命名空间身份（agentId，宿主级命名空间 id）：`remote:` 前缀 →
 * resolveForwardHostTarget 派生连接 → forwardProtoclawRoute 转发远程同名 git
 * 路由，返回远程响应原文。body 原样转发（dir 是远程机本地路径，远程端自己
 * validateDir/resolveGitRoot，本地不复刻任何 git 逻辑），仅身份字段 bareId
 * 展开。本地分支返回 false（零网络、不改写请求）；远程分支处理后返回 true。
 * 写端点远程分支强制幂等键（400 idempotency_key_required，请求不过隧道），
 * 读端点不强制。
 */
async function forwardRemoteGitIfNamespaced(req, res, op) {
  try {
    const hostTarget = resolveForwardHostTarget(req.body?.agentId);
    if (hostTarget.scope !== 'remote') return false;
    if (GIT_WRITE_OPS.has(op) && !requireRemoteGitIdempotencyKey(req, res)) return true;
    await forwardProtoclawRoute(res, hostTarget, `/protoclaw/git/${op}`, {
      method: 'POST',
      // dir 原样转发：它是远程机的合法路径，远程端自己 validateDir/resolveGitRoot
      body: { ...(req.body || {}), agentId: bareId(req.body?.agentId) },
    });
    return true;
  } catch (error) {
    res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    return true;
  }
}

export function setupGitRoutes(app, express) {
  app.post('/protoclaw/git/status', express.json(), async (req, res) => {
    try {
      // 远程命名空间身份 → 转发远程同名路由（dir 原样，远程端自己校验）；
      // 本地身份走下方既有路径，行为字节级不动。读端点，无幂等闸。
      if (await forwardRemoteGitIfNamespaced(req, res, 'status')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.json({ ok: true, isRepo: false });
        return;
      }
      const text = await runGit(['status', '--porcelain', '-b', '-u', '--null'], root);
      res.json({ ok: true, isRepo: true, root, status: serializeStatus(parseStatusSummary(text)) });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post('/protoclaw/git/stage', express.json(), async (req, res) => {
    try {
      // 远程命名空间身份 → 转发远程同名路由；本地身份字节级不动。写端点，
      // 远程分支强制幂等键（见 forwardRemoteGitIfNamespaced）。
      if (await forwardRemoteGitIfNamespaced(req, res, 'stage')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const files = req.body?.files == null ? null : normalizeFiles(req.body.files);
      // simple-git add: ['add', ...files]；全部暂存用 -A
      await runGit(files == null ? ['add', '-A'] : ['add', '--', ...files], root);
      res.json({ ok: true });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post('/protoclaw/git/unstage', express.json(), async (req, res) => {
    try {
      if (await forwardRemoteGitIfNamespaced(req, res, 'unstage')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const files = req.body?.files == null ? null : normalizeFiles(req.body.files);
      // simple-git reset: ['reset', '--mixed', ...customArgs]
      await runGit(files == null ? ['reset', '--mixed'] : ['reset', '--mixed', '--', ...files], root);
      res.json({ ok: true });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post('/protoclaw/git/commit', express.json(), async (req, res) => {
    try {
      if (await forwardRemoteGitIfNamespaced(req, res, 'commit')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const message = String(req.body?.message || '').trim();
      if (!message) {
        res.status(400).json({ error: 'message is required' });
        return;
      }
      // simple-git commit: ['-c', 'core.abbrev=40', 'commit', ...prefixedArray(messages, '-m')]
      // 多行消息拆为多个 -m（git 以空行分段），同时规避 Windows cmd 换行传参问题
      const messages = message.split(/\r?\n/).map((m) => m.trim()).filter(Boolean);
      const commands = ['-c', 'core.abbrev=40', 'commit', ...messages.flatMap((m) => ['-m', m])];
      const stdout = await runGit(commands, root);
      res.json({ ok: true, commit: parseCommitResult(stdout) });
    } catch (error) {
      routeError(res, error);
    }
  });

  app.post('/protoclaw/git/discard', express.json(), async (req, res) => {
    try {
      // discard 是破坏性写：远程分支照常转发（前端既有确认流不新增层），
      // 远程分支强制幂等键。
      if (await forwardRemoteGitIfNamespaced(req, res, 'discard')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const requested = normalizeFiles(req.body?.files);
      if (requested.length === 0) {
        res.status(400).json({ error: 'files is required' });
        return;
      }

      // 以最新 porcelain 状态为准分类（不信任客户端带来的状态副本）
      const fileMap = new Map();
      for (const f of await statusFilesAt(root)) {
        fileMap.set(f.path, f);
      }

      const resetList = [];      // 有暂存改动的：先 reset 回 HEAD
      const checkoutList = [];   // HEAD 中存在的工作区改动：checkout -- 恢复
      const cleanList = [];      // 未跟踪（含 reset 后变为未跟踪的新增）：clean -f -d 移除
      const unsupported = [];

      for (const p of requested) {
        const f = fileMap.get(p);
        if (!f) {
          continue; // 请求的文件已无改动，视为已丢弃
        }
        if (f.index === 'R' || f.working_dir === 'R' || isConflictCode(f.index, f.working_dir)) {
          unsupported.push(p);
          continue;
        }
        if (f.index === '?') {
          cleanList.push(p);
          continue;
        }
        if (f.index !== ' ') {
          resetList.push(p);
          // staged-A：HEAD 中不存在，reset 后是未跟踪文件 → clean；
          // 其余 staged-M/D：reset 后仍需 checkout 恢复工作区
          (f.index === 'A' ? cleanList : checkoutList).push(p);
        } else {
          checkoutList.push(p);
        }
      }

      if (unsupported.length > 0) {
        res.status(400).json({
          error: `暂不支持丢弃重命名/冲突状态的文件: ${unsupported.slice(0, 5).join(', ')}${unsupported.length > 5 ? ' ...' : ''}`,
        });
        return;
      }

      if (resetList.length > 0) {
        await runGit(['reset', '--mixed', '--', ...resetList], root);
      }
      if (checkoutList.length > 0) {
        await runGit(['checkout', '--', ...checkoutList], root);
      }
      // clean 只对工作区中仍存在的文件执行（如 A+D：reset 后文件本就不在磁盘上）
      const cleanTargets = [];
      for (const p of cleanList) {
        const exists = await fs.stat(path.join(root, p)).then((s) => s.isFile() || s.isDirectory(), () => false);
        if (exists) cleanTargets.push(p);
      }
      if (cleanTargets.length > 0) {
        await runGit(['clean', '-f', '-d', '--', ...cleanTargets], root);
      }

      res.json({ ok: true, discarded: requested.length });
    } catch (error) {
      routeError(res, error);
    }
  });

  // ── 提交历史图（供前端 SVG lane 绘制，非字符画）─────────────────
  // 输出：[{ hash, parents:[], author, relTime, subject, refs:[] }]，refs 含
  // 本地/远程分支、HEAD、tag。解析用 NUL 分隔，避免 subject 含空格/引号问题。
  app.post('/protoclaw/git/graph', express.json(), async (req, res) => {
    try {
      if (await forwardRemoteGitIfNamespaced(req, res, 'graph')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 1000);
      // 可指定分支/引用查看其历史（图形区分支选择器）；默认当前分支 HEAD
      const branch = String(req.body?.branch || '').trim();
      const branchArgs = branch ? [branch, '--'] : [];
      const format = '%H%x1f%P%x1f%an%x1f%ar%x1f%D%x1f%s';
      let text;
      try {
        // --topo-order：保证父提交恒在子提交之后输出（lane 算法的前提，
        // 与 VS Code Git Graph 行为一致；默认时间序在 rebase 历史上会乱序）
        const args = ['log', `-n${limit}`, '--topo-order', '--pretty=format:' + format, '--date=relative'];
        args.push(...branchArgs);
        text = await runGit(args, root);
      } catch (error) {
        // 空仓库（尚无任何提交）不是错误：返回空历史
        if (/does not have any commits yet|ambiguous argument 'HEAD'/i.test(String(error?.message || error))) {
          res.json({ ok: true, root, commits: [] });
          return;
        }
        throw error;
      }
      const commits = [];
      // format 输出按行分隔；%s subject 恒为单行，字段用 \x1f 分隔
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        const [hash, parents, author, relTime, refs, subject] = raw.split('\x1f');
        if (!hash) continue;
        commits.push({
          hash: hash.slice(0, 12),
          fullHash: hash,
          // parents 与 hash 统一截断 12 位：lane 算法靠哈希等值匹配定位行号，
          // 长度不一致会导致所有边匹配失败、图形全乱
          parents: (parents || '').split(' ').map((s) => s.trim().slice(0, 12)).filter(Boolean),
          author: author || '',
          relTime: relTime || '',
          refs: parseRefs(refs || ''),
          subject: subject || '',
        });
      }
      // 未推送提交（@{upstream}..HEAD）：供前端画「传出的更改」分组与虚线节点。
      // 无上游/失败时为空集——这只是装饰性信息，不应拖垮整个图。
      let aheadHashes = [];
      try {
        // 完整哈希 %H 再截 12 位，与 commits[].hash 严格一致（短哈希不匹配
        // 会导致前端 aheadSet 全部脱靶、虚线节点画不出来）
        const aheadText = await runGit(['rev-list', '--pretty=format:%H', '@{upstream}..HEAD'], root);
        aheadHashes = aheadText.split('\n')
          .map((l) => l.trim().slice(0, 12))
          .filter((l) => l && !l.startsWith('commit '));
      } catch (e) { /* 无上游等情况：保持空集 */ }
      res.json({ ok: true, root, commits, aheadHashes });
    } catch (error) {
      routeError(res, error);
    }
  });

  // ── 某次提交改了哪些文件（点节点展开）────────────────────────────
  app.post('/protoclaw/git/commit_files', express.json(), async (req, res) => {
    try {
      if (await forwardRemoteGitIfNamespaced(req, res, 'commit_files')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const ref = String(req.body?.hash || '').trim();
      if (!ref) {
        res.status(400).json({ error: 'hash is required' });
        return;
      }
      const text = await runGit(['show', '--stat', '--pretty=format:', '--no-color', ref], root);
      // --stat 行形如： path | 12 ++++++----
      const files = [];
      for (const line of text.split('\n')) {
        const m = line.match(/^(.+?)\s*\|\s*(\d+)\s*([+-]*)\s*$/);
        if (!m) continue;
        const name = m[1].trim();
        if (name === 'Bin' || name.startsWith('/')) continue;
        const added = (m[3].match(/\+/g) || []).length;
        const removed = (m[3].match(/-/g) || []).length;
        files.push({ path: name, added, removed });
      }
      res.json({ ok: true, hash: ref, files });
    } catch (error) {
      routeError(res, error);
    }
  });

  // ── 分支列表（本地 / 远程 / HEAD）──────────────────────────────
  app.post('/protoclaw/git/branches', express.json(), async (req, res) => {
    try {
      if (await forwardRemoteGitIfNamespaced(req, res, 'branches')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      // for-each-ref：按最近提交时间倒序，一次拿到名称/短哈希/相对时间/主题/HEAD 标记
      const fmt = '%(refname:short)\x1f%(objectname:short)\x1f%(committerdate:relative)\x1f%(subject)\x1f%(HEAD)';
      const localText = await runGit(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'], root);
      const remoteText = await runGit(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/remotes'], root);
      const locals = parseBranchLines(localText, false);
      const remotes = parseBranchLines(remoteText, true);
      res.json({ ok: true, root, current: getCurrentBranchName(locals), locals, remotes });
    } catch (error) {
      routeError(res, error);
    }
  });

  // ── 分支操作：create / switch / delete ─────────────────────────
  app.post('/protoclaw/git/branch', express.json(), async (req, res) => {
    try {
      if (await forwardRemoteGitIfNamespaced(req, res, 'branch')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const op = String(req.body?.op || '').trim();
      const name = String(req.body?.name || '').trim();
      const target = String(req.body?.target || '').trim();

      if (op === 'create') {
        if (!name) {
          res.status(400).json({ error: 'name is required' });
          return;
        }
        await runGit(target ? ['branch', name, target] : ['branch', name], root);
        res.json({ ok: true, branch: name });
      } else if (op === 'switch') {
        const ref = name || target;
        if (!ref) {
          res.status(400).json({ error: 'name or target is required' });
          return;
        }
        await runGit(['checkout', ref], root);
        res.json({ ok: true, branch: ref });
      } else if (op === 'delete') {
        if (!name) {
          res.status(400).json({ error: 'name is required' });
          return;
        }
        // -D 强制删除（含未合并），操作前由前端强确认
        await runGit(req.body?.force ? ['branch', '-D', name] : ['branch', '-d', name], root);
        res.json({ ok: true, branch: name });
      } else {
        res.status(400).json({ error: 'op must be create|switch|delete' });
      }
    } catch (error) {
      routeError(res, error);
    }
  });

  // ── 贮藏 stash：save / pop / drop / list ───────────────────────
  app.post('/protoclaw/git/stash', express.json(), async (req, res) => {
    try {
      // 工单读写分类把 stash 端点整体归写（save/pop/drop 写、list 读），
      // 幂等闸按端点粒度强制——与 session.js 逐端点口径一致。
      if (await forwardRemoteGitIfNamespaced(req, res, 'stash')) return;
      const dir = await validateDir(req.body?.dir);
      const root = await resolveGitRoot(dir);
      if (!root) {
        res.status(400).json({ error: 'not a git repository' });
        return;
      }
      const op = String(req.body?.op || 'list').trim();

      if (op === 'list') {
        const text = await runGit(['stash', 'list', '--pretty=format:%gd %cr %gs'], root);
        const entries = text.split('\n').map((l) => l.trim()).filter(Boolean)
          .map((l) => {
            const sp = l.indexOf(' ');
            return { ref: l.slice(0, sp), desc: l.slice(sp + 1) };
          });
        res.json({ ok: true, entries });
        return;
      }
      if (op === 'save') {
        const msg = String(req.body?.message || '').trim();
        await runGit(msg ? ['stash', 'push', '-m', msg] : ['stash', 'push'], root);
        res.json({ ok: true });
        return;
      }
      const ref = String(req.body?.ref || '').trim() || 'stash@{0}';
      if (op === 'pop') {
        await runGit(['stash', 'pop', ref], root);
        res.json({ ok: true });
      } else if (op === 'drop') {
        await runGit(['stash', 'drop', ref], root);
        res.json({ ok: true });
      } else {
        res.status(400).json({ error: 'op must be list|save|pop|drop' });
      }
    } catch (error) {
      routeError(res, error);
    }
  });
}

/** 解析 `git for-each-ref --format=...` 输出行（\x1f 分隔：name/hash/relTime/subject/HEAD标记） */
function parseBranchLines(text, isRemote) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [name, hash, relTime, subject, headMark] = line.split('\x1f');
    if (!name) continue;
    out.push({
      name,
      hash: hash || '',
      relTime: relTime || '',
      subject: subject || '',
      current: headMark === '*',
      remote: isRemote,
    });
  }
  return out;
}

function getCurrentBranchName(locals) {
  const cur = locals.find((b) => b.current);
  return cur ? cur.name : '';
}

/** 解析 `git log --format=%D` 的 ref 装饰串：HEAD -> master, origin/main, tag: v1.0 */
function parseRefs(decoration) {
  if (!decoration) return [];
  const refs = [];
  for (const token of decoration.split(',')) {
    const t = token.trim();
    if (!t) continue;
    if (t.startsWith('HEAD ->')) {
      refs.push({ type: 'head', name: t.slice('HEAD ->'.length).trim() });
    } else if (t.startsWith('tag: ')) {
      refs.push({ type: 'tag', name: t.slice('tag: '.length).trim() });
    } else if (t.includes('/') && !t.startsWith('HEAD')) {
      refs.push({ type: 'remote', name: t.trim() });
    } else {
      refs.push({ type: 'local', name: t.trim() });
    }
  }
  return refs;
}
