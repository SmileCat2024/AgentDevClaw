import path from 'path';
import os from 'os';
import process from 'process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import {
  getContextHandoffFilePath,
} from './handoff-package.js';

const HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_COMPILER_VERSION = 'summarized-nine-section-v1';

function sanitizeFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function cleanInlineText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function cleanMultilineText(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  const compacted = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun <= 1) {
        compacted.push('');
      }
      continue;
    }
    blankRun = 0;
    compacted.push(line);
  }
  return compacted.join('\n').trim();
}

function buildSourceRecord(sourceRecord = {}) {
  return {
    title: cleanInlineText(sourceRecord?.title),
    featureName: cleanInlineText(sourceRecord?.featureName),
    agentName: cleanInlineText(sourceRecord?.agentName),
    taskTitle: cleanInlineText(sourceRecord?.taskTitle),
    taskType: cleanInlineText(sourceRecord?.taskType),
    goal: cleanMultilineText(sourceRecord?.goal),
    constraints: cleanMultilineText(sourceRecord?.constraints),
    expectedOutput: cleanMultilineText(sourceRecord?.expectedOutput),
    targetFiles: cleanMultilineText(sourceRecord?.targetFiles),
    referenceMaterials: cleanMultilineText(sourceRecord?.referenceMaterials),
    openDirectory: cleanInlineText(sourceRecord?.openDirectory),
    createdAt: cleanInlineText(sourceRecord?.createdAt),
    updatedAt: cleanInlineText(sourceRecord?.updatedAt),
  };
}

function buildCompactOverview(sourceRecord = {}) {
  const lines = [];
  const title = cleanInlineText(sourceRecord?.taskTitle || sourceRecord?.title);
  const goal = cleanMultilineText(sourceRecord?.goal);
  const constraints = cleanMultilineText(sourceRecord?.constraints);
  const openDirectory = cleanInlineText(sourceRecord?.openDirectory);
  if (title) lines.push(`Task: ${title}`);
  if (goal) lines.push(`Goal: ${goal}`);
  if (constraints) lines.push(`Constraints: ${constraints}`);
  if (openDirectory) lines.push(`Working directory: ${openDirectory}`);
  return lines.join('\n');
}

function normalizeSummaryPolicy(rawPolicy = {}) {
  return {
    strategy: 'summarized-nine-section',
    summaryShape: 'claude-nine-section-v1',
    maxAttempts: Number.isFinite(rawPolicy?.maxAttempts)
      ? Math.max(1, Math.min(5, Number(rawPolicy.maxAttempts)))
      : 3,
    additionalInstructions: cleanMultilineText(rawPolicy?.additionalInstructions),
  };
}

function buildSummarySeedMessage(summaryText) {
  const body = cleanMultilineText(summaryText);
  return {
    role: 'system',
    content: [
      'This session is being continued from a previous conversation that ran out of context.',
      'The summary below covers the earlier portion of the conversation.',
      '',
      'Summary:',
      body,
      '',
      'Continue from this summary without asking the user to restate the full background unless necessary.',
    ].join('\n'),
    turn: 0,
  };
}

async function runMirrorCompaction(scriptPath, args, cwd, timeoutMs = 600000) {
  const resultDir = path.join(os.tmpdir(), `compact-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const resultPath = path.join(resultDir, 'result.json');
  await fs.mkdir(resultDir, { recursive: true });

  return new Promise((resolve, reject) => {
    console.log(`[summarized_handoff] spawning child resultPath=${resultPath}`);

    const child = spawn(process.execPath, [scriptPath, ...args, resultPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
      },
    });

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Mirror compaction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[compact-mirror] ${line.trimEnd()}`);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[summarized_handoff] child spawn error: ${err.message}`);
      reject(err);
    });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      console.log(`[summarized_handoff] child exited code=${code}`);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `run-compact-mirror exited with code ${code}`));
        return;
      }
      try {
        const raw = await fs.readFile(resultPath, 'utf8');
        resolve(JSON.parse(raw.trim()));
      } catch (error) {
        reject(new Error(`Failed to read mirror compaction result file: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeSummarizedHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sourceRecord = {},
  policy: rawPolicy = {},
  summaryText: rawSummaryText = '',
  rawResponse = '',
  attemptCount = null,
}) {
  const policy = normalizeSummaryPolicy(rawPolicy);
  const createdAt = new Date().toISOString();
  const handoffId = `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const summaryText = cleanMultilineText(rawSummaryText);
  if (!summaryText) {
    throw new Error('Summary text is required for summarized handoff');
  }

  const handoff = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    createdAt,
    compilerVersion: HANDOFF_COMPILER_VERSION,
    seedKind: 'summary-message',
    mode: 'summarized-nine-section',
    summaryShape: policy.summaryShape,
    sourceAgentId: sanitizeFragment(agentId),
    sourceSessionId: sanitizeFragment(sessionId),
    sourceRecord: buildSourceRecord(sourceRecord),
    policy,
    stats: {
      attemptCount: Number.isFinite(attemptCount) ? Number(attemptCount) : null,
      rawResponseChars: typeof rawResponse === 'string' ? rawResponse.length : 0,
      summaryChars: summaryText.length,
    },
    sourceSummary: summaryText,
    summaryArtifact: {
      shape: policy.summaryShape,
      rawResponse: typeof rawResponse === 'string' ? rawResponse : '',
      summaryText,
    },
    seedMessages: [buildSummarySeedMessage(summaryText)],
  };

  const handoffPath = getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  await ensureDir(path.dirname(handoffPath));
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return {
    handoff,
    handoffPath,
  };
}

export async function exportSummarizedHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sourceRecord = {},
  policy: rawPolicy = {},
  agentRelativeDir,
  projectRoot,
}) {
  const policy = normalizeSummaryPolicy(rawPolicy);
  const mirrorScriptPath = path.join(path.resolve(String(projectRoot || '').trim()), 'scripts', 'run-compact-mirror.js');
  console.log(`[summarized_handoff] mirror compaction begin agent=${agentId} session=${sessionId}`);

  const mirrorResult = await runMirrorCompaction(
    mirrorScriptPath,
    [
      agentRelativeDir,
      agentId,
      sessionId,
      JSON.stringify({
        maxAttempts: policy.maxAttempts,
        additionalInstructions: policy.additionalInstructions,
      }),
    ],
    path.resolve(String(projectRoot || '').trim()),
  );
  console.log(`[summarized_handoff] mirror compaction done agent=${agentId} session=${sessionId} attempts=${mirrorResult?.attemptCount ?? 'unknown'}`);

  const summaryText = cleanMultilineText(mirrorResult?.summaryText);
  if (!summaryText) {
    throw new Error('Mirror compaction returned an empty summary');
  }
  return writeSummarizedHandoffPackage({
    userDataRoot,
    agentId,
    sessionId,
    sourceRecord,
    policy,
    summaryText,
    rawResponse: typeof mirrorResult?.rawResponse === 'string' ? mirrorResult.rawResponse : '',
    attemptCount: mirrorResult?.attemptCount,
  });
}
