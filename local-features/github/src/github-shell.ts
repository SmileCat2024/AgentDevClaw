/** GitHub domain shell policy and adapters. */
import type { Tool } from '@agentdevjs/core';
import type { CapabilityShellPolicy } from '../../capability-shell/src/types.js';

export const GITHUB_SHELL_NAME = 'github_shell';

function commandName(toolName: string): string {
  return toolName.replace(/^gh_/, '').replaceAll('_', '-');
}

function flagName(property: string): string {
  return `--${property.replaceAll('_', '-')}`;
}

export function createGitHubShellPolicy(tools: Tool[]): CapabilityShellPolicy {
  const verbs: CapabilityShellPolicy['verbs'] = {};
  for (const tool of tools) {
    const properties = (tool.parameters as any)?.properties ?? {};
    const verb = commandName(tool.name);
    verbs[verb] = {
      description: tool.description,
      params: [],
      flags: Object.keys(properties).map((key) => `${flagName(key)}=`),
      usage: `${verb}${Object.keys(properties).length ? ` ${Object.keys(properties).map((key) => {
        const required = ((tool.parameters as any)?.required ?? []).includes(key);
        const option = `${flagName(key)}=<value>`;
        return required ? option : `[${option}]`;
      }).join(' ')}` : ''}`, 
      adapter: { key: `github:${tool.name}` },
    };
  }
  return {
    name: GITHUB_SHELL_NAME,
    description: 'GitHub 仓库、Issue、Pull Request、Actions 与通知操作。使用 help 查看命令；参数使用 --name=value 形式。首次使用或涉及 PR review、CI 排查与发布流程时，先激活 github-workflows 技能。',
    verbs,
  };
}

export function createGitHubShellAdapters(tools: Tool[]): Record<string, (args: string[]) => Promise<string>> {
  return Object.fromEntries(tools.map((tool) => {
    const properties = (tool.parameters as any)?.properties ?? {};
    const propertyByFlag = new Map(Object.keys(properties).map((key) => [flagName(key), key]));
    return [`github:${tool.name}`, async (args: string[]) => {
      const values: Record<string, unknown> = {};
      for (const arg of args) {
        const equals = arg.indexOf('=');
        const rawName = equals < 0 ? arg : arg.slice(0, equals);
        const key = propertyByFlag.get(rawName);
        if (!key) throw new Error(`Unsupported GitHub argument: ${rawName}`);
        const schema = properties[key];
        if (equals < 0) throw new Error(`${rawName} requires a value (use ${rawName}=<value>)`);
        const rawValue = arg.slice(equals + 1);
        if (schema?.type === 'boolean') {
          if (rawValue !== 'true' && rawValue !== 'false') throw new Error(`${rawName} must be true or false`);
          values[key] = rawValue === 'true';
        } else if (schema?.type === 'number' || schema?.type === 'integer') {
          const number = Number(rawValue);
          if (!Number.isFinite(number)) throw new Error(`${rawName} must be a number`);
          if (schema.type === 'integer' && !Number.isInteger(number)) throw new Error(`${rawName} must be an integer`);
          values[key] = number;
        } else if (schema?.type === 'array' || schema?.type === 'object') {
          try {
            values[key] = JSON.parse(rawValue);
          } catch {
            throw new Error(`${rawName} must be valid JSON`);
          }
        } else values[key] = rawValue;
      }
      const required: string[] = (tool.parameters as any)?.required ?? [];
      const missing = required.filter((key) => values[key] === undefined);
      if (missing.length) throw new Error(`Missing required option(s): ${missing.map(flagName).join(', ')}`);
      const result = await tool.execute(values as any, undefined as any);
      if (typeof result === 'string') return result;
      if (result && typeof result === 'object') {
        const record = result as Record<string, unknown>;
        return String(record.text ?? record.error ?? JSON.stringify(result));
      }
      return String(result ?? 'ok');
    }];
  }));
}
