const state = {
  featurePanelWidth: undefined,
};

window.KernelState.claim('panel-layout-state', {
  get: (key) => state[key],
  set: (key, value) => { state[key] = value; },
});

export function getFeaturePanelWidth() {
  return state.featurePanelWidth;
}

export function setFeaturePanelWidth(value) {
  state.featurePanelWidth = value;
}
