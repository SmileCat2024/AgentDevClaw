/* global document, getComputedStyle, XMLSerializer, Option */
import { projectTopology, selectTopologyNode } from './view-model.mjs';
// Standalone offline viewer: no CDN, network requests, or conversation bodies.
export function renderTopology(graph) {
  const payload = JSON.stringify(graph).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>线程引用 · 协作关系图</title><link rel="icon" href="data:,"><style>${styles}</style>
<body><header><div><h1>线程引用 · 协作关系图</h1><p id="subtitle"></p></div><button id="theme">切换明暗</button></header>
<section class="metrics" id="metrics"></section>
<section class="toolbar" aria-label="图谱控制"><label>层级 <select id="level"><option value="thread">线程之间（Thread）</option><option value="mixed">含未归属会话</option></select></label><label>关系 <select id="kind"><option value="reference">显式引用</option><option value="knowledge">引用 + 成功读取</option><option value="read">仅成功读取</option><option value="all">全部证据（含失败与血缘）</option></select></label><label>关联群 <select id="cluster"><option value="all">全部关联群</option></select></label><label>范围 <select id="scope"><option value="global">完整范围</option><option value="component">锚定节点 · 关联群</option><option value="neighbors">锚定节点 · 一跳邻居</option><option value="ancestors">锚定节点 · 向外追溯</option><option value="dependents">锚定节点 · 谁依赖它</option></select></label></section>
<section class="view-tools"><div><button id="clear" disabled>取消选择 · Esc</button><label><input type="checkbox" id="focus"> 淡化无关节点</label><label><input type="checkbox" id="isolated"> 包含孤立节点</label></div><div><button id="reset">适应画布</button><button id="export">导出 SVG</button></div></section>
<main><aside class="catalog"><label for="search">查找线程 / 节点</label><input id="search" type="search" placeholder="标题 / Session / Thread ID"><p class="muted" id="listNote"></p><div id="list"></div></aside>
<section class="canvas-panel"><div class="canvas-heading"><strong id="viewCount"></strong><span>箭头：引用方 → 背景来源</span></div><svg id="graph" role="img" aria-label="对话关系网络；可在左栏键盘选择对话" viewBox="0 0 1100 760"><defs><marker id="arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs><g id="viewport"></g></svg><div class="legend"><span><i class="reference"></i>用户引用</span><span><i class="read"></i>成功读取</span><span><i class="structure"></i>血缘 / 其他</span><span>大小 = 被引用数 · 滚轮缩放 / 拖动平移 · 空白点击取消选择</span></div></section>
<aside class="details"><h2 id="detailTitle">选择一个对话</h2><div id="detail"></div></aside></main>
<footer><details><summary>覆盖范围、证据口径与限制</summary><p>读取本机规范存储中有索引的会话，包含归档；按现有 Thread 归属合并。未主动读取远程主机、备份、回滚历史或无索引文件。扫描不是跨文件事务快照；活动会话可能继续变化。此图不是协作成果或语义因果的判定。</p><p>显式引用只认来源为 session-reference 的系统消息；工具读取只认 assistant 的 session_read_overview / session_read_turn 及对应结果。成功表示工具返回内容，不证明模型已理解。失败与结果缺失单列，正文里随意出现的 ID 不构成边。</p><p>去重仅沿有证据的接续 / 分支祖先：工具按调用 ID；引用按目标、前一用户消息的哈希及同形出现序号。引用没有原生事件 ID，重复计数仍可能受裁剪和摘要影响。图中引用次数是重建的观察值，不是平台原生计数。</p><p id="coverage"></p></details></footer>
<script id="data" type="application/json">${payload}</script><script>(${client.toString()})(${projectTopology.toString()}, ${selectTopologyNode.toString()});</script></body></html>`;
}

const styles = `
:root{color-scheme:dark;--bg:#141619;--panel:#1c1f24;--text:#edf0f6;--muted:#a6adbb;--line:#343942;--accent:#6391ff;--read:#a6adbb;--hover:#292f3a;--warning:#dba76c;--label:#141619}
body.light{color-scheme:light;--bg:#f5f6f8;--panel:#fff;--text:#202634;--muted:#586174;--line:#d7dce5;--accent:#345fc9;--read:#727c90;--hover:#edf1f8;--warning:#996121;--label:#f5f6f8}
*{box-sizing:border-box}body{margin:0;padding:24px;font:14px/1.55 system-ui,'Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{font-size:24px;margin:0;font-weight:700}h2{font-size:18px;margin:0 0 16px}p{margin:8px 0}header p,.muted{color:var(--muted);font-size:12px}button,input,select{font:inherit;color:inherit;border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:9px 12px}button{cursor:pointer;font-weight:600}button:hover,button.active{background:var(--hover);border-color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.metrics{display:flex;gap:32px;padding:20px 0;border-bottom:1px solid var(--line)}.metric strong{font-size:24px;font-weight:650;margin-right:8px}.metric span{color:var(--muted);font-size:13px}.toolbar{display:flex;align-items:center;gap:16px;padding:16px 0;flex-wrap:wrap}.toolbar label{display:flex;align-items:center;gap:8px;font-size:13px}main{display:grid;grid-template-columns:240px minmax(0,1fr) 310px;grid-template-rows:minmax(0,1fr);gap:16px;min-height:500px;height:calc(100vh - 340px)}aside,.canvas-panel{border:1px solid var(--line);border-radius:16px;background:var(--panel);min-width:0}.catalog,.details{padding:16px;overflow:auto}.catalog input{width:100%;margin-top:8px}.catalog #list{display:flex;flex-direction:column;gap:6px}.item{width:100%;text-align:left;font-size:13px;padding:10px;background:transparent;line-height:1.5;font-weight:500}.item small{display:block;color:var(--muted);font-size:11px;margin-top:4px}.canvas-panel{display:flex;flex-direction:column;background:var(--bg)}.canvas-heading{display:flex;justify-content:space-between;gap:12px;padding:16px;font-size:12px;color:var(--muted)}.canvas-heading strong{color:var(--text)}#graph{display:block;width:100%;flex:1;min-height:0;touch-action:none;cursor:grab}#graph:active{cursor:grabbing}.legend{display:flex;gap:12px;padding:12px 16px;flex-wrap:wrap;font-size:11px;color:var(--muted)}.legend i{display:inline-block;width:16px;height:2px;margin:0 5px 3px 0;background:var(--read)}.legend .reference{background:var(--accent)}.legend .structure{background:var(--warning)}.node{cursor:pointer}.node text{fill:var(--text);stroke:var(--label);stroke-width:4px;paint-order:stroke;font-size:12px}.node circle{fill:var(--accent);stroke:var(--bg);stroke-width:2}.node.missing circle{fill:var(--warning)}.node.selected circle{stroke:var(--text);stroke-width:3}.edge{fill:none;stroke:var(--read);stroke-opacity:.38;stroke-width:1.2}.edge.reference{stroke:var(--accent);stroke-opacity:.5}.edge.structural{stroke:var(--warning);stroke-dasharray:5 4}.dim{opacity:.1}.relation{border-top:1px solid var(--line);padding:12px 0}.relation button{border:0;background:none;text-align:left;padding:0;font-size:13px;color:var(--accent);font-weight:500}.details h3{font-size:13px;margin:20px 0 8px}.details code{font-size:11px;overflow-wrap:anywhere;color:var(--muted)}.details p{font-size:12px}.badge{display:inline-block;padding:2px 7px;border:1px solid var(--line);border-radius:6px;font-size:11px;color:var(--muted);margin:4px 4px 4px 0}footer{font-size:12px;color:var(--muted);margin-top:16px}summary{cursor:pointer}details p{max-width:1100px}.evidence{padding:8px;background:var(--bg);border-radius:8px;margin:6px 0;font-size:11px;overflow-wrap:anywhere}.empty{padding:24px;color:var(--muted)}
button:disabled{opacity:.4;cursor:default}header button{white-space:nowrap}.metrics{padding:14px 0;gap:24px}.metric strong{font-size:22px}.toolbar{padding:12px 0 8px;gap:12px}.toolbar select{max-width:260px}.view-tools{display:flex;justify-content:space-between;gap:12px;padding:0 0 14px;flex-wrap:wrap}.view-tools>div{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.view-tools label{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}.view-tools button{font-size:12px;padding:7px 12px}main{height:calc(100vh - 330px);min-height:480px;grid-template-columns:250px minmax(0,1fr) 300px}.catalog #list{gap:2px}.item{border-color:transparent;border-radius:8px;border-bottom:1px solid var(--line);padding:12px 8px}.item.active{border:1px solid var(--accent)}.canvas-panel{background:radial-gradient(var(--line) .6px,transparent .6px);background-size:22px 22px}.canvas-heading{background:var(--panel);border-radius:16px 16px 0 0;border-bottom:1px solid var(--line)}.node.selected circle{fill:var(--accent);stroke:var(--text);stroke-width:4}.dim{opacity:.25}.legend{background:var(--panel);border-radius:0 0 16px 16px}.node text{font-size:13px}#graph{outline:none}#cluster{max-width:290px}footer{margin-top:10px}
@media(min-width:1800px){main{grid-template-columns:290px minmax(0,1fr) 360px}}@media(max-width:1100px){main{grid-template-columns:200px minmax(0,1fr);height:700px}.details{grid-column:1/-1;max-height:500px}main{height:auto}.canvas-panel,.catalog{height:620px}.metrics{gap:16px;flex-wrap:wrap}}@media(max-width:650px){body{padding:16px}h1{font-size:20px}header{align-items:flex-start}main{display:flex;flex-direction:column}.catalog{height:250px}.canvas-panel{height:520px}.details{max-height:none}.metric strong{font-size:20px}.toolbar{gap:12px}.canvas-heading{flex-direction:column}}
`;

function client(projectTopology, selectTopologyNode) {
  const data = JSON.parse(document.getElementById('data').textContent);
  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  const nodes = new Map(data.nodes.map(n => [n.id, n]));
  const sessions = new Map(data.sessions.map(s => [s.id, s]));
  const events = new Map(data.events.map(e => [e.id, e]));
  const names = { reference: '用户引用', 'read-overview': '读取概览', 'read-turn': '读取轮次', continuation: '接续自', branch: '分支自', derived: '派生自' };
  let selected = null, currentEdges = [], currentNodes = [], transform = { x: 0, y: 0, k: 1 };
  let drag = null, anchor = null, projection = null;
  const positions = new Map();
  const count = value => Number(value || 0).toLocaleString('zh-CN');
  const unit = () => $('level').value === 'thread' ? '线程' : '节点';
  $('subtitle').textContent = `一个节点 = 一条 Thread，历史 Session 收在详情中 · 数据快照 ${new Date(data.finishedAt).toLocaleString('zh-CN')}`;
  function renderMetrics() {
    $('metrics').replaceChildren();
    for (const [value, label] of [[projection.nodes.length, `${unit()}总数`], [projection.edges.length, `${unit()}间关系`], [projection.edges.reduce((sum, e) => sum + e.count, 0), '关系事件'], [projection.components.length, '关联群'], [projection.excludedEdges, '未归属关系（未画入）']]) {
      const div = document.createElement('div'); div.className = 'metric';
      const strong = document.createElement('strong'); strong.textContent = count(value);
      const span = document.createElement('span'); span.textContent = label; div.append(strong, span); $('metrics').append(div);
    }
  }
  function updateProjection() {
    projection = projectTopology(data, { level: $('level').value, kind: $('kind').value, isolated: $('isolated').checked });
    const r = rank(projection.edges);
    $('cluster').replaceChildren(new Option('全部关联群', 'all'));
    for (const group of projection.components.filter(c => c.length > 1)) {
      const representative = [...group].sort((a, b) => (r.incoming.get(b)?.size || 0) - (r.incoming.get(a)?.size || 0))[0];
      $('cluster').append(new Option(`${group.length} ${unit()} · ${nodes.get(representative).title}`, group[0]));
    }
    selected = null; anchor = null; $('scope').value = 'global';
    renderMetrics(); rebuild();
  }
  $('coverage').textContent = `可读 ${data.stats.readableSessions}/${data.stats.indexedSessions} 个会话；目标未解析 ${data.stats.unresolvedTargets}；警告 ${data.warnings.length}；未扫描的无索引文件 ${data.stats.excluded.orphanFiles}。完整文件摘要、证据定位与警告见同目录 graph.json / summary.json。`;
  function eligible() { return projection.edges; }
  function rank(edges) {
    const incoming = new Map(), outgoing = new Map();
    for (const e of edges) {
      if (!incoming.has(e.target)) incoming.set(e.target, new Set()); incoming.get(e.target).add(e.source);
      if (!outgoing.has(e.source)) outgoing.set(e.source, new Set()); outgoing.get(e.source).add(e.target);
    }
    return { incoming, outgoing };
  }
  function reach(edges, start, direction) {
    const seen = new Set([start]), pending = [start];
    while (pending.length) {
      const id = pending.shift();
      for (const e of edges) {
        const next = (direction === 'ancestors' || direction === 'component') && e.source === id ? e.target : (direction === 'dependents' || direction === 'component') && e.target === id ? e.source : null;
        if (next && !seen.has(next)) { seen.add(next); pending.push(next); }
      }
    }
    return seen;
  }
  function choose(id) {
    selected = selectTopologyNode(selected, id);
    draw(); renderList(); renderDetails();
  }
  function clearSelection() {
    selected = null;
    draw(); renderList(); renderDetails();
  }
  function rebuild() {
    const all = eligible();
    const cluster = projection.components.find(c => c[0] === $('cluster').value);
    let visible = new Set(cluster || projection.nodes.map(n => n.id));
    const scope = $('scope').value;
    if (scope !== 'global' && anchor) {
      visible = scope === 'neighbors' ? new Set([anchor, ...all.filter(e => e.source === anchor || e.target === anchor).flatMap(e => [e.source, e.target])]) : reach(all, anchor, scope);
    }
    currentEdges = all.filter(e => visible.has(e.source) && visible.has(e.target));
    currentNodes = [...visible].map(id => nodes.get(id)).filter(Boolean);
    if (!visible.has(selected)) selected = null;
    layout(); fit(); draw(); renderList(); renderDetails();
    $('viewCount').textContent = `${count(currentNodes.length)} ${unit()} · ${count(currentEdges.length)} 条关系${scope !== 'global' && anchor ? ' · 范围锚：' + nodes.get(anchor).title : ''}`;
  }
  function isLocal() { return $('scope').value !== 'global' || $('cluster').value !== 'all'; }
  function layout() {
    positions.clear();
    if (isLocal() && currentNodes.length <= 45) {
      const ordered = [...currentNodes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const columns = Math.min(3, ordered.length);
      ordered.forEach((n, i) => positions.set(n.id, { x: 140 + (i % columns) * 300, y: 70 + Math.floor(i / columns) * 190 }));
      return;
    }
    const adjacency = new Map(currentNodes.map(n => [n.id, new Set()]));
    for (const e of currentEdges) { adjacency.get(e.source).add(e.target); adjacency.get(e.target).add(e.source); }
    const seen = new Set(), components = [];
    for (const n of currentNodes) {
      if (seen.has(n.id)) continue;
      const group = [], queue = [n.id]; seen.add(n.id);
      while (queue.length) { const id = queue.shift(); group.push(id); for (const to of adjacency.get(id)) if (!seen.has(to)) { seen.add(to); queue.push(to); } }
      group.sort((a, b) => adjacency.get(b).size - adjacency.get(a).size || a.localeCompare(b));
      components.push(group);
    }
    components.sort((a, b) => b.length - a.length);
    let cursorX = 0, cursorY = 0, rowHeight = 0;
    const packingWidth = Math.max(1100, Math.sqrt(currentNodes.length) * 90);
    for (const group of components) {
      const size = Math.max(110, Math.sqrt(group.length) * 70);
      if (cursorX + size > packingWidth) { cursorX = 0; cursorY += rowHeight + 50; rowHeight = 0; }
      const local = group.map((id, i) => ({ id, x: Math.cos(i * 2.39996) * Math.sqrt(i + 1) * 28, y: Math.sin(i * 2.39996) * Math.sqrt(i + 1) * 28 }));
      const lookup = new Map(local.map(n => [n.id, n]));
      const pairs = currentEdges.filter(e => lookup.has(e.source) && lookup.has(e.target));
      // Bounded static force layout, deterministic across reloads; no animation loop.
      if (group.length < 700) for (let step = 0; step < 110; step++) {
        const forces = local.map(() => ({ x: 0, y: 0 }));
        for (let i = 0; i < local.length; i++) for (let j = i + 1; j < local.length; j++) {
          let dx = local[i].x - local[j].x, dy = local[i].y - local[j].y;
          const d2 = Math.max(50, dx * dx + dy * dy), f = 1100 / d2;
          forces[i].x += dx * f; forces[i].y += dy * f; forces[j].x -= dx * f; forces[j].y -= dy * f;
        }
        for (const e of pairs) {
          const a = lookup.get(e.source), b = lookup.get(e.target), dx = b.x - a.x, dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 1, f = (distance - 75) * .018;
          a.x += dx / distance * f; a.y += dy / distance * f; b.x -= dx / distance * f; b.y -= dy / distance * f;
        }
        const cooling = 1 - step / 130;
        local.forEach((n, i) => { n.x += Math.max(-12, Math.min(12, forces[i].x - n.x * .012)) * cooling; n.y += Math.max(-12, Math.min(12, forces[i].y - n.y * .012)) * cooling; });
      }
      const xs = local.map(n => n.x), ys = local.map(n => n.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const scale = (size - 60) / Math.max(1, maxX - minX, maxY - minY);
      for (const n of local) positions.set(n.id, { x: cursorX + 30 + (n.x - minX) * scale, y: cursorY + 30 + (n.y - minY) * scale });
      cursorX += size + 50; rowHeight = Math.max(rowHeight, size);
    }
  }
  function applyTransform() { $('viewport').setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.k})`); }
  function fit() {
    const p = [...positions.values()];
    if (!p.length) { transform = { x: 0, y: 0, k: 1 }; return; }
    const xs = p.map(v => v.x), ys = p.map(v => v.y), minX = Math.min(...xs) - 60, minY = Math.min(...ys) - 40;
    const width = Math.max(...xs) - minX + 130, height = Math.max(...ys) - minY + 100;
    const k = Math.min(2, 1020 / width, 700 / height);
    transform = { k, x: (1100 - width * k) / 2 - minX * k, y: (760 - height * k) / 2 - minY * k };
  }
  function svg(tag, attributes) { const el = document.createElementNS(ns, tag); for (const [key, val] of Object.entries(attributes)) el.setAttribute(key, val); return el; }
  function draw() {
    const root = $('viewport'); root.replaceChildren();
    const { incoming } = rank(currentEdges);
    const neighbors = new Set([selected, ...currentEdges.filter(e => e.source === selected || e.target === selected).flatMap(e => [e.source, e.target])]);
    for (const e of currentEdges) {
      const a = positions.get(e.source), b = positions.get(e.target);
      const dim = $('focus').checked && selected && (!neighbors.has(e.source) || !neighbors.has(e.target));
      const distance = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const bend = isLocal() ? 45 : e.kind === 'reference' ? 0 : 10;
      const controlX = (a.x + b.x) / 2 - (b.y - a.y) / distance * bend;
      const controlY = (a.y + b.y) / 2 + (b.x - a.x) / distance * bend;
      const edge = svg('path', { d: `M${a.x},${a.y} Q${controlX},${controlY} ${b.x},${b.y}`,  class: `edge ${e.kind === 'reference' ? 'reference' : e.status === 'success' ? '' : 'structural'} ${dim ? 'dim' : ''}`, 'marker-end': 'url(#arrow)' });
      const title = svg('title', {}); title.textContent = `${nodes.get(e.source).title} → ${nodes.get(e.target).title}\n${names[e.kind]} × ${e.count} (${e.status})`; edge.append(title); root.append(edge);
    }
    const labelTop = new Set([...currentNodes].sort((a, b) => (incoming.get(b.id)?.size || 0) - (incoming.get(a.id)?.size || 0)).slice(0, 14).map(n => n.id));
    for (const n of currentNodes) {
      const p = positions.get(n.id), radius = 4 + Math.min(14, Math.sqrt(incoming.get(n.id)?.size || 0) * 2);
      const group = svg('g', { class: `node ${n.missing ? 'missing' : ''} ${n.id === selected ? 'selected' : ''} ${$('focus').checked && selected && !neighbors.has(n.id) ? 'dim' : ''}`, transform: `translate(${p.x} ${p.y})` });
      group.append(svg('circle', { r: radius }));
      const title = svg('title', {}); title.textContent = `${n.title}\n${n.id}`; group.append(title);
      if (currentNodes.length < 45 || labelTop.has(n.id) || n.id === selected) {
        if (isLocal()) {
          const label = svg('text', { x: 0, y: radius + 20, 'text-anchor': 'middle' });
          const chars = Array.from(n.title);
          for (let line = 0; line < Math.min(3, Math.ceil(chars.length / 16)); line++) {
            const span = svg('tspan', { x: 0, dy: line ? 17 : 0 });
            span.textContent = chars.slice(line * 16, (line + 1) * 16).join('') + (line === 2 && chars.length > 48 ? '…' : ''); label.append(span);
          }
          group.append(label);
        } else {
          const label = svg('text', { x: radius + 5, y: 4 }); label.textContent = n.title.length > 18 ? n.title.slice(0, 18) + '…' : n.title; group.append(label);
        }
      }
      group.addEventListener('click', () => choose(n.id)); root.append(group);
    }
    if (!currentNodes.length) { const empty = svg('text', { x: 550, y: 380, 'text-anchor': 'middle', fill: 'var(--muted)' }); empty.textContent = '此范围没有匹配关系。可更换关系类型，或显示无关联对话。'; root.append(empty); }
    applyTransform();
  }
  function renderList() {
    const query = $('search').value.trim().toLowerCase(), r = rank(eligible());
    const pool = query ? data.nodes.filter(n => $('level').value !== 'thread' || (n.threadId && !n.missing)) : currentNodes;
    const list = pool.filter(n => !query || [n.title, n.id, ...n.sessions].some(s => s.toLowerCase().includes(query)))
      .sort((a, b) => (r.incoming.get(b.id)?.size || 0) - (r.incoming.get(a.id)?.size || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    $('listNote').textContent = `${list.length} 个匹配 · 按被引用的${unit()}数排序${list.length > 160 ? ' · 先列前 160，可搜索其余' : ''}`;
    $('list').replaceChildren();
    for (const n of list.slice(0, 160)) {
      const button = document.createElement('button'); button.className = `item ${selected === n.id ? 'active' : ''}`;
      button.textContent = n.title;
      const small = document.createElement('small'); small.textContent = `${n.threadId ? 'Thread' : '未归属 Session'} · 被 ${r.incoming.get(n.id)?.size || 0} 个${unit()}引用 · 含 ${n.sessions.length} 个 Session`;
      button.append(small); button.onclick = () => choose(n.id); $('list').append(button);
    }
  }
  function para(parent, tag, content, cls = '') { const el = document.createElement(tag); el.textContent = content; el.className = cls; parent.append(el); return el; }
  function renderDetails() {
    const root = $('detail'); root.replaceChildren();
    $('clear').disabled = !selected;
    if (!selected) {
      $('detailTitle').textContent = '自由浏览 · 未选中节点';
      para(root, 'p', $('level').value === 'thread' ? '每个圆点是一条 Thread。它包含的所有 Session 已折叠，箭头汇总整个线程曾建立的引用。' : '此视图额外包含未归属 Thread 的 Session 和待解析目标；它们不会冒充线程。');
      para(root, 'h3', '先看关系，再看证据');
      para(root, 'p', '用顶部「关联群」直接打开一组线程，无需先选择节点。选中节点只打开详情，不改变当前范围或淡化其他线程。');
      para(root, 'p', '再次点击同一节点、点击画布空白、按 Esc 或点击「取消选择」，都能恢复无选中状态；当前关联群和缩放保持不变。');
      para(root, 'h3', '当前范围');
      para(root, 'p', `${currentNodes.length} 个${unit()} · ${currentEdges.length} 条关系。${projection.excludedEdges ? `另有 ${projection.excludedEdges} 条关系的两端不能同时确认 Thread 归属，可切换「含未归属会话」查看。` : ''}`);
      para(root, 'p', '全局缩略图用于看分布，局部关联群用于读完整标题；具体哪次引用仍可在关系详情中展开。'); return;
    }
    const n = nodes.get(selected); $('detailTitle').textContent = n.title;
    para(root, 'code', n.id);
    para(root, 'p', `${n.agentId} · ${n.sessions.length} 个会话快照${n.missing ? ' · 本机目标未解析' : ''}${n.archived ? ' · 已归档' : ''}`);
    const button = para(root, 'button', '以此线程展开关联群'); button.onclick = () => { anchor = selected; $('scope').value = 'component'; rebuild(); };
    for (const [direction, label] of [['out', '它引用的背景'], ['in', '引用它的线程 / 节点']]) {
      const relations = eligible().filter(e => direction === 'out' ? e.source === selected : e.target === selected);
      para(root, 'h3', `${label} · ${relations.length} 类关系`);
      for (const e of relations.sort((a, b) => b.count - a.count)) {
        const other = nodes.get(direction === 'out' ? e.target : e.source);
        const row = document.createElement('div'); row.className = 'relation'; root.append(row);
        const link = para(row, 'button', other.title); link.onclick = () => choose(other.id);
        para(row, 'p', `${names[e.kind]} × ${e.count} · ${e.status === 'success' ? '已返回内容' : e.status === 'failed' ? '读取失败' : e.status === 'unknown' ? '结果未知' : e.status === 'declared' ? '用户显式提供' : '索引事实'}`);
        if (e.eventIds.length) {
          const details = document.createElement('details'); row.append(details); para(details, 'summary', '证据定位');
          for (const id of e.eventIds) {
            const event = events.get(id), source = sessions.get(event.source);
            const target = sessions.get(JSON.stringify([event.targetAgent, event.targetId]));
            const evidence = document.createElement('div'); evidence.className = 'evidence'; details.append(evidence);
            para(evidence, 'strong', `引用位置：${source?.title || '来源会话'}`);
            para(evidence, 'p', `${source?.createdAt || '创建时间未知'}（会话创建时间，非引用时间）`);
            para(evidence, 'code', `${source?.sessionId || event.source} · T${event.turn ?? '?'} · messages[${event.messageIndex}]`);
            para(evidence, 'p', `→ 当时引用的快照：${target?.title || event.titleHint || event.targetId}`);
            para(evidence, 'code', `${event.targetAgent || ''} / ${event.targetId}${event.targetTurn !== null && event.targetTurn !== undefined ? ` · T${event.targetTurn}` : ''}`);
            para(evidence, 'p', `${event.evidence} · 在 ${event.observedIn.length} 个快照中观察到，合并为一次${event.callId ? '\n' + event.callId : ''}`);
          }
        }
      }
    }
    const internal = data.events.filter(e => e.sourceConversation === selected && e.targetConversation === selected);
    if (internal.length) para(root, 'p', `另有 ${internal.length} 条对话内部引用 / 读取，不画为对外协作边。`);
    const history = document.createElement('details'); root.append(history); para(history, 'summary', `会话快照 · ${n.sessions.length}`);
    for (const key of n.sessions) { const s = sessions.get(key); para(history, 'p', `${s.createdAt}\n${s.title}`); para(history, 'code', s.sessionId); }
  }
  $('level').onchange = updateProjection; $('kind').onchange = updateProjection; $('isolated').onchange = updateProjection;
  $('scope').onchange = () => {
    if ($('scope').value !== 'global') {
      if (selected) anchor = selected;
      else if (!anchor) { $('scope').value = 'global'; return; }
    }
    rebuild();
  };
  $('cluster').onchange = () => { anchor = null; selected = null; $('scope').value = 'global'; rebuild(); };
  $('clear').onclick = clearSelection;
  $('focus').onchange = draw;
  document.addEventListener('keydown', event => { if (event.key === 'Escape') clearSelection(); });
  $('search').oninput = renderList;
  $('reset').onclick = () => { fit(); applyTransform(); };
  $('theme').onclick = () => document.body.classList.toggle('light');
  const point = event => { const p = $('graph').createSVGPoint(); p.x = event.clientX; p.y = event.clientY; return p.matrixTransform($('graph').getScreenCTM().inverse()); };
  $('graph').addEventListener('wheel', event => {
    event.preventDefault(); const p = point(event), k = Math.max(.05, Math.min(12, transform.k * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    transform.x = p.x - (p.x - transform.x) * k / transform.k; transform.y = p.y - (p.y - transform.y) * k / transform.k; transform.k = k; applyTransform();
  }, { passive: false });
  $('graph').addEventListener('pointerdown', event => {
    if (event.target.closest('.node') || event.button !== 0) return;
    drag = { point: point(event), startX: event.clientX, startY: event.clientY, moved: false };
    $('graph').setPointerCapture(event.pointerId);
  });
  $('graph').addEventListener('pointermove', event => {
    if (!drag) return;
    const p = point(event);
    drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    transform.x += p.x - drag.point.x; transform.y += p.y - drag.point.y; drag.point = p; applyTransform();
  });
  $('graph').addEventListener('pointerup', () => { const clear = drag && !drag.moved; drag = null; if (clear) clearSelection(); });
  $('graph').addEventListener('pointercancel', () => { drag = null; });
  $('export').onclick = () => {
    const clone = $('graph').cloneNode(true);
    const originals = [$('graph'), ...$('graph').querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((el, i) => { const c = getComputedStyle(el); for (const prop of ['fill', 'stroke', 'stroke-width', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'paint-order']) copies[i].style.setProperty(prop, c.getPropertyValue(prop)); });
    clone.setAttribute('xmlns', ns); clone.style.background = getComputedStyle(document.body).backgroundColor;
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    const a = document.createElement('a'); a.href = url; a.download = 'session-topology.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  updateProjection();
}
