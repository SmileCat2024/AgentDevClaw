#!/usr/bin/env node

/**
 * claw - AgentDevClaw workspace CLI (thin shell)
 *
 * Routes all commands through claw-core provider registry.
 * Legacy commands (exp, subs, show, spawn, compact, resume)
 * are aliases for the default workspace operations.
 */

import {
  loadProviders, listProviders, getProvider, getDefaultWorkspaceId,
  dispatch, cleanText, truncate, formatDate,
} from '../server/claw-core.mjs';

// ── Legacy command → operation name mapping ─────────────────────

const LEGACY_ALIASES = {
  'exp': 'explorations',
  'explorations': 'explorations',
  'subs': 'subs',
  'sub': 'subs',
  'show': 'show',
  'get': 'show',
  'spawn': 'spawn',
  'compact': 'compact',
  'compress': 'compact',
  'resume': 'resume',
};

// ── Main ────────────────────────────────────────────────────────

async function main() {
  await loadProviders();

  const args = process.argv.slice(2);
  const command = args[0] || '';
  const defaultWs = getDefaultWorkspaceId();

  if (command === '') {
    await cmdOverview(defaultWs);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'ws') {
    await handleWs(args.slice(1));
    return;
  }

  if (LEGACY_ALIASES[command]) {
    await handleLegacy(defaultWs, LEGACY_ALIASES[command], args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run claw help for usage');
  process.exit(1);
}

// ── Help ────────────────────────────────────────────────────────

function printHelp() {
  const providers = listProviders();
  console.log('claw - AgentDevClaw workspace CLI');
  console.log('');
  console.log('Workspaces:');
  for (const p of providers) {
    console.log(`  ${p.id}   ${p.name} - ${p.description}`);
  }
  console.log('');
  console.log('Commands:');
  console.log('  claw                                   Overview');
  console.log('  claw ws                                List all workspaces');
  console.log('  claw ws <id> [command] [args]          Workspace operation');
  console.log('  claw ws <id> help                      Workspace operations list');
  console.log('');
  console.log('Legacy aliases (default workspace):');
  console.log('  claw exp [--limit N] [--file F] [--keyword K]');
  console.log('  claw subs');
  console.log('  claw show <id>');
  console.log('  claw spawn --goal "..." [--blocking]');
  console.log('  claw spawn <exp-id>... --goal "..."');
  console.log('  claw compact <exp-id>');
  console.log('  claw resume <sub-id> --msg "..."');
}

// ── Overview ────────────────────────────────────────────────────

async function cmdOverview(defaultWs) {
  if (!defaultWs) {
    console.log('No workspace providers registered.');
    return;
  }
  const { ok, result } = await dispatch(defaultWs, 'overview');
  console.log('AgentDevClaw  workspace CLI');
  console.log('');
  if (ok) {
    console.log(`  Workspace: ${defaultWs}`);
    console.log(`  Directory: ${result.workingDirectory}`);
    console.log(`  Explorations: ${result.explorationCount}`);
    console.log(`  Sub-agents: ${result.subAgentCount}`);
  }
  console.log('');
  console.log('  claw ws                List all workspaces');
  console.log('  claw exp               List explorations');
  console.log('  claw spawn --goal ...  Spawn exploration');
  console.log('  claw compact <id>      Compact exploration');
  console.log('  claw resume <id> --msg Resume sub-agent');
}

// ── ws command ──────────────────────────────────────────────────

async function handleWs(args) {
  if (args.length === 0) {
    const providers = listProviders();
    console.log(`Workspaces (${providers.length}):`);
    console.log('');
    for (const p of providers) {
      console.log(`  ${p.id}   ${p.name}`);
      console.log(`    ${truncate(p.description, 100)}`);
      console.log(`    operations: ${p.operations.map(op => op.name).join(', ')}`);
      console.log('');
    }
    return;
  }

  const wsId = args[0];
  const provider = getProvider(wsId);
  if (!provider) {
    console.error(`Unknown workspace: ${wsId}`);
    console.error('Available: ' + listProviders().map(p => p.id).join(', '));
    process.exit(1);
  }

  const subCommand = args[1] || 'overview';

  if (subCommand === 'help') {
    console.log(`${provider.name} (${provider.id})`);
    console.log(provider.description);
    console.log('');
    console.log('Operations:');
    for (const op of provider.operations) {
      const paramStr = (op.params || []).map(p =>
        p.required ? `--${p.name} <required>` : `[--${p.name}]`
      ).join(' ');
      console.log(`  claw ws ${wsId} ${op.name}${paramStr ? ' ' + paramStr : ''}`);
      console.log(`    ${op.description}`);
    }
    return;
  }

  const operation = provider.operations.find(op => op.name === subCommand);
  if (!operation) {
    console.error(`Unknown operation: ${subCommand}`);
    console.error('Available: ' + provider.operations.map(op => op.name).join(', '));
    process.exit(1);
  }

  const params = parseOpParams(operation, args.slice(2));
  const { ok, result, error } = await dispatch(wsId, subCommand, params);

  if (!ok) {
    console.error('Error: ' + error);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

// ── Legacy command handlers ─────────────────────────────────────

async function handleLegacy(wsId, opName, args) {
  const params = parseLegacyArgs(opName, args);
  const { ok, result, error } = await dispatch(wsId, opName, params);

  if (!ok) {
    console.error('Error: ' + error);
    process.exit(1);
  }

  formatLegacyOutput(opName, result, params);
}

function parseOpParams(operation, args) {
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      params[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (!args[i].startsWith('-') && operation.params && operation.params.length > 0) {
      params[operation.params[0].name] = args[i];
    }
  }
  return params;
}

function parseLegacyArgs(opName, args) {
  const params = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--goal' && args[i + 1]) { params.goal = args[i + 1]; i++; }
    else if (args[i] === '--msg' && args[i + 1]) { params.message = args[i + 1]; i++; }
    else if (args[i] === '--limit' && args[i + 1]) { params.limit = parseInt(args[i + 1], 10) || 20; i++; }
    else if (args[i] === '--file' && args[i + 1]) { params.file = args[i + 1]; i++; }
    else if (args[i] === '--keyword' && args[i + 1]) { params.keyword = args[i + 1]; i++; }
    else if (args[i] === '--blocking' || args[i] === '--wait') { params.blocking = true; }
    else if (!args[i].startsWith('-')) { positional.push(args[i]); }
  }

  if (opName === 'show' || opName === 'compact') {
    if (positional.length > 0) params.sessionId = positional[0];
  } else if (opName === 'spawn') {
    if (positional.length > 0) params.from = positional.join(',');
  } else if (opName === 'resume') {
    if (positional.length > 0) params.sessionId = positional[0];
  }

  return params;
}

function formatLegacyOutput(opName, result, params) {
  // Provider-level error (result has error but no ok/records/type)
  if (result && result.error && result.ok === undefined && !result.records && !result.type) {
    console.error('Error: ' + result.error);
    process.exit(1);
  }

  switch (opName) {
    case 'explorations': {
      const records = result.records || [];
      if (records.length === 0) {
        console.log(params.file || params.keyword ? 'No matching explorations found' : 'No explorations yet');
        console.log('Use claw spawn --goal "..." to start');
        return;
      }
      const filterDesc = params.file || params.keyword
        ? ' (filter: ' + (params.file ? 'file="' + params.file + '"' : '') +
          (params.file && params.keyword ? ', ' : '') +
          (params.keyword ? 'keyword="' + params.keyword + '"' : '') + ')'
        : '';
      console.log(`Explorations (${result.total}${result.total > records.length ? ', showing ' + records.length : ''}${filterDesc})`);
      console.log('');
      for (const r of records) {
        const shortId = r.id.length > 30 ? '...' + r.id.slice(-24) : r.id;
        console.log('  ' + shortId);
        console.log('    ' + truncate(r.goal, 80));
        if (r.importantFiles && r.importantFiles.length > 0) {
          const fp = r.importantFiles.slice(0, 4).map(f => (f.split('/').pop() || f)).join(', ');
          console.log('    explored: ' + truncate(fp, 100) + (r.importantFiles.length > 4 ? ' +' + (r.importantFiles.length - 4) + ' more' : ''));
        } else if (r.hasSummary) {
          console.log('    (has summary)');
        } else {
          console.log('    (no summary)');
        }
        if (r.domains && r.domains.length > 0) console.log('    domains: ' + r.domains.join(', '));
        const date = r.timestamp ? formatDate(r.timestamp) : '';
        const gitInfo = r.gitMeta ? ' · ' + (r.gitMeta.branch || '?') + '@' + (r.gitMeta.commitHash || '?') : '';
        console.log('    ' + (r.status === 'locked' ? '已锁定' : '运行中') + ' · ' + date + gitInfo);
        console.log('');
      }
      return;
    }

    case 'subs': {
      const records = result.records || [];
      if (records.length === 0) {
        console.log('暂无子代理对话');
        console.log('使用 claw spawn <exp-id> --goal "..." 启动子代理');
        return;
      }
      console.log(`子代理对话 (${records.length} 个)`);
      console.log('');
      for (const r of records) {
        const shortId = r.id.length > 30 ? '...' + r.id.slice(-24) : r.id;
        console.log('  ' + shortId);
        console.log('    ' + truncate(r.goal, 80));
        if (r.domains && r.domains.length > 0) console.log('    领域: ' + r.domains.join(', '));
        if (r.sourceExplorationIds && r.sourceExplorationIds.length > 0) console.log('    来源: ' + r.sourceExplorationIds.join(', '));
        console.log('    ' + formatDate(r.createdAt));
        console.log('');
      }
      return;
    }

    case 'show': {
      if (result.error) {
        console.error(result.error);
        process.exit(1);
      }
      if (result.type === 'exploration') {
        console.log(`探索记录 · ${result.id}`);
        console.log('目标: ' + result.goal);
        console.log('状态: ' + (result.status === 'locked' ? '已锁定' : '运行中'));
        if (result.domains && result.domains.length > 0) console.log('领域: ' + result.domains.join(', '));
        console.log('摘要: ' + (result.hasSummary ? '已生成' : '未生成（claw compact 生成）'));
        console.log('消息: ' + result.messageCount + ' 条');
        if (result.result) {
          console.log('');
          console.log('--- 探索结果 ---');
          console.log(result.result);
          console.log('--- 结束 ---');
        }
      } else {
        console.log(`子代理对话 · ${result.id}`);
        console.log('目标: ' + result.goal);
        if (result.sourceExplorationIds && result.sourceExplorationIds.length > 0) {
          console.log('来源探索: ' + result.sourceExplorationIds.join(', '));
        }
        console.log('消息: ' + result.messageCount + ' 条');
        if (result.finalOutput) {
          console.log('');
          console.log('--- 最终输出 ---');
          console.log(result.finalOutput);
          console.log('--- 结束 ---');
        }
      }
      return;
    }

    case 'spawn': {
      if (result.error) {
        console.error(params.from ? '子代理执行失败' : '探索执行失败');
        console.error('  错误: ' + result.error);
        process.exit(1);
      }
      console.log(params.from ? '子代理执行完成' : '探索完成');
      console.log('  会话 ID: ' + result.sessionId);
      console.log('  类型: ' + result.sessionType);
      console.log('  耗时: ' + (result.durationMs / 1000).toFixed(1) + 's');
      if (result.response) {
        console.log('');
        console.log('--- 执行结果 ---');
        console.log(result.response);
        console.log('--- 结束 ---');
      }
      return;
    }

    case 'compact': {
      if (result.error) {
        console.error('压缩失败: ' + result.error);
        process.exit(1);
      }
      console.log('压缩完成');
      console.log('  摘要长度: ' + result.summaryLength + ' 字符');
      if (result.sessionTitle) console.log('  对话标题: ' + result.sessionTitle);
      if (result.importantFiles && result.importantFiles.length > 0) {
        console.log('  重要文件:');
        for (const f of result.importantFiles) console.log('    - ' + f);
      }
      console.log('');
      console.log(result.summaryText);
      return;
    }

    case 'resume': {
      if (result.error) {
        console.error('续接失败');
        console.error('  错误: ' + result.error);
        process.exit(1);
      }
      console.log('子代理续接完成');
      console.log('  耗时: ' + (result.durationMs / 1000).toFixed(1) + 's');
      if (result.response) {
        console.log('');
        console.log('--- 执行结果 ---');
        console.log(result.response);
        console.log('--- 结束 ---');
      }
      return;
    }

    default:
      console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
