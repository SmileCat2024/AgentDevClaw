/**
 * p2-w2-2-runtime-status-owner.js — `runtime-status` 域三个跨文件可变状态键的
 * owner（P2 第二波 2）。
 *
 * 迁出边界是**状态所有权**，不是整个 runtime-status.js。三个键原为 classic
 * 顶层 `let`（可替换语义），现：
 *   - 初值仍由 runtime-status.js 在**原声明位置** `defineKey` 注册——首屏同步
 *     链在 deferred 模块执行前必须读到真初值（见下）；
 *   - 本模块在 claim 时一次性吸收哑存储现值（无双存储），此后 classic 侧的
 *     裸标识符读写经同一访问器转发到这里的活绑定。
 *
 * 键名映射（classic 全局名 ↔ 本模块导出）：
 *   `currentRuntimeConnected`          ↔ `currentRuntimeConnected`
 *   `lastNotificationStatusPayload`    ↔ `lastNotificationStatusPayload`
 *   `_lastRenderedNotificationRuntime` ↔ `lastRenderedNotificationRuntime`
 *     （导出名去掉前导下划线；两者是同一份状态，classic 读写与导出读写可见同一值，
 *      见 test/p2-w2-2-runtime-owner.test.js 的逐键断言）
 *
 * 未知键策略：本域一旦 claim，claim.get / claim.set 对未声明的键**直接抛错**，
 * 不返回 undefined、不静默吞写。同一域新增跨文件状态键必须同时在本模块导出并
 * 加入两个 switch 分支——否则 KernelState 在「已 claim 域补注册」时立刻失败
 * （defineKey 会把初值经 impl.set 送入域模块），错误在注册点暴露而非退化成
 * 读到 undefined / 写丢失。
 *
 * 首屏真实性（为什么初值必须留在 classic 相注册）：
 *   `app-main` 顶层 `applyLanguage()` → `renderAgentList()` → sidebar-render 的
 *   侧栏条目投影同步读运行时状态；`session-view-state` 的
 *   `readCurrentSessionViewState()` 同步读 `connected`，`applySessionViewPatch`
 *   同步写回 `connected`；200ms 通知时钟与胶囊 tick 读快照键。deferred 模块执行
 *   晚于这些首屏同步语句，所以键必须在经典相带真初值可读。
 *
 * 仍留在 runtime-status.js（classic 唯一实现）的部分与依据见该文件头注；
 * 本模块不含任何业务实现，只做状态持有与桥转发。
 *
 * 桥键（domain `runtime-status`）：三个键由 classic 文件注册、本模块 claim；
 * 注销条件 = theme-lang / session-view-state / persistent-input 等消费方改 import。
 */

export let currentRuntimeConnected = true;
export let lastNotificationStatusPayload = null;
export let lastRenderedNotificationRuntime = null;

export const setCurrentRuntimeConnected = (value) => { currentRuntimeConnected = value; };
export const setLastNotificationStatusPayload = (value) => { lastNotificationStatusPayload = value; };
export const setLastRenderedNotificationRuntime = (value) => { lastRenderedNotificationRuntime = value; };

const DOMAIN = 'runtime-status';

function rejectUnknownKey(key) {
  throw new Error(
    `[${DOMAIN}] 未知状态键：${key}（本域已由 p2-w2-2-runtime-status-owner 接管；` +
    '新增跨文件状态键必须同时在该模块导出并加入 claim 的 get/set 分支，不接受静默吞值）',
  );
}

window.KernelState.claim(DOMAIN, {
  get(key) {
    switch (key) {
      case 'currentRuntimeConnected': return currentRuntimeConnected;
      case 'lastNotificationStatusPayload': return lastNotificationStatusPayload;
      case '_lastRenderedNotificationRuntime': return lastRenderedNotificationRuntime;
      default: return rejectUnknownKey(key);
    }
  },
  set(key, value) {
    switch (key) {
      case 'currentRuntimeConnected': setCurrentRuntimeConnected(value); break;
      case 'lastNotificationStatusPayload': setLastNotificationStatusPayload(value); break;
      case '_lastRenderedNotificationRuntime': setLastRenderedNotificationRuntime(value); break;
      default: rejectUnknownKey(key);
    }
  },
});
