import { all, get } from '../core/db.js';
import { buildStart, addMin, toMin } from '../core/clock.js';
import { ASG_STATUS } from './assignments.js';
import { getMissionPeriods } from './missions.js';

export async function driverIntervals(driverId) {
  const [assignments, occurrences, missions] = await Promise.all([
    all('assignments'),
    all('occurrences'),
    all('missions')
  ]);
  const occMap = new Map(occurrences.map(o => [o.id, o]));
  const misMap = new Map(missions.map(m => [m.id, m]));
  const out = [];

  for (const a of assignments) {
    if (a.status === ASG_STATUS.CANCELLED) continue;
    const did = a.actualDriverId || a.plannedDriverId;
    if (did !== Number(driverId)) continue;
    const o = occMap.get(a.occurrenceId);
    if (!o || o.cancelled) continue;

    let start = null;
    let end = null;

    if (a.startIso && a.endIso) {
      start = new Date(a.startIso);
      end = new Date(a.endIso);
    } else if (a.periodId || a.periodCode) {
      const m = misMap.get(o.missionId);
      const periods = getMissionPeriods(m);
      const p = periods.find(x => x.id === (a.periodId || a.periodCode) || x.code === (a.periodCode || a.periodId));
      if (p) {
        const [y, mm, d] = o.dateIso.split('-').map(Number);
        const [h, min] = p.startTime.split(':').map(Number);
        start = new Date(y, mm - 1, d + (p.dayOffset || 0), h, min, 0, 0);
        end = new Date(start.getTime() + p.durationMinutes * 60000);
      }
    }

    if (!start) {
      start = buildStart(o.dateIso, o.startTime);
      end = addMin(start, o.durationMinutes);
    }

    out.push({
      start,
      end,
      occurrenceId: o.id,
      missionId: o.missionId,
      dateIso: o.dateIso,
      periodId: a.periodId || a.periodCode || null,
      assignmentId: a.id
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

export async function restBefore(driverId, targetStart) {
  const iv = await driverIntervals(driverId);
  const before = iv.filter(x => x.end <= targetStart);
  if (!before.length) return null;
  const last = before[before.length - 1];
  const mins = Math.floor((targetStart - last.end) / 60000);
  return { last, minutes: mins };
}

export async function hasConflict(driverId, start, end) {
  const iv = await driverIntervals(driverId);
  for (const x of iv) {
    if (start < x.end && x.start < end) return true;
  }
  return false;
}

export async function restsBetween(driverId) {
  const iv = await driverIntervals(driverId);
  const out = [];
  for (let i = 0; i < iv.length - 1; i++) {
    const mins = Math.floor((iv[i + 1].start - iv[i].end) / 60000);
    if (mins > 0) out.push({ after: iv[i], before: iv[i + 1], minutes: mins });
  }
  return out;
}

export async function longestRest(driverId) {
  const rs = await restsBetween(driverId);
  if (!rs.length) return 0;
  return Math.max(...rs.map(r => r.minutes));
}
