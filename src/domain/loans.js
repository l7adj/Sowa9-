import { all, get, put } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite, getSession } from '../core/auth.js';

export const LOAN_STATUS = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

export async function createLoan({
  fromTeamId,
  toTeamId,
  driverId,
  missionId,
  occurrenceId,
  periodId = null,
  timeSlot = '',
  dateIso,
  reason = 'نقص سائق',
  fairnessImpact = true
}) {
  requireWrite('loan.create');
  if (!fromTeamId || !toTeamId) throw new Error('فريق الإعارة وفريق الاستعارة مطلوبان');
  if (fromTeamId === toTeamId) throw new Error('لا يمكن الإعارة لنفس الفريق');
  if (!driverId) throw new Error('السائق مطلوب');
  if (!reason || !reason.trim()) throw new Error('سبب الإعارة مطلوب للتوثيق');

  const sess = getSession();
  const id = await put('loans', {
    fromTeamId: Number(fromTeamId),
    toTeamId: Number(toTeamId),
    driverId: Number(driverId),
    missionId: missionId ? Number(missionId) : null,
    occurrenceId: occurrenceId ? Number(occurrenceId) : null,
    periodId: periodId ? String(periodId) : null,
    timeSlot: timeSlot || '',
    dateIso,
    reason: reason.trim(),
    fairnessImpact: !!fairnessImpact,
    status: LOAN_STATUS.ACTIVE,
    recordedByRole: sess?.role || 'LEADER',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  await audit({
    entity: 'loans',
    entityId: id,
    action: 'borrow_driver',
    newValue: { fromTeamId, toTeamId, driverId, missionId, periodId, dateIso, reason }
  });

  return id;
}

export async function listLoans(filters = {}) {
  let rows = await all('loans');
  if (filters.dateIso) rows = rows.filter(r => r.dateIso === filters.dateIso);
  if (filters.driverId) rows = rows.filter(r => r.driverId === Number(filters.driverId));
  if (filters.fromTeamId) rows = rows.filter(r => r.fromTeamId === Number(filters.fromTeamId));
  if (filters.toTeamId) rows = rows.filter(r => r.toTeamId === Number(filters.toTeamId));
  if (filters.status) rows = rows.filter(r => r.status === filters.status);
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getLoan(id) {
  if (!id) return null;
  return get('loans', Number(id));
}

export async function completeLoan(id, note = '') {
  requireWrite('loan.complete');
  const l = await get('loans', Number(id));
  if (!l) throw new Error('سجل الإعارة غير موجود');
  const next = { ...l, status: LOAN_STATUS.COMPLETED, completionNote: note, updatedAt: nowIso() };
  await put('loans', next);
  await audit({ entity: 'loans', entityId: id, action: 'complete', oldValue: l, newValue: next });
  return next;
}

export async function cancelLoan(id, reason = '') {
  requireWrite('loan.cancel');
  const l = await get('loans', Number(id));
  if (!l) throw new Error('سجل الإعارة غير موجود');
  const next = { ...l, status: LOAN_STATUS.CANCELLED, cancelReason: reason, updatedAt: nowIso() };
  await put('loans', next);
  await audit({ entity: 'loans', entityId: id, action: 'cancel', oldValue: l, newValue: next });
  return next;
}

// ═══════════════════════════════════════
// Shortages (سجل رصد وتوثيق النقص)
// ═══════════════════════════════════════
export async function recordShortage({
  occurrenceId,
  missionId,
  periodId = null,
  dateIso,
  timeSlot = '',
  requiredCount,
  availableCount,
  shortageCount,
  reason = 'عدم توفر سائق متاح'
}) {
  requireWrite('shortage.record');
  const id = await put('shortages', {
    occurrenceId: Number(occurrenceId),
    missionId: Number(missionId),
    periodId: periodId ? String(periodId) : null,
    dateIso,
    timeSlot,
    requiredCount,
    availableCount,
    shortageCount,
    reason,
    resolved: false,
    resolvedWithLoanId: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  await audit({ entity: 'shortages', entityId: id, action: 'record_shortage', newValue: { occurrenceId, shortageCount, reason } });
  return id;
}

export async function listShortages(dateIso = null) {
  let rows = await all('shortages');
  if (dateIso) rows = rows.filter(r => r.dateIso === dateIso);
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function resolveShortage(id, loanId = null) {
  requireWrite('shortage.resolve');
  const s = await get('shortages', Number(id));
  if (!s) return null;
  const next = { ...s, resolved: true, resolvedWithLoanId: loanId ? Number(loanId) : null, updatedAt: nowIso() };
  await put('shortages', next);
  return next;
}
