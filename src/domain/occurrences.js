import { all, get, put, byIdx } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export async function listByDate(dateIso) {
  const rows = await byIdx('occurrences', 'dateIso', dateIso);
  return rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export async function getOccurrence(id) { return get('occurrences', id); }

export async function listAll() {
  const r = await all('occurrences');
  return r.sort((a, b) => b.dateIso.localeCompare(a.dateIso));
}

export async function createOccurrence({ dateIso, missionId, startTime, durationMinutes }) {
  requireWrite('occurrence.create');
  const id = await put('occurrences', {
    dateIso, missionId, startTime, durationMinutes,
    cancelled: false, createdAt: nowIso(), updatedAt: nowIso()
  });
  await audit({ entity:'occurrences', entityId:id, action:'create',
    newValue:{ dateIso, missionId } });
  return id;
}

export async function updateOccurrence(id, patch) {
  requireWrite('occurrence.edit');
  const o = await get('occurrences', id);
  if (!o) throw new Error('غير موجودة');
  const next = { ...o, ...patch, updatedAt: nowIso() };
  await put('occurrences', next);
  await audit({ entity:'occurrences', entityId:id, action:'edit',
    oldValue:o, newValue:patch });
  return next;
}

export async function cancelOccurrence(id, reason) {
  requireWrite('occurrence.cancel');
  if (!reason || !reason.trim()) throw new Error('سبب الإلغاء مطلوب');
  return updateOccurrence(id, { cancelled: true, cancelReason: reason });
}
