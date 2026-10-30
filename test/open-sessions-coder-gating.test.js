// T013c：恢复卡片（open-sessions）不得接纳非 main 会话。
//
// 真实事故（2026-10-10 21:41 接续#3）：coder successor runtime ready 时
// addOpenSession 无条件登记进 open-sessions.json（条目不带 sessionType），
// 服务重启后恢复卡片从文件加载，coder successor 以「可恢复会话」身份
// 出现在智能编码空间首页（乱入），点开按 main 会话激活、落到主空间
// 而非 Coder 投影。coder 等线程身份会话的归属是线程视图，恢复卡片
// 只服务 main 会话。
//
// 数据目录经 AGENTDEV_DATA_DIR 隔离到临时目录（动态 import 保证 env
// 先于 constants 模块求值生效）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-open-sessions-gate-'));
process.env.AGENTDEV_DATA_DIR = tmpDataDir;

const { addOpenSession, getRecoverySessions, initRecoveryCache } = await import(
  '../server/shared/open-sessions-tracker.js'
);
const { writeSessionIndex, closeAllSessionDbs, getPrebuiltWorkspaceDir } = await import(
  '../server/shared/session-access.js'
);

const AGENT = 'ph-gate-test';

// 索引夹具经 writeSessionIndex API 写入（ADR-0036：索引持久层为 index.db，
// 直接落 index.json 文件只在首次访问前作为迁移源生效，运行期直写不可见）。
function writeIndex(sessions) {
  return writeSessionIndex(AGENT, { revision: 1, sessions, activeSessionId: null });
}

function writeOpenSessionsFile(sessions) {
  const filePath = path.join(getPrebuiltWorkspaceDir(AGENT), 'open-sessions.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ updatedAt: new Date().toISOString(), sessions }), 'utf8');
  return filePath;
}

test('T013c-1: addOpenSession 跳过 coder 会话，main 会话照常登记', async () => {
  await writeIndex([
    { id: 'sess-coder', sessionType: 'coder', title: 'coder 会话', openDirectory: 'D:\\proj' },
    { id: 'sess-main', sessionType: 'main', title: 'main 会话', openDirectory: 'D:\\proj' },
  ]);
  await addOpenSession(AGENT, 'sess-coder');
  await addOpenSession(AGENT, 'sess-main');
  const file = JSON.parse(fs.readFileSync(
    path.join(getPrebuiltWorkspaceDir(AGENT), 'open-sessions.json'), 'utf8'));
  const ids = file.sessions.map((s) => s.sessionId);
  assert.ok(!ids.includes('sess-coder'), 'coder 会话不得进入恢复登记');
  assert.ok(ids.includes('sess-main'), 'main 会话照常登记');
});

test('T013c-2: 恢复卡片读取过滤历史脏条目（coder 条目即便已在文件中也被丢弃）', async () => {
  // 模拟修复前已落盘的脏数据：coder successor 条目无 sessionType 字段
  await writeIndex([
    { id: 'sess-coder-dirty', sessionType: 'coder', title: 'coder 会话', openDirectory: 'D:\\proj' },
    { id: 'sess-main-dirty', sessionType: 'main', title: 'main 会话', openDirectory: 'D:\\proj' },
  ]);
  writeOpenSessionsFile([
    { sessionId: 'sess-coder-dirty', title: 'x', openDirectory: 'D:\\proj', updatedAt: '2026-10-10T00:00:00Z' },
    { sessionId: 'sess-main-dirty', title: 'y', openDirectory: 'D:\\proj', updatedAt: '2026-10-10T00:00:00Z' },
  ]);
  await initRecoveryCache(AGENT);
  const recovered = await getRecoverySessions(AGENT);
  const ids = recovered.map((s) => s.sessionId);
  assert.ok(!ids.includes('sess-coder-dirty'), '历史脏 coder 条目必须被读取侧过滤');
  assert.ok(ids.includes('sess-main-dirty'), 'main 条目保留');
});

test.after(() => {
  closeAllSessionDbs(); // Windows 下打开的 db 句柄会让 rmSync 报 EBUSY
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});
