// ═══════════════════════════════════════
// views.js — كل الشاشات (النسخة النهائية المُصحَّحة)
// ═══════════════════════════════════════
import {
  listDrivers, createDriver,
  STATUS_AR, STATUS_COLOR
} from '../domain/drivers.js';

import {
  listMissions, getMission, createMission, editMission,
  disableMission, seedCatalog, getMissionPeriods
} from '../domain/missions.js';

import { listTeams, getTeam, createTeam } from '../domain/teams.js';
import { listLoans, recordShortage, LOAN_STATUS } from '../domain/loans.js';
import { openNewLoanModal } from './views-loans.js';

import {
  listByDate, createOccurrence, getOccurrence, updateOccurrence
} from '../domain/occurrences.js';

import {
  listByOccurrence, createProposal,
  confirm as confirmProposal,
  cancel, ASG_STATUS
} from '../domain/assignments.js';

import {
  FOREST_PERIODS, periodRange, periodLabel
} from '../engine/shared-transport.js';

import { suggestForTurn, commitExecution } from '../engine/fairness.js';
import { listUnresolved, setPolicy, resolveMissed } from '../domain/missed-turns.js';
import { isManager, isLeader, getSession, ROLE_LABEL } from '../core/auth.js';
import { sheet, toast, refresh, logout, setupCollapsible, attachRipple } from './helpers.js';

import {
  todayIso, addDays, humanDate, humanDateFull, dayNameAr, isToday,
  fmtDur, fmtDurShort, relativeDay, buildStart, addMin, toMin,
  isoToDate, fromMinSafe
} from '../core/clock.js';

import { exportBackup, importBackup } from '../core/backup.js';

let currentDate = todayIso();

const STATUS_CLASS = {
  AVAILABLE:'ok', VACATION:'warn', SICK:'bad',
  UNAVAILABLE:'warn', ABSENT:'warn', DISABLED:'muted'
};
const AV_CLASS = {
  AVAILABLE:'', VACATION:'vacation', SICK:'sick',
  UNAVAILABLE:'unavailable', ABSENT:'unavailable', DISABLED:'disabled'
};

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════
// بيانات مساعدة
// ═══════════════════════════════════════
async function computeDriverProfile(driverId) {
  const { all } = await import('../core/db.js');
  const [drivers, missions, occurrences, assignments, statusHist, teams, loans] =
    await Promise.all([
      all('drivers'), all('missions'), all('occurrences'),
      all('assignments'), all('status_history'), all('teams'), all('loans')
    ]);
  const driver = drivers.find(d => d.id === driverId);
  const team = teams.find(t => t.id === (driver?.teamId || 1)) || teams[0] || null;
  const missionMap = new Map(missions.map(m => [m.id, m]));
  const occMap = new Map(occurrences.map(o => [o.id, o]));
  const session = getSession();
  const viewerIsSelf = session?.driverId === driverId;
  const viewerIsManager = isManager();
  const vacationVisible = viewerIsSelf || viewerIsManager;
  const history = [];
  let borrowedMissions = 0;
  for (const a of assignments) {
    if (a.status === ASG_STATUS.CANCELLED) continue;
    const did = a.actualDriverId || a.plannedDriverId;
    if (did !== driverId) continue;
    const o = occMap.get(a.occurrenceId);
    if (!o || o.cancelled) continue;
    const m = missionMap.get(o.missionId);
    if (!m) continue;
    if (a.source === 'BORROWED') borrowedMissions++;
    let startDate, endDate;
    const periods = getMissionPeriods(m);
    const pCode = a.periodCode || a.periodId;
    const p = pCode ? periods.find(x => x.code === pCode) : null;
    if (p) {
      const r = periodRange(p, o.dateIso);
      startDate = r.start;
      endDate = r.end;
    }
    if (!startDate) {
      startDate = buildStart(o.dateIso, o.startTime);
      endDate = addMin(startDate, o.durationMinutes);
    }
    history.push({
      assignment: a, occurrence: o, mission: m,
      start: startDate, end: endDate, dateIso: o.dateIso,
      periodCode: pCode || null,
      period: p || null,
      isBorrowed: a.source === 'BORROWED',
      durationMinutes: Math.round((endDate - startDate) / 60000)
    });
  }
  history.sort((a, b) => b.start - a.start);
  const myStatus = statusHist.filter(s => s.driverId === driverId)
    .sort((a, b) => a.at.localeCompare(b.at));
  const vacations = myStatus.filter(s => s.status === 'VACATION');
  const lastVacation = vacations[vacations.length - 1] || null;
  const multiShiftCycles = new Set();
  let multiShiftPeriods = 0, normalMissions = 0;
  for (const h of history) {
    const isMulti = Boolean(h.periodCode || h.mission?.type === 'MULTI_SHIFT' || h.mission?.type === 'FOREST' || (h.mission?.periods && h.mission.periods.length > 1));
    if (isMulti) {
      multiShiftCycles.add(h.occurrence.id);
      multiShiftPeriods++;
    } else {
      normalMissions++;
    }
  }
  const myLoans = loans.filter(l => l.driverId === driverId);
  const activeLoan = myLoans.find(l => l.status === LOAN_STATUS.ACTIVE) || null;

  return {
    driver, team, history,
    lastVacation: vacationVisible ? lastVacation : null,
    vacationVisible,
    lastMission: history[0] || null,
    multiShiftCycles: multiShiftCycles.size,
    multiShiftPeriods,
    forestCycles: multiShiftCycles.size,
    forestPeriods: multiShiftPeriods,
    normalMissions,
    borrowedMissions,
    myLoans, activeLoan,
    missionMap,
    totalMinutes: history.reduce((s, h) => s + h.durationMinutes, 0)
  };
}

async function computeDriverSummary(profile) {
  const { history } = profile;
  const last = history[0] || null;
  const prev = history[1] || null;
  let restBetweenText = '—', restBetweenMinutes = null;
  if (last && prev) {
    const mins = Math.floor((last.start - prev.end) / 60000);
    restBetweenMinutes = mins;
    restBetweenText = mins > 0 ? fmtDurShort(mins) : 'مهمة متتالية!';
  }
  let currentRestText = '—', currentRestMinutes = null, workingNow = false;
  if (last) {
    const now = new Date();
    if (now >= last.start && now <= last.end) {
      workingNow = true;
      currentRestText = 'يعمل الآن';
    } else if (now > last.end) {
      currentRestMinutes = Math.floor((now - last.end) / 60000);
      if (currentRestMinutes > 0) {
        const days = Math.floor(currentRestMinutes / 1440);
        const hours = Math.floor((currentRestMinutes % 1440) / 60);
        currentRestText = days > 0 ? `${days} ي ${hours} س` : fmtDurShort(currentRestMinutes);
      }
    }
  }
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisWeek = history.filter(h => h.start >= weekStart);
  const thisMonth = history.filter(h => h.start >= monthStart);
  return {
    last, prev, restBetweenText, restBetweenMinutes,
    currentRestText, currentRestMinutes, workingNow,
    weekCount: thisWeek.length,
    weekMinutes: thisWeek.reduce((s, h) => s + h.durationMinutes, 0),
    monthCount: thisMonth.length,
    monthMinutes: thisMonth.reduce((s, h) => s + h.durationMinutes, 0)
  };
}

// ═══════════════════════════════════════
// HOME
// ═══════════════════════════════════════
export async function renderHome(main) {
  const [occurrences, missions, drivers] = await Promise.all([
    listByDate(currentDate),
    listMissions(true),
    listDrivers()
  ]);
  const missionMap = new Map(missions.map(m => [m.id, m]));
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  const profiles = {};
  for (const d of drivers) profiles[d.id] = await computeDriverProfile(d.id);
  const summaries = {};
  for (const d of drivers) summaries[d.id] = await computeDriverSummary(profiles[d.id]);
  const allAsg = [];
  for (const o of occurrences) {
    const list = await listByOccurrence(o.id);
    for (const a of list) allAsg.push({ ...a, occurrenceId: o.id });
  }
  const isMgr = isManager();
  main.innerHTML = `
    ${renderDateBar()}
    ${isMgr ? '' : '<div class="readonly-banner">📖 عرض فقط — لا يمكنك التعديل</div>'}
    <div class="section" id="missionSection">
      <div class="section-head">
        <div class="title">
          📋 مهام اليوم
          <span class="count ${occurrences.length ? 'accent' : ''}">${occurrences.length}</span>
        </div>
        <div class="spacer"></div>
        <div class="chev">▾</div>
      </div>
      <div class="section-body">
        ${occurrences.length === 0
          ? `<div class="empty-block">
              <div class="ic">📭</div>
              <h3>لا مهام ${isToday(currentDate) ? 'اليوم' : 'في ' + esc(humanDate(currentDate))}</h3>
              ${isMgr ? '<p>اضغط "+ إضافة مهمة" للبدء</p>' : ''}
            </div>`
          : occurrences.map(o =>
              renderMissionCard(o, missionMap, driverMap, allAsg, isMgr)
            ).join('')}
      </div>
    </div>
    <div class="section" id="driversSection">
      <div class="section-head">
        <div class="title">
          👥 السواق
          <span class="count">${drivers.length}</span>
        </div>
        <div class="spacer"></div>
        <div class="chev">▾</div>
      </div>
      <div class="section-body">
        ${drivers.length === 0
          ? `<div class="empty-block"><div class="ic">👤</div><h3>لا سواق مسجلون</h3></div>`
          : drivers.map(d => renderDriverCardCompact(profiles[d.id], summaries[d.id])).join('')}
      </div>
    </div>
    <div class="section" id="pastSection">
      <div class="section-head">
        <div class="title">
          📅 الأيام السابقة
          <span class="count" id="pastCount">…</span>
        </div>
        <div class="spacer"></div>
        <div class="chev">▾</div>
      </div>
      <div class="section-body" id="pastDaysBody">
        <div class="pdc-loading">جارٍ التحميل…</div>
      </div>
    </div>
    ${isMgr ? `
      <button class="fab" id="fabAdd">
        <span class="plus">+</span>
        <span>إضافة مهمة</span>
      </button>
    ` : ''}
  `;
  setupCollapsible(main.querySelector('#missionSection'), { open: true });
  setupCollapsible(main.querySelector('#driversSection'), { open: true });
  setupCollapsible(main.querySelector('#pastSection'), { open: false });
  wireDateBar(main);

  main.querySelectorAll('[data-mission]').forEach(el => {
    const occId = Number(el.dataset.mission);
    const head = el.querySelector('.mission-head');
    if (head) {
      head.onclick = async (e) => {
        if (e.target.closest('button')) return;
        const occ = await getOccurrence(occId);
        const mis = await getMission(occ.missionId);
        const periods = getMissionPeriods(mis);
        if (mis?.type === 'FOREST' || mis?.type === 'MULTI_SHIFT' || (periods && periods.length > 1)) {
          openMultiShiftMission(occId, mis);
        } else {
          el.classList.toggle('expanded');
        }
      };
    }
  });

  main.querySelectorAll('[data-add-driver]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); openDriverPicker(Number(btn.dataset.addDriver)); };
  });

  main.querySelectorAll('[data-borrow-driver], [data-borrow-for-occ]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const occId = Number(btn.dataset.borrowDriver || btn.dataset.borrowForOcc);
      const mid = Number(btn.dataset.mid);
      openNewLoanModal({ occurrenceId: occId, missionId: mid, dateIso: currentDate });
    };
  });

  main.querySelectorAll('[data-remove-driver]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const aid = Number(btn.dataset.removeDriver);
      if (!window.confirm('هل أنت متأكد من إزالة هذا السائق من المهمة؟')) return;
      await cancel(aid, 'إزالة يدوية من القائد');
      toast('تمت الإزالة بنجاح', 2200, 'success');
      refresh();
    };
  });

  main.querySelectorAll('[data-edit-mission]').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); openEditTime(Number(btn.dataset.editMission)); };
  });

  main.querySelectorAll('[data-cancel-mission]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const occId = Number(btn.dataset.cancelMission);
      const r = prompt('يرجى ذكر سبب إلغاء هذه المهمة (إلزامي للتوثيق):');
      if (!r || !r.trim()) return;
      await updateOccurrence(occId, { cancelled: true, cancelReason: r.trim() });
      toast('تم إلغاء المهمة', 2200, 'warn');
      refresh();
    };
  });

  main.querySelectorAll('[data-driver]').forEach(el => {
    el.onclick = () => openDriverProfile(Number(el.dataset.driver));
  });

  main.querySelector('#fabAdd')?.addEventListener('click', () => openMissionPicker());
  main.querySelectorAll('.mission-head, .driver-profile-card, .section-head, .fab')
    .forEach(attachRipple);

  (async () => {
    const body = main.querySelector('#pastDaysBody');
    if (!body) return;
    const html = await renderPastDaysSection();
    body.innerHTML = html;
    wirePastDays(body);
    const c = body.querySelectorAll('.past-day-card').length;
    const counter = main.querySelector('#pastCount');
    if (counter) counter.textContent = c;
  })();
}

function renderDateBar() {
  const isCur = isToday(currentDate);
  return `
    <div class="datebar" id="datebar">
      <button class="nav" id="dPrev" title="اليوم السابق">‹</button>
      <div class="info" id="dInfo" title="اضغط لاختيار تاريخ">
        <div class="d1">${esc(humanDate(currentDate))}</div>
        <div class="d2">${esc(dayNameAr(currentDate))}</div>
      </div>
      <button class="today-btn ${!isCur ? 'show' : ''}" id="dToday">اليوم</button>
      <button class="nav" id="dNext" title="اليوم التالي">›</button>
    </div>
  `;
}

function wireDateBar(main) {
  main.querySelector('#dPrev').onclick = () => { currentDate = addDays(currentDate, -1); refresh(); };
  main.querySelector('#dNext').onclick = () => { currentDate = addDays(currentDate, 1); refresh(); };
  main.querySelector('#dToday')?.addEventListener('click', () => { currentDate = todayIso(); refresh(); });
  main.querySelector('#dInfo').onclick = () => {
    const d = prompt('أدخل التاريخ المطلوب (YYYY-MM-DD):', currentDate);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    currentDate = d; refresh();
  };
}

function renderMissionCard(o, missionMap, driverMap, allAsg, isMgr) {
  const m = missionMap.get(o.missionId);
  if (!m) return '';
  const periods = getMissionPeriods(m);
  const isMultiPeriod = m.type === 'FOREST' || m.type === 'MULTI_SHIFT' || (periods && periods.length > 1);
  const asgForOcc = allAsg.filter(a =>
    a.occurrenceId === o.id && a.status !== ASG_STATUS.CANCELLED
  );
  const filled = asgForOcc.length;
  const total = isMultiPeriod
    ? periods.reduce((sum, p) => sum + (p.driversNeeded || 1), 0)
    : m.driversNeeded;
  const shortage = Math.max(0, total - filled);
  const full = filled >= total;
  const pct = Math.min(100, (filled / total) * 100);
  const cls = [
    isMultiPeriod ? 'forest' : '',
    m.locationType === 'indoor' ? 'indoor' : '',
    o.cancelled ? 'cancelled' : '',
    full ? 'complete' : shortage > 0 ? 'shortage-card' : 'normal'
  ].filter(Boolean).join(' ');
  const startStr = o.startTime;
  const endStr = fromMinSafe(toMin(o.startTime) + o.durationMinutes);
  return `
    <div class="mission ${cls}" data-mission="${o.id}">
      <div class="mission-head">
        <div class="body">
          <div class="name">
            ${esc(m.name)}
            ${isMultiPeriod ? `<span class="tag info">🔄 ${periods.length} فترات</span>` : ''}
            ${m.locationType === 'indoor' ? '<span class="tag indoor">داخلية</span>' : ''}
            ${o.cancelled ? '<span class="tag danger">ملغى</span>' : ''}
            ${shortage > 0 && !o.cancelled ? `<span class="tag shortage">⚠️ نقص (${shortage})</span>` : ''}
          </div>
          <div class="times">
            <b>${esc(startStr)} → ${esc(endStr)}</b>
            <span class="dot"></span>
            <span>${esc(fmtDur(o.durationMinutes))}</span>
            ${isMultiPeriod ? `<span class="dot"></span><span>${periods.length} فترات مناوبة</span>` : ''}
          </div>
        </div>
        ${!isMultiPeriod ? `
          <div class="progress">
            <div class="num ${full ? 'full' : shortage > 0 ? 'warn' : ''}">${filled}/${total}</div>
            <div class="bar"><div class="fill ${full ? 'full' : ''}" style="width:${pct}%"></div></div>
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:12px;font-weight:800;color:${full ? 'var(--ok)' : 'var(--accent)'}">${filled}/${total}</span>
            <span class="arrow" style="font-size:20px">›</span>
          </div>
        `}
      </div>
      ${!isMultiPeriod ? `
        <div class="mission-body">
          <div class="mission-body-inner">
            <div class="info-grid">
              <div class="cell"><div class="k">وقت المهمة</div><div class="v">${esc(startStr)} → ${esc(endStr)}</div></div>
              <div class="cell"><div class="k">المدة</div><div class="v">${esc(fmtDur(o.durationMinutes))}</div></div>
              <div class="cell"><div class="k">سواق مطلوبون</div><div class="v">${total}</div></div>
              <div class="cell"><div class="k">الموقع</div><div class="v">${m.locationType === 'indoor' ? 'داخلية' : 'خارجية'}</div></div>
            </div>
            
            ${shortage > 0 && !o.cancelled ? `
              <div class="shortage-banner">
                <div>
                  <b style="color:var(--danger)">⚠️ نقص ${shortage} سائق في هذه المهمة!</b>
                  <div style="font-size:11px;color:var(--text-2);margin-top:2px">المطلوب: ${total} · المعين: ${filled}</div>
                </div>
                ${isMgr ? `
                  <button class="tag" data-borrow-for-occ="${o.id}" data-mid="${m.id}" style="cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:5px 10px;font-family:inherit;font-weight:700">
                    🔄 استعارة سائق
                  </button>
                ` : ''}
              </div>
            ` : ''}

            <div class="drivers-list">
              <div class="head">السواق المعينون <b>(${filled}/${total})</b></div>
              ${asgForOcc.length === 0
                ? `<div class="empty-inline" style="padding:10px;text-align:center;color:var(--text-3);font-size:12px">لم يُعيَّن أحد بعد</div>`
                : asgForOcc.map(a => {
                    const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
                    const dueDr = driverMap.get(a.dueDriverId);
                    const isSub = a.actualDriverId && a.dueDriverId && a.actualDriverId !== a.dueDriverId;
                    const isBorrowed = a.source === 'BORROWED';
                    return `
                      <div class="driver-row">
                        <div class="av ${isBorrowed ? 'borrowed' : isSub ? 'sub' : 'ok'}">${esc((dr?.name || '؟').charAt(0))}</div>
                        <div class="info">
                          <div class="n">
                            ${esc(dr?.name || '—')}
                            ${isBorrowed ? '<span class="tag borrowed" style="margin-right:4px">🔄 مستعار</span>' : ''}
                            ${isSub ? `<span class="sub">بديل عن ${esc(dueDr?.name || '—')}</span>` : ''}
                          </div>
                        </div>
                        ${isMgr ? `<button class="x" data-remove-driver="${a.id}" title="إزالة">✕</button>` : ''}
                      </div>
                    `;
                  }).join('')}
            </div>
            ${isMgr && !full && !o.cancelled ? `
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="add-driver-row" data-add-driver="${o.id}" style="flex:1">
                  <span>+</span><span>تعيين بالدور العادل</span>
                </button>
                <button class="add-driver-row" data-borrow-driver="${o.id}" data-mid="${m.id}" style="flex:1;background:var(--surface-2);color:var(--accent)">
                  <span>🔄</span><span>استعارة من فرقة</span>
                </button>
              </div>
            ` : ''}
            ${isMgr && !o.cancelled ? `
              <div class="mission-actions">
                <button class="edit" data-edit-mission="${o.id}">تعديل الوقت</button>
                <button class="del" data-cancel-mission="${o.id}">إلغاء المهمة</button>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderDriverCardCompact(profile, summary) {
  const { driver: d, lastVacation, vacationVisible, lastMission,
    forestCycles, normalMissions } = profile;
  const cls = STATUS_CLASS[d.status] || 'muted';
  const avCls = AV_CLASS[d.status] || '';
  let vacationRow = '';
  if (vacationVisible) {
    const text = lastVacation
      ? relativeDay(lastVacation.at.substring(0, 10))
      : 'لا توجد';
    vacationRow = `<div class="dpc-row">
      <span class="k">آخر إجازة</span><span class="v">${esc(text)}</span>
    </div>`;
  }
  const lastMissionText = lastMission
    ? `${lastMission.mission.name} · ${relativeDay(lastMission.dateIso)}`
    : 'لم يعمل بعد';
  const total = forestCycles + normalMissions;
  return `
    <div class="driver-profile-card" data-driver="${d.id}">
      <div class="dpc-head">
        <div class="av-lg ${avCls}">${esc(d.name.charAt(0))}</div>
        <div class="dpc-info">
          <div class="dpc-name">${esc(d.name)}</div>
          <div class="dpc-tags">
            <span class="tag ${cls}">${esc(STATUS_AR[d.status] || d.status)}</span>
            ${summary.workingNow ? '<span class="tag working">● يعمل الآن</span>' : ''}
          </div>
        </div>
        <span class="dpc-chev">›</span>
      </div>
      <div class="dpc-rows">
        ${vacationRow}
        <div class="dpc-row">
          <span class="k">آخر مهمة</span><span class="v">${esc(lastMissionText)}</span>
        </div>
        ${summary.last ? `
          <div class="dpc-row">
            <span class="k">الراحة الحالية</span>
            <span class="v ${summary.workingNow ? 'working' : summary.currentRestMinutes != null && summary.currentRestMinutes < 8 * 60 ? 'warn' : 'ok'}">${esc(summary.currentRestText)}</span>
          </div>
        ` : ''}
      </div>
      ${total > 0 ? `
        <div class="dpc-stats">
          ${forestCycles > 0 ? `
            <div class="dpc-stat forest">
              <span class="ic">🌲</span><b>${forestCycles}</b><span>غابة</span>
            </div>` : ''}
          ${normalMissions > 0 ? `
            <div class="dpc-stat normal">
              <span class="ic">📋</span><b>${normalMissions}</b><span>عادية</span>
            </div>` : ''}
          <div class="dpc-stat total">
            <span class="ic">📊</span><b>${total}</b><span>إجمالي</span>
          </div>
        </div>
      ` : `<div class="dpc-empty">لم ينفذ أي مهمة بعد</div>`}
    </div>
  `;
}

// ═══════════════════════════════════════
// Mission Picker
// ═══════════════════════════════════════
async function openMissionPicker() {
  const [missions, todays] = await Promise.all([
    listMissions(),
    listByDate(currentDate)
  ]);
  if (!missions.length) {
    sheet({
      title: 'لا توجد مهام', subtitle: 'أضف مهام من شاشة الإعدادات أولاً',
      builder: (body, close) => {
        body.innerHTML = `
          <p style="text-align:center;color:var(--text-3);margin-bottom:16px">الكتالوج فارغ حالياً. يمكنك تفعيل القالب الجاهز بـ 9 مهام من الإعدادات.</p>
          <button class="btn-primary" id="ok">حسنًا</button>`;
        body.querySelector('#ok').onclick = close;
      }
    });
    return;
  }
  const used = new Set(todays.map(o => o.missionId));
  sheet({
    title: 'إضافة مهمة لليوم',
    subtitle: `${esc(humanDateFull(currentDate))} · ${esc(dayNameAr(currentDate))}`,
    builder: (body, close) => {
      body.innerHTML = missions.map(m => {
        const isUsed = used.has(m.id);
        const endStr = fromMinSafe(toMin(m.startTime) + m.durationMinutes);
        const periods = getMissionPeriods(m);
        const isMulti = m.type === 'MULTI_SHIFT' || m.type === 'FOREST' || (periods && periods.length > 1);
        const color = isMulti ? 'var(--warn)'
          : m.locationType === 'indoor' ? 'var(--purple)' : 'var(--accent)';
        return `
          <div class="dp-row ${isUsed ? 'blocked' : ''}" data-mid="${m.id}">
            <div class="av" style="background:${color}">${esc((m.startTime || '00').slice(0, 2))}</div>
            <div class="body">
              <div class="n">${esc(m.name)}${isMulti ? ' 🔄' : ''}</div>
              <div class="tags">
                <span class="tag info">${esc(m.startTime)} → ${esc(endStr)}</span>
                <span class="tag">${esc(fmtDurShort(m.durationMinutes))}</span>
                <span class="tag">${m.driversNeeded} سواق</span>
                ${isMulti ? `<span class="tag">${periods.length} فترات</span>` : ''}
                ${isUsed ? '<span class="tag warn">مُضافة بالفعل</span>' : ''}
              </div>
            </div>
          </div>
        `;
      }).join('') + `<button class="btn-ghost" id="cancelBtn" style="margin-top:14px">إلغاء</button>`;
      body.querySelector('#cancelBtn').onclick = close;
      body.querySelectorAll('.dp-row:not(.blocked)').forEach(el => {
        el.onclick = async () => {
          const mid = Number(el.dataset.mid);
          const m = missions.find(x => x.id === mid);
          const id = await createOccurrence({
            dateIso: currentDate, missionId: mid,
            startTime: m.startTime, durationMinutes: m.durationMinutes
          });
          toast(`تمت إضافة ${esc(m.name)}`, 2200, 'success');
          close();
          const periods = getMissionPeriods(m);
          if (m.type === 'MULTI_SHIFT' || m.type === 'FOREST' || (periods && periods.length > 1)) {
            setTimeout(() => openMultiShiftMission(id, m), 300);
          } else {
            setTimeout(() => openDriverPicker(id), 300);
          }
          refresh();
        };
      });
    }
  });
}

// ═══════════════════════════════════════
// Driver Picker (مهمة عادية)
// ═══════════════════════════════════════
async function openDriverPicker(occId) {
  const o = await getOccurrence(occId);
  const m = await getMission(o.missionId);
  const start = buildStart(o.dateIso, o.startTime);
  const end = addMin(start, o.durationMinutes);
  const result = await suggestForTurn({
    missionId: m.id,
    periodId: null,
    occurrenceId: occId,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    targetTeamId: m.teamId || null
  });
  const enriched = [];
  for (const q of result.queue) {
    const profile = await computeDriverProfile(q.driver.id);
    const summary = await computeDriverSummary(profile);
    const sameMission = profile.history.filter(h => h.occurrence.missionId === m.id);
    enriched.push({
      ...q, profile, summary,
      sameMissionCount: sameMission.length,
      sameMissionLast: sameMission[0] || null,
      isSuggested: result.proposed?.id === q.driver.id
    });
  }
  sheet({
    title: `تعيين في ${esc(m.name)}`,
    subtitle: `${esc(o.startTime)} → ${esc(fromMinSafe(toMin(o.startTime) + o.durationMinutes))}`,
    builder: (body, close) => {
      let html = `<div class="turn-reason-banner ${result.isBorrow ? 'warn' : ''}">
        <div class="trb-icon">${result.isBorrow ? '⚠️' : '🎯'}</div>
        <div class="trb-text">${esc(result.reason)}</div>
      </div>`;

      if (result.internalShortage) {
        html += `
          <div style="background:#fffbeb;border:1px solid #fef3c7;border-radius:8px;padding:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:#92400e;font-weight:600">يوجد نقص في الفريق المعني. يمكنك توثيق النقص أو استعارة سائق:</span>
            <button id="pickerBorrowBtn" style="padding:4px 10px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:12px;cursor:pointer;font-weight:700">
              🔄 استعارة سائق
            </button>
          </div>
        `;
      }

      const suggested = enriched.find(e => e.isSuggested);
      const sameTeamOthers = enriched.filter(e => !e.isSuggested && e.isAvailable && e.isSameTeam);
      const otherTeamOthers = enriched.filter(e => !e.isSuggested && e.isAvailable && !e.isSameTeam);
      const blocked = enriched.filter(e => !e.isAvailable);

      if (suggested) {
        html += `<div class="sheet-section">⭐ المقترح الأول (${suggested.isSameTeam ? 'من داخل الفريق' : 'اقتراح استعارة خارجي'})</div>`;
        html += renderTurnCandidate(suggested, m);
      }
      if (sameTeamOthers.length) {
        html += `<div class="sheet-section">سائقو الفريق المتاحون</div>`;
        for (const c of sameTeamOthers) html += renderTurnCandidate(c, m);
      }
      if (otherTeamOthers.length) {
        html += `<div class="sheet-section" style="color:#d97706">سائقون متاحون من فرق أخرى (للاستعارة)</div>`;
        for (const c of otherTeamOthers) html += renderTurnCandidate(c, m);
      }
      if (blocked.length) {
        html += `<div class="sheet-section muted">غير متاحين حالياً</div>`;
        for (const c of blocked) html += renderBlockedTurn(c);
      }
      html += `<button class="btn-ghost" id="cancelBtn" style="margin-top:14px">إلغاء</button>`;
      body.innerHTML = html;

      body.querySelector('#cancelBtn').onclick = close;

      body.querySelector('#pickerBorrowBtn')?.addEventListener('click', () => {
        openNewLoanModal({
          occurrenceId: occId,
          missionId: m.id,
          dateIso: o.dateIso,
          onDone: () => { close(); refresh(); }
        });
      });

      body.querySelectorAll('.turn-candidate:not(.blocked)').forEach(el => {
        el.onclick = async () => {
          const did = Number(el.dataset.did);
          const cand = enriched.find(e => e.driver.id === did);
          if (cand && !cand.isSameTeam && m.teamId) {
            // Picked from external team - open loan modal pre-filled
            openNewLoanModal({
              fromTeamId: cand.team?.id || cand.driver.teamId,
              toTeamId: m.teamId,
              driverId: did,
              occurrenceId: occId,
              missionId: m.id,
              dateIso: o.dateIso,
              notes: `استعارة لمهمة ${m.name}`,
              onDone: () => { close(); refresh(); }
            });
            return;
          }
          await assignDriverToMission(occId, m.id, did, result.due?.id || did);
          toast('تم التعيين بنجاح', 2200, 'success');
          close(); refresh();
        };
      });
    }
  });
}

async function assignDriverToMission(occId, missionId, driverId, dueDriverId = null, extraOpts = {}) {
  const o = await getOccurrence(occId);
  const start = buildStart(o.dateIso, o.startTime);
  const end = addMin(start, o.durationMinutes);
  const due = dueDriverId ?? driverId;
  const isOverride = due && driverId && Number(due) !== Number(driverId);
  const repReason = extraOpts.replacementReason || (isOverride ? 'اختيار القائد لتجاوز صاحب الدور' : '');
  const aid = await createProposal({
    occurrenceId: occId, missionId, periodId: null,
    dueDriverId: due,
    plannedDriverId: driverId,
    startIso: start.toISOString(), endIso: end.toISOString(),
    rationale: 'تعيين يدوي من القائد', score: 0,
    source: extraOpts.source || 'TEAM',
    loanId: extraOpts.loanId || null,
    replacementReason: repReason,
    autoConfirm: true
  });
  await commitExecution({
    missionId, periodId: null, driverId,
    at: start.toISOString(), assignmentId: aid
  });
  return aid;
}

function renderTurnCandidate(c, mission) {
  const s = c.summary;
  const restColor = s.workingNow ? 'working'
    : !s.currentRestMinutes ? 'muted'
      : s.currentRestMinutes < 8 * 60 ? 'warn' : 'ok';
  let sameText;
  if (c.sameMissionCount === 0) sameText = 'لم يعمل هذه المهمة من قبل';
  else if (c.sameMissionCount === 1) sameText = `عملها مرة واحدة · آخرها ${relativeDay(c.sameMissionLast.dateIso)}`;
  else sameText = `عملها ${c.sameMissionCount} مرات · آخرها ${relativeDay(c.sameMissionLast.dateIso)}`;
  return `
    <div class="turn-candidate ${c.isSuggested ? 'suggested' : ''}" data-did="${c.driver.id}">
      <div class="tc-position">${c.position === 0 ? '🥇' : c.position === 1 ? '🥈' : c.position === 2 ? '🥉' : '#' + (c.position + 1)}</div>
      <div class="tc-head">
        <div class="av ok">${esc(c.driver.name.charAt(0))}</div>
        <div class="tc-info">
          <div class="tc-name">
            ${esc(c.driver.name)}
            ${c.position === 0 ? '<span class="tag due">صاحب الدور</span>' : ''}
            ${c.isSuggested && c.position !== 0 ? '<span class="tag sugg">التالي</span>' : ''}
            ${c.team ? `<span class="tag" style="background:#f1f5f9;color:#475569">${esc(c.team.name)}</span>` : ''}
            ${c.isSameTeam === false ? '<span class="tag" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a">🔄 استعارة</span>' : ''}
          </div>
          <div class="tc-status">
            <span class="tag ${STATUS_CLASS[c.driver.status]}">${esc(STATUS_AR[c.driver.status] || c.driver.status)}</span>
            ${s.workingNow ? '<span class="tag working">● يعمل الآن</span>' : ''}
          </div>
        </div>
      </div>
      ${c.isSuggested ? `<div class="tc-reason">${esc(c.reason || '')}</div>` : ''}
      <div class="tc-history">
        ${s.last ? `<div class="tc-row"><span class="k">آخر مهمة</span><span class="v">${esc(s.last.mission.name)} · ${relativeDay(s.last.dateIso)}</span></div>` : ''}
        ${s.prev ? `<div class="tc-row"><span class="k">قبلها</span><span class="v">${esc(s.prev.mission.name)} · ${relativeDay(s.prev.dateIso)}</span></div>` : ''}
        <div class="tc-row"><span class="k">الراحة الحالية</span><span class="v ${restColor}">${esc(s.currentRestText)}</span></div>
        ${s.restBetweenMinutes != null ? `<div class="tc-row"><span class="k">راحة بين الأخيرتين</span><span class="v ${s.restBetweenMinutes === 0 ? 'bad' : ''}">${esc(s.restBetweenText)}</span></div>` : ''}
      </div>
      <div class="tc-same ${c.sameMissionCount === 0 ? 'never' : ''}">
        <span>📌</span><span>${esc(sameText)}</span>
      </div>
    </div>
  `;
}

function renderBlockedTurn(c) {
  return `
    <div class="turn-candidate blocked">
      <div class="tc-position">#${c.position + 1}</div>
      <div class="tc-head">
        <div class="av off">${esc(c.driver.name.charAt(0))}</div>
        <div class="tc-info">
          <div class="tc-name">${esc(c.driver.name)}</div>
          <div class="tc-status"><span class="tag bad">${esc(c.reasonAr)}</span></div>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════
// Multi-Shift & Generic Period Management
// ═══════════════════════════════════════
async function openMultiShiftMission(occId, mission) {
  const o = await getOccurrence(occId);
  if (!o) return;
  const isMgr = isManager();
  const periods = getMissionPeriods(mission);
  const title = `🔄 ${mission.name}`;
  const subtitle = `${esc(humanDateFull(o.dateIso))} · ${periods.length} فترات تشغيلية (${fmtDur(o.durationMinutes)})`;

  sheet({
    title,
    subtitle,
    builder: (body, close) => {
      const render = async () => {
        const [assignments, drivers, teams] = await Promise.all([
          listByOccurrence(occId),
          listDrivers(),
          listTeams()
        ]);
        const driverMap = new Map(drivers.map(d => [d.id, d]));
        const teamMap = new Map(teams.map(t => [t.id, t]));
        const activeAsg = assignments.filter(a => a.status !== ASG_STATUS.CANCELLED);

        // Group assignments by period code
        const byPeriod = {};
        for (const p of periods) {
          const pCode = p.code || p.id;
          byPeriod[pCode] = activeAsg.filter(a => (a.periodCode || a.periodId) === pCode);
        }

        // Calculate totals
        const totalNeeded = periods.reduce((sum, p) => sum + (p.driversNeeded || 1), 0);
        const totalFilled = activeAsg.length;
        const totalShortage = Math.max(0, totalNeeded - totalFilled);
        const filledPeriodsCount = periods.filter(p => {
          const pCode = p.code || p.id;
          return (byPeriod[pCode] || []).length >= (p.driversNeeded || 1);
        }).length;

        // Fetch suggestions for periods with shortages
        const suggestions = {};
        for (const p of periods) {
          const pCode = p.code || p.id;
          const asgs = byPeriod[pCode] || [];
          if (asgs.length < (p.driversNeeded || 1)) {
            const r = periodRange(p, o.dateIso);
            const res = await suggestForTurn({
              missionId: mission.id,
              periodId: pCode,
              occurrenceId: occId,
              startIso: r.start.toISOString(),
              endIso: r.end.toISOString(),
              targetTeamId: mission.teamId || null
            });
            suggestions[pCode] = res;
          }
        }

        let html = `
          <div class="forest-summary">
            <div class="fs-stat"><b>${filledPeriodsCount}/${periods.length}</b><span>فترات مكتملة</span></div>
            <div class="fs-stat"><b>${totalFilled}/${totalNeeded}</b><span>سواق معينون</span></div>
            <div class="fs-stat ${totalShortage > 0 ? 'warn' : ''}"><b>${totalShortage}</b><span>نقص السواق</span></div>
          </div>
        `;

        if (totalShortage > 0) {
          html += `
            <div class="shortage-banner" style="margin-bottom:14px">
              <div>
                <b style="color:var(--danger)">⚠️ تنبيه عجز في القوة البشرية:</b>
                <div style="font-size:12px;color:var(--text-2);margin-top:2px">
                  يوجد نقص إجمالي قدره ${totalShortage} سائق. يمكنك الاستعارة من الفرق الزميلة لتغطية العجز فوراً.
                </div>
              </div>
              ${isMgr ? `
                <button class="tag" id="borrowGlobalBtn" style="cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 12px;font-family:inherit;font-weight:700">
                  🔄 استعارة سائق
                </button>
              ` : ''}
            </div>
          `;
        }

        html += `<div class="forest-section-title">⏱ فترات ومناوبات المهمة (${periods.length})</div>`;

        for (const p of periods) {
          const pCode = p.code || p.id;
          const asgs = byPeriod[pCode] || [];
          const needed = p.driversNeeded || 1;
          const pShortage = Math.max(0, needed - asgs.length);
          const sug = suggestions[pCode];
          html += renderPeriodBlock({
            period: p, assignments: asgs, needed, shortage: pShortage,
            suggestion: sug, driverMap, teamMap, isMgr, dateIso: o.dateIso
          });
        }

        body.innerHTML = html;

        body.querySelector('#borrowGlobalBtn')?.addEventListener('click', () => {
          openNewLoanModal({ occurrenceId: occId, missionId: mission.id, dateIso: o.dateIso, onDone: render });
        });

        // Wire period events
        body.querySelectorAll('[data-assign]').forEach(btn => {
          btn.onclick = () => {
            const code = btn.dataset.assign;
            const period = periods.find(p => (p.code || p.id) === code);
            openMultiShiftAssignDialog({
              occId, period, mission, dateIso: o.dateIso,
              onDone: () => { render(); refresh(); }
            });
          };
        });

        body.querySelectorAll('[data-accept]').forEach(btn => {
          btn.onclick = async () => {
            const code = btn.dataset.accept;
            const period = periods.find(p => (p.code || p.id) === code);
            const sug = suggestions[code];
            if (!sug?.proposed) return toast('لا يوجد اقتراح متاح', 2200, 'error');
            if (sug.isBorrow && mission.teamId) {
              openNewLoanModal({
                fromTeamId: sug.candidate?.team?.id || sug.borrowFromTeam?.id || sug.proposed.teamId,
                toTeamId: mission.teamId,
                driverId: sug.proposed.id,
                occurrenceId: occId,
                missionId: mission.id,
                periodId: code,
                dateIso: o.dateIso,
                notes: `استعارة سائق لتغطية نقص فترة ${period.name}`,
                onDone: () => { render(); refresh(); }
              });
              return;
            }
            await assignDriverToPeriod(occId, mission.id, period, sug.proposed.id, sug.due?.id || sug.proposed.id);
            toast(`تم تعيين ${esc(sug.proposed.name)} في ${esc(period.name)}`, 2200, 'success');
            render(); refresh();
          };
        });

        body.querySelectorAll('[data-borrow-period]').forEach(btn => {
          btn.onclick = () => {
            const code = btn.dataset.borrowPeriod;
            openNewLoanModal({
              occurrenceId: occId, missionId: mission.id, periodId: code,
              dateIso: o.dateIso, onDone: () => { render(); refresh(); }
            });
          };
        });

        body.querySelectorAll('[data-record-shortage]').forEach(btn => {
          btn.onclick = async () => {
            const code = btn.dataset.recordShortage;
            const period = periods.find(p => (p.code || p.id) === code);
            const asgs = byPeriod[code] || [];
            const needed = period.driversNeeded || 1;
            const pShortage = Math.max(0, needed - asgs.length);
            const endStr = fromMinSafe(toMin(period.startTime) + period.durationMinutes);
            await recordShortage({
              occurrenceId: occId,
              missionId: mission.id,
              periodId: code,
              dateIso: o.dateIso,
              timeSlot: `${period.startTime} → ${endStr}`,
              requiredCount: needed,
              availableCount: asgs.length,
              shortageCount: pShortage,
              reason: `نقص مسجل في فترة ${period.name}`
            });
            toast(`تم توثيق النقص (${pShortage} سائق) في السجلات الرسمية`, 2400, 'warn');
            render(); refresh();
          };
        });

        body.querySelectorAll('[data-change]').forEach(btn => {
          btn.onclick = () => {
            const code = btn.dataset.change;
            const period = periods.find(p => (p.code || p.id) === code);
            openMultiShiftAssignDialog({
              occId, period, mission, dateIso: o.dateIso,
              onDone: () => { render(); refresh(); }
            });
          };
        });

        body.querySelectorAll('[data-remove-asg]').forEach(btn => {
          btn.onclick = async () => {
            const asgId = Number(btn.dataset.removeAsg);
            if (!window.confirm('هل أنت متأكد من إزالة هذا السائق من الفترة؟')) return;
            await cancel(asgId, 'إزالة يدوية');
            toast('تمت إزالة السائق', 2200, 'success');
            render(); refresh();
          };
        });
      };
      render();
    }
  });
}

const openForestMission = openMultiShiftMission;

function renderPeriodBlock({ period, assignments, needed, shortage, suggestion, driverMap, teamMap, isMgr, dateIso }) {
  const pCode = period.code || period.id;
  const endStr = fromMinSafe(toMin(period.startTime) + period.durationMinutes);
  const isAlpha = period.track === 'ALPHA';
  const isMo = period.track === 'MO';
  const hasTrack = isAlpha || isMo || Boolean(period.track);
  const full = shortage === 0;
  const sug = suggestion?.proposed;

  return `
    <div class="period-block-card ${shortage > 0 ? 'shortage' : 'full'}">
      <div class="pbc-head">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${hasTrack ? `
              <div class="fec-track-badge ${isAlpha ? 'alpha' : isMo ? 'mo' : ''}">
                ${isAlpha ? '🔵 مسار Alpha' : isMo ? '🟣 مسار MO' : esc(period.track)}
              </div>
            ` : ''}
            <div style="font-weight:800;font-size:14px">${esc(period.name)}</div>
          </div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px">
            ${esc(period.startTime)} → ${esc(endStr)} · ${esc(fmtDurShort(period.durationMinutes))}
            ${period.dayOffset === 1 ? ' · (اليوم التالي)' : ''}
          </div>
        </div>
        <div>
          <span class="tag ${full ? 'ok' : 'warn'}" style="font-weight:800">
            ${assignments.length}/${needed} سواق
          </span>
        </div>
      </div>

      ${assignments.length > 0 ? `
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
          ${assignments.map(a => {
            const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
            const dueDr = driverMap.get(a.dueDriverId);
            const tm = teamMap.get(dr?.teamId);
            const isSub = a.actualDriverId && a.dueDriverId && a.actualDriverId !== a.dueDriverId;
            const isBorrowed = a.source === 'BORROWED';
            return `
              <div class="driver-row" style="padding:6px 8px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
                <div class="av ${isBorrowed ? 'borrowed' : isSub ? 'sub' : 'ok'}">${esc((dr?.name || '؟').charAt(0))}</div>
                <div class="info">
                  <div class="n">
                    ${esc(dr?.name || '—')}
                    ${tm ? `<span class="tag" style="background:${tm.color || '#3b82f6'}18;color:${tm.color || '#3b82f6'};font-size:10px;margin-right:4px">${esc(tm.name)}</span>` : ''}
                    ${isBorrowed ? `<span class="tag borrowed" style="font-size:10px;margin-right:4px">🔄 مستعار</span>` : ''}
                    ${isSub ? `<span class="sub">بديل عن ${esc(dueDr?.name || '—')}</span>` : ''}
                  </div>
                </div>
                ${isMgr ? `
                  <div style="display:flex;gap:4px">
                    <button class="tag" data-change="${pCode}" style="cursor:pointer;border:0;font-family:inherit;font-size:11px">تغيير</button>
                    <button class="x" data-remove-asg="${a.id}" title="إزالة">✕</button>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      ${shortage > 0 ? `
        <div class="shortage-banner" style="margin-top:10px">
          <div style="flex:1">
            <b style="color:var(--danger)">⚠️ نقص ${shortage} سائق في هذه الفترة!</b>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">المطلوب: ${needed} · المعين: ${assignments.length}</div>
          </div>
          ${isMgr ? `
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="tag borrowed" data-borrow-period="${pCode}" style="cursor:pointer;border:0;font-family:inherit;font-weight:700">
                🔄 استعارة
              </button>
              <button class="tag shortage" data-record-shortage="${pCode}" style="cursor:pointer;border:0;font-family:inherit;font-weight:700">
                📝 توثيق
              </button>
            </div>
          ` : ''}
        </div>

        ${sug ? `
          <div class="fec-suggestion" style="margin-top:8px">
            <div class="fec-sug-head">
              <span class="star">⭐</span>
              <span class="name">المقترح العادل: ${esc(sug.name)}</span>
            </div>
            <div class="fec-sug-reason">${esc(suggestion.reason)}</div>
          </div>
        ` : ''}

        ${isMgr ? `
          <div class="fec-actions" style="margin-top:8px">
            ${sug ? `<button class="fec-btn accept" data-accept="${pCode}">✓ قبول ${esc(sug.name)}</button>` : ''}
            <button class="fec-btn other" data-assign="${pCode}">
              ${sug ? 'اختيار سائق داخلي آخر' : 'تعيين سائق داخلي'}
            </button>
          </div>
        ` : ''}
      ` : ''}
    </div>
  `;
}

async function openMultiShiftAssignDialog({ occId, period, mission, dateIso, onDone }) {
  const pCode = period.code || period.id;
  const r = periodRange(period, dateIso);
  const result = await suggestForTurn({
    missionId: mission.id,
    periodId: pCode,
    occurrenceId: occId,
    startIso: r.start.toISOString(),
    endIso: r.end.toISOString(),
    targetTeamId: mission.teamId || null
  });
  const enriched = [];
  for (const q of result.queue) {
    const profile = await computeDriverProfile(q.driver.id);
    const summary = await computeDriverSummary(profile);
    const samePeriod = profile.history.filter(h => h.periodCode === pCode);
    enriched.push({
      ...q, profile, summary,
      sameMissionCount: samePeriod.length,
      sameMissionLast: samePeriod[0] || null,
      isSuggested: result.proposed?.id === q.driver.id
    });
  }
  const endStr = fromMinSafe(toMin(period.startTime) + period.durationMinutes);
  sheet({
    title: `تعيين في ${esc(period.name)}`,
    subtitle: `${esc(period.startTime)} → ${esc(endStr)} · ${esc(fmtDurShort(period.durationMinutes))}`,
    builder: (body, close) => {
      let html = `<div class="turn-reason-banner ${result.isBorrow ? 'warn' : ''}">
        <div class="trb-icon">${result.isBorrow ? '⚠️' : '🎯'}</div>
        <div class="trb-text">${esc(result.reason)}</div>
      </div>`;

      if (result.internalShortage) {
        html += `
          <div style="background:#fffbeb;border:1px solid #fef3c7;border-radius:8px;padding:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:#92400e;font-weight:600">نقص داخلي: لا يوجد سائق متاح من الفريق المعني لهذه الفترة.</span>
            <button id="shiftDialogBorrowBtn" style="padding:4px 10px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:12px;cursor:pointer;font-weight:700">
              🔄 استعارة من فريق آخر
            </button>
          </div>
        `;
      }

      const suggested = enriched.find(e => e.isSuggested);
      const sameTeamOthers = enriched.filter(e => !e.isSuggested && e.isAvailable && e.isSameTeam);
      const otherTeamOthers = enriched.filter(e => !e.isSuggested && e.isAvailable && !e.isSameTeam);
      const blocked = enriched.filter(e => !e.isAvailable);

      if (suggested) {
        html += `<div class="sheet-section">⭐ المقترح الأول (${suggested.isSameTeam ? 'داخلي' : 'استعارة'})</div>`;
        html += renderTurnCandidate(suggested, mission);
      }
      if (sameTeamOthers.length) {
        html += `<div class="sheet-section">سائقو الفريق المتاحون</div>`;
        for (const c of sameTeamOthers) html += renderTurnCandidate(c, mission);
      }
      if (otherTeamOthers.length) {
        html += `<div class="sheet-section" style="color:#d97706">سائقون متاحون من فرق أخرى (للاستعارة)</div>`;
        for (const c of otherTeamOthers) html += renderTurnCandidate(c, mission);
      }
      if (blocked.length) {
        html += `<div class="sheet-section muted">غير متاحين حالياً</div>`;
        for (const c of blocked) html += renderBlockedTurn(c);
      }
      html += `<button class="btn-ghost" id="cancelBtn" style="margin-top:14px">إلغاء</button>`;
      body.innerHTML = html;

      body.querySelector('#cancelBtn').onclick = close;

      body.querySelector('#shiftDialogBorrowBtn')?.addEventListener('click', () => {
        openNewLoanModal({
          occurrenceId: occId,
          missionId: mission.id,
          periodId: pCode,
          dateIso: dateIso,
          onDone: () => {
            close();
            onDone && onDone();
          }
        });
      });

      body.querySelectorAll('.turn-candidate:not(.blocked)').forEach(el => {
        el.onclick = async () => {
          const did = Number(el.dataset.did);
          const cand = enriched.find(e => e.driver.id === did);
          if (cand && !cand.isSameTeam && mission.teamId) {
            openNewLoanModal({
              fromTeamId: cand.team?.id || cand.driver.teamId,
              toTeamId: mission.teamId,
              driverId: did,
              occurrenceId: occId,
              missionId: mission.id,
              periodId: pCode,
              dateIso: dateIso,
              notes: `استعارة سائق لفترة ${period.name}`,
              onDone: () => {
                close();
                onDone && onDone();
              }
            });
            return;
          }
          await assignDriverToPeriod(occId, mission.id, period, did, result.due?.id || did);
          toast('تم التعيين بنجاح', 2200, 'success');
          close();
          onDone && onDone();
        };
      });
    }
  });
}

const openForestAssignDialog = openMultiShiftAssignDialog;

async function assignDriverToPeriod(occId, missionId, period, driverId, dueDriverId = null, extraOpts = {}) {
  const o = await getOccurrence(occId);
  const r = periodRange(period, o.dateIso);
  const existing = await listByOccurrence(occId);
  const pCode = period.code || period.id;
  const prev = existing.find(x =>
    (x.periodCode === pCode || x.periodId === pCode) && x.status !== ASG_STATUS.CANCELLED);
  if (prev) await cancel(prev.id, 'استبدال السائق');
  const due = dueDriverId ?? driverId;
  const isOverride = due && driverId && Number(due) !== Number(driverId);
  const repReason = extraOpts.replacementReason || (isOverride ? 'اختيار القائد لتجاوز صاحب الدور' : '');
  const aid = await createProposal({
    occurrenceId: occId, missionId,
    periodId: pCode, periodCode: pCode,
    dueDriverId: due,
    plannedDriverId: driverId,
    startIso: r.start.toISOString(), endIso: r.end.toISOString(),
    rationale: `تعيين فترة ${period.name || pCode}`, score: 0,
    source: extraOpts.source || 'TEAM',
    loanId: extraOpts.loanId || null,
    replacementReason: repReason,
    autoConfirm: true
  });
  await commitExecution({
    missionId, periodId: pCode, driverId,
    at: r.start.toISOString(), assignmentId: aid
  });
  return aid;
}

// ═══════════════════════════════════════
// Past Days
// ═══════════════════════════════════════
async function renderPastDaysSection() {
  const { all } = await import('../core/db.js');
  const [occurrences, assignments, missions, drivers] = await Promise.all([
    all('occurrences'), all('assignments'), all('missions'), all('drivers')
  ]);
  const missionMap = new Map(missions.map(m => [m.id, m]));
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  const today = todayIso();
  const byDate = {};
  for (const o of occurrences) {
    if (o.dateIso >= today) continue;
    if (o.cancelled) continue;
    if (!byDate[o.dateIso]) byDate[o.dateIso] = [];
    byDate[o.dateIso].push(o);
  }
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).slice(0, 30);
  if (dates.length === 0) {
    return `<div class="empty-block">
      <div class="ic">📆</div>
      <h3>لا يوجد سجل سابق بعد</h3>
      <p>ستظهر هنا أرشيفات المهام السابقة بمجرد مرور تواريخها</p>
    </div>`;
  }
  let html = '';
  for (let i = 0; i < dates.length; i++) {
    const dateIso = dates[i];
    const occs = byDate[dateIso].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const missionsList = [];
    for (const o of occs) {
      const m = missionMap.get(o.missionId);
      if (!m) continue;
      const asgList = assignments.filter(a => a.occurrenceId === o.id);
      const active = asgList.filter(a => a.status !== ASG_STATUS.CANCELLED);
      const cancelled = asgList.filter(a => a.status === ASG_STATUS.CANCELLED);
      const byPeriod = {};
      for (const a of active) {
        const key = a.periodCode || 'MAIN';
        if (!byPeriod[key]) byPeriod[key] = [];
        byPeriod[key].push(a);
      }
      missionsList.push({
        occurrence: o, mission: m,
        assignments: active, cancelledAssignments: cancelled, byPeriod
      });
    }
    html += renderPastDayCard({
      dateIso, missions: missionsList,
      totalMissions: missionsList.length,
      totalDrivers: new Set(missionsList.flatMap(m =>
        m.assignments.map(a => a.actualDriverId || a.plannedDriverId)
      )).size
    }, driverMap, i === 0);
  }
  return html;
}

function renderPastDayCard(day, driverMap, isExpanded) {
  const { dateIso, missions, totalMissions, totalDrivers } = day;
  const dateObj = isoToDate(dateIso);
  return `
    <div class="past-day-card ${isExpanded ? 'expanded' : ''}" data-past="${dateIso}">
      <div class="pdc-head">
        <div class="pdc-date-block">
          <div class="pdc-day-number">${dateObj.getDate()}</div>
          <div class="pdc-day-name">${esc(dayNameAr(dateIso))}</div>
        </div>
        <div class="pdc-info">
          <div class="pdc-date-full">${esc(humanDateFull(dateIso))}</div>
          <div class="pdc-summary">${totalMissions} مهام · ${totalDrivers} سواق منفذون</div>
        </div>
        <div class="pdc-chev">${isExpanded ? '▾' : '▸'}</div>
      </div>
      <div class="pdc-body">
        ${missions.length === 0
          ? '<div class="pdc-empty">لا توجد مهام مسجلة</div>'
          : missions.map(m => renderPastMission(m, driverMap)).join('')}
      </div>
    </div>
  `;
}

function renderPastMission(item, driverMap) {
  const { occurrence: o, mission: m, assignments, byPeriod, cancelledAssignments } = item;
  const periods = getMissionPeriods(m);
  const isMultiPeriod = m.type === 'FOREST' || m.type === 'MULTI_SHIFT' || (periods && periods.length > 1);
  const endStr = fromMinSafe(toMin(o.startTime) + o.durationMinutes);
  return `
    <div class="pm-card ${isMultiPeriod ? 'forest' : ''}">
      <div class="pm-head">
        <div class="pm-name">
          ${esc(m.name)}
          ${isMultiPeriod ? '<span class="pm-badge info">🔄 مناوبات</span>' : ''}
          ${m.locationType === 'indoor' ? '<span class="pm-badge indoor">داخلية</span>' : ''}
        </div>
        <div class="pm-time">${esc(o.startTime)} → ${esc(endStr)} · ${esc(fmtDurShort(o.durationMinutes))}</div>
      </div>
      ${isMultiPeriod ? `
        <div class="pm-periods">
          ${renderPastPeriods(periods, byPeriod, driverMap)}
        </div>
      ` : `
        <div class="pm-drivers">
          ${assignments.length === 0
            ? '<div class="pm-no-driver" style="font-size:11px;color:var(--text-3);padding:4px">لم يُعيَّن أحد</div>'
            : assignments.map(a => renderAssignmentRow(a, driverMap)).join('')}
        </div>
      `}
      ${cancelledAssignments.length > 0 ? `
        <div class="pm-cancelled">
          <div class="pm-cancelled-title">⚠️ تعيينات ملغاة (${cancelledAssignments.length})</div>
          ${cancelledAssignments.map(a => {
            const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
            return `<div class="pm-cancelled-row">
              <span>${esc(dr?.name || '—')}</span>
              <span class="reason">${esc(a.replacementReason || '—')}</span>
            </div>`;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderPastPeriods(periods, byPeriod, driverMap) {
  return (periods || []).map(p => {
    const pCode = p.code || p.id;
    const asgs = byPeriod[pCode] || [];
    const endStr = fromMinSafe(toMin(p.startTime) + p.durationMinutes);
    const trackIcon = p.track === 'ALPHA' ? '🔵' : p.track === 'MO' ? '🟣' : '⏱';
    if (asgs.length === 0) {
      return `<div class="pm-period empty" style="opacity:0.6">
        <div class="pmp-track">${trackIcon}</div>
        <div class="pmp-info">
          <div class="pmp-name">${esc(p.name)}</div>
          <div class="pmp-time">${esc(p.startTime)} → ${esc(endStr)}</div>
        </div>
        <div class="pmp-empty" style="color:var(--warn);font-size:11px">شاغرة</div>
      </div>`;
    }
    return asgs.map(a => {
      const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
      const dueDr = driverMap.get(a.dueDriverId);
      const isSub = a.actualDriverId && a.dueDriverId && a.actualDriverId !== a.dueDriverId;
      const isBorrowed = a.source === 'BORROWED';
      return `
        <div class="pm-period">
          <div class="pmp-track">${trackIcon}</div>
          <div class="pmp-info">
            <div class="pmp-name">${esc(p.name)}</div>
            <div class="pmp-time">${esc(p.startTime)} → ${esc(endStr)} · ${esc(fmtDurShort(p.durationMinutes))}</div>
          </div>
          <div class="pmp-driver">
            <span class="av ${isBorrowed ? 'borrowed' : ''}">${esc(dr?.name?.charAt(0) || '؟')}</span>
            <span>${esc(dr?.name || '—')}</span>
            ${isBorrowed ? '<span class="tag borrowed" style="font-size:10px;margin-right:4px">🔄 مستعار</span>' : ''}
            ${isSub ? `<span class="pm-sub">بديل عن ${esc(dueDr?.name || '—')}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }).join('');
}
const renderForestPastPeriods = (byPeriod, driverMap) => renderPastPeriods(FOREST_PERIODS, byPeriod, driverMap);

function renderAssignmentRow(a, driverMap) {
  const dr = driverMap.get(a.actualDriverId || a.plannedDriverId);
  const dueDr = driverMap.get(a.dueDriverId);
  const plannedDr = driverMap.get(a.plannedDriverId);
  const isSub = a.actualDriverId && a.dueDriverId && a.actualDriverId !== a.dueDriverId;
  const wasPlanned = a.plannedDriverId && a.plannedDriverId !== a.dueDriverId;
  const hasOverride = isSub || wasPlanned;
  return `
    <div class="pm-driver-row ${hasOverride ? 'override' : ''}">
      <span class="av">${esc(dr?.name?.charAt(0) || '؟')}</span>
      <div class="pmd-info">
        <div class="pmd-name">
          ${esc(dr?.name || '—')}
          ${isSub ? '<span class="pm-sub">بديل</span>' : ''}
        </div>
        ${hasOverride ? `
          <div class="pmd-detail">
            ${a.dueDriverId && a.dueDriverId !== (a.actualDriverId || a.plannedDriverId)
              ? `صاحب الدور الأصلي: <b>${esc(dueDr?.name || '—')}</b>` : ''}
            ${a.plannedDriverId && a.plannedDriverId !== a.dueDriverId && a.plannedDriverId !== a.actualDriverId
              ? ` · مخطط: <b>${esc(plannedDr?.name || '—')}</b>` : ''}
            ${a.replacementReason ? ` · <i>السبب: ${esc(a.replacementReason)}</i>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function wirePastDays(container) {
  container.querySelectorAll('.past-day-card').forEach(card => {
    const head = card.querySelector('.pdc-head');
    if (head) {
      head.onclick = () => {
        card.classList.toggle('expanded');
        const chev = card.querySelector('.pdc-chev');
        if (chev) chev.textContent = card.classList.contains('expanded') ? '▾' : '▸';
      };
    }
  });
}

// ═══════════════════════════════════════
// Edit Time
// ═══════════════════════════════════════
async function openEditTime(occId) {
  const o = await getOccurrence(occId);
  if (!o) return;
  sheet({
    title: 'تعديل وقت المهمة',
    builder: (body, close) => {
      body.innerHTML = `
        <div class="form-field"><label>وقت البداية (HH:MM)</label>
          <input id="st" value="${esc(o.startTime)}"></div>
        <div class="form-field"><label>المدة (بالدقائق)</label>
          <input id="dur" type="number" value="${o.durationMinutes}"></div>
        <button class="btn-primary" id="save">حفظ التعديل</button>
        <button class="btn-ghost" id="cancelBtn">إلغاء</button>
      `;
      body.querySelector('#cancelBtn').onclick = close;
      body.querySelector('#save').onclick = async () => {
        const startTime = body.querySelector('#st').value.trim();
        const durationMinutes = Number(body.querySelector('#dur').value);
        if (!/^\d{1,2}:\d{2}$/.test(startTime)) return toast('صيغة الوقت غير صالحة', 2200, 'error');
        await updateOccurrence(occId, { startTime, durationMinutes });
        toast('تم تعديل وقت المهمة بنجاح', 2200, 'success');
        close(); refresh();
      };
    }
  });
}

// ═══════════════════════════════════════
// Driver Profile
// ═══════════════════════════════════════
async function openDriverProfile(driverId) {
  const profile = await computeDriverProfile(driverId);
  const { driver: d, history, lastVacation, vacationVisible,
    multiShiftCycles, multiShiftPeriods, normalMissions } = profile;
  const multiByOcc = {};
  const normalList = [];
  for (const h of history) {
    const isMulti = Boolean(h.periodCode || h.mission?.type === 'MULTI_SHIFT' || h.mission?.type === 'FOREST' || (h.mission?.periods && h.mission.periods.length > 1));
    if (isMulti) {
      if (!multiByOcc[h.occurrence.id]) {
        multiByOcc[h.occurrence.id] = {
          occurrence: h.occurrence, mission: h.mission,
          dateIso: h.dateIso, periods: []
        };
      }
      multiByOcc[h.occurrence.id].periods.push(h);
    } else normalList.push(h);
  }
  for (const key in multiByOcc) {
    multiByOcc[key].periods.sort((a, b) => a.start - b.start);
  }
  const timeline = [];
  for (const key in multiByOcc) {
    const f = multiByOcc[key];
    timeline.push({
      type: 'forest', dateIso: f.dateIso,
      start: f.periods[0].start, end: f.periods[f.periods.length - 1].end,
      mission: f.mission, periods: f.periods,
      totalMinutes: f.periods.reduce((s, p) => s + p.durationMinutes, 0)
    });
  }
  for (const h of normalList) {
    timeline.push({
      type: 'normal', dateIso: h.dateIso, start: h.start, end: h.end,
      mission: h.mission, assignment: h.assignment,
      durationMinutes: h.durationMinutes
    });
  }
  timeline.sort((a, b) => b.start - a.start);
  const asc = [...timeline].sort((a, b) => a.start - b.start);
  const restBefore = {};
  for (let i = 1; i < asc.length; i++) {
    const mins = Math.floor((asc[i].start - asc[i - 1].end) / 60000);
    restBefore[asc[i].dateIso + '::' + asc[i].start.getTime()] = mins;
  }
  const totalMinutes = profile.totalMinutes;
  sheet({
    title: null,
    builder: (body, close) => {
      body.innerHTML = `
        <div class="profile-hero">
          <div class="av ${AV_CLASS[d.status] || ''}">${esc(d.name.charAt(0))}</div>
          <div class="info">
            <h2>${esc(d.name)}</h2>
            <div class="status">
              <span class="tag ${STATUS_CLASS[d.status] || 'muted'}">${esc(STATUS_AR[d.status] || d.status)}</span>
            </div>
          </div>
        </div>
        <div class="stat-grid-3">
          <div class="cell"><b>${multiShiftCycles || 0}</b><span>🔄 مناوبات</span></div>
          <div class="cell"><b>${normalMissions || 0}</b><span>📋 عادية</span></div>
          <div class="cell"><b>${esc(fmtDurShort(totalMinutes))}</b><span>⏱ إجمالي</span></div>
        </div>
        <div class="profile-block">
          <h4>معلومات السائق</h4>
          ${vacationVisible ? `
            <div class="row"><span class="k">آخر إجازة</span>
              <span class="v">${lastVacation ? relativeDay(lastVacation.at.substring(0, 10)) : 'لا توجد'}</span>
            </div>
            ${lastVacation ? `
              <div class="row"><span class="k">سبب آخر إجازة</span>
                <span class="v">${esc(lastVacation.reason || '—')}</span>
              </div>` : ''}
          ` : `
            <div class="row"><span class="k">🔒 معلومات الإجازات</span>
              <span class="v" style="color:var(--text-3);font-weight:600;font-size:11px">خاصة بالقيادة</span>
            </div>
          `}
          <div class="row"><span class="k">إجمالي المهام المنفذة</span>
            <span class="v">${history.length}</span></div>
          ${multiShiftPeriods > 0 ? `
            <div class="row"><span class="k">فترات المناوبات</span>
              <span class="v">${multiShiftPeriods} فترة</span>
            </div>` : ''}
        </div>
        <div class="profile-block">
          <h4>السجل الزمني للمهام (${timeline.length})</h4>
          ${timeline.length === 0
            ? `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">لم ينفذ أي مهمة بعد</div>`
            : `<div class="timeline-list">
                ${timeline.map(ev => renderTimelineItem(ev, restBefore)).join('')}
              </div>`}
        </div>
        ${isManager() ? `
          <button class="btn-ghost" id="cmpWithBtn" style="margin-bottom:10px">
            📊 قارن ${esc(d.name)} مع سائق آخر
          </button>
        ` : ''}
        <button class="btn-ghost" id="closeBtn">إغلاق</button>
      `;
      body.querySelector('#closeBtn').onclick = close;
      body.querySelector('#cmpWithBtn')?.addEventListener('click', () => {
        close();
        setTimeout(() => openDriverComparison([driverId]), 300);
      });
    }
  });
}

function renderTimelineItem(ev, restBefore) {
  const restKey = ev.dateIso + '::' + ev.start.getTime();
  const rest = restBefore[restKey];
  if (ev.type === 'forest') {
    const count = ev.periods.length;
    return `
      <div class="tl-item forest">
        <div class="tli-head">
          <div class="tli-date-block">
            <div class="tli-day">${esc(humanDate(ev.dateIso))}</div>
            <div class="tli-weekday">${esc(dayNameAr(ev.dateIso))}</div>
          </div>
          <div class="tli-title-block">
            <div class="tli-name">🌲 الغابة</div>
            <div class="tli-sub">${count} فترات · ${esc(fmtDurShort(ev.totalMinutes))}</div>
          </div>
        </div>
        <div class="tli-periods">
          ${ev.periods.map(p => {
            const pLabel = periodLabel(p.period, ev.dateIso);
            const isAlpha = p.period.track === 'ALPHA';
            const isSub = p.assignment.actualDriverId && p.assignment.dueDriverId && p.assignment.actualDriverId !== p.assignment.dueDriverId;
            return `
              <div class="tli-period">
                <span class="tp-track ${isAlpha ? 'alpha' : 'mo'}">
                  ${isAlpha ? '🔵 Alpha' : '🟣 MO'}
                </span>
                <span class="tp-name">${esc(p.period.name)}</span>
                <span class="tp-time">${esc(pLabel.fullRange)}</span>
                ${isSub ? '<span class="tp-sub">بديل</span>' : ''}
              </div>
            `;
          }).join('')}
        </div>
        <div class="tli-rest ${rest === undefined ? 'muted' : rest === 0 ? 'bad' : rest < 8 * 60 ? 'warn' : 'ok'}">
          💤 ${rest === undefined ? 'أول مهمة' : rest === 0 ? 'مهمة متتالية!' : `راحة قبلها: ${esc(fmtDurShort(rest))}`}
        </div>
      </div>
    `;
  }
  const startStr = `${String(ev.start.getHours()).padStart(2, '0')}:${String(ev.start.getMinutes()).padStart(2, '0')}`;
  const endStr = `${String(ev.end.getHours()).padStart(2, '0')}:${String(ev.end.getMinutes()).padStart(2, '0')}`;
  const isSub = ev.assignment.actualDriverId && ev.assignment.dueDriverId && ev.assignment.actualDriverId !== ev.assignment.dueDriverId;
  return `
    <div class="tl-item normal">
      <div class="tli-head">
        <div class="tli-date-block">
          <div class="tli-day">${esc(humanDate(ev.dateIso))}</div>
          <div class="tli-weekday">${esc(dayNameAr(ev.dateIso))}</div>
        </div>
        <div class="tli-title-block">
          <div class="tli-name">${esc(ev.mission.name)}</div>
          <div class="tli-sub">
            ${esc(startStr)} → ${esc(endStr)} · ${esc(fmtDurShort(ev.durationMinutes))}
            ${isSub ? ' · <span class="tli-badge sub">بديل</span>' : ''}
          </div>
        </div>
      </div>
      <div class="tli-rest ${rest === undefined ? 'muted' : rest === 0 ? 'bad' : rest < 8 * 60 ? 'warn' : 'ok'}">
        💤 ${rest === undefined ? 'أول مهمة' : rest === 0 ? 'مهمة متتالية!' : `راحة قبلها: ${esc(fmtDurShort(rest))}`}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════
// Comparison
// ═══════════════════════════════════════
async function openDriverComparison(initialIds = []) {
  const drivers = await listDrivers();
  sheet({
    title: '📊 مقارنة السواق التنافسية',
    subtitle: 'اختر سائقين أو أكثر للتحقق من عدالة توزيع الساعات والمهام',
    builder: (body, close) => {
      const selected = new Set(initialIds);
      const renderList = () => {
        body.innerHTML = `
          <div class="sheet-section">حدد السواق للمقارنة (${selected.size} محدد)</div>
          ${drivers.map(d => {
            const isSel = selected.has(d.id);
            return `
              <div class="candidate-row ${isSel ? 'selected' : ''}" data-did="${d.id}">
                <div class="av ${isSel ? 'ok' : 'off'}">${esc(d.name.charAt(0))}</div>
                <div class="body">
                  <div class="n">${esc(d.name)}</div>
                  <div class="reason">${esc(STATUS_AR[d.status] || d.status)}</div>
                </div>
                ${isSel ? '<span class="check">✓</span>' : ''}
              </div>
            `;
          }).join('')}
          <div class="cmp-actions">
            <button class="btn-primary" id="compareBtn"
              ${selected.size < 2 ? 'disabled' : ''}>ابدأ المقارنة (${selected.size})</button>
            <button class="btn-ghost" id="cancelBtn">إلغاء</button>
          </div>
        `;
        body.querySelector('#cancelBtn').onclick = close;
        body.querySelector('#compareBtn')?.addEventListener('click', () => {
          if (selected.size >= 2) showComparison(Array.from(selected));
        });
        body.querySelectorAll('.candidate-row[data-did]').forEach(el => {
          el.onclick = () => {
            const did = Number(el.dataset.did);
            if (selected.has(did)) selected.delete(did);
            else selected.add(did);
            renderList();
          };
        });
      };
      const showComparison = async (driverIds) => {
        body.innerHTML = `<div class="pdc-loading">جارٍ إعداد مقارنة العدالة…</div>`;
        const profiles = [];
        for (const id of driverIds) {
          const p = await computeDriverProfile(id);
          const s = await computeDriverSummary(p);
          profiles.push({ p, s });
        }
        const rows = [
          { key: 'week', label: 'مهام هذا الأسبوع', get: e => e.s.weekCount, type: 'number' },
          { key: 'week_min', label: 'ساعات الأسبوع', get: e => fmtDurShort(e.s.weekMinutes), type: 'text' },
          { key: 'month', label: 'مهام هذا الشهر', get: e => e.s.monthCount, type: 'number' },
          { key: 'month_min', label: 'ساعات الشهر', get: e => fmtDurShort(e.s.monthMinutes), type: 'text' },
          { key: 'total', label: 'إجمالي المهام المنفذة', get: e => e.p.history.length, type: 'number' },
          { key: 'total_min', label: 'إجمالي الساعات', get: e => fmtDurShort(e.p.totalMinutes), type: 'text' },
          { key: 'forest', label: '🌲 دورات الغابة', get: e => e.p.forestCycles, type: 'number' },
          {
            key: 'last', label: 'آخر مهمة مسجلة',
            get: e => e.p.lastMission
              ? `${e.p.lastMission.mission.name} · ${relativeDay(e.p.lastMission.dateIso)}`
              : '—', type: 'text'
          },
          {
            key: 'rest', label: 'الراحة الحالية',
            get: e => e.s.currentRestText,
            type: 'text',
            color: e => e.s.workingNow ? 'ok'
              : e.s.currentRestMinutes != null && e.s.currentRestMinutes < 8 * 60 ? 'warn' : 'ok'
          }
        ];
        if (isManager()) {
          rows.push({
            key: 'vac', label: '🔒 آخر إجازة (للقيادة)',
            get: e => e.p.lastVacation
              ? relativeDay(e.p.lastVacation.at.substring(0, 10))
              : 'لا توجد',
            type: 'text', private: true
          });
        }
        body.innerHTML = `
          <div class="cmp-header">
            <div class="cmp-title">مقارنة ${profiles.length} سواق</div>
            <button class="btn-ghost" id="backBtn"
              style="padding:6px 12px;font-size:12px;width:auto;margin:0">← تعديل الاختيار</button>
          </div>
          <div class="cmp-table-wrap">
            <table class="cmp-table">
              <thead>
                <tr>
                  <th class="cmp-row-label">المعيار</th>
                  ${profiles.map(e => `
                    <th class="cmp-col">
                      <div class="cmp-col-head">
                        <span class="av">${esc(e.p.driver.name.charAt(0))}</span>
                        <span class="n">${esc(e.p.driver.name)}</span>
                      </div>
                    </th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => {
                  let bestIdx = -1;
                  if (r.type === 'number') {
                    let max = -1;
                    profiles.forEach((e, i) => {
                      const v = r.get(e);
                      if (typeof v === 'number' && v > max) { max = v; bestIdx = i; }
                    });
                    if (new Set(profiles.map(e => r.get(e))).size === 1) bestIdx = -1;
                  }
                  return `
                    <tr>
                      <td class="cmp-row-label">${r.private ? '🔒 ' : ''}${esc(r.label)}</td>
                      ${profiles.map((e, i) => {
                        const v = r.get(e);
                        const isBest = i === bestIdx;
                        const color = r.color ? r.color(e) : null;
                        return `
                          <td class="cmp-cell ${isBest ? 'best' : ''} ${color ? 'c-' + color : ''}">
                            ${esc(v)}
                            ${isBest ? ' <span class="cmp-star">🏆</span>' : ''}
                          </td>`;
                      }).join('')}
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div class="cmp-legend">🏆 الأعلى إنجازاً للمهام · 🔒 بيانات خاصة بالقيادة فقط</div>
          <button class="btn-ghost" id="closeBtn" style="margin-top:14px">إغلاق المقارنة</button>
        `;
        body.querySelector('#closeBtn').onclick = close;
        body.querySelector('#backBtn').onclick = renderList;
      };
      renderList();
    }
  });
}

// ═══════════════════════════════════════
// Drivers Page
// ═══════════════════════════════════════
export async function renderDriversPage(main) {
  const drivers = await listDrivers();
  const profiles = {};
  const summaries = {};
  for (const d of drivers) {
    profiles[d.id] = await computeDriverProfile(d.id);
    summaries[d.id] = await computeDriverSummary(profiles[d.id]);
  }
  main.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="title">👥 قائمة السواق <span class="count">${drivers.length}</span></div>
        <div class="spacer"></div>
        <button class="tag" id="cmpBtn" style="padding:6px 12px;
          background:var(--accent-soft);color:var(--accent);border:0;
          border-radius:8px;font-family:inherit;font-weight:800;
          cursor:pointer;font-size:12px">📊 مقارنة</button>
        ${isManager() ? `
          <button class="tag" id="addBtn" style="padding:6px 12px;
            background:var(--primary);color:#fff;border:0;border-radius:8px;
            font-family:inherit;font-weight:800;cursor:pointer;
            font-size:12px;margin-right:6px">+ إضافة سائق</button>
        ` : ''}
      </div>
      <div class="section-body">
        ${drivers.length === 0
          ? '<div class="empty-block"><div class="ic">👤</div><h3>لا يوجد سواق مسجلين بعد</h3><p>اضغط "+ إضافة سائق" لإضافة السواق للقائمة</p></div>'
          : drivers.map(d => renderDriverCardCompact(profiles[d.id], summaries[d.id])).join('')}
      </div>
    </div>
  `;
  main.querySelector('#cmpBtn')?.addEventListener('click', () => openDriverComparison());
  main.querySelector('#addBtn')?.addEventListener('click', openAddDriver);
  main.querySelectorAll('[data-driver]').forEach(el => {
    el.onclick = () => openDriverProfile(Number(el.dataset.driver));
  });
  main.querySelectorAll('.driver-profile-card').forEach(attachRipple);
}

async function openAddDriver() {
  sheet({
    title: 'إضافة سائق جديد',
    builder: (body, close) => {
      body.innerHTML = `
        <div class="form-field"><label>اسم السائق الكامل</label>
          <input id="n" placeholder="مثال: أحمد محمد" autofocus></div>
        <div class="form-field"><label>الحالة المبدئية</label>
          <select id="st">
            <option value="AVAILABLE">متاح للعمل</option>
            <option value="VACATION">في عطلة / إجازة</option>
            <option value="SICK">عجز طبي / مريض</option>
            <option value="UNAVAILABLE">غير متاح مؤقتاً</option>
          </select>
        </div>
        <button class="btn-primary" id="save">حفظ وإضافة السائق</button>
        <button class="btn-ghost" id="cancelBtn">إلغاء</button>
      `;
      body.querySelector('#cancelBtn').onclick = close;
      body.querySelector('#save').onclick = async () => {
        const name = body.querySelector('#n').value.trim();
        const st = body.querySelector('#st').value;
        if (!name) return toast('اسم السائق مطلوب', 2200, 'error');
        try {
          await createDriver({ name, status: st });
          toast(`تمت إضافة ${esc(name)} بنجاح`, 2200, 'success');
          close(); refresh();
        } catch (e) { toast(e.message, 2200, 'error'); }
      };
    }
  });
}

// ═══════════════════════════════════════
// Settings
// ═══════════════════════════════════════
export async function renderSettingsPage(main) {
  const missions = await listMissions(true);
  const sess = getSession();
  const missed = await listUnresolved();
  const policyAr = { RECLAIM: 'استرداد الأولوية فوراً', NORMAL: 'انتظار الدور الطبيعي' };
  main.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="title">⚙️ كتالوج المهام والورديات <span class="count">${missions.length}</span></div>
        <div class="spacer"></div>
        ${isManager() ? `
          <button class="tag" id="addM" style="padding:6px 12px;
            background:var(--primary);color:#fff;border:0;border-radius:8px;
            font-family:inherit;font-weight:800;cursor:pointer;font-size:12px">+ مهمة جديدة</button>
        ` : ''}
      </div>
      <div class="section-body">
        ${missions.map(m => {
          const endStr = fromMinSafe(toMin(m.startTime) + m.durationMinutes);
          const periods = getMissionPeriods(m);
          const isMulti = m.type === 'MULTI_SHIFT' || m.type === 'FOREST' || (periods && periods.length > 1);
          const color = isMulti ? 'var(--warn)'
            : m.locationType === 'indoor' ? 'var(--purple)' : 'var(--accent)';
          return `
            <div class="driver-profile-card" data-mid="${m.id}">
              <div class="dpc-head">
                <div class="av-lg" style="background:${color}">${esc((m.startTime || '00').slice(0, 2))}</div>
                <div class="dpc-info">
                  <div class="dpc-name">
                    ${esc(m.name)}
                    ${isMulti ? '<span class="tag info" style="font-size:11px;margin-right:4px">🔄 مناوبات</span>' : ''}
                    ${m.isActive === false ? '<span class="tag bad" style="font-size:11px;margin-right:4px">معطّلة</span>' : ''}
                  </div>
                  <div class="dpc-tags">
                    <span class="tag">${esc(m.startTime)} → ${esc(endStr)}</span>
                    <span class="tag">${esc(fmtDurShort(m.durationMinutes))}</span>
                    <span class="tag">${m.driversNeeded} سواق</span>
                    ${isMulti && periods ? `<span class="tag">${periods.length} فترات</span>` : ''}
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
        ${missions.length === 0 ? `<div style="padding:10px 4px"><button class="btn-primary" id="seed">📥 تحميل القالب الجاهز (9 مهام)</button></div>` : ''}
      </div>
    </div>
    ${missed.length > 0 ? `
      <div class="section">
        <div class="section-head">
          <div class="title">⚠️ أدوار فائتة مستحقة <span class="count warn">${missed.length}</span></div>
        </div>
        <div class="section-body">
          ${missed.map(m => `
            <div class="driver-profile-card" style="padding:10px 12px">
              <div style="font-size:12px">
                <div style="font-weight:800">${esc(m.dateIso)}</div>
                <div style="color:var(--text-3);margin-top:3px">${esc(m.reason)}</div>
                <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
                  <span class="tag info">السياسة: ${esc(policyAr[m.returnPolicy] || m.returnPolicy)}</span>
                  ${isManager() ? `
                    <button class="tag" data-setpol="${m.id}" style="cursor:pointer;border:0;font-family:inherit">
                      تغيير إلى ${m.returnPolicy === 'RECLAIM' ? 'طبيعي' : 'استرداد'}
                    </button>
                    <button class="tag ok" data-resolve="${m.id}" style="cursor:pointer;border:0;font-family:inherit">
                      تسوية الدور
                    </button>
                  ` : ''}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
    <div class="section">
      <div class="section-head"><div class="title">💾 إدارة النسخ الاحتياطي للبيانات</div></div>
      <div class="section-body" style="padding:0 4px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="btn-ghost" id="exp" style="margin:0">📥 تصدير ملف النسخة</button>
          <button class="btn-ghost" id="imp" style="margin:0">📤 استيراد نسخة</button>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><div class="title">حساب المستخدم</div></div>
      <div class="section-body" style="padding:0 4px">
        <div class="profile-block" style="margin:0">
          <div class="row"><span class="k">الدور الحالي</span>
            <span class="v">${esc(ROLE_LABEL[sess?.role] || '—')}</span>
          </div>
        </div>
        <button class="btn-danger" id="logout" style="margin-top:8px">تسجيل الخروج</button>
      </div>
    </div>
  `;
  main.querySelectorAll('.section').forEach(s => setupCollapsible(s, { open: true }));
  main.querySelector('#addM')?.addEventListener('click', () => openMissionEditor(null));
  main.querySelectorAll('[data-mid]').forEach(el => {
    el.onclick = () => openMissionEditor(Number(el.dataset.mid));
  });
  main.querySelector('#seed')?.addEventListener('click', async () => {
    try { await seedCatalog(); toast('تم تحميل القالب الجاهز بنجاح', 2200, 'success'); refresh(); }
    catch (e) { toast(e.message, 2200, 'error'); }
  });
  main.querySelectorAll('[data-setpol]').forEach(b => {
    b.onclick = async () => {
      const id = Number(b.dataset.setpol);
      const m = missed.find(x => x.id === id);
      try {
        await setPolicy(id, m.returnPolicy === 'RECLAIM' ? 'NORMAL' : 'RECLAIM');
        toast('تم تحديث سياسة الاسترداد', 2200, 'success'); refresh();
      } catch (e) { toast(e.message, 2200, 'error'); }
    };
  });
  main.querySelectorAll('[data-resolve]').forEach(b => {
    b.onclick = async () => {
      try {
        await resolveMissed({ missedId: Number(b.dataset.resolve) });
        toast('تمت تسوية الدور الفائت بنجاح', 2200, 'success'); refresh();
      } catch (e) { toast(e.message, 2200, 'error'); }
    };
  });
  main.querySelector('#exp').onclick = async () => {
    const b = await exportBackup();
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url; a.download = `sowa9-backup-${todayIso()}.json`;
    a.click(); URL.revokeObjectURL(url);
  };
  main.querySelector('#imp').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const txt = await f.text();
      if (!window.confirm('تنبيه: سيتم استبدال كل البيانات بالنسخة المختارة. هل ترغب في المتابعة؟')) return;
      try { await importBackup(txt); toast('تم استيراد البيانات بنجاح', 2200, 'success'); refresh(); }
      catch (e) { toast('فشل الاستيراد: ' + e.message, 2200, 'error'); }
    };
    inp.click();
  };
  main.querySelector('#logout').onclick = () => {
    if (window.confirm('هل تريد تسجيل الخروج؟')) logout();
  };
}

async function openMissionEditor(missionId) {
  let m = {
    name: '', startTime: '12:00', durationMinutes: 480,
    driversNeeded: 1, locationType: 'outdoor', type: 'NORMAL',
    teamId: null, periods: null, notes: ''
  };
  if (missionId) {
    const fetched = await getMission(missionId);
    if (fetched) m = fetched;
  }

  const teams = await listTeams();

  sheet({
    title: missionId ? 'تعديل المهمة' : 'مهمة جديدة',
    builder: (body, close) => {
      // Local state for periods being edited
      let currentPeriods = (m.periods && m.periods.length > 0)
        ? JSON.parse(JSON.stringify(m.periods))
        : [];
      let currentMode = (currentPeriods.length > 0 || m.type === 'MULTI_SHIFT' || m.type === 'FOREST')
        ? 'MULTI_SHIFT'
        : 'NORMAL';

      const renderEditor = () => {
        const isMulti = currentMode === 'MULTI_SHIFT';
        body.innerHTML = `
          <div class="form-field"><label>اسم المهمة</label>
            <input id="m_name" value="${esc(m.name)}" placeholder="مثال: حراسة مقر، دورية ليلية، نقل مناوبات...">
          </div>

          <div class="form-row">
            <div class="form-field"><label>الفريق المسؤول</label>
              <select id="m_team">
                <option value="" ${!m.teamId ? 'selected' : ''}>مشترك (متاح لجميع الفرق)</option>
                ${teams.map(t => `<option value="${t.id}" ${m.teamId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-field"><label>نمط المهمة</label>
              <select id="m_mode">
                <option value="NORMAL" ${!isMulti ? 'selected' : ''}>وردية واحدة بسيطة (Single Shift)</option>
                <option value="MULTI_SHIFT" ${isMulti ? 'selected' : ''}>مناوبات وفترات متعددة (Multi-Shift)</option>
              </select>
            </div>
          </div>

          <div class="form-row">
            <div class="form-field"><label>وقت البداية الإجمالي (HH:MM)</label>
              <input id="m_start" value="${esc(m.startTime || '12:00')}" placeholder="12:00">
            </div>
            <div class="form-field"><label>المدة الإجمالية (دقائق)</label>
              <input id="m_dur" type="number" value="${m.durationMinutes || 480}" min="15" step="15">
            </div>
          </div>

          <div class="form-row">
            <div class="form-field"><label>طبيعة الموقع</label>
              <select id="m_loc">
                <option value="outdoor" ${m.locationType === 'outdoor' ? 'selected' : ''}>ميدانية / خارجية</option>
                <option value="indoor" ${m.locationType === 'indoor' ? 'selected' : ''}>داخلية / مقر</option>
              </select>
            </div>
            ${!isMulti ? `
              <div class="form-field"><label>عدد السواق المطلوبين</label>
                <input id="m_single_drivers" type="number" value="${m.driversNeeded || 1}" min="1">
              </div>
            ` : `
              <div class="form-field"><label>ملاحظات إضافية</label>
                <input id="m_notes" value="${esc(m.notes || '')}" placeholder="تعليمات أو تفاصيل...">
              </div>
            `}
          </div>

          ${isMulti ? `
            <div style="margin:16px 0 10px;padding:12px;background:var(--card-bg, #f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:10px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <b style="font-size:14px;color:var(--text)">⏱ فترات ومناوبات المهمة (${currentPeriods.length})</b>
                <button type="button" id="addPeriodBtn" style="padding:6px 12px;background:var(--accent,#2563eb);color:#fff;border:0;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">
                  ➕ إضافة فترة
                </button>
              </div>

              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
                <span style="font-size:11px;color:var(--text-muted);align-self:center">قوالب جاهزة:</span>
                <button type="button" class="tag" id="tpl3Shifts" style="cursor:pointer;background:#e0e7ff;color:#3730a3;border:0">3 ورديات متتابعة (24 س)</button>
                <button type="button" class="tag" id="tpl12h" style="cursor:pointer;background:#e0e7ff;color:#3730a3;border:0">دورية 12 ساعة (فترتين)</button>
                <button type="button" class="tag" id="tplForest" style="cursor:pointer;background:#e0e7ff;color:#3730a3;border:0">مساران 24 س (Alpha + MO)</button>
              </div>

              <div id="periodsList" style="display:flex;flex-direction:column;gap:8px">
                ${currentPeriods.map((p, idx) => `
                  <div class="period-edit-card" data-pidx="${idx}" style="background:#fff;border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:10px">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                      <span style="font-weight:700;font-size:12px">فترة #${idx + 1}</span>
                      <button type="button" class="del-period-btn" data-del="${idx}" style="background:transparent;color:#dc2626;border:0;cursor:pointer;font-size:12px;padding:2px 6px">
                        🗑️ حذف
                      </button>
                    </div>
                    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:6px">
                      <div>
                        <label style="font-size:11px;display:block;margin-bottom:2px;color:var(--text-muted)">اسم الفترة</label>
                        <input class="p-name" value="${esc(p.name)}" placeholder="مثال: وردية الليل" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px">
                      </div>
                      <div>
                        <label style="font-size:11px;display:block;margin-bottom:2px;color:var(--text-muted)">البداية</label>
                        <input class="p-start" value="${esc(p.startTime)}" placeholder="17:00" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px">
                      </div>
                      <div>
                        <label style="font-size:11px;display:block;margin-bottom:2px;color:var(--text-muted)">المدة (دقائق)</label>
                        <input class="p-dur" type="number" value="${p.durationMinutes || 360}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px">
                      </div>
                      <div>
                        <label style="font-size:11px;display:block;margin-bottom:2px;color:var(--text-muted)">سواق مطلوبين</label>
                        <input class="p-drivers" type="number" min="1" value="${p.driversNeeded || 1}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px">
                      </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
                      <div>
                        <label style="font-size:11px;display:block;margin-bottom:2px;color:var(--text-muted)">المسار / الرمز (اختياري)</label>
                        <input class="p-track" value="${esc(p.track || '')}" placeholder="مثال: Alpha، دورية 1..." style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px">
                      </div>
                      <div>
                        <label style="font-size:11px;display:block;margin-bottom:2px;color:var(--text-muted)">إزاحة اليوم</label>
                        <select class="p-day" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px">
                          <option value="0" ${(p.dayOffset || 0) === 0 ? 'selected' : ''}>نفس يوم البدء (0)</option>
                          <option value="1" ${(p.dayOffset || 0) === 1 ? 'selected' : ''}>اليوم التالي (+1)</option>
                          <option value="2" ${(p.dayOffset || 0) === 2 ? 'selected' : ''}>بعد يومين (+2)</option>
                        </select>
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px">
            <button class="btn-primary" id="saveMissionBtn">حفظ المهمة</button>
            ${missionId ? `
              <button class="btn-danger" id="disMissionBtn">
                ${m.isActive === false ? 'إعادة تفعيل المهمة' : 'تعطيل المهمة'}
              </button>
            ` : ''}
            <button class="btn-ghost" id="cancelEditorBtn">إلغاء</button>
          </div>
        `;

        // Sync inputs from periods if currently rendered
        const collectPeriodsFromDOM = () => {
          if (currentMode !== 'MULTI_SHIFT') return;
          const cards = body.querySelectorAll('.period-edit-card');
          currentPeriods = Array.from(cards).map((card, idx) => {
            return {
              id: currentPeriods[idx]?.id || `P-${idx + 1}`,
              code: currentPeriods[idx]?.code || `P-${idx + 1}`,
              name: card.querySelector('.p-name').value.trim() || `فترة ${idx + 1}`,
              startTime: card.querySelector('.p-start').value.trim() || '12:00',
              durationMinutes: Number(card.querySelector('.p-dur').value) || 360,
              driversNeeded: Number(card.querySelector('.p-drivers').value) || 1,
              track: card.querySelector('.p-track').value.trim() || null,
              dayOffset: Number(card.querySelector('.p-day').value) || 0,
              orderIndex: idx
            };
          });
        };

        // Event listeners
        body.querySelector('#m_mode').onchange = (e) => {
          collectPeriodsFromDOM();
          currentMode = e.target.value;
          if (currentMode === 'MULTI_SHIFT' && currentPeriods.length === 0) {
            currentPeriods = [
              { id: 'P-1', code: 'P-1', name: 'الفترة 1', startTime: '17:00', durationMinutes: 360, driversNeeded: 1, dayOffset: 0, orderIndex: 0 },
              { id: 'P-2', code: 'P-2', name: 'الفترة 2', startTime: '23:00', durationMinutes: 360, driversNeeded: 1, dayOffset: 0, orderIndex: 1 }
            ];
          }
          renderEditor();
        };

        body.querySelector('#addPeriodBtn')?.addEventListener('click', () => {
          collectPeriodsFromDOM();
          const nextIdx = currentPeriods.length;
          currentPeriods.push({
            id: `P-${nextIdx + 1}`,
            code: `P-${nextIdx + 1}`,
            name: `فترة ${nextIdx + 1}`,
            startTime: '12:00',
            durationMinutes: 360,
            driversNeeded: 1,
            dayOffset: 0,
            track: null,
            orderIndex: nextIdx
          });
          renderEditor();
        });

        body.querySelectorAll('.del-period-btn').forEach(btn => {
          btn.onclick = () => {
            collectPeriodsFromDOM();
            const delIdx = Number(btn.dataset.del);
            currentPeriods.splice(delIdx, 1);
            renderEditor();
          };
        });

        body.querySelector('#tpl3Shifts')?.addEventListener('click', () => {
          currentPeriods = [
            { id: 'S1', code: 'S1', name: 'وردية المساء', startTime: '17:00', durationMinutes: 480, driversNeeded: 1, dayOffset: 0, orderIndex: 0 },
            { id: 'S2', code: 'S2', name: 'وردية الليل والفجر', startTime: '01:00', durationMinutes: 480, driversNeeded: 1, dayOffset: 1, orderIndex: 1 },
            { id: 'S3', code: 'S3', name: 'وردية الصباح والظهر', startTime: '09:00', durationMinutes: 480, driversNeeded: 1, dayOffset: 1, orderIndex: 2 }
          ];
          body.querySelector('#m_dur').value = '1440';
          body.querySelector('#m_start').value = '17:00';
          renderEditor();
        });

        body.querySelector('#tpl12h')?.addEventListener('click', () => {
          currentPeriods = [
            { id: 'P-NIGHT', code: 'P-NIGHT', name: 'دورية أول الليل', startTime: '18:00', durationMinutes: 360, driversNeeded: 2, dayOffset: 0, orderIndex: 0 },
            { id: 'P-DAWN', code: 'P-DAWN', name: 'دورية الفجر', startTime: '00:00', durationMinutes: 360, driversNeeded: 2, dayOffset: 1, orderIndex: 1 }
          ];
          body.querySelector('#m_dur').value = '720';
          body.querySelector('#m_start').value = '18:00';
          renderEditor();
        });

        body.querySelector('#tplForest')?.addEventListener('click', () => {
          currentPeriods = [
            { id: 'ALPHA-1', code: 'ALPHA-1', name: 'Alpha — بداية', track: 'ALPHA', startTime: '17:00', durationMinutes: 360, dayOffset: 0, driversNeeded: 1, orderIndex: 0 },
            { id: 'ALPHA-2', code: 'ALPHA-2', name: 'Alpha — فجر', track: 'ALPHA', startTime: '05:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 1, orderIndex: 1 },
            { id: 'ALPHA-3', code: 'ALPHA-3', name: 'Alpha — ظهر', track: 'ALPHA', startTime: '11:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 1, orderIndex: 2 },
            { id: 'MO-1', code: 'MO-1', name: 'MO — بداية', track: 'MO', startTime: '17:00', durationMinutes: 330, dayOffset: 0, driversNeeded: 1, orderIndex: 3 },
            { id: 'MO-2', code: 'MO-2', name: 'MO — صباح', track: 'MO', startTime: '07:30', durationMinutes: 270, dayOffset: 1, driversNeeded: 1, orderIndex: 4 },
            { id: 'MO-3', code: 'MO-3', name: 'MO — ظهر', track: 'MO', startTime: '12:30', durationMinutes: 270, dayOffset: 1, driversNeeded: 1, orderIndex: 5 }
          ];
          body.querySelector('#m_dur').value = '1440';
          body.querySelector('#m_start').value = '17:00';
          renderEditor();
        });

        body.querySelector('#cancelEditorBtn').onclick = close;

        body.querySelector('#saveMissionBtn').onclick = async () => {
          collectPeriodsFromDOM();
          const name = body.querySelector('#m_name').value.trim();
          const startTime = body.querySelector('#m_start').value.trim();
          const durationMinutes = Number(body.querySelector('#m_dur').value);
          const locationType = body.querySelector('#m_loc').value;
          const teamVal = body.querySelector('#m_team').value;
          const teamId = teamVal ? Number(teamVal) : null;
          const notes = body.querySelector('#m_notes')?.value.trim() || '';

          if (!name) return toast('اسم المهمة مطلوب', 2200, 'error');
          if (!/^\d{1,2}:\d{2}$/.test(startTime)) {
            return toast('صيغة وقت البداية غير صالحة (مثال 12:00)', 2200, 'error');
          }

          let finalPeriods = null;
          let driversNeeded = 1;

          if (currentMode === 'MULTI_SHIFT') {
            if (currentPeriods.length === 0) {
              return toast('يجب إضافة فترة واحدة على الأقل في نمط المناوبات', 2200, 'error');
            }
            finalPeriods = currentPeriods;
            driversNeeded = finalPeriods.reduce((sum, p) => sum + (Number(p.driversNeeded) || 1), 0);
          } else {
            driversNeeded = Number(body.querySelector('#m_single_drivers').value) || 1;
          }

          const payload = {
            name,
            startTime,
            durationMinutes,
            locationType,
            teamId,
            notes,
            type: currentMode === 'MULTI_SHIFT' ? 'MULTI_SHIFT' : 'NORMAL',
            periods: finalPeriods,
            driversNeeded
          };

          try {
            if (missionId) await editMission(missionId, payload);
            else await createMission(payload);
            toast('تم حفظ المهمة بنجاح', 2200, 'success');
            close(); refresh();
          } catch (e) {
            toast(e.message, 2200, 'error');
          }
        };

        body.querySelector('#disMissionBtn')?.addEventListener('click', async () => {
          if (m.isActive === false) {
            await editMission(missionId, { isActive: true });
            toast('تمت إعادة تفعيل المهمة', 2200, 'success');
          } else {
            if (!window.confirm('هل أنت متأكد من تعطيل هذه المهمة؟ لن يتم حذف تاريخها السابق.')) return;
            await disableMission(missionId);
            toast('تم تعطيل المهمة', 2200, 'warn');
          }
          close(); refresh();
        });
      };

      renderEditor();
    }
  });
}
