import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripNestedRuntimeEnv } from '../server/shared/nested-runtime-env.js';

/**
 * ADR-0037 M4：嵌套启动 env 剥离（修 M1 遗留——在托管 runtime 内再启动
 * Claw server 时，宿主注入的 UDS 路径 / 会话身份会短路 per-instance 派生）。
 */

describe('stripNestedRuntimeEnv（嵌套启动 env 剥离）', () => {
  it('无嵌套特征时原样返回（同一引用，正常启动零开销）', () => {
    const env = { PATH: 'x', CLAW_SUPERVISED: '1' };
    assert.equal(stripNestedRuntimeEnv(env), env);
  });

  it('签名键为空字符串不视为嵌套（显式注入冒烟路径不受影响）', () => {
    const env = { AGENTDEV_UDS_PATH: 'explicit-uds-path', PROTOCLAW_PREBUILT_AGENT_ID: '' };
    assert.equal(stripNestedRuntimeEnv(env), env);
  });

  it('检测到嵌套特征时剥离全部 runtime 专属键，保留其余键', () => {
    const runtimeKeys = {
      AGENTDEV_UDS_PATH: '\\\\.\\pipe\\host-runtime',
      AGENTDEV_VIEWER_ADDR: 'tcp://127.0.0.1:2026',
      AGENTDEV_VIEWER_ORIGIN: 'http://192.168.1.5:1420',
      PROTOCLAW_PREBUILT_AGENT_ID: 'programming-helper',
      PROTOCLAW_PREBUILT_SESSION_ID: 's1',
      PROTOCLAW_SESSION_WORKSPACE_CWD: 'D:/host/path',
      PROTOCLAW_SESSION_TYPE: 'ph',
      PROTOCLAW_GC_CHAT_ID: 'gc1',
      PROTOCLAW_MODEL_PRESET_ROLE: 'default',
      PROTOCLAW_HANDOFF_PATH: 'D:/handoff.json',
      PROTOCLAW_HANDOFF_PAYLOAD: 'payload',
      PROTOCLAW_ASSEMBLY_RUNTIME: '1',
      PROTOCLAW_ASSEMBLY_WORKSPACE: 'D:/assembly',
    };
    const env = { PATH: 'x', NODE_ENV: 'test', ...runtimeKeys };
    const stripped = stripNestedRuntimeEnv(env);

    assert.equal(stripped.PATH, 'x', '非 runtime 键保留');
    assert.equal(stripped.NODE_ENV, 'test', '非 runtime 键保留');
    for (const key of Object.keys(runtimeKeys)) {
      assert.equal(key in stripped, false, `${key} 应被剥离`);
    }
    assert.equal(env.AGENTDEV_UDS_PATH, '\\\\.\\pipe\\host-runtime', '入参对象不被原地修改');
  });
});
