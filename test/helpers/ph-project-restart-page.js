// Browser fixture: actual sidebar projection, data loading and context restart
// handler. Only unrelated workspace navigation/chrome are inert.
export function restartPage({ projectId, root }) {
  return `<!doctype html><html lang="zh"><body>
  <div id="agent-list"></div><div id="external-agent-list"></div>
  <button id="restart" type="button">重启所选对话</button>
  <output id="navigation"></output>
  <script>
  let allAgents=[], currentLanguage='zh', currentMessages=[], focusedAgentId='programming-helper', currentRuntimeAgentId='';
  let loadAgentsInFlight=null, suppressSidebarRerender=false, _navigationGuardEpoch=0;
  const loadedAgentDetailIds=new Set(), pendingPrebuiltAgentIds=new Set(), restartingRuntimeIds=new Set(), _recentlyFinishedRuntimes=new Set(), _agentCallActive=new Map();
  const agentList=document.getElementById('agent-list'), externalAgentList=document.getElementById('external-agent-list'), externalGroup={style:{}}, externalCount={};
  function normalizeAgentIdentity(v){return String(v||'').trim()}
  function getPathLeaf(v){return String(v||'').split('/').filter(Boolean).pop()||''}
  function toEpochMs(v){return Date.parse(v||'')||0}
  function getRuntimeId(a){return a?.runtime_session_id||a?.id||''}
  function getAgentRuntimeId(a){return a?.runtime_session_id||''}
  function getParentAgentId(a){return a?.parent_id||''}
  function getActiveSessionId(a){return a?.active_workspace_session_id||''}
  function isRuntimeItemActive(id){return id===currentRuntimeAgentId}
  function isSidebarRuntimeDisconnected(e){return e?.status==='disconnected'}
  function isRuntimeSuspended(){return false}
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function t(k){return k}
  function groupConnectedAgents(){return {external:[]}}
  function updateCurrentAgentChrome(){}
  function renderFeaturePanel(){}
  function isRemoteNamespaceAgentId(){return false}
  async function refreshAgentCallStates(){}
  function clearAgentRuntimeCache(){}
  function bumpNavigationGuard(){_navigationGuardEpoch++}
  async function requestSwitch(id){currentRuntimeAgentId=id;document.getElementById('navigation').textContent=id;renderAgentList()}
  async function invoke(command,payload){
    const response=await fetch('/protoclaw/'+command,{method:command==='get_connected_agents'?'GET':'POST',headers:{'Content-Type':'application/json'},...(command==='get_connected_agents'?{}:{body:JSON.stringify(payload)})});
    if(!response.ok)throw new Error(await response.text());
    return response.json();
  }
  window.SIDEBAR_TODO_COLORS=new Set(['white']);
  window.ClawThreads={threads:[{threadId:'thread-project',agentId:'programming-helper',headSessionId:'project',sessionIds:['project'],status:'open',headRuntimeRunning:true}]};
  window.ClawSidebarLayout={load:async()=>{},signature:()=>'',isInteracting:()=>false,render(){agentList.innerHTML=renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0],allAgents),'programming-helper')}};
  </script>
  <script src="/src/modules/sidebar-operations.js"></script>
  <script src="/src/modules/project-data.js"></script>
  <script src="/src/modules/runtime-status.js"></script>
  <script src="/src/modules/navigation-core.js"></script>
  <script src="/src/modules/external-runtime.js"></script>
  <script src="/src/modules/ctx-menu-items.js"></script>
  <script src="/src/modules/sidebar-render.js"></script>
  <script>
  let selectedTarget=null;
  agentList.addEventListener('click',event=>{
    const item=event.target.closest('[data-ctx-role="runtime"]');
    if(!item)return;
    selectedTarget={ns:item.dataset.ctxNs,id:item.dataset.ctxId,sessionId:item.dataset.ctxSessionId,variant:item.dataset.ctxVariant};
  });
  window.switchAgent=async id=>{currentRuntimeAgentId=id;renderAgentList()};
  document.getElementById('restart').onclick=async()=>{
    await ctxRestartAgent(selectedTarget);
    document.body.dataset.restarted='true';
  };
  window.ClawFW.phProjectEntities={loaded:true,projects:[{id:${JSON.stringify(projectId)},name:'测试项目',workDirectory:${JSON.stringify(root)}}]};
  loadAgents().then(()=>document.body.dataset.ready='true');
  </script></body></html>`;
}
