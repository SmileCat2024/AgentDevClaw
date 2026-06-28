import path from 'path';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import {
  PREBUILT_SESSIONS_ROOT,
  PREBUILT_WORKSPACES_ROOT,
  PROJECT_DOCSET_SUBPATH,
} from './constants.js';
import {
  sanitizeSessionFragment,
  cleanSessionText,
  isWorkspaceSessionAgent,
} from './string-helpers.js';
import { readJson, ensureDir } from './fs-helpers.js';

// ── Path helpers ──────────────────────────────────────────────────

export function getPrebuiltAgentSessionDir(agentId) {
  if (isWorkspaceSessionAgent(agentId)) {
    return path.join(PREBUILT_WORKSPACES_ROOT, sanitizeSessionFragment(agentId), 'sessions');
  }
  return path.join(PREBUILT_SESSIONS_ROOT, sanitizeSessionFragment(agentId));
}

export function getPrebuiltSessionFilePath(agentId, sessionId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
}

export function getPrebuiltSessionIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'index.json');
}

export function getPrebuiltWorkspaceDir(agentId) {
  return path.join(PREBUILT_WORKSPACES_ROOT, sanitizeSessionFragment(agentId));
}

export function getPrebuiltWorkspaceStatePath(agentId) {
  return path.join(getPrebuiltWorkspaceDir(agentId), 'state.json');
}

export function getPrebuiltWorkspaceArtifactsDir(agentId) {
  return path.join(getPrebuiltWorkspaceDir(agentId), 'artifacts');
}

export function getProjectDocsetDir(projectDir) {
  return path.join(path.resolve(String(projectDir || '').trim()), PROJECT_DOCSET_SUBPATH);
}

export function getProjectDocsetProjectPath(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'project.json');
}

export function getProjectDocsetFormsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'forms');
}

export function getProjectDocsetMaterialsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'materials');
}

export function getProjectDocsetConversationsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'conversations');
}

export function getWorkspaceArtifactPath(agentId, artifactId) {
  return path.join(getPrebuiltWorkspaceArtifactsDir(agentId), `${sanitizeSessionFragment(artifactId)}.json`);
}

// ── Session index read/write ──────────────────────────────────────

export async function readSessionIndex(agentId) {
  const dirPath = getPrebuiltAgentSessionDir(agentId);
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  await ensureDir(dirPath);

  try {
    const data = await readJson(indexPath);
    const sessions = Array.isArray(data.sessions)
      ? data.sessions
        .filter((session) => session && session.id && session.id !== 'legacy')
        .map((session) => ({
          ...session,
          id: String(session.id),
          title: cleanSessionText(session.title),
          featureName: cleanSessionText(session.featureName),
          agentName: cleanSessionText(session.agentName),
          taskTitle: cleanSessionText(session.taskTitle),
          taskType: cleanSessionText(session.taskType),
          goal: cleanSessionText(session.goal),
          constraints: cleanSessionText(session.constraints),
          expectedOutput: cleanSessionText(session.expectedOutput),
          targetFiles: cleanSessionText(session.targetFiles),
          referenceMaterials: cleanSessionText(session.referenceMaterials),
          openDirectory: cleanSessionText(session.openDirectory),
          sessionType: cleanSessionText(session.sessionType) || (session.metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
          archived: session.archived === true,
          todo: session.todo === true,
          metadata: normalizeSessionMetadata(session.metadata),
        }))
      : [];
    return {
      activeSessionId: sessions.some((session) => session.id === data.activeSessionId) ? data.activeSessionId : null,
      sessions,
    };
  } catch {
    return {
      activeSessionId: null,
      sessions: [],
    };
  }
}

export async function resolvePrebuiltSessionType(agentId, sessionId) {
  const normalizedSessionId = cleanSessionText(sessionId);
  if (!normalizedSessionId) return '';

  try {
    const index = await readSessionIndex(agentId);
    const record = Array.isArray(index?.sessions)
      ? index.sessions.find((session) => cleanSessionText(session?.id) === normalizedSessionId)
      : null;
    const indexedType = cleanSessionText(record?.sessionType);
    if (indexedType) {
      return indexedType;
    }
    const indexedResumeMode = cleanSessionText(record?.metadata?.resumeMode);
    if (indexedResumeMode === 'one-shot') {
      return 'sub';
    }
  } catch {}

  try {
    const sessionPath = getPrebuiltSessionFilePath(agentId, normalizedSessionId);
    const sessionRecord = await fs.readFile(sessionPath, 'utf8').then(JSON.parse).catch(() => null);
    const fileType = cleanSessionText(sessionRecord?.sessionType);
    if (fileType) {
      return fileType;
    }
    const fileResumeMode = cleanSessionText(sessionRecord?.metadata?.resumeMode);
    if (fileResumeMode === 'one-shot') {
      return 'sub';
    }
  } catch {}

  return '';
}

const _indexLocks = new Map();

export async function writeSessionIndex(agentId, index) {
  const dirPath = getPrebuiltAgentSessionDir(agentId);
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  await ensureDir(dirPath);
  const tmpPath = indexPath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  try {
    await fs.rename(tmpPath, indexPath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      await fs.unlink(indexPath).catch(() => {});
      await fs.rename(tmpPath, indexPath);
    } else if (err.code === 'EXDEV') {
      await fs.copyFile(tmpPath, indexPath);
      await fs.unlink(tmpPath).catch(() => {});
    } else {
      throw err;
    }
  }
}

export async function updateSessionIndex(agentId, fn) {
  const prev = _indexLocks.get(agentId) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _indexLocks.set(agentId, next);
  await prev;
  try {
    const index = await readSessionIndex(agentId);
    const newIndex = await fn(index);
    await writeSessionIndex(agentId, newIndex);
    return newIndex;
  } finally {
    release();
    if (_indexLocks.get(agentId) === next) _indexLocks.delete(agentId);
  }
}

export function buildSessionTitle(createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  return `对话 ${parts.join('-')} ${time.join(':')}`;
}

export function normalizeSessionMetadata(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const metadata = {
    resumeMode: cleanSessionText(raw.resumeMode),
    sourceAgentId: cleanSessionText(raw.sourceAgentId),
    sourceSessionId: cleanSessionText(raw.sourceSessionId),
    handoffId: cleanSessionText(raw.handoffId),
    handoffPath: cleanSessionText(raw.handoffPath),
    handoffCreatedAt: cleanSessionText(raw.handoffCreatedAt),
    handoffSummaryKind: cleanSessionText(raw.handoffSummaryKind),
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value),
  );
}

export function readSessionIndexSync(agentId) {
  const sessionDir = isWorkspaceSessionAgent(agentId)
    ? path.join(PREBUILT_WORKSPACES_ROOT, agentId, 'sessions')
    : path.join(PREBUILT_SESSIONS_ROOT, agentId);
  const indexPath = path.join(sessionDir, 'index.json');
  try {
    return JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return { sessions: [] };
  }
}
