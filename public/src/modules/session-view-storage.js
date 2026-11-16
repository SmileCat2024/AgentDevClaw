/**
 * ESM owner for the session-view compatibility storage keys.
 *
 * app-core registers the original values before deferred modules run. Claiming
 * this domain absorbs those exact values; it deliberately does not initialize,
 * normalize, or clone them. The window accessors remain the compatibility
 * surface for classic readers and writers until their consumers migrate.
 */
let currentMessages;
let currentInputRequests;
let toolRenderConfigs;
let TOOL_NAMES;
let currentHookInspector;
let currentHookInspectorSignature;
let currentOverviewSnapshot;
let currentOverviewSignature;
let currentTodoPlan;
let currentTodoPlanSignature;

window.KernelState.claim('session-view-storage', {
  get(key) {
    switch (key) {
      case 'currentMessages': return currentMessages;
      case 'currentInputRequests': return currentInputRequests;
      case 'toolRenderConfigs': return toolRenderConfigs;
      case 'TOOL_NAMES': return TOOL_NAMES;
      case 'currentHookInspector': return currentHookInspector;
      case 'currentHookInspectorSignature': return currentHookInspectorSignature;
      case 'currentOverviewSnapshot': return currentOverviewSnapshot;
      case 'currentOverviewSignature': return currentOverviewSignature;
      case 'currentTodoPlan': return currentTodoPlan;
      case 'currentTodoPlanSignature': return currentTodoPlanSignature;
    }
  },
  set(key, value) {
    switch (key) {
      case 'currentMessages': currentMessages = value; break;
      case 'currentInputRequests': currentInputRequests = value; break;
      case 'toolRenderConfigs': toolRenderConfigs = value; break;
      case 'TOOL_NAMES': TOOL_NAMES = value; break;
      case 'currentHookInspector': currentHookInspector = value; break;
      case 'currentHookInspectorSignature': currentHookInspectorSignature = value; break;
      case 'currentOverviewSnapshot': currentOverviewSnapshot = value; break;
      case 'currentOverviewSignature': currentOverviewSignature = value; break;
      case 'currentTodoPlan': currentTodoPlan = value; break;
      case 'currentTodoPlanSignature': currentTodoPlanSignature = value; break;
    }
  },
});

export {
  currentMessages,
  currentInputRequests,
  toolRenderConfigs,
  TOOL_NAMES,
  currentHookInspector,
  currentHookInspectorSignature,
  currentOverviewSnapshot,
  currentOverviewSignature,
  currentTodoPlan,
  currentTodoPlanSignature,
};

export const setCurrentMessages = (value) => { currentMessages = value; };
export const setCurrentInputRequests = (value) => { currentInputRequests = value; };
export const setToolRenderConfigs = (value) => { toolRenderConfigs = value; };
export const setToolNames = (value) => { TOOL_NAMES = value; };
export const setCurrentHookInspector = (value) => { currentHookInspector = value; };
export const setCurrentHookInspectorSignature = (value) => { currentHookInspectorSignature = value; };
export const setCurrentOverviewSnapshot = (value) => { currentOverviewSnapshot = value; };
export const setCurrentOverviewSignature = (value) => { currentOverviewSignature = value; };
export const setCurrentTodoPlan = (value) => { currentTodoPlan = value; };
export const setCurrentTodoPlanSignature = (value) => { currentTodoPlanSignature = value; };
