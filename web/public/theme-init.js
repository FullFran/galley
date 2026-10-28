// Applies the stored theme before the first paint, so a reload never flashes
// the other theme. Loaded as an external file because the CSP allows
// `script-src 'self'` only. Mirrors readTheme/applyTheme in src/shell/theme.ts.
try {
  var galleyTheme = localStorage.getItem('galley:theme');
  if (galleyTheme === 'light' || galleyTheme === 'dark') document.documentElement.dataset.theme = galleyTheme;
} catch {
  // Blocked storage: follow the system theme.
}
