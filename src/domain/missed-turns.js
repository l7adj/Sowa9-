import { put, all, get } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export const MISSED_POLICY = { RECLAIM:'RECLAIM', NORMAL:'NORMAL' };

export async function recordMissed({
  driverId,
  dueDriverId = null,
  plannedDriverId = null,
  actualDriverId = null,
  missionId,
  periodId = null,
  occurrenceId = null,
  dateIso,
  reason,
  substitutedBy = null,
  policy = MISSED_POLICY.RECLAIM
}) {
  requireWrite('missed.record');
  const dId = Number(dueDriverId || driverId);
  const mId = Number(missionId);
  const occId = occurrenceId ? Number(occurrenceId) : null;
  const pId = periodId ? String(periodId) : null;
  const subId = actualDriverId ? Number(actualDriverId) : (substitutedBy ? Number(substitutedBy) : null);
  const planId = plannedDriverId ? Number(plannedDriverId) : subId;

  // Prevent duplicate un-resolved missed record for the same occurrence + period + driver
  const allRows = await all('missed_turns');
  const exists = allRows.find(r =>
    Number(r.driverId) === dId &&
    Number(r.missionId) === mId &&
    (occId ? Number(r.occurrenceId) === occId : r.dateIso === dateIso) &&
    String(r.periodId || '') === String(pId || '') &&
    !r.resolved
  );
  if (exists) return exists.id;

  const id = await put('missed_turns', {
    driverId: dId,
    dueDriverId: dId,
    plannedDriverId: planId,
    actualDriverId: subId,
    substitutedBy: subId,
    missionId: mId,
    periodId: pId,
    occurrenceId: occId,
    dateIso,
    reason: reason || 'تنفيذ بواسطة بديل',
    returnPolicy: policy,
    resolved: false,
    resolution: null,
    createdAt: nowIso()
  });
  await audit({ entity:'missed_turns', entityId:id, action:'record',
    newValue:{ driverId: dId, missionId: mId, occurrenceId: occId, periodId: pId, dateIso, reason, policy } });
  return id;
}

export async function listUnresolved() {
  const rows = await all('missed_turns');
  return rows.filter(r => !r.resolved)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function listDriverUnresolved(driverId) {
  const rows = await all('missed_turns');
  return rows.filter(r => Number(r.driverId) === Number(driverId) && !r.resolved)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
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

export async function hasReclaimPriority(driverId, missionId, periodId = null) {
  const rows = await all('missed_turns');
  return rows.find(r =>
    Number(r.driverId) === Number(driverId) &&
    Number(r.missionId) === Number(missionId) &&
    (!periodId || !r.periodId || String(r.periodId) === String(periodId)) &&
    r.returnPolicy === MISSED_POLICY.RECLAIM &&
    !r.resolved
  ) || null;
}

export async function findReclaimCandidates(missionId, periodId = null) {
  const rows = await all('missed_turns');
  return rows.filter(r =>
    Number(r.missionId) === Number(missionId) &&
    (!periodId || !r.periodId || String(r.periodId) === String(periodId)) &&
    r.returnPolicy === MISSED_POLICY.RECLAIM &&
    !r.resolved
  ).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')); // FIFO: oldest missed turn first
}

export async function resolveMissedForDriver(driverId, missionId, periodId = null) {
  const rows = await all('missed_turns');
  // Sort oldest first for strict FIFO single-turn resolution
  const matching = rows.filter(r =>
    Number(r.driverId) === Number(driverId) &&
    Number(r.missionId) === Number(missionId) &&
    (!periodId || !r.periodId || String(r.periodId) === String(periodId)) &&
    !r.resolved
  ).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  if (matching.length > 0) {
    const target = matching[0]; // Exactly ONE oldest missed turn (FIFO)
    await resolveMissed({
      missedId: target.id,
      resolution: target.returnPolicy === MISSED_POLICY.RECLAIM ? 'RECLAIMED' : 'RESOLVED_NORMAL',
      note: 'تم تنفيذ الدور واستعادته بنجاح (FIFO)'
    });
    return target;
  }
  return null;
}
