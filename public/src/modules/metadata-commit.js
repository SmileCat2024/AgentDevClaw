// Poll and SSE publish metadata as one transaction; unchanged input events
// still advance the observation revision so an old lease cannot reappear.
export function createMetadataCommit(host) {
  function commitMetadataUpdate(token, { todoRaw, overviewJson, inputRequestsRaw } = {}) {
    const hasTodo = todoRaw !== undefined;
    const hasOverview = overviewJson !== undefined;
    const hasInput = inputRequestsRaw !== undefined && host.inputCurrent(token);
    const overview = hasOverview ? host.normalizeOverview(overviewJson) : null;
    const overviewSignature = hasOverview ? host.overviewSignature(overview) : null;
    const todo = hasTodo ? (todoRaw === null ? null : host.normalizeTodo(todoRaw)) : null;
    const todoSignature = todo === null ? null : host.todoSignature(todo);
    const input = hasInput ? (Array.isArray(inputRequestsRaw) ? inputRequestsRaw : []) : null;
    const overviewChanged = hasOverview && overviewSignature !== host.currentOverviewSignature();
    const todoChanged = todo !== null && todoSignature !== host.currentTodoSignature();
    const inputChanged = input !== null && JSON.stringify(input) !== JSON.stringify(host.inputRequests() || []);
    const patch = {};
    if (overviewChanged) patch.overview = overview;
    if (todoChanged) patch.todoPlan = todo;
    if (hasInput) patch.inputRequests = input;
    return host.commit(token, patch, ({ current }) => {
      let interruptCleared = false;
      let interruptSynced = false;
      if (todo !== null) {
        const targetId = host.interruptTarget();
        if (targetId) {
          const target = todo.tasks.find(task => task.id === targetId);
          if (target && (target.status === 'completed' || target.status === 'deleted')) {
            host.setInterruptTarget(null);
            interruptCleared = true;
          }
        }
        if ((host.now() - host.lastInterruptAction()) > 3000) {
          const serverTarget = todo.interruptTargetId || null;
          if (serverTarget !== targetId) {
            host.setInterruptTarget(serverTarget);
            interruptSynced = true;
          }
        }
      }
      host.render({ token, current, overviewChanged, todoChanged, inputChanged,
        inputRequests: input, interruptCleared, interruptSynced });
    });
  }
  return { commitMetadataUpdate };
}
