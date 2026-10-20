import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CODER_FEATURE_PRESETS, ensureCoderFeaturePresets } from '../server/routes/coder-feature-presets.js';

function tempLayerPath() {
  const dir = join(mkdtempSync(join(tmpdir(), 'coder-presets-')), 'feature-config');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent.json');
}

test('ensureCoderFeaturePresets writes presets when layer file does not exist', () => {
  const layerPath = tempLayerPath();
  try {
    const result = ensureCoderFeaturePresets({ layerPath });
    assert.equal(result.created, true);
    assert.equal(result.layerPath, layerPath);

    const written = JSON.parse(readFileSync(layerPath, 'utf8'));
    assert.deepEqual(written, CODER_FEATURE_PRESETS);
    // 两类 API 重试默认开启，预算 5，无总开关。
    const fc = written['force-continuation'];
    assert.equal(fc.outputTruncation, true);
    assert.equal(fc.apiErrorRetry, true);
    assert.equal('enabled' in fc, false);
    assert.equal(fc.maxConsecutiveContinuations, 5);
  } finally {
    rmSync(join(layerPath, '..'), { recursive: true, force: true });
  }
});

test('ensureCoderFeaturePresets never touches an existing layer file', () => {
  const layerPath = tempLayerPath();
  writeFileSync(layerPath, JSON.stringify({ skill: { extraDirs: [] } }, null, 2), 'utf8');
  const before = readFileSync(layerPath, 'utf8');
  try {
    const result = ensureCoderFeaturePresets({ layerPath });
    assert.equal(result.created, false);
    assert.equal(result.layerPath, undefined);
    // 内容逐字节不变：已存在文件（含缺 force-continuation 键）不补键、
    // 不重排——用户配置与"主动清除"都不被出厂预填覆盖
    assert.equal(readFileSync(layerPath, 'utf8'), before);
  } finally {
    rmSync(join(layerPath, '..'), { recursive: true, force: true });
  }
});

test('CODER_FEATURE_PRESETS values stay within the feature manifest contract', () => {
  // manifest 约束：maxConsecutiveContinuations ∈ [1,10]；此处锚定预设值合法。
  // schema 与字段语义的权威在 feature manifest（system_feature_manifests），
  // 本测试只防预设值漂移出契约。
  const limit = CODER_FEATURE_PRESETS['force-continuation'].maxConsecutiveContinuations;
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 10);
});
