/**
 * Browser reproduction of empty assistant rows, using production source + CSS.
 * No server, credentials, user sessions or model calls. Only /messages IO and
 * unrelated application chrome/scroll settlement are stubbed. Message commits,
 * diff, append/patch/full rendering, templates and visibility execute real code.
 * Scroll event delivery is held during virtual-tier message injection to isolate
 * message-arrival ownership from scroll settlement. Nonzero exit means failure.
 *
 * node scripts/experiments/empty-assistant-replay.mjs --scenario=virtual
 * node scripts/experiments/empty-assistant-replay.mjs --scenario=virtual --revision=ca283c9
 * node scripts/experiments/empty-assistant-replay.mjs --scenario=grouped
 *
 * Requires installed Playwright Chromium. PLAYWRIGHT_BROWSERS_PATH is honored;
 * otherwise uses Claw's browser asset directory. Artifacts are ignored local data.
 */
/* global applySessionViewPatch, deliver, call, currentMessages, container, document,
  enableProcessView, forceFullRender,
  _onScrollForWindowing, _scrollStopTimer:writable, precomputeViewportIdx, applyProcessDistance, inspect,
  toggleChatProcessVisibility, applyConversationProcessState:writable, window,
  replaySyncCalls, getComputedStyle */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(revision|scenario)=(.+)$/.exec(arg);
  assert.ok(match, 'Expected --revision=<git-ref> or --scenario=virtual|grouped|all');
  return [match[1], match[2]];
}));
const scenario = args.scenario || 'all';
assert.ok(['all', 'virtual', 'grouped'].includes(scenario), 'Unknown scenario');
const revision = args.revision || null;
const source = rel => revision
  ? execFileSync('git', ['show', revision + ':' + rel], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  : fs.readFileSync(path.join(root, rel), 'utf8');
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Source seam missing: ${start}`);
  return text.slice(a, b);
}
const artifactDir = path.join(root, '.agentdev/temp/empty-assistant-replay',
  (revision || 'working-tree').replace(/[^\w.-]/g, '_') + '-' + scenario);
fs.mkdirSync(artifactDir, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(os.homedir(), '.agentdev/AgentDevClaw/assets/playwright-shell/browsers');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const results = [], errors = [];
try {
  async function createPage() {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="chat"></div>');
    await page.addStyleTag({ content: source('public/styles/components.css') });
    await page.addStyleTag({ content: `
      body { margin:16px;background:#fff;color:#222;font:14px sans-serif;
        --text-primary:#222;--text-secondary:#555;--border-color:#ddd; }
      #chat { height:800px;overflow:auto;overflow-anchor:none;display:flex;flex-direction:column;position:relative;gap:24px; }
    ` });
    for (const rel of ['node_modules/marked/lib/marked.umd.js', 'node_modules/@highlightjs/cdn-assets/highlight.min.js']) {
      await page.addScriptTag({ path: path.join(root, rel) });
    }
    await page.addScriptTag({ content: `
      var container = document.getElementById('chat');
      var currentMessages = [], currentInputRequests = [], allAgents = [], toolRenderConfigs = {};
      var currentRuntimeAgentId = 'replay', focusedAgentId = 'programming-helper', _switchEpoch = 0;
      var TOOL_NAMES = {}, currentHookInspector = {}, currentOverviewSnapshot = {}, currentTodoPlan = {}, currentRuntimeConnected = true;
      var showChatProcess = false, followLatestEnabled = false;
      function enableProcessView() { showChatProcess=true; }
      function forceFullRender() { _lastRenderedChatSig=''; render(currentMessages); }
      var _agentCallActive = new Map(), _lastRenderedChatSig = '';
      var _userExpandedReasoning = new Set(), _userExpandedMsgs = new Set(), _userCollapsedMsgs = new Set();
      var chatProcessToggle = null, CHAT_PROCESS_VISIBILITY_KEY = 'replay';
      function setCurrentHookInspector(value) { currentHookInspector=value; }
      function setCurrentOverviewSnapshot(value) { currentOverviewSnapshot=value; }
      function setCurrentTodoPlan(value) { currentTodoPlan=value; }
      function t(s) { return s; }
      function getToolDisplayName(s) { return s || 'Tool'; }
      function getToolRenderTemplate() { return {}; }
      function resolveToolProgressForCall() { return null; }
      function ensureChatRuntimeIndicator() {}
      function runWithSuppressedChatViewportObservers(fn) { return fn(); }
      function notifyChatViewportMutation(o) { refreshMeasuredChatRows(o.reason); }
      function updateFollowLatestButton() {} function cancelChatScrollSettlement() {}
      function consumePendingChatScrollRestore() { return null; }
      function isChatSurfaceActive() { return true; } function shouldRenderWorkspaceSurface() { return false; }
      function getEmptyStateHtml() { return '<div class="empty-state">Welcome</div>'; }
      function getToggleButtonLabel(c) { return c ? 'Expand' : 'Collapse'; }
      function renderCurrentMainView() { render(currentMessages); }
      function clearChatLoadingSession() {} function markAutoTitleCandidate() {}
      function emitMsgMetrics() {} function computeSerializedBytes() { return 0; }
      // The only fake data boundary: respond with a snapshot/delta as /messages would.
      var replayMessages = [];
      async function fetch(url) {
        const query = new URL(url, 'http://replay.invalid').searchParams;
        let messages = replayMessages;
        if (query.has('since')) messages = messages.slice(Number(query.get('since')));
        if (query.has('tail')) messages = messages.slice(-Number(query.get('tail')));
        return {status:200,json:async()=>({messages:structuredClone(messages)})};
      }
      const _appliedMessagesSeq = new Map();
      var replaySeq = 0;
      async function deliver(messages, changeKind) {
        replayMessages = messages;
        return runMessagesProbeCycle(captureSessionViewToken(), {count:messages.length,seq:++replaySeq,changeKind});
      }
      function call(i, big) {
        const arguments = Object.fromEntries(Array.from({length:big ? 120 : 2}, (_,n)=>['field'+n,'fixture '+n]));
        return {role:'assistant',content:'',toolCalls:[{id:'call'+i,name:'fixture_tool',arguments}]};
      }
      function inspect(index) {
        const content = document.getElementById('msg-'+index);
        const row = content?.closest('.message-row'), card = content?.querySelector('.tool-call-container');
        if (!row || !card) return {missing:true};
        const rect=row.getBoundingClientRect(), viewport=container.getBoundingClientRect();
        return {rowClass:row.className,cardClass:card.className,
          rowDisplay:getComputedStyle(row).display,cardDisplay:getComputedStyle(card).display,
          cardContentVisibility:getComputedStyle(card).contentVisibility,
          inViewport:rect.top < viewport.bottom && rect.bottom > viewport.top,
          nodeCount:container.getElementsByTagName('*').length,windowingDisabled:_windowingDisabled,
          messageCount:currentMessages.length,rowCount:container.querySelectorAll('.message-row').length};
      }
    ` });
    for (const name of ['markdown-utils', 'template-engine', 'session-view-state', 'input-helpers', 'lazy-tool-content', 'chat-renderer', 'chat-row-visibility']) {
      await page.addScriptTag({ content: source('public/src/modules/' + name + '.js') });
    }
    // Timeline did not exist at the historical revision; not relevant to these fixtures.
    await page.addScriptTag({ content: between(source('public/src/modules/auto-title.js'), 'function _messagesEqual(', '\n/**'.replaceAll('\n', source('public/src/modules/auto-title.js').includes('\r\n') ? '\r\n' : '\n')) });
    if (!revision) await page.addScriptTag({ content: source('public/src/modules/message-timeline.js') });
    const main = source('public/src/app-main.js');
    await page.addScriptTag({ content: between(main, 'async function runMessagesProbeCycle(', '\n/**\n * todo / overview'.replaceAll('\n', main.includes('\r\n') ? '\r\n' : '\n')) });
    await page.evaluate(() => { applySessionViewPatch({identity:{agentId:'programming-helper',sessionId:'fixture'}}); });
    return page;
  }
  async function save(page, name, before, after, extra = {}) {
    await page.screenshot({ path: path.join(artifactDir, name + '-recovered.png') });
    const contentEnabled = state => !state.missing && state.rowDisplay !== 'none'
      && state.cardDisplay !== 'none' && state.cardContentVisibility !== 'hidden'
      && !state.rowClass.includes('chat-row-distant');
    const result = { name, ...extra, before, after, passed:contentEnabled(before),
      recovered:contentEnabled(after),
      onscreenEmpty:before.inViewport && !contentEnabled(before),
      evidence:name.startsWith('grouped-') ? 'onscreen-symptom' : 'window-ownership-mechanism' };
    results.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(result)}`);
    await page.close();
  }
  if (scenario !== 'grouped') {
    for (const big of [false, true]) for (const mutation of ['append', 'tail']) {
      const page = await createPage();
      await page.evaluate(async big => {
        enableProcessView();
        await deliver([{role:'user',content:'Read history while the agent runs'},
          ...Array.from({length:320},(_,i)=>call(i,big))], 'rewrite');
        // Initial load uses full render (as loadAgentData does), selecting the node-budget tier.
        forceFullRender();
        // Land at the bottom first, then use the real scroll listener to reopen history.
        container.scrollTop=container.scrollHeight;
      }, big);
      // Hold scroll delivery while injecting a streaming event: focus this experiment
      // on message-arrival window ownership, not browser scroll settlement timing.
      await page.evaluate(() => {
        container.removeEventListener('scroll',_onScrollForWindowing);
        if(_scrollStopTimer) clearTimeout(_scrollStopTimer);
        _scrollStopTimer=null;
        container.scrollTop=document.getElementById('msg-20').closest('.message-row').offsetTop;
        precomputeViewportIdx(); applyProcessDistance(container);
        container.scrollTop=document.getElementById('msg-21').closest('.message-row').offsetTop;
      });
      const watchedIndex = await page.evaluate(() => {
        const viewport=container.getBoundingClientRect();
        const row=[...container.querySelectorAll('.message-row.assistant')].find(row=>{
          const rect=row.getBoundingClientRect();return rect.top < viewport.bottom && rect.bottom > viewport.top;
        });
        return Number(row.querySelector('.message-content').id.replace('msg-',''));
      });
      const initial = await page.evaluate(index => inspect(index), watchedIndex);
      assert.equal(initial.inViewport, true, 'Observe an actual onscreen assistant row');
      assert.equal(initial.windowingDisabled, !big, 'Fixture must cross the real node-budget branch');
      const before = await page.evaluate(async ({mutation,index}) => {
        if(mutation==='append') await deliver([...currentMessages,call('new',false)],'append');
        else await deliver(currentMessages.map((m,i)=>i===320?{...m,content:'tail update'}:m),'tail');
        return inspect(index);
      }, {mutation,index:watchedIndex});
      const name = `${big ? 'over-budget' : 'under-budget'}-${mutation}`;
      await page.screenshot({ path:path.join(artifactDir,name+'-before.png') });
      const after = await page.evaluate(index => { toggleChatProcessVisibility();toggleChatProcessVisibility();return inspect(index); },watchedIndex);
      await save(page,name,before,after,{initial});
    }
  }
  if (scenario !== 'virtual') {
    for (const count of [0,1,2]) {
      const page=await createPage();
      const before=await page.evaluate(async count=>{
        enableProcessView();
        const errors=Array.from({length:count},(_,i)=>({role:'assistant',content:'[API Error: fixture '+i+']',
          execution:{status:'failed',error:{category:'server_error'}}}));
        await deliver([{role:'user',content:'Run a tool'},...errors],'rewrite');
        const originalSync=applyConversationProcessState;
        window.replaySyncCalls=[];
        applyConversationProcessState=function(root,fromIndex){
          replaySyncCalls.push({fromIndex,rowCount:root.querySelectorAll('.message-row').length,
            messageCount:currentMessages.length});
          return originalSync(root,fromIndex);
        };
        await deliver([...currentMessages,call('new',false)],'append');
        applyConversationProcessState=originalSync;
        return {...inspect(currentMessages.length-1),syncCalls:replaySyncCalls};
      },count);
      const name=`grouped-errors-${count}`;
      await page.screenshot({path:path.join(artifactDir,name+'-before.png')});
      const after=await page.evaluate(()=>{toggleChatProcessVisibility();toggleChatProcessVisibility();return inspect(currentMessages.length-1);});
      const intervention=await page.evaluate(async count=>{
        const errors=Array.from({length:count},(_,i)=>({role:'assistant',content:'[API Error: fixture '+i+']',
          execution:{status:'failed',error:{category:'server_error'}}}));
        await deliver([{role:'user',content:'Run a tool'},...errors],'rewrite');
        await deliver([...currentMessages,call('new',false)],'append');
        const row=document.getElementById('msg-'+(currentMessages.length-1)).closest('.message-row');
        const domIndex=[...container.querySelectorAll('.message-row')].indexOf(row);
        applyConversationProcessState(container,domIndex);
        return {...inspect(currentMessages.length-1),domIndex};
      },count);
      await save(page,name,before,after,{intervention});
    }
    // Stateful production-chain regression: no toggle or corrective sync between
    // append, body patches and structural rebuild; old history nodes stay alive.
    for (const show of [false,true]) for (const count of [2,4]) {
      const page=await createPage();
      const state=await page.evaluate(async ({show,count})=>{
        if(show) enableProcessView();
        const errors=Array.from({length:count},(_,i)=>({role:'assistant',content:'error '+i,
          execution:{status:'failed',error:{category:'server_error'}}}));
        await deliver([{role:'user',content:'fixture'},...errors],'rewrite');
        const prefix=document.getElementById('msg-0');
        await deliver([...currentMessages,{role:'assistant',content:''}],'append');
        const index=currentMessages.length-1;
        const row=()=>document.getElementById('msg-'+index).closest('.message-row');
        const emptyHidden=row().classList.contains('process-hidden-empty');
        await deliver(currentMessages.map((m,i)=>i===index?{...m,toolCalls:call('late',false).toolCalls}:m),'tail');
        const structural=inspect(index);
        await deliver(currentMessages.map((m,i)=>i===index?{...m,content:'streamed text'}:m),'tail');
        const textVisible=getComputedStyle(row()).display!=='none'
          && row().querySelector('.markdown-body').textContent.trim()==='streamed text';
        await deliver(currentMessages.map((m,i)=>i===index?{...m,content:''}:m),'tail');
        const cleared=inspect(index);
        return {show,count,emptyHidden,structural,textVisible,cleared,
          prefixPreserved:prefix===document.getElementById('msg-0')};
      },{show,count});
      const enabled=s=>s.rowDisplay!=='none' && s.cardDisplay!=='none';
      const passed=state.emptyHidden && state.textVisible && state.prefixPreserved
        && enabled(state.structural)===show && enabled(state.cleared)===show;
      results.push({name:`grouped-stream-show-${show}-errors-${count}`,passed,...state});
      console.log(`${passed?'PASS':'FAIL'} grouped-stream: ${JSON.stringify(state)}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(artifactDir,'results.json'),JSON.stringify({revision:revision||'working-tree',scenario,results,errors},null,2));
}
console.log('Artifacts: '+artifactDir);
assert.deepEqual(errors, [], 'Browser must have no uncaught errors');
assert.ok(results.every(r=>r.passed), 'Visible assistant tool cards must survive incremental updates; see artifacts');
