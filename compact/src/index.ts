/**
 * Compact Feature
 */

import { fileURLToPath } from 'url';
import type {
  AgentFeature,
  FeatureInitContext,
  PackageInfo,
} from 'agentdev';
import type { Tool } from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';

export interface CompactConfig {
  /** 配置选项 */
  enabled?: boolean;
}

export class Compact implements AgentFeature {
  readonly name = 'Compact';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = 'Compact feature';

  private config: CompactConfig;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: CompactConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
    };
  }

  /**
   * 获取包信息
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表
   */
  getTemplateNames(): string[] {
    return [];
  }

  /**
   * 获取工具列表
   */
  getTools(): Tool[] {
    return [];
  }

  /**
   * 异步获取工具列表
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    return [];
  }

  /**
   * 初始化
   */
  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // TODO: Feature 初始化逻辑
  }

  /**
   * 清理资源
   */
  async onDestroy(): Promise<void> {
    // TODO: Feature 清理逻辑
  }
}
