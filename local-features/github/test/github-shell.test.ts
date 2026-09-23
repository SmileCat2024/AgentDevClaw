import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tool } from '@agentdevjs/core';
import { createGitHubShellAdapters, createGitHubShellPolicy } from '../src/github-shell.js';
import { runCapabilityShellPipeline } from '../../capability-shell/src/tool-factory.js';

test('GitHub shell exposes one command per existing GitHub capability', async () => {
  const calls: unknown[] = [];
  const tools = [{
    name: 'gh_get_pr',
    description: 'View a pull request.',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        pull_number: { type: 'number' },
        comments: { type: 'boolean' },
      },
      required: ['pull_number'],
    },
    execute: async (args: unknown) => {
      calls.push(args);
      return { success: true, text: 'PR #42' };
    },
  }] as unknown as Tool[];
  const policy = createGitHubShellPolicy(tools);
  const adapters = createGitHubShellAdapters(tools);

  assert.deepEqual(Object.keys(policy.verbs), ['get-pr']);
  const result = await runCapabilityShellPipeline(policy, 'get-pr --owner=acme --pull-number=42 --comments=true', {
    adapters,
    bashPath: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'PR #42');
  assert.deepEqual(calls, [{ owner: 'acme', pull_number: 42, comments: true }]);
});

test('GitHub shell rejects unregistered commands and arguments', async () => {
  const tools = [{
    name: 'gh_get_me',
    description: 'Show authenticated user.',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  }] as unknown as Tool[];
  const policy = createGitHubShellPolicy(tools);
  const adapters = createGitHubShellAdapters(tools);

  const unknown = await runCapabilityShellPipeline(policy, 'api repos/acme/project', { adapters, bashPath: null });
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /不是 github_shell 的可用动词/);

  const badArg = await runCapabilityShellPipeline(policy, 'get-me --token=secret', { adapters, bashPath: null });
  assert.equal(badArg.ok, false);
  assert.match(badArg.output, /期望 0 个参数/);
});
