// UI effects run only after the session transaction has accepted its data.
export function createCommittedViewRenderer(host) {
  function renderMessages({ previous, current }) {
    const previousMessages = previous.messages;
    const nextMessages = current.messages;
    if (nextMessages.length > 0) host.clearLoading();
    host.markTitle(previousMessages, nextMessages);
    const firstChangedIndex = host.firstChanged(nextMessages, previousMessages);
    if (nextMessages.length !== previousMessages.length) {
      if (nextMessages.length > previousMessages.length && firstChangedIndex === previousMessages.length) {
        if (host.workspaceSurface()) host.render(current);
        else host.append(nextMessages.slice(previousMessages.length), previousMessages.length);
      } else host.render(current);
    } else if (firstChangedIndex >= 0) {
      if (host.workspaceSurface() || firstChangedIndex < nextMessages.length - 1) host.render(current);
      else host.updateLast(nextMessages[nextMessages.length - 1]);
    }
    // Reconcile optimistic echoes only after the accepted transcript is visible.
    host.reconcile(nextMessages);
  }

  function renderMetadata({ token, current, overviewChanged, todoChanged,
    inputChanged, inputRequests, interruptCleared, interruptSynced }) {
    if (overviewChanged) {
      if (host.panel() === 'workspace') host.renderPanel();
      host.updateContext(current);
      host.updateModel();
      host.updateThinking();
    }
    if (todoChanged) {
      if (host.panel() === 'plan') host.renderPanel();
      host.updatePlanBadge();
    } else if ((interruptCleared || interruptSynced) && host.panel() === 'plan') {
      host.renderPanel();
    }
    host.clearCompletedCompact(token, inputRequests);
    // Patch hooks already notified input UI; do not emit a second notification.
    if (inputChanged) host.updateRollback();
    else if (host.chatSurface()) host.syncInput(token.runtimeId);
  }
  return { renderMessages, renderMetadata };
}
