import { spawn } from 'node:child_process';

/**
 * 终止由调用方明确拥有的进程树。
 *
 * 仅用于显式退出后的宿主自有子进程清理，以及测试/打包脚本清理自己启动的
 * 进程。服务健康探测、启动端口检查和 supervisor 生命周期不得调用本函数。
 * Windows 上使用 taskkill /T 清理调用方创建的树；其他平台向主进程发送
 * SIGKILL。本函数承诺"尽力"，不承诺孙进程清零。
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
