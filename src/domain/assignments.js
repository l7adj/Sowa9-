import { get, put, byIdx, all } from '../core/db.js';
import { nowIso, toIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

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

function normalizeAssignment(a) {
  if (!a) return a;
  if (a.startIso && typeof a.startIso !== 'string') {
    a.startIso = toIso(a.startIso);
  }
  if (a.endIso && typeof a.endIso !== 'string') {
    a.endIso = toIso(a.endIso);
  }
  return a;
}

export async function listByOccurrence(occurrenceId) {
  const list = await byIdx('assignments', 'occurrenceId', Number(occurrenceId));
  return list.map(normalizeAssignment);
}

export async function listAllAssignments() {
  const list = await all('assignments');
  return list.map(normalizeAssignment);
}

export async function getAssignment(id) {
  const a = await get('assignments', Number(id));
  return normalizeAssignment(a);
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
    startIso: toIso(startIso),
    endIso: toIso(endIso),
    rationale: rationale || null,
    replacementReason: replacementReason || null,
    replacedAt: isOverride ? nowIso() : null,
    confirmedAt: autoConfirm ? nowIso() : null,
    cancelledAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });

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

export async function updateAssignmentTiming(assignmentId, { startIso, endIso, driverId = null }) {
  requireWrite('assign.create');
  const a = await get('assignments', Number(assignmentId));
  if (!a) throw new Error('التوزيع غير موجود');

  const next = {
    ...a,
    startIso: toIso(startIso || a.startIso),
    endIso: toIso(endIso || a.endIso),
    ...(driverId ? {
      plannedDriverId: Number(driverId),
      actualDriverId: a.actualDriverId ? Number(driverId) : a.actualDriverId,
      dueDriverId: a.dueDriverId || Number(driverId)
    } : {}),
    updatedAt: nowIso()
  };

  await put('assignments', next);
  await audit({
    entity: 'assignments',
    entityId: assignmentId,
    action: 'update_timing',
    oldValue: { startIso: a.startIso, endIso: a.endIso, plannedDriverId: a.plannedDriverId },
    newValue: { startIso: next.startIso, endIso: next.endIso, plannedDriverId: next.plannedDriverId }
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

