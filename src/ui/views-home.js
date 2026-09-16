import { listByDate, createOccurrence, getOccurrence, updateOccurrence } from '../domain/occurrences.js';
import { listMissions, getMission, getMissionPeriods, createMission } from '../domain/missions.js';
import { listDrivers, setDriverStatus, STATUS, STATUS_AR, STATUS_COLOR, DRIVER_CATEGORY, DRIVER_CATEGORY_AR } from '../domain/drivers.js';
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
import { toast, refresh, attachRipple, esc, sheet } from './helpers.js';
import { openDriverPickerSheet, openDriverProfileSheet } from './components/driver-modal.js';
import { openAddTodayMissionSheet } from './components/add-mission-modal.js';
import {
  todayIso, addDays, humanDate, humanDateFull, dayNameAr, isToday,
  fmtDurShort, toMin, fromMinSafe, buildStart, addMin, nowIso, calcDuration,
  formatTimeHhmm, formatDateIso
} from '../core/clock.js';

let currentDate = todayIso();
// Modes: 'ALL' (جميع المهام) | 'LIGHT' (الوزن الخفيف) | 'SHARED' (النقل المشترك) | 'DRIVERS_ROSTER' (جدول مهام السواق)
let activeOpsFilter = 'ALL';
let driverSearchQuery = '';
let missionSearchQuery = '';
let quickMissionOpen = false;

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

  if (isDriverRole && activeOpsFilter !== 'DRIVERS_ROSTER') {
    activeOpsFilter = 'DRIVERS_ROSTER';
  }

  const isEmpty = await isDatabaseEmpty();
  if (isEmpty) {
    main.innerHTML = `
      <div class="empty-block" style="padding:48px 24px;text-align:center;background:var(--surface-card);border:1px solid var(--line);border-radius:18px;margin:30px auto;max-width:560px;box-shadow:var(--shadow-2)">
        <div style="font-size:52px;margin-bottom:14px">🚀</div>
        <h2 style="font-size:22px;font-weight:900;color:var(--text);margin-bottom:8px">مرحباً بك في Sowa9</h2>
        <p style="font-size:14px;color:var(--text-2);line-height:1.7;margin:0 0 24px">
          نظام قيادة وتشغيل فرقة السواق. يمكنك تفعيل البيانات التجريبية الشاملة بضغطة زر واحدة لتجربة توزيع المهام وحساب الأدوار فوراً:
        </p>
        <button class="btn-primary" id="btnSeedDemo" style="padding:14px 28px;font-size:15px;font-weight:800;border-radius:12px;background:linear-gradient(135deg,#1d4ed8,#2563eb);box-shadow:0 4px 14px rgba(37,99,235,0.3)">
          ⚡ تفعيل البيانات التشغيلية (Demo)
        </button>
      </div>
    `;
    main.querySelector('#btnSeedDemo')?.addEventListener('click', async () => {
      try {
        await seedDemoDataset();
        toast('تم تفعيل البيانات التشغيلية بنجاح!', 2500, 'success');
        refresh();
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    });
    return;
  }

  // Load Operations Data
  const [occurrences, missions, drivers, teams] = await Promise.all([
    listByDate(currentDate),
    listMissions(true),
    listDrivers(),
    listTeams()
  ]);

  const missionMap = new Map(missions.map(m => [m.id, m]));
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  const teamMap = new Map(teams.map(t => [t.id, t]));

  // Retrieve assignments for today's occurrences
  const allAssignments = [];
  for (const occ of occurrences) {
    const asgs = await listByOccurrence(occ.id);
    for (const a of asgs) {
      allAssignments.push({ ...a, occurrenceId: occ.id, missionId: occ.missionId });
    }
  }

  // Separate drivers strictly by category
  const lightDrivers = drivers.filter(d => (d.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.LIGHT);
  const sharedDrivers = drivers.filter(d => d.category === DRIVER_CATEGORY.SHARED);

  // Deconstruct occurrences into operational periods
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

  // Filter periods strictly by squad selection
  const lightPeriods = operationalPeriods.filter(op => op.category === DRIVER_CATEGORY.LIGHT);
  const sharedPeriods = operationalPeriods.filter(op => op.category === DRIVER_CATEGORY.SHARED);

  let displayedPeriods = activeOpsFilter === 'SHARED' ? sharedPeriods : activeOpsFilter === 'LIGHT' ? lightPeriods : operationalPeriods;

  if (missionSearchQuery) {
    displayedPeriods = displayedPeriods.filter(p =>
      p.mission.name.toLowerCase().includes(missionSearchQuery) ||
      (p.period.name && p.period.name.toLowerCase().includes(missionSearchQuery))
    );
  }

  // Active drivers currently driving
  const drivingDriverIds = new Set();
  operationalPeriods.filter(p => p.isActiveNow).forEach(p => {
    p.assignments.forEach(a => {
      const drId = a.actualDriverId || a.plannedDriverId;
      if (drId) drivingDriverIds.add(drId);
    });
  });

  const activeDrivingDrivers = drivers.filter(d => drivingDriverIds.has(d.id));
  const availableDrivers = drivers.filter(d => d.status === STATUS.AVAILABLE && !drivingDriverIds.has(d.id));
  const unavailableDrivers = drivers.filter(d => d.status !== STATUS.AVAILABLE);

  // Suggested by fair turn: available drivers sorted with least active duty
  const suggestedLight = availableDrivers.filter(d => d.category !== DRIVER_CATEGORY.SHARED);
  const suggestedShared = availableDrivers.filter(d => d.category === DRIVER_CATEGORY.SHARED);

  // Dates for quick 1-click navigation
  const yesterday = addDays(currentDate, -1);
  const tomorrow = addDays(currentDate, 1);
  const dayAfterTomorrow = addDays(currentDate, 2);

  main.innerHTML = `
    <!-- 1. HEADER (بخط كبير واضح ومريح للعين) -->
    <div class="today-banner-card" style="background:var(--surface-card);border:1px solid var(--line);border-radius:16px;padding:20px 24px;margin-bottom:20px;box-shadow:var(--shadow-1)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px">
        <div>
          <div style="font-size:12px;font-weight:800;color:var(--color-accent);margin-bottom:6px;display:flex;align-items:center;gap:6px">
            <span>📅</span>
            <span>جدول مهام الميدان والتشغيل اليومي</span>
            ${isToday(currentDate) ? '<span class="today-badge">اليوم</span>' : ''}
          </div>
          <!-- بخط كبير وواضح ومريح للعين -->
          <h1 style="margin:0;font-size:26px;font-weight:900;color:var(--text);letter-spacing:-0.5px">
            اليوم: ${dayNameAr(currentDate)} ${humanDate(currentDate)}
          </h1>
        </div>

        <!-- 1-Click Fast Day Navigator & Actions -->
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="exec-day-chips">
            <button type="button" class="day-chip-btn nav-arrow" id="btnPrevDay" title="اليوم السابق">‹</button>
            <button type="button" class="day-chip-btn ${currentDate === yesterday ? 'active' : ''}" id="btnNavYesterday">أمس</button>
            <button type="button" class="day-chip-btn ${isToday(currentDate) ? 'active' : ''}" id="btnNavToday">اليوم</button>
            <button type="button" class="day-chip-btn ${currentDate === tomorrow ? 'active' : ''}" id="btnNavTomorrow">غداً</button>
            <button type="button" class="day-chip-btn ${currentDate === dayAfterTomorrow ? 'active' : ''}" id="btnNavDayAfter">بعد غد</button>
            <button type="button" class="day-chip-btn nav-arrow" id="btnNextDay" title="اليوم التالي">›</button>
          </div>

          <div class="exec-date-picker-wrap" title="اختر تاريخاً بالتقويم">
            <input type="date" id="directDateInput" value="${currentDate}">
          </div>

          ${isMgr ? `
            <button type="button" class="btn-primary" id="btnOpenAddTodayMission" style="width:auto;padding:8px 16px;font-size:12px;font-weight:800;border-radius:10px;background:var(--color-accent);color:#fff;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
              <span>➕</span>
              <span>إضافة مهمة لليوم</span>
            </button>
          ` : ''}

          <button type="button" class="btn-ghost" id="btnToggleDriverRoster" style="padding:8px 14px;font-size:12px;font-weight:800;border-radius:10px;background:var(--surface-2);border:1px solid var(--line);color:var(--text);cursor:pointer">
            ${activeOpsFilter === 'DRIVERS_ROSTER' ? '📋 العودة لمهام اليوم' : '👤 جدول مهام السواق'}
          </button>
        </div>
      </div>
    </div>

    <!-- MAIN CONTENT -->
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
      <!-- 2. SECTION: مهام اليوم -->
      <div class="today-missions-section" style="margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:22px">📋</span>
            <h2 style="margin:0;font-size:19px;font-weight:900;color:var(--text)">
              مهام اليوم:
            </h2>
            <span style="font-size:12px;font-weight:800;background:var(--surface-2);color:var(--text-2);padding:2px 10px;border-radius:14px;border:1px solid var(--line)">
              ${displayedPeriods.length} مهمة مسجلة
            </span>
          </div>

          <div style="display:flex;align-items:center;gap:8px">
            <input type="text" id="missionSearchInput" class="input" placeholder="🔍 بحث في مهام اليوم..." value="${esc(missionSearchQuery)}" style="padding:6px 12px;font-size:12px;border-radius:8px;background:var(--surface-card);border:1px solid var(--line);width:180px">
            ${isMgr ? `
              <button type="button" class="btn-ghost" id="btnToggleQuickMission" style="padding:6px 12px;font-size:12px;font-weight:700;border-radius:8px;background:var(--surface-card);border:1px solid var(--line);color:var(--text-2);cursor:pointer">
                ${quickMissionOpen ? '✕ إغلاق' : '⚡ إدخال سريع'}
              </button>
            ` : ''}
          </div>
        </div>

        <!-- COLLAPSIBLE INLINE QUICK MISSION FORM -->
        <div id="quickMissionCard" style="display:${quickMissionOpen ? 'block' : 'none'};background:var(--surface-card);border:1px solid var(--color-accent);border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--shadow-2)">
          <div style="font-size:14px;font-weight:900;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:6px">
            <span>⚡</span>
            <span>إضافة مهمة سريعة لجدول اليوم</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;margin-bottom:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">اسم المهمة</label>
              <input type="text" id="quickMisName" placeholder="مثال: مهمة تأمين الغابة" class="input" style="width:100%;font-size:12px;padding:7px 10px">
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">وقت البداية</label>
              <input type="time" id="quickMisStart" value="08:00" class="input" style="width:100%;font-size:12px;padding:7px 10px">
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">وقت النهاية</label>
              <input type="time" id="quickMisEnd" value="16:00" class="input" style="width:100%;font-size:12px;padding:7px 10px">
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">عدد السواق المطلوبين</label>
              <input type="number" id="quickMisDrivers" value="1" min="1" max="10" class="input" style="width:100%;font-size:12px;padding:7px 10px">
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn-ghost" id="btnCancelQuickMis" style="width:auto;padding:7px 14px;font-size:12px">إلغاء</button>
            <button type="button" class="btn-primary" id="btnSaveQuickMis" style="width:auto;padding:7px 18px;font-size:12px;font-weight:800;background:var(--color-accent);color:#fff">
              💾 حفظ وتكليف فوراً
            </button>
          </div>
        </div>

        <!-- LIST OF TODAY'S MISSIONS (WITH PARALLEL DRIVER COLUMNS) -->
        <div style="display:flex;flex-direction:column;gap:16px">
          ${displayedPeriods.length === 0 ? `
            <div style="text-align:center;padding:40px 20px;background:var(--surface-card);border:1px dashed var(--line);border-radius:14px;color:var(--text-3)">
              <div style="font-size:36px;margin-bottom:8px">📋</div>
              <div style="font-size:15px;font-weight:800;color:var(--text)">لا توجد مهام مسجلة في هذا اليوم</div>
              <div style="font-size:12px;margin-top:4px">يمكنك إضافة مهام اليوم مباشرة عبر زر "➕ إضافة مهمة لليوم" أعلاه</div>
            </div>
          ` : displayedPeriods.map(op => renderOperationalPeriodCard(op, driverMap, teamMap, drivers, isMgr)).join('')}
        </div>
      </div>

      <!-- 3. SECTION: ثم في الأسفل: السواق المقترحين أو إحصائيات السواق -->
      <div class="bottom-stats-suggestions" style="background:var(--surface-card);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:var(--shadow-1)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:22px">📊</span>
            <div>
              <h3 style="margin:0;font-size:17px;font-weight:900;color:var(--text)">
                إحصائيات السواق والسواق المقترحون بالدور
              </h3>
              <div style="font-size:11px;color:var(--text-3);margin-top:2px">
                كشف جاهزية السواق الميدانية وتوزيع التكليفات بعدالة
              </div>
            </div>
          </div>
        </div>

        <!-- 4 Stats Cards (Clean & High Contrast) -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:12px;margin-bottom:18px">
          <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px">
            <div style="font-size:11px;color:var(--text-3);font-weight:700">👥 إجمالي السواق</div>
            <div style="font-size:22px;font-weight:900;color:var(--text);margin-top:2px">${drivers.length}</div>
            <div style="font-size:10px;color:var(--text-3);margin-top:2px">${lightDrivers.length} وزن خفيف · ${sharedDrivers.length} نقل مشترك</div>
          </div>

          <div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:10px;padding:12px 14px">
            <div style="font-size:11px;color:#10b981;font-weight:800">🟢 يقودون بالميدان الآن</div>
            <div style="font-size:22px;font-weight:900;color:#10b981;margin-top:2px">${activeDrivingDrivers.length}</div>
            <div style="font-size:10px;color:var(--text-2);margin-top:2px">
              ${activeDrivingDrivers.length > 0 ? activeDrivingDrivers.map(d => esc(d.name)).join('، ') : 'لا أحد يقود في هذه اللحظة'}
            </div>
          </div>

          <div style="background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.25);border-radius:10px;padding:12px 14px">
            <div style="font-size:11px;color:#2563eb;font-weight:800">✅ جاهزون ومتاحون للعمل</div>
            <div style="font-size:22px;font-weight:900;color:#2563eb;margin-top:2px">${availableDrivers.length}</div>
            <div style="font-size:10px;color:var(--text-2);margin-top:2px">
              ${availableDrivers.filter(d => d.category !== DRIVER_CATEGORY.SHARED).length} خفيف · ${availableDrivers.filter(d => d.category === DRIVER_CATEGORY.SHARED).length} نقل مشترك
            </div>
          </div>

          <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px">
            <div style="font-size:11px;color:var(--text-3);font-weight:700">💤 في راحة أو إجازة</div>
            <div style="font-size:22px;font-weight:900;color:var(--text-2);margin-top:2px">${unavailableDrivers.length}</div>
            <div style="font-size:10px;color:var(--text-3);margin-top:2px">غير متاحين حالياً</div>
          </div>
        </div>

        <!-- TWO FACING COLUMNS: SUGGESTED LIGHT DRIVERS vs SUGGESTED SHARED DRIVERS -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(310px, 1fr));gap:16px;margin-bottom:18px">
          <!-- 🚗 مقترحو الوزن الخفيف بالدور -->
          <div style="background:rgba(37,99,235,0.03);border:1px solid rgba(37,99,235,0.2);border-radius:12px;padding:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(37,99,235,0.15)">
              <div style="font-size:13px;font-weight:900;color:var(--text);display:flex;align-items:center;gap:6px">
                <span>🚗</span>
                <span>سواق الوزن الخفيف المقترحون بالدور:</span>
              </div>
              <span style="font-size:10px;font-weight:800;background:rgba(37,99,235,0.12);color:#2563eb;padding:2px 8px;border-radius:6px">
                الأقل ساعات
              </span>
            </div>

            ${suggestedLight.length > 0 ? `
              <div style="display:flex;flex-direction:column;gap:6px">
                ${suggestedLight.slice(0, 4).map((d, idx) => {
                  const tm = teamMap.get(d.teamId);
                  return `
                    <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px">
                      <div class="driver-clickable" data-open-driver="${d.id}" style="cursor:pointer;display:flex;align-items:center;gap:8px">
                        <span style="font-size:11px;font-weight:900;color:#2563eb;background:rgba(37,99,235,0.1);width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center">${idx + 1}</span>
                        <div>
                          <div style="font-size:12px;font-weight:800;color:var(--text)">${esc(d.name)}</div>
                          <div style="font-size:10px;color:var(--text-3)">${tm?.name ? esc(tm.name) : 'الفرقة الرئيسية'} · ✅ متاح بالدور</div>
                        </div>
                      </div>
                      ${isMgr ? `
                        <button type="button" class="btn-toggle-driver-status" data-drid="${d.id}" data-curstatus="${d.status}" style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;border:1px solid rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);color:#10b981;cursor:pointer" title="تبديل الحالة">
                          ✅ متاح
                        </button>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `
              <div style="font-size:11px;color:var(--text-3);padding:10px;text-align:center;background:var(--surface-card);border-radius:8px;border:1px dashed var(--line)">
                جميع سواق الوزن الخفيف مكلفون أو غير متاحين حالياً
              </div>
            `}
          </div>

          <!-- 🚌 مقترحو النقل المشترك بالدور -->
          <div style="background:rgba(16,185,129,0.03);border:1px solid rgba(16,185,129,0.2);border-radius:12px;padding:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(16,185,129,0.15)">
              <div style="font-size:13px;font-weight:900;color:var(--text);display:flex;align-items:center;gap:6px">
                <span>🚌</span>
                <span>سواق النقل المشترك المقترحون بالدور:</span>
              </div>
              <span style="font-size:10px;font-weight:800;background:rgba(16,185,129,0.12);color:#059669;padding:2px 8px;border-radius:6px">
                الأقل ساعات
              </span>
            </div>

            ${suggestedShared.length > 0 ? `
              <div style="display:flex;flex-direction:column;gap:6px">
                ${suggestedShared.slice(0, 4).map((d, idx) => {
                  const tm = teamMap.get(d.teamId);
                  return `
                    <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px">
                      <div class="driver-clickable" data-open-driver="${d.id}" style="cursor:pointer;display:flex;align-items:center;gap:8px">
                        <span style="font-size:11px;font-weight:900;color:#059669;background:rgba(16,185,129,0.1);width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center">${idx + 1}</span>
                        <div>
                          <div style="font-size:12px;font-weight:800;color:var(--text)">${esc(d.name)}</div>
                          <div style="font-size:10px;color:var(--text-3)">${tm?.name ? esc(tm.name) : 'نقل مشترك'} · ✅ متاح بالدور</div>
                        </div>
                      </div>
                      ${isMgr ? `
                        <button type="button" class="btn-toggle-driver-status" data-drid="${d.id}" data-curstatus="${d.status}" style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;border:1px solid rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);color:#10b981;cursor:pointer" title="تبديل الحالة">
                          ✅ متاح
                        </button>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `
              <div style="font-size:11px;color:var(--text-3);padding:10px;text-align:center;background:var(--surface-card);border-radius:8px;border:1px dashed var(--line)">
                جميع سواق النقل المشترك مكلفون أو غير متاحين حالياً
              </div>
            `}
          </div>
        </div>

        <!-- READINESS STATUS LIST OF ALL DRIVERS (COLLAPSIBLE / FAST SWITCHER) -->
        <details style="background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:10px 14px">
          <summary style="font-size:12px;font-weight:800;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:space-between">
            <span>📋 كشف جاهزية جميع السواق والتبديل السريع للحالة (${drivers.length} سائق)</span>
            <span style="font-size:11px;color:var(--text-3)">انقر للعرض/الإخفاء ▾</span>
          </summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:8px;margin-top:10px;max-height:360px;overflow-y:auto;padding-right:2px">
            ${drivers.map(d => {
              const isDriving = drivingDriverIds.has(d.id);
              const isAvail = d.status === STATUS.AVAILABLE;
              const isShared = d.category === DRIVER_CATEGORY.SHARED;
              return `
                <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;gap:6px">
                  <div class="driver-clickable" data-open-driver="${d.id}" style="cursor:pointer;display:flex;align-items:center;gap:6px">
                    <span>${isShared ? '🚌' : '🚗'}</span>
                    <span style="font-size:12px;font-weight:800;color:var(--text)">${esc(d.name)}</span>
                  </div>
                  ${isMgr ? `
                    <button type="button" class="btn-toggle-driver-status" data-drid="${d.id}" data-curstatus="${d.status}" style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;border:1px solid ${isDriving ? 'rgba(16,185,129,0.3)' : isAvail ? 'rgba(37,99,235,0.3)' : 'rgba(239,68,68,0.3)'};background:${isDriving ? 'rgba(16,185,129,0.1)' : isAvail ? 'rgba(37,99,235,0.08)' : 'rgba(239,68,68,0.08)'};color:${isDriving ? '#10b981' : isAvail ? '#2563eb' : '#ef4444'};cursor:pointer">
                      ${isDriving ? '🟢 يقود الآن' : isAvail ? '✅ متاح' : '🔴 ' + (STATUS_AR[d.status] || d.status)}
                    </button>
                  ` : `
                    <span style="font-size:10px;font-weight:800;color:${isAvail ? '#10b981' : '#ef4444'}">
                      ${STATUS_AR[d.status] || d.status}
                    </span>
                  `}
                </div>
              `;
            }).join('')}
          </div>
        </details>
      </div>
    `}
  `;

  // Attach Event Handlers
  main.querySelector('#btnPrevDay').onclick = () => { currentDate = addDays(currentDate, -1); refresh(); };
  main.querySelector('#btnNextDay').onclick = () => { currentDate = addDays(currentDate, 1); refresh(); };
  main.querySelector('#btnNavYesterday').onclick = () => { currentDate = yesterday; refresh(); };
  main.querySelector('#btnNavToday').onclick = () => { currentDate = todayIso(); refresh(); };
  main.querySelector('#btnNavTomorrow').onclick = () => { currentDate = tomorrow; refresh(); };
  main.querySelector('#btnNavDayAfter').onclick = () => { currentDate = dayAfterTomorrow; refresh(); };

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

  // Driver Roster Toggle Button
  const btnToggleRoster = main.querySelector('#btnToggleDriverRoster');
  if (btnToggleRoster) {
    btnToggleRoster.onclick = () => {
      activeOpsFilter = activeOpsFilter === 'DRIVERS_ROSTER' ? 'ALL' : 'DRIVERS_ROSTER';
      renderHome(main);
    };
  }

  // Mission Search Filter
  const misSearch = main.querySelector('#missionSearchInput');
  if (misSearch) {
    misSearch.oninput = (e) => {
      missionSearchQuery = e.target.value.toLowerCase().trim();
      renderHome(main);
    };
  }

  // Quick Mission Toggle & Save
  main.querySelector('#btnToggleQuickMission')?.addEventListener('click', () => {
    quickMissionOpen = !quickMissionOpen;
    renderHome(main);
  });
  main.querySelector('#btnCancelQuickMis')?.addEventListener('click', () => {
    quickMissionOpen = false;
    renderHome(main);
  });
  main.querySelector('#btnSaveQuickMis')?.addEventListener('click', async () => {
    const name = main.querySelector('#quickMisName')?.value?.trim();
    const startTime = main.querySelector('#quickMisStart')?.value || '08:00';
    const endTime = main.querySelector('#quickMisEnd')?.value || '16:00';
    const driversNeeded = Number(main.querySelector('#quickMisDrivers')?.value) || 1;

    if (!name) {
      toast('يرجى كتابة اسم المهمة', 2200, 'error');
      return;
    }

    try {
      const startMin = toMin(startTime);
      const endMin = toMin(endTime);
      const dur = endMin >= startMin ? (endMin - startMin) : (1440 - startMin + endMin);

      const mid = await createMission({
        name,
        type: 'NORMAL',
        startTime,
        endTime,
        durationMinutes: dur,
        driversNeeded,
        driverCategory: activeOpsFilter === 'SHARED' ? 'SHARED' : 'LIGHT'
      });

      await createOccurrence({
        dateIso: currentDate,
        missionId: mid,
        startTime,
        durationMinutes: dur
      });

      quickMissionOpen = false;
      toast('تمت جدولة المهمة بنجاح!', 2200, 'success');
      refresh();
    } catch (e) {
      toast(e.message, 2500, 'error');
    }
  });

  // 1-CLICK INSTANT DUE DRIVER ROTATION ASSIGN
  main.querySelectorAll('[data-quick-assign-suggest]').forEach(btn => {
    btn.onclick = async () => {
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occid = Number(btn.dataset.occid);
      const startIso = btn.dataset.start;
      const endIso = btn.dataset.end;
      const reqCat = btn.dataset.reqcat || DRIVER_CATEGORY.LIGHT;

      btn.disabled = true;
      btn.textContent = '⏳ جاري التعيين...';

      try {
        const res = await suggestForTurn({
          missionId: mid,
          periodId: pcode,
          occurrenceId: occid,
          startIso,
          endIso,
          requiredCategory: reqCat
        });

        if (!res.proposed) {
          toast(res.reason || 'لا يوجد سائق متاح حالياً بالفرقة', 2500, 'error');
          btn.disabled = false;
          btn.textContent = '⚡ تعيين المستحق بالدور';
          return;
        }

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
      } catch (err) {
        toast(err.message, 2500, 'error');
        btn.disabled = false;
      }
    };
  });

  // INLINE MANUAL DRIVER ASSIGNMENT (2 CLICKS: PICK + CLICK)
  main.querySelectorAll('.btn-quick-manual-assign').forEach(btn => {
    btn.onclick = async () => {
      const slotBox = btn.closest('[data-slot-box]');
      if (!slotBox) return;
      const select = slotBox.querySelector('.quick-manual-select');
      const driverId = Number(select?.value);
      if (!driverId) {
        toast('اختر سائقاً من القائمة أولاً', 2000, 'warn');
        return;
      }

      const occid = Number(btn.dataset.occid);
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const startIso = btn.dataset.start;
      const endIso = btn.dataset.end;

      try {
        await createProposal({
          occurrenceId: occid,
          missionId: mid,
          periodId: pcode,
          periodCode: pcode,
          dueDriverId: driverId,
          plannedDriverId: driverId,
          startIso,
          endIso,
          rationale: 'تعيين مباشر من قائد الفرقة',
          replacementReason: 'تعيين مباشر',
          autoConfirm: true
        });
        toast('تم تعيين السائق بنجاح!', 2000, 'success');
        refresh();
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    };
  });

  // INLINE TIME EDITING (AUTO-SAVES WITH REAL-TIME DURATION UPDATE)
  main.querySelectorAll('.time-input-inline').forEach(input => {
    input.onchange = async () => {
      const asgId = Number(input.dataset.asgid);
      const slot = input.closest('[data-asg-slot]');
      if (!slot) return;
      const startInput = slot.querySelector('[data-field="start"]');
      const endInput = slot.querySelector('[data-field="end"]');
      const indicator = slot.querySelector('.save-badge');
      const durLabel = slot.querySelector('.dr-dur-label');

      const newStartVal = startInput?.value;
      const newEndVal = endInput?.value;

      if (durLabel && newStartVal && newEndVal) {
        const dObj = calcDuration(newStartVal, newEndVal);
        durLabel.textContent = dObj.humanText || '—';
      }

      try {
        const newStartIso = `${currentDate}T${newStartVal}:00`;
        const newEndIso = `${currentDate}T${newEndVal}:00`;

        await updateAssignmentTiming(asgId, { startIso: newStartIso, endIso: newEndIso });
        if (indicator) {
          indicator.style.display = 'inline';
          setTimeout(() => { indicator.style.display = 'none'; }, 2000);
        }
        toast('تم تحديث وحفظ توقيت عمل السائق بالمهمة!', 1600, 'success');
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    };
  });

  // EDIT OVERALL MISSION TIMING MODAL
  main.querySelectorAll('.btn-edit-mission-time').forEach(btn => {
    btn.onclick = () => {
      const occId = Number(btn.dataset.occid);
      const missionName = btn.dataset.mname;
      const curStart = btn.dataset.curstart;
      const curEnd = btn.dataset.curend;
      openEditMissionTimingModal({
        occurrenceId: occId,
        missionName,
        currentStart: curStart,
        currentEnd: curEnd,
        currentDate
      });
    };
  });

  // 1-CLICK COMMIT EXECUTION
  main.querySelectorAll('[data-op-commit]').forEach(btn => {
    btn.onclick = async () => {
      const asgId = Number(btn.dataset.asgid);
      const occId = Number(btn.dataset.occid);
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const drId = Number(btn.dataset.drid);

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

  // 1-CLICK REMOVE ASSIGNMENT
  main.querySelectorAll('[data-op-remove]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await cancelAssignment(Number(btn.dataset.asgid), 'إلغاء من قائد الفرقة');
        toast('تم إلغاء التكليف بنجاح', 2000, 'success');
        refresh();
      } catch (err) {
        toast(err.message, 2500, 'error');
      }
    };
  });

  // 1-CLICK DRIVER STATUS TOGGLE (متاح ⇄ إجازة)
  main.querySelectorAll('.btn-toggle-driver-status').forEach(btn => {
    btn.onclick = async () => {
      const drId = Number(btn.dataset.drid);
      const cur = btn.dataset.curstatus;
      const next = cur === STATUS.AVAILABLE ? STATUS.VACATION : STATUS.AVAILABLE;

      try {
        await setDriverStatus(drId, next, 'تبديل سريع من لوحة العمليات');
        toast(`تم تحويل حالة السائق إلى: ${STATUS_AR[next] || next}`, 2000, 'info');
        refresh();
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    };
  });

  // OPEN ADD TODAY MISSION SHEET (REGISTERED CATALOG OR NEW CUSTOM)
  main.querySelector('#btnOpenAddTodayMission')?.addEventListener('click', () => {
    openAddTodayMissionSheet(currentDate, activeOpsFilter);
  });

  // OPEN DRIVER PROFILE SHEET (CLICKING ANY DRIVER ANYWHERE)
  main.querySelectorAll('[data-open-driver]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const drId = Number(el.dataset.openDriver);
      if (drId) {
        openDriverProfileSheet(drId, currentDate);
      }
    });
  });

  // OPEN INTERACTIVE DRIVER PICKER SHEET (WITH LÉGER / TRANSPORT TABS, REST & TURNS)
  main.querySelectorAll('[data-pick-driver]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const mid = Number(btn.dataset.mid);
      const pcode = btn.dataset.pcode;
      const occid = Number(btn.dataset.occid);
      const startIso = btn.dataset.start;
      const endIso = btn.dataset.end;
      const reqCat = btn.dataset.reqcat;

      const occ = occurrences.find(o => o.id === occid);
      const mis = missionMap.get(mid);
      if (!occ || !mis) return;

      const periods = getMissionPeriods(mis);
      const period = periods.find(p => (p.code || p.id) === pcode) || { code: pcode, name: 'فترة التكليف' };

      openDriverPickerSheet({
        mission: mis,
        period,
        occurrence: occ,
        currentDate,
        startIso,
        endIso,
        initialCategory: reqCat
      });
    };
  });

  main.querySelectorAll('.btn-primary, .btn-ghost, .day-chip-btn').forEach(attachRipple);
}

// ═══════════════════════════════════════
// Edit Mission Timing Modal (Overall Occurrence Time)
// ═══════════════════════════════════════
function openEditMissionTimingModal({ occurrenceId, missionName, currentStart, currentEnd, currentDate }) {
  sheet({
    title: `✏️ تعديل توقيت المهمة`,
    subtitle: `${missionName} · تاريخ ${humanDate(currentDate)}`,
    builder: (body, close) => {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:16px;padding:6px 0">
          <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:12px">
            <div style="font-size:14px;color:var(--text);font-weight:900;margin-bottom:4px">📌 ${esc(missionName)}</div>
            <div style="font-size:12px;color:var(--text-3)">تعديل وقت البداية والنهاية الإجمالي للمهمة اليوم بالكامل</div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:800;color:var(--text);display:block;margin-bottom:6px">⏰ وقت بداية المهمة (من)</label>
              <input type="time" id="editOccStart" value="${currentStart}" class="input" style="width:100%;font-size:15px;padding:10px 12px;font-weight:800;border-radius:8px">
            </div>
            <div>
              <label style="font-size:12px;font-weight:800;color:var(--text);display:block;margin-bottom:6px">🏁 وقت نهاية المهمة (إلى)</label>
              <input type="time" id="editOccEnd" value="${currentEnd}" class="input" style="width:100%;font-size:15px;padding:10px 12px;font-weight:800;border-radius:8px">
            </div>
          </div>

          <div id="editOccDurationPreview" style="font-size:13px;font-weight:800;color:var(--color-accent);background:var(--surface-card);border:1px solid var(--line);padding:10px 14px;border-radius:8px;text-align:center">
            المدة الإجمالية: ${(calcDuration(currentStart, currentEnd).humanText || '—')}
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px">
            <button type="button" class="btn-ghost" id="btnCancelEditOcc" style="padding:10px 18px;font-size:13px;border-radius:8px">إلغاء</button>
            <button type="button" class="btn-primary" id="btnSaveEditOcc" style="padding:10px 22px;font-size:13px;font-weight:900;border-radius:8px;background:var(--color-accent);color:#fff">
              💾 حفظ توقيت المهمة
            </button>
          </div>
        </div>
      `;

      const startInp = body.querySelector('#editOccStart');
      const endInp = body.querySelector('#editOccEnd');
      const durPrev = body.querySelector('#editOccDurationPreview');

      const updateDur = () => {
        const dObj = calcDuration(startInp.value, endInp.value);
        durPrev.textContent = `المدة الإجمالية: ${dObj.humanText || '—'}`;
      };
      startInp.oninput = updateDur;
      endInp.oninput = updateDur;

      body.querySelector('#btnCancelEditOcc').onclick = close;
      body.querySelector('#btnSaveEditOcc').onclick = async () => {
        const sVal = startInp.value;
        const eVal = endInp.value;
        if (!sVal || !eVal) return toast('يرجى تحديد وقتي البداية والنهاية', 2200, 'warn');

        const sMin = toMin(sVal);
        const eMin = toMin(eVal);
        const dur = eMin >= sMin ? (eMin - sMin) : (1440 - sMin + eMin);

        try {
          await updateOccurrence(Number(occurrenceId), {
            startTime: sVal,
            durationMinutes: dur
          });
          toast('تم تحديث توقيت المهمة بنجاح!', 2500, 'success');
          close();
          refresh();
        } catch (e) {
          toast(e.message, 2500, 'error');
        }
      };
    }
  });
}

// ═══════════════════════════════════════
// Driver Row In Mission (Clean, Sleek & Direct)
// ═══════════════════════════════════════
function renderDriverRowInMission(a, dr, occ, m, periodCode, defStart, defEnd, isMgr, forcedCat) {
  const isExecuted = Boolean(a.executedAt);
  const drStart = formatTimeHhmm(a.startIso, defStart);
  const drEnd = formatTimeHhmm(a.endIso, defEnd);
  const drDurationObj = calcDuration(drStart, drEnd);
  const drDuration = drDurationObj.humanText || '—';
  const cat = dr?.category || forcedCat;

  return `
    <div class="op-slot-row" data-asg-slot="${a.id}" style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <!-- 1. Driver Identity -->
      <div style="display:flex;align-items:center;gap:8px;min-width:170px">
        <div class="driver-clickable" data-open-driver="${dr?.id || ''}" style="display:flex;align-items:center;gap:8px;cursor:pointer" title="انقر لمعاينة ملف السائق المباشر">
          <div style="width:32px;height:32px;border-radius:7px;background:${cat === DRIVER_CATEGORY.SHARED ? 'linear-gradient(135deg,#047857,#059669)' : 'linear-gradient(135deg,#1d4ed8,#2563eb)'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;flex-shrink:0">
            ${esc((dr?.name || '؟').charAt(0))}
          </div>
          <div>
            <div style="font-size:13px;font-weight:800;color:var(--text);display:flex;align-items:center;gap:6px">
              <span>${esc(dr?.name || 'سائق غير مسجل')}</span>
              ${isExecuted ? '<span style="font-size:10px;font-weight:800;background:rgba(16,185,129,0.15);color:#10b981;padding:1px 6px;border-radius:4px">✓ نُفّذت</span>' : ''}
            </div>
            <div style="font-size:10px;color:var(--text-3);display:flex;align-items:center;gap:4px">
              <span style="color:${dr?.status === STATUS.AVAILABLE ? 'var(--success)' : 'var(--text-2)'}">${STATUS_AR[dr?.status] || dr?.status || 'متاح'}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Individual Driver Working Time in Mission (Editable with real-time duration) -->
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;background:var(--surface-2);border:1px solid var(--line);padding:4px 8px;border-radius:7px;flex-wrap:wrap">
        <span style="color:var(--text-2);font-weight:800">⏰ وقت السائق:</span>
        <span style="color:var(--text-3);font-weight:700">من</span>
        <input type="time" class="time-input-inline driver-work-time" value="${drStart}" data-asgid="${a.id}" data-field="start" title="وقت بداية عمل هذا السائق" style="padding:2px 6px;font-size:12px;font-weight:800;border:1px solid var(--line);border-radius:5px;background:var(--surface-card);color:var(--text);width:76px;text-align:center">
        <span style="color:var(--text-3);font-weight:700">إلى</span>
        <input type="time" class="time-input-inline driver-work-time" value="${drEnd}" data-asgid="${a.id}" data-field="end" title="وقت نهاية عمل هذا السائق" style="padding:2px 6px;font-size:12px;font-weight:800;border:1px solid var(--line);border-radius:5px;background:var(--surface-card);color:var(--text);width:76px;text-align:center">
        <span class="dr-dur-label" style="color:var(--color-accent);font-weight:800;font-size:11px">(${drDuration})</span>
        <span class="save-badge" style="display:none;color:#10b981;font-weight:800;font-size:10px">✓ حُفظ</span>
      </div>

      <!-- 3. Actions -->
      ${isMgr ? `
        <div style="display:flex;align-items:center;gap:6px">
          ${!isExecuted ? `
            <button type="button" class="btn-commit-exec" data-op-commit="1" data-asgid="${a.id}" data-drid="${dr?.id}" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" style="padding:4px 10px;font-size:11px;font-weight:800;border-radius:6px;background:rgba(16,185,129,0.12);color:#059669;border:1px solid rgba(16,185,129,0.3);cursor:pointer;white-space:nowrap" title="تسجيل التنفيذ الفعلي">
              🏁 تنفيذ
            </button>
          ` : ''}
          <button type="button" class="day-chip-btn" data-op-remove="1" data-asgid="${a.id}" style="padding:4px 8px;font-size:11px;color:#ef4444;border-radius:6px;border:1px solid rgba(239,68,68,0.25);background:rgba(239,68,68,0.06);cursor:pointer;white-space:nowrap" title="إلغاء التكليف">
            ✕ إزالة
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════
// Operational Period Card (Missions View)
// ═══════════════════════════════════════
function renderOperationalPeriodCard(op, driverMap, teamMap, squadDrivers, isMgr) {
  const { occurrence: occ, mission: m, period: p, periodCode, range, assignments, needed, shortageCount, isActiveNow, isUpcomingToday, category } = op;
  const team = m.teamId ? teamMap.get(m.teamId) : null;
  const startStr = range.start.toTimeString().slice(0, 5);
  const endStr = range.end.toTimeString().slice(0, 5);
  const totalPeriodDur = calcDuration(startStr, endStr).humanText || '—';

  // Separate assigned drivers into Light Vehicle vs Shared Transport
  const lightAsgs = [];
  const sharedAsgs = [];

  for (const a of assignments) {
    const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
    const drCat = dr?.category || category;
    if (drCat === DRIVER_CATEGORY.SHARED) {
      sharedAsgs.push({ asg: a, driver: dr });
    } else {
      lightAsgs.push({ asg: a, driver: dr });
    }
  }

  return `
    <div class="card" style="padding:14px 16px;border:1px solid ${isActiveNow ? 'rgba(239,68,68,0.35)' : 'var(--line)'};border-radius:12px;background:var(--surface-card);box-shadow:var(--shadow-1);margin-bottom:14px">
      <!-- 1. MISSION HEADER (Title, Category, Timing, Status, Total Drivers) -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:15px;font-weight:900;color:var(--text)">📌 ${esc(m.name)}</span>
          ${p.name && p.name !== 'فترة التكليف' ? `
            <span style="font-size:11px;font-weight:700;background:var(--surface-2);color:var(--text-2);padding:2px 8px;border-radius:6px">
              ${esc(p.name)}
            </span>
          ` : ''}
          <span class="${category === DRIVER_CATEGORY.SHARED ? 'badge-cat-transport' : 'badge-cat-leger'}">
            ${category === DRIVER_CATEGORY.SHARED ? '🚌 نقل مشترك' : '🚗 وزن خفيف'}
          </span>
          ${isActiveNow ? '<span class="badge-status-driving"><span class="pulse-dot"></span> جارية بالميدان</span>' : ''}
          ${!isActiveNow && isUpcomingToday ? '<span style="font-size:11px;font-weight:700;color:var(--text-3);background:var(--surface-2);padding:2px 8px;border-radius:6px">⏳ قادمة</span>' : ''}
        </div>

        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <!-- Mission Timing with Edit Button -->
          <div style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:var(--text);background:var(--surface-2);padding:4px 10px;border-radius:8px;border:1px solid var(--line)">
            <span>⏰ ${esc(startStr)} — ${esc(endStr)}</span>
            <span style="font-size:10px;color:var(--text-3);font-weight:normal">(${totalPeriodDur})</span>
            ${isMgr ? `
              <button type="button" class="btn-edit-mission-time" data-occid="${occ.id}" data-mname="${esc(m.name)}" data-curstart="${startStr}" data-curend="${endStr}" style="background:none;border:none;cursor:pointer;padding:0 2px;color:var(--text-3);font-size:12px;line-height:1" title="تعديل توقيت المهمة">
                ✏️
              </button>
            ` : ''}
          </div>

          <!-- Total Drivers Assigned Status -->
          <span style="font-size:11px;font-weight:800;color:var(--text);background:var(--surface-2);padding:4px 10px;border-radius:8px;border:1px solid var(--line)">
            👥 إجمالي السواق: <b>${assignments.length}</b>
          </span>
        </div>
      </div>

      <!-- 2. TWO PARALLEL COLUMNS: LIGHT DRIVERS FACING SHARED TRANSPORT DRIVERS -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(310px, 1fr));gap:14px;align-items:start">
        <!-- 🚗 A. SECTION: LIGHT VEHICLE DRIVERS (LÉGER) -->
        <div style="background:rgba(37,99,235,0.02);border:1px solid rgba(37,99,235,0.18);border-radius:10px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:15px">🚗</span>
              <span style="font-size:12px;font-weight:900;color:var(--text)">سواق الوزن الخفيف (Léger):</span>
              <span style="font-size:10px;font-weight:800;background:rgba(37,99,235,0.12);color:#2563eb;padding:1px 8px;border-radius:6px;border:1px solid rgba(37,99,235,0.25)">
                ${lightAsgs.length} سائق
              </span>
            </div>

            ${isMgr ? `
              <button type="button" class="btn-open-driver-picker" data-pick-driver="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-reqcat="LIGHT" style="padding:4px 10px;font-size:11px;font-weight:800;border-radius:6px;background:rgba(37,99,235,0.08);color:#2563eb;border:1px solid rgba(37,99,235,0.3);cursor:pointer;display:inline-flex;align-items:center;gap:4px">
                <span>➕</span>
                <span>إضافة سائق وزن خفيف</span>
              </button>
            ` : ''}
          </div>

          <!-- Light Drivers List -->
          ${lightAsgs.length > 0 ? `
            <div style="display:flex;flex-direction:column;gap:6px">
              ${lightAsgs.map(({ asg: a, driver: dr }) => renderDriverRowInMission(a, dr, occ, m, periodCode, startStr, endStr, isMgr, 'LIGHT')).join('')}
            </div>
          ` : `
            <div style="font-size:11px;color:var(--text-3);padding:6px 10px;background:var(--surface-card);border-radius:6px;border:1px dashed var(--line);display:flex;justify-content:space-between;align-items:center">
              <span>لا يوجد سواق وزن خفيف مكلفين حالياً في هذه المهمة</span>
              ${isMgr ? `
                <button type="button" class="btn-open-driver-picker" data-pick-driver="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-reqcat="LIGHT" style="background:none;border:none;color:#2563eb;font-size:11px;font-weight:800;cursor:pointer;padding:0 4px">
                  + تعيين سائق خفيف
                </button>
              ` : ''}
            </div>
          `}
        </div>

        <!-- 🚌 B. SECTION: SHARED TRANSPORT DRIVERS (TRANSPORT) -->
        <div style="background:rgba(16,185,129,0.02);border:1px solid rgba(16,185,129,0.18);border-radius:10px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:15px">🚌</span>
              <span style="font-size:12px;font-weight:900;color:var(--text)">سواق حافلات النقل المشترك (Transport):</span>
              <span style="font-size:10px;font-weight:800;background:rgba(16,185,129,0.12);color:#059669;padding:1px 8px;border-radius:6px;border:1px solid rgba(16,185,129,0.25)">
                ${sharedAsgs.length} سائق
              </span>
            </div>

            ${isMgr ? `
              <button type="button" class="btn-open-driver-picker" data-pick-driver="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-reqcat="SHARED" style="padding:4px 10px;font-size:11px;font-weight:800;border-radius:6px;background:rgba(16,185,129,0.08);color:#059669;border:1px solid rgba(16,185,129,0.3);cursor:pointer;display:inline-flex;align-items:center;gap:4px">
                <span>➕</span>
                <span>إضافة سائق نقل مشترك</span>
              </button>
            ` : ''}
          </div>

          <!-- Shared Drivers List -->
          ${sharedAsgs.length > 0 ? `
            <div style="display:flex;flex-direction:column;gap:6px">
              ${sharedAsgs.map(({ asg: a, driver: dr }) => renderDriverRowInMission(a, dr, occ, m, periodCode, startStr, endStr, isMgr, 'SHARED')).join('')}
            </div>
          ` : `
            <div style="font-size:11px;color:var(--text-3);padding:6px 10px;background:var(--surface-card);border-radius:6px;border:1px dashed var(--line);display:flex;justify-content:space-between;align-items:center">
              <span>لا يوجد سواق نقل مشترك مكلفين حالياً في هذه المهمة</span>
              ${isMgr ? `
                <button type="button" class="btn-open-driver-picker" data-pick-driver="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-reqcat="SHARED" style="background:none;border:none;color:#059669;font-size:11px;font-weight:800;cursor:pointer;padding:0 4px">
                  + تعيين سائق حافلة
                </button>
              ` : ''}
            </div>
          `}
        </div>

        <!-- 3. UNFILLED SHORTAGE ALERT (IF APPLICABLE) -->
        ${shortageCount > 0 ? `
          <div style="background:rgba(245,158,11,0.06);border:1px dashed rgba(245,158,11,0.3);border-radius:8px;padding:6px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
            <div style="font-size:11px;font-weight:800;color:var(--text);display:flex;align-items:center;gap:6px">
              <span>⚠️</span>
              <span>متبقي ${shortageCount} سائق للوصول للحد الأدنى للمهمة (${needed})</span>
            </div>

            ${isMgr ? `
              <button type="button" class="btn-instant-assign" data-quick-assign-suggest="1" data-mid="${m.id}" data-pcode="${periodCode}" data-occid="${occ.id}" data-start="${range.start.toISOString()}" data-end="${range.end.toISOString()}" data-reqcat="${category}" style="padding:4px 10px;font-size:11px;font-weight:800;border-radius:6px">
                ⚡ تعيين المستحق بالدور
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════
// Driver Schedule View ("وتظهر مهام السواق للسواق")
// ═══════════════════════════════════════
function renderDriverRosterView({ drivers, lightDrivers, sharedDrivers, allAssignments, missionMap, teamMap, currentDate, isMgr }) {
  return `
    <div class="card" style="padding:16px;border:1px solid var(--line);background:var(--surface-card);border-radius:14px;box-shadow:var(--shadow-1)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:16px;font-weight:900;margin:0;color:var(--text)">جدول مهام السواق الميداني</h3>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">
            استعراض المهام المسندة لكل سائق، وتوقيت البداية والنهاية الدقيق
          </div>
        </div>

        <div class="roster-search-wrap">
          <input type="text" id="driverRosterSearchInput" class="input" placeholder="🔍 ابحث عن اسم السائق..." style="width:100%;padding:8px 12px;font-size:12px;border-radius:9px">
        </div>
      </div>

      <!-- 1. LIGHT DRIVERS SQUAD -->
      <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid rgba(37,99,235,0.25)">
          <span style="font-size:18px">🚗</span>
          <span style="font-weight:900;font-size:14px;color:var(--text)">فرقة سواق الوزن الخفيف (${lightDrivers.length} سائق)</span>
        </div>
        <div class="driver-roster-grid">
          ${lightDrivers.map(d => renderSingleDriverCard(d, allAssignments, missionMap, teamMap, isMgr)).join('')}
        </div>
      </div>

      <!-- 2. SHARED DRIVERS SQUAD -->
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid rgba(16,185,129,0.25)">
          <span style="font-size:18px">🚌</span>
          <span style="font-weight:900;font-size:14px;color:var(--text)">فرقة سواق النقل المشترك (${sharedDrivers.length} سائق)</span>
        </div>
        <div class="driver-roster-grid">
          ${sharedDrivers.map(d => renderSingleDriverCard(d, allAssignments, missionMap, teamMap, isMgr)).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderSingleDriverCard(d, allAssignments, missionMap, teamMap, isMgr) {
  const tm = teamMap.get(d.teamId);
  const driverAsgs = allAssignments.filter(a =>
    (Number(a.actualDriverId) === Number(d.id) || Number(a.plannedDriverId) === Number(d.id)) &&
    a.status !== ASG_STATUS.CANCELLED
  );

  return `
    <div class="driver-roster-card" data-driver-name="${esc(d.name.toLowerCase())}" style="background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="driver-clickable" data-open-driver="${d.id}" style="display:flex;align-items:center;gap:8px;cursor:pointer" title="انقر لمعاينة ملف وحالة السائق المباشرة">
          <div style="width:32px;height:32px;border-radius:8px;background:${d.category === DRIVER_CATEGORY.SHARED ? 'linear-gradient(135deg,#047857,#059669)' : 'linear-gradient(135deg,#1d4ed8,#2563eb)'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px">
            ${esc(d.name.charAt(0))}
          </div>
          <div>
            <div style="font-weight:800;font-size:13px;color:var(--text);display:flex;align-items:center;gap:4px">
              <span>${esc(d.name)}</span>
              <span style="font-size:11px;color:var(--text-3);opacity:0.8">👁️</span>
            </div>
            ${tm ? `<div style="font-size:10px;color:var(--text-3)">${esc(tm.name)}</div>` : ''}
          </div>
        </div>

        <span style="font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;background:${d.status === STATUS.AVAILABLE ? 'rgba(16,185,129,0.15);color:#10b981' : 'rgba(239,68,68,0.15);color:#ef4444'}">
          ${STATUS_AR[d.status] || d.status}
        </span>
      </div>

      <div style="border-top:1px solid var(--line);padding-top:8px">
        <div style="font-size:11px;font-weight:800;color:var(--text-2);margin-bottom:4px">
          مهام اليوم (${driverAsgs.length}):
        </div>

        ${driverAsgs.length === 0 ? `
          <div style="font-size:11px;color:var(--text-3);padding:4px 0">
            لا توجد مهام مسندة لهذا السائق في هذا اليوم
          </div>
        ` : driverAsgs.map(a => {
          const m = missionMap.get(a.missionId);
          const startStr = formatTimeHhmm(a.startIso, '00:00');
          const endStr = formatTimeHhmm(a.endIso, '00:00');
          const durObj = calcDuration(startStr, endStr);
          const durText = durObj.humanText || '—';
          const isExecuted = Boolean(a.executedAt);

          return `
            <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-weight:800;font-size:12px;color:var(--text)">${esc(m?.name || 'مهمة')}</div>
                <div style="font-size:10px;color:var(--text-2);margin-top:2px">
                  ⏰ من ${esc(startStr)} إلى ${esc(endStr)} (${durText})
                </div>
              </div>
              <div>
                ${isExecuted ? '<span style="font-size:10px;font-weight:800;background:rgba(16,185,129,0.2);color:#10b981;padding:2px 6px;border-radius:4px">✓ نُفّذت</span>' : '<span style="font-size:10px;color:var(--text-3)">مجدولة</span>'}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}
