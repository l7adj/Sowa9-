import { all, get, put } from '../core/db.js';
import { nowIso, todayIso, toMin, fromMinSafe, fmtDurShort, humanDate, dayNameAr, buildStart, addMin, addDays, calcDuration } from '../core/clock.js';
import { isManager, requireWrite } from '../core/auth.js';
import { listMissions, getMission, createMission, editMission, disableMission, getMissionPeriods, MISSION_TYPE, SAMPLE_CATALOG } from '../domain/missions.js';
import { listByDate, createOccurrence, getOccurrence } from '../domain/occurrences.js';
import { listTeams } from '../domain/teams.js';
import { listDrivers, DRIVER_CATEGORY, DRIVER_CATEGORY_AR } from '../domain/drivers.js';
import { createProposal, ASG_STATUS } from '../domain/assignments.js';
import { suggestForTurn } from '../engine/fairness.js';
import { sheet, toast, esc, attachRipple, refresh } from './helpers.js';

export async function renderCatalogPage(main) {
  const isMgr = isManager();
  const [missions, teams] = await Promise.all([
    listMissions(true), // include disabled
    listTeams()
  ]);

  const teamMap = new Map(teams.map(t => [t.id, t]));

  main.innerHTML = `
    <div class="datebar" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:20px">📋</span>
        <div>
          <h2 style="font-size:16px;font-weight:800;margin:0;color:var(--text)">كتالوج وإدارة المهام</h2>
          <span style="font-size:11px;color:var(--text-3)">${missions.length} مهام معرفة في النظام</span>
        </div>
      </div>
      ${isMgr ? `
        <div style="display:flex;gap:6px">
          <button class="btn-primary" id="btnNewMission" style="padding:6px 12px;font-size:12px">
            + مهمة جديدة
          </button>
        </div>
      ` : ''}
    </div>

    ${isMgr ? `
      <div style="padding:10px 14px;background:var(--surface-2);border-radius:10px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between">
        <span style="font-size:12px;color:var(--text-2)">إجراءات سريعة لكتالوج المهام:</span>
        <div style="display:flex;gap:6px">
          <button class="tag" id="btnQuickCreateOcc" style="cursor:pointer;background:var(--color-accent);color:#fff;border:0;padding:4px 10px;font-weight:700">
            ⚡ إنشاء تشغيل لمهمة
          </button>
          <button class="tag" id="btnImportCatalog" style="cursor:pointer;background:var(--surface-3);color:var(--text);border:0;padding:4px 10px">
            📥 استيراد القالب الجاهز
          </button>
        </div>
      </div>
    ` : '<div class="readonly-banner">📖 عرض فقط — لا يمكنك تعديل أو إنشاء المهام</div>'}

    <div class="section" id="catalogSection">
      <div class="section-body" style="padding-top:4px">
        ${missions.length === 0 ? `
          <div class="empty-block">
            <div class="ic">📭</div>
            <h3>لا توجد مهام معرفة في الكتالوج</h3>
            <p>يمكنك إنشاء مهمة جديدة أو استيراد القالب الجاهز</p>
            ${isMgr ? `
              <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
                <button class="btn-primary" id="emptyNewMission">+ مهمة جديدة</button>
                <button class="btn-ghost" id="emptySeed">استيراد القالب</button>
              </div>
            ` : ''}
          </div>
        ` : missions.map(m => renderCatalogMissionCard(m, teamMap, isMgr)).join('')}
      </div>
    </div>
  `;

  // Attach event handlers
  main.querySelector('#btnNewMission')?.addEventListener('click', () => openMissionEditorModal());
  main.querySelector('#emptyNewMission')?.addEventListener('click', () => openMissionEditorModal());
  main.querySelector('#btnQuickCreateOcc')?.addEventListener('click', () => openCreateOccurrenceModal());

  main.querySelector('#btnImportCatalog')?.addEventListener('click', async () => {
    if (!window.confirm('هل تريد استيراد المهام الافتراضية إلى الكتالوج؟')) return;
    try {
      const existing = await all('missions');
      for (const sm of SAMPLE_CATALOG) {
        if (!existing.some(x => x.code === sm.code)) {
          await createMission(sm);
        }
      }
      toast('تم استيراد كتالوج المهام بنجاح', 2200, 'success');
      refresh();
    } catch (e) {
      toast(e.message, 2200, 'error');
    }
  });

  main.querySelector('#emptySeed')?.addEventListener('click', async () => {
    try {
      for (const sm of SAMPLE_CATALOG) {
        await createMission(sm);
      }
      toast('تم استيراد كتالوج المهام بنجاح', 2200, 'success');
      refresh();
    } catch (e) {
      toast(e.message, 2200, 'error');
    }
  });

  main.querySelectorAll('[data-edit-catalog-mission]').forEach(btn => {
    btn.onclick = () => openMissionEditorModal(Number(btn.dataset.editCatalogMission));
  });

  main.querySelectorAll('[data-toggle-active-mission]').forEach(btn => {
    btn.onclick = async () => {
      const mid = Number(btn.dataset.toggleActiveMission);
      const m = await getMission(mid);
      if (!m) return;
      if (m.isActive === false) {
        await editMission(mid, { isActive: true });
        toast('تمت إعادة تفعيل المهمة', 2200, 'success');
      } else {
        if (!window.confirm(`هل أنت متأكد من تعطيل مهمة "${m.name}"؟`)) return;
        await disableMission(mid);
        toast('تم تعطيل المهمة', 2200, 'warn');
      }
      refresh();
    };
  });

  main.querySelectorAll('[data-create-occ-for]').forEach(btn => {
    btn.onclick = () => openCreateOccurrenceModal(Number(btn.dataset.createOccFor));
  });

  main.querySelectorAll('.mission-card, .btn-primary, .btn-ghost').forEach(attachRipple);
}

function renderCatalogMissionCard(m, teamMap, isMgr) {
  const periods = getMissionPeriods(m);
  const isMulti = m.type === MISSION_TYPE.MULTI_SHIFT || periods.length > 1;
  const team = teamMap.get(m.teamId) || null;
  const isDisabled = m.isActive === false;
  const cat = m.driverCategory || DRIVER_CATEGORY.LIGHT;
  const isShared = cat === DRIVER_CATEGORY.SHARED;

  return `
    <div class="mission-card ${isDisabled ? 'disabled-mission' : ''}" style="margin-bottom:12px;opacity:${isDisabled ? '0.6' : '1'}">
      <div class="mission-head" style="cursor:default">
        <div class="av" style="background:${isShared ? '#3b82f6' : '#10b981'};font-size:18px">
          ${isShared ? '🚌' : '🚗'}
        </div>
        <div class="body" style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <h3 style="margin:0;font-size:14px;font-weight:800">${esc(m.name)}</h3>
            <span class="tag ${isShared ? 'cat-shared' : 'cat-light'}" style="font-size:10px">
              ${isShared ? '🚌 نقل مشترك' : '🚗 وزن خفيف'}
            </span>
            <span class="tag" style="font-size:10px">${esc(m.code || 'M' + m.id)}</span>
            ${isDisabled ? '<span class="tag warn" style="font-size:10px">معطلة</span>' : ''}
          </div>
          <div class="tags" style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">
            <span class="tag info" style="font-weight:700">
              ⏰ ${esc(m.startTime || '17:00')} ➔ ${esc(m.endTime || fromMinSafe(toMin(m.startTime || '17:00') + (m.durationMinutes || 360)))} (${fmtDurShort(m.durationMinutes)})
            </span>
            <span class="tag" style="font-weight:700">${m.driversNeeded || 1} سواق</span>
            <span class="tag">${isMulti ? `${periods.length} فترات / مناوبات` : 'فترة واحدة'}</span>
            ${team ? `<span class="tag" style="background:${esc(team.color || '#3b82f6')}22;color:${esc(team.color || '#3b82f6')};font-weight:700">${esc(team.name)}</span>` : ''}
          </div>
        </div>
      </div>

      <!-- Periods Breakdown -->
      <div style="padding:10px 14px;background:var(--surface-2);border-top:1px solid var(--line);font-size:12px">
        <div style="font-weight:700;margin-bottom:6px;color:var(--text-2)">⏱ فترات وتوقيتات المهمة:</div>
        <div style="display:flex;flex-direction:column;gap:5px">
          ${periods.map((p, i) => {
            const pShared = (p.driverCategory || cat) === DRIVER_CATEGORY.SHARED;
            return `
              <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-card);padding:6px 10px;border-radius:8px;border:1px solid var(--line)">
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="font-size:14px">${pShared ? '🚌' : '🚗'}</span>
                  <span style="font-weight:700">${esc(p.name)}</span>
                  <span class="tag ${pShared ? 'cat-shared' : 'cat-light'}" style="font-size:9px">
                    ${pShared ? 'نقل مشترك' : 'وزن خفيف'}
                  </span>
                  ${p.track ? `<span class="tag" style="font-size:10px">${esc(p.track)}</span>` : ''}
                </div>
                <div style="color:var(--text-3);font-size:11px;font-weight:600">
                  <span style="color:var(--text);font-weight:700">${esc(p.startTime)} ➔ ${esc(p.endTime)}</span>
                  (${fmtDurShort(p.durationMinutes)}) · ${p.driversNeeded} سائق
                  ${p.dayOffset > 0 ? `<span class="tag warn" style="font-size:9px">+${p.dayOffset} يوم</span>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ${m.notes ? `<div style="margin-top:6px;font-size:11px;color:var(--text-3)">📝 ${esc(m.notes)}</div>` : ''}
      </div>

      <!-- Actions -->
      ${isMgr ? `
        <div style="padding:8px 14px;display:flex;justify-content:space-between;align-items:center;background:var(--surface-card);border-top:1px solid var(--line);gap:6px;flex-wrap:wrap">
          <div style="display:flex;gap:6px">
            <button class="btn-primary" data-create-occ-for="${m.id}" style="padding:6px 12px;font-size:11px;display:flex;align-items:center;gap:4px">
              <span>🚀</span>
              <span>تشغيل وتعيين السواق</span>
            </button>
            <button class="btn-ghost" data-edit-catalog-mission="${m.id}" style="padding:6px 10px;font-size:11px">
              ✏️ تعديل
            </button>
          </div>
          <button class="btn-ghost" data-toggle-active-mission="${m.id}" style="padding:5px 10px;font-size:11px;color:${isDisabled ? 'var(--accent)' : 'var(--danger,#ef4444)'}">
            ${isDisabled ? 'إعادة تفعيل' : 'تعطيل'}
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════
// Full Mission Editor Modal with Timing & Driver Category
// ═══════════════════════════════════════
export async function openMissionEditorModal(missionId = null) {
  requireWrite('mission.edit');
  const [existingMission, teams] = await Promise.all([
    missionId ? getMission(missionId) : null,
    listTeams()
  ]);

  const defaultStartTime = '17:00';
  const defaultEndTime = '23:00';

  const m = existingMission || {
    name: '',
    code: '',
    type: 'NORMAL',
    driverCategory: DRIVER_CATEGORY.LIGHT,
    startTime: defaultStartTime,
    endTime: defaultEndTime,
    durationMinutes: 360,
    driversNeeded: 1,
    locationType: 'outdoor',
    teamId: teams[0]?.id || 1,
    notes: '',
    periods: null
  };

  let currentCategory = m.driverCategory || DRIVER_CATEGORY.LIGHT;
  let currentMode = (m.periods && m.periods.length > 0) || m.type === 'MULTI_SHIFT' ? 'MULTI_SHIFT' : 'NORMAL';
  let currentStartTime = m.startTime || defaultStartTime;
  let currentEndTime = m.endTime || (m.startTime && m.durationMinutes ? fromMinSafe(toMin(m.startTime) + m.durationMinutes) : defaultEndTime);
  let currentPeriods = (m.periods && m.periods.length > 0) ? JSON.parse(JSON.stringify(m.periods)) : [];

  sheet({
    title: missionId ? 'تعديل تعريف المهمة' : 'تعريف مهمة جديدة',
    subtitle: missionId ? `تعديل المهمة: ${m.name}` : 'تحديد توقيتات المهمة ونوع السائق المطلوب وفترات العمل',
    builder: (body, close) => {
      const renderEditor = () => {
        const computedDur = calcDuration(currentStartTime, currentEndTime);

        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:14px">
            <!-- Mission Name & Code -->
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">اسم المهمة <span style="color:red">*</span></label>
              <input id="m_name" class="input" value="${esc(m.name)}" placeholder="مثال: نقل العمال والمناوبات" style="width:100%">
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">كود المهمة</label>
                <input id="m_code" class="input" value="${esc(m.code)}" placeholder="مثال: WORKER-24H" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">الفرقة المسؤولة</label>
                <select id="m_team" class="input" style="width:100%">
                  ${teams.map(t => `<option value="${t.id}" ${Number(m.teamId) === Number(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
                </select>
              </div>
            </div>

            <!-- Driver Category Selection -->
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">صنف السائق المطلوب (نوع المركبة والمهام)</label>
              <div class="segment-group" id="catSegmentGroup">
                <button type="button" class="segment-btn ${currentCategory === DRIVER_CATEGORY.LIGHT ? 'active accent-light' : ''}" data-cat="${DRIVER_CATEGORY.LIGHT}">
                  <span>🚗</span>
                  <span>وزن خفيف (ميداني)</span>
                </button>
                <button type="button" class="segment-btn ${currentCategory === DRIVER_CATEGORY.SHARED ? 'active accent-shared' : ''}" data-cat="${DRIVER_CATEGORY.SHARED}">
                  <span>🚌</span>
                  <span>نقل مشترك (حافلات)</span>
                </button>
                <button type="button" class="segment-btn ${currentCategory === DRIVER_CATEGORY.ALL ? 'active' : ''}" data-cat="${DRIVER_CATEGORY.ALL}">
                  <span>🌟</span>
                  <span>شامل</span>
                </button>
              </div>
            </div>

            <!-- Single Shift vs Multi-Shift -->
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">نمط المهمة</label>
              <div class="segment-group" id="modeSegmentGroup">
                <button type="button" class="segment-btn ${currentMode === 'NORMAL' ? 'active' : ''}" data-mode="NORMAL">
                  <span>⚡</span>
                  <span>وردية واحدة (فترة محددة)</span>
                </button>
                <button type="button" class="segment-btn ${currentMode === 'MULTI_SHIFT' ? 'active' : ''}" data-mode="MULTI_SHIFT">
                  <span>🔄</span>
                  <span>مناوبات متتابعة (عدة فترات)</span>
                </button>
              </div>
            </div>

            <!-- Mission Overall Timing (Start & End Time) -->
            <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:12px">
              <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:6px">
                <span>⏰</span>
                <span>توقيت المهمة (وقت البدء ووقت الانتهاء):</span>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div>
                  <label style="font-size:11px;font-weight:700;display:block;margin-bottom:4px;color:var(--text-2)">وقت البداية</label>
                  <input type="time" id="m_start" class="input" value="${esc(currentStartTime)}" style="width:100%;font-size:14px;font-weight:700">
                </div>
                <div>
                  <label style="font-size:11px;font-weight:700;display:block;margin-bottom:4px;color:var(--text-2)">وقت النهاية</label>
                  <input type="time" id="m_end" class="input" value="${esc(currentEndTime)}" style="width:100%;font-size:14px;font-weight:700">
                </div>
              </div>
              <div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;font-size:12px">
                <span style="color:var(--text-3)">المدة المحسوبة تلقائياً:</span>
                <span class="tag info" id="lblDuration" style="font-weight:800;font-size:12px">
                  ${fmtDurShort(computedDur)} ${toMin(currentEndTime) < toMin(currentStartTime) ? '(تنتهي في اليوم التالي)' : ''}
                </span>
              </div>
            </div>

            ${currentMode === 'NORMAL' ? `
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">عدد السواق المطلوبين للفترة</label>
                <input id="m_single_drivers" type="number" min="1" class="input" value="${m.driversNeeded || 1}" style="width:100%">
              </div>
            ` : `
              <!-- Multi-Shift Periods Roster -->
              <div style="padding:12px;background:var(--surface-2);border-radius:12px;border:1px solid var(--line)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                  <b style="font-size:13px;color:var(--text)">⏱ فترات ومناوبات المهمة (${currentPeriods.length})</b>
                  <button type="button" id="btnAddPeriod" class="btn-primary" style="padding:5px 12px;font-size:11px">
                    + إضافة وردية
                  </button>
                </div>

                <div id="periodsContainer" style="display:flex;flex-direction:column;gap:10px">
                  ${currentPeriods.map((p, idx) => {
                    const pDur = calcDuration(p.startTime || '12:00', p.endTime || '18:00');
                    const isPShared = (p.driverCategory || currentCategory) === DRIVER_CATEGORY.SHARED;
                    return `
                      <div class="period-edit-box" data-pidx="${idx}" style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:12px">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                          <span style="font-weight:800;font-size:13px">فترة التكليف #${idx + 1}</span>
                          <button type="button" class="btn-del-period" data-del="${idx}" style="background:transparent;color:var(--danger,#ef4444);border:0;cursor:pointer;font-size:12px;font-weight:700">
                            🗑️ حذف الفترة
                          </button>
                        </div>
                        <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-bottom:8px">
                          <div>
                            <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">اسم الفترة / المناوبة</label>
                            <input class="p-name input" value="${esc(p.name)}" placeholder="مثال: المناوبة الصباحية" style="padding:6px 8px;font-size:12px;width:100%">
                          </div>
                          <div>
                            <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">صنف السائق المطلوب</label>
                            <select class="p-cat input" style="padding:6px 8px;font-size:11px;width:100%">
                              <option value="${DRIVER_CATEGORY.LIGHT}" ${!isPShared ? 'selected' : ''}>🚗 وزن خفيف</option>
                              <option value="${DRIVER_CATEGORY.SHARED}" ${isPShared ? 'selected' : ''}>🚌 نقل مشترك</option>
                            </select>
                          </div>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
                          <div>
                            <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">وقت البدء</label>
                            <input type="time" class="p-start input" value="${esc(p.startTime || '12:00')}" style="padding:5px 6px;font-size:12px;width:100%">
                          </div>
                          <div>
                            <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">وقت النهاية</label>
                            <input type="time" class="p-end input" value="${esc(p.endTime || '18:00')}" style="padding:5px 6px;font-size:12px;width:100%">
                          </div>
                          <div>
                            <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">عدد السواق</label>
                            <input class="p-drivers input" type="number" min="1" value="${p.driversNeeded || 1}" style="padding:5px 6px;font-size:12px;width:100%">
                          </div>
                        </div>
                        <div style="margin-top:6px;font-size:11px;color:var(--text-3);display:flex;justify-content:space-between">
                          <span>المدة: <b>${fmtDurShort(pDur)}</b></span>
                          <span style="font-size:10px">${p.dayOffset > 0 ? '+1 يوم' : 'نفس اليوم'}</span>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `}

            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">ملاحظات تشغيلية</label>
              <textarea id="m_notes" class="input" rows="2" style="width:100%">${esc(m.notes || '')}</textarea>
            </div>

            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn-primary" id="btnSaveMission" style="flex:1;padding:10px">
                ${missionId ? 'حفظ التعديلات' : 'إضافة المهمة للكتالوج'}
              </button>
              <button class="btn-ghost" id="btnCancelMission" style="flex:1;padding:10px">إلغاء</button>
            </div>
          </div>
        `;

        const collectValues = () => {
          currentStartTime = body.querySelector('#m_start')?.value || currentStartTime;
          currentEndTime = body.querySelector('#m_end')?.value || currentEndTime;
          if (currentMode === 'MULTI_SHIFT') {
            const boxes = body.querySelectorAll('.period-edit-box');
            currentPeriods = Array.from(boxes).map((box, idx) => {
              const pStart = box.querySelector('.p-start')?.value || '12:00';
              const pEnd = box.querySelector('.p-end')?.value || '18:00';
              const dur = calcDuration(pStart, pEnd);
              return {
                id: currentPeriods[idx]?.id || `P-${idx + 1}`,
                code: currentPeriods[idx]?.code || `P-${idx + 1}`,
                name: box.querySelector('.p-name')?.value.trim() || `وردية ${idx + 1}`,
                startTime: pStart,
                endTime: pEnd,
                durationMinutes: dur,
                driverCategory: box.querySelector('.p-cat')?.value || currentCategory,
                driversNeeded: Number(box.querySelector('.p-drivers')?.value) || 1,
                track: currentPeriods[idx]?.track || null,
                dayOffset: toMin(pEnd) < toMin(pStart) ? 1 : 0,
                orderIndex: idx
              };
            });
          }
        };

        // Category buttons
        body.querySelectorAll('#catSegmentGroup .segment-btn').forEach(btn => {
          btn.onclick = () => {
            collectValues();
            currentCategory = btn.dataset.cat;
            renderEditor();
          };
        });

        // Mode buttons
        body.querySelectorAll('#modeSegmentGroup .segment-btn').forEach(btn => {
          btn.onclick = () => {
            collectValues();
            currentMode = btn.dataset.mode;
            if (currentMode === 'MULTI_SHIFT' && currentPeriods.length === 0) {
              currentPeriods = [
                { id: 'P-1', code: 'P-1', name: 'وردية المساء', startTime: '17:00', endTime: '23:00', durationMinutes: 360, driversNeeded: 1, driverCategory: currentCategory, dayOffset: 0, orderIndex: 0 },
                { id: 'P-2', code: 'P-2', name: 'وردية الليل', startTime: '23:00', endTime: '05:00', durationMinutes: 360, driversNeeded: 1, driverCategory: currentCategory, dayOffset: 0, orderIndex: 1 }
              ];
            }
            renderEditor();
          };
        });

        // Timing inputs reactive duration
        const syncDuration = () => {
          const s = body.querySelector('#m_start')?.value || '17:00';
          const e = body.querySelector('#m_end')?.value || '23:00';
          currentStartTime = s;
          currentEndTime = e;
          const dur = calcDuration(s, e);
          const lbl = body.querySelector('#lblDuration');
          if (lbl) {
            lbl.textContent = `${fmtDurShort(dur)} ${toMin(e) < toMin(s) ? '(تنتهي في اليوم التالي)' : ''}`;
          }
        };
        body.querySelector('#m_start')?.addEventListener('input', syncDuration);
        body.querySelector('#m_end')?.addEventListener('input', syncDuration);

        // Add Period
        body.querySelector('#btnAddPeriod')?.addEventListener('click', () => {
          collectValues();
          const nextIdx = currentPeriods.length + 1;
          currentPeriods.push({
            id: `P-${nextIdx}`,
            code: `P-${nextIdx}`,
            name: `وردية ${nextIdx}`,
            startTime: '12:00',
            endTime: '18:00',
            durationMinutes: 360,
            driversNeeded: 1,
            driverCategory: currentCategory,
            dayOffset: 0,
            track: null,
            orderIndex: currentPeriods.length
          });
          renderEditor();
        });

        // Delete Period
        body.querySelectorAll('.btn-del-period').forEach(btn => {
          btn.onclick = () => {
            collectValues();
            currentPeriods.splice(Number(btn.dataset.del), 1);
            renderEditor();
          };
        });

        body.querySelector('#btnCancelMission').onclick = close;

        body.querySelector('#btnSaveMission').onclick = async () => {
          collectValues();
          const name = body.querySelector('#m_name').value.trim();
          const code = body.querySelector('#m_code').value.trim();
          const startTime = currentStartTime;
          const endTime = currentEndTime;
          const durationMinutes = calcDuration(startTime, endTime);
          const locationType = m.locationType || 'outdoor';
          const teamId = Number(body.querySelector('#m_team').value) || 1;
          const notes = body.querySelector('#m_notes').value.trim();

          if (!name) return toast('اسم المهمة مطلوب', 2200, 'error');

          let finalPeriods = null;
          let driversNeeded = 1;

          if (currentMode === 'MULTI_SHIFT') {
            if (currentPeriods.length === 0) {
              return toast('يجب إضافة وردية واحدة على الأقل في نمط المناوبات', 2200, 'error');
            }
            finalPeriods = currentPeriods;
            driversNeeded = finalPeriods.reduce((sum, p) => sum + (Number(p.driversNeeded) || 1), 0);
          } else {
            driversNeeded = Number(body.querySelector('#m_single_drivers')?.value) || 1;
          }

          const payload = {
            name,
            code: code || ('M' + Date.now().toString().slice(-4)),
            driverCategory: currentCategory,
            startTime,
            endTime,
            durationMinutes,
            driversNeeded,
            locationType,
            teamId,
            notes,
            type: currentMode === 'MULTI_SHIFT' ? MISSION_TYPE.MULTI_SHIFT : MISSION_TYPE.NORMAL,
            periods: finalPeriods
          };

          try {
            if (missionId) await editMission(missionId, payload);
            else await createMission(payload);
            toast('تم حفظ المهمة بنجاح بنظام التوقيت والتصنيف', 2200, 'success');
            close();
            refresh();
          } catch (err) {
            toast(err.message, 2500, 'error');
          }
        };
      };

      renderEditor();
    }
  });
}

// ═══════════════════════════════════════
// Smart Mission Launch & Driver Assignment Studio
// ═══════════════════════════════════════
export async function openCreateOccurrenceModal(preselectedMissionId = null) {
  requireWrite('occurrence.create');
  const [missions, allDrivers, teams] = await Promise.all([
    listMissions(false), // active only
    listDrivers(),
    listTeams()
  ]);

  if (missions.length === 0) {
    return toast('لا توجد مهام نشطة في الكتالوج. أضف مهمة أولاً.', 2500, 'warn');
  }

  const teamMap = new Map(teams.map(t => [t.id, t]));

  // Selected state
  let selectedMissionId = preselectedMissionId ? Number(preselectedMissionId) : missions[0].id;
  let selectedDate = todayIso();

  sheet({
    title: '🚀 استوديو تشغيل المهمة وتعيين السواق',
    subtitle: 'تحديد توقيت المهمة وتعيين سواق الوزن الخفيف والنقل المشترك بأوقات دقيقة',
    builder: (body, close) => {
      const renderStudio = async () => {
        const currentMission = missions.find(m => m.id === selectedMissionId) || missions[0];
        const periods = getMissionPeriods(currentMission);
        const missionCat = currentMission.driverCategory || DRIVER_CATEGORY.LIGHT;
        const totalDur = calcDuration(currentMission.startTime || '17:00', currentMission.endTime || '23:00');

        // Pre-fetch fair turn suggestions for each period
        const periodSuggestions = [];
        for (const p of periods) {
          const pStartIso = buildStart(selectedDate, p.startTime || currentMission.startTime || '17:00');
          const pEndIso = addMin(pStartIso, p.durationMinutes || 360);
          const reqCat = p.driverCategory || missionCat;

          let suggestion = null;
          try {
            suggestion = await suggestForTurn({
              missionId: currentMission.id,
              periodId: p.code || p.id,
              occurrenceId: 0,
              startIso: pStartIso,
              endIso: pEndIso,
              targetTeamId: currentMission.teamId,
              requiredCategory: reqCat
            });
          } catch (e) {
            console.warn('Turn suggestion error:', e);
          }

          periodSuggestions.push({
            period: p,
            startIso: pStartIso,
            endIso: pEndIso,
            requiredCategory: reqCat,
            suggestion
          });
        }

        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:14px">
            <!-- 1. MISSION SELECTION CARDS (Visual, No clumsy dropdowns) -->
            <div>
              <label style="font-size:12px;font-weight:800;display:block;margin-bottom:6px;color:var(--text)">
                1. اختر المهمة المراد تفعيلها:
              </label>
              <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:8px;max-height:160px;overflow-y:auto;padding:2px">
                ${missions.map(m => {
                  const isSel = m.id === currentMission.id;
                  const isShared = m.driverCategory === DRIVER_CATEGORY.SHARED;
                  return `
                    <div class="mission-pick-card" data-mid="${m.id}" style="border:2px solid ${isSel ? 'var(--primary)' : 'var(--line)'};background:${isSel ? 'var(--surface-2)' : 'var(--surface-card)'};border-radius:10px;padding:10px;cursor:pointer;transition:all 0.15s">
                      <div style="display:flex;align-items:center;gap:6px">
                        <span style="font-size:16px">${isShared ? '🚌' : '🚗'}</span>
                        <div style="font-weight:800;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                          ${esc(m.name)}
                        </div>
                      </div>
                      <div style="display:flex;align-items:center;gap:4px;margin-top:4px">
                        <span class="tag ${isShared ? 'cat-shared' : 'cat-light'}" style="font-size:9px">
                          ${isShared ? 'نقل مشترك' : 'وزن خفيف'}
                        </span>
                        <span style="font-size:10px;color:var(--text-3);font-weight:700">
                          ${esc(m.startTime)} ➔ ${esc(m.endTime || fromMinSafe(toMin(m.startTime) + (m.durationMinutes || 360)))}
                        </span>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <!-- 2. DATE SELECTOR WITH SHORTCUTS -->
            <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:12px">
              <label style="font-size:12px;font-weight:800;display:block;margin-bottom:6px;color:var(--text)">
                2. تاريخ تشغيل المهمة:
              </label>
              <div class="filter-chips-row" style="margin-bottom:8px">
                <button type="button" class="filter-pill ${selectedDate === todayIso() ? 'active' : ''}" data-setdate="${todayIso()}">
                  اليوم (${todayIso()})
                </button>
                <button type="button" class="filter-pill ${selectedDate === addDays(todayIso(), 1) ? 'active' : ''}" data-setdate="${addDays(todayIso(), 1)}">
                  غداً (+1 يوم)
                </button>
                <button type="button" class="filter-pill ${selectedDate === addDays(todayIso(), 2) ? 'active' : ''}" data-setdate="${addDays(todayIso(), 2)}">
                  بعد غد (+2 يوم)
                </button>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <input type="date" id="occ_date" class="input" value="${selectedDate}" style="flex:1;font-weight:700">
                <span style="font-size:12px;color:var(--text-3);font-weight:700">${esc(humanDate(selectedDate))} (${esc(dayNameAr(selectedDate))})</span>
              </div>
            </div>

            <!-- 3. DETAILED PERIODS & DRIVER ROSTER STUDIO -->
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <label style="font-size:12px;font-weight:800;color:var(--text)">
                  3. جدول وتعيين السواق للفترات (${periods.length} فترات):
                </label>
                <span class="tag info" style="font-size:10px;font-weight:700">
                  تحديد بداية ونهاية كل سائق
                </span>
              </div>

              <div id="rosterContainer" style="display:flex;flex-direction:column;gap:10px">
                ${periodSuggestions.map((ps, pIdx) => {
                  const p = ps.period;
                  const reqCat = ps.requiredCategory;
                  const isShared = reqCat === DRIVER_CATEGORY.SHARED;
                  const needed = p.driversNeeded || 1;
                  const suggestedDr = ps.suggestion?.proposed || null;

                  // Filter drivers by category match first
                  const matchingDrivers = allDrivers.filter(d => {
                    const dCat = d.category || DRIVER_CATEGORY.LIGHT;
                    return dCat === reqCat || dCat === DRIVER_CATEGORY.ALL;
                  });
                  const otherDrivers = allDrivers.filter(d => {
                    const dCat = d.category || DRIVER_CATEGORY.LIGHT;
                    return dCat !== reqCat && dCat !== DRIVER_CATEGORY.ALL;
                  });

                  return `
                    <div class="roster-period-card" data-pidx="${pIdx}" data-pcode="${esc(p.code || p.id)}" style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px">
                      <!-- Period Header -->
                      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid var(--line);padding-bottom:8px">
                        <div style="display:flex;align-items:center;gap:6px">
                          <span style="font-size:16px">${isShared ? '🚌' : '🚗'}</span>
                          <span style="font-weight:800;font-size:13px">${esc(p.name)}</span>
                          <span class="tag ${isShared ? 'cat-shared' : 'cat-light'}" style="font-size:10px">
                            مطلوب: ${isShared ? 'سائق نقل مشترك' : 'سائق وزن خفيف'}
                          </span>
                        </div>
                        <div style="font-size:11px;font-weight:700;color:var(--text)">
                          ⏰ <b>${esc(p.startTime)} ➔ ${esc(p.endTime)}</b> (${fmtDurShort(p.durationMinutes)})
                        </div>
                      </div>

                      <!-- Driver Slots for this Period -->
                      <div style="display:flex;flex-direction:column;gap:8px">
                        ${Array.from({ length: needed }).map((_, slotIdx) => {
                          const autoSelectedId = slotIdx === 0 && suggestedDr ? suggestedDr.id : '';
                          return `
                            <div class="driver-slot-row" data-slot="${slotIdx}" style="background:var(--surface-2);border-radius:10px;padding:10px">
                              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                                <span style="font-size:11px;font-weight:800;color:var(--text-2)">
                                  👤 السائق #${slotIdx + 1}:
                                </span>
                                ${slotIdx === 0 && suggestedDr ? `
                                  <span class="tag ok" style="font-size:10px;font-weight:800">
                                    ⭐ صاحب الدور العادل: ${esc(suggestedDr.name)}
                                  </span>
                                ` : ''}
                              </div>

                               <!-- Driver Selection (Strictly Filtered by Category) -->
                              <select class="slot-driver-select input" style="width:100%;font-weight:700;margin-bottom:6px">
                                <option value="">-- اختر السائق المكلف --</option>
                                ${suggestedDr && slotIdx === 0 && (suggestedDr.category === 'ALL' || suggestedDr.category === (isShared ? DRIVER_CATEGORY.SHARED : DRIVER_CATEGORY.LIGHT)) ? `
                                  <option value="${suggestedDr.id}" selected>
                                    ⭐ [المستحق حسب الدور] ${esc(suggestedDr.name)} (${DRIVER_CATEGORY_AR[suggestedDr.category] || suggestedDr.category})
                                  </option>
                                ` : ''}
                                <optgroup label="✅ سواق فرقة (${isShared ? 'النقل المشترك 🚌' : 'الوزن الخفيف 🚗'})">
                                  ${matchingDrivers.map(d => `
                                    <option value="${d.id}" ${d.id === autoSelectedId ? 'selected' : ''}>
                                      ${esc(d.name)} (${DRIVER_CATEGORY_AR[d.category] || d.category}) — ${d.status === 'AVAILABLE' ? 'متاح' : 'غير متاح'}
                                    </option>
                                  `).join('')}
                                </optgroup>
                              </select>

                              <!-- Driver Precise Start & End Time -->
                              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
                                <div>
                                  <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">وقت بداية السائق</label>
                                  <input type="time" class="slot-dr-start input" value="${esc(p.startTime)}" style="padding:4px 6px;font-size:12px;width:100%">
                                </div>
                                <div>
                                  <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">وقت نهاية السائق</label>
                                  <input type="time" class="slot-dr-end input" value="${esc(p.endTime)}" style="padding:4px 6px;font-size:12px;width:100%">
                                </div>
                              </div>
                            </div>
                          `;
                        }).join('')}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <!-- Action Buttons -->
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn-primary" id="btnLaunchMissionWithDrivers" style="flex:2;padding:12px;font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;gap:6px">
                <span>🚀</span>
                <span>تفعيل المهمة وتعيين السواق فوراً</span>
              </button>
              <button class="btn-ghost" id="btnCancelStudio" style="flex:1;padding:12px">إلغاء</button>
            </div>
          </div>
        `;

        // Mission pick event
        body.querySelectorAll('.mission-pick-card').forEach(card => {
          card.onclick = () => {
            selectedMissionId = Number(card.dataset.mid);
            renderStudio();
          };
        });

        // Date shortcuts
        body.querySelectorAll('[data-setdate]').forEach(btn => {
          btn.onclick = () => {
            selectedDate = btn.dataset.setdate;
            renderStudio();
          };
        });

        body.querySelector('#occ_date').onchange = (e) => {
          selectedDate = e.target.value;
          renderStudio();
        };

        body.querySelector('#btnCancelStudio').onclick = close;

        // Launch & Assign Flow
        body.querySelector('#btnLaunchMissionWithDrivers').onclick = async () => {
          const date = selectedDate;
          if (!date) return toast('يرجى تحديد تاريخ التشغيل', 2200, 'error');

          const launchBtn = body.querySelector('#btnLaunchMissionWithDrivers');
          launchBtn.disabled = true;
          launchBtn.innerHTML = '<span>⏳</span><span>جارٍ تفعيل المهمة وجدولة السواق...</span>';

          try {
            // 1. Create Occurrence
            const occId = await createOccurrence({
              dateIso: date,
              missionId: currentMission.id,
              startTime: currentMission.startTime || '17:00',
              durationMinutes: currentMission.durationMinutes || 360
            });

            // 2. Read each period's assigned drivers and precise timings
            const periodCards = body.querySelectorAll('.roster-period-card');
            let assignmentCount = 0;

            for (const pCard of periodCards) {
              const pcode = pCard.dataset.pcode;
              const slotRows = pCard.querySelectorAll('.driver-slot-row');

              for (const slot of slotRows) {
                const driverSelect = slot.querySelector('.slot-driver-select');
                const drId = driverSelect ? Number(driverSelect.value) : null;
                const drStart = slot.querySelector('.slot-dr-start')?.value || currentMission.startTime;
                const drEnd = slot.querySelector('.slot-dr-end')?.value || currentMission.endTime;

                if (drId) {
                  const startIso = buildStart(date, drStart);
                  const endIso = toMin(drEnd) < toMin(drStart)
                    ? buildStart(addDays(date, 1), drEnd)
                    : buildStart(date, drEnd);

                  await createProposal({
                    occurrenceId: occId,
                    missionId: currentMission.id,
                    periodId: pcode,
                    periodCode: pcode,
                    dueDriverId: drId,
                    plannedDriverId: drId,
                    startIso,
                    endIso,
                    rationale: 'تعيين مباشر عبر استوديو التشغيل',
                    autoConfirm: true
                  });
                  assignmentCount++;
                }
              }
            }

            toast(`تم تفعيل مهمة "${currentMission.name}" وجدولة ${assignmentCount} سائق بنجاح!`, 2500, 'success');
            close();
            refresh();
          } catch (err) {
            toast(err.message, 3000, 'error');
            launchBtn.disabled = false;
            launchBtn.innerHTML = '<span>🚀</span><span>تفعيل المهمة وتعيين السواق فوراً</span>';
          }
        };
      };

      renderStudio();
    }
  });
}

