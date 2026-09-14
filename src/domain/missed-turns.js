import { put, all, get } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export const MISSED_POLICY = { RECLAIM:'RECLAIM', NORMAL:'NORMAL' };

export async function recordMissed({
  driverId, missionId, periodId = null,
  dateIso, reason, substitutedBy = null,
  policy = MISSED_POLICY.RECLAIM
}) {
  requireWrite('missed.record');
  const id = await put('missed_turns', {
    driverId, missionId, periodId: periodId ?? null,
    dateIso, reason, substitutedBy,
    returnPolicy: policy, resolved: false, resolution: null,
    createdAt: nowIso()
  });
  await audit({ entity:'missed_turns', entityId:id, action:'record',
    newValue:{ driverId, missionId, dateIso, reason, policy } });
  return id;
}

export async function listUnresolved() {
  const rows = await all('missed_turns');
  return rows.filter(r => !r.resolved)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function listDriverUnresolved(driverId) {
  const rows = await all('missed_turns');
  return rows.filter(r => r.driverId === driverId && !r.resolved);
}

export async function setPolicy(missedId, policy) {
  requireWrite('missed.setPolicy');
  const before = await get('missed_turns', missedId);
  if (!before) throw new Error('غير موجود');
  await put('missed_turns', { ...before, returnPolicy: policy });
  await audit({ entity:'missed_turns', entityId:missedId, action:'setPolicy',
    oldValue:before.returnPolicy, newValue:policy });
}

export async function resolveMissed({ missedId, resolution = 'RECLAIMED', note = '' }) {
  requireWrite('missed.resolve');
  const before = await get('missed_turns', missedId);
  if (!before) throw new Error('غير موجود');
  await put('missed_turns', { ...before, resolved:true, resolution,
    resolutionNote: note, resolvedAt: nowIso() });
  await audit({ entity:'missed_turns', entityId:missedId, action:'resolve',
    newValue:{ resolution, note } });
}

export async function hasReclaimPriority(driverId, missionId) {
  const rows = await all('missed_turns');
  return rows.find(r =>
    r.driverId === driverId &&
    r.missionId === missionId &&
    r.returnPolicy === MISSED_POLICY.RECLAIM &&
    !r.resolved
  ) || null;
}
