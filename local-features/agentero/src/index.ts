/**
 * AgenteroFeature — 文献库工具面（Agent 侧，spawn CLI 薄包装）
 *
 * 对接 Agentero 研究 vault（本对接 = ADR-0044 P6 样本，仓库内集成三件套之一）。
 * 工具实现统一走 `agentero <子命令> --json` 子进程：数据正确性由官方 CLI
 * 保证，本 feature 不读 schema、不做并发协议，读写边界即 CLI 的官方契约。
 *
 * vault 路径语义：配置 `agentero.vaultPath`（四层作用域 merge 后由 agent.js
 * 装配层显式传入）存在时以 `--vault` 注入覆盖；未配置时不注入，CLI 自身的
 * env / walk-up / config 解析链兜底（与 server 数据面「未配置即
 * configured:false」不同——工具面保留 CLI 原生兜底，用户设 AGENTERO_VAULT
 * 也能生效）。
 *
 * 工具面偏读：list / get / vault_info 只读；写操作第一版仅 set-read（幂等、
 * 无破坏），经 CLI 官方契约执行。正文检索（vault.search）与整页阅读
 * （page.read）是 MCP surface 独有能力，CLI 无对应子命令，不在本工具面。
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import type { AgentFeature, PackageInfo, Tool } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';

const CLI_TIMEOUT_MS = 30_000;
/** list 行在 id/path/title 基础上补充的字段（CLI --fields 语义）。 */
const LIST_EXTRA_FIELDS = 'title,year,authors,tags,is_read';

/** 子进程执行器签名（默认 spawn，测试注入 mock）。 */
export type AgenteroCliExecutor = (
  args: string[],
  options?: { vaultPath?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** CLI 调用失败（非零退出 / 超时 / 信封 ok:false）。 */
export class AgenteroCliError extends Error {
  readonly code: string;
  readonly stderr: string;

  constructor(message: string, code: string, stderr = '') {
    super(message);
    this.name = 'AgenteroCliError';
    this.code = code;
    this.stderr = stderr;
  }
}

/** 默认执行器：spawn agentero（win32 需带 .exe 后缀走 CreateProcess PATH 解析）。 */
export const spawnAgenteroCli: AgenteroCliExecutor = async (args, options) => {
  const finalArgs = options?.vaultPath
    ? [...args, '--vault', options.vaultPath]
    : args;
  const command = process.platform === 'win32' ? 'agentero.exe' : 'agentero';
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new AgenteroCliError(`agentero CLI 超时（${CLI_TIMEOUT_MS}ms）: ${finalArgs.join(' ')}`, 'cli-timeout'));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AgenteroCliError(
        `无法启动 agentero CLI（${command}）: ${err.message}`,
        'cli-not-found',
        stderr,
      ));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new AgenteroCliError(
          `agentero CLI 退出码 ${code}: ${finalArgs.join(' ')}`,
          'cli-exit-nonzero',
          stderr,
        ));
      }
    });
  });
};

/**
 * 执行 CLI 并解析 `--json` 信封。成功返回 data；信封 ok:false 或 stdout
 * 非 JSON 时抛 AgenteroCliError（保留 CLI 的 code 与 message，工具层转
 * 用户可读错误，不吞 stderr）。
 */
export async function runAgenteroCli<T = unknown>(
  args: string[],
  options?: { vaultPath?: string; exec?: AgenteroCliExecutor },
): Promise<T> {
  const executor = options?.exec ?? spawnAgenteroCli;
  const { stdout, stderr } = await executor(args, { vaultPath: options?.vaultPath });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AgenteroCliError(
      `agentero CLI 输出不是合法 JSON: ${String(stdout).slice(0, 200)}`,
      'cli-output-not-json',
      stderr,
    );
  }
  if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
    const envelope = parsed as { ok: boolean; data?: T; error?: { code?: string; message?: string } };
    if (envelope.ok) return envelope.data as T;
    throw new AgenteroCliError(
      envelope.error?.message || 'agentero CLI 报错',
      envelope.error?.code || 'cli-error',
      stderr,
    );
  }
  throw new AgenteroCliError(
    `agentero CLI 输出缺少 ok 信封: ${String(stdout).slice(0, 200)}`,
    'cli-output-not-envelope',
    stderr,
  );
}

/** 论文 REF（位置参数）校验：非空、非 flag 开头，防参数注入。 */
function cleanPaperRef(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.startsWith('-')) return null;
  return value;
}

function cleanTextArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface PaperListRow {
  id?: string;
  path?: string;
  title?: string;
  year?: number | string | null;
  authors?: string[] | string | null;
  tags?: string[] | string | null;
  is_read?: boolean | number | null;
}

function formatAuthors(authors: PaperListRow['authors']): string {
  if (!Array.isArray(authors) || authors.length === 0) return '未知作者';
  const names = authors.slice(0, 3).join(', ');
  return authors.length > 3 ? `${names} 等 ${authors.length} 人` : names;
}

function formatTags(tags: PaperListRow['tags']): string {
  if (!Array.isArray(tags) || tags.length === 0) return '';
  return `｜${tags.join(' ')}`;
}

function formatListRow(row: PaperListRow): string {
  const year = row.year != null && row.year !== '' ? `（${row.year}）` : '';
  const read = row.is_read ? '' : '｜未读';
  return `- ${row.id ?? row.path ?? '?'}｜${row.title ?? '无标题'}${year}｜${formatAuthors(row.authors)}${formatTags(row.tags)}${read}`;
}

const NOT_CONFIGURED_HINT =
  '未配置 agentero.vaultPath（feature 配置，全局或 agent 层）。CLI 会继续用自身解析链' +
  '（AGENTERO_VAULT 环境变量 / walk-up / config）定位 vault；若本错误重复出现，' +
  '请在设置菜单的 feature 配置里填写 agentero.vaultPath 指向 vault 根目录。';

export class AgenteroFeature implements AgentFeature {
  readonly name = 'agentero';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  private readonly vaultPath: string;
  private readonly exec: AgenteroCliExecutor | undefined;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: { vaultPath?: string; exec?: AgenteroCliExecutor } = {}) {
    const vault = cleanTextArg(config.vaultPath);
    this.vaultPath = vault;
    this.exec = config.exec;
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  private run<T>(args: string[]): Promise<T> {
    return runAgenteroCli<T>(args, { vaultPath: this.vaultPath || undefined, exec: this.exec });
  }

  /** CLI 失败统一转工具错误（保留 code / stderr 供排查，不向模型抛异常栈）。 */
  private toToolError(err: unknown): { error: string } {
    if (err instanceof AgenteroCliError) {
      const detail = err.stderr.trim() ? `\nstderr: ${err.stderr.trim().slice(0, 300)}` : '';
      return { error: `agentero CLI 失败（${err.code}）: ${err.message}${detail}` };
    }
    return { error: `agentero 工具执行失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  getTools(): Tool[] {
    return [
      {
        name: 'agentero_papers',
        parallelizable: true,
        description:
          '列出文献库（Agentero vault）中的论文。支持 query 子串过滤（匹配标题 / 作者 / id / 路径 / 标签）、' +
          'tag 精确过滤（可多个，AND）、unread 只看未读。返回 id 是后续 agentero_paper_get / ' +
          'agentero_paper_set_read 的寻址键。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '子串过滤（标题 / 作者 / id / 路径 / 标签），可选' },
            tag: { type: 'array', items: { type: 'string' }, description: '标签精确过滤（多个为 AND），可选' },
            unread: { type: 'boolean', description: 'true 时只列未读论文，可选' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const cliArgs = ['paper', 'list', '--json', '--fields', LIST_EXTRA_FIELDS];
          const query = cleanTextArg(args?.query);
          if (query) cliArgs.push('--query', query);
          if (Array.isArray(args?.tag)) {
            for (const tag of args.tag) {
              const cleaned = cleanTextArg(tag);
              if (cleaned) cliArgs.push('--tag', cleaned);
            }
          }
          if (args?.unread === true) cliArgs.push('--unread');
          try {
            const papers = await this.run<PaperListRow[]>(cliArgs);
            if (!Array.isArray(papers) || papers.length === 0) {
              return { text: '没有匹配的论文。', total: 0, papers: [] };
            }
            const lines = papers.map(formatListRow);
            const filterNote = query ? `（query="${query}"）` : '';
            return {
              text: `共 ${papers.length} 篇${filterNote}：\n${lines.join('\n')}`,
              total: papers.length,
              papers,
            };
          } catch (err) {
            const toolError = this.toToolError(err);
            return { ...toolError, hint: NOT_CONFIGURED_HINT };
          }
        },
      },
      {
        name: 'agentero_paper_get',
        parallelizable: true,
        description:
          '读取单篇论文的完整元数据（标题 / 作者 / 年份 / 摘要 / 标签 / PDF 与源文件资产路径 / 已读状态）。' +
          'id 来自 agentero_papers 的返回。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '论文 id（agentero_papers 返回的 id 字段）' },
          },
          required: ['id'],
        },
        execute: async (args: Record<string, unknown>) => {
          const id = cleanPaperRef(args?.id);
          if (!id) {
            return { error: 'id 无效（非空、且不能以 - 开头）', hint: '先用 agentero_papers 拿到论文 id' };
          }
          try {
            // CLI 返回 {assets, paper}（assets 是 marksDir/notesMd/pdf/tex 的
            // 资产可用性表）；解包平铺，省去模型一层无谓嵌套。
            const data = await this.run<{ assets?: Record<string, unknown>; paper?: Record<string, unknown> }>(
              ['paper', 'get', id, '--json'],
            );
            return { paper: data?.paper ?? data, assets: data?.assets ?? null };
          } catch (err) {
            const toolError = this.toToolError(err);
            return { ...toolError, hint: NOT_CONFIGURED_HINT };
          }
        },
      },
      {
        name: 'agentero_paper_set_read',
        description:
          '标记论文已读 / 未读（写操作，走 agentero CLI 官方契约，只改 catalog 的 is_read 字段，' +
          '不动文件）。幂等：重复标记同一状态无副作用。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '论文 id' },
            read: { type: 'boolean', description: 'true 标记已读（默认），false 标记未读' },
          },
          required: ['id'],
        },
        execute: async (args: Record<string, unknown>) => {
          const id = cleanPaperRef(args?.id);
          if (!id) {
            return { error: 'id 无效（非空、且不能以 - 开头）' };
          }
          const read = args?.read !== false;
          const cliArgs = ['paper', 'set-read', id, '--json'];
          if (!read) cliArgs.push('--false');
          try {
            const result = await this.run<Record<string, unknown>>(cliArgs);
            return { ok: true, id, read, result };
          } catch (err) {
            return this.toToolError(err);
          }
        },
      },
      {
        name: 'agentero_vault_info',
        parallelizable: true,
        description:
          '查看文献库状态：生效的 vault 路径（配置或 CLI 自身解析）、论文总数。排查「库里有什么 / ' +
          'vault 有没有配对」时先用这个。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          try {
            const papers = await this.run<PaperListRow[]>(['paper', 'list', '--json']);
            const count = Array.isArray(papers) ? papers.length : 0;
            return {
              text: `vault: ${this.vaultPath || '（未配置 vaultPath，走 CLI 自身解析）'}\n论文总数: ${count}`,
              vaultPath: this.vaultPath || null,
              totalPapers: count,
            };
          } catch (err) {
            const toolError = this.toToolError(err);
            return { ...toolError, hint: NOT_CONFIGURED_HINT };
          }
        },
      },
    ];
  }
}
