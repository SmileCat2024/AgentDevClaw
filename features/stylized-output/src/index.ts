/**
 * StylizedOutput —— 输出风格库 + 确认签名门禁
 *
 * 约定（与 SkillFeature 的 skills 发现同族，但布局不同）：
 *   <workspaceDir>/.agentdev/output-style/*.md   每个平铺 md 文件 = 一种风格
 *
 * 风格选择是会话作用域的内存状态（activeStyleName）：不落盘、不跨会话共享。
 * 同一会话内随 Feature 状态快照（captureState/restoreState）持久；新会话一律
 * 从未选择开始，必须人工经面板 capability（configure）重新选择——工作区里
 * 的任何遗留状态都不会让新对话“先入为主”地继承某个风格。
 * 每个风格 md 必须带 YAML frontmatter，必填字段：
 *   name        风格名（选择文件引用它，需全局唯一）
 *   description 一句话描述
 *   signature   确认签名：一句简短但独特的声明句，例如
 *               “我确认本回复已逐句遵循简洁风格的全部要求。”
 * 正文是风格规则本体。缺任一必填字段的文件会被忽略并记录警告。
 *
 * 行为：
 *   1. 启用风格时，风格全文以 system 消息注入上下文（风格或其文件内容变化时注入一次）。
 *   2. Feature 暴露 sign_output_style 签名工具：模型逐字默写当前风格的确认签名，并必填
 *      interrupt（打断）字段；规范化空白后全等比对，匹配才记为“本轮已签名”。interrupt
 *      缺失时按 false 生效，并经 effectiveCall 调用改写（ADR-0023）把历史调用修正为显式
 *      interrupt=false；填了但非布尔值仍直接拒绝。interrupt=true 的打断仅在随本调用
 *      一并输出了非空正文时生效：ToolUse 钩子（captureSignStepContent）在工具执行前
 *      从 context 捕获本步 assistant 正文，空白正文的打断会被强制降级为 false 并同样经
 *      effectiveCall 改写调用历史——本轮继续，工具结果勒令模型在下一步直接产出最终
 *      回复正文（防“假签名提早打断”导致最终回复残缺/为空）。
 *   3. StepFinish guard 门禁：风格启用期间，模型的自然结束（无工具调用的收尾步）
 *      必须已经签名通过；否则拦截本次结束并注入 system 消息勒令补签，强制再跑一轮。
 *      连续拦截达到 maxSignatureBlocks 上限后放行结束并记录警告（防死循环）。
 *      子代理、wait、后台唤醒等机制活跃时不干预。
 *   4. 打断（interrupt=true 的签名）：签名通过的本步（带工具调用）guard 返回 Deny 直接
 *      结束本轮——随签名工具调用一并给出的正文即最终回复，省去签名后的又一次模型调用
 *      （框架语义：带工具调用的步上 Deny = 以本步正文收尾）。机制活跃时同样不干预，
 *      请求保持挂起，待机制收敛后的下一个 StepFinish 再生效。
 *   5. 只读管理工具 list_output_styles / show_output_style：模型可主动列出
 *      风格清单、查看风格说明原文（frontmatter + 正文 + signature）；上下文中
 *      的风格说明被精简或遗失时，凭这两个工具即可重新核对，无需用户介入。
 *
 * 对外控制链路是 configure capability（面板 / slash）：人工选择/清除风格，
 * 即时写入内存。风格选择不做任何磁盘持久化；会话恢复由 Feature 状态快照负责。
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  createTool,
  Decision,
  getPackageInfoFromSource,
  splitFrontmatter,
  withRewrite,
} from '@agentdevjs/core';
import type {
  AgentFeature,
  CallStartContext,
  CapabilityDefinition,
  FeatureInitContext,
  FeatureManifestDefinition,
  PackageInfo,
  StepFinishDecisionContext,
  StepStartContext,
  Tool,
  ToolContext,
} from '@agentdevjs/core';

const STYLE_DIR_SEGMENTS = ['.agentdev', 'output-style'];
const STYLE_FILE_EXT = '.md';
const DEFAULT_MAX_SIGNATURE_BLOCKS = 5;

export interface OutputStyleMeta {
  /** 风格名（frontmatter name 字段，选择文件引用它） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 确认签名原文 */
  signature: string;
  /** 风格 md 文件绝对路径 */
  path: string;
}

export interface StylizedOutputStatus {
  styleCount: number;
  styles: Array<Pick<OutputStyleMeta, 'name' | 'description' | 'signature'>>;
  activeStyle: string | null;
  /** 本轮回复是否已签名通过 */
  signedForReply: boolean;
  /** 本轮是否有待生效的打断请求（interrupt=true 的签名，尚未被 StepFinish 消费） */
  interruptRequested: boolean;
  /** 本轮回复因未签名被拦截的连续次数 */
  blockedCount: number;
  maxSignatureBlocks: number;
  lastAction: 'idle' | 'blocked' | 'signed' | 'released' | 'interrupted';
}

export interface StylizedOutputOptions {
  /** 同一轮回复的最大连续签名拦截次数，1–10，缺省 5 */
  maxSignatureBlocks?: number;
  /** 会话工作区（缺省 process.cwd()；显式传入时优先于 onInitiate 的 ctx.config） */
  workspaceDir?: string;
}

function clampMax(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_SIGNATURE_BLOCKS;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 签名规范化：trim + 内部连续空白折叠为单空格；不做大小写与标点宽恕（严格比对） */
function normalizeSignature(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/**
 * 极简 frontmatter 字段解析：只取单行 `key: value` 与块标量（| 或 >）续行。
 * 注入用的是 frontmatter 原文，因此这里只需要可靠读出 name/description/signature，
 * 不引入完整 YAML 依赖。
 */
function parseSimpleFrontmatter(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('---') || trimmedLine.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value === '' || value === '|' || value === '>') {
      const parts: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j])) {
        parts.push(lines[j].trim());
        j += 1;
      }
      if (parts.length > 0) {
        i = j - 1;
        value = parts.join(' ');
      } else if (value === '|' || value === '>') {
        value = '';
      }
    }
    if (!fields.has(key)) fields.set(key, unquote(value));
  }
  return fields;
}

function parseStyleFile(raw: string, path: string): OutputStyleMeta | null {
  const { frontmatter } = splitFrontmatter(raw);
  if (!frontmatter) return null;
  const fields = parseSimpleFrontmatter(frontmatter);
  const name = cleanText(fields.get('name'));
  const description = cleanText(fields.get('description'));
  const signature = cleanText(fields.get('signature'));
  if (!name || !description || !signature) return null;
  return { name, description, signature, path };
}

function scanStyles(dir: string): { styles: OutputStyleMeta[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!dir || !existsSync(dir)) return { styles: [], warnings };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    warnings.push(`无法读取风格目录 ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return { styles: [], warnings };
  }
  const styles: OutputStyleMeta[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort()) {
    if (!entry.toLowerCase().endsWith(STYLE_FILE_EXT) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(full, 'utf-8');
    } catch (error) {
      warnings.push(`${entry}: 读取失败（${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }
    const meta = parseStyleFile(raw, full);
    if (!meta) {
      warnings.push(`${entry}: frontmatter 缺少 name/description/signature 必填字段或格式无效，已忽略`);
      continue;
    }
    if (seen.has(meta.name)) {
      warnings.push(`${entry}: 风格名 "${meta.name}" 与其他文件重复，已忽略`);
      continue;
    }
    seen.add(meta.name);
    styles.push(meta);
  }
  return { styles, warnings };
}

const VALID_ACTIONS = ['idle', 'blocked', 'signed', 'released', 'interrupted'] as const;

export class StylizedOutput implements AgentFeature {
  static hooks = {
    syncStyleState: { lifecycle: 'CallStart' as any, kind: 'observe' as const },
    ensureStyleInjection: { lifecycle: 'StepStart' as any, kind: 'observe' as const },
    captureSignStepContent: { lifecycle: 'ToolUse' as any, kind: 'observe' as const },
    decideSignatureGate: { lifecycle: 'StepFinish' as any, kind: 'guard' as const, role: 'advisor' as const },
  };

  readonly name = 'stylized-output';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description =
    '为会话选定输出风格后，agent 的每次回复都遵循该风格并经签名确认；风格文件放入工作区 .agentdev/output-style/ 目录即可选用。';

  private workspaceDir = process.cwd();
  private stylesDir = '';
  private styles: OutputStyleMeta[] = [];
  private activeStyleName: string | null = null;
  private signedForReply = false;
  /** 本轮待生效的打断请求：interrupt=true 的签名通过后置位，StepFinish 消费（Deny 收尾）时清零 */
  private interruptRequested = false;
  /**
   * 签名工具所在 assistant 步的正文（随本调用一并输出的内容）。
   * ToolUse 钩子在工具执行前捕获（react-loop 保证本步 assistant 消息先于工具执行写入
   * context）；null = 未捕获（本轮尚未经标准执行链调用签名工具），空串 = 捕获到空白正文。
   */
  private signStepContent: string | null = null;
  private blockedCount = 0;
  /** 已注入风格的内容指纹键：name@hash，风格或文件内容变化时重新注入 */
  private injectedStyleKey: string | null = null;
  private maxSignatureBlocks = DEFAULT_MAX_SIGNATURE_BLOCKS;
  private lastAction: StylizedOutputStatus['lastAction'] = 'idle';
  private logger?: FeatureInitContext['logger'];
  private _packageInfo: PackageInfo | null = null;

  private workspaceDirOption?: string;

  constructor(options: StylizedOutputOptions = {}) {
    this.maxSignatureBlocks = clampMax(options.maxSignatureBlocks);
    // 显式传入的 workspaceDir 优先于 onInitiate 的 ctx.config（Claw 静态装配
    // 在构造时就知道会话工作区，与 MemoryFeature 等兄弟 Feature 的传参方式对齐）。
    if (typeof options.workspaceDir === 'string' && options.workspaceDir.trim()) {
      this.workspaceDirOption = options.workspaceDir;
      this.workspaceDir = options.workspaceDir;
      this.stylesDir = join(this.workspaceDir, ...STYLE_DIR_SEGMENTS);
    }
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) this._packageInfo = getPackageInfoFromSource(this.source);
    return this._packageInfo;
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1,
      settings: {
        properties: {
          maxSignatureBlocks: {
            type: 'number',
            title: '签名拦截上限',
            description: '同一轮回复中，模型未完成签名而试图结束时的最大连续拦截次数；达到上限后放行结束并记录警告，避免死循环。1–10。',
            default: DEFAULT_MAX_SIGNATURE_BLOCKS,
            min: 1,
            max: 10,
            step: 1,
          },
        },
        sections: [{ id: 'signature-gate', title: '签名门禁', properties: ['maxSignatureBlocks'] }],
      },
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    const featureConfig = ctx.featureConfig && typeof ctx.featureConfig === 'object'
      ? ctx.featureConfig as Record<string, unknown>
      : {};
    if (featureConfig.maxSignatureBlocks !== undefined) {
      this.maxSignatureBlocks = clampMax(featureConfig.maxSignatureBlocks);
    }
    const config = ctx.config as { workspaceDir?: unknown } | undefined;
    const workspaceDir = config && typeof config.workspaceDir === 'string' ? config.workspaceDir : '';
    this.workspaceDir = this.workspaceDirOption || workspaceDir || process.cwd();
    this.stylesDir = join(this.workspaceDir, ...STYLE_DIR_SEGMENTS);
    this.rescan('init');
    this.logger?.info('stylized-output 初始化完成', {
      stylesDir: this.stylesDir,
      styleCount: this.styles.length,
      activeStyle: this.activeStyleName,
    });
  }

  getTools(): Tool[] {
    return [this.listTool, this.showTool, this.signTool];
  }

  /**
   * 会话控制面入口（Claw 面板 capability_invoke / slash）。风格清单与门禁状态读取、
   * 风格选择切换都走这一个 capability；风格 md 的编写仍由用户直接放文件完成。
   */
  getCapabilities(): CapabilityDefinition[] {
    return [
      {
        name: 'configure',
        title: '输出风格',
        description: '查看与选择本会话的输出风格（发现自 .agentdev/output-style/）。选择是会话内存态：不落盘、不跨会话继承，新会话需重新选择；选中后模型每次最终回复须通过确认签名门禁。',
        parameters: {
          styleName: {
            type: 'string',
            title: '风格名',
            description: '要启用的风格名（须在风格清单中）；传空字符串或 null 清除选择（门禁旁路）。',
          },
          maxSignatureBlocks: {
            type: 'number',
            title: '签名拦截上限',
            description: '同一轮回复的最大连续签名拦截次数（1–10），达到上限后放行结束并记录警告。',
            min: 1,
            max: 10,
            step: 1,
          },
        },
        entryPoints: ['slash', 'feature'],
        readCurrentValues: () => {
          // 控制面读取前重扫磁盘：会话尚未发生 CallStart 时，面板也能立即看到
          // 用户刚放入工作区的风格文件（闭环第一环不依赖首轮模型调用）。
          this.rescan('set');
          return { ...this.getStatus() };
        },
        execute: (args) => {
          const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
          // 写入前同样以磁盘为准（用户可能在两次面板刷新之间放入了新文件）。
          this.rescan('set');
          if ('styleName' in input) {
            this.setActiveStyle(typeof input.styleName === 'string' && input.styleName.trim() ? input.styleName : null);
          }
          if (typeof input.maxSignatureBlocks === 'number') {
            this.setMaxSignatureBlocks(input.maxSignatureBlocks);
          }
          return Promise.resolve(this.getStatus());
        },
      },
    ];
  }

  /** 签名工具：模型逐字默写当前风格的确认签名，是本轮回复被允许结束的准入凭证 */
  private readonly signTool: Tool = createTool({
    name: 'sign_output_style',
    description:
      '输出风格签名确认工具。当前会话启用输出风格后，每一轮对话收尾时都必须调用本工具完成签名——签名按轮刷新，上一轮的签名对本轮无效，每轮都要重新调用：参数 signature 需逐字默写该风格 frontmatter 中 signature 字段的确认签名原文（上下文中已注入的风格说明里可以查到）；必填参数 interrupt（打断）填 true 表示验证通过后本轮回复在本次工具调用后直接结束，随本工具调用一并输出的正文即最终回复，不再进行下一次模型调用——注意 interrupt=true 仅当本次调用随附了非空回复正文时才生效，空正文时会被强制降级为 false（调用历史同步改写），届时须在下一步直接输出最终回复正文；填 false 表示继续常规流程，本轮仍以无工具调用的收尾步自然结束。验证通过后本轮回复才被允许结束；未签名就结束会被系统拦截。把签名写进正文不算签名，必须调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        signature: {
          type: 'string',
          description: '当前风格确认签名的原文：逐字默写，不要改写、缩写或附加解释',
        },
        interrupt: {
          type: 'boolean',
          description:
            '打断：必填。true = 签名验证通过后本轮在本次工具调用后直接结束，随本调用一并输出的正文就是最终回复；false = 不打断，继续常规流程（本轮仍以无工具调用的收尾步自然结束）',
        },
      },
      required: ['signature', 'interrupt'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    // ADR-0023：interrupt 缺失时经 effectiveCall 把历史调用改写为显式 interrupt=false，
    // 工具须声明 rewritable 才能通过执行器校验链。
    rewritable: true,
    execute: async (args = {}, context) => {
      const input = args as { signature?: unknown; interrupt?: unknown };
      const active = this.getActiveStyle();
      if (!active) {
        return { ok: false, error: '当前未启用任何输出风格，无需签名；本次调用不产生任何效果。' };
      }
      let interrupt: boolean;
      /** interrupt 缺失时的确定性纠正（ADR-0023）：按 false 生效，并经 effectiveCall 把历史调用改写为显式 interrupt=false */
      let corrected = false;
      if (typeof input.interrupt === 'boolean') {
        interrupt = input.interrupt;
      } else if (input.interrupt === undefined) {
        interrupt = false;
        corrected = true;
      } else {
        return {
          ok: false,
          error:
            'interrupt（打断）参数不是布尔值：true 表示签名通过后本轮在本次工具调用后直接结束；false 表示继续常规流程。请以布尔值重新调用。',
        };
      }
      const provided = normalizeSignature(typeof input.signature === 'string' ? input.signature : '');
      if (!provided) {
        return {
          ok: false,
          error: 'signature 参数为空。请在上下文中已注入的风格说明里找到 signature 字段原文并逐字默写。',
        };
      }
      if (provided !== normalizeSignature(active.signature)) {
        this.logger?.info('输出风格签名不匹配', { style: active.name });
        return {
          ok: false,
          signed: false,
          error: '确认签名与当前风格不匹配。请在上下文中已注入的风格说明里核对 signature 字段原文，逐字默写后重试；不要编造或改写。',
        };
      }
      /**
       * 空正文打断降级（防"假签名提早打断"）：interrupt=true 只在随本调用一并
       * 输出了非空回复正文时才生效。捕获到空白正文时强制按 false 生效并经
       * effectiveCall 改写调用历史——本轮继续，模型须在下一步实际写出最终回复。
       * signStepContent 为 null 表示未经 ToolUse 钩子捕获（非标准执行链直调），
       * 无事实则不判断，保持现状行为。
       */
      let demoted = false;
      if (interrupt && this.signStepContent !== null && !this.signStepContent.trim()) {
        interrupt = false;
        demoted = true;
      }
      this.signedForReply = true;
      this.interruptRequested = interrupt;
      this.lastAction = 'signed';
      this.logger?.info('输出风格签名验证通过', {
        style: active.name,
        interrupt,
        ...(corrected ? { correctedInterrupt: true } : {}),
        ...(demoted ? { demotedInterrupt: true } : {}),
      });
      let note: string;
      if (demoted) {
        note =
          '签名验证通过，本轮签名已记录。但本次调用未随附任何回复正文（assistant 正文为空），'
          + 'interrupt=true 不能生效：已强制按 false 处理，并在调用历史中改写为 interrupt=false。'
          + '请立即产出本轮最终回复：在下一步直接输出完整的回复正文，不要再调用任何工具，'
          + '以无工具调用的收尾步自然结束本轮——签名已记录，输出正文后本轮即可正常结束。';
      } else if (interrupt) {
        note =
          '签名验证通过，interrupt=true 已生效：本轮回复将在本次工具调用后直接结束，'
          + '以随本调用一并输出的正文为最终回复，无需也不应再产生任何后续内容。';
      } else {
        note =
          '签名验证通过，本轮签名已记录。interrupt=false：本轮尚未结束，'
          + '请立即产出最终回复正文——在下一步直接输出完整内容，不要再调用任何工具，'
          + '以无工具调用的收尾步自然结束本轮。';
      }
      const payload = {
        ok: true,
        signed: true,
        style: active.name,
        interrupt,
        note: note
          + (corrected
            ? '本次调用未携带必填的 interrupt 参数，已按 false 处理并在调用历史中补记为 interrupt=false；下次调用请显式填写该字段。'
            : '')
          + '签名属于内部流程：不要在给用户的回复正文里提及签名或本工具调用。',
      };
      if (corrected || demoted) {
        // ADR-0023：修正/降级后的调用写入 assistant 历史，下一轮模型看到的就是已显式填
        // interrupt=false 的调用；context 未携带 callId（非运行时直接调用）时不改写。
        const callId = context?.callId;
        if (callId) {
          return withRewrite(JSON.stringify(payload), {
            id: callId,
            name: 'sign_output_style',
            arguments: { ...args, interrupt: false },
          });
        }
      }
      return payload;
    },
  });

  /** 管理工具：列出全部已发现的输出风格（只读，以磁盘为准） */
  private readonly listTool: Tool = {
    name: 'list_output_styles',
    description:
      '列出当前工作区已发现的全部输出风格（发现自 .agentdev/output-style/*.md）。返回每个风格的名称、一句话描述和是否为当前启用风格，无参数。查看某个风格的完整规则与确认签名请用 show_output_style。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      this.rescan('tool');
      const styles = this.getStyles();
      const payload: {
        ok: true;
        activeStyle: string | null;
        styleCount: number;
        styles: Array<{ name: string; description: string; active: boolean }>;
        hint?: string;
      } = {
        ok: true,
        activeStyle: this.activeStyleName,
        styleCount: styles.length,
        styles: styles.map((style) => ({
          name: style.name,
          description: style.description,
          active: style.name === this.activeStyleName,
        })),
      };
      if (styles.length === 0) {
        payload.hint =
          '未发现任何输出风格。将带 name/description/signature frontmatter 的 md 文件放入 ' + this.stylesDir + ' 即可被发现。';
      }
      return payload;
    },
  };

  /** 管理工具：查看一种输出风格的完整说明原文（只读；缺省查看当前启用风格） */
  private readonly showTool: Tool = {
    name: 'show_output_style',
    description:
      '查看一种输出风格的完整说明原文（frontmatter + 正文，含确认签名 signature 字段）。不带参数时查看当前启用的风格；传 name 可查看任一已发现的风格。风格启用期间，若上下文中已注入的风格说明被精简或找不到了，用本工具重新核对签名原文与风格要求。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '要查看的风格名；缺省查看当前启用的风格',
        },
      },
      additionalProperties: false,
    },
    execute: async (args: { name?: string }) => {
      this.rescan('tool');
      const wanted = cleanText(args?.name);
      const target = wanted
        ? this.styles.find((style) => style.name === wanted) ?? null
        : this.getActiveStyle();
      if (!target) {
        return wanted
          ? {
              ok: false,
              error: '未找到名为「' + wanted + '」的输出风格。可调用 list_output_styles 查看全部可用风格名。',
            }
          : {
              ok: false,
              error: '当前未启用任何输出风格，且未指定 name 参数。可传 name 查看指定风格，或先调用 list_output_styles。',
            };
      }
      let raw = '';
      try {
        raw = readFileSync(target.path, 'utf-8');
      } catch (error) {
        return {
          ok: false,
          error: '读取风格文件失败：' + (error instanceof Error ? error.message : String(error)),
        };
      }
      return {
        ok: true,
        style: target.name,
        description: target.description,
        signature: target.signature,
        active: target.name === this.activeStyleName,
        path: target.path,
        content: raw,
      };
    },
  };

  /** CallStart：重扫风格目录（支持用户随时增删风格文件），并重置本轮签名状态 */
  async syncStyleState(_ctx: CallStartContext): Promise<void> {
    this.rescan('call');
    this.signedForReply = false;
    this.interruptRequested = false;
    this.signStepContent = null;
    this.blockedCount = 0;
  }

  /**
   * ToolUse：签名工具执行前捕获本步 assistant 正文（随本次调用一并输出的内容）。
   * react-loop 保证本步 assistant 消息先于工具执行写入 context，从尾部取最近的
   * assistant 消息即得；签名工具为 exclusive（批次唯一），尾部定位不受其他调用干扰。
   * 捕获结果供 signTool 判断 interrupt=true 的空正文降级；未捕获（null）则不判断。
   */
  async captureSignStepContent(ctx: ToolContext): Promise<void> {
    if (ctx.call?.name !== 'sign_output_style') return;
    const messages = ctx.context?.getAll?.() ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === 'assistant') {
        this.signStepContent = typeof message.content === 'string' ? message.content : '';
        return;
      }
    }
    this.signStepContent = '';
  }

  /** StepStart：确保当前风格说明已注入上下文（风格或其文件内容变化时注入一次，不逐 step 重复） */
  async ensureStyleInjection(ctx: StepStartContext): Promise<void> {
    const active = this.getActiveStyle();
    if (!active) {
      this.injectedStyleKey = null;
      return;
    }
    let raw = '';
    try {
      raw = readFileSync(active.path, 'utf-8');
    } catch (error) {
      this.logger?.warn('读取风格文件失败，跳过注入', {
        path: active.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const styleKey = active.name + '@' + createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16);
    if (this.injectedStyleKey === styleKey) return;
    const { frontmatter, body } = splitFrontmatter(raw);
    const content = [
      '[输出风格已启用：' + active.name + ']',
      '说明：' + active.description,
      '---',
      frontmatter ? ['```yaml', frontmatter, '```'].join('\n') : '',
      body,
      '---',
      '[签名要求] 本风格启用期间，每一轮对话收尾时都必须调用签名工具：',
      '在你给出本轮最终回复的同时，调用 sign_output_style 工具：参数 signature 逐字默写上面 frontmatter 中 signature 字段的原文；必填参数 interrupt（打断）填 true——验证通过后本轮在本次工具调用后直接结束，你随本调用一并输出的正文就是最终回复，不再进行下一次模型调用。',
      'interrupt=true 只在随本调用一并写出了最终回复正文时才生效：若本次调用没有随附正文，interrupt 会被强制按 false 处理（调用历史同步改写），届时请在下一步直接输出最终回复正文，不要再调用任何工具。',
      '签名状态按轮刷新：每一轮用户输入都会清空上一轮的签名记录，上一轮签过名对本轮无效，本轮必须重新调用一次。',
      '工具验证通过后，本轮回复才会被允许结束。未签名就试图结束会被系统拦截并要求补签。',
      '把签名写进正文不算签名，必须调用工具。',
    ].filter(Boolean).join('\n');
    try {
      ctx.context.add({ role: 'system', content });
    } catch (error) {
      this.logger?.warn('注入风格说明失败', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.injectedStyleKey = styleKey;
    this.logger?.info('已注入输出风格说明', { style: active.name, styleKey });
  }

  /**
   * StepFinish guard：签名门禁。
   * - 打断：本步带工具调用、本轮已签名且签名时 interrupt=true → 返回 Deny 结束本轮
   *   （框架语义：带工具调用的步上 Deny = 以本步正文收尾），随签名工具调用一并给出的
   *   正文即最终回复；子代理、wait 等机制活跃时不干预，请求保持挂起，待机制收敛后的
   *   下一个 StepFinish 再生效。
   * - 未启用风格 / 该步仍有工具调用（且无打断请求）/ 子代理与 wait 等机制活跃 / 已签名 → 不干预（Continue）。
   * - 自然结束但未签名 → 注入勒令补签的 system 消息并 Approve 强制再跑一轮；
   *   连续拦截达到上限后放行并告警（防死循环）。
   */
  async decideSignatureGate(ctx: StepFinishDecisionContext) {
    const active = this.getActiveStyle();
    if (!active) return Decision.Continue;
    if (ctx.toolCallsCount !== 0) {
      if (this.signedForReply && this.interruptRequested) {
        if (ctx.hasActiveSubAgents || ctx.hasPendingMessages || ctx.waitCalled) {
          return Decision.Continue;
        }
        this.interruptRequested = false;
        this.lastAction = 'interrupted';
        this.logger?.info('输出风格签名门禁：interrupt=true，本轮在签名工具调用后直接结束', {
          style: active.name,
        });
        return Decision.Deny;
      }
      return Decision.Continue;
    }
    if (ctx.hasActiveSubAgents || ctx.hasPendingMessages || ctx.waitCalled) {
      return Decision.Continue;
    }
    if (this.signedForReply) return Decision.Continue;
    if (this.blockedCount >= this.maxSignatureBlocks) {
      this.blockedCount = 0;
      this.lastAction = 'released';
      this.logger?.warn('输出风格签名门禁：拦截次数达到上限，放行本轮回复', {
        style: active.name,
        maxSignatureBlocks: this.maxSignatureBlocks,
      });
      return Decision.Continue;
    }
    this.blockedCount += 1;
    this.lastAction = 'blocked';
    const demand = [
      '[输出风格签名门禁]',
      '当前已启用输出风格「' + active.name + '」，但你的回复尚未完成签名确认，不能就此结束。',
      '请立即检查本回复是否符合该风格的输出要求；若有不符合之处，请更正后重新输出。',
      '自检无误后，调用 sign_output_style 工具完成签名确认：参数 signature 逐字默写该风格说明中 signature 字段的确认签名原文，必填参数 interrupt 填 true。',
      '签名验证通过且 interrupt=true 时，本轮回复会在该工具调用后直接结束，以你随该调用一并给出的正文为最终回复；直接在正文里书写签名无效。',
    ].join('\n');
    ctx.context.add({ role: 'system', content: demand });
    this.logger?.info('输出风格签名门禁：拦截未签名结束', {
      style: active.name,
      blockedCount: this.blockedCount,
    });
    return Decision.Approve;
  }

  captureState() {
    return {
      activeStyleName: this.activeStyleName,
      signedForReply: this.signedForReply,
      interruptRequested: this.interruptRequested,
      blockedCount: this.blockedCount,
      injectedStyleKey: this.injectedStyleKey,
      lastAction: this.lastAction,
    };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
    this.activeStyleName = cleanText(state.activeStyleName) || null;
    this.signedForReply = state.signedForReply === true;
    this.interruptRequested = state.interruptRequested === true;
    this.blockedCount = typeof state.blockedCount === 'number' && Number.isFinite(state.blockedCount)
      ? Math.max(0, Math.floor(state.blockedCount))
      : 0;
    this.injectedStyleKey = cleanText(state.injectedStyleKey) || null;
    this.lastAction = VALID_ACTIONS.includes(state.lastAction as typeof VALID_ACTIONS[number])
      ? state.lastAction as StylizedOutputStatus['lastAction']
      : 'idle';
  }

  // ---------- 公共 API（供未来控制面 / 其他 Feature 使用；模型不可见） ----------

  getStyles(): OutputStyleMeta[] {
    return this.styles.map((style) => ({ ...style }));
  }

  getActiveStyle(): OutputStyleMeta | null {
    if (!this.activeStyleName) return null;
    return this.styles.find((style) => style.name === this.activeStyleName) ?? null;
  }

  getStatus(): StylizedOutputStatus {
    return {
      styleCount: this.styles.length,
      styles: this.styles.map((style) => ({
        name: style.name,
        description: style.description,
        signature: style.signature,
      })),
      activeStyle: this.activeStyleName,
      signedForReply: this.signedForReply,
      interruptRequested: this.interruptRequested,
      blockedCount: this.blockedCount,
      maxSignatureBlocks: this.maxSignatureBlocks,
      lastAction: this.lastAction,
    };
  }

  /** 调整签名拦截上限（1–10 钳制） */
  setMaxSignatureBlocks(value: number): StylizedOutputStatus {
    this.maxSignatureBlocks = clampMax(value);
    return this.getStatus();
  }

  /**
   * 设置当前风格（会话内存态，立即生效，不落盘）；传 null 清空选择。
   * 面板 configure capability 与未来控制面共用的写入入口；模型不可见。
   * 选择只随 Feature 状态快照在会话恢复时还原，新会话一律从 null 开始。
   */
  setActiveStyle(name: string | null): StylizedOutputStatus {
    const value = cleanText(name);
    if (value) {
      this.rescan('set');
      if (!this.styles.some((style) => style.name === value)) {
        this.logger?.warn('[stylized-output] 拒绝设置未知风格 "' + value + '"');
        return this.getStatus();
      }
      this.activeStyleName = value;
    } else {
      this.activeStyleName = null;
    }
    this.signedForReply = false;
    this.interruptRequested = false;
    this.blockedCount = 0;
    return this.getStatus();
  }

  // ---------- 内部 ----------

  /** 重扫风格目录；reason 只影响日志语境。风格选择是内存态，此处不读写任何选择文件 */
  private rescan(reason: 'init' | 'call' | 'set' | 'tool'): void {
    const { styles, warnings } = scanStyles(this.stylesDir);
    for (const warning of warnings) this.logger?.warn('[stylized-output] ' + warning);
    this.styles = styles;
    // 内存中选中的风格文件被删除/改名时主动失效，保持状态自洽（门禁旁路）。
    if (this.activeStyleName && !styles.some((style) => style.name === this.activeStyleName)) {
      this.logger?.warn(
        '[stylized-output] 已选风格 "' + this.activeStyleName + '" 不在最新扫描结果中（' + reason + '），按未选择处理',
      );
      this.activeStyleName = null;
      this.signedForReply = false;
      this.interruptRequested = false;
      this.blockedCount = 0;
    }
  }
}

export default StylizedOutput;