import { getSession, setSession, clearSession, ROLE_LABEL, isLeader } from '../core/auth.js';
import { registerRefresh, registerLogout } from './helpers.js';
import { renderHome, renderDriversPage, renderSettingsPage } from './views.js';
import { renderLoansPage } from './views-loans.js';

let rootEl = null;
let currentTab = 'home';
let isTransitioning = false;
let pageCache = {};

const TABS = [
  { id: 'home', label: 'المهام', icon: '📋', render: renderHome },
  { id: 'loans', label: 'الإعارات والنقص', icon: '🔄', render: renderLoansPage },
  { id: 'drivers', label: 'السواق', icon: '👥', render: renderDriversPage },
  { id: 'settings', label: 'الإعدادات', icon: '⚙️', render: renderSettingsPage, leaderOnly: true }
];
let visibleTabs = [];

export function boot(root) {
  rootEl = root;
  const s = getSession();
  if (!s) return renderLogin();
  renderShell();
}

function renderLogin() {
  rootEl.innerHTML = `
    <div class="login-screen">
      <div class="logo-big">S9</div>
      <h1>Sowa9 — نظام إدارة مهام السواق</h1>
      <p class="lead">العدالة التامة في توزيع المهام وحساب الدور والراحة</p>
      <button class="btn-primary" data-role="LEADER"
        style="max-width:340px;padding:16px;text-align:right">
        <div style="font-weight:900;font-size:15px">قائد فرقة السواق</div>
        <div style="font-size:11px;opacity:.8;margin-top:3px">صلاحيات كاملة في التعيين وإدارة الكتالوج</div>
      </button>
      <button class="btn-ghost" data-role="DEPUTY"
        style="max-width:340px;padding:16px;text-align:right">
        <div style="font-weight:900;font-size:15px">نائب قائد فرقة السواق</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">توزيع المهام وإدارة السواق اليومية</div>
      </button>
      <button class="btn-ghost" data-role="DRIVER"
        style="max-width:340px;padding:16px;text-align:right">
        <div style="font-weight:900;font-size:15px">السواق</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">عرض المهام والجدول فقط دون تعديل</div>
      </button>
    </div>
  `;
  rootEl.querySelectorAll('button[data-role]').forEach(b => {
    b.onclick = () => {
      setSession({ role: b.dataset.role, driverId: null, at: new Date().toISOString() });
      boot(rootEl);
    };
  });
}

function renderShell() {
  const sess = getSession();
  visibleTabs = TABS.filter(t => !t.leaderOnly || isLeader());
  if (!visibleTabs.find(t => t.id === currentTab)) currentTab = 'home';

  rootEl.innerHTML = `
    <header class="topbar">
      <h1>
        <span class="logo">S9</span>
        <span>Sowa9</span>
      </h1>
      <span class="role-tag">${ROLE_LABEL[sess.role] || sess.role}</span>
      <button id="outBtn" title="تسجيل الخروج">⎋</button>
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
