const supportsViewTransitions =
  typeof document !== 'undefined' &&
  'startViewTransition' in document &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function transition(updateFn, options = {}) {
  const { type = 'default' } = options;
  if (!supportsViewTransitions) { await updateFn(); return; }
  try {
    document.documentElement.classList.add(`vt-${type}`);
    const t = document.startViewTransition(() => updateFn());
    await t.finished;
    document.documentElement.classList.remove(`vt-${type}`);
  } catch (err) {
    console.warn('View Transition failed:', err);
    await updateFn();
  }
}

export async function pageTransition(updateFn, direction = 'forward') {
  return transition(updateFn, { type: `page-${direction}` });
}

export async function modalTransition(updateFn) {
  return transition(updateFn, { type: 'modal' });
}

export async function sharedTransition(updateFn, elementId) {
  if (!supportsViewTransitions) { await updateFn(); return; }
  const el = document.getElementById(elementId);
  if (!el) { await updateFn(); return; }
  el.style.viewTransitionName = `shared-${elementId}`;
  try {
    const t = document.startViewTransition(() => updateFn());
    await t.finished;
  } finally {
    el.style.viewTransitionName = '';
  }
}

export function hasTransitions() { return supportsViewTransitions; }
