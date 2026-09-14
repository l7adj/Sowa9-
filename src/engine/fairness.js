import { ensureQueue, getTurnInfo, recordExecution } from '../domain/turns.js';
import { listDrivers, STATUS, STATUS_AR } from '../domain/drivers.js';
import { listTeams } from '../domain/teams.js';
import { restBefore, hasConflict } from '../domain/rest.js';
import { listByOccurrence, ASG_STATUS } from '../domain/assignments.js';
import { getSetting } from '../core/auth.js';
import { fmtDurShort, relativeDay } from '../core/clock.js';
import { periodRange } from './shared-transport.js';
import { getMission } from '../domain/missions.js';

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
    isSameTeam: targetTeamId ? (driver.teamId === Number(targetTeamId)) : true,
    canBorrow: false
  };

  if (!driver) {
    e.reasonAr = 'غير موجود';
    return e;
  }
  if (excludeIds.includes(driver.id)) {
    e.reasonAr = 'مستبعد';
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
    if (!e.restOk) e.reasonAr = `راحة قصيرة (${fmtDurShort(rest.minutes)})`;
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

  const allIds = allDrivers.map(d => d.id);
  await ensureQueue(missionId, periodId, allIds);

  const info = await getTurnInfo(missionId, periodId);
  if (!info) {
    return {
      due: null, proposed: null, reason: 'تعذر تحميل قائمة الدور',
      queue: [], available: [], sameTeamAvailable: [], otherTeamsAvailable: [],
      blocked: [], missed: null, warning: null, isBorrow: false
    };
  }

  const evaluated = [];
  for (const item of info.queue) {
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
    evaluated.push({
      ...check,
      driver: item.driver,
      team: driverTeam,
      position: item.position,
      isDue: item.isDue,
      count: item.count,
      lastDone: item.lastDone
    });
  }

  const due = evaluated[0];
  const sameTeamAvailable = evaluated.filter(e => e.isAvailable && e.isSameTeam);
  const otherTeamsAvailable = evaluated.filter(e => e.isAvailable && !e.isSameTeam);
  const available = evaluated.filter(e => e.isAvailable);
  const blocked = evaluated.filter(e => !e.isAvailable);

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

  // Case 1: The designated due driver is available and belongs to the target team (or mission has no team restriction)
  if (due && due.isAvailable && (!effectiveTargetTeamId || due.isSameTeam)) {
    return {
      due: due.driver,
      proposed: due.driver,
      candidate: due,
      isBorrow: false,
      borrowFromTeam: null,
      reason: buildReason(due, true),
      queue: evaluated,
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

  // Case 2: Due driver is not available (or is external), but target team has other available drivers
  if (sameTeamAvailable.length > 0) {
    const internalCandidate = sameTeamAvailable[0];
    return {
      due: due?.driver || null,
      proposed: internalCandidate.driver,
      candidate: internalCandidate,
      isBorrow: false,
      borrowFromTeam: null,
      reason: buildReason(internalCandidate, false, due, targetTeam),
      queue: evaluated,
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
      queue: evaluated,
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
    queue: evaluated,
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

export async function commitExecution({ missionId, periodId = null, driverId, at, assignmentId }) {
  await recordExecution({ missionId, periodId, driverId, at, assignmentId });
}
