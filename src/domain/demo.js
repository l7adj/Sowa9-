import { all, put } from '../core/db.js';
import { nowIso, todayIso, toMin, fromMinSafe, buildStart, addMin } from '../core/clock.js';
import { requireWrite } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { SAMPLE_CATALOG, getMissionPeriods } from './missions.js';
import { createOccurrence } from './occurrences.js';
import { createAssignment, confirm, ASG_STATUS } from './assignments.js';
import { suggestForTurn, commitExecution } from '../engine/fairness.js';
import { recordMissed, MISSED_POLICY } from './missed-turns.js';
import { periodRange } from '../engine/shared-transport.js';

export async function isDatabaseEmpty() {
  const [drivers, missions] = await Promise.all([
    all('drivers'),
    all('missions')
  ]);
  return drivers.length === 0 && missions.length === 0;
}

export async function seedDemoDataset() {
  requireWrite('demo.seed');

  // 1. Teams
  let teams = await all('teams');
  if (teams.length === 0) {
    const defaultTeams = [
      { id: 1, name: 'فرقة أ — الميدانية', color: '#3b82f6', isDefault: true, createdAt: nowIso() },
      { id: 2, name: 'فرقة ب — الإسناد والنقل', color: '#10b981', isDefault: false, createdAt: nowIso() },
      { id: 3, name: 'فرقة ج — التدخل السريع', color: '#f59e0b', isDefault: false, createdAt: nowIso() }
    ];
    for (const t of defaultTeams) await put('teams', t);
    teams = await all('teams');
  }
  const teamA = teams[0] || { id: 1 };
  const teamB = teams[1] || { id: 2 };
  const teamC = teams[2] || { id: 3 };

  // 2. Drivers
  let drivers = await all('drivers');
  if (drivers.length === 0) {
    const demoDrivers = [
      { name: 'أحمد السائق (وزن خفيف)', phone: '0550112233', teamId: teamA.id, status: 'AVAILABLE', category: 'LIGHT' },
      { name: 'علي السائق (وزن خفيف)', phone: '0550223344', teamId: teamA.id, status: 'AVAILABLE', category: 'LIGHT' },
      { name: 'محمد السائق (وزن خفيف)', phone: '0550334455', teamId: teamA.id, status: 'AVAILABLE', category: 'LIGHT' },
      { name: 'عثمان السائق (وزن خفيف)', phone: '0550445566', teamId: teamA.id, status: 'VACATION', category: 'LIGHT' },
      { name: 'خالد السائق (نقل مشترك)', phone: '0560112233', teamId: teamB.id, status: 'AVAILABLE', category: 'SHARED' },
      { name: 'طارق السائق (نقل مشترك)', phone: '0560223344', teamId: teamB.id, status: 'AVAILABLE', category: 'SHARED' },
      { name: 'سالم السائق (نقل مشترك)', phone: '0560334455', teamId: teamB.id, status: 'AVAILABLE', category: 'SHARED' },
      { name: 'عمر السائق (شامل)', phone: '0570112233', teamId: teamC.id, status: 'AVAILABLE', category: 'ALL' },
      { name: 'سعيد السائق (شامل)', phone: '0570223344', teamId: teamC.id, status: 'AVAILABLE', category: 'ALL' }
    ];

    for (const d of demoDrivers) {
      await put('drivers', {
        ...d,
        active: true,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    drivers = await all('drivers');
  }

  // 3. Missions Catalog
  let missions = await all('missions');
  if (missions.length === 0) {
    for (const m of SAMPLE_CATALOG) {
      const periods = Array.isArray(m.periods) && m.periods.length > 0 ? m.periods : null;
      const totalDrivers = periods ? periods.reduce((s, p) => s + (Number(p.driversNeeded) || 1), 0) : (m.driversNeeded ?? 1);
      let assignedTeamId = teamA.id;
      if (['PATROL-12H', 'GARDEN', 'RAID'].includes(m.code)) assignedTeamId = teamB.id;
      if (['BAHJA', 'GUARD'].includes(m.code)) assignedTeamId = teamC.id;

      await put('missions', {
        code: m.code,
        name: m.name,
        type: m.type || (periods ? 'MULTI_SHIFT' : 'NORMAL'),
        startTime: m.startTime,
        durationMinutes: m.durationMinutes,
        driversNeeded: totalDrivers,
        locationType: m.locationType ?? 'outdoor',
        teamId: assignedTeamId,
        periods,
        notes: m.notes ?? '',
        isActive: true,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    missions = await all('missions');
  }

  // 4. Today's Operational Occurrences
  const today = todayIso();
  const existingOccurrences = await all('occurrences');
  const todayOccs = existingOccurrences.filter(o => o.dateIso === today && !o.cancelled);

  if (todayOccs.length === 0) {
    const workerMission = missions.find(m => m.code === 'WORKER-24H') || missions[0];
    const dunyaMission = missions.find(m => m.code === 'DUNYA') || missions[1];

    if (workerMission) {
      const occId = await createOccurrence({
        dateIso: today,
        missionId: workerMission.id,
        startTime: workerMission.startTime,
        durationMinutes: workerMission.durationMinutes
      });

      // Populate assignments for workerMission periods
      const periods = getMissionPeriods(workerMission);
      for (const p of periods) {
        const r = periodRange(p, today);
        const suggestion = await suggestForTurn({
          missionId: workerMission.id,
          periodId: p.code || p.id,
          occurrenceId: occId,
          startIso: r.start.toISOString(),
          endIso: r.end.toISOString(),
          targetTeamId: workerMission.teamId
        });

        if (suggestion.proposed) {
          const aid = await createAssignment({
            occurrenceId: occId,
            missionId: workerMission.id,
            periodId: p.code || p.id,
            periodCode: p.code || p.id,
            periodName: p.name,
            dueDriverId: suggestion.due?.id || suggestion.proposed.id,
            plannedDriverId: suggestion.proposed.id,
            startIso: r.start.toISOString(),
            endIso: r.end.toISOString(),
            rationale: suggestion.reason,
            autoConfirm: true
          });
        }
      }
    }

    if (dunyaMission) {
      const occId2 = await createOccurrence({
        dateIso: today,
        missionId: dunyaMission.id,
        startTime: dunyaMission.startTime,
        durationMinutes: dunyaMission.durationMinutes
      });

      const s = buildStart(today, dunyaMission.startTime);
      const e = addMin(s, dunyaMission.durationMinutes);
      const suggestion2 = await suggestForTurn({
        missionId: dunyaMission.id,
        periodId: 'DEFAULT',
        occurrenceId: occId2,
        startIso: s.toISOString(),
        endIso: e.toISOString(),
        targetTeamId: dunyaMission.teamId
      });

      if (suggestion2.proposed) {
        await createAssignment({
          occurrenceId: occId2,
          missionId: dunyaMission.id,
          periodId: 'DEFAULT',
          periodCode: 'DEFAULT',
          periodName: 'فترة التكليف',
          dueDriverId: suggestion2.due?.id || suggestion2.proposed.id,
          plannedDriverId: suggestion2.proposed.id,
          startIso: s.toISOString(),
          endIso: e.toISOString(),
          rationale: suggestion2.reason,
          autoConfirm: false // Keep as PROPOSED to demonstrate "Needs Confirmation" state!
        });
      }
    }
  }

  await audit({ entity: 'system', entityId: 1, action: 'seed_demo_dataset' });
  return true;
}
