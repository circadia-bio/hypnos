// Light and dark theme. Follows the system setting until the visitor uses the toggle in the
// navbar, then remembers that choice (as the main site's Quarto toggle does). The choice is
// applied as data-theme on <html>; index.html applies a saved choice before the first paint.

const KEY = 'hypnos_theme';

export function initTheme(onChange = () => {}) {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  const saved = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch { return null; }
  };
  const save = (v) => {
    try { localStorage.setItem(KEY, v); } catch { /* storage unavailable: the choice lasts for this visit */ }
  };
  const current = () => root.dataset.theme ?? (system.matches ? 'dark' : 'light');

  // Toggle icon: off in light mode, on in dark mode
  function paint() {
    if (!btn) return;
    const dark = current() === 'dark';
    btn.querySelector('i').className = `bi ${dark ? 'bi-toggle-on' : 'bi-toggle-off'}`;
    btn.setAttribute('aria-pressed', String(dark));
  }

  const choice = saved();
  if (choice) root.dataset.theme = choice;
  paint();

  btn?.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    save(next);
    paint();
    onChange();
  });

  // Until the visitor has chosen, a change of the system setting is followed
  system.addEventListener('change', () => {
    if (root.dataset.theme) return;
    paint();
    onChange();
  });
}
