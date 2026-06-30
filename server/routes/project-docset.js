import path from 'path';
import { promises as fs } from 'fs';

import { sanitizeSessionFragment, cleanSessionText } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import {
  getProjectDocsetDir,
  getProjectDocsetProjectPath,
  getProjectDocsetFormsDir,
  getProjectDocsetMaterialsDir,
  getProjectDocsetConversationsDir,
} from '../shared/session-access.js';

export function sanitizeProjectDocsetId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'doc';
}

export function buildProjectDocsetMarkdownId(title, createdAt, fallbackPrefix = 'plan') {
  const normalizedTitle = sanitizeProjectDocsetId(title || fallbackPrefix);
  const timestamp = String(createdAt || new Date().toISOString())
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `${fallbackPrefix}-${normalizedTitle}-${timestamp || Date.now()}`;
}

export function cleanProjectDocsetPayload(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => value !== undefined && value !== null && !(typeof value === 'string' && value === '')),
  );
}

export function normalizeProjectConversationRecord(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const timestamp = new Date().toISOString();
  return {
    sessionId: sanitizeProjectDocsetId(source.sessionId || 'session'),
    title: cleanSessionText(source.title) || 'conversation-record',
    summary: cleanSessionText(source.summary),
    currentFocus: cleanSessionText(source.currentFocus),
    keyDecisions: Array.isArray(source.keyDecisions) ? source.keyDecisions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    nextActions: Array.isArray(source.nextActions) ? source.nextActions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    openQuestions: Array.isArray(source.openQuestions) ? source.openQuestions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    relatedMaterialIds: Array.isArray(source.relatedMaterialIds) ? source.relatedMaterialIds.map((value) => sanitizeProjectDocsetId(value)).filter(Boolean) : [],
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : timestamp,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : timestamp,
  };
}

export function extractMaterialSourcePath(content = '') {
  const match = String(content || '').match(/^- Source Path:\s*(.+)$/m);
  return match ? cleanSessionText(match[1]) : '';
}

export async function ensureProjectDocset(projectDir, options = {}) {
  const resolvedProjectDir = path.resolve(String(projectDir || '').trim());
  const docsetDir = getProjectDocsetDir(resolvedProjectDir);
  const formsDir = getProjectDocsetFormsDir(resolvedProjectDir);
  const materialsDir = getProjectDocsetMaterialsDir(resolvedProjectDir);
  const conversationsDir = getProjectDocsetConversationsDir(resolvedProjectDir);
  const timestamp = typeof options.timestamp === 'string' && options.timestamp ? options.timestamp : new Date().toISOString();

  await Promise.all([
    ensureDir(docsetDir),
    ensureDir(formsDir),
    ensureDir(materialsDir),
    ensureDir(conversationsDir),
  ]);

  const legacyPlansDir = path.join(docsetDir, 'plans');
  try {
    const entries = await fs.readdir(legacyPlansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fromPath = path.join(legacyPlansDir, entry.name);
      const toPath = path.join(materialsDir, entry.name);
      await fs.rename(fromPath, toPath).catch(async () => {
        const content = await fs.readFile(fromPath);
        await fs.writeFile(toPath, content);
        await fs.rm(fromPath, { force: true }).catch(() => {});
      });
    }
    await fs.rmdir(legacyPlansDir).catch(() => {});
  } catch {
    // Ignore missing legacy plans dir.
  }

  await fs.rm(path.join(docsetDir, 'tasks'), { recursive: true, force: true }).catch(() => {});

  const legacySessionsDir = path.join(docsetDir, 'sessions');
  try {
    const legacyEntries = await fs.readdir(legacySessionsDir, { withFileTypes: true });
    for (const entry of legacyEntries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const legacyPath = path.join(legacySessionsDir, entry.name);
      const nextPath = path.join(conversationsDir, entry.name);
      const raw = await readJson(legacyPath).catch(() => null);
      if (raw) {
        const normalized = normalizeProjectConversationRecord(raw);
        await fs.writeFile(nextPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      }
      await fs.rm(legacyPath, { force: true }).catch(() => {});
    }
    await fs.rmdir(legacySessionsDir).catch(() => {});
  } catch {
    // Ignore missing legacy sessions dir.
  }

  const nextProjectRecord = {
    schemaVersion: 1,
    workspaceId: cleanSessionText(options.workspaceId),
    projectType: cleanSessionText(options.projectType),
    projectName: cleanSessionText(options.projectName),
    openDirectory: resolvedProjectDir,
    targetDir: cleanSessionText(options.targetDir) || path.dirname(resolvedProjectDir),
    goal: cleanSessionText(options.goal),
    constraints: cleanSessionText(options.constraints),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const projectPath = getProjectDocsetProjectPath(resolvedProjectDir);
  try {
    const existing = await readJson(projectPath);
    nextProjectRecord.createdAt = typeof existing?.createdAt === 'string' && existing.createdAt ? existing.createdAt : timestamp;
  } catch {
    // Ignore if project record does not exist yet.
  }

  await fs.writeFile(projectPath, `${JSON.stringify(nextProjectRecord, null, 2)}\n`, 'utf8');

  if (options.requirementForm && typeof options.requirementForm === 'object') {
    const requirementDoc = {
      schemaVersion: 1,
      formId: cleanSessionText(options.formId) || 'startup-form',
      workspaceId: cleanSessionText(options.workspaceId),
      openDirectory: resolvedProjectDir,
      payload: cleanProjectDocsetPayload(options.requirementForm),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const requirementPath = path.join(formsDir, `${requirementDoc.formId}.json`);
    try {
      const existing = await readJson(requirementPath);
      requirementDoc.createdAt = typeof existing?.createdAt === 'string' && existing.createdAt ? existing.createdAt : timestamp;
    } catch {
      // Ignore if form file does not exist yet.
    }
    await fs.writeFile(requirementPath, `${JSON.stringify(requirementDoc, null, 2)}\n`, 'utf8');
  }

  return {
    docsetDir,
    projectPath,
    formsDir,
    materialsDir,
    conversationsDir,
  };
}

export async function syncWorkspaceProjectDocset(agentId, state, timestamp) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (normalizedAgentId !== 'feature-creator' && normalizedAgentId !== 'agent-creator' && normalizedAgentId !== 'programming-helper') {
    return null;
  }

  const openDirectory = cleanSessionText(state?.openDirectory);
  if (!openDirectory) {
    return null;
  }

  const startupForm = state?.forms?.['startup-form'] || {};
  const isFeatureCreator = normalizedAgentId === 'feature-creator';
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  return ensureProjectDocset(openDirectory, {
    timestamp,
    workspaceId: normalizedAgentId,
    projectType: isProgrammingHelper ? 'programming-task' : (isFeatureCreator ? 'feature' : 'agent'),
    projectName: isProgrammingHelper ? startupForm.task_title : (isFeatureCreator ? startupForm.feature_name : startupForm.agent_name),
    targetDir: isProgrammingHelper ? path.dirname(openDirectory) : startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    formId: 'startup-form',
    requirementForm: startupForm,
  });
}

export async function summarizeProjectDocset(projectDir, options = {}) {
  const resolvedProjectDir = cleanSessionText(projectDir);
  if (!resolvedProjectDir) {
    return {
      type: 'project-docset',
      exists: false,
      projectDir: '',
      docsetDir: '',
      requirementForm: null,
      materials: [],
      materialCount: 0,
    };
  }

  const docsetDir = getProjectDocsetDir(resolvedProjectDir);
  const materialLimit = Number.isFinite(Number(options.materialLimit)) ? Math.max(1, Number(options.materialLimit)) : 6;
  const conversationLimit = Number.isFinite(Number(options.conversationLimit)) ? Math.max(1, Number(options.conversationLimit)) : 5;
  const currentSessionId = cleanSessionText(options.currentSessionId);

  try {
    const [projectRecord, requirementForm, materialEntries, conversationEntries] = await Promise.all([
      readJson(getProjectDocsetProjectPath(resolvedProjectDir)).catch(() => null),
      readJson(path.join(getProjectDocsetFormsDir(resolvedProjectDir), 'startup-form.json')).catch(() => null),
      fs.readdir(getProjectDocsetMaterialsDir(resolvedProjectDir), { withFileTypes: true }).catch(() => []),
      fs.readdir(getProjectDocsetConversationsDir(resolvedProjectDir), { withFileTypes: true }).catch(() => []),
    ]);

    const materials = (await Promise.all(materialEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const filePath = path.join(getProjectDocsetMaterialsDir(resolvedProjectDir), entry.name);
        const stat = await fs.stat(filePath);
        const body = await fs.readFile(filePath, 'utf8');
        const lines = body.split(/\r?\n/).map((line) => line.trim());
        const heading = lines.find((line) => line.startsWith('# ')) || '';
        const title = heading ? heading.replace(/^#\s+/, '').trim() : entry.name.replace(/\.md$/i, '');
        const preview = lines.filter(Boolean).slice(1, 4).join(' ').slice(0, 180);
        return {
          id: sanitizeProjectDocsetId(entry.name.replace(/\.md$/i, '')),
          title,
          preview,
          content: body,
          sourcePath: extractMaterialSourcePath(body),
          path: filePath,
          updatedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
        };
      })))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const conversationRecords = (await Promise.all(conversationEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(getProjectDocsetConversationsDir(resolvedProjectDir), entry.name);
        const raw = await readJson(filePath);
        return normalizeProjectConversationRecord(raw);
      })))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const currentConversationRecord = currentSessionId
      ? conversationRecords.find((item) => item.sessionId === sanitizeProjectDocsetId(currentSessionId)) || null
      : null;

    return {
      type: 'project-docset',
      exists: true,
      projectDir: resolvedProjectDir,
      docsetDir,
      project: projectRecord,
      requirementForm,
      currentSessionId: currentSessionId || '',
      currentConversationRecord,
      conversationRecords: conversationRecords.slice(0, conversationLimit),
      materialCount: materials.length,
      materials: materials.slice(0, materialLimit),
    };
  } catch {
    return {
      type: 'project-docset',
      exists: false,
      projectDir: resolvedProjectDir,
      docsetDir,
      requirementForm: null,
      currentSessionId: currentSessionId || '',
      currentConversationRecord: null,
      conversationRecords: [],
      materials: [],
      materialCount: 0,
    };
  }
}

export function setupProjectDocsetRoutes(app, express) {
  app.post('/protoclaw/project_docset/import_materials', express.json({ limit: '20mb' }), async (req, res, next) => {
    try {
      const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
      const projectDir = typeof req.body?.projectDir === 'string' ? req.body.projectDir.trim() : '';
      const materials = Array.isArray(req.body?.materials) ? req.body.materials : [];

      if (!agentId) {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      if (!projectDir) {
        res.status(400).json({ error: 'projectDir is required' });
        return;
      }
      if (materials.length === 0) {
        res.status(400).json({ error: 'materials are required' });
        return;
      }

      await ensureProjectDocset(projectDir, {});
      const materialsDir = getProjectDocsetMaterialsDir(projectDir);
      const imported = [];

      for (const material of materials) {
        const sourcePath = typeof material?.sourcePath === 'string' ? material.sourcePath.trim() : '';
        const sourceKind = material?.sourceKind === 'directory' ? 'directory' : 'file';
        const name = typeof material?.name === 'string' && material.name.trim()
          ? material.name.trim()
          : (sourcePath ? path.basename(sourcePath) : '');
        if (!name || !sourcePath) continue;

        const timestamp = new Date().toISOString();
        const title = `导入资料 · ${name}`;
        const id = buildProjectDocsetMarkdownId(title, timestamp, 'material');
        const body = [
          `# ${title}`,
          '',
          `- Source Kind: ${sourceKind}`,
          `- Source Path: ${sourcePath}`,
          `- Imported At: ${timestamp}`,
          '',
          '> 这是路径引用资料，项目文档集只保存来源路径，不复制原始内容。',
        ].join('\n');
        const filePath = path.join(materialsDir, `${id}.md`);
        await fs.writeFile(filePath, body, 'utf8');
        imported.push({ id, title, path: filePath });
      }

      res.json({ ok: true, count: imported.length, items: imported });
    } catch (error) {
      next(error);
    }
  });
}
