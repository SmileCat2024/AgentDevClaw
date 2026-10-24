/**
 * StylizedOutput —— 输出风格库 + 确认签名门禁
 *
 * 约定（与 SkillFeature 的 skills 发现同族，但布局不同），风格来自两个来源合并发现：
 *   1. feature 内嵌目录 dist/styles/*.md（源码在 src/styles/，构建时经 copy-assets 镜像）
 *   2. <workspaceDir>/.agentdev/output-style/*.md   每个平铺 md 文件 = 一种风格
 *   两处风格名重复时工作区版本优先（用户自定义覆盖内置），并记录警告。
 *
 * 风格选择是会话作用域的内存状态（activeStyleName）：不落盘、不跨会话共享。
 * 同一会话内随 Feature 状态快照（captureState/restoreState）持久；新会话从
 * 「未选择」开始。defaultStyle 选项声明默认风格：未选择且未被显式清除时，
 * 每次扫描后自动回填该风格（新会话、接续会话、旧会话恢复都适用）；用户经
 * 面板显式清除选择后记 activeStyleCleared=true，不再回填——区分「没选过」
 * 与「不要了」，二者都不会让工作区里的遗留状态先入为主地选中某个风格。
 * 每个风格 md 必须带 YAML frontmatter，必填字段：
 *   name        风格名（选择文件引用它，需全局唯一）
 *   description 一句话描述
 *   signature   确认签名：一句简短但独特的声明句，例如
 *               “我确认本回复已逐句遵循简洁风格的全部要求。”
 * 正文是风格规则本体。缺任一必填字段的文件会被忽略并记录警告。
 *
 * 行为：
 *   1. 启用风格时，风格全文以 system 消息注入上下文（风格或其文件内容变化时注入一次）。
 *   2. Feature 暴露 sign_output_style 签名工具：模型逐字默写当前风格的确认签名，
 *      判定分两层：先规范化空白后全等比对；不等时计算字符级编辑距离，在笔误容忍
 *      预算内（signatureTolerance% × 签名长度，基数至少 2）的个别笔误静默放行——
 *      返回与精确通过完全一致，仅记警告日志供审计，模型可见文案（工具描述 / 注入
 *      说明 / 门禁提示）不宣传容错，避免宽恕层从安全网变成常态通道；超预算的
 *      漏句 / 意译 / 大面积改写照旧拒绝，错误信息带差异量级与容忍上限。
 *      通过才记为“本轮已签名”。
 *   3. StepFinish guard 门禁：风格启用期间，模型的自然结束（无工具调用的收尾步）
 *      必须已经签名通过；否则拦截本次结束并注入复核补签提醒。拦截后补签成功
 *      即正常结束当前回复，不再额外调用模型收尾；普通签名不自动结束。
 *      连续拦截达到 maxSignatureBlocks 上限后放行结束并记录警告（防死循环）。
 *      子代理、wait 等机制活跃时不干预；后台工作的挂起由框架处理。
 *   4. 只读管理工具 list_output_styles / show_output_style：模型可主动列出
 *      风格清单、查看风格说明原文（frontmatter + 正文 + signature）；上下文中
 *      的风格说明被精简或遗失时，凭这两个工具即可重新核对，无需用户介入。
 *
 * 对外控制链路是 configure capability（面板 / slash）：人工选择/清除风格，
 * 即时写入内存。风格选择不做任何磁盘持久化；会话恢复由 Feature 状态快照负责。
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  Decision,
  getPackageInfoFromSource,
  splitFrontmatter,
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
} from '@agentdevjs/core';

const STYLE_DIR_SEGMENTS = ['.agentdev', 'output-style'];
const STYLE_FILE_EXT = '.md';
/** feature 内嵌风格目录名（位于 dist/ 旁边，构建时由 copy-assets 从 src/styles/ 镜像） */
const BUILTIN_STYLE_DIR_NAME = 'styles';
const DEFAULT_MAX_SIGNATURE_BLOCKS = 5;
/** 笔误容忍基数：签名再短也至少容忍的编辑距离（覆盖近义单字替换 / 漏字 / 标点全半角） */
const SIGNATURE_TOLERANCE_BASE = 2;
/** 默认笔误容忍比例（%，0–10；0 = 严格逐字比对） */
const DEFAULT_SIGNATURE_TOLERANCE = 5;

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
  /** 配置声明的默认风格名（未配置为 null；是否在清单中以其是否被回填为准） */
  defaultStyle: string | null;
  /** 本轮回复是否已签名通过 */
  signedForReply: boolean;
  /** 本轮回复因未签名被拦截的连续次数 */
  blockedCount: number;
  maxSignatureBlocks: number;
  /** 签名笔误容忍比例（%，0–10；0 = 严格逐字比对） */
  signatureTolerance: number;
  lastAction: 'idle' | 'blocked' | 'signed' | 'released';
}

export interface StylizedOutputOptions {
  /** 同一轮回复的最大连续签名拦截次数，1–10，缺省 5 */
  maxSignatureBlocks?: number;
  /** 签名笔误容忍比例（%，0–10）：允许的编辑距离 ≈ 签名长度 × 该比例（基数 2）；0 = 严格逐字比对，缺省 5 */
  signatureTolerance?: number;
  /** 会话工作区（缺省 process.cwd()；显式传入时优先于 onInitiate 的 ctx.config） */
  workspaceDir?: string;
  /** 默认风格名：未选择且未被显式清除时扫描后自动启用；配置的名称不在清单中时保持未选择 */
  defaultStyle?: string;
}

function clampMax(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_SIGNATURE_BLOCKS;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function clampTolerance(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIGNATURE_TOLERANCE;
  return Math.max(0, Math.min(10, Math.floor(value)));
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 签名规范化：trim + 内部连续空白折叠为单空格。大小写与标点宽恕（全半角等价表）
 *  不做：这类差异按编辑距离 1–2 计入笔误预算，由 signTool 的宽恕层统一覆盖。 */
function normalizeSignature(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** 字符级 Levenshtein 编辑距离（codepoint 展开，规避代理对；签名长度内性能无感） */
function editDistance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let prev = Array.from({ length: right.length + 1 }, (_, j) => j);
  let curr = new Array<number>(right.length + 1);
  for (let i = 1; i <= left.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[right.length];
}

/** 笔误容忍预算：随签名长度按比例伸缩，短签名保底基数；漏句 / 意译 / 改写的
 *  编辑距离超出预算一个数量级，仍被拒绝。 */
function toleranceBudget(signatureLength: number, tolerancePercent: number): number {
  return Math.max(SIGNATURE_TOLERANCE_BASE, Math.floor((signatureLength * tolerancePercent) / 100));
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

/**
 * 双源扫描合并：工作区目录风格优先，feature 内嵌风格补充。
 * 同名时工作区版本生效（用户自定义覆盖内置）并记录警告；合并后按风格名排序，
 * 展示顺序与来源无关、稳定可预测。
 */
function scanAllStyles(builtinDir: string, workspaceDir: string): { styles: OutputStyleMeta[]; warnings: string[] } {
  const builtin = scanStyles(builtinDir);
  const workspace = scanStyles(workspaceDir);
  const warnings = [...builtin.warnings, ...workspace.warnings];
  const styles = [...workspace.styles];
  const seen = new Set(styles.map((style) => style.name));
  for (const style of builtin.styles) {
    if (seen.has(style.name)) {
      warnings.push(`内嵌风格 "${style.name}" 与工作区风格重名，使用工作区版本`);
      continue;
    }
    seen.add(style.name);
    styles.push(style);
  }
  styles.sort((a, b) => a.name.localeCompare(b.name));
  return { styles, warnings };
}

const VALID_ACTIONS = ['idle', 'blocked', 'signed', 'released'] as const;

export class StylizedOutput implements AgentFeature {
  static hooks = {
    syncStyleState: { lifecycle: 'CallStart' as any, kind: 'observe' as const },
    ensureStyleInjection: { lifecycle: 'StepStart' as any, kind: 'observe' as const },
    decideSignatureGate: { lifecycle: 'StepFinish' as any, kind: 'guard' as const, role: 'advisor' as const },
  };

  readonly name = 'stylized-output';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description =
    '为会话选定输出风格后，agent 的每次回复都遵循该风格并经签名确认；风格发现自 feature 内置目录与工作区 .agentdev/output-style/，可配置默认风格自动启用。';

  private workspaceDir = process.cwd();
  private stylesDir = '';
  private builtinStylesDir = '';
  private styles: OutputStyleMeta[] = [];
  private activeStyleName: string | null = null;
  /** 用户是否显式清除过选择：true 时默认风格不再自动回填（随快照持久化） */
  private activeStyleCleared = false;
  /** 配置声明的默认风格名（构造 options 或 onInitiate featureConfig） */
  private defaultStyleName: string | null = null;
  private signedForReply = false;
  private blockedCount = 0;
  /** 最近用户输入的 sequence；同一次 call 内的排队插话也会刷新签名与补签条件。 */
  private lastUserSequence: number | null = null;
  /** 已注入风格的内容指纹键：name@hash，风格或文件内容变化时重新注入 */
  private injectedStyleKey: string | null = null;
  private maxSignatureBlocks = DEFAULT_MAX_SIGNATURE_BLOCKS;
  private signatureTolerance = DEFAULT_SIGNATURE_TOLERANCE;
  private lastAction: StylizedOutputStatus['lastAction'] = 'idle';
  private logger?: FeatureInitContext['logger'];
  private _packageInfo: PackageInfo | null = null;

  private workspaceDirOption?: string;

  constructor(options: StylizedOutputOptions = {}) {
    this.maxSignatureBlocks = clampMax(options.maxSignatureBlocks);
    this.signatureTolerance = clampTolerance(options.signatureTolerance);
    this.defaultStyleName = cleanText(options.defaultStyle) || null;
    // 内嵌风格目录随 dist 产物定位（源码装配与 tgz 安装下 dist/styles/ 结构一致）
    this.builtinStylesDir = join(dirname(this.source), BUILTIN_STYLE_DIR_NAME);
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
    // 默认风格只能从 feature 内置风格中选（选项在 manifest 声明时扫描内置目录
    // 生成）；运行时的风格发现与选择仍含工作区 .agentdev/output-style/ 双源合并。
    const builtinStyles = scanStyles(this.builtinStylesDir).styles;
    return {
      schemaVersion: 1,
      settings: {
        properties: {
          defaultStyle: {
            type: 'select',
            title: '默认输出风格',
            description: '会话未选择且未显式清除输出风格时自动启用的风格，选项为本 feature 内置风格。工作区 .agentdev/output-style/ 中的风格仍可在会话控制面板选用（含同名覆盖内置）。',
            options: [
              { label: '不启用默认', value: '' },
              ...builtinStyles.map((style) => ({ label: style.name, value: style.name })),
            ],
          },
          maxSignatureBlocks: {
            type: 'number',
            title: '签名拦截上限',
            description: '同一轮回复中，模型未完成签名而试图结束时的最大连续拦截次数；达到上限后放行结束并记录警告，避免死循环。1–10。',
            default: DEFAULT_MAX_SIGNATURE_BLOCKS,
            min: 1,
            max: 10,
            step: 1,
          },
          signatureTolerance: {
            type: 'number',
            title: '签名笔误容忍',
            description: '签名比对允许的编辑距离占签名长度的百分比（0–10）。0 为严格逐字比对；默认 5：个别错字、近义单字替换、标点全半角等笔误静默放行（仅记警告日志），漏句与大面积改写仍拒绝。',
            default: DEFAULT_SIGNATURE_TOLERANCE,
            min: 0,
            max: 10,
            step: 1,
          },
        },
        sections: [{ id: 'output-style', title: '输出风格', properties: ['defaultStyle', 'maxSignatureBlocks', 'signatureTolerance'] }],
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
    if (featureConfig.signatureTolerance !== undefined) {
      this.signatureTolerance = clampTolerance(featureConfig.signatureTolerance);
    }
    // 宿主 manifest 编辑值优先（与 maxSignatureBlocks 同通道）；空串视为显式撤销默认
    if (featureConfig.defaultStyle !== undefined) {
      this.defaultStyleName = cleanText(featureConfig.defaultStyle) || null;
    }
    const config = ctx.config as { workspaceDir?: unknown } | undefined;
    const workspaceDir = config && typeof config.workspaceDir === 'string' ? config.workspaceDir : '';
    this.workspaceDir = this.workspaceDirOption || workspaceDir || process.cwd();
    this.stylesDir = join(this.workspaceDir, ...STYLE_DIR_SEGMENTS);
    this.rescan('init');
    this.logger?.info('stylized-output 初始化完成', {
      stylesDir: this.stylesDir,
      builtinStylesDir: this.builtinStylesDir,
      styleCount: this.styles.length,
      activeStyle: this.activeStyleName,
      defaultStyle: this.defaultStyleName,
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
        description: '查看与选择本会话的输出风格（feature 内置风格与 .agentdev/output-style/ 目录合并发现）。选择是会话内存态：不落盘、不跨会话继承；未选择时自动启用配置的默认风格，显式清除（传空）后不再自动回填。选中后模型每次最终回复须通过确认签名门禁。',
        parameters: {
          styleName: {
            type: 'string',
            title: '风格名',
            description: '要启用的风格名（须在风格清单中）；传空字符串或 null 显式清除选择（门禁旁路，且默认风格不再自动回填）。',
          },
          maxSignatureBlocks: {
            type: 'number',
            title: '签名拦截上限',
            description: '同一轮回复的最大连续签名拦截次数（1–10），达到上限后放行结束并记录警告。',
            min: 1,
            max: 10,
            step: 1,
          },
          signatureTolerance: {
            type: 'number',
            title: '签名笔误容忍',
            description: '签名比对允许的编辑距离占签名长度的百分比（0–10）。0 为严格逐字比对；默认 5：个别笔误静默放行，漏句与改写仍拒绝。',
            min: 0,
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
          if (typeof input.signatureTolerance === 'number') {
            this.setSignatureTolerance(input.signatureTolerance);
          }
          return Promise.resolve(this.getStatus());
        },
      },
    ];
  }

  /** 签名工具：模型逐字默写当前风格的确认签名，是本轮回复被允许结束的准入凭证 */
  private readonly signTool: Tool = {
    name: 'sign_output_style',
    description:
      '输出风格签名确认工具。当前会话启用输出风格后，每一轮对话收尾时都必须调用本工具完成签名——签名按轮刷新，上一轮的签名对本轮无效，每轮都要重新调用：参数 signature 需逐字默写该风格 frontmatter 中 signature 字段的确认签名原文（上下文中已注入的风格说明里可以查到）。验证通过后本轮回复才被允许结束；未签名就结束会被系统拦截。把签名写进正文不算签名，必须调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        signature: {
          type: 'string',
          description: '当前风格确认签名的原文：逐字默写，不要改写、缩写或附加解释',
        },
      },
      required: ['signature'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    execute: async (args: { signature?: string }) => {
      const active = this.getActiveStyle();
      if (!active) {
        return { ok: false, error: '当前未启用任何输出风格，无需签名；本次调用不产生任何效果。' };
      }
      const provided = normalizeSignature(typeof args?.signature === 'string' ? args.signature : '');
      if (!provided) {
        return {
          ok: false,
          error: 'signature 参数为空。请在上下文中已注入的风格说明里找到 signature 字段原文并逐字默写。',
        };
      }
      const expected = normalizeSignature(active.signature);
      if (provided !== expected) {
        const distance = editDistance(provided, expected);
        const budget = toleranceBudget(expected.length, this.signatureTolerance);
        if (this.signatureTolerance > 0 && distance <= budget) {
          // 笔误宽恕：静默放行，返回与精确通过完全一致；仅日志留痕供审计。
          // 模型可见文案不宣传容错（工具描述 / 注入说明 / 门禁提示仍要求逐字默写），
          // 避免宽恕层从安全网变成常态通道。
          this.logger?.warn('输出风格签名经笔误宽恕通过', {
            style: active.name,
            distance,
            budget,
            tolerancePercent: this.signatureTolerance,
          });
        } else {
          this.logger?.info('输出风格签名不匹配', {
            style: active.name,
            distance,
            budget,
            tolerancePercent: this.signatureTolerance,
          });
          return {
            ok: false,
            signed: false,
            error: this.signatureTolerance > 0
              ? `确认签名与当前风格不匹配：与原文约有 ${distance} 处字符差异，超出笔误容忍上限 ${budget}。差距只有两三处属个别笔误，请对照上下文中已注入的风格说明再逐字默写一次；差距明显说明未对照原文，请调用 show_output_style 核对 signature 字段原文。不要编造或改写。`
              : `确认签名与当前风格不匹配：与原文约有 ${distance} 处字符差异（笔误容忍已关闭，须逐字一致）。请在上下文中已注入的风格说明里核对 signature 字段原文，逐字默写后重试；不要编造或改写。`,
          };
        }
      } else {
        this.logger?.info('输出风格签名验证通过', { style: active.name });
      }
      this.signedForReply = true;
      this.lastAction = 'signed';
      return {
        ok: true,
        signed: true,
        style: active.name,
        note: this.blockedCount > 0
          ? '签名验证通过。签名属于内部流程，不要在给用户的回复正文里提及签名或本工具调用。'
          : '签名验证通过，本轮回复现在可以正常结束。签名属于内部流程：不要在给用户的回复正文里提及签名或本工具调用。面向用户的回复若已完整输出，不必复述全文，用简短几句与用户自然交接收尾即可；尚未输出完整时，再输出完整回复。',
      };
    },
  };

  /** 管理工具：列出全部已发现的输出风格（只读，以磁盘为准） */
  private readonly listTool: Tool = {
    name: 'list_output_styles',
    description:
      '列出当前会话已发现的全部输出风格（feature 内置风格与工作区 .agentdev/output-style/*.md 合并发现，重名时工作区优先）。返回每个风格的名称、一句话描述和是否为当前启用风格，无参数。查看某个风格的完整规则与确认签名请用 show_output_style。',
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
          '未发现任何输出风格。将带 name/description/signature frontmatter 的 md 文件放入 ' + this.stylesDir + '（工作区）即可被发现；本 feature 另带内置风格目录 ' + this.builtinStylesDir + '。';
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
    this.blockedCount = 0;
    this.lastUserSequence = null;
  }

  /** StepStart：同步用户输入边界，并确保当前风格说明已注入上下文。 */
  async ensureStyleInjection(ctx: StepStartContext): Promise<void> {
    const userSequence = ctx.context.query().byRole('user').last()?.sequence ?? null;
    if (userSequence !== this.lastUserSequence) {
      this.signedForReply = false;
      this.blockedCount = 0;
      this.lastUserSequence = userSequence;
    }
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
      '在你给出本轮最终回复的同时，调用 sign_output_style 工具，参数 signature 逐字默写上面 frontmatter 中 signature 字段的原文。',
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
   * - 拦截后成功补签 → Deny 结束当前回复，不再为收尾额外调用模型。
   * - 未启用风格 / 子代理与 wait 等机制活跃 / 普通签名或工具步 → 不干预（Continue）。
   * - 自然结束但未签名 → 注入复核补签的 system 消息并 Approve 强制再跑一轮；
   *   连续拦截达到上限后放行并告警（防死循环）。
   */
  async decideSignatureGate(ctx: StepFinishDecisionContext) {
    const active = this.getActiveStyle();
    if (!active) return Decision.Continue;
    if (ctx.hasActiveSubAgents || ctx.hasPendingMessages || ctx.waitCalled) {
      return Decision.Continue;
    }
    if (this.signedForReply && this.blockedCount > 0) {
      this.blockedCount = 0;
      this.logger?.info('输出风格签名门禁：补签成功，结束本轮回复', { style: active.name });
      return Decision.Deny;
    }
    if (ctx.toolCallsCount !== 0) return Decision.Continue;
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
      '当前已启用输出风格「' + active.name + '」，但本轮回复尚未完成签名确认，暂不能结束。',
      '若已完成面向用户的最终输出，请复核已有表述是否符合该风格：符合则直接签名；有不符合之处，只需作必要补充或局部重新表述，无需全文重写。',
      '若忘记风格要求或确认签名原文，请调用 show_output_style（不传参数即可查看当前风格完整说明）。',
      '自检无误后，调用 sign_output_style，参数 signature 逐字默写该风格说明中 signature 字段的原文。直接在正文中书写签名无效。',
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
      activeStyleCleared: this.activeStyleCleared,
      signedForReply: this.signedForReply,
      blockedCount: this.blockedCount,
      lastUserSequence: this.lastUserSequence,
      injectedStyleKey: this.injectedStyleKey,
      lastAction: this.lastAction,
    };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
    this.activeStyleName = cleanText(state.activeStyleName) || null;
    // 旧快照无此字段按 false 处理：存量会话恢复后同样能获得默认风格回填
    this.activeStyleCleared = state.activeStyleCleared === true;
    this.signedForReply = state.signedForReply === true;
    this.blockedCount = typeof state.blockedCount === 'number' && Number.isFinite(state.blockedCount)
      ? Math.max(0, Math.floor(state.blockedCount))
      : 0;
    this.lastUserSequence = typeof state.lastUserSequence === 'number' && Number.isFinite(state.lastUserSequence)
      ? state.lastUserSequence
      : null;
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
      defaultStyle: this.defaultStyleName,
      signedForReply: this.signedForReply,
      blockedCount: this.blockedCount,
      maxSignatureBlocks: this.maxSignatureBlocks,
      signatureTolerance: this.signatureTolerance,
      lastAction: this.lastAction,
    };
  }

  /** 调整签名拦截上限（1–10 钳制） */
  setMaxSignatureBlocks(value: number): StylizedOutputStatus {
    this.maxSignatureBlocks = clampMax(value);
    return this.getStatus();
  }

  /** 调整签名笔误容忍比例（0–10 钳制；0 = 严格逐字比对，回退旧行为） */
  setSignatureTolerance(value: number): StylizedOutputStatus {
    this.signatureTolerance = clampTolerance(value);
    return this.getStatus();
  }

  /**
   * 设置当前风格（会话内存态，立即生效，不落盘）；传 null 显式清空选择——
   * 清空后记 activeStyleCleared，默认风格不再自动回填，直到再次显式选择。
   * 面板 configure capability 与未来控制面共用的写入入口；模型不可见。
   * 选择只随 Feature 状态快照在会话恢复时还原。
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
      this.activeStyleCleared = false;
    } else {
      this.activeStyleName = null;
      this.activeStyleCleared = true;
    }
    this.signedForReply = false;
    this.blockedCount = 0;
    return this.getStatus();
  }

  // ---------- 内部 ----------

  /** 重扫风格（双源合并）；reason 只影响日志语境。风格选择是内存态，此处不读写任何选择文件 */
  private rescan(reason: 'init' | 'call' | 'set' | 'tool'): void {
    const { styles, warnings } = scanAllStyles(this.builtinStylesDir, this.stylesDir);
    for (const warning of warnings) this.logger?.warn('[stylized-output] ' + warning);
    this.styles = styles;
    // 内存中选中的风格文件被删除/改名时主动失效，保持状态自洽（门禁旁路）。
    if (this.activeStyleName && !styles.some((style) => style.name === this.activeStyleName)) {
      this.logger?.warn(
        '[stylized-output] 已选风格 "' + this.activeStyleName + '" 不在最新扫描结果中（' + reason + '），按未选择处理',
      );
      this.activeStyleName = null;
      this.signedForReply = false;
      this.blockedCount = 0;
    }
    // 默认风格回填：未选择且未被显式清除时自动启用（新会话 / 接续会话 / 旧会话恢复统一走这里）
    if (!this.activeStyleName && !this.activeStyleCleared && this.defaultStyleName) {
      if (styles.some((style) => style.name === this.defaultStyleName)) {
        this.activeStyleName = this.defaultStyleName;
        this.logger?.info('[stylized-output] 未选择输出风格，已回填默认风格 "' + this.defaultStyleName + '"', { reason });
      }
    }
  }
}

export default StylizedOutput;