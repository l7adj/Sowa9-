import { get, put, byIdx, all } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';
import { recordMissed, resolveMissedForDriver } from './missed-turns.js';

export const ASG_STATUS = {
  PROPOSED: 'PROPOSED',
  PLANNED: 'PLANNED',
  CONFIRMED: 'CONFIRMED',
  OVERRIDDEN: 'OVERRIDDEN',
  CANCELLED: 'CANCELLED'
};

export const DRIVER_SOURCE = {
  TEAM: 'TEAM',           // من نفس الفريق
  BORROWED: 'BORROWED'    // مستعار من فريق آخر
};

export async function listByOccurrence(occurrenceId) {
  return byIdx('assignments', 'occurrenceId', Number(occurrenceId));
}

export async function listAllAssignments() {
  return all('assignments');
}

export async function getAssignment(id) {
  return get('assignments', Number(id));
}

export async function createAssignment({
  occurrenceId,
  missionId,
  periodId = null,
  periodCode = null,
  periodName = '',
  timeSlot = '',
  dueDriverId = null,
  plannedDriverId = null,
  actualDriverId = null,
  source = DRIVER_SOURCE.TEAM,
  loanId = null,
  startIso,
  endIso,
  rationale = '',
  replacementReason = '',
  autoConfirm = true
}) {
  requireWrite('assign.create');
  const isOverride = Boolean(dueDriverId && plannedDriverId && Number(dueDriverId) !== Number(plannedDriverId));
  if (isOverride && autoConfirm && (!replacementReason || !replacementReason.trim())) {
    throw new Error('سبب التجاوز مطلوب');
  }
  const status = autoConfirm
    ? (isOverride ? ASG_STATUS.OVERRIDDEN : ASG_STATUS.CONFIRMED)
    : ASG_STATUS.PROPOSED;

  const id = await put('assignments', {
    occurrenceId: Number(occurrenceId),
    missionId: Number(missionId),
    periodId: periodId ? String(periodId) : null,
    periodCode: periodCode ? String(periodCode) : null,
    periodName: periodName || '',
    timeSlot: timeSlot || '',
    dueDriverId: dueDriverId ? Number(dueDriverId) : null,
    plannedDriverId: plannedDriverId ? Number(plannedDriverId) : null,
    actualDriverId: autoConfirm ? (actualDriverId || plannedDriverId) : null,
    source: source || DRIVER_SOURCE.TEAM,
    loanId: loanId ? Number(loanId) : null,
    status,
    startIso,
    endIso,
    rationale: rationale || null,
    replacementReason: replacementReason || null,
    replacedAt: isOverride ? nowIso() : null,
    confirmedAt: autoConfirm ? nowIso() : null,
    cancelledAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

  if (isOverride && dueDriverId) {
    try {
      await recordMissed({
        driverId: Number(dueDriverId),
        missionId: Number(missionId),
        periodId: periodId ? String(periodId) : (periodCode ? String(periodCode) : null),
        dateIso: startIso ? startIso.slice(0, 10) : nowIso().slice(0, 10),
        reason: replacementReason?.trim() || 'استبدال السائق أو تجاوزه',
        substitutedBy: Number(plannedDriverId)
      });
    } catch (e) {
      // Ignore if already logged or not critical
    }
  }

  if (autoConfirm && plannedDriverId) {
    try {
      await resolveMissedForDriver(
        Number(plannedDriverId),
        Number(missionId),
        periodId ? String(periodId) : (periodCode ? String(periodCode) : null)
      );
    } catch (e) {}
  }

  await audit({
    entity: 'assignments',
    entityId: id,
    action: autoConfirm ? 'assign_driver' : 'propose_driver',
    newValue: { dueDriverId, plannedDriverId, source, timeSlot, missionId, periodId }
  });

  return id;
}

export async function confirm(assignmentId, reason = '') {
  requireWrite('assign.confirm');
  const a = await get('assignments', Number(assignmentId));
  if (!a) throw new Error('التوزيع غير موجود');
  if (a.status === ASG_STATUS.CANCELLED) throw new Error('لا يمكن تأكيد توزيع ملغى');

  const override = Boolean(a.dueDriverId && a.plannedDriverId && Number(a.dueDriverId) !== Number(a.plannedDriverId));
  if (override && (!reason || !reason.trim())) throw new Error('سبب التجاوز مطلوب');

  const next = {
    ...a,
    actualDriverId: a.plannedDriverId,
    status: override ? ASG_STATUS.OVERRIDDEN : ASG_STATUS.CONFIRMED,
    replacementReason: override ? reason.trim() : (a.replacementReason || null),
    replacedAt: override ? nowIso() : null,
    confirmedAt: nowIso(),
    updatedAt: nowIso()
  };
  await put('assignments', next);

  if (override && a.dueDriverId) {
    try {
      await recordMissed({
        driverId: Number(a.dueDriverId),
        missionId: Number(a.missionId),
        periodId: a.periodId || a.periodCode || null,
        dateIso: a.startIso ? a.startIso.slice(0, 10) : nowIso().slice(0, 10),
        reason: reason.trim() || 'استبدال السائق عند التأكيد',
        substitutedBy: Number(a.plannedDriverId)
      });
    } catch (e) {}
  }

  if (a.plannedDriverId) {
    try {
      await resolveMissedForDriver(
        Number(a.plannedDriverId),
        Number(a.missionId),
        a.periodId || a.periodCode || null
      );
    } catch (e) {}
  }
  await audit({
    entity: 'assignments',
    entityId: assignmentId,
    action: override ? 'confirm-with-override' : 'confirm',
    oldValue: { status: a.status },
    newValue: { status: next.status, actualDriverId: next.actualDriverId },
    reason
  });
  return next;
}

export async function cancel(assignmentId, reason) {
  requireWrite('assign.cancel');
  if (!reason || !reason.trim()) throw new Error('سبب الإلغاء مطلوب');
  const a = await get('assignments', Number(assignmentId));
  if (!a) throw new Error('التوزيع غير موجود');
  if (a.status === ASG_STATUS.CANCELLED) return a;

  const next = {
    ...a,
    status: ASG_STATUS.CANCELLED,
    replacementReason: reason,
    cancelledAt: nowIso(),
    updatedAt: nowIso()
  };
  await put('assignments', next);
  await audit({
    entity: 'assignments',
    entityId: assignmentId,
    action: 'cancel',
    oldValue: { status: a.status },
    newValue: { status: ASG_STATUS.CANCELLED },
    reason
  });
  return next;
}

export async function isAssignedInOccurrence(driverId, occurrenceId) {
  const rows = await byIdx('assignments', 'occurrenceId', Number(occurrenceId));
  return rows.find(a =>
    a.status !== ASG_STATUS.CANCELLED &&
    (a.plannedDriverId === Number(driverId) || a.actualDriverId === Number(driverId))
  ) || null;
}

export const createProposal = createAssignment;

