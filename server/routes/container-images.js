/**
 * container-images.js — 容器镜像面（智能编码空间设置窗「容器镜像」页）
 *
 * 域边界（ADR-0025 对象模型）：本路由按「宿主 APP + 同域 hosted APP」圈定可见与
 * 可操作范围——宿主自己 + 名册中 host 声明指向宿主的 APP（如 coder 之于
 * programming-helper）。host 是同域绑定呈现属性；配置面跟随宿主工作空间设置，
 * 与设置窗「Coder 策略」页（workspace_settings/resource_policy）同构。其他工作
 * 空间的镜像、容器与构建入口一律不返回、不接受——过滤在服务端做权威，防止任
 * 何客户端经本面操作域外应用资产。名册消费复用 agent-discovery 的 discoverAgents，
 * 不自建第二份发现逻辑。
 *
 * - 连接检查：Docker 可达性/版本、执行环境生效值与来源（env/默认）、平台网关配置
 * - 镜像清单：仅本域成员；元数据读 OCI label（dev.claw.agent / image.revision），
 *   与宿主代码 git 状态做一致性核对（三态：ok/stale/unknown，只提示不阻断）
 * - 运行中容器：label claw-runtime=1，仅本域 agent；按镜像 ImageID 关联占用；使用中禁删
 * - 删除/构建：目标必须属于本域（越域 403）；构建仅开发树可用，单任务槽 + 尾部轮询
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { cleanSessionText } from '../shared/string-helpers.js';
import { AGENTS_ROOT, HIDDEN_PREBUILT_AGENT_IDS } from '../shared/constants.js';
import { discoverAgents } from './agent-discovery.js';
import { resolveWorkspaceAgent, workspaceAgentDisplayName } from '../shared/workspace-agents.js';

const RUNTIME_REPO = 'agentdev-claw-runtime';
const BUILD_SCRIPT = join('scripts', 'pack-container.mjs');
const DEFAULT_HOST = 'programming-helper';
const HOST_INFO_TTL_MS = 5_000;
const BUILD_TAIL_CHARS = 16_000;

const execFileAsync = promisify(execFile);

function defaultDockerFactory() {
  return () => new Docker(process.env.CLAW_DOCKER_SOCKET
    ? { socketPath: process.env.CLAW_DOCKER_SOCKET }
    : undefined);
}

async function readDockerStatus(dockerFactory) {
  try {
    const docker = dockerFactory();
    const version = await docker.version();
    return { reachable: true, version: version?.Version || null, apiVersion: version?.ApiVersion || null };
  } catch (error) {
    return { reachable: false, error: String(error?.message || error) };
  }
}

/** 宿主运行代码事实（开发树：git 短 hash + dirty；桌面树：无 git）。5s 缓存防轮询刷 git。 */
function createHostInfoReader(execGit, repoRoot) {
  let cache = null;
  let cacheAt = 0;
  return async () => {
    if (cache && Date.now() - cacheAt < HOST_INFO_TTL_MS) return cache;
    let pkgVersion = null;
    try {
      pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version || null;
    } catch { /* 无 package.json 的环境按 unknown 处理 */ }
    try {
      const { stdout: hashOut } = await execGit(['rev-parse', '--short=8', 'HEAD'], repoRoot);
      const { stdout: statusOut } = await execGit(['status', '--porcelain'], repoRoot);
      cache = {
        version: pkgVersion,
        commit: hashOut.trim(),
        dirty: statusOut.trim().length > 0,
        devTree: true,
      };
    } catch {
      cache = { version: pkgVersion, commit: null, dirty: false, devTree: false };
    }
    cacheAt = Date.now();
    return cache;
  };
}

/**
 * 本域成员：宿主 APP 自己 + 名册中 host 声明指向宿主的同域 APP（ADR-0025）。
 * 隐藏清单内的 APP（已下线）不进面板；成员顺序：宿主第一，hosted 按名册序。
 *
 * 展示名口径：宿主用其**工作空间内 Agent 名**（编程小助手），不是工作空间名
 * （智能编码空间）——与欢迎页「显示当前会话 Agent 名」同一口径；同域子应用
 * 用 id（coder）呈现，侧栏已用工作空间名表达其身份，这里不重复造第二套名字。
 */
async function readDomainAgents(agentsRoot, hostId) {
  const roster = await discoverAgents(agentsRoot);
  const visible = roster.filter((meta) => !HIDDEN_PREBUILT_AGENT_IDS.has(String(meta.id)));
  const self = visible.find((meta) => meta.id === hostId);
  let selfName = hostId;
  if (self) {
    try {
      const defaultAgent = resolveWorkspaceAgent(self, self.defaultAgentId);
      selfName = workspaceAgentDisplayName(defaultAgent) || selfName;
    } catch { /* 名册声明异常时回落到 id，不阻断观测页 */ }
  }
  const domain = [{ id: hostId, name: selfName, hosted: false }];
  for (const meta of visible) {
    if (meta.id !== hostId && meta.host === hostId) {
      domain.push({ id: meta.id, name: meta.id, hosted: true });
    }
  }
  return domain;
}

/**
 * 镜像 → 本域 agentId：label 优先，无 label 的历史镜像按本域 id 做 tag 前缀匹配
 * （agentId 自身可含连字符，如 programming-helper，故前缀匹配而非裸 split）。
 * 域外或无法归属返回 null。
 */
function resolveImageAgentId(labels, tags, domainIds) {
  const labeled = cleanSessionText(labels?.['dev.claw.agent']);
  if (labeled) return domainIds.has(labeled) ? labeled : null;
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = String(tag).split(':', 2)[1] || '';
    for (const id of domainIds) {
      if (value === id || value.startsWith(`${id}-`)) return id;
    }
  }
  return null;
}

/**
 * 一致性三态判定。revision 形如 `<version>-<git短hash>[-dirty]`（pack:container
 * OCI label）；`-released` 后缀（桌面发布树构建）无 hash，归 unknown。
 */
function assessConsistency(revision, host) {
  const match = /^([^-]+)-([0-9a-f]{7,12})(-dirty)?$/.exec(revision || '');
  if (!match) return { state: 'unknown', reason: 'no_revision' };
  const [, imageVersion, imageCommit] = match;
  if (!host.devTree || !host.commit) return { state: 'unknown', reason: 'host_not_dev_tree', imageCommit, imageVersion };
  if (host.dirty) return { state: 'unknown', reason: 'host_dirty', imageCommit, imageVersion };
  if (revision.endsWith('-dirty')) return { state: 'unknown', reason: 'image_dirty', imageCommit, imageVersion };
  const ok = imageCommit === host.commit && imageVersion === host.version;
  return { state: ok ? 'ok' : 'stale', imageCommit, imageVersion };
}

function shortImageId(id) {
  return String(id || '').replace(/^sha256:/, '').slice(0, 12);
}

function containerSessionId(name, agentId) {
  const prefix = `claw-rt-${agentId}-`;
  const value = String(name || '').replace(/^\//, '');
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function createBuildJobSlot(repoRoot) {
  let job = null;
  return {
    get: () => job ? { ...job, tail: job.tail.slice(-4000) } : null,
    start(agentId) {
      if (job) return { ok: false, reason: 'busy' };
      const tailChunks = [];
      let tail = '';
      // shell:true 覆盖 Windows npm.cmd 与 Unix shell 两种形态
      const child = execFile('npm', ['run', 'pack:container', '--', `--agent=${agentId}`], {
        cwd: repoRoot,
        shell: true,
        maxBuffer: 8 * 1024 * 1024,
      }, () => {});
      job = {
        agentId,
        startedAt: Date.now(),
        running: true,
        exitCode: null,
        get tail() { return tail; },
      };
      const append = (buf) => {
        tailChunks.push(String(buf));
        let merged = tailChunks.join('');
        if (merged.length > BUILD_TAIL_CHARS) {
          merged = merged.slice(-BUILD_TAIL_CHARS);
          tailChunks.length = 0;
          tailChunks.push(merged);
        }
        tail = merged;
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (error) => {
        append(`\n[spawn 失败] ${error?.message || error}\n`);
        job.running = false;
        job.exitCode = 1;
      });
      child.on('close', (code) => {
        job.running = false;
        job.exitCode = typeof code === 'number' ? code : 1;
      });
      return { ok: true };
    },
  };
}

export function setupContainerImagesRoutes(app, express, options = {}) {
  void express;
  const repoRoot = options.repoRoot || process.cwd();
  const agentsRoot = options.agentsRoot || AGENTS_ROOT;
  const dockerFactory = options.dockerFactory || defaultDockerFactory();
  // 注意：`|| async (...) =>` 在该位置会按 async(...) 调用解析，箭头须加括号成组
  const execGit = options.execGit
    || (async (args, cwd) => execFileAsync('git', args, { cwd }));
  const readHostInfo = createHostInfoReader(execGit, repoRoot);
  const buildSlot = createBuildJobSlot(repoRoot);
  const json = express.json({ limit: '64kb' });

  app.get('/protoclaw/container_images/overview', async (req, res) => {
    try {
      const hostId = DEFAULT_HOST;
      const domain = await readDomainAgents(agentsRoot, hostId);
      const domainIds = new Set(domain.map((d) => d.id));
      const [docker, host] = await Promise.all([readDockerStatus(dockerFactory), readHostInfo()]);
      const executor = {
        configured: cleanSessionText(process.env.CLAW_RUNTIME_EXECUTOR) || 'local',
        source: process.env.CLAW_RUNTIME_EXECUTOR ? 'env' : 'default',
        agentFilter: cleanSessionText(process.env.CLAW_RUNTIME_EXECUTOR_AGENTS) || null,
        imageOverride: cleanSessionText(process.env.CLAW_RUNTIME_CONTAINER_IMAGE) || null,
      };
      const gateway = {
        viewerAddr: cleanSessionText(process.env.AGENTDEV_VIEWER_ADDR) || null,
        httpBind: cleanSessionText(process.env.AGENTDEV_VIEWER_HTTP_BIND) || null,
      };
      const buildAvailable = existsSync(join(repoRoot, BUILD_SCRIPT));

      const byAgent = new Map();
      const containers = [];
      if (docker.reachable) {
        const dockerClient = dockerFactory();
        const all = await dockerClient.listImages();
        for (const image of all) {
          const tags = (image.RepoTags || []).filter((t) => String(t).startsWith(`${RUNTIME_REPO}:`));
          if (!tags.length && !image.Labels?.['dev.claw.agent']) continue;
          const agentId = resolveImageAgentId(image.Labels, tags, domainIds);
          if (!agentId) continue; // 域外或无法归属的镜像不进本面板
          const entry = {
            id: shortImageId(image.Id),
            tags,
            agentId,
            revision: image.Labels?.['org.opencontainers.image.revision'] || null,
            version: image.Labels?.['org.opencontainers.image.version'] || null,
            createdMs: (image.Created || 0) * 1000,
            sizeBytes: image.Size || 0,
            primary: tags.includes(`${RUNTIME_REPO}:${agentId}`),
          };
          entry.consistency = assessConsistency(entry.revision, host);
          if (!byAgent.has(agentId)) byAgent.set(agentId, []);
          byAgent.get(agentId).push(entry);
        }
        for (const list of byAgent.values()) {
          list.sort((a, b) => b.createdMs - a.createdMs);
        }

        const rawContainers = await dockerClient.listContainers({
          filters: JSON.stringify({ label: ['claw-runtime=1'] }),
        });
        for (const c of rawContainers) {
          const agentId = cleanSessionText(c.Labels?.['claw-runtime-agent']);
          if (!agentId || !domainIds.has(agentId)) continue;
          const name = String(c.Names?.[0] || '').replace(/^\//, '');
          containers.push({
            id: shortImageId(c.Id),
            name,
            agentId,
            sessionId: containerSessionId(name, agentId),
            imageId: shortImageId(c.ImageID),
            state: c.State || null,
            createdMs: (c.Created || 0) * 1000,
          });
        }
      }

      res.json({
        docker,
        executor,
        gateway,
        host,
        domainHost: hostId,
        buildAvailable,
        buildJob: buildSlot.get(),
        agents: domain.map((d) => ({ ...d, images: byAgent.get(d.id) || [] })),
        containers,
      });
    } catch (error) {
      res.status(500).json({ error: `container_images overview 失败: ${error?.message || error}` });
    }
  });

  app.post('/protoclaw/container_images/delete', json, async (req, res) => {
    const imageRef = typeof req.body?.imageRef === 'string' ? req.body.imageRef.trim() : '';
    if (!imageRef) {
      res.status(400).json({ error: 'imageRef required（镜像 Id 或 repo:tag）' });
      return;
    }
    try {
      const hostId = DEFAULT_HOST;
      const domain = await readDomainAgents(agentsRoot, hostId);
      const domainIds = new Set(domain.map((d) => d.id));
      const docker = dockerFactory();
      const image = docker.getImage(imageRef);
      const inspect = await image.inspect();
      // 域校验：目标镜像必须归属本域（label 优先，历史镜像按 tag 前缀）
      const agentId = resolveImageAgentId(inspect?.Config?.Labels, inspect?.RepoTags, domainIds);
      if (!agentId) {
        res.status(403).json({ error: 'image_not_in_domain', message: '该镜像不属于当前工作空间的容器镜像管理范围' });
        return;
      }
      // 使用中保护：有运行中容器占用该镜像时拒绝（docker rmi 同样会拒绝，这里
      // 预检是为了把占用者名字带回前端，而不是裸 409）
      const running = await docker.listContainers({
        filters: JSON.stringify({ label: ['claw-runtime=1'] }),
      });
      const shortId = shortImageId(inspect?.Id);
      const inUse = running.filter((c) => shortImageId(c.ImageID) === shortId)
        .map((c) => String(c.Names?.[0] || '').replace(/^\//, ''));
      if (inUse.length) {
        res.status(409).json({ error: 'image_in_use', containers: inUse });
        return;
      }
      await image.remove({});
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: `删除镜像失败: ${error?.message || error}` });
    }
  });

  app.post('/protoclaw/container_images/build', json, async (req, res) => {
    const hostId = DEFAULT_HOST;
    const agentId = cleanSessionText(req.body?.agentId);
    // agentId 拼入构建命令（shell 执行），只放行 id 安全字符集
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
      res.status(400).json({ error: 'agentId required（仅字母/数字/-/_）' });
      return;
    }
    try {
      const domain = await readDomainAgents(agentsRoot, hostId);
      if (!domain.some((d) => d.id === agentId)) {
        res.status(403).json({ error: 'agent_not_in_domain', message: '该应用不属于当前工作空间的容器镜像管理范围' });
        return;
      }
      if (!existsSync(join(repoRoot, BUILD_SCRIPT))) {
        res.status(403).json({ error: '当前运行树不可构建镜像（缺少 scripts/pack-container.mjs，桌面安装态请在源码树构建）' });
        return;
      }
      const started = buildSlot.start(agentId);
      if (!started.ok) {
        res.status(409).json({ error: '已有构建任务进行中' });
        return;
      }
      res.json({ ok: true, job: buildSlot.get() });
    } catch (error) {
      res.status(500).json({ error: `构建启动失败: ${error?.message || error}` });
    }
  });
}
