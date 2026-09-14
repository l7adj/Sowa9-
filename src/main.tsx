import './index.css';
import { openDB } from './core/db.js';
import { ensureDefaults } from './core/auth.js';
import { boot } from './ui/app.js';

async function init() {
  const root = document.getElementById('root');
  if (!root) return;

  try {
    await openDB();
    await ensureDefaults();

    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch {}
    }

    boot(root);
  } catch (e: any) {
    console.error('Boot error:', e);
    root.innerHTML = `
      <div style="padding:60px 20px;text-align:center;font-family:system-ui,sans-serif">
        <div style="font-size:44px;margin-bottom:14px">⚠️</div>
        <h2 style="margin:0 0 8px;font-size:18px;color:#dc2626">فشل في تشغيل النظام</h2>
        <p style="color:#64748B;font-size:13px;direction:ltr;font-family:monospace;margin-bottom:16px">
          ${String(e?.message || e)}
        </p>
        <button onclick="location.reload()" style="padding:10px 20px;background:#1e293b;color:#fff;border:0;border-radius:8px;cursor:pointer;font-weight:bold">
          إعادة المحاولة
        </button>
      </div>`;
  }
}

init();
