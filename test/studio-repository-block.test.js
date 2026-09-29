/**
 * studio-repository block 数据链：resolveWorkspaceData 的 featureRepository.userOnly
 * 分支只读用户 Feature 仓库（快照与导入 tgz 的同一数据源），且按文件签名缓存
 * 摘要——文件集不变时复用同一对象（loadAgents 每 3s 打一次 /api/agents，稳态
 * 不应重复起 tar 进程），新增 tgz 后重新扫描。
 *
 * harness 参照 git-default-repo.test.js：AGENTDEV_DATA_DIR 隔离数据目录
 * （workspace.js 模块链在 import 时解析数据根）。
 */
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'studio-repo-block-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { resolveWorkspaceData } = await import('../server/routes/workspace.js');

const USER_REPO = join(DATA_ROOT, 'user-features');

const AGENT = {
  id: 'studio-repo-test',
  ui: {
    home: {
      blocks: [
        {
          id: 'studio-repository',
          type: 'studio-repository',
          featureRepository: { userOnly: true },
        },
      ],
    },
  },
};

/** 手工 tgz（npm pack 形态的 package/ 前缀），只含 package.json 即可入摘要。 */
function writeRepoTgz(fileName, packageName, version) {
  const pkgRoot = mkdtempSync(join(tmpdir(), 'studio-repo-pkg-'));
  try {
    mkdirSync(join(pkgRoot, 'package'));
    writeFileSync(
      join(pkgRoot, 'package', 'package.json'),
      JSON.stringify({ name: packageName, version, description: `${packageName} 测试包` }),
    );
    execFileSync('tar', ['--force-local', '-czf', join(USER_REPO, fileName), 'package'], { cwd: pkgRoot });
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
}

test.after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('studio-repository block（featureRepository.userOnly）', () => {
  it('空仓库返回空列表且 exists=false', async () => {
    const data = await resolveWorkspaceData(AGENT);
    const block = data['studio-repository'];
    assert.equal(block.type, 'feature-repository');
    assert.equal(block.exists, false);
    assert.deepEqual(block.packages, []);
    assert.equal(block.packageCount, 0);
  });

  it('只聚合用户仓库：tgz 入仓后出现包条目', async () => {
    mkdirSync(USER_REPO, { recursive: true });
    writeRepoTgz('demo-feature-1.0.0.tgz', '@demo/demo-feature', '1.0.0');
    const data = await resolveWorkspaceData(AGENT);
    const block = data['studio-repository'];
    assert.equal(block.exists, true);
    assert.equal(block.packageCount, 1);
    assert.equal(block.packages[0].packageName, '@demo/demo-feature');
    assert.equal(block.packages[0].latestVersion, '1.0.0');
    assert.equal(block.packages[0].source, 'custom');
  });

  it('文件集不变时命中缓存（packages 同一引用），新增 tgz 后重扫', async () => {
    const first = (await resolveWorkspaceData(AGENT))['studio-repository'];
    const second = (await resolveWorkspaceData(AGENT))['studio-repository'];
    // 稳态复用上次摘要：/api/agents 高频轮询不应每轮起 tar 进程
    assert.equal(second.packages, first.packages);

    writeRepoTgz('another-feature-2.0.0.tgz', '@demo/another-feature', '2.0.0');
    const third = (await resolveWorkspaceData(AGENT))['studio-repository'];
    assert.notEqual(third.packages, first.packages);
    assert.equal(third.packageCount, 2);
    assert.equal(third.packages.some((item) => item.packageName === '@demo/another-feature'), true);
  });
});
