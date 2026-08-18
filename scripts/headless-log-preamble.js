// 无头日志前导模块。
//
// 必须是无头入口的第一个 import：ESM 依赖按声明顺序深度优先求值，
// 本模块体（设 env + console 分流补丁）先于后续依赖
// （feature / agent / server 侧模块）的模块顶层执行。
//
// 作用（无头契约：所有日志一律走 stderr，stdout 只承载结果输出）：
// 1. AGENTDEV_LOG_STREAM=stderr —— 框架 writeRawConsole / resolveStdioStream
//    按调用时读取此 env，入口模块体里再设已经太晚（静态 import 提升，
//    且 agentdev 依赖图含 top-level await，会进一步推迟入口模块体）。
// 2. 简版 console 分流补丁 —— 覆盖"框架 console 桥（Agent 构造时才安装）
//    生效之前"的窗口期：模块顶层 / 装配前的 console 输出同样按级别分流，
//    不漏进 stdout。Agent 构造时框架桥会覆盖本补丁（超集，含 namespace
//    与 hub 投递），无需 restore。
//
// 注意：本模块严禁依赖 agentdev 或任何含 top-level await 的模块，
// 否则其体的执行会被异步化，后续依赖将插队先执行，前导失效。
process.env.AGENTDEV_LOG_STREAM = process.env.AGENTDEV_LOG_STREAM || 'stderr';

import { format } from 'util';

const toStderr = process.env.AGENTDEV_LOG_STREAM === 'stderr';

function writeLog(level, args) {
  const line = format(...args) + '\n';
  if (toStderr || level === 'warn' || level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

console.log = (...args) => writeLog('info', args);
console.info = (...args) => writeLog('info', args);
console.debug = (...args) => writeLog('debug', args);
console.warn = (...args) => writeLog('warn', args);
console.error = (...args) => writeLog('error', args);
