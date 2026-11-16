// Eligibility is evaluated at commit time, not when a request starts. The host
// reads live identity/revisions; no copied view or second store is retained here.
export function createSessionViewCommit(host) {
  function isSessionViewMessagesCurrent(token) {
    return token?.messagesRevision === host.messagesRevision();
  }

  function isSessionViewInputRequestsCurrent(token) {
    return token?.inputRequestsRevision === host.inputRequestsRevision();
  }

  function isSessionViewTokenCurrent(token) {
    if (!token || host.switchEpoch() !== token.switchEpoch) return false;
    if (token.generation !== host.generation()) return false;
    const currentIdentity = host.identity();
    if (token.identity) {
      return !!currentIdentity
        && currentIdentity.agentId === token.identity.agentId
        && currentIdentity.sessionId === token.identity.sessionId
        && (token.runtimeId === '' || host.runtimeId() === token.runtimeId);
    }
    return token.runtimeId !== '' && host.runtimeId() === token.runtimeId;
  }

  function commitSessionViewState(token, apply) {
    if (typeof apply !== 'function') {
      throw new TypeError('commitSessionViewState requires a synchronous apply function');
    }
    if (!isSessionViewTokenCurrent(token)) return false;
    apply();
    return true;
  }

  // A successful transaction can discard stale fields while accepting others:
  // newer input leases and model revisions must survive an older response.
  function commitSessionViewPatch(token, patch, afterCommit) {
    if (afterCommit !== undefined && typeof afterCommit !== 'function') {
      throw new TypeError('session view afterCommit must be a function');
    }
    return commitSessionViewState(token, () => {
      const previous = host.read();
      if (Object.prototype.hasOwnProperty.call(patch, 'inputRequests')
        && !isSessionViewInputRequestsCurrent(token)) {
        patch = { ...patch };
        delete patch.inputRequests;
      }
      const hasModel = Object.prototype.hasOwnProperty.call(patch, 'model');
      const hasOverview = Object.prototype.hasOwnProperty.call(patch, 'overview');
      if ((hasModel || hasOverview) && host.modelRuntimeId() === previous.runtimeId) {
        const incoming = host.normalizeModel(hasModel ? patch.model : patch.overview);
        const current = host.normalizeModel(previous.overview);
        if (current.modelRevision !== null
          && (incoming.modelRevision === null || incoming.modelRevision < current.modelRevision)) {
          patch = { ...patch, model: current };
        }
      }
      host.apply(patch);
      if (afterCommit) afterCommit({ previous, current: host.read() });
    });
  }

  return { isSessionViewMessagesCurrent, isSessionViewInputRequestsCurrent,
    isSessionViewTokenCurrent, commitSessionViewState, commitSessionViewPatch };
}
