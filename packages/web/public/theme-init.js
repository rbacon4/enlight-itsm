// Apply the saved theme before first paint to avoid a flash.
// Kept as an external (same-origin) file so the app can ship a strict
// Content-Security-Policy (script-src 'self') without 'unsafe-inline'.
(function () {
  try {
    var p = localStorage.getItem('enlight_theme') || 'system';
    var light = p === 'light' ||
      (p === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  } catch (e) { /* ignore */ }
})();
