// Light/dark toggle. Dark is the default; the choice is kept in localStorage and applied by a tiny
// inline script in <head> before paint. This wires the button and keeps the browser chrome colour in step.
(function () {
  const root = document.documentElement;
  const current = () => root.getAttribute('data-theme') || 'dark';
  const buttons = document.querySelectorAll('.utility .theme');
  function apply(t) {
    root.setAttribute('data-theme', t);
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', t === 'dark' ? '#0e0e0e' : '#ffffff'));
    label();
    document.dispatchEvent(new Event('themechange'));
  }
  function label() {
    const next = current() === 'dark' ? 'light' : 'dark';
    buttons.forEach(b => { b.setAttribute('aria-label', 'Switch to ' + next + ' mode'); b.title = next[0].toUpperCase() + next.slice(1) + ' mode'; });
  }
  buttons.forEach(b => b.addEventListener('click', () => {
    const t = current() === 'dark' ? 'light' : 'dark';
    apply(t);
    try { localStorage.setItem('theme', t); } catch (e) { /* private mode: the choice just lasts this page */ }
  }));
  if (root.getAttribute('data-theme')) apply(root.getAttribute('data-theme')); else label();
})();

// The bar: on the home page it only appears once the intro text has scrolled away
(function () {
  const mark = document.querySelector('.bar.away'), blurb = document.querySelector('.blurb');
  if (!mark) return;
  if (!blurb || !('IntersectionObserver' in window)) { mark.classList.remove('away'); return; }
  new IntersectionObserver(([e]) => mark.classList.toggle('away', e.isIntersecting), { threshold: 0 }).observe(blurb);
})();
