// ESM owner for session-view identity and revision slots. Classic session-view-state
// functions continue to access these keys through KernelState until migrated.
export let _sessionMeta;
export let _sessionViewIdentity;
export let _sessionViewGeneration;
export let _sessionViewInputRequestsRevision;
export let _sessionViewMessagesRevision;
export let _sessionViewModelRuntimeId;

window.KernelState.claim('session-view-identity-state', {
  get(key) {
    switch (key) {
      case '_sessionMeta': return _sessionMeta;
      case '_sessionViewIdentity': return _sessionViewIdentity;
      case '_sessionViewGeneration': return _sessionViewGeneration;
      case '_sessionViewInputRequestsRevision': return _sessionViewInputRequestsRevision;
      case '_sessionViewMessagesRevision': return _sessionViewMessagesRevision;
      case '_sessionViewModelRuntimeId': return _sessionViewModelRuntimeId;
    }
  },
  set(key, value) {
    switch (key) {
      case '_sessionMeta': _sessionMeta = value; break;
      case '_sessionViewIdentity': _sessionViewIdentity = value; break;
      case '_sessionViewGeneration': _sessionViewGeneration = value; break;
      case '_sessionViewInputRequestsRevision': _sessionViewInputRequestsRevision = value; break;
      case '_sessionViewMessagesRevision': _sessionViewMessagesRevision = value; break;
      case '_sessionViewModelRuntimeId': _sessionViewModelRuntimeId = value; break;
    }
  },
});

export const setSessionMeta = (value) => { _sessionMeta = value; };
export const setSessionViewIdentity = (value) => { _sessionViewIdentity = value; };
export const setSessionViewGeneration = (value) => { _sessionViewGeneration = value; };
export const setSessionViewInputRequestsRevision = (value) => { _sessionViewInputRequestsRevision = value; };
export const setSessionViewMessagesRevision = (value) => { _sessionViewMessagesRevision = value; };
export const setSessionViewModelRuntimeId = (value) => { _sessionViewModelRuntimeId = value; };
