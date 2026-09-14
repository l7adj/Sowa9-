import { STORES, all, put, putMany, wipe, get } from './db.js';

const SLOT = 'latest';

export async function exportBackup() {
  const data = { _meta: { app:'Sowa9', ver:1, at:new Date().toISOString() } };
  for (const n of Object.keys(STORES)) {
    if (n === '_backup') continue;
    data[n] = await all(n);
  }
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

export async function importBackup(text) {
  const d = JSON.parse(text);
  if (!d._meta || d._meta.app !== 'Sowa9') {
    throw new Error('ملف غير صالح — ليس نسخة Sowa9');
  }
  if (d._meta.ver !== 1) {
    throw new Error('إصدار غير مدعوم');
  }

  // احفظ نسخة أمان في IndexedDB
  const bak = { _meta: { app:'Sowa9', ver:1, at:new Date().toISOString() } };
  for (const n of Object.keys(STORES)) {
    if (n === '_backup') continue;
    bak[n] = await all(n);
  }
  await put('_backup', { slot: SLOT, data: bak, savedAt: new Date().toISOString() });

  const verified = await get('_backup', SLOT);
  if (!verified || !verified.data) {
    throw new Error('فشل حفظ النسخة الاحتياطية — تم إلغاء الاستيراد');
  }

  await wipe(['_backup']);

  try {
    for (const n of Object.keys(STORES)) {
      if (n === '_backup') continue;
      if (Array.isArray(d[n]) && d[n].length) await putMany(n, d[n]);
    }
  } catch (err) {
    const recovery = await get('_backup', SLOT);
    if (recovery?.data) {
      await wipe(['_backup']);
      for (const n of Object.keys(STORES)) {
        if (n === '_backup') continue;
        if (Array.isArray(recovery.data[n]) && recovery.data[n].length) {
          await putMany(n, recovery.data[n]);
        }
      }
    }
    throw new Error(`فشل الاستيراد: ${err.message} — تم الاسترجاع`);
  }
}

export async function restoreLastBackup() {
  const bak = await get('_backup', SLOT);
  if (!bak?.data) throw new Error('لا توجد نسخة احتياطية');
  await wipe(['_backup']);
  for (const n of Object.keys(STORES)) {
    if (n === '_backup') continue;
    if (Array.isArray(bak.data[n]) && bak.data[n].length) {
      await putMany(n, bak.data[n]);
    }
  }
}
