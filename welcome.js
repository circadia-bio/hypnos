// Welcome screen, after NotedApp's onboarding: a blurred overlay with a card of
// steps, progress dots, Skip and Next. Shown on the first visit and remembered in
// localStorage. When WELCOME_VERSION changes, returning visitors see only the last
// step. The nav "About" link reopens it from the start.

const WELCOME_KEY = 'hypnos_welcomed';
const WELCOME_VERSION = '0.1.0';
const TOTAL = 4;

function readSeen() {
  try { return localStorage.getItem(WELCOME_KEY); } catch { return null; }
}

function writeSeen() {
  try { localStorage.setItem(WELCOME_KEY, WELCOME_VERSION); } catch { /* storage unavailable */ }
}

export function initWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  if (!overlay) return;
  const steps = [...overlay.querySelectorAll('.wl-step')];
  const dots = [...overlay.querySelectorAll('.wl-dot')];
  const next = document.getElementById('wl-next');
  const skip = document.getElementById('wl-skip');
  let step = 1;

  function show(n) {
    step = n;
    steps.forEach((el, i) => { el.hidden = i + 1 !== n; });
    dots.forEach((d, i) => d.classList.toggle('active', i + 1 === n));
    next.innerHTML = (n === TOTAL ? 'Get started' : 'Next') + ' <i class="bi bi-arrow-right"></i>';
  }

  function open(from = 1) {
    show(from);
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    next.focus();
  }

  function close() {
    overlay.classList.remove('open');
    writeSeen();
    setTimeout(() => { overlay.hidden = true; }, 300);
  }

  function advance() {
    if (step < TOTAL) show(step + 1);
    else close();
  }

  skip.addEventListener('click', close);
  next.addEventListener('click', advance);
  document.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') advance();
    else if (e.key === 'ArrowLeft' && step > 1) show(step - 1);
  });

  document.getElementById('open-welcome')?.addEventListener('click', (e) => {
    e.preventDefault();
    open(1);
  });

  const seen = readSeen();
  if (!seen) open(1);
  else if (seen !== WELCOME_VERSION) open(TOTAL);     // updated since last visit: last step only
}
