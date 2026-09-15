import { listByDate, createOccurrence, getOccurrence, updateOccurrence } from '../domain/occurrences.js';
import { listMissions, getMission, getMissionPeriods } from '../domain/missions.js';
import { listDrivers, STATUS, STATUS_AR, STATUS_COLOR } from '../domain/drivers.js';
import { listTeams } from '../domain/teams.js';
import { listByOccurrence, createProposal, confirm as confirmProposal, cancel as cancelAssignment, ASG_STATUS } from '../domain/assignments.js';
import { suggestForTurn, commitExecution } from '../engine/fairness.js';
import { listLoans, listActiveLoans, listUnresolvedShortages, recordShortage } from '../domain/loans.js';
import { isDatabaseEmpty, seedDemoDataset } from '../domain/demo.js';
import { periodRange } from '../engine/shared-transport.js';
import { isManager, isLeader } from '../core/auth.js';
import { sheet, toast, refresh, attachRipple, esc } from './helpers.js';
import {
  todayIso, addDays, humanDate, humanDateFull, dayNameAr, isToday,
  fmtDurShort, toMin, fromMinSafe, buildStart, addMin, nowIso
} from '../core/clock.js';
import { openNewLoanModal } from './views-loans.js';
import { openCreateOccurrenceModal } from './views-catalog.js';

let currentDate = todayIso();

export function getCurrentDate() {
  return currentDate;
}

export function setCurrentDate(d) {
  currentDate = d;
}

export async function renderHome(main) {
  const isMgr = isManager();
  const isEmpty = await isDatabaseEmpty();

  // If database is empty, present the explicit onboarding / demo prompt
  if (isEmpty) {
    main.innerHTML = `
      <div class="empty-block" style="padding:40px 20px;text-align:center;background:var(--surface-card);border:1px solid var(--line);border-radius:16px;margin:20px 0">
        <div style="font-size:48px;margin-bottom:12px">🚀</div>
        <h2 style="font-size:20px;font-weight:900;color:var(--text);margin-bottom:8px">مرحباً بك في Sowa9</h2>
        <p style="font-size:14px;color:var(--text-2);max-width:480px;margin:0 auto 20px;line-height:1.6">
          نظام تشغيل وإدارة مهام السواق التام. قاعدة البيانات جاهزة ونظيفة. يمكنك تفعيل بيانات تشغيلية تجريبية كاملة بنقرة واحدة لاختبار دورة العمل فوراً:
        </p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn-primary" id="btnSeedDemo" style="padding:12px 24px;font-size:14px;font-weight:800">
            ⚡ تفعيل البيانات التجريبية الشاملة (Demo)
          </button>
        </div>
      </div>
    `;

    main.querySelector('#btnSeedDemo')?.addEventListener('click', async () => {
      try {
        await seedDemoDataset();
        toast('تم تفعيل البيانات التجريبية الشاملة بنجاح!', 2500, 'success');
        refresh();
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    });
    return;
  }

  // Normal Operations Flow
  const [occurrences, missions, drivers, teams, activeLoans, unresolvedShortages] = await Promise.all([
    listByDate(currentDate),
    listMissions(true),
    listDrivers(),
    listTeams(),
    listActiveLoans(),
    listUnresolvedShortages()
  ]);

  const missionMap = new Map(missions.map(m => [m.id, m]));
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  const teamMap = new Map(teams.map(t => [t.id, t]));

  // Retrieve all assignments for today's occurrences
  const allAssignments = [];
  for (const occ of occurrences) {
    const asgs = await listByOccurrence(occ.id);
    for (const a of asgs) {
      allAssignments.push({ ...a, occurrenceId: occ.id });
    }
  }

  // Deconstruct occurrences into all operational periods for today
  const operationalPeriods = [];
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const occ of occurrences) {
    if (occ.cancelled) continue;
    const mis = missionMap.get(occ.missionId);
    if (!mis) continue;
    const periods = getMissionPeriods(mis);

    for (const p of periods) {
      const pCode = p.code || p.id;
      const r = periodRange(p, occ.dateIso);
      const asgs = allAssignments.filter(a =>
        a.occurrenceId === occ.id &&
        (a.periodId ? (String(a.periodId) === String(pCode)) : (String(a.periodCode || '') === String(pCode) || pCode === 'DEFAULT')) &&
        a.status !== ASG_STATUS.CANCELLED
      );

      const startMin = toMin(p.startTime);
      const dur = p.durationMinutes || 360;
      const endMin = startMin + dur;
      const needed = p.driversNeeded || 1;
      const shortageCount = Math.max(0, needed - asgs.length);

      // Check if period is active NOW
      const isTodayView = isToday(currentDate);
      let isActiveNow = false;
      let isUpcomingToday = false;

      if (isTodayView) {
        if (p.dayOffset === 0) {
          if (nowMinutes >= startMin && nowMinutes < endMin) isActiveNow = true;
          else if (nowMinutes < startMin) isUpcomingToday = true;
        } else {
          // next day offset period
          isUpcomingToday = true;
        }
      } else {
        isUpcomingToday = true;
      }

      operationalPeriods.push({
        occurrence: occ,
        mission: mis,
        period: p,
        periodCode: pCode,
        range: r,
        assignments: asgs,
        needed,
        shortageCount,
        isActiveNow,
        isUpcomingToday,
        startMin
      });
    }
  }

  // Sort periods chronologically
  operationalPeriods.sort((a, b) => a.startMin - b.startMin);

  // Group into Active Now and Upcoming
  const activeNowPeriods = operationalPeriods.filter(p => p.isActiveNow);
  const upcomingPeriods = operationalPeriods.filter(p => !p.isActiveNow && p.isUpcomingToday);

  // Active Drivers currently driving
  const drivingDriverIds = new Set();
  activeNowPeriods.forEach(p => {
    p.assignments.forEach(a => {
      const drId = a.actualDriverId || a.plannedDriverId;
      if (drId) drivingDriverIds.add(drId);
    });
  });

  const availableDrivers = drivers.filter(d => d.status === STATUS.AVAILABLE && !drivingDriverIds.has(d.id));
  const unavailableDrivers = drivers.filter(d => d.status !== STATUS.AVAILABLE);

  // Total shortages today
  const totalShortages = operationalPeriods.reduce((sum, p) => sum + p.shortageCount, 0);
  const needsActionCount = totalShortages + operationalPeriods.reduce((s, p) => s + p.assignments.filter(a => a.status === ASG_STATUS.PROPOSED).length, 0);

  main.innerHTML = `
    <!-- Operations Header Bar -->
    <div class="datebar" style="justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:center;gap:6px">
        <button class="nav" id="btnPrevDay" title="اليوم السابق">‹</button>
        <div class="info" id="btnPickDay" style="cursor:pointer">
          <div class="d1">${esc(humanDate(currentDate))}</div>
          <div class="d2">${esc(dayNameAr(currentDate))}</div>
        </div>
        <button class="today-btn ${!isToday(currentDate) ? 'show' : ''}" id="btnToday">اليوم</button>
        <button class="nav" id="btnNextDay" title="اليوم التالي">›</button>
      </div>

      ${isMgr ? `
        <button class="btn-primary" id="btnQuickCreateOcc" style="padding:6px 12px;font-size:12px;font-weight:700">
          + تشغيل مهمة
        </button>
      ` : ''}
    </div>

    ${isMgr ? '' : '<div class="readonly-banner">📖 عرض فقط — لا يمكنك تعديل التوزيعات أو تسجيل التنفيذ</div>'}

    <!-- Operations Pulse Metric Badges -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;margin-bottom:14px">
      <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">🔴</span>
        <div>
          <div style="font-size:11px;color:var(--text-3);font-weight:700">جارية الآن</div>
          <div style="font-size:18px;font-weight:900;color:${activeNowPeriods.length > 0 ? 'var(--danger,#ef4444)' : 'var(--text)'}">
            ${activeNowPeriods.length}
          </div>
        </div>
      </div>

      <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">⏳</span>
        <div>
          <div style="font-size:11px;color:var(--text-3);font-weight:700">قادمة اليوم</div>
          <div style="font-size:18px;font-weight:900;color:var(--text)">
            ${upcomingPeriods.length}
          </div>
        </div>
      </div>

      <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">👥</span>
        <div>
          <div style="font-size:11px;color:var(--text-3);font-weight:700">يقودون حالياً</div>
          <div style="font-size:18px;font-weight:900;color:var(--ok,#10b981)">
            ${drivingDriverIds.size}
          </div>
        </div>
      </div>

      <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">⚠️</span>
        <div>
          <div style="font-size:11px;color:var(--text-3);font-weight:700">تحتاج إجراء</div>
          <div style="font-size:18px;font-weight:900;color:${needsActionCount > 0 ? 'var(--warn,#f59e0b)' : 'var(--text)'}">
            ${needsActionCount}
          </div>
        </div>
      </div>

      <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">🔄</span>
        <div>
          <div style="font-size:11px;color:var(--text-3);font-weight:700">استعارات نشطة</div>
          <div style="font-size:18px;font-weight:900;color:var(--accent)">
            ${activeLoans.length}
          </div>
        </div>
      </div>
    </div>

    <!-- 1. ACTIVE NOW SECTION -->
    <div class="section" id="activeNowSection" style="margin-bottom:16px">
      <div class="section-head" style="background:var(--surface-2);border-radius:10px 10px 0 0">
        <div class="title" style="color:var(--danger,#ef4444);display:flex;align-items:center;gap:6px">
          <span>🔴</span>
          <span>الفترات الجارية الآن (ميدانياً)</span>
          <span class="count accent">${activeNowPeriods.length}</span>
        </div>
      </div>
      <div class="section-body" style="padding:10px">
        ${activeNowPeriods.length === 0 ? `
          <div style="text-align:center;padding:16px;color:var(--text-3);font-size:13px">
            لا توجد ورديات أو فترات نشطة في هذه اللحظة
          </div>
        ` : activeNowPeriods.map(op => renderOperationalPeriodCard(op, driverMap, teamMap, isMgr, true)).join('')}
      </div>
    </div>

    <!-- 2. UPCOMING TODAY SECTION -->
    <div class="section" id="upcomingSection" style="margin-bottom:16px">
      <div class="section-head" style="background:var(--surface-2);border-radius:10px 10px 0 0">
        <div class="title" style="display:flex;align-items:center;gap:6px">
          <span>⏳</span>
          <span>الفترات القادمة اليوم (جدول اليوم)</span>
          <span class="count">${upcomingPeriods.length}</span>
        </div>
      </div>
      <div class="section-body" style="padding:10px">
        ${upcomingPeriods.length === 0 ? `
          <div style="text-align:center;padding:16px;color:var(--text-3);font-size:13px">
            لا توجد فترات قادمة اليوم
          </div>
        ` : upcomingPeriods.map(op => renderOperationalPeriodCard(op, driverMap, teamMap, isMgr, false)).join('')}
      </div>
    </div>

    <!-- 3. DRIVERS FIELD READINESS -->
    <div class="section" id="driverReadinessSection" style="margin-bottom:16px">
      <div class="section-head" style="background:var(--surface-2);border-radius:10px 10px 0 0">
        <div class="title" style="display:flex;align-items:center;gap:6px">
          <span>👥</span>
          <span>جاهزية السواق والميدان (${drivers.length} سائق)</span>
        </div>
      </div>
      <div class="section-body" style="padding:12px">
        <!-- Driving Now -->
        <div style="margin-bottom:12px">
          <div style="font-size:12px;font-weight:700;color:var(--ok,#10b981);margin-bottom:6px">
            🟢 يقودون في الميدان الآن (${drivingDriverIds.size}):
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${drivingDriverIds.size === 0 ? '<span style="font-size:12px;color:var(--text-3)">لا أحد يقود حالياً</span>' : Array.from(drivingDriverIds).map(id => {
              const d = driverMap.get(id);
              const tm = teamMap.get(d?.teamId);
              return `
                <div class="tag" style="background:var(--ok,#10b981)22;color:var(--ok,#10b981);font-weight:700;padding:5px 10px;border-radius:8px">
                  ${esc(d?.name || '—')} ${tm ? `(${esc(tm.name)})` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Standby / Available -->
        <div style="margin-bottom:12px">
          <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:6px">
            ⚪ متاحون في وضع الاستعداد (${availableDrivers.length}):
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${availableDrivers.length === 0 ? '<span style="font-size:12px;color:var(--text-3)">لا يوجد سواق متاحون</span>' : availableDrivers.map(d => {
              const tm = teamMap.get(d.teamId);
              return `
                <div class="tag" style="background:var(--surface-2);color:var(--text);padding:4px 8px;border-radius:6px;font-size:11px">
                  ${esc(d.name)} ${tm ? `· ${esc(tm.name)}` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Unavailable -->
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--danger,#ef4444);margin-bottom:6px">
            🔴 غير متاحين حالياً (عطلة / غياب / عجز) (${unavailableDrivers.length}):
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${unavailableDrivers.length === 0 ? '<span style="font-size:12px;color:var(--text-3)">الجميع متاحون</span>' : unavailableDrivers.map(d => {
              return `
                <div class="tag" style="background:var(--danger,#ef4444)18;color:var(--danger,#ef4444);padding:4px 8px;border-radius:6px;font-size:11px">
                  ${esc(d.name)} (${STATUS_AR[d.status] || d.status})
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach event handlers
  main.querySelector('#btnPrevDay').onclick = () => { currentDate = addDays(currentDate, -1); refresh(); };
  main.querySelector('#btnNextDay').onclick = () => { currentDate = addDays(currentDate, 1); refresh(); };
  main.querySelector('#btnToday').onclick = () => { currentDate = todayIso(); refresh(); };
  main.querySelector('#btnPickDay').onclick = () => {
    const d = prompt('أدخل التاريخ المطلوب (YYYY-MM-DD):', currentDate);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { currentDate = d; refresh(); }
  };

  main.querySelector('#btnQuickCreateOcc')?.addEventListener('click', () => {
    openCreateOccurrenceModal();
  });

  // Wire period assignment action buttons
  main.querySelectorAll('[data-op-suggest]').forEach(btn => {
    btn.onclick = async () => {
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occid = Number(btn.dataset.occid);
      const startIso = btn.dataset.start;
      const endIso = btn.dataset.end;
      const teamId = Number(btn.dataset.teamid) || null;

      try {
        const res = await suggestForTurn({
          missionId: mid,
          periodId: pcode,
          occurrenceId: occid,
          startIso,
          endIso,
          targetTeamId: teamId
        });

        if (!res.proposed) {
          return toast('لا يوجد أي سائق متاح حالياً! يرجى الاستعارة لحل النقص.', 3000, 'error');
        }

        if (res.isBorrow) {
          openNewLoanModal({
            occurrenceId: occid,
            missionId: mid,
            periodId: pcode,
            driverId: res.proposed.id,
            toTeamId: teamId,
            fromTeamId: res.borrowFromTeam?.id || res.proposed.teamId,
            dateIso: currentDate,
            notes: res.reason
          });
          return;
        }

        // Create assignment proposal
        await createProposal({
          occurrenceId: occid,
          missionId: mid,
          periodId: pcode,
          periodCode: pcode,
          dueDriverId: res.due?.id || res.proposed.id,
          plannedDriverId: res.proposed.id,
          startIso,
          endIso,
          rationale: res.reason,
          autoConfirm: true // auto confirm turn suggestion
        });

        toast(`تم تعيين ${res.proposed.name} وفق الدور العادل`, 2200, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('[data-op-borrow]').forEach(btn => {
    btn.onclick = () => {
      openNewLoanModal({
        occurrenceId: Number(btn.dataset.occid),
        missionId: Number(btn.dataset.mid),
        periodId: btn.dataset.pcode,
        dateIso: currentDate
      });
    };
  });

  main.querySelectorAll('[data-op-commit]').forEach(btn => {
    btn.onclick = async () => {
      const asgId = Number(btn.dataset.asgid);
      const drId = Number(btn.dataset.drid);
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occid = Number(btn.dataset.occid);

      try {
        await commitExecution({
          assignmentId: asgId,
          occurrenceId: occid,
          missionId: mid,
          periodId: pcode,
          driverId: drId
        });
        toast('تم تسجيل التنفيذ الفعلي وتحديث الدور بنجاح', 2200, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('[data-op-confirm]').forEach(btn => {
    btn.onclick = async () => {
      const asgId = Number(btn.dataset.asgid);
      try {
        await confirmProposal(asgId, 'تأكيد من شاشة العمليات');
        toast('تم تأكيد التوزيع', 2200, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('[data-op-remove]').forEach(btn => {
    btn.onclick = async () => {
      const asgId = Number(btn.dataset.asgid);
      if (!window.confirm('هل تريد إلغاء هذا التوزيع؟')) return;
      try {
        await cancelAssignment(asgId, 'إلغاء يدوي من العمليات');
        toast('تم إلغاء التوزيع', 2200, 'warn');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('.btn-primary, .btn-ghost, .tag').forEach(attachRipple);
}

function renderOperationalPeriodCard(op, driverMap, teamMap, isMgr, isActiveNow) {
  const { occurrence: occ, mission: m, period: p, periodCode, range, assignments, needed, shortageCount } = op;
  const startStr = p.startTime;
  const endStr = fromMinSafe(toMin(p.startTime) + (p.durationMinutes || 360));
  const team = teamMap.get(m.teamId);

  return `
    <div class="period-op-card" style="background:var(--surface-card);border:1px solid ${isActiveNow ? 'var(--danger,#ef4444)' : 'var(--line)'};border-radius:10px;padding:12px;margin-bottom:10px">
      <!-- Period Header -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${isActiveNow ? '<span class="tag danger" style="font-weight:800">🔴 جارية الآن</span>' : ''}
            <span style="font-size:14px;font-weight:800;color:var(--text)">${esc(m.name)}</span>
            <span class="tag" style="font-size:11px;font-weight:700">${esc(p.name)}</span>
            ${p.track ? `<span class="tag" style="font-size:10px">${esc(p.track)}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px">
            ⏱ <b>${esc(startStr)} → ${esc(endStr)}</b> (${fmtDurShort(p.durationMinutes)}) ·
            المطلوب: <b>${needed} سواق</b> ${team ? `· التابع لـ ${esc(team.name)}` : ''}
          </div>
        </div>

        <div>
          <span class="tag ${shortageCount === 0 ? 'ok' : 'warn'}" style="font-weight:800;font-size:11px">
            ${assignments.length}/${needed} سواق
          </span>
        </div>
      </div>

      <!-- Assignments List -->
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        ${assignments.map(a => {
          const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
          const dueDr = driverMap.get(a.dueDriverId);
          const isSub = a.dueDriverId && Number(a.dueDriverId) !== Number(a.actualDriverId || a.plannedDriverId);
          const isBorrowed = a.source === 'BORROWED' || Boolean(a.loanId);
          const isConfirmed = a.status === ASG_STATUS.CONFIRMED || a.status === ASG_STATUS.OVERRIDDEN;
          const isExecuted = Boolean(a.executedAt);

          return `
            <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-2);padding:8px 10px;border-radius:8px;gap:8px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:8px">
                <div class="av ${isBorrowed ? 'borrowed' : isSub ? 'sub' : 'ok'}" style="width:32px;height:32px;font-size:12px;font-weight:800">
                  ${esc((dr?.name || '؟').charAt(0))}
                </div>
                <div>
                  <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px">
                    <span>${esc(dr?.name || 'غير معروف')}</span>
                    ${isExecuted ? '<span class="tag ok" style="font-size:10px">✓ نُفّذت</span>' : ''}
                    ${!isExecuted && isConfirmed ? '<span class="tag info" style="font-size:10px">مؤكد</span>' : ''}
                    ${!isConfirmed ? '<span class="tag warn" style="font-size:10px">بانتظار التأكيد</span>' : ''}
                    ${isBorrowed ? '<span class="tag borrowed" style="font-size:10px">🔄 مستعار</span>' : ''}
                  </div>
                  <div style="font-size:11px;color:var(--text-3);margin-top:2px">
                    ${dueDr ? `صاحب الدور الشرعي: <b>${esc(dueDr.name)}</b>` : 'الدور الأصلي'}
                    ${isSub ? `<span style="color:var(--warn,#f59e0b)"> (بديل: ${esc(a.replacementReason || 'تعويض')})</span>` : ''}
                  </div>
                </div>
              </div>

              ${isMgr ? `
                <div style="display:flex;gap:4px;align-items:center">
                  ${!isExecuted ? `
                    <button class="tag ok" data-op-commit="1" data-asgid="${a.id}" data-drid="${dr?.id}" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" style="cursor:pointer;border:0;font-weight:700;padding:4px 8px">
                      🏁 تسجيل التنفيذ
                    </button>
                  ` : ''}
                  ${!isConfirmed ? `
                    <button class="tag info" data-op-confirm="1" data-asgid="${a.id}" style="cursor:pointer;border:0;font-weight:700;padding:4px 8px">
                      ✅ تأكيد
                    </button>
                  ` : ''}
                  <button class="x" data-op-remove="1" data-asgid="${a.id}" title="إلغاء التوزيع">✕</button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>

      <!-- Shortage Warning and Action Buttons -->
      ${shortageCount > 0 ? `
        <div style="margin-top:8px;padding:8px 10px;background:var(--danger,#ef4444)14;border:1px dashed var(--danger,#ef4444)44;border-radius:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div>
            <div style="font-weight:700;font-size:12px;color:var(--danger,#ef4444)">
              ⚠️ عجز بمقدار ${shortageCount} سائق في هذه الفترة!
            </div>
          </div>
          ${isMgr ? `
            <div style="display:flex;gap:6px">
              <button class="tag" data-op-suggest="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-teamid="${m.teamId || ''}" style="cursor:pointer;background:var(--color-accent);color:#fff;border:0;font-weight:700;padding:4px 10px">
                💡 اقتراح بالدور العادل
              </button>
              <button class="tag borrowed" data-op-borrow="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" style="cursor:pointer;border:0;font-weight:700;padding:4px 10px">
                🔄 استعارة من فرقة
              </button>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}
