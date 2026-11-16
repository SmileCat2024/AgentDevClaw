// ESM owner for render-entry mutable slots. Render functions and their
// initialization stay in classic files; this module only claims storage.
export let activeFeaturePanel;
export let currentWorkspaceTab;
export let shouldAnimateWorkspaceSurface;
export let lastRenderedWorkspaceHtml;
export let lastRenderedWorkspaceScrollKey;
export let workspaceSurfaceScrollSaveRaf;
export let _lastRenderedChatSig;
export let currentWorkspaceArtifactDetail;
export let currentWorkspaceDocsetDetail;
export let currentProjectDocsetOpen;
export let currentProjectRequirementEdit;
export let currentProjectDocsetPage;
export let unitModePreferences;

window.KernelState.claim('render-entry', {
  get(key) {
    switch (key) {
      case 'activeFeaturePanel': return activeFeaturePanel;
      case 'currentWorkspaceTab': return currentWorkspaceTab;
      case 'shouldAnimateWorkspaceSurface': return shouldAnimateWorkspaceSurface;
      case 'lastRenderedWorkspaceHtml': return lastRenderedWorkspaceHtml;
      case 'lastRenderedWorkspaceScrollKey': return lastRenderedWorkspaceScrollKey;
      case 'workspaceSurfaceScrollSaveRaf': return workspaceSurfaceScrollSaveRaf;
      case '_lastRenderedChatSig': return _lastRenderedChatSig;
      case 'currentWorkspaceArtifactDetail': return currentWorkspaceArtifactDetail;
      case 'currentWorkspaceDocsetDetail': return currentWorkspaceDocsetDetail;
      case 'currentProjectDocsetOpen': return currentProjectDocsetOpen;
      case 'currentProjectRequirementEdit': return currentProjectRequirementEdit;
      case 'currentProjectDocsetPage': return currentProjectDocsetPage;
      case 'unitModePreferences': return unitModePreferences;
    }
  },
  set(key, value) {
    switch (key) {
      case 'activeFeaturePanel': activeFeaturePanel = value; break;
      case 'currentWorkspaceTab': currentWorkspaceTab = value; break;
      case 'shouldAnimateWorkspaceSurface': shouldAnimateWorkspaceSurface = value; break;
      case 'lastRenderedWorkspaceHtml': lastRenderedWorkspaceHtml = value; break;
      case 'lastRenderedWorkspaceScrollKey': lastRenderedWorkspaceScrollKey = value; break;
      case 'workspaceSurfaceScrollSaveRaf': workspaceSurfaceScrollSaveRaf = value; break;
      case '_lastRenderedChatSig': _lastRenderedChatSig = value; break;
      case 'currentWorkspaceArtifactDetail': currentWorkspaceArtifactDetail = value; break;
      case 'currentWorkspaceDocsetDetail': currentWorkspaceDocsetDetail = value; break;
      case 'currentProjectDocsetOpen': currentProjectDocsetOpen = value; break;
      case 'currentProjectRequirementEdit': currentProjectRequirementEdit = value; break;
      case 'currentProjectDocsetPage': currentProjectDocsetPage = value; break;
      case 'unitModePreferences': unitModePreferences = value; break;
    }
  },
});

export const setActiveFeaturePanel = (value) => { activeFeaturePanel = value; };
export const setCurrentWorkspaceTab = (value) => { currentWorkspaceTab = value; };
export const setShouldAnimateWorkspaceSurface = (value) => { shouldAnimateWorkspaceSurface = value; };
export const setLastRenderedWorkspaceHtml = (value) => { lastRenderedWorkspaceHtml = value; };
export const setLastRenderedWorkspaceScrollKey = (value) => { lastRenderedWorkspaceScrollKey = value; };
export const setWorkspaceSurfaceScrollSaveRaf = (value) => { workspaceSurfaceScrollSaveRaf = value; };
export const setLastRenderedChatSig = (value) => { _lastRenderedChatSig = value; };
export const setCurrentWorkspaceArtifactDetail = (value) => { currentWorkspaceArtifactDetail = value; };
export const setCurrentWorkspaceDocsetDetail = (value) => { currentWorkspaceDocsetDetail = value; };
export const setCurrentProjectDocsetOpen = (value) => { currentProjectDocsetOpen = value; };
export const setCurrentProjectRequirementEdit = (value) => { currentProjectRequirementEdit = value; };
export const setCurrentProjectDocsetPage = (value) => { currentProjectDocsetPage = value; };
export const setUnitModePreferences = (value) => { unitModePreferences = value; };
