// Theme service: resolves the user preference (system / light / dark) into the
// `data-theme` attribute consumed by theme.css, keeps the Electron main process
// in sync (nativeTheme → native chrome, dialogs, scrollbars), and exposes a
// change event so canvas-based views (three.js, uPlot) can repaint.

export const THEME_STORAGE_KEY = 'wj.theme-preference';
export const THEME_CHANGE_EVENT = 'wj:themechange';

const PREFERENCES = ['system', 'light', 'dark'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DARK_QUERY) : null;

let preference = 'system';
let resolved = 'light';
let initialized = false;

function readStoredPreference() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return PREFERENCES.includes(stored) ? stored : 'system';
  } catch (e) {
    return 'system';
  }
}

function systemPrefersDark() {
  return !!media && media.matches;
}

function resolve(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark() ? 'dark' : 'light';
}

function applyToDocument(theme, pref) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePref = pref;
  // Keep the native form-control/scrollbar rendering in the same mode.
  root.style.colorScheme = theme;
}

function notifyMain(pref) {
  const api = window.electronAPI;
  if (!api || typeof api.setThemeSource !== 'function') return;
  api.setThemeSource(pref).catch((error) => {
    console.warn('[theme] setThemeSource failed:', error && error.message ? error.message : error);
  });
}

function emitChange() {
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
    detail: { theme: resolved, preference },
  }));
}

function apply(pref, { persist = false, announce = true } = {}) {
  preference = PREFERENCES.includes(pref) ? pref : 'system';
  resolved = resolve(preference);
  applyToDocument(resolved, preference);
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch (e) {
      /* storage may be unavailable; the preference then lasts for this session */
    }
  }
  notifyMain(preference);
  if (announce) emitChange();
}

export function initTheme() {
  if (initialized) return resolved;
  initialized = true;
  // index.html already applied the same value before first paint; re-apply so
  // the runtime state and the DOM agree even if that inline script was skipped.
  apply(readStoredPreference(), { persist: false, announce: false });
  if (media) {
    const onSystemChange = () => {
      if (preference !== 'system') return;
      apply('system', { persist: false });
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
    else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
  }
  return resolved;
}

export function getThemePreference() {
  return preference;
}

export function getResolvedTheme() {
  return resolved;
}

export function setThemePreference(pref) {
  apply(pref, { persist: true });
  return resolved;
}

const CYCLE = { system: 'light', light: 'dark', dark: 'system' };

export function cycleThemePreference() {
  return setThemePreference(CYCLE[preference] || 'system');
}

export function onThemeChange(handler) {
  const listener = (event) => handler(event.detail);
  window.addEventListener(THEME_CHANGE_EVENT, listener);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, listener);
}

const ICONS = {
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
};

const LABELS = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

function renderToggle(button) {
  button.innerHTML = ICONS[preference] || ICONS.system;
  button.dataset.pref = preference;
  button.title = `主题：${LABELS[preference]}（点击切换）`;
  button.setAttribute('aria-label', `主题：${LABELS[preference]}，点击切换为${LABELS[CYCLE[preference]]}`);
}

export function mountThemeToggle(button) {
  if (!button) return () => {};
  button.classList.add('theme-toggle');
  renderToggle(button);
  button.addEventListener('click', () => {
    cycleThemePreference();
  });
  const unsubscribe = onThemeChange(() => renderToggle(button));
  return unsubscribe;
}
