/**
 * GitHubFeature — 为 Agent 提供 GitHub 平台的读写能力
 *
 * 直接调用 GitHub REST/GraphQL API，不依赖 MCP Server 或 gh CLI 执行。
 * 认证策略：manifest 配置的 PAT 优先；未配置时尝试从 gh CLI 读取 token。
 * gh CLI 仅作为认证来源，不参与任何实际 API 调用。
 *
 * 工具按 toolset 分组，通过 manifest 可选择性启用。
 */

import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import type { AgentFeature, FeatureInitContext, Tool, PackageInfo, FeatureManifestDefinition } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';
import { GitHubClient } from './client.js';
import { createGitHubTools, type GitHubToolDefaults } from './tools.js';

const __filename = fileURLToPath(import.meta.url);

const ALL_TOOLSETS = ['context', 'repo', 'issues', 'pr', 'actions', 'notifications'] as const;
type ToolsetId = typeof ALL_TOOLSETS[number];

export interface GitHubFeatureConfig {
  token?: string;
  apiBaseUrl?: string;
  defaultOwner?: string;
  defaultRepo?: string;
  /** 启用的工具集，未指定时全部启用（notifications 除外，默认关闭） */
  enabledToolsets?: string[];
}

export class GitHubFeature implements AgentFeature {
  readonly name = 'github';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'GitHub 平台集成：仓库浏览、Issue/PR 管理、CI 日志分析。直接调用 GitHub API，无需 MCP。';

  private _packageInfo: PackageInfo | null = null;
  private _token: string | null = null;
  private _apiBaseUrl: string | undefined;
  private _defaults: GitHubToolDefaults = {};
  private _enabledToolsets: Set<string>;

  constructor(config: GitHubFeatureConfig = {}) {
    if (config.token) this._token = config.token;
    if (config.apiBaseUrl) this._apiBaseUrl = config.apiBaseUrl;
    if (config.defaultOwner) this._defaults.defaultOwner = config.defaultOwner;
    if (config.defaultRepo) this._defaults.defaultRepo = config.defaultRepo;

    // 默认：除 notifications 外全部启用
    this._enabledToolsets = new Set(
      config.enabledToolsets
        ?? ALL_TOOLSETS.filter(t => t !== 'notifications')
    );
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          token: {
            type: 'string',
            title: 'GitHub Token',
            description: '在此填入你的 GitHub Personal Access Token。建议勾选 repo、workflow、read:org 权限。如果留空且本机已安装并登录 gh CLI，将自动使用 gh 的凭据。',
            placeholder: 'ghp_xxxxxxxxxxxx',
          },
          apiBaseUrl: {
            type: 'string',
            title: 'API 地址',
            description: '使用 github.com 时留空即可。如果你使用 GitHub Enterprise，请填写 API 地址，例如 https://github.my-company.com/api/v3。',
            placeholder: 'https://api.github.com',
          },
          defaultOwner: {
            type: 'string',
            title: '默认仓库所属者',
            description: '配置后，调用 GitHub 工具时可以省略 owner 参数，系统会自动填充这里设置的值。不填则每次调用都需要手动指定。',
            placeholder: 'my-org',
          },
          defaultRepo: {
            type: 'string',
            title: '默认仓库名',
            description: '配合"默认仓库所属者"使用。配置后调用工具时可省略 repo 参数。',
            placeholder: 'my-repo',
          },
          enableContext: {
            type: 'boolean',
            title: '身份查询',
            description: '启用后，Agent 可以查询当前登录的 GitHub 用户信息。',
            default: true,
          },
          enableRepo: {
            type: 'boolean',
            title: '仓库浏览',
            description: '启用后，Agent 可以读取仓库文件、搜索代码、查看提交历史和分支。',
            default: true,
          },
          enableIssues: {
            type: 'boolean',
            title: 'Issue 管理',
            description: '启用后，Agent 可以创建、更新、搜索 Issue 并发表评论。',
            default: true,
          },
          enablePr: {
            type: 'boolean',
            title: 'Pull Request 管理',
            description: '启用后，Agent 可以创建和合并 PR、查看 Review、回复评审意见。',
            default: true,
          },
          enableActions: {
            type: 'boolean',
            title: 'CI / Actions',
            description: '启用后，Agent 可以查看 CI 运行状态、获取失败日志并分析构建失败原因。',
            default: true,
          },
          enableNotifications: {
            type: 'boolean',
            title: '通知',
            description: '启用后，Agent 可以查看 GitHub 通知列表并标记已读。默认关闭。',
            default: false,
          },
        },
        sections: [
          { id: 'main', title: 'GitHub', properties: ['token', 'apiBaseUrl', 'defaultOwner', 'defaultRepo', 'enableContext', 'enableRepo', 'enableIssues', 'enablePr', 'enableActions', 'enableNotifications'] },
        ],
      },
    };
  }

  /**
   * 初始化：从 featureConfig（system feature config 的 github 节）读取运行时配置，
   * 覆盖构造函数默认值。
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    const fc = ctx.featureConfig;
    if (fc && typeof fc === 'object') {
      const c = fc as Record<string, unknown>;
      if (typeof c.token === 'string' && c.token.trim()) this._token = c.token.trim();
      if (typeof c.apiBaseUrl === 'string' && c.apiBaseUrl.trim()) this._apiBaseUrl = c.apiBaseUrl.trim();
      if (typeof c.defaultOwner === 'string' && c.defaultOwner.trim()) this._defaults.defaultOwner = c.defaultOwner.trim();
      if (typeof c.defaultRepo === 'string' && c.defaultRepo.trim()) this._defaults.defaultRepo = c.defaultRepo.trim();

      // 从 manifest boolean 字段重建 toolset set
      const toolsetMap: Record<string, string> = {
        enableContext: 'context',
        enableRepo: 'repo',
        enableIssues: 'issues',
        enablePr: 'pr',
        enableActions: 'actions',
        enableNotifications: 'notifications',
      };
      const newToolsets = new Set<string>();
      for (const [manifestKey, toolsetId] of Object.entries(toolsetMap)) {
        // manifest 中未出现的 key 不改变默认值；出现的 key 按 boolean 取值
        if (c[manifestKey] !== undefined) {
          if (c[manifestKey] !== false) newToolsets.add(toolsetId);
        }
      }
      if (newToolsets.size > 0) this._enabledToolsets = newToolsets;
    }

    // 如果没有 token，尝试从 gh CLI 读取
    if (!this._token) {
      this._token = resolveGhToken();
    }

    const logger = ctx.logger;
    if (logger) {
      logger.info('GitHubFeature initiated', {
        hasToken: !!this._token,
        tokenSource: this._token ? (ctx.featureConfig && (ctx.featureConfig as any)?.token ? 'manifest' : 'gh-cli') : 'none',
        enabledToolsets: Array.from(this._enabledToolsets),
      });
    }
  }

  /**
   * 异步工具注册：根据配置创建 client 和工具。
   * 如果没有 token，仍然注册工具——调用时会返回认证错误。
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    // 如果 onInitiate 还没跑（首次 getAsyncTools 在 onInitiate 之前调用），
    // 也从 featureConfig 尝试读一次
    const fc = _ctx.featureConfig;
    if (fc && typeof fc === 'object') {
      const c = fc as Record<string, unknown>;
      if (!this._token && typeof c.token === 'string' && c.token.trim()) {
        this._token = c.token.trim();
      }
      if (!this._apiBaseUrl && typeof c.apiBaseUrl === 'string' && c.apiBaseUrl.trim()) {
        this._apiBaseUrl = c.apiBaseUrl.trim();
      }
      if (!this._defaults.defaultOwner && typeof c.defaultOwner === 'string' && c.defaultOwner.trim()) {
        this._defaults.defaultOwner = c.defaultOwner.trim();
      }
      if (!this._defaults.defaultRepo && typeof c.defaultRepo === 'string' && c.defaultRepo.trim()) {
        this._defaults.defaultRepo = c.defaultRepo.trim();
      }
    }

    // gh CLI 兜底
    if (!this._token) {
      this._token = resolveGhToken();
    }

    // 即使没有 token 也创建 client，工具调用时会自然返回认证错误
    const effectiveToken = this._token || '';
    const client = new GitHubClient({
      token: effectiveToken,
      apiBaseUrl: this._apiBaseUrl,
    });

    return createGitHubTools(client, this._defaults, this._enabledToolsets);
  }
}

/**
 * 尝试从本地 gh CLI 读取认证 token。
 * gh 仅作为 token 来源，不用于任何实际 API 调用。
 * 失败时静默返回 null。
 */
function resolveGhToken(): string | null {
  try {
    const output = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = output.trim();
    return token || null;
  } catch {
    return null;
  }
}
