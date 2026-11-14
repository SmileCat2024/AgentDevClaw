/** Pure projection shared by the offline viewer and tests. Session evidence stays untouched. */
export function projectTopology(data, { level = 'thread', kind = 'reference', isolated = false } = {}) {
  const isThread = n => Boolean(n.threadId) && !n.missing;
  const nodes = data.nodes.filter(n => level !== 'thread' || isThread(n));
  const allowed = new Set(nodes.map(n => n.id));
  const matches = e => e.source !== e.target && (kind === 'all' || (kind === 'reference' ? e.kind === 'reference' : kind === 'read' ? e.status === 'success' : e.kind === 'reference' || e.status === 'success'));
  const candidates = data.edges.filter(matches);
  const edges = candidates.filter(e => allowed.has(e.source) && allowed.has(e.target));
  const active = new Set(edges.flatMap(e => [e.source, e.target]));
  const visible = nodes.filter(n => isolated || active.has(n.id));
  const neighbors = new Map(visible.map(n => [n.id, new Set()]));
  for (const e of edges) { neighbors.get(e.source).add(e.target); neighbors.get(e.target).add(e.source); }
  const seen = new Set(), components = [];
  for (const n of visible) {
    if (seen.has(n.id)) continue;
    const group = [], queue = [n.id]; seen.add(n.id);
    while (queue.length) {
      const id = queue.pop(); group.push(id);
      for (const next of neighbors.get(id)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    components.push(group);
  }
  components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  return { nodes: visible, edges, components, excludedEdges: candidates.length - edges.length };
}

/** Inspection and scope are independent: clearing selection preserves the current map. */
export function selectTopologyNode(current, id) {
  return current === id ? null : id;
}
