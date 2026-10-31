import { spawn } from 'child_process';
import { cleanSessionText } from '../shared/string-helpers.js';

const OUTPUT_TAIL_CHARS = 8000;

function appendOutputTail(handle, text) {
  handle.__runtimeOutputTail = `${handle.__runtimeOutputTail || ''}${text}`.slice(-OUTPUT_TAIL_CHARS);
}

/**
 * 本地执行后端（ADR-0037 M4）。包装既有 spawn + IPC 消息接线 + stdout/stderr
 * tail，把承载差异收敛为统一语义事件；行为与改造前逐字等价（startManagedSession
 * 与 startAssemblyRuntime 的 spawn 参数、stdio、监听接线原样迁移至此）。
 *
 * handle 即 ChildProcess 本体：pid / kill / exitCode / signalCode / exit / error
 * / __runtimeOutputTail 全部保留，managedAgents 记录与共享进程按进程身份分组的
 * 语义不变。在此之上增补契约事件：
 *
 * - 'output' { stream: 'stdout'|'stderr', text }：日志呈现与诊断 tail 的统一
 *   来源。READY / Viewer Agent ID 探测由宿主在 output 事件上单处实现——容器
 *   后端（M6）以 docker 日志流供给同一事件，无需重复解析逻辑。
 * - 'identity' { agentId, sessionId, viewerAgentId, accept() }：IPC
 *   runtime-identity 的语义化。accept() 回执 runtime-identity-accepted（字段
 *   与原实现一致，值来自已通过宿主校验的同一条消息）。
 * - 'session-exited' { sessionId, persisted }：IPC session-exited 直通
 *   （persisted 保留原始值，布尔化判定在宿主消费侧）。
 *
 * 原生 'message' 事件继续可用（本层叠加翻译、不吞消息）：共享进程 join 路径
 * （add-session / session-ready / session-error 双向 IPC）依赖它，且 join 仅
 * 本地后端支持——容器执行不接共享模式（executor 选择层回退 local）。
 */
export function startLocalRuntime({ argv, env, cwd, ipc = false }) {
  const child = spawn(process.execPath, argv, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
    env,
    windowsHide: true,
  });

  child.getOutputTail = () => child.__runtimeOutputTail || '';

  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    appendOutputTail(child, text);
    child.emit('output', { stream: 'stdout', text });
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    appendOutputTail(child, text);
    child.emit('output', { stream: 'stderr', text });
  });

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'runtime-identity') {
      const viewerAgentId = cleanSessionText(message.viewerAgentId);
      if (!viewerAgentId) return;
      child.emit('identity', {
        agentId: message.agentId,
        sessionId: message.sessionId,
        viewerAgentId,
        accept: () => child.send({
          type: 'runtime-identity-accepted',
          agentId: message.agentId,
          sessionId: message.sessionId,
          viewerAgentId,
        }),
      });
      return;
    }
    if (message.type === 'session-exited') {
      child.emit('session-exited', { sessionId: message.sessionId, persisted: message.persisted });
    }
  });

  return child;
}
