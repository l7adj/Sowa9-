import { ensureQueue, getTurnInfo, recordExecution } from '../domain/turns.js';
import { listDrivers, STATUS, STATUS_AR } from '../domain/drivers.js';
import { listTeams } from '../domain/teams.js';
import { restBefore, hasConflict } from '../domain/rest.js';
import { listByOccurrence, ASG_STATUS, DRIVER_SOURCE } from '../domain/assignments.js';
import { getSetting, requireWrite } from '../core/auth.js';
import { fmtDurShort, relativeDay, nowIso } from '../core/clock.js';
import { periodRange } from './shared-transport.js';
import { getMission } from '../domain/missions.js';
import { findReclaimCandidates, recordMissed, resolveMissedForDriver, MISSED_POLICY } from '../domain/missed-turns.js';
import { get, put, byIdx, all } from '../core/db.js';
import { audit } from '../core/audit.js';
import { completeLoan } from '../domain/loans.js';

export async function evaluateDriverForShift({
  driver,
  startDate,
  endDate,
  restMinMinutes = 480,
  occurrenceId = null,
  periodId = null,
  targetTeamId = null,
  excludeIds = []
}) {
  const e = {
    driver,
    isAvailable: false,
    reasonAr: '',
    restMinutes: null,
    restOk: true,
    conflict: false,
    alreadyAssigned: false,
    isSameTeam: targetTeamId ? (Number(driver.teamId) === Number(targetTeamId)) : true,
    canBorrow: false
  };

  if (!driver) {
    e.reasonAr = 'غير موجود';
    return e;
  }
  if (excludeIds.includes(driver.id)) {
    e.reasonAr = 'مستبعد أو معيّن بالفعل';
    return e;
  }
  if (driver.status !== STATUS.AVAILABLE) {
    e.reasonAr = STATUS_AR[driver.status] || 'غير متاح';
    return e;
  }

  // Check if already assigned to this occurrence and period
  if (occurrenceId) {
    const asgs = await listByOccurrence(occurrenceId);
    const inShift = asgs.some(a =>
      a.status !== ASG_STATUS.CANCELLED &&
      (a.periodId === periodId || a.periodCode === periodId) &&
      (a.plannedDriverId === driver.id || a.actualDriverId === driver.id)
    );
    if (inShift) {
      e.alreadyAssigned = true;
      e.reasonAr = 'معيّن بالفعل في هذه الفترة';
      return e;
    }
  }

  // Conflict checking with other tasks
  const conflict = await hasConflict(driver.id, startDate, endDate);
  if (conflict) {
    e.conflict = true;
    e.reasonAr = 'تعارض زمني مع مهمة أخرى';
    return e;
  }

  // Rest calculation
  const rest = await restBefore(driver.id, startDate);
  if (rest) {
    e.restMinutes = rest.minutes;
    e.lastEndIso = rest.last.end.toISOString();
    e.restOk = rest.minutes >= restMinMinutes;
    if (!e.restOk) {
      e.reasonAr = `راحة قصيرة (${fmtDurShort(rest.minutes)})`;
      const enforceRestMin = await getSetting('enforceRestMin');
      if (enforceRestMin) {
        e.isAvailable = false;
        e.reasonAr = `راحة غير كافية (${fmtDurShort(rest.minutes)}) — الإلزام مفعّل`;
        return e;
      }
    }
  }

  e.isAvailable = true;
  if (!e.isSameTeam) {
    e.canBorrow = true;
  }
  return e;
}

export async function analyzePeriodAllocation({
  mission,
  period,
  dateIso,
  occurrenceId = null,
  targetTeamId = null,
  excludeIds = []
}) {
  const restMinHours = await getSetting('restMinHours') || 8;
  const restMinMinutes = restMinHours * 60;
  const range = periodRange(period, dateIso);
  const startDate = range.start;
  const endDate = range.end;

  const [allDrivers, teams] = await Promise.all([
    listDrivers(),
    listTeams()
  ]);
  const teamMap = new Map(teams.map(t => [t.id, t]));

  // Active assignments already for this shift
  let existingAssignments = [];
  if (occurrenceId) {
    const asgs = await listByOccurrence(occurrenceId);
    existingAssignments = asgs.filter(a =>
      a.status !== ASG_STATUS.CANCELLED &&
      (a.periodId === (period.id || period.code) || a.periodCode === (period.code || period.id))
    );
  }

  const assignedDriverIds = new Set(
    existingAssignments.map(a => a.actualDriverId || a.plannedDriverId).filter(Boolean)
  );
  const totalExcluded = [...new Set([...excludeIds, ...assignedDriverIds])];

  const evaluated = [];
  for (const d of allDrivers) {
    const res = await evaluateDriverForShift({
      driver: d,
      startDate,
      endDate,
      restMinMinutes,
      occurrenceId,
      periodId: period.id || period.code,
      targetTeamId: targetTeamId || mission.teamId || null,
      excludeIds: totalExcluded
    });
    evaluated.push({
      ...res,
      team: teamMap.get(d.teamId) || { name: 'الفريق الرئيسي', id: 1, color: '#2563eb' }
    });
  }

  const requiredCount = Number(period.driversNeeded) || 1;
  const assignedCount = existingAssignments.length;
  const remainingNeeded = Math.max(0, requiredCount - assignedCount);

  // Group candidates
  const sameTeamAvailable = evaluated.filter(e => e.isAvailable && e.isSameTeam);
  const otherTeamsAvailable = evaluated.filter(e => e.isAvailable && !e.isSameTeam);
  const blockedDrivers = evaluated.filter(e => !e.isAvailable);

  // Sort candidates by fairness (longest rest, restOk first)
  const sortFn = (a, b) => {
    if (a.restOk !== b.restOk) return a.restOk ? -1 : 1;
    const ra = a.restMinutes == null ? 99999 : a.restMinutes;
    const rb = b.restMinutes == null ? 99999 : b.restMinutes;
    return rb - ra;
  };
  sameTeamAvailable.sort(sortFn);
  otherTeamsAvailable.sort(sortFn);

  // Shortage status
  const internalShortage = sameTeamAvailable.length < remainingNeeded;
  const totalAvailable = sameTeamAvailable.length + otherTeamsAvailable.length;
  const netShortage = Math.max(0, remainingNeeded - totalAvailable);

  let recommendation = null;
  if (remainingNeeded > 0) {
    if (sameTeamAvailable.length > 0) {
      recommendation = {
        type: 'INTERNAL',
        driver: sameTeamAvailable[0].driver,
        team: sameTeamAvailable[0].team,
        text: `اقتراح تعيين ${sameTeamAvailable[0].driver.name} من نفس الفريق (راحة: ${sameTeamAvailable[0].restMinutes ? fmtDurShort(sameTeamAvailable[0].restMinutes) : 'مكتملة'})`
      };
    } else if (otherTeamsAvailable.length > 0) {
      const topBorrow = otherTeamsAvailable[0];
      recommendation = {
        type: 'BORROW',
        driver: topBorrow.driver,
        team: topBorrow.team,
        fromTeam: topBorrow.team,
        text: `نقص في الفريق المعني: اقتراح استعارة ${topBorrow.driver.name} من ${topBorrow.team.name}`
      };
    } else {
      recommendation = {
        type: 'SHORTAGE',
        driver: null,
        text: `عجز في السائقين: المطلوب ${requiredCount}، المعيّن ${assignedCount}، النقص الصافي ${netShortage} سائق!`
      };
    }
  }

  return {
    mission,
    period,
    range,
    requiredCount,
    assignedCount,
    remainingNeeded,
    existingAssignments,
    sameTeamAvailable,
    otherTeamsAvailable,
    blockedDrivers,
    internalShortage,
    netShortage,
    recommendation,
    allEvaluated: evaluated
  };
}

export async function suggestForTurn({
  missionId,
  periodId = null,
  occurrenceId = null,
  startIso,
  endIso,
  targetTeamId = null,
  excludeIds = []
}) {
  const restMinHours = await getSetting('restMinHours') || 8;
  const restMinMinutes = restMinHours * 60;
  const startDate = new Date(startIso);
  const endDate = new Date(endIso);

  // Resolve target team from parameters or mission
  let effectiveTargetTeamId = targetTeamId;
  let mission = null;
  if (missionId) {
    try {
      mission = await getMission(missionId);
      if (!effectiveTargetTeamId && mission?.teamId) {
        effectiveTargetTeamId = mission.teamId;
      }
    } catch {}
  }

  const [allDrivers, teams] = await Promise.all([
    listDrivers(),
    listTeams()
  ]);
  const teamMap = new Map(teams.map(t => [t.id, t]));
  const targetTeam = effectiveTargetTeamId ? teamMap.get(Number(effectiveTargetTeamId)) : null;

  // Filter primary drivers: belong to target team, or all drivers if neutral/shared mission
  const primaryDrivers = effectiveTargetTeamId
    ? allDrivers.filter(d => Number(d.teamId) === Number(effectiveTargetTeamId))
    : allDrivers;

  const externalDrivers = effectiveTargetTeamId
    ? allDrivers.filter(d => Number(d.teamId) !== Number(effectiveTargetTeamId))
    : [];

  // Turn queue is maintained per mission + period for primary drivers
  const primaryIds = primaryDrivers.map(d => d.id);
  await ensureQueue(missionId, periodId, primaryIds);

  const info = await getTurnInfo(missionId, periodId);
  if (!info) {
    return {
      due: null, proposed: null, reason: 'تعذر تحميل قائمة الدور',
      queue: [], available: [], sameTeamAvailable: [], otherTeamsAvailable: [],
      blocked: [], missed: null, warning: null, isBorrow: false
    };
  }

  // Evaluate primary queue drivers
  const evaluatedPrimary = [];
  for (const item of info.queue) {
    if (excludeIds.includes(item.driver.id)) continue;
    const check = await evaluateDriverForShift({
      driver: item.driver,
      startDate,
      endDate,
      restMinMinutes,
      occurrenceId,
      periodId,
      targetTeamId: effectiveTargetTeamId,
      excludeIds
    });
    const driverTeam = teamMap.get(item.driver.teamId) || { name: 'الفريق الرئيسي', id: item.driver.teamId || 1 };
    evaluatedPrimary.push({
      ...check,
      driver: item.driver,
      team: driverTeam,
      position: item.position,
      isDue: false,
      count: item.count,
      lastDone: item.lastDone
    });
  }

  // Also evaluate external drivers for borrowing if needed
  const evaluatedExternal = [];
  for (const drv of externalDrivers) {
    if (excludeIds.includes(drv.id)) continue;
    const check = await evaluateDriverForShift({
      driver: drv,
      startDate,
      endDate,
      restMinMinutes,
      occurrenceId,
      periodId,
      targetTeamId: effectiveTargetTeamId,
      excludeIds
    });
    const driverTeam = teamMap.get(drv.teamId) || { name: 'فريق خارجي', id: drv.teamId };
    evaluatedExternal.push({
      ...check,
      driver: drv,
      team: driverTeam,
      position: -1,
      isDue: false,
      count: 0,
      lastDone: null
    });
  }

  const allEvaluated = [...evaluatedPrimary, ...evaluatedExternal];

  // Check Reclaim Priority & Due Driver:
  // Requirement 8: The due driver MUST be established BEFORE filtering for availability.
  // dueDriver -> Is he available?
  //   YES -> He is the candidate/proposed.
  //   NO  -> He remains the dueDriver; search for the substitute/replacement.
  let due = null;
  let isReclaim = false;

  let reclaimCandidates = [];
  try {
    reclaimCandidates = await findReclaimCandidates(missionId, periodId);
  } catch (e) {}
  const reclaimMap = new Map(reclaimCandidates.map(r => [r.driverId, r]));

  // 1. Establish due driver: check reclaim priority first, then head of primary queue
  const reclaimCandidate = evaluatedPrimary.find(e => reclaimMap.has(e.driver.id));
  if (reclaimCandidate) {
    due = reclaimCandidate;
    due.isDue = true;
    isReclaim = true;
  } else if (evaluatedPrimary.length > 0) {
    due = evaluatedPrimary[0];
    due.isDue = true;
  }

  const sameTeamAvailable = evaluatedPrimary.filter(e => e.isAvailable);
  const otherTeamsAvailable = evaluatedExternal.filter(e => e.isAvailable);
  const available = [...sameTeamAvailable, ...otherTeamsAvailable];
  const blocked = allEvaluated.filter(e => !e.isAvailable);

  // Sorting helper by rest sufficiency and rest duration
  const sortCandidates = (list) => {
    return [...list].sort((a, b) => {
      if (a.restOk !== b.restOk) return a.restOk ? -1 : 1;
      const ra = a.restMinutes == null ? 99999 : a.restMinutes;
      const rb = b.restMinutes == null ? 99999 : b.restMinutes;
      return rb - ra;
    });
  };

  const internalShortage = Boolean(effectiveTargetTeamId && sameTeamAvailable.length === 0);
  const netShortage = available.length === 0 ? 1 : 0;

  // Case 1: The designated due driver is available and belongs to target team (or is neutral)
  if (due && due.isAvailable && (!effectiveTargetTeamId || due.isSameTeam)) {
    const reasonText = isReclaim
      ? `استعادة الدور الفائت (Reclaim Priority) لـ ${due.driver.name} بعد العودة والتوفر`
      : buildReason(due, true);

    return {
      due: due.driver,
      proposed: due.driver,
      candidate: due,
      isBorrow: false,
      borrowFromTeam: null,
      reason: reasonText,
      queue: allEvaluated,
      available,
      sameTeamAvailable,
      otherTeamsAvailable,
      blocked,
      internalShortage: false,
      netShortage: 0,
      missed: null,
      warning: !due.restOk ? `تحذير: ${due.reasonAr}` : null
    };
  }

  // Case 2: Due driver is not available, but target team has other available drivers
  if (sameTeamAvailable.length > 0) {
    const internalCandidate = sameTeamAvailable[0];
    return {
      due: due?.driver || null,
      proposed: internalCandidate.driver,
      candidate: internalCandidate,
      isBorrow: false,
      borrowFromTeam: null,
      reason: buildReason(internalCandidate, false, due, targetTeam),
      queue: allEvaluated,
      available,
      sameTeamAvailable,
      otherTeamsAvailable,
      blocked,
      internalShortage: false,
      netShortage: 0,
      missed: (due && due.isSameTeam) ? { driverId: due.driver.id, reason: due.reasonAr } : null,
      warning: !internalCandidate.restOk ? `تحذير: ${internalCandidate.reasonAr}` : null
    };
  }

  // Case 3: Target team has NO available driver, but an external team driver is available (BORROW PROPOSAL)
  if (otherTeamsAvailable.length > 0) {
    const sortedBorrow = sortCandidates(otherTeamsAvailable);
    const borrowCandidate = sortedBorrow[0];
    const teamName = targetTeam ? targetTeam.name : 'الفريق المعني';
    const reasonText = `⚠️ نقص في ${teamName}: اقتراح استعارة ${borrowCandidate.driver.name} من ${borrowCandidate.team.name} لعدم توفر سائق بديل داخل الفريق`;

    return {
      due: due?.driver || null,
      proposed: borrowCandidate.driver,
      candidate: borrowCandidate,
      isBorrow: true,
      borrowFromTeam: borrowCandidate.team,
      needsLoan: true,
      reason: reasonText,
      queue: allEvaluated,
      available,
      sameTeamAvailable,
      otherTeamsAvailable,
      blocked,
      internalShortage: true,
      netShortage: 0,
      missed: due ? { driverId: due.driver.id, reason: due.reasonAr } : null,
      warning: !borrowCandidate.restOk ? `تحذير: ${borrowCandidate.reasonAr}` : null
    };
  }

  // Case 4: No driver available at all (neither internal nor external)
  const teamLabel = targetTeam ? `في ${targetTeam.name}` : 'حالياً';
  const emptyReason = due
    ? `عجز في السائقين: ${due.driver.name} صاحب الدور ${due.reasonAr}، ولا يوجد سائق متاح ${teamLabel} أو من الفرق الزميلة`
    : `عجز كلي في القوة البشرية: لا يوجد أي سائق متاح ${teamLabel} أو من الفرق الزميلة`;

  return {
    due: due?.driver || null,
    proposed: null,
    candidate: null,
    isBorrow: false,
    borrowFromTeam: null,
    reason: emptyReason,
    queue: allEvaluated,
    available: [],
    sameTeamAvailable: [],
    otherTeamsAvailable: [],
    blocked,
    internalShortage: true,
    netShortage: 1,
    missed: due ? { driverId: due.driver.id, reason: due.reasonAr } : null,
    warning: null
  };
}

export async function suggestMultipleForPeriod({
  missionId,
  period,
  occurrenceId = null,
  dateIso,
  count = 1,
  targetTeamId = null,
  alreadyAssignedIds = []
}) {
  const pCode = period.code || period.id;
  const range = periodRange(period, dateIso);
  const results = [];
  const excluded = [...alreadyAssignedIds];

  for (let i = 0; i < count; i++) {
    const res = await suggestForTurn({
      missionId,
      periodId: pCode,
      occurrenceId,
      startIso: range.start.toISOString(),
      endIso: range.end.toISOString(),
      targetTeamId,
      excludeIds: excluded
    });
    results.push(res);
    if (res.proposed) {
      excluded.push(res.proposed.id);
    }
  }
  return results;
}

function buildReason(candidate, isDue, due, targetTeam = null) {
  const parts = [];
  if (isDue) {
    parts.push(`${candidate.driver.name} هو صاحب الدور الحالي`);
  } else {
    parts.push(`${candidate.driver.name} هو البديل المتاح في الدور`);
    if (due) {
      parts.push(`${due.driver.name} (صاحب الدور) ${due.reasonAr}`);
    }
  }
  if (targetTeam && candidate.isSameTeam) {
    parts.push(`من أعضاء ${targetTeam.name}`);
  }
  if (candidate.lastDone) {
    parts.push(`آخر تنفيذ: ${relativeDay(candidate.lastDone.substring(0, 10))}`);
  } else {
    parts.push('لم يعمل هذه المهمة من قبل');
  }
  if (candidate.count > 0) parts.push(`${candidate.count} مرة سابقة`);
  if (candidate.restMinutes !== null && candidate.restMinutes !== undefined) {
    parts.push(`راحة ${fmtDurShort(candidate.restMinutes)}`);
  }
  return parts.join(' · ');
}

export async function commitExecution({
  assignmentId,
  occurrenceId,
  missionId,
  periodId = null,
  driverId,
  at = nowIso(),
  reason = ''
}) {
  requireWrite('assignment.execute');

  // 1. Validate and retrieve assignment
  let asg = null;
  if (assignmentId) {
    asg = await get('assignments', Number(assignmentId));
  }
  if (!asg && occurrenceId) {
    const list = await byIdx('assignments', 'occurrenceId', Number(occurrenceId));
    asg = list.find(a =>
      a.status !== ASG_STATUS.CANCELLED &&
      (periodId ? (String(a.periodId || '') === String(periodId) || String(a.periodCode || '') === String(periodId)) : true) &&
      (Number(a.actualDriverId || a.plannedDriverId) === Number(driverId) || !a.actualDriverId)
    );
  }

  const effectiveMissionId = Number(missionId || asg?.missionId);
  const effectivePeriodId = periodId ? String(periodId) : (asg?.periodId || asg?.periodCode || null);
  const effectiveOccurrenceId = occurrenceId ? Number(occurrenceId) : (asg?.occurrenceId ? Number(asg.occurrenceId) : null);
  const actualDriverId = Number(driverId);
  const dueDriverId = asg?.dueDriverId ? Number(asg.dueDriverId) : null;
  const isBorrowed = (asg?.source === DRIVER_SOURCE.BORROWED) || Boolean(asg?.loanId);
  const isOverride = Boolean(dueDriverId && dueDriverId !== actualDriverId);

  // 2. Update assignment status and execution details
  if (asg) {
    const updatedStatus = isOverride ? ASG_STATUS.OVERRIDDEN : ASG_STATUS.CONFIRMED;
    const patch = {
      ...asg,
      actualDriverId,
      status: updatedStatus,
      replacementReason: isOverride ? (asg.replacementReason || reason || 'تنفيذ بواسطة بديل') : null,
      executedAt: at,
      updatedAt: nowIso()
    };
    if (!patch.confirmedAt) patch.confirmedAt = at;
    await put('assignments', patch);
    asg = patch;
  }

  // 3. Update Turn Queue ONLY if NOT borrowed (Rule 12: borrowed driver does NOT alter permanent queue)
  if (!isBorrowed && effectiveMissionId) {
    await recordExecution({
      missionId: effectiveMissionId,
      periodId: effectivePeriodId,
      driverId: actualDriverId,
      at,
      assignmentId: asg?.id || null
    });
  }

  // 4. Handle Missed Turn for Due Driver if overridden/substitute
  if (isOverride && dueDriverId && effectiveMissionId) {
    const mission = await get('missions', effectiveMissionId);
    const policy = mission?.returnPolicy || MISSED_POLICY.RECLAIM;
    await recordMissed({
      driverId: dueDriverId,
      dueDriverId,
      plannedDriverId: asg?.plannedDriverId ? Number(asg.plannedDriverId) : actualDriverId,
      actualDriverId,
      missionId: effectiveMissionId,
      periodId: effectivePeriodId,
      occurrenceId: effectiveOccurrenceId,
      dateIso: asg?.startIso ? asg.startIso.slice(0, 10) : at.slice(0, 10),
      reason: asg?.replacementReason || reason || (isBorrowed ? 'استعارة سائق بديل لنقص في الفريق' : 'استبدال السائق في التنفيذ'),
      substitutedBy: actualDriverId,
      policy
    });
  }

  // 5. Resolve ONE FIFO missed turn for executing driver if they had an outstanding missed turn (Rule 10)
  if (effectiveMissionId) {
    try {
      await resolveMissedForDriver(actualDriverId, effectiveMissionId, effectivePeriodId);
    } catch (e) {}
  }

  // 6. Complete Loan if borrowed
  if (isBorrowed && asg?.loanId) {
    try {
      await completeLoan(asg.loanId, `تم التنفيذ بنجاح في ${at}`);
    } catch (e) {}
  }

  // 7. Audit
  await audit({
    entity: 'assignments',
    entityId: asg?.id || null,
    action: 'commit_execution',
    newValue: {
      missionId: effectiveMissionId,
      periodId: effectivePeriodId,
      occurrenceId: effectiveOccurrenceId,
      actualDriverId,
      dueDriverId,
      isBorrowed,
      isOverride,
      executedAt: at
    }
  });

  return asg;
}
