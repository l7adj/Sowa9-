import { listByDate, createOccurrence, getOccurrence, updateOccurrence } from '../domain/occurrences.js';
import { listMissions, getMission, getMissionPeriods } from '../domain/missions.js';
import { listDrivers, STATUS, STATUS_AR, STATUS_COLOR, DRIVER_CATEGORY, DRIVER_CATEGORY_AR } from '../domain/drivers.js';
import { listTeams } from '../domain/teams.js';
import {
  listByOccurrence, createProposal, confirm as confirmProposal,
  cancel as cancelAssignment, updateAssignmentTiming, ASG_STATUS
} from '../domain/assignments.js';
import { suggestForTurn, commitExecution } from '../engine/fairness.js';
import { listLoans, listActiveLoans, listUnresolvedShortages, recordShortage } from '../domain/loans.js';
import { isDatabaseEmpty, seedDemoDataset } from '../domain/demo.js';
import { periodRange } from '../engine/shared-transport.js';
import { isManager, isLeader, requireWrite, getSession } from '../core/auth.js';
import { sheet, toast, refresh, attachRipple, esc } from './helpers.js';
import {
  todayIso, addDays, humanDate, humanDateFull, dayNameAr, isToday,
  fmtDurShort, toMin, fromMinSafe, buildStart, addMin, nowIso, calcDuration
} from '../core/clock.js';
import { openNewLoanModal } from './views-loans.js';
import { openCreateOccurrenceModal } from './views-catalog.js';

let currentDate = todayIso();
// Modes: 'LIGHT' (الوزن الخفيف) | 'SHARED' (النقل المشترك) | 'DRIVERS_ROSTER' (جدول مهام السواق) | 'ALL' (عرض الكل)
let activeOpsFilter = 'LIGHT';
let driverSearchQuery = '';

export function getCurrentDate() {
  return currentDate;
}

export function setCurrentDate(d) {
  currentDate = d;
}

export async function renderHome(main) {
  const isMgr = isManager();
  const sess = getSession();
  const isDriverRole = sess?.role === 'DRIVER';

  // If driver role, default directly to Driver Schedule if not set
  if (isDriverRole && activeOpsFilter !== 'DRIVERS_ROSTER') {
    activeOpsFilter = 'DRIVERS_ROSTER';
  }

  const isEmpty = await isDatabaseEmpty();

  // If database is empty, present demo onboarding prompt
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

  // Load Operations Data
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
      allAssignments.push({ ...a, occurrenceId: occ.id, missionId: occ.missionId });
    }
  }

  // Split drivers strictly by category: NO cross-comparison!
  const lightDrivers = drivers.filter(d => (d.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.LIGHT);
  const sharedDrivers = drivers.filter(d => d.category === DRIVER_CATEGORY.SHARED);

  // Deconstruct occurrences into all operational periods for selected date
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

      const isTodayView = isToday(currentDate);
      let isActiveNow = false;
      let isUpcomingToday = false;

      if (isTodayView) {
        if (p.dayOffset === 0) {
          if (nowMinutes >= startMin && nowMinutes < endMin) isActiveNow = true;
          else if (nowMinutes < startMin) isUpcomingToday = true;
        } else {
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
        startMin,
        category: mis.driverCategory || p.driverCategory || DRIVER_CATEGORY.LIGHT
      });
    }
  }

  operationalPeriods.sort((a, b) => a.startMin - b.startMin);

  // Filter periods strictly according to squad selection
  const lightPeriods = operationalPeriods.filter(op => op.category === DRIVER_CATEGORY.LIGHT);
  const sharedPeriods = operationalPeriods.filter(op => op.category === DRIVER_CATEGORY.SHARED);

  let displayedPeriods = operationalPeriods;
  if (activeOpsFilter === 'LIGHT') {
    displayedPeriods = lightPeriods;
  } else if (activeOpsFilter === 'SHARED') {
    displayedPeriods = sharedPeriods;
  }

  const activeNowPeriods = displayedPeriods.filter(p => p.isActiveNow);
  const upcomingPeriods = displayedPeriods.filter(p => !p.isActiveNow && p.isUpcomingToday);

  // Active drivers currently driving
  const drivingDriverIds = new Set();
  operationalPeriods.filter(p => p.isActiveNow).forEach(p => {
    p.assignments.forEach(a => {
      const drId = a.actualDriverId || a.plannedDriverId;
      if (drId) drivingDriverIds.add(drId);
    });
  });

  // Category specific active drivers
  const squadDrivers = activeOpsFilter === 'SHARED' ? sharedDrivers : activeOpsFilter === 'LIGHT' ? lightDrivers : drivers;
  const squadAvailable = squadDrivers.filter(d => d.status === STATUS.AVAILABLE && !drivingDriverIds.has(d.id));
  const squadUnavailable = squadDrivers.filter(d => d.status !== STATUS.AVAILABLE);
  const squadDrivingNow = squadDrivers.filter(d => drivingDriverIds.has(d.id));

  // Quick navigation dates
  const yesterday = addDays(currentDate, -1);
  const tomorrow = addDays(currentDate, 1);

  main.innerHTML = `
    <!-- 1. PROMINENT OPERATIONAL DATE COMMAND BANNER -->
    <div class="card" style="padding:16px 20px;margin-bottom:14px;border:1px solid var(--line);background:var(--surface-card)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap">
        <div>
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
            <span style="font-size:24px;font-weight:900;color:var(--text)">${dayNameAr(currentDate)}</span>
            <span style="font-size:18px;font-weight:800;color:var(--text-2)">${humanDate(currentDate)}</span>
            <span style="font-size:13px;color:var(--text-3);font-family:monospace;background:var(--surface-2);padding:2px 8px;border-radius:6px">${currentDate}</span>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-top:4px">
            لوحة قيادة فرقة السواق · ${isToday(currentDate) ? '⚡ العمليات الميدانية لليوم الحالي' : '📅 جدول تشغيل يوم ' + dayNameAr(currentDate)}
          </div>
        </div>

        <!-- Date Controls: Clear Day Switching & Direct Calendar Picker -->
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="nav" id="btnPrevDay" title="اليوم السابق" style="padding:8px 14px;font-weight:800;font-size:13px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);cursor:pointer">
            ‹ اليوم السابق
          </button>
          <button type="button" class="filter-pill ${isToday(currentDate) ? 'active' : ''}" id="btnNavToday" style="padding:8px 14px;font-size:13px">
            اليوم
          </button>
          <button type="button" class="filter-pill ${currentDate === tomorrow ? 'active' : ''}" id="btnNavTomorrow" style="padding:8px 14px;font-size:13px">
            غداً
          </button>
          <button class="nav" id="btnNextDay" title="اليوم التالي" style="padding:8px 14px;font-weight:800;font-size:13px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);cursor:pointer">
            اليوم التالي ›
          </button>

          <!-- Direct Date Picker (No Prompts, Instant Change) -->
          <div style="display:flex;align-items:center;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:2px 8px" title="اختر أي تاريخ بالتقويم">
            <span style="font-size:14px;margin-left:4px">📅</span>
            <input type="date" id="directDateInput" value="${currentDate}" style="border:0;background:transparent;font-weight:700;font-size:13px;color:var(--text);cursor:pointer;outline:none;font-family:inherit">
          </div>
        </div>
      </div>
    </div>

    ${isMgr ? '' : '<div class="readonly-banner">📖 وضع العرض — مهام وجداول السواق الميدانية</div>'}

    <!-- 2. SQUAD COMMAND TABS (STRICT SEPARATION: LIGHT vs SHARED vs DRIVER ROSTER) -->
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="filter-pill ${activeOpsFilter === 'LIGHT' ? 'active' : ''}" data-ops-filter="LIGHT" style="padding:10px 18px;font-size:13px;font-weight:800">
          🚗 فرقة سواق الوزن الخفيف (${lightPeriods.length} مهمة)
        </button>
        <button type="button" class="filter-pill ${activeOpsFilter === 'SHARED' ? 'active' : ''}" data-ops-filter="SHARED" style="padding:10px 18px;font-size:13px;font-weight:800">
          🚌 فرقة سواق النقل المشترك (${sharedPeriods.length} مهمة)
        </button>
        <button type="button" class="filter-pill ${activeOpsFilter === 'DRIVERS_ROSTER' ? 'active' : ''}" data-ops-filter="DRIVERS_ROSTER" style="padding:10px 18px;font-size:13px;font-weight:800;background:${activeOpsFilter === 'DRIVERS_ROSTER' ? 'var(--color-primary)' : 'var(--surface-card)'}">
          👤 جدول مهام السواق (الميداني)
        </button>
        <button type="button" class="filter-pill ${activeOpsFilter === 'ALL' ? 'active' : ''}" data-ops-filter="ALL" style="padding:10px 14px;font-size:12px">
          📋 عرض الكل (${operationalPeriods.length})
        </button>
      </div>

      ${isMgr ? `
        <button class="btn-primary" id="btnQuickCreateOcc" style="padding:8px 16px;font-size:12px;font-weight:800;display:flex;align-items:center;gap:6px">
          <span>🚀</span>
          <span>استوديو تشغيل مهمة</span>
        </button>
      ` : ''}
    </div>

    <!-- MAIN BODY BASED ON ACTIVE MODE -->
    ${activeOpsFilter === 'DRIVERS_ROSTER' ? renderDriverRosterView({
      drivers,
      lightDrivers,
      sharedDrivers,
      allAssignments,
      missionMap,
      teamMap,
      currentDate,
      isMgr
    }) : `
      <!-- Squad Pulse Metrics -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(135px, 1fr));gap:8px;margin-bottom:14px">
        <div style="background:var(--surface-card);border:1px solid ${activeNowPeriods.length > 0 ? 'var(--danger,#ef4444)' : 'var(--line)'};border-radius:12px;padding:12px;display:flex;align-items:center;gap:10px">
          <span style="font-size:24px">🔴</span>
          <div>
            <div style="font-size:11px;color:var(--text-3);font-weight:700">جارية بالميدان الآن</div>
            <div style="font-size:20px;font-weight:900;color:${activeNowPeriods.length > 0 ? 'var(--danger,#ef4444)' : 'var(--text)'}">
              ${activeNowPeriods.length}
            </div>
          </div>
        </div>

        <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;align-items:center;gap:10px">
          <span style="font-size:24px">⏳</span>
          <div>
            <div style="font-size:11px;color:var(--text-3);font-weight:700">قادمة اليوم</div>
            <div style="font-size:20px;font-weight:900;color:var(--text)">
              ${upcomingPeriods.length}
            </div>
          </div>
        </div>

        <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;align-items:center;gap:10px">
          <span style="font-size:24px">👥</span>
          <div>
            <div style="font-size:11px;color:var(--text-3);font-weight:700">يقودون حالياً</div>
            <div style="font-size:20px;font-weight:900;color:var(--ok,#10b981)">
              ${squadDrivingNow.length}
            </div>
          </div>
        </div>

        <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;align-items:center;gap:10px">
          <span style="font-size:24px">⚪</span>
          <div>
            <div style="font-size:11px;color:var(--text-3);font-weight:700">سواق جاهزون</div>
            <div style="font-size:20px;font-weight:900;color:var(--text)">
              ${squadAvailable.length}
            </div>
          </div>
        </div>
      </div>

      <!-- ACTIVE NOW MISSIONS -->
      <div class="section" style="margin-bottom:16px">
        <div class="section-head" style="background:var(--surface-2);border-radius:12px 12px 0 0;padding:12px 14px">
          <div class="title" style="color:var(--danger,#ef4444);display:flex;align-items:center;gap:8px">
            <span style="font-size:16px">🔴</span>
            <span style="font-weight:800;font-size:14px">المهام الجارية الآن بالميدان</span>
            <span class="count accent">${activeNowPeriods.length}</span>
          </div>
        </div>
        <div class="section-body" style="padding:12px">
          ${activeNowPeriods.length === 0 ? `
            <div style="text-align:center;padding:22px;color:var(--text-3);font-size:13px;background:var(--surface-card);border:1px dashed var(--line);border-radius:10px">
              لا توجد مهام جارية في هذه اللحظة لهذه الفرقة
            </div>
          ` : activeNowPeriods.map(op => renderOperationalPeriodCard(op, driverMap, teamMap, isMgr, true)).join('')}
        </div>
      </div>

      <!-- UPCOMING TODAY MISSIONS -->
      <div class="section" style="margin-bottom:16px">
        <div class="section-head" style="background:var(--surface-2);border-radius:12px 12px 0 0;padding:12px 14px">
          <div class="title" style="display:flex;align-items:center;gap:8px">
            <span style="font-size:16px">⏳</span>
            <span style="font-weight:800;font-size:14px">المهام القادمة (جدول اليوم)</span>
            <span class="count">${upcomingPeriods.length}</span>
          </div>
        </div>
        <div class="section-body" style="padding:12px">
          ${upcomingPeriods.length === 0 ? `
            <div style="text-align:center;padding:22px;color:var(--text-3);font-size:13px;background:var(--surface-card);border:1px dashed var(--line);border-radius:10px">
              لا توجد مهام قادمة لليوم المحدد لهذه الفرقة
            </div>
          ` : upcomingPeriods.map(op => renderOperationalPeriodCard(op, driverMap, teamMap, isMgr, false)).join('')}
        </div>
      </div>

      <!-- SQUAD DRIVERS FIELD READINESS (FILTERED TO THIS SQUAD ONLY) -->
      <div class="section" style="margin-bottom:16px">
        <div class="section-head" style="background:var(--surface-2);border-radius:12px 12px 0 0;padding:12px 14px">
          <div class="title" style="display:flex;align-items:center;gap:8px">
            <span style="font-size:16px">${activeOpsFilter === 'SHARED' ? '🚌' : '🚗'}</span>
            <span style="font-weight:800;font-size:14px">جاهزية سواق ${activeOpsFilter === 'SHARED' ? 'فرقة النقل المشترك' : 'فرقة الوزن الخفيف'} (${squadDrivers.length} سائق)</span>
          </div>
        </div>
        <div class="section-body" style="padding:14px">
          <!-- Driving Now -->
          <div style="margin-bottom:12px">
            <div style="font-size:12px;font-weight:800;color:var(--ok,#10b981);margin-bottom:6px">
              🟢 يقودون في الميدان الآن (${squadDrivingNow.length}):
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${squadDrivingNow.length === 0 ? '<span style="font-size:12px;color:var(--text-3)">لا أحد يقود حالياً</span>' : squadDrivingNow.map(d => {
                const tm = teamMap.get(d.teamId);
                return `
                  <div class="tag" style="background:var(--ok,#10b981)22;color:var(--ok,#10b981);font-weight:800;padding:6px 12px;border-radius:8px;font-size:12px;display:flex;align-items:center;gap:6px">
                    <span>${d.category === DRIVER_CATEGORY.SHARED ? '🚌' : '🚗'}</span>
                    <span>${esc(d.name)}</span>
                    ${tm ? `<span style="opacity:0.8">(${esc(tm.name)})</span>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Standby / Available -->
          <div style="margin-bottom:12px">
            <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:6px">
              ⚪ متاحون في وضع الاستعداد (${squadAvailable.length}):
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${squadAvailable.length === 0 ? '<span style="font-size:12px;color:var(--text-3)">لا يوجد سواق متاحون في هذه الفرقة</span>' : squadAvailable.map(d => {
                const tm = teamMap.get(d.teamId);
                return `
                  <div class="tag" style="background:var(--surface-2);color:var(--text);padding:5px 10px;border-radius:8px;font-size:11px;display:flex;align-items:center;gap:5px">
                    <span>${d.category === DRIVER_CATEGORY.SHARED ? '🚌' : '🚗'}</span>
                    <b>${esc(d.name)}</b>
                    ${tm ? `<span style="color:var(--text-3)">· ${esc(tm.name)}</span>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Unavailable -->
          <div>
            <div style="font-size:12px;font-weight:800;color:var(--danger,#ef4444);margin-bottom:6px">
              🔴 غير متاحين حالياً (${squadUnavailable.length}):
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${squadUnavailable.length === 0 ? '<span style="font-size:12px;color:var(--text-3)">الجميع متاحون</span>' : squadUnavailable.map(d => {
                return `
                  <div class="tag" style="background:var(--danger,#ef4444)18;color:var(--danger,#ef4444);padding:5px 10px;border-radius:8px;font-size:11px">
                    ${esc(d.name)} (${STATUS_AR[d.status] || d.status})
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    `}
  `;

  // Attach Event Handlers
  main.querySelector('#btnPrevDay').onclick = () => { currentDate = addDays(currentDate, -1); refresh(); };
  main.querySelector('#btnNextDay').onclick = () => { currentDate = addDays(currentDate, 1); refresh(); };
  main.querySelector('#btnNavToday').onclick = () => { currentDate = todayIso(); refresh(); };
  main.querySelector('#btnNavTomorrow').onclick = () => { currentDate = tomorrow; refresh(); };

  // Direct Date Picker Change
  const datePicker = main.querySelector('#directDateInput');
  if (datePicker) {
    datePicker.onchange = (e) => {
      if (e.target.value) {
        currentDate = e.target.value;
        refresh();
      }
    };
  }

  // Quick studio
  main.querySelector('#btnQuickCreateOcc')?.addEventListener('click', () => {
    openCreateOccurrenceModal();
  });

  // Squad selection tabs
  main.querySelectorAll('[data-ops-filter]').forEach(btn => {
    btn.onclick = () => {
      activeOpsFilter = btn.dataset.opsFilter;
      renderHome(main);
    };
  });

  // Search input in Driver Schedule view
  const searchInput = main.querySelector('#driverSearchInput');
  if (searchInput) {
    searchInput.oninput = (e) => {
      driverSearchQuery = e.target.value.toLowerCase().trim();
      const cards = main.querySelectorAll('.driver-roster-card');
      cards.forEach(card => {
        const name = card.dataset.driverName || '';
        if (!driverSearchQuery || name.includes(driverSearchQuery)) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    };
  }

  // Wire Smart Turn Suggestions with strict category enforcement
  main.querySelectorAll('[data-op-suggest]').forEach(btn => {
    btn.onclick = async () => {
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occid = Number(btn.dataset.occid);
      const startIso = btn.dataset.start;
      const endIso = btn.dataset.end;
      const teamId = Number(btn.dataset.teamid) || null;
      const reqCat = btn.dataset.reqcat || DRIVER_CATEGORY.LIGHT;

      try {
        const res = await suggestForTurn({
          missionId: mid,
          periodId: pcode,
          occurrenceId: occid,
          startIso,
          endIso,
          targetTeamId: teamId,
          requiredCategory: reqCat
        });

        if (!res.proposed) {
          toast(res.reason || 'لا يوجد سائق متاح حالياً مطابق للصنف', 3000, 'error');
          return;
        }

        const catName = (res.proposed.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.SHARED ? 'نقل مشترك' : 'وزن خفيف';
        const msg = `اقتراح السائق المستحق بالدور: ${res.proposed.name} (${catName})\n\nالتعليل: ${res.reason}\n\nهل تريد تأكيد التعيين في المهمة؟`;
        if (window.confirm(msg)) {
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
            autoConfirm: true
          });
          toast(`تم تعيين ${res.proposed.name} بنجاح!`, 2200, 'success');
          refresh();
        }
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  // Wire manual driver assignment modal (strictly category isolated)
  main.querySelectorAll('[data-op-assign-manual]').forEach(btn => {
    btn.onclick = () => {
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occid = Number(btn.dataset.occid);
      const startStr = btn.dataset.start;
      const endStr = btn.dataset.end;
      const reqCat = btn.dataset.reqcat || DRIVER_CATEGORY.LIGHT;

      openAssignDriverModal({
        missionId: mid,
        periodCode: pcode,
        occurrenceId: occid,
        defaultStart: startStr,
        defaultEnd: endStr,
        requiredCategory: reqCat,
        drivers,
        teams
      });
    };
  });

  // Wire driver timing edit modal
  main.querySelectorAll('[data-op-edit-timing]').forEach(btn => {
    btn.onclick = () => {
      const asgId = Number(btn.dataset.asgid);
      const drName = btn.dataset.drname;
      const startStr = btn.dataset.start;
      const endStr = btn.dataset.end;

      openEditDriverTimingModal({
        assignmentId: asgId,
        driverName: drName,
        currentStart: startStr,
        currentEnd: endStr
      });
    };
  });

  // Wire commit execution
  main.querySelectorAll('[data-op-commit]').forEach(btn => {
    btn.onclick = async () => {
      const asgId = Number(btn.dataset.asgid);
      const drId = Number(btn.dataset.drid);
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occId = Number(btn.dataset.occid);

      if (!window.confirm('هل تود تأكيد وتسجيل تنفيذ السائق لهذه المهمة ميدانياً؟')) return;

      try {
        await commitExecution({
          assignmentId: asgId,
          occurrenceId: occId,
          missionId: mid,
          periodId: pcode,
          actualDriverId: drId
        });
        toast('تم تسجيل التنفيذ بنجاح واحتساب الدور والراحة!', 2500, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  // Wire confirm assignment
  main.querySelectorAll('[data-op-confirm]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await confirmProposal(Number(btn.dataset.asgid));
        toast('تم تأكيد التكليف بنجاح', 2000, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  // Wire remove assignment
  main.querySelectorAll('[data-op-remove]').forEach(btn => {
    btn.onclick = async () => {
      if (!window.confirm('هل تريد إلغاء تكليف هذا السائق من المهمة؟')) return;
      try {
        await cancelAssignment(Number(btn.dataset.asgid), 'إلغاء يدوي من لوحة العمليات');
        toast('تم إلغاء التعيين بنجاح', 2000, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('.btn-primary, .btn-ghost, .tag, .filter-pill').forEach(attachRipple);
}

// ═══════════════════════════════════════
// Driver Schedule View ("وتظهر مهام السواق للسواق")
// ═══════════════════════════════════════
function renderDriverRosterView({ drivers, lightDrivers, sharedDrivers, allAssignments, missionMap, teamMap, currentDate, isMgr }) {
  return `
    <div class="card" style="padding:16px;margin-bottom:16px;border:1px solid var(--line);background:var(--surface-card)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:16px;font-weight:900;margin:0;color:var(--text)">جدول مهام السواق الميداني</h3>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">
            استعراض المهام المجدولة لكل سائق، أوقات البداية والنهاية، وحالة التنفيذ
          </div>
        </div>

        <div style="width:260px">
          <input type="text" id="driverSearchInput" class="input" placeholder="🔍 ابحث عن اسم السائق..." style="width:100%;padding:8px 12px;font-size:12px">
        </div>
      </div>

      <!-- Two Separate Squad Sections -->
      <!-- 1. SQUAD LIGHT DRIVERS -->
      <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid var(--line)">
          <span style="font-size:18px">🚗</span>
          <span style="font-weight:900;font-size:14px;color:var(--text)">فرقة سواق الوزن الخفيف (${lightDrivers.length} سائق)</span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:10px">
          ${lightDrivers.map(d => renderSingleDriverCard(d, allAssignments, missionMap, teamMap, isMgr)).join('')}
        </div>
      </div>

      <!-- 2. SQUAD SHARED DRIVERS -->
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid var(--line)">
          <span style="font-size:18px">🚌</span>
          <span style="font-weight:900;font-size:14px;color:var(--text)">فرقة سواق النقل المشترك (${sharedDrivers.length} سائق)</span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:10px">
          ${sharedDrivers.map(d => renderSingleDriverCard(d, allAssignments, missionMap, teamMap, isMgr)).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderSingleDriverCard(driver, allAssignments, missionMap, teamMap, isMgr) {
  const driverAsgs = allAssignments.filter(a =>
    (a.actualDriverId === driver.id || a.plannedDriverId === driver.id) &&
    a.status !== ASG_STATUS.CANCELLED
  );

  const tm = teamMap.get(driver.teamId);
  const isAvailable = driver.status === STATUS.AVAILABLE;
  const isLight = (driver.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.LIGHT;

  return `
    <div class="driver-roster-card" data-driver-name="${esc(driver.name.toLowerCase())}" style="background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px">
      <!-- Driver Top Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="av" style="width:34px;height:34px;font-size:13px;font-weight:900;background:var(--surface-card);border:1px solid var(--line)">
            ${esc(driver.name.charAt(0))}
          </div>
          <div>
            <div style="font-weight:900;font-size:13px;color:var(--text)">${esc(driver.name)}</div>
            <div style="font-size:10px;color:var(--text-3)">
              ${isLight ? '🚗 وزن خفيف' : '🚌 نقل مشترك'} ${tm ? `· ${esc(tm.name)}` : ''}
            </div>
          </div>
        </div>

        <div>
          <span class="tag ${isAvailable ? 'ok' : 'warn'}" style="font-size:10px;font-weight:700">
            ${STATUS_AR[driver.status] || driver.status}
          </span>
        </div>
      </div>

      <!-- Missions Assigned Today -->
      <div style="margin-top:4px">
        ${driverAsgs.length === 0 ? `
          <div style="font-size:11px;color:var(--text-3);padding:8px 10px;background:var(--surface-card);border-radius:8px;border:1px dashed var(--line);text-align:center">
            لا توجد مهام مسندة لهذا السائق في هذا اليوم (جاهز / في راحة)
          </div>
        ` : driverAsgs.map(a => {
          const m = missionMap.get(a.missionId);
          const st = a.startIso ? a.startIso.slice(11, 16) : '—';
          const et = a.endIso ? a.endIso.slice(11, 16) : '—';
          const dur = calcDuration(st, et);
          const isExec = Boolean(a.executedAt);

          return `
            <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                <span style="font-weight:800;font-size:12px;color:var(--text)">${esc(m?.name || 'مهمة مسندة')}</span>
                ${isExec ? '<span class="tag ok" style="font-size:9px">✓ تم التنفيذ</span>' : '<span class="tag info" style="font-size:9px">مجدولة</span>'}
              </div>
              <div style="font-size:11px;color:var(--text-2);margin-top:4px;display:flex;align-items:center;gap:8px">
                <span>⏰ <b>من ${esc(st)} إلى ${esc(et)}</b></span>
                <span style="color:var(--text-3)">(${dur})</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════
// Operational Period Card (Command Board)
// ═══════════════════════════════════════
function renderOperationalPeriodCard(op, driverMap, teamMap, isMgr, isActiveNow) {
  const { occurrence: occ, mission: m, period: p, periodCode, range, assignments, needed, shortageCount, category } = op;
  const startStr = p.startTime || m.startTime || '17:00';
  const endStr = p.endTime || m.endTime || fromMinSafe(toMin(startStr) + (p.durationMinutes || 360));
  const team = teamMap.get(m.teamId);
  const totalPeriodDur = calcDuration(startStr, endStr);

  return `
    <div class="period-op-card" style="background:var(--surface-card);border:1px solid ${isActiveNow ? 'var(--danger,#ef4444)' : 'var(--line)'};border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
      <!-- Period Header -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${isActiveNow ? '<span class="tag danger" style="font-weight:900">🔴 جارية الآن بالميدان</span>' : ''}
            <span style="font-size:15px;font-weight:900;color:var(--text)">${esc(m.name)}</span>
            <span class="tag" style="font-size:11px;font-weight:800;background:var(--surface-2)">${esc(p.name)}</span>
            
            <!-- Category Badge -->
            <span class="tag ${category === DRIVER_CATEGORY.SHARED ? 'cat-shared' : 'cat-light'}" style="font-size:10px;font-weight:800">
              ${category === DRIVER_CATEGORY.SHARED ? '🚌 مهمة نقل مشترك' : '🚗 مهمة وزن خفيف'}
            </span>

            ${team ? `
              <span class="tag" style="background:${esc(team.color || '#3b82f6')}22;color:${esc(team.color || '#3b82f6')};font-size:10px;font-weight:700">
                ${esc(team.name)}
              </span>
            ` : ''}
          </div>

          <!-- Mission Timings & Durations -->
          <div style="font-size:12px;color:var(--text-2);margin-top:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span>⏱ توقيت المهمة: <b>من ${esc(startStr)} إلى ${esc(endStr)}</b></span>
            <span>· المدة: <b>${totalPeriodDur}</b></span>
            <span>· المطلوب: <b>${needed} سواق</b></span>
          </div>
        </div>

        <div>
          <span class="tag ${shortageCount === 0 ? 'ok' : 'warn'}" style="font-weight:800;font-size:12px;padding:6px 12px;border-radius:8px">
            ${assignments.length}/${needed} سواق معينين
          </span>
        </div>
      </div>

      <!-- Assigned Drivers Roster -->
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
        ${assignments.length === 0 ? `
          <div style="background:var(--surface-2);border-radius:8px;padding:12px;text-align:center;font-size:12px;color:var(--text-3)">
            لم يتم تعيين أي سائق لهذه المهمة بعد
          </div>
        ` : assignments.map(a => {
          const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
          const dueDr = driverMap.get(a.dueDriverId);
          const isSub = a.dueDriverId && Number(a.dueDriverId) !== Number(a.actualDriverId || a.plannedDriverId);
          const isBorrowed = a.source === 'BORROWED' || Boolean(a.loanId);
          const isConfirmed = a.status === ASG_STATUS.CONFIRMED || a.status === ASG_STATUS.OVERRIDDEN;
          const isExecuted = Boolean(a.executedAt);

          const drStart = a.startIso ? a.startIso.slice(11, 16) : startStr;
          const drEnd = a.endIso ? a.endIso.slice(11, 16) : endStr;
          const drDur = calcDuration(drStart, drEnd);
          const drCat = dr?.category || DRIVER_CATEGORY.LIGHT;

          return `
            <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-2);padding:10px 12px;border-radius:10px;gap:10px;flex-wrap:wrap;border:1px solid var(--line)">
              <div style="display:flex;align-items:center;gap:10px">
                <div class="av ${isBorrowed ? 'borrowed' : isSub ? 'sub' : 'ok'}" style="width:36px;height:36px;font-size:13px;font-weight:800">
                  ${esc((dr?.name || '؟').charAt(0))}
                </div>
                <div>
                  <div style="font-weight:800;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span>${esc(dr?.name || 'غير معروف')}</span>
                    <span class="tag ${drCat === DRIVER_CATEGORY.SHARED ? 'cat-shared' : 'cat-light'}" style="font-size:9px">
                      ${drCat === DRIVER_CATEGORY.SHARED ? '🚌 نقل مشترك' : '🚗 وزن خفيف'}
                    </span>
                    ${isExecuted ? '<span class="tag ok" style="font-size:10px">✓ نُفّذت</span>' : ''}
                    ${!isExecuted && isConfirmed ? '<span class="tag info" style="font-size:10px">مؤكد</span>' : ''}
                    ${!isConfirmed ? '<span class="tag warn" style="font-size:10px">بانتظار التأكيد</span>' : ''}
                    ${isBorrowed ? '<span class="tag borrowed" style="font-size:10px">🔄 مستعار</span>' : ''}
                  </div>

                  <!-- Driver Precise Timing -->
                  <div style="font-size:11px;color:var(--text-2);margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span>⏰ توقيت السائق: <b>من ${esc(drStart)} إلى ${esc(drEnd)}</b> (${drDur})</span>
                    ${dueDr && isSub ? `<span style="color:var(--warn,#f59e0b)">· بديل عن المستحق بالدور: <b>${esc(dueDr.name)}</b></span>` : ''}
                  </div>
                </div>
              </div>

              ${isMgr ? `
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  ${!isExecuted ? `
                    <button class="btn-ghost" data-op-edit-timing="1" data-asgid="${a.id}" data-drname="${esc(dr?.name || '')}" data-start="${drStart}" data-end="${drEnd}" style="cursor:pointer;font-weight:700;padding:5px 10px;font-size:11px;border-radius:6px" title="تعديل توقيت السائق في هذه المهمة">
                      ⏱ تعديل التوقيت
                    </button>
                    <button class="tag ok" data-op-commit="1" data-asgid="${a.id}" data-drid="${dr?.id}" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" style="cursor:pointer;border:0;font-weight:700;padding:5px 10px;border-radius:6px">
                      🏁 تسجيل التنفيذ
                    </button>
                  ` : ''}
                  ${!isConfirmed ? `
                    <button class="tag info" data-op-confirm="1" data-asgid="${a.id}" style="cursor:pointer;border:0;font-weight:700;padding:5px 10px;border-radius:6px">
                      ✅ تأكيد
                    </button>
                  ` : ''}
                  <button class="x" data-op-remove="1" data-asgid="${a.id}" title="إلغاء التكليف">✕</button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>

      <!-- Action Panel & Shortage Alert -->
      <div style="margin-top:10px;padding:10px 12px;background:var(--surface-2);border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div>
          ${shortageCount > 0 ? `
            <div style="font-weight:800;font-size:12px;color:var(--danger,#ef4444);display:flex;align-items:center;gap:6px">
              <span>⚠️</span>
              <span>عجز بمقدار ${shortageCount} سائق في هذه المهمة!</span>
            </div>
          ` : `
            <div style="font-weight:700;font-size:12px;color:var(--ok,#10b981);display:flex;align-items:center;gap:6px">
              <span>✅</span>
              <span>اكتمال العدد المطلوب من السواق (${needed} سائق)</span>
            </div>
          `}
        </div>

        ${isMgr ? `
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${shortageCount > 0 ? `
              <button class="tag" data-op-suggest="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-teamid="${m.teamId || ''}" data-reqcat="${category}" style="cursor:pointer;background:var(--color-accent);color:#fff;border:0;font-weight:800;padding:6px 12px;border-radius:8px">
                💡 اقتراح بالدور العادل
              </button>
            ` : ''}

            <button class="btn-ghost" data-op-assign-manual="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${startStr}" data-end="${endStr}" data-reqcat="${category}" style="padding:5px 12px;font-size:11px;font-weight:800;border-radius:8px">
              ➕ تعيين سائق مخصص
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════
// Manual Driver Assignment Modal (Strict Category Isolation)
// ═══════════════════════════════════════
function openAssignDriverModal({ missionId, periodCode, occurrenceId, defaultStart, defaultEnd, requiredCategory, drivers, teams }) {
  requireWrite('assign.create');

  // STRICT category filtering: Light missions get ONLY Light drivers; Shared missions get ONLY Shared drivers!
  const eligibleDrivers = drivers.filter(d => {
    if (requiredCategory && requiredCategory !== DRIVER_CATEGORY.ALL) {
      const cat = d.category || DRIVER_CATEGORY.LIGHT;
      if (cat !== requiredCategory && cat !== DRIVER_CATEGORY.ALL) return false;
    }
    return true;
  });

  const teamMap = new Map(teams.map(t => [t.id, t]));
  let selectedDriverId = eligibleDrivers.find(d => d.status === STATUS.AVAILABLE)?.id || eligibleDrivers[0]?.id;
  let startTime = defaultStart || '17:00';
  let endTime = defaultEnd || '23:00';

  const catLabelAr = requiredCategory === DRIVER_CATEGORY.SHARED ? 'سواق النقل المشترك 🚌' : 'سواق الوزن الخفيف 🚗';

  sheet({
    title: `➕ تعيين سائق في المهمة (${catLabelAr})`,
    subtitle: 'تحديد السائق المعين وضبط ساعات بدايته ونهايته بدقة',
    builder: (body, close) => {
      const render = () => {
        const dur = calcDuration(startTime, endTime);
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:14px">
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">اختر السائق المعين (فرقة ${catLabelAr})</label>
              ${eligibleDrivers.length === 0 ? `
                <div style="padding:10px;background:var(--danger,#ef4444)15;color:var(--danger,#ef4444);font-size:12px;border-radius:8px">
                  ⚠️ لا يوجد سواق مسجلون في هذه الفرقة!
                </div>
              ` : `
                <select id="modal_dr_select" class="input" style="width:100%;font-weight:700">
                  ${eligibleDrivers.map(d => {
                    const tm = teamMap.get(d.teamId);
                    const isAvail = d.status === STATUS.AVAILABLE;
                    return `
                      <option value="${d.id}" ${d.id === selectedDriverId ? 'selected' : ''}>
                        ${esc(d.name)} (${STATUS_AR[d.status] || d.status}) ${tm ? `· ${esc(tm.name)}` : ''} ${isAvail ? '✅ متاح' : '⚠️ غير متاح'}
                      </option>
                    `;
                  }).join('')}
                </select>
              `}
            </div>

            <!-- Custom Timing for this Driver -->
            <div style="background:var(--surface-2);border-radius:10px;padding:12px;border:1px solid var(--line)">
              <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:8px">
                ⏱ توقيت عمل السائق في هذه المهمة:
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                  <label style="font-size:11px;font-weight:700;display:block;margin-bottom:4px">وقت البداية</label>
                  <input type="time" id="modal_dr_start" class="input" value="${esc(startTime)}" style="width:100%">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:700;display:block;margin-bottom:4px">وقت النهاية</label>
                  <input type="time" id="modal_dr_end" class="input" value="${esc(endTime)}" style="width:100%">
                </div>
              </div>
              <div style="margin-top:8px;font-size:12px;color:var(--text-3);text-align:center">
                المدة المحسوبة لساعات عمل السائق: <b style="color:var(--text)">${dur}</b>
              </div>
            </div>

            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn-primary" id="btnConfirmAssign" style="flex:1" ${eligibleDrivers.length === 0 ? 'disabled' : ''}>
                تأكيد التعيين والجدولة
              </button>
              <button class="btn-ghost" id="btnCancelAssign" style="flex:1">إلغاء</button>
            </div>
          </div>
        `;

        const startInput = body.querySelector('#modal_dr_start');
        const endInput = body.querySelector('#modal_dr_end');

        const updateDur = () => {
          startTime = startInput.value;
          endTime = endInput.value;
          render();
        };

        if (startInput) startInput.onchange = updateDur;
        if (endInput) endInput.onchange = updateDur;

        body.querySelector('#btnCancelAssign').onclick = close;
        body.querySelector('#btnConfirmAssign').onclick = async () => {
          const selectEl = body.querySelector('#modal_dr_select');
          if (!selectEl) return;
          const drId = Number(selectEl.value);
          const st = startInput.value;
          const et = endInput.value;

          if (!drId) return toast('يرجى اختيار سائق', 2200, 'error');
          if (!st || !et) return toast('يرجى إدخال توقيت البداية والنهاية', 2200, 'error');

          try {
            const startIso = buildStart(currentDate, st);
            const endIso = toMin(et) < toMin(st)
              ? buildStart(addDays(currentDate, 1), et)
              : buildStart(currentDate, et);

            await createProposal({
              occurrenceId,
              missionId,
              periodId: periodCode,
              periodCode,
              dueDriverId: drId,
              plannedDriverId: drId,
              startIso,
              endIso,
              rationale: 'تعيين مباشر من لوحة قيادة العمليات',
              autoConfirm: true
            });

            toast('تم تعيين السائق وتحديد توقيته بنجاح!', 2200, 'success');
            close();
            refresh();
          } catch (err) {
            toast(err.message, 2500, 'error');
          }
        };
      };

      render();
    }
  });
}

// ═══════════════════════════════════════
// Edit Driver Timing Modal
// ═══════════════════════════════════════
function openEditDriverTimingModal({ assignmentId, driverName, currentStart, currentEnd }) {
  requireWrite('assign.create');

  let startTime = currentStart || '17:00';
  let endTime = currentEnd || '23:00';

  sheet({
    title: `⏱ تعديل توقيت السائق: ${driverName}`,
    subtitle: 'تعديل ساعات بداية ونهاية هذا السائق في هذه المهمة',
    builder: (body, close) => {
      const render = () => {
        const dur = calcDuration(startTime, endTime);
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:14px">
            <div style="background:var(--surface-2);border-radius:10px;padding:12px;border:1px solid var(--line)">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                  <label style="font-size:11px;font-weight:700;display:block;margin-bottom:4px">توقيت البداية الجديد</label>
                  <input type="time" id="edit_dr_start" class="input" value="${esc(startTime)}" style="width:100%">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:700;display:block;margin-bottom:4px">توقيت النهاية الجديد</label>
                  <input type="time" id="edit_dr_end" class="input" value="${esc(endTime)}" style="width:100%">
                </div>
              </div>
              <div style="margin-top:10px;font-size:12px;color:var(--text-3);text-align:center">
                المدة المحسوبة: <b style="color:var(--text)">${dur}</b>
              </div>
            </div>

            <div style="display:flex;gap:8px">
              <button class="btn-primary" id="btnSaveTiming" style="flex:1">
                حفظ التوقيت الجديد
              </button>
              <button class="btn-ghost" id="btnCancelTiming" style="flex:1">إلغاء</button>
            </div>
          </div>
        `;

        const startInput = body.querySelector('#edit_dr_start');
        const endInput = body.querySelector('#edit_dr_end');

        startInput.onchange = () => { startTime = startInput.value; render(); };
        endInput.onchange = () => { endTime = endInput.value; render(); };

        body.querySelector('#btnCancelTiming').onclick = close;
        body.querySelector('#btnSaveTiming').onclick = async () => {
          const st = startInput.value;
          const et = endInput.value;

          if (!st || !et) return toast('يرجى إدخال التوقيت', 2200, 'error');

          try {
            const startIso = buildStart(currentDate, st);
            const endIso = toMin(et) < toMin(st)
              ? buildStart(addDays(currentDate, 1), et)
              : buildStart(currentDate, et);

            await updateAssignmentTiming(assignmentId, { startIso, endIso });

            toast('تم تحديث توقيت السائق بنجاح!', 2200, 'success');
            close();
            refresh();
          } catch (err) {
            toast(err.message, 2500, 'error');
          }
        };
      };

      render();
    }
  });
}
