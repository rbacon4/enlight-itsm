// Light / dark / system theme handling. The preference is per-device (localStorage),
// applied by setting <html data-theme="light|dark">. CSS in index.css supplies the
// palette for each. "system" follows the OS and updates live.

export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'enlight_theme';
const prefersLight = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;

export function getThemePref(): ThemePref {
  const v = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) as ThemePref | null;
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/** Resolves a preference to the concrete theme to render. */
export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') return prefersLight() ? 'light' : 'dark';
  return pref;
}

/** Writes the resolved theme to <html data-theme>. */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
}

export function setThemePref(pref: ThemePref): void {
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* ignore */ }
  applyTheme(pref);
}

/** Apply the saved preference and keep "system" in sync with OS changes. */
export function initTheme(): void {
  applyTheme(getThemePref());
  if (typeof window === 'undefined') return;
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}
