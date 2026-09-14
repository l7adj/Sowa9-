import { hapticMedium, hapticSuccess, hapticError } from './components/haptic.js';
import { skeletonSheet } from './components/skeleton.js';

let _refreshFn = () => {};
let _logoutFn = () => {};
export function registerRefresh(fn) { _refreshFn = fn; }
export function registerLogout(fn) { _logoutFn = fn; }
export function refresh() { _refreshFn(); }
export function logout() { _logoutFn(); }

// Toast محسّن مع أنواع
export function toast(msg, ms = 2200, type = 'default') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;

  const colors = {
    success: 'var(--color-success, var(--success))',
    error: 'var(--color-danger, var(--danger))',
    warn: 'var(--color-warn, var(--warn))',
    info: 'var(--color-accent, var(--accent))',
    default: 'var(--primary)'
  };
  t.style.background = colors[type] || colors.default;
  document.body.appendChild(t);

  if (type === 'success') hapticSuccess();
  else if (type === 'error') hapticError();
  else hapticMedium();

  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => {
    t.classList.remove('on');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function attachRipple(el) {
  if (!el || el.dataset.ripple) return;
  el.dataset.ripple = '1';
  el.classList.add('has-ripple');
  el.addEventListener('pointerdown', e => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const r = document.createElement('span');
    r.className = 'ripple';
    r.style.width = r.style.height = size + 'px';
    r.style.left = (e.clientX - rect.left - size / 2) + 'px';
    r.style.top = (e.clientY - rect.top - size / 2) + 'px';
    el.appendChild(r);
    setTimeout(() => r.remove(), 600);
  });
}

// Sheet المحسّن — Memory Leak Fix + Haptic + Skeleton
const openSheets = [];

export function sheet({ title, subtitle, builder, onClose, skeleton = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  const sh = document.createElement('div');
  sh.className = 'sheet';
  bg.appendChild(sh);
  document.body.appendChild(bg);

  hapticMedium();

  requestAnimationFrame(() => {
    bg.classList.add('on');
    sh.classList.add('on');
  });

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  let closed = false;
  let startY = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false;

  const onMove = e => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    const y = t.clientY;
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = (y - lastY) / dt;
    lastY = y; lastT = now;
    const dy = Math.max(0, y - startY);
    const resistance = 1 / (1 + dy / 300); // Rubber Band
    sh.style.transform = `translateY(${dy * resistance}px)`;
    const progress = Math.min(1, dy / 400);
    bg.style.background = `rgba(11,18,32,${0.5 * (1 - progress)})`;
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    sh.classList.remove('dragging');
    const dy = lastY - startY;
    const shouldClose = dy > 100 || velocity > 0.5;
    if (shouldClose) {
      sh.style.transition = 'transform .25s var(--ease)';
      sh.style.transform = 'translateY(100%)';
      hapticMedium();
      setTimeout(close, 200);
    } else {
      sh.style.transition = 'transform .42s cubic-bezier(0.34, 1.56, 0.64, 1)';
      sh.style.transform = '';
      bg.style.background = '';
      setTimeout(() => { sh.style.transition = ''; }, 440);
    }
  };

  const onEsc = e => {
    if (e.key === 'Escape' && openSheets[openSheets.length - 1] === close) {
      close();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;

    // تنظيف كل المستمعين
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onEnd);
    document.removeEventListener('keydown', onEsc);

    const idx = openSheets.indexOf(close);
    if (idx >= 0) openSheets.splice(idx, 1);

    bg.classList.remove('on');
    sh.classList.remove('on');
    document.body.style.overflow = prevOverflow;
    hapticMedium();
    setTimeout(() => { bg.remove(); onClose && onClose(); }, 400);
  };

  sh.innerHTML = `
    <div class="sheet-h" data-grab>
      <div class="grab"></div>
      ${title ? `<h2>${title}</h2>` : ''}
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
    </div>
    <div class="sheet-b"></div>
  `;

  const body = sh.querySelector('.sheet-b');
  if (skeleton) {
    body.innerHTML = skeletonSheet();
    setTimeout(() => { if (!closed) builder(body, close, sh); }, 300);
  } else {
    builder(body, close, sh);
  }

  const grab = sh.querySelector('[data-grab]');
  const onStart = e => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    const t = e.touches ? e.touches[0] : e;
    startY = t.clientY;
    lastY = startY;
    lastT = performance.now();
    velocity = 0;
    dragging = true;
    sh.classList.add('dragging');
  };

  grab.addEventListener('touchstart', onStart, { passive: true });
  grab.addEventListener('touchmove', onMove, { passive: true });
  grab.addEventListener('touchend', onEnd);
  grab.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);
  document.addEventListener('keydown', onEsc);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  openSheets.push(close);
  return close;
}

export function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function setupCollapsible(sectionEl, { open = true } = {}) {
  if (!sectionEl) return;
  const body = sectionEl.querySelector('.section-body');
  if (!body) return;
  const setHeight = () => { body.style.maxHeight = body.scrollHeight + 'px'; };
  if (open) {
    sectionEl.classList.remove('closed');
    requestAnimationFrame(setHeight);
    setTimeout(() => { if (!sectionEl.classList.contains('closed')) body.style.maxHeight = 'none'; }, 420);
  } else {
    body.style.maxHeight = '0px';
    sectionEl.classList.add('closed');
  }
  const head = sectionEl.querySelector('.section-head');
  if (head) {
    head.onclick = () => {
      const isClosed = sectionEl.classList.toggle('closed');
      if (isClosed) {
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(() => { body.style.maxHeight = '0px'; });
      } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        setTimeout(() => {
          if (!sectionEl.classList.contains('closed')) body.style.maxHeight = 'none';
        }, 420);
      }
    };
  }
}
