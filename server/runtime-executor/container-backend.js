/**
 * container-backend.js — 容器执行后端（ADR-0037 M6）
 *
 * 经 docker 守护进程 API（dockerode，纯 JS）运行托管 runtime 容器：镜像由
 * `npm run pack:container` 预构建（运行时不构建、缺失直接报错不回退）。
 *
 * handle 契约与 local-backend 对齐：EventEmitter 暴露 exitCode / signalCode /
 * kill() / __runtimeOutputTail 与语义事件 output / identity / session-exited，
 * 宿主消费面（agent-startup）零改动复用——READY / Viewer Agent ID 探测在
 * output 事件上单处实现，docker 日志流供给同一事件。
 *
 * 身份交接：启动前签发一次性 ticket（runtime-spawn-tickets），经 env 注入
 * 容器；容器 runtime 携 ticket 注册（PROTOCLAW_RUNTIME_REGISTER=1），注册
 * 路由回调 onRegister → 本后端在 handle 上发出 'identity' 事件（等价本地
 * IPC 的 runtime-identity，accept 为 no-op——HTTP 响应即回执）。
 *
 * 无父子 IPC 通道：session-exited 由容器 runtime 经 /protoclaw/runtime/exited
 * 上报、注册路由转发 emitHostEvent 到本 handle；宿主→runtime 的 add-session
 * 共享进程语义不成立（executor 选择层已回退 local）。
 */
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { existsSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import Docker from 'dockerode';
import { USER_DATA_ROOT, WORKSPACE_SESSION_AGENT_IDS } from '../shared/constants.js';
import { cleanSessionText, sanitizeSessionFragment, log } from '../shared/string-helpers.js';
import { issueManagedSpawnTicket } from '../shared/runtime-spawn-tickets.js';

const OUTPUT_TAIL_CHARS = 8000;
const DOCKER_STOP_GRACE_SEC = 10;
const CONTAINER_DATA_ROOT = '/data';
const CONTAINER_WORKSPACE = '/workspace';
const HOST_GATEWAY = 'host.docker.internal';

class ContainerRuntimeHandle extends EventEmitter {
  constructor(container, name) {
    super();
    this.container = container;
    this.containerName = name;
    this.pid = name; // 诊断用途（容器无宿主 pid 语义，用容器名定位）
    this.exitCode = null;
    this.signalCode = null;
    this.__runtimeOutputTail = '';
    this.__isContainerRuntime = true;
  }

  getOutputTail() {
    return this.__runtimeOutputTail;
  }

  /** 注册路由转发语义事件（session-exited）；仅容器 handle 实现。 */
  emitHostEvent(type, payload) {
    this.emit(type, payload);
  }

  appendTail(text) {
    this.__runtimeOutputTail = `${this.__runtimeOutputTail}${text}`.slice(-OUTPUT_TAIL_CHARS);
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null) return;
    // docker stop = PID 1 SIGTERM → 宽限后 SIGKILL，与本地进程树收割同语义；
    // runtime 的 SIGTERM handler（disposeAllSessions）负责持久化后退出。
    const op = signal === 'SIGKILL'
      ? this.container.kill({ signal: 'SIGKILL' })
      : this.container.stop({ t: DOCKER_STOP_GRACE_SEC });
    op.catch((error) => {
      // 容器可能已退出（304/409）：由 wait() 收敛，不视为 kill 失败
      log('runtime-executor', `container kill 容错 (${this.containerName}): ${error?.message || error}`, 'warn');
    });
  }
}

function toBind(hostPath, containerPath, mode = 'rw') {
  const normalized = String(hostPath).replaceAll('\\', '/');
  return `${normalized}:${containerPath}${mode === 'ro' ? ':ro' : ''}`;
}

/**
 * 平台地址上下文：容器经 host.docker.internal 寻址平台。要求平台进程自身
 * 开启 TCP 监听（AGENTDEV_VIEWER_ADDR）与非回环 HTTP 绑定
 * （AGENTDEV_VIEWER_HTTP_BIND，M5-A）——缺失即报错并给出配置指引，不静默
 * 回退 local。
 */
function resolvePlatformGatewayContext(specEnv) {
  const tcpListen = cleanSessionText(process.env.AGENTDEV_VIEWER_ADDR);
  if (!tcpListen) {
    throw new Error(
      '容器执行后端需要平台开启 ViewerWorker TCP 监听：在 .env（CLAW_ENV_FILE）设置 '
      + 'AGENTDEV_VIEWER_ADDR=0.0.0.0:<port> 并重启服务（容器 runtime 经该端口接入）',
    );
  }
  const tcpPort = tcpListen.split(':').pop();
  const httpBind = cleanSessionText(process.env.AGENTDEV_VIEWER_HTTP_BIND);
  if (!httpBind || httpBind === '127.0.0.1' || httpBind === 'localhost') {
    throw new Error(
      '容器执行后端需要平台 HTTP 面非回环绑定：在 .env 设置 '
      + 'AGENTDEV_VIEWER_HTTP_BIND=0.0.0.0 并重启服务（容器 runtime 经该面 dequeue 输入）',
    );
  }
  const viewerHttpPort = cleanSessionText(specEnv.AGENTDEV_VIEWER_PORT) || '2026';
  let appPort = '1420';
  try {
    const origin = new URL(cleanSessionText(specEnv.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420');
    if (origin.port) appPort = origin.port;
  } catch { /* 保底默认端口 */ }
  return {
    viewerAddr: `${HOST_GATEWAY}:${tcpPort}`,
    viewerOrigin: `http://${HOST_GATEWAY}:${viewerHttpPort}`,
    serverOrigin: `http://${HOST_GATEWAY}:${appPort}`,
  };
}

/**
 * 用户数据挂载与 env 重写：容器内 AGENTDEV_DATA_DIR=/data，runtime 侧全部
 * 数据路径（会话存储、模型配置、agent 配置、OAuth token）同源派生自它
 * （ADR-0036 分区不变）。文件级挂载仅挂存在的文件——Docker 对缺失宿主文件
 * 的 bind mount 会创建目录，造成 default.json 变目录的破坏性副作用。
 */
export function buildDataMounts(agentId, specEnv, dataRoot = USER_DATA_ROOT) {
  const binds = [];
  const workspaceBound = WORKSPACE_SESSION_AGENT_IDS.has(agentId);
  const sessionsHostDir = workspaceBound
    ? join(dataRoot, 'workspaces', agentId, 'sessions')
    : join(dataRoot, 'prebuilt-sessions', agentId);
  mkdirSync(sessionsHostDir, { recursive: true });
  binds.push(toBind(sessionsHostDir, workspaceBound
    ? `${CONTAINER_DATA_ROOT}/workspaces/${agentId}/sessions`
    : `${CONTAINER_DATA_ROOT}/prebuilt-sessions/${agentId}`));

  // Runtime needs model configuration and per-agent settings for reads, but those
  // files are owned by the host settings UI. Keep them read-only in the container;
  // OAuth refresh is the exception: it rotates token files from the runtime.
  for (const file of ['default.json', 'presets.json', 'model-connections.json']) {
    const host = join(dataRoot, file);
    if (existsSync(host)) binds.push(toBind(host, `${CONTAINER_DATA_ROOT}/${file}`, 'ro'));
  }
  const agentConfig = join(dataRoot, 'agent-configs', `${agentId}.json`);
  if (existsSync(agentConfig)) {
    binds.push(toBind(agentConfig, `${CONTAINER_DATA_ROOT}/agent-configs/${agentId}.json`, 'ro'));
  }
  const imageDir = join(dataRoot, 'images');
  if (existsSync(imageDir)) binds.push(toBind(imageDir, `${CONTAINER_DATA_ROOT}/images`));
  const oauthDir = join(dataRoot, 'oauth-tokens');
  if (existsSync(oauthDir)) binds.push(toBind(oauthDir, `${CONTAINER_DATA_ROOT}/oauth-tokens`));

  // handoff 注入文件：runtime 首启导入后自删（作用于挂载文件），按 ADR 契约
  // 只读挂载防误写；env 重写到容器路径。
  const envOverrides = {};
  const handoffHost = cleanSessionText(specEnv.PROTOCLAW_HANDOFF_PATH);
  if (handoffHost && existsSync(handoffHost)) {
    const file = basename(handoffHost);
    binds.push(toBind(handoffHost, `${CONTAINER_DATA_ROOT}/context-handoffs/${file}`, 'ro'));
    envOverrides.PROTOCLAW_HANDOFF_PATH = `${CONTAINER_DATA_ROOT}/context-handoffs/${file}`;
  }
  // 会话工作目录挂载源 = PROTOCLAW_SESSION_WORKSPACE_CWD（宿主路径，
  // buildSessionWorkspaceEnv 注入的会话语义目录）。不能用 seam 的 cwd 参数：
  // workspace-bound agent（coder 等）经 seam 传来的 cwd 是仓库根（本地 spawn
  // 的进程起始目录），挂它等于把仓库根挂进 /workspace，工具写盘全落错位
  // （E2E S3a 实测：容器内写入成功、宿主 ws 目录空）。
  const globalLayer = join(dataRoot, 'feature-setup.json');
  if (existsSync(globalLayer)) {
    binds.push(toBind(globalLayer, `${CONTAINER_DATA_ROOT}/feature-setup.json`, 'ro'));
  }
  const coderAgentConfig = join(dataRoot, 'workspaces', agentId, 'feature-config', 'agent.json');
  if (existsSync(coderAgentConfig)) {
    binds.push(toBind(coderAgentConfig, `${CONTAINER_DATA_ROOT}/workspaces/${agentId}/feature-config/agent.json`, 'ro'));
  }
  const workspaceHost = cleanSessionText(specEnv.PROTOCLAW_SESSION_WORKSPACE_CWD);
  if (workspaceHost) {
    mkdirSync(workspaceHost, { recursive: true });
    binds.push(toBind(workspaceHost, CONTAINER_WORKSPACE));
  }
  return { binds, envOverrides };
}

/**
 * 容器执行后端入口（seam 契约：同步返回 handle，docker 失败经 error 事件
 * 送达——与 spawn 的 ENOENT 语义对齐，宿主 startManagedSession 的 error
 * 接线零改动）。
 */
export function startContainerRuntime({ argv, env, cwd, ipc }) {
  void ipc; // 容器无父子 IPC；共享进程模式已在 executor 选择层回退 local
  const agentId = sanitizeSessionFragment(env.PROTOCLAW_PREBUILT_AGENT_ID);
  const sessionId = sanitizeSessionFragment(env.PROTOCLAW_PREBUILT_SESSION_ID);
  const image = cleanSessionText(process.env.CLAW_RUNTIME_CONTAINER_IMAGE)
    || 'agentdev-claw-runtime:latest';
  const docker = new Docker(process.env.CLAW_DOCKER_SOCKET
    ? { socketPath: process.env.CLAW_DOCKER_SOCKET }
    : undefined);
  const name = `claw-rt-${agentId}-${sessionId || 'nosession'}`;

  const handle = new ContainerRuntimeHandle(null, name);
  handle.__containerImage = image;

  // ticket 先于容器创建签发（要进容器 env）；handle 失败后的迟到注册在
  // onRegister 里被拒（exitCode 已非 null），ticket 本身一次性消费。
  const ticket = issueManagedSpawnTicket({
    agentId,
    sessionId,
    onRegister: (viewerAgentId) => {
      if (handle.exitCode !== null) {
        throw new Error('container runtime exited before registration');
      }
      handle.emit('identity', {
        agentId,
        sessionId: sessionId || null,
        viewerAgentId,
        accept: () => {}, // HTTP 响应即回执（路由在 onRegister 返回后应答）
      });
    },
  });

  (async () => {
    // 同名残留容器（上次崩溃未收敛）：强制移除后重建
    await docker.getContainer(name).remove({ force: true }).catch(() => {});
    const { binds, envOverrides } = buildDataMounts(agentId, env);
    const gateway = resolvePlatformGatewayContext(env);
    // 白名单传递：宿主 spawn env 里的 Windows 系统变量（PATH / HOME /
    // SystemRoot 等）对容器无效且会覆盖镜像默认（node 因此找不到）；只带
    // 平台协议前缀变量 + 显式覆盖集，容器基础环境由镜像提供。
    const PASSTHROUGH_ENV_PREFIXES = /^(PROTOCLAW_|AGENTDEV_|CLAW_)/;
    const containerEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (PASSTHROUGH_ENV_PREFIXES.test(key)) containerEnv[key] = value;
    }
    Object.assign(containerEnv, envOverrides, {
      AGENTDEV_DATA_DIR: CONTAINER_DATA_ROOT,
      PROTOCLAW_SESSION_WORKSPACE_CWD: CONTAINER_WORKSPACE,
      PROTOCLAW_RUNTIME_REGISTER: '1',
      PROTOCLAW_RUNTIME_TICKET: ticket,
      AGENTDEV_VIEWER_ADDR: gateway.viewerAddr,
      AGENTDEV_VIEWER_ORIGIN: gateway.viewerOrigin,
      PROTOCLAW_SERVER_ORIGIN: gateway.serverOrigin,
      // ADR-0037 容器修订：容器内索引读走平台 HTTP，禁止直连 index.db
      // （WAL 锁跨不过容器边界）。session-access 检测该标志 fail fast。
      CLAW_SESSION_INDEX_REMOTE: '1',
    });
    delete containerEnv.AGENTDEV_UDS_PATH; // 容器无 UDS；防宿主路径短路 TCP

    // /workspace 挂载在 buildDataMounts 内按 PROTOCLAW_SESSION_WORKSPACE_CWD
    // （会话工作目录）配置；无会话 spawn（无该 env）时挂 seam cwd 兜底。
    if (!cleanSessionText(env.PROTOCLAW_SESSION_WORKSPACE_CWD)) {
      mkdirSync(cwd, { recursive: true });
      binds.push(toBind(cwd, CONTAINER_WORKSPACE));
    }

    const container = await docker.createContainer({
      Image: image,
      // 镜像 ENTRYPOINT 已含 runtime 脚本（M5 Dockerfile），Cmd = 其余参数
      Cmd: argv.slice(1),
      Env: Object.entries(containerEnv).map(([key, value]) => `${key}=${value}`),
      name,
      Labels: { 'claw-runtime': '1', 'claw-runtime-agent': agentId },
      WorkingDir: '/app',
      HostConfig: {
        Binds: binds,
        // Linux 引擎（非 Desktop）无 host.docker.internal：经 host-gateway 映射
        ExtraHosts: [`${HOST_GATEWAY}:host-gateway`],
      },
    });
    handle.container = container;
    await container.start();

    // 日志流 → output 事件（READY / Viewer Agent ID 探测复用宿主消费面）
    const logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 200 });
    const demuxSink = (stream) => new Writable({
      write(chunk, _enc, callback) {
        const text = String(chunk);
        handle.appendTail(text);
        handle.emit('output', { stream, text });
        callback();
      },
    });
    docker.modem.demuxStream(logStream, demuxSink('stdout'), demuxSink('stderr'));

    // 退出监测：wait() 是容器终止的权威信号（人为停止 / 崩溃同源）
    const waitResult = await container.wait().catch((error) => {
      log('runtime-executor', `container wait 失败 (${name}): ${error?.message || error}`, 'warn');
      return { StatusCode: 1 };
    });
    handle.exitCode = typeof waitResult?.StatusCode === 'number' ? waitResult.StatusCode : 1;
    try { logStream.destroy(); } catch { /* 已结束 */ }
    handle.emit('exit', handle.exitCode, null);
    // 退出后收敛容器实体（日志已消费完毕；失败不阻塞退出善后）
    container.remove({ force: true }).catch(() => {});
  })().catch((error) => {
    handle.exitCode = 1;
    handle.emit('error', error);
    handle.emit('exit', 1, null);
    if (handle.container) handle.container.remove({ force: true }).catch(() => {});
  });

  return handle;
}

export const containerRuntimeBackend = { name: 'container', start: startContainerRuntime };
