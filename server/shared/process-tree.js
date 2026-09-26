import { spawn } from 'node:child_process';

/**
 * 终止整棵进程树（宿主裁决的最后手段）。
 *
 * Windows 上子进程不会随父进程消亡，必须经 taskkill /T 沿进程树递归收割；
 * 其他平台的进程组语义下对主进程 SIGKILL 即可，孙进程由各服务自身的
 * shutdown 收敛。本函数承诺"尽力"，不承诺孙进程清零——裁决权的兜底在
 * 调用方（supervisor / 启动预检），不在这里叠加重试。
 *
 * @param {number} pid
 * @returns {Promise<boolean>} 是否成功发起终止
 */
export function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => resolve(false));
      killer.on('exit', (code) => resolve(code === 0));
    });
  }
  return new Promise((resolve) => {
    try {
      process.kill(pid, 'SIGKILL');
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}
