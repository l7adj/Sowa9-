import { all, get, put } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export const STATUS = {
  AVAILABLE:'AVAILABLE', VACATION:'VACATION', SICK:'SICK',
  UNAVAILABLE:'UNAVAILABLE', ABSENT:'ABSENT', DISABLED:'DISABLED'
};

export const STATUS_AR = {
  AVAILABLE:'متاح', VACATION:'عطلة', SICK:'عجز طبي',
  UNAVAILABLE:'غير متاح', ABSENT:'غائب', DISABLED:'معطَّل'
};

export const STATUS_COLOR = {
  AVAILABLE:'ok', VACATION:'warn', SICK:'bad',
  UNAVAILABLE:'warn', ABSENT:'warn', DISABLED:'muted'
};

export async function listDrivers(includeDisabled = false) {
  let r = await all('drivers');
  if (!includeDisabled) r = r.filter(d => d.status !== STATUS.DISABLED);
  return r.sort((a, b) => a.id - b.id);
}

export async function getDriver(id) { return get('drivers', id); }

export async function createDriver({ name, status = STATUS.AVAILABLE, notes = '', teamId = 1, phone = '' }) {
  requireWrite('driver.create');
  if (!name || !name.trim()) throw new Error('الاسم مطلوب');
  const id = await put('drivers', {
    name: name.trim(),
    status,
    notes,
    teamId: Number(teamId) || 1,
    phone: phone || '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  await put('status_history', {
    driverId: id, status, at: nowIso(), reason: 'initial'
  });
  await audit({ entity:'drivers', entityId:id, action:'create',
    newValue:{ name, status, teamId } });
  return id;
}

export async function editDriver(id, patch) {
  requireWrite('driver.edit');
  const d = await get('drivers', id);
  if (!d) throw new Error('السائق غير موجود');
  const cleanPatch = { ...patch };
  if ('teamId' in cleanPatch) cleanPatch.teamId = Number(cleanPatch.teamId) || 1;
  await put('drivers', { ...d, ...cleanPatch, updatedAt: nowIso() });
  await audit({ entity:'drivers', entityId:id, action:'edit',
    oldValue:d, newValue:cleanPatch });
}

export async function setStatus(id, status, reason = '') {
  requireWrite('driver.status');
  const d = await get('drivers', id);
  if (!d) throw new Error('السائق غير موجود');
  if (d.status === status) return;
  await put('drivers', { ...d, status, updatedAt: nowIso() });
  await put('status_history', {
    driverId: id, status, prev: d.status, at: nowIso(), reason
  });
  await audit({ entity:'drivers', entityId:id, action:'status',
    oldValue:d.status, newValue:status, reason });
}

export async function statusHistory(driverId) {
  const rows = await all('status_history');
  return rows.filter(r => r.driverId === driverId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export const updateDriver = editDriver;
export const setDriverStatus = setStatus;

