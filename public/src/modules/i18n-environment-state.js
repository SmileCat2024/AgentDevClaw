const state = {
  currentTheme: undefined,
  currentLanguage: undefined,
};

window.KernelState.claim('i18n-environment', {
  get: (key) => state[key],
  set: (key, value) => { state[key] = value; },
});

export function getCurrentTheme() {
  return state.currentTheme;
}

export function setCurrentTheme(value) {
  state.currentTheme = value;
}

export function getCurrentLanguage() {
  return state.currentLanguage;
}

export function setCurrentLanguage(value) {
  state.currentLanguage = value;
}
