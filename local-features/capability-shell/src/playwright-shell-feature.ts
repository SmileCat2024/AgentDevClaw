/**
 * PlaywrightShellFeature — playwright 领域 shell 挂载（ticket 036）
 *
 * 在 033 基座（管线四道检查点 + 工具工厂）上装配第二个领域 shell：
 * ProgrammingHelperAgent（main 身份）构造函数挂载，提供 `playwright_shell`
 * 工具。
 *
 * v2 扩展：双模式动词面 ——
 * - one-shot 产物动词（screenshot / pdf / har + env）：渲染即退出，浏览器不驻留；
 * - 受控会话动词（open/goto/snapshot/find/fill/press/click/tab-list/tab-select/close）：
 *   转发 @playwright/cli daemon 子命令，跨调用共享同一页面；refs 机制
 *   （click/fill 只接受 snapshot 输出的元素引用）是防注入核心约束。
 *
 * CLI 资产管理（简报 §4 既定模式）：
 * - CLI 入口显式路径寻址（不经 PATH / npx）；会话后端 @playwright/cli 同法；
 * - 浏览器资产目录注入 PLAYWRIGHT_BROWSERS_PATH（自管位置，config 可覆盖；
 *   缺省 ~/.agentdev/assets/playwright-shell/browsers），安装属装配期人工动作；
 * - env 动词报告存在性/版本/匹配，缺失时给人工修复指引（不裸抛）。
 * - 会话 daemon 跨调用存活：close 动词显式收尾；onDestroy 兜底 kill-all。
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AgentFeature, Tool } from '@agentdevjs/core';
import { createCapabilityShellTool } from './tool-factory.js';
import { createPlaywrightAdapters } from './playwright-shell.js';
import { createPlaywrightShellPolicy } from './playwright-policy.js';

const __filename = fileURLToPath(import.meta.url);

export interface PlaywrightShellFeatureConfig {
  /** playwright 包根目录（含 cli.js）；缺省经 createRequire 自动解析 */
  packageRoot?: string;
  /** CLI 入口 js 绝对路径；缺省 <packageRoot>/cli.js */
  cliEntry?: string;
  /** 会话后端入口（@playwright/cli bin js）；缺省经 createRequire 自动解析 */
  sessionCliEntry?: string;
  /** 浏览器资产目录（PLAYWRIGHT_BROWSERS_PATH 注入值）；缺省 ~/.agentdev/assets/playwright-shell/browsers */
  browsersPath?: string;
  /** spawn 工作目录与产物路径解析基准；缺省 process.cwd() */
  workdir?: string;
  /** 覆盖工具默认超时（毫秒；超时唯一闸门 = Tool.timeout 契约） */
  timeoutMs?: number;
  /** 覆盖超时上限（缺省 600000） */
  maxTimeoutMs?: number;
}

/** @playwright/cli bin 路径解析（package.json bin 契约固定）。 */
export function resolveSessionCliEntry(from: string, explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    const req = createRequire(from);
    const pkgJson = req.resolve('@playwright/cli/package.json');
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { bin?: Record<string, string> | string };
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['playwright-cli'];
    if (!binRel) return null;
    return join(dirname(pkgJson), binRel);
  } catch {
    return null; // 会话后端未安装：动词报文给人工修复指引
  }
}

/**
 * PlaywrightShellFeature — playwright 领域 shell 挂载（ticket 036 v2）
 *
 * 提供 `playwright_shell` 工具：单次产物取证（v1）+ 受控页面会话（v2）。
 * 与 coder 领域 shell（CapabilityShellFeature）同基座、同管线、同边界模型。
 */
export class PlaywrightShellFeature implements AgentFeature {
  readonly name = 'playwright-shell';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description =
    '浏览器页面取证与受控页面会话（playwright_shell 工具）：一次性产物（截图/PDF/HAR）' +
    '与多步页面交互（导航/输入/点击/读取，refs 防注入），双模式 headless/headed。';

  private readonly config: PlaywrightShellFeatureConfig;

  constructor(config: PlaywrightShellFeatureConfig = {}) {
    this.config = { ...config };
  }

  getTools(): Tool[] {
    const adapters = createPlaywrightAdapters({
      packageRoot: this.config.packageRoot,
      cliEntry: this.config.cliEntry,
      sessionCliEntry: this.config.sessionCliEntry,
      browsersPath: this.config.browsersPath,
      workdir: this.config.workdir,
    });
    return [
      createCapabilityShellTool(
        createPlaywrightShellPolicy(),
        adapters,
        {
          bashPath: null,
          ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
          ...(this.config.maxTimeoutMs !== undefined ? { maxTimeoutMs: this.config.maxTimeoutMs } : {}),
          ...(this.config.workdir !== undefined ? { workdir: this.config.workdir } : {}),
        },
      ),
    ];
  }

  /**
   * 生命周期兜底：feature 销毁时强制回收残留会话 daemon（正常路径模型用
   * close 收尾；这里防 agent 关闭时页面会话泄漏）。官方 kill-all 幂等。
   */
  async onDestroy(): Promise<void> {
    try {
      const entry = resolveSessionCliEntry(__filename, this.config.sessionCliEntry);
      if (!entry) return;
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, [entry, 'kill-all'], {
          cwd: this.config.workdir ?? process.cwd(),
          env: { ...process.env },
          stdio: 'ignore',
          detached: false,
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* 已退出 */ }
          resolve();
        }, 3000);
        timer.unref?.();
      });
    } catch { /* 兜底失败不阻塞销毁 */ }
  }
}
