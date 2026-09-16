import { getSession, setSession, clearSession, ROLE_LABEL, isLeader } from '../core/auth.js';
import { registerRefresh, registerLogout } from './helpers.js';
import { renderHome } from './views-home.js';
import { renderCatalogPage } from './views-catalog.js';
import { renderLoansPage } from './views-loans.js';
import { renderDriversPage } from './views-drivers.js';
import { renderSettingsPage } from './views.js';

let rootEl = null;
let currentTab = 'home';
let isTransitioning = false;
let pageCache = {};

const TABS = [
  { id: 'home', label: 'العمليات', icon: '⚡', render: renderHome },
  { id: 'catalog', label: 'المهام', icon: '📋', render: renderCatalogPage },
  { id: 'loans', label: 'الإعارات', icon: '🔄', render: renderLoansPage },
  { id: 'drivers', label: 'السواق', icon: '👥', render: renderDriversPage },
  { id: 'settings', label: 'الإعدادات', icon: '⚙️', render: renderSettingsPage, leaderOnly: true }
];
let visibleTabs = [];

export function boot(root) {
  rootEl = root;
  initTheme();
  const s = getSession();
  if (!s) return renderLogin();
  renderShell();
}

function initTheme() {
  const saved = localStorage.getItem('sowa9_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('sowa9_theme', next);
  const icon = document.querySelector('#themeToggleBtn');
  if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
}

function renderLogin() {
  const curTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  rootEl.innerHTML = `
    <div class="login-screen">
      <div style="position:absolute;top:16px;left:16px">
        <button id="themeToggleBtnLogin" class="btn-ghost" style="width:auto;padding:6px 12px;font-size:13px;border-radius:10px">
          ${curTheme === 'dark' ? '☀️ وضع النهار' : '🌙 الوضع الليلي'}
        </button>
      </div>
      <div class="logo-big" style="background:linear-gradient(135deg,#1e3a8a,#2563eb);box-shadow:0 8px 24px rgba(37,99,235,0.3)">S9</div>
      <h1 style="font-weight:900;letter-spacing:-0.5px">Sowa9 — قيادة فرقة السواق</h1>
      <p class="lead" style="max-width:380px;line-height:1.6">النظام التشغيلي الميداني لإدارة المهام وتوزيع السواق بأقل عدد من النقرات</p>
      
      <div style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:360px">
        <button class="btn-primary" data-role="LEADER"
          style="padding:16px 20px;text-align:right;background:linear-gradient(135deg,#1d4ed8,#2563eb);box-shadow:0 4px 14px rgba(37,99,235,0.25)">
          <div style="font-weight:900;font-size:15px;display:flex;align-items:center;justify-content:space-between">
            <span>🎖️ قائد فرقة السواق</span>
            <span style="font-size:11px;background:rgba(255,255,255,0.2);padding:2px 8px;border-radius:6px">تحكم كامل</span>
          </div>
          <div style="font-size:11px;opacity:.9;margin-top:4px">توجيه العمليات، وتعيين السواق بضغطة واحدة</div>
        </button>
        <button class="btn-ghost" data-role="DEPUTY"
          style="padding:14px 20px;text-align:right">
          <div style="font-weight:900;font-size:14px">⭐ نائب قائد فرقة السواق</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px">توزيع المهام ومتابعة الجاهزية الميدانية</div>
        </button>
        <button class="btn-ghost" data-role="DRIVER"
          style="padding:14px 20px;text-align:right">
          <div style="font-weight:900;font-size:14px">🚗 السواق (عرض المهام الميدانية)</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px">استعراض المهام المسندة والتوقيت بدقة</div>
        </button>
      </div>
    </div>
  `;
  rootEl.querySelector('#themeToggleBtnLogin').onclick = () => {
    toggleTheme();
    renderLogin();
  };
  rootEl.querySelectorAll('button[data-role]').forEach(b => {
    b.onclick = () => {
      setSession({ role: b.dataset.role, driverId: null, at: new Date().toISOString() });
      boot(rootEl);
    };
  });
}

function renderShell() {
  const sess = getSession();
  const curTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  visibleTabs = TABS.filter(t => !t.leaderOnly || isLeader());
  if (!visibleTabs.find(t => t.id === currentTab)) currentTab = 'home';

  rootEl.innerHTML = `
    <header class="topbar">
      <h1>
        <span class="logo" style="background:linear-gradient(135deg,#1d4ed8,#2563eb)">S9</span>
        <span style="font-weight:900">Sowa9</span>
        <span class="topbar-subtitle" style="font-size:11px;font-weight:700;color:var(--text-3);margin-right:4px">| قيادة العمليات</span>
      </h1>
      <div class="topbar-actions" style="display:flex;align-items:center;gap:6px">
        <span class="role-tag topbar-role-tag" style="display:flex;align-items:center;gap:4px">
          <span style="color:#10b981">●</span>
          <span>${ROLE_LABEL[sess.role] || sess.role}</span>
        </span>
        <button id="themeToggleBtn" title="تبديل مظهر العرض" style="font-size:14px;background:var(--surface-2)">
          ${curTheme === 'dark' ? '☀️' : '🌙'}
        </button>
        <button id="outBtn" title="تسجيل الخروج" style="font-size:14px;background:var(--surface-2)">⎋</button>
      </div>
    </header>
    <div class="pages-stack" id="pagesStack"></div>
    <nav class="bnav" id="bnav">
      ${visibleTabs.map(t => `
        <button data-tab="${t.id}" class="${t.id === currentTab ? 'active' : ''}">
          <span class="pill"></span>
          <span class="ic">${t.icon}</span>
          <span>${t.label}</span>
        </button>
      `).join('')}
    </nav>
  `;

  rootEl.querySelector('#themeToggleBtn').onclick = toggleTheme;

  rootEl.querySelector('#outBtn').onclick = () => {
    if (window.confirm('هل تريد تسجيل الخروج؟')) { clearSession(); boot(rootEl); }
  };

  rootEl.querySelector('#bnav').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b || isTransitioning) return;
    if (b.dataset.tab === currentTab) return;
    switchTab(b.dataset.tab);
  });

  mountInitial();
}

function mountInitial() {
  const stack = rootEl.querySelector('#pagesStack');
  stack.innerHTML = '';
  const page = createPage(currentTab, 'active');
  stack.appendChild(page);
  renderIntoPage(page, currentTab);
}

function createPage(tabId, ...classes) {
  const page = document.createElement('div');
  page.className = 'page ' + classes.join(' ');
  page.dataset.tab = tabId;
  const inner = document.createElement('div');
  inner.className = 'page-inner';
  page.appendChild(inner);
  return page;
}

function renderIntoPage(page, tabId) {
  const t = visibleTabs.find(x => x.id === tabId);
  if (!t) return Promise.resolve();
  const inner = page.querySelector('.page-inner');
  return Promise.resolve()
    .then(() => t.render(inner))
    .catch(err => {
      console.error(err);
      inner.innerHTML = `
        <div class="empty-block">
          <div class="ic">⚠️</div>
          <h3>حدث خطأ أثناء تحميل الصفحة</h3>
          <p style="direction:ltr;font-family:monospace;font-size:11px">
            ${String(err?.message || err)}
          </p>
        </div>`;
    });
}

function switchTab(tabId) {
  if (tabId === currentTab || isTransitioning) return;
  const oldIdx = visibleTabs.findIndex(x => x.id === currentTab);
  const newIdx = visibleTabs.findIndex(x => x.id === tabId);
  if (newIdx < 0) return;

  isTransitioning = true;
  const stack = rootEl.querySelector('#pagesStack');
  const oldPage = stack.querySelector('.page.active');
  if (oldPage) pageCache[currentTab] = oldPage.scrollTop;

  const forward = newIdx > oldIdx;
  const newPage = createPage(tabId, forward ? 'from-left' : 'from-right');
  stack.appendChild(newPage);

  rootEl.querySelectorAll('#bnav button').forEach(x => {
    x.classList.toggle('active', x.dataset.tab === tabId);
  });

  const renderPromise = renderIntoPage(newPage, tabId);
  renderPromise.then(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newPage.classList.remove('from-left', 'from-right');
        newPage.classList.add('active');
        if (oldPage) {
          oldPage.classList.remove('active');
          oldPage.classList.add(forward ? 'to-right' : 'to-left');
        }
      });
    });
    setTimeout(() => {
      if (oldPage && oldPage.parentNode) oldPage.remove();
      if (pageCache[tabId] !== undefined) newPage.scrollTop = pageCache[tabId];
      currentTab = tabId;
      isTransitioning = false;
    }, 400);
  });
}

function refreshCurrent() {
  const stack = rootEl.querySelector('#pagesStack');
  if (!stack) return;
  const page = stack.querySelector('.page.active');
  if (!page) return;
  const tabId = page.dataset.tab;
  const inner = page.querySelector('.page-inner');
  Promise.resolve().then(() => {
    const t = visibleTabs.find(x => x.id === tabId);
    return t && t.render(inner);
  }).catch(err => console.error(err));
}

registerRefresh(refreshCurrent);
registerLogout(() => { clearSession(); boot(rootEl); });
