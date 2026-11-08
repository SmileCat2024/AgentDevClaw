/**
 * smoke-plugin-package.mjs — 外部插件包端到端冒烟（ADR-0045 P1/P2 验收）
 *
 * 在隔离数据根（AGENTDEV_DATA_DIR=临时目录）起最小 Express 实例，挂载
 * feature-repository / feature-store / feature-assets 路由与插件数据面
 * 挂载器，对真实构建的 agentero-0.3.0.tgz 走完整链路：
 *
 *   upload → parse → confirm（client/server 面解出）→ install（$mount 装配）
 *   → declarations（声明合成）→ 资产 URL → remount → server 面数据路由
 *
 * 全绿输出 SMOKE OK + 各步证据；任一步失败退出码 1。
 * 用法：node scripts/smoke-plugin-package.mjs <path-to-tgz>
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const tgzPath = process.argv[2];
if (!tgzPath || !existsSync(tgzPath)) {
  console.error('用法: node scripts/smoke-plugin-package.mjs <path-to-tgz>');
  process.exit(1);
}

// 数据根隔离必须在 import server 模块前设置（constants.js import 时解析）
const dataDir = mkdtempSync(join(tmpdir(), 'plugin-smoke-'));
process.env.AGENTDEV_DATA_DIR = dataDir;
process.env.npm_config_registry = process.env.npm_config_registry || 'https://registry.npmmirror.com';

const express = (await import('express')).default;
const { setupFeatureRepositoryRoutes } = await import('../server/routes/feature-repository.js');
const { setupFeatureStoreRoutes } = await import('../server/routes/feature-store.js');
const { setupFeatureAssetRoutes } = await import('../server/routes/feature-assets.js');
const { mountPluginServerRoutes, remountPluginServerRoutes } = await import('../server/feature-runtime/plugin-server.js');
const { installFeature } = await import('../server/feature-runtime/install-service.js');

const app = express();
setupFeatureRepositoryRoutes(app, express);
setupFeatureStoreRoutes(app, express);
setupFeatureAssetRoutes(app);
const initialMount = await mountPluginServerRoutes(app);

const server = http.createServer(app);
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

const steps = [];
const step = async (name, fn) => {
  const result = await fn();
  steps.push(`${result ? '✔' : '✖'} ${name}`);
  if (!result) {
    console.error(steps.join('\n'));
    console.error(`SMOKE FAILED at: ${name}`);
    await cleanup();
    process.exit(1);
  }
};

async function cleanup() {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  await step('upload + parse_upload 返回待确认摘要', async () => {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(tgzPath)]), 'agentero-0.3.0.tgz');
    const res = await fetch(`${base}/protoclaw/feature_repository/parse_upload`, { method: 'POST', body: form });
    const body = await res.json();
    if (!res.ok || !body.uploadId || body.summary?.packageName !== 'agentero') {
      console.error('  parse_upload:', res.status, JSON.stringify(body).slice(0, 300));
      return false;
    }
    globalThis.__uploadId = body.uploadId;
    return true;
  });

  await step('confirm_import 落库 + client/server 面解出', async () => {
    const res = await fetch(`${base}/protoclaw/feature_repository/confirm_import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: globalThis.__uploadId }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) {
      console.error('  confirm_import:', res.status, JSON.stringify(body).slice(0, 300));
      return false;
    }
    return true;
  });

  await step('install 装配到 main 身份（$mount 声明 + provision 环境）', async () => {
    const result = await installFeature({ identity: 'main', packageName: 'agentero', version: '0.3.0' });
    console.log('  install:', JSON.stringify(result).slice(0, 200));
    return Boolean(result?.ok || result?.installed || result?.mounts);
  });

  await step('declarations 下发 agentero-library 面板（scope=global）', async () => {
    const res = await fetch(`${base}/api/feature-ui/declarations`);
    const body = await res.json();
    const panel = (body.declarations || []).find((d) => d.panelId === 'agentero-library');
    if (!res.ok || !panel) {
      console.error('  declarations:', res.status, JSON.stringify(body).slice(0, 300));
      return false;
    }
    console.log('  面板声明:', panel.url, '| label.zh:', panel.meta?.label?.zh, '| when:', JSON.stringify(panel.meta?.when));
    globalThis.__panelUrl = panel.url;
    return true;
  });

  await step('资产 URL 200 + immutable 缓存 + ESM MIME', async () => {
    const res = await fetch(`${base}${globalThis.__panelUrl}`);
    const contentType = res.headers.get('content-type') || '';
    if (res.status !== 200 || !/javascript/.test(contentType) || !/immutable/.test(res.headers.get('cache-control') || '')) {
      console.error('  asset:', res.status, contentType, res.headers.get('cache-control'));
      return false;
    }
    const text = await res.text();
    return text.length > 1000; // React bundle 预期 MB 级
  });

  await step('remount 后 server 面数据路由可达（vault 未配置 → configured:false）', async () => {
    await remountPluginServerRoutes(app);
    const res = await fetch(`${base}/protoclaw/plugin/agentero/status`);
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || !body?.ok || body?.data?.configured !== false) {
      console.error('  server route:', res.status, JSON.stringify(body).slice(0, 300));
      return false;
    }
    return true;
  });

  console.log(steps.join('\n'));
  console.log(`SMOKE OK — 初始挂载 ${JSON.stringify(initialMount.mounted)}，全链路（导入→解出→装配→声明→资产→数据面）通过`);
} finally {
  await cleanup();
}
