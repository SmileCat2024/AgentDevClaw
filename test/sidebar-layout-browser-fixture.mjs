// Isolated UI harness: real sidebar modules and settings routes, temporary data only.
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupWorkspaceSettingsRoutes } from '../server/routes/workspace-settings.js';

export async function startSidebarFixture(port = 0) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-sidebar-browser-'));
  const app = express();
  let failSave = false;
  app.put('/protoclaw/workspace_settings/sidebar_layout', (req, res, next) => {
    if (failSave) return res.status(503).json({ error: 'fixture failure' });
    next();
  });
  app.post('/fixture/fail-save/:value', (req, res) => { failSave = req.params.value === 'true'; res.json({ ok: true }); });
  setupWorkspaceSettingsRoutes(app, express, { settingsPath: path.join(dataDir, 'workspace-settings.json') });
  app.use(express.static('public'));
  const index = await fs.readFile('public/index.html', 'utf8');
  const sidebar = index.slice(index.indexOf('  <div class="sidebar"'), index.indexOf('  <div class="sidebar-resizer"'));
  app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles/base.css"><link rel="stylesheet" href="/styles/layout.css">
    <link rel="stylesheet" href="/styles/components.css"><link rel="stylesheet" href="/styles/sidebar-layout.css">
    <style>body{display:flex;height:100vh}.sidebar{height:100vh}.fixture-main{padding:24px}</style>
    </head><body>${sidebar}<main class="fixture-main"><h1>左栏整理验证</h1><button id="refresh">后台更新</button><button id="theme">切换主题</button><p id="navigation"></p></main>
    <script>
    let currentLanguage='zh', focusedAgentId=null, currentRuntimeAgentId=null;
    let allAgents=[
      {id:'qqbot',name:'IM 渠道',source:'prebuilt'},
      {id:'memo',name:'智能备忘录',source:'prebuilt'},
      {id:'programming-helper',name:'智能编码空间',source:'prebuilt'},
      {id:'coder',name:'Coder',source:'prebuilt'},
    ];
    const agentList=document.getElementById('agent-list');
    const externalAgentList=document.getElementById('external-agent-list'),externalGroup=document.getElementById('external-group'),externalCount=document.getElementById('external-count');
    const pendingPrebuiltAgentIds=new Set(),restartingRuntimeIds=new Set(),_recentlyFinishedRuntimes=new Set(),_agentCallActive=new Map();
    function normalizeAgentIdentity(v){return String(v||'')}
    function getAgentRuntimeId(a){return a.runtimeId||''}
    function getParentAgentId(a){return a.parent_id||''}
    function getActiveSessionId(){return ''}
    function isAgentActive(a){return a.id===focusedAgentId}
    function isWorkspaceSurfaceUnit(){return true}
    function isRuntimeCalling(){return false}
    function collectRuntimeEntriesForPrebuilt(a){return a.id==='programming-helper'?[{runtimeId:'session-demo',name:'运行中会话（拖动引用保持原样）',sessionId:'demo',ownerId:a.id,source:'local',contextMenuEnabled:false}]:[]}
    function isRuntimeItemActive(id){return id===currentRuntimeAgentId}
    function isSidebarRuntimeDisconnected(){return false}
    function isRuntimeSuspended(){return false}
    function updateCurrentAgentChrome(){}
    function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    function groupConnectedAgents(list){return {prebuilt:list.filter(a=>!['coder','programming-helper'].includes(a.id)),workGroup:[],tool:list.filter(a=>['coder','programming-helper'].includes(a.id)),external:[]}}
    window.handlePrebuiltAgentClick=async id=>{focusedAgentId=id;document.getElementById('navigation').textContent=id;renderAgentList()};
    window.switchAgent=async id=>{document.getElementById('navigation').textContent=id};
    window.onSidebarPinPointerDown=()=>{};
    </script>
    <script src="/src/modules/sidebar-layout.js"></script><script src="/src/modules/sidebar-render.js"></script>
    <script>
    document.getElementById('refresh').onclick=()=>{lastAgentListRenderSignature='';renderAgentList()};
    document.getElementById('theme').onclick=()=>{document.body.dataset.theme=document.body.dataset.theme==='light'?'dark':'light'};
    window.fixtureSetAgents=list=>{allAgents=list;renderAgentList()};
    window.fixtureSelectRuntime=id=>{currentRuntimeAgentId=id;focusedAgentId=id;renderAgentList()};
    window.ClawSidebarLayout.load().then(()=>{document.body.dataset.ready='true'});
    </script></body></html>`));
  const server = app.listen(port, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/fixture`, dataDir,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startSidebarFixture(Number(process.env.PORT) || 1435);
  console.log(`ready ${fixture.url}`);
  process.stdin.resume();
  process.stdin.on('data', async () => { await fixture.close(); process.exit(0); });
}
