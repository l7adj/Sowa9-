import { all, get, put } from '../core/db.js';
import { nowIso, todayIso, toMin, fromMinSafe, fmtDurShort, humanDate, dayNameAr, buildStart, addMin } from '../core/clock.js';
import { isManager, requireWrite } from '../core/auth.js';
import { listMissions, getMission, createMission, editMission, disableMission, getMissionPeriods, MISSION_TYPE, SAMPLE_CATALOG } from '../domain/missions.js';
import { listByDate, createOccurrence, getOccurrence } from '../domain/occurrences.js';
import { listTeams } from '../domain/teams.js';
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

  return `
    <div class="mission-card ${isDisabled ? 'disabled-mission' : ''}" style="margin-bottom:12px;opacity:${isDisabled ? '0.6' : '1'}">
      <div class="mission-head" style="cursor:default">
        <div class="av" style="background:${isMulti ? 'var(--warn,#f59e0b)' : 'var(--color-accent)'}">
          ${esc(m.startTime ? m.startTime.slice(0, 2) : '⏱')}
        </div>
        <div class="body" style="flex:1">
          <div style="display:flex;align-items:center;gap:6px">
            <h3 style="margin:0;font-size:14px;font-weight:700">${esc(m.name)}</h3>
            <span class="tag" style="font-size:10px">${esc(m.code || 'M' + m.id)}</span>
            ${isDisabled ? '<span class="tag warn" style="font-size:10px">معطلة</span>' : ''}
          </div>
          <div class="tags" style="margin-top:4px">
            <span class="tag info">${esc(m.startTime || '12:00')} (${fmtDurShort(m.durationMinutes)})</span>
            <span class="tag">${m.driversNeeded || 1} سواق</span>
            <span class="tag">${isMulti ? `${periods.length} فترات / مناوبات` : 'فترة واحدة'}</span>
            ${team ? `<span class="tag" style="background:${esc(team.color || '#3b82f6')}22;color:${esc(team.color || '#3b82f6')}">${esc(team.name)}</span>` : ''}
          </div>
        </div>
      </div>

      <!-- Periods Breakdown -->
      <div style="padding:10px 14px;background:var(--surface-2);border-top:1px solid var(--line);font-size:12px">
        <div style="font-weight:700;margin-bottom:6px;color:var(--text-2)">⏱ فترات المهمة:</div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${periods.map((p, i) => `
            <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-card);padding:5px 8px;border-radius:6px">
              <div>
                <span style="font-weight:700">${esc(p.name)}</span>
                ${p.track ? `<span class="tag" style="font-size:10px;margin-right:4px">${esc(p.track)}</span>` : ''}
              </div>
              <div style="color:var(--text-3);font-size:11px">
                ${esc(p.startTime)} → ${esc(p.endTime)}
                (${fmtDurShort(p.durationMinutes)}) · ${p.driversNeeded} سائق
                ${p.dayOffset > 0 ? `<span class="tag warn" style="font-size:9px">+${p.dayOffset} يوم</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
        ${m.notes ? `<div style="margin-top:6px;font-size:11px;color:var(--text-3)">📝 ${esc(m.notes)}</div>` : ''}
      </div>

      <!-- Actions -->
      ${isMgr ? `
        <div style="padding:8px 14px;display:flex;justify-content:space-between;align-items:center;background:var(--surface-card);border-top:1px solid var(--line);gap:6px;flex-wrap:wrap">
          <div style="display:flex;gap:6px">
            <button class="btn-primary" data-create-occ-for="${m.id}" style="padding:5px 10px;font-size:11px">
              ⚡ تشغيل اليوم
            </button>
            <button class="btn-ghost" data-edit-catalog-mission="${m.id}" style="padding:5px 10px;font-size:11px">
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
// Full Mission Editor Modal (Requirement 6)
// ═══════════════════════════════════════
export async function openMissionEditorModal(missionId = null) {
  requireWrite('mission.edit');
  const [existingMission, teams] = await Promise.all([
    missionId ? getMission(missionId) : null,
    listTeams()
  ]);

  const m = existingMission || {
    name: '',
    code: '',
    type: 'NORMAL',
    startTime: '17:00',
    durationMinutes: 360,
    driversNeeded: 1,
    locationType: 'outdoor',
    teamId: teams[0]?.id || 1,
    notes: '',
    periods: null
  };

  let currentPeriods = (m.periods && m.periods.length > 0) ? JSON.parse(JSON.stringify(m.periods)) : [];
  let currentMode = (currentPeriods.length > 0 || m.type === 'MULTI_SHIFT') ? 'MULTI_SHIFT' : 'NORMAL';

  sheet({
    title: missionId ? 'تعديل تعريف المهمة' : 'تعريف مهمة جديدة',
    subtitle: missionId ? `تعديل الكود: ${m.code}` : 'إدخال مهمة جديدة في الكتالوج وتحديد فتراتها',
    builder: (body, close) => {
      const renderEditor = () => {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">اسم المهمة <span style="color:red">*</span></label>
              <input id="m_name" class="input" value="${esc(m.name)}" placeholder="مثال: نقل العمال والمناوبات" style="width:100%">
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">كود المهمة (رمزي)</label>
                <input id="m_code" class="input" value="${esc(m.code)}" placeholder="مثال: WORKER-24H" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">الفريق المسؤول</label>
                <select id="m_team" class="input" style="width:100%">
                  ${teams.map(t => `<option value="${t.id}" ${Number(m.teamId) === Number(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">نوع ونمط المهمة</label>
                <select id="m_mode" class="input" style="width:100%">
                  <option value="NORMAL" ${currentMode === 'NORMAL' ? 'selected' : ''}>فترة واحدة (وردية عادية)</option>
                  <option value="MULTI_SHIFT" ${currentMode === 'MULTI_SHIFT' ? 'selected' : ''}>مناوبات متعددة (عدة فترات)</option>
                </select>
              </div>
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">الموقع / النطاق</label>
                <select id="m_loc" class="input" style="width:100%">
                  <option value="outdoor" ${m.locationType === 'outdoor' ? 'selected' : ''}>ميداني (خارجي)</option>
                  <option value="indoor" ${m.locationType === 'indoor' ? 'selected' : ''}>مقر (داخلي)</option>
                </select>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">وقت البداية <span style="color:red">*</span></label>
                <input id="m_start" class="input" value="${esc(m.startTime || '17:00')}" placeholder="17:00" style="width:100%">
              </div>
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">المدة الكلية (بالدقائق)</label>
                <input id="m_dur" type="number" min="1" class="input" value="${m.durationMinutes || 360}" style="width:100%">
              </div>
            </div>

            ${currentMode === 'NORMAL' ? `
              <div>
                <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">عدد السواق المطلوبين للفترة</label>
                <input id="m_single_drivers" type="number" min="1" class="input" value="${m.driversNeeded || 1}" style="width:100%">
              </div>
            ` : `
              <div style="margin-top:6px;padding:12px;background:var(--surface-2);border-radius:10px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                  <b style="font-size:13px;color:var(--text)">⏱ فترات ومناوبات المهمة (${currentPeriods.length})</b>
                  <button type="button" id="btnAddPeriod" class="btn-primary" style="padding:4px 10px;font-size:11px">
                    + إضافة فترة
                  </button>
                </div>

                <div id="periodsContainer" style="display:flex;flex-direction:column;gap:8px">
                  ${currentPeriods.map((p, idx) => `
                    <div class="period-edit-box" data-pidx="${idx}" style="background:var(--surface-card);border:1px solid var(--line);border-radius:8px;padding:10px">
                      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                        <span style="font-weight:700;font-size:12px">فترة #${idx + 1}</span>
                        <button type="button" class="btn-del-period" data-del="${idx}" style="background:transparent;color:var(--danger,#ef4444);border:0;cursor:pointer;font-size:12px">
                          🗑️ حذف
                        </button>
                      </div>
                      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:6px">
                        <div>
                          <label style="font-size:10px;color:var(--text-3);display:block">اسم الفترة</label>
                          <input class="p-name input" value="${esc(p.name)}" placeholder="مثال: وردية الليل" style="padding:4px 6px;font-size:12px">
                        </div>
                        <div>
                          <label style="font-size:10px;color:var(--text-3);display:block">البداية</label>
                          <input class="p-start input" value="${esc(p.startTime)}" placeholder="17:00" style="padding:4px 6px;font-size:12px">
                        </div>
                        <div>
                          <label style="font-size:10px;color:var(--text-3);display:block">المدة (دقائق)</label>
                          <input class="p-dur input" type="number" min="1" value="${p.durationMinutes || 360}" style="padding:4px 6px;font-size:12px">
                        </div>
                        <div>
                          <label style="font-size:10px;color:var(--text-3);display:block">سواق مطلوبين</label>
                          <input class="p-drivers input" type="number" min="1" value="${p.driversNeeded || 1}" style="padding:4px 6px;font-size:12px">
                        </div>
                      </div>
                      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
                        <div>
                          <label style="font-size:10px;color:var(--text-3);display:block">المسار / الرمز (اختياري)</label>
                          <input class="p-track input" value="${esc(p.track || '')}" placeholder="مثال: دورية 1" style="padding:4px 6px;font-size:12px">
                        </div>
                        <div>
                          <label style="font-size:10px;color:var(--text-3);display:block">إزاحة اليوم</label>
                          <select class="p-day input" style="padding:4px 6px;font-size:12px">
                            <option value="0" ${(p.dayOffset || 0) === 0 ? 'selected' : ''}>نفس يوم البدء (0)</option>
                            <option value="1" ${(p.dayOffset || 0) === 1 ? 'selected' : ''}>اليوم التالي (+1)</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            `}

            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">ملاحظات تشغيلية</label>
              <textarea id="m_notes" class="input" rows="2" style="width:100%">${esc(m.notes || '')}</textarea>
            </div>

            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn-primary" id="btnSaveMission" style="flex:1">
                ${missionId ? 'حفظ التعديلات' : 'إضافة المهمة للكتالوج'}
              </button>
              <button class="btn-ghost" id="btnCancelMission" style="flex:1">إلغاء</button>
            </div>
          </div>
        `;

        const collectPeriods = () => {
          if (currentMode !== 'MULTI_SHIFT') return;
          const boxes = body.querySelectorAll('.period-edit-box');
          currentPeriods = Array.from(boxes).map((box, idx) => ({
            id: currentPeriods[idx]?.id || `P-${idx + 1}`,
            code: currentPeriods[idx]?.code || `P-${idx + 1}`,
            name: box.querySelector('.p-name').value.trim() || `فترة ${idx + 1}`,
            startTime: box.querySelector('.p-start').value.trim() || '12:00',
            durationMinutes: Number(box.querySelector('.p-dur').value) || 360,
            driversNeeded: Number(box.querySelector('.p-drivers').value) || 1,
            track: box.querySelector('.p-track').value.trim() || null,
            dayOffset: Number(box.querySelector('.p-day').value) || 0,
            orderIndex: idx
          }));
        };

        body.querySelector('#m_mode').onchange = (e) => {
          collectPeriods();
          currentMode = e.target.value;
          if (currentMode === 'MULTI_SHIFT' && currentPeriods.length === 0) {
            currentPeriods = [
              { id: 'P-1', code: 'P-1', name: 'الفترة 1', startTime: '17:00', durationMinutes: 360, driversNeeded: 1, dayOffset: 0, orderIndex: 0 },
              { id: 'P-2', code: 'P-2', name: 'الفترة 2', startTime: '23:00', durationMinutes: 360, driversNeeded: 1, dayOffset: 0, orderIndex: 1 }
            ];
          }
          renderEditor();
        };

        body.querySelector('#btnAddPeriod')?.addEventListener('click', () => {
          collectPeriods();
          currentPeriods.push({
            id: `P-${currentPeriods.length + 1}`,
            code: `P-${currentPeriods.length + 1}`,
            name: `فترة ${currentPeriods.length + 1}`,
            startTime: '12:00',
            durationMinutes: 360,
            driversNeeded: 1,
            dayOffset: 0,
            track: null,
            orderIndex: currentPeriods.length
          });
          renderEditor();
        });

        body.querySelectorAll('.btn-del-period').forEach(btn => {
          btn.onclick = () => {
            collectPeriods();
            currentPeriods.splice(Number(btn.dataset.del), 1);
            renderEditor();
          };
        });

        body.querySelector('#btnCancelMission').onclick = close;

        body.querySelector('#btnSaveMission').onclick = async () => {
          collectPeriods();
          const name = body.querySelector('#m_name').value.trim();
          const code = body.querySelector('#m_code').value.trim();
          const startTime = body.querySelector('#m_start').value.trim();
          const durationMinutes = Number(body.querySelector('#m_dur').value);
          const locationType = body.querySelector('#m_loc').value;
          const teamId = Number(body.querySelector('#m_team').value) || 1;
          const notes = body.querySelector('#m_notes').value.trim();

          // Validation
          if (!name) return toast('اسم المهمة مطلوب', 2200, 'error');
          if (!/^\d{1,2}:\d{2}$/.test(startTime)) {
            return toast('صيغة وقت البداية غير صالحة (مثال 17:00)', 2200, 'error');
          }
          if (isNaN(durationMinutes) || durationMinutes <= 0) {
            return toast('يجب أن تكون مدة المهمة أكبر من 0', 2200, 'error');
          }

          let finalPeriods = null;
          let driversNeeded = 1;

          if (currentMode === 'MULTI_SHIFT') {
            if (currentPeriods.length === 0) {
              return toast('يجب إضافة فترة واحدة على الأقل في نمط المناوبات', 2200, 'error');
            }
            for (const p of currentPeriods) {
              if (!/^\d{1,2}:\d{2}$/.test(p.startTime)) {
                return toast(`وقت البداية للفترة ${p.name} غير صالح`, 2200, 'error');
              }
              if (Number(p.driversNeeded) <= 0) {
                return toast(`عدد السواق للفترة ${p.name} يجب أن يكون 1 على الأقل`, 2200, 'error');
              }
            }
            finalPeriods = currentPeriods;
            driversNeeded = finalPeriods.reduce((sum, p) => sum + (Number(p.driversNeeded) || 1), 0);
          } else {
            driversNeeded = Number(body.querySelector('#m_single_drivers').value) || 1;
          }

          const payload = {
            name,
            code: code || ('M' + Date.now().toString().slice(-4)),
            startTime,
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
            toast('تم حفظ المهمة بنجاح', 2200, 'success');
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
// Create Occurrence Flow (Requirement 7)
// ═══════════════════════════════════════
export async function openCreateOccurrenceModal(preselectedMissionId = null) {
  requireWrite('occurrence.create');
  const missions = await listMissions(false); // active only
  if (missions.length === 0) {
    return toast('لا توجد مهام نشطة في الكتالوج. أضف مهمة أولاً.', 2500, 'warn');
  }

  sheet({
    title: 'إنشاء تشغيل لمهمة (Occurrence)',
    subtitle: 'ربط تعريف المهمة الدائم بتاريخ تشغيلي محدد',
    builder: (body, close) => {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">اختر المهمة من الكتالوج</label>
            <select id="occ_mission" class="input" style="width:100%">
              ${missions.map(m => `
                <option value="${m.id}" ${Number(preselectedMissionId) === Number(m.id) ? 'selected' : ''}>
                  ${esc(m.name)} (${esc(m.code || 'M' + m.id)}) — ${esc(m.startTime)}
                </option>
              `).join('')}
            </select>
          </div>

          <div>
            <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">تاريخ التشغيل</label>
            <input type="date" id="occ_date" class="input" value="${todayIso()}" style="width:100%">
          </div>

          <div id="occPreview" style="padding:10px;background:var(--surface-2);border-radius:8px;font-size:12px"></div>

          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn-primary" id="btnConfirmOcc" style="flex:1">تأكيد إنشاء التشغيل</button>
            <button class="btn-ghost" id="btnCancelOcc" style="flex:1">إلغاء</button>
          </div>
        </div>
      `;

      const updatePreview = () => {
        const mid = Number(body.querySelector('#occ_mission').value);
        const m = missions.find(x => x.id === mid);
        const date = body.querySelector('#occ_date').value;
        const periods = getMissionPeriods(m);
        const preview = body.querySelector('#occPreview');
        if (!m || !preview) return;

        preview.innerHTML = `
          <div style="font-weight:700;margin-bottom:4px;color:var(--text)">تفاصيل التشغيل:</div>
          <div>التاريخ: <b>${esc(humanDate(date))} (${esc(dayNameAr(date))})</b></div>
          <div>وقت البداية: <b>${esc(m.startTime)}</b> · المدة: <b>${fmtDurShort(m.durationMinutes)}</b></div>
          <div>الفترات: <b>${periods.length} فترات (${periods.reduce((s, p) => s + (p.driversNeeded || 1), 0)} سائق مطلوب)</b></div>
        `;
      };

      body.querySelector('#occ_mission').onchange = updatePreview;
      body.querySelector('#occ_date').onchange = updatePreview;
      updatePreview();

      body.querySelector('#btnCancelOcc').onclick = close;
      body.querySelector('#btnConfirmOcc').onclick = async () => {
        const mid = Number(body.querySelector('#occ_mission').value);
        const date = body.querySelector('#occ_date').value;
        const m = missions.find(x => x.id === mid);
        if (!date) return toast('يرجى تحديد التاريخ', 2200, 'error');

        try {
          const occId = await createOccurrence({
            dateIso: date,
            missionId: mid,
            startTime: m.startTime,
            durationMinutes: m.durationMinutes
          });
          toast(`تم إنشاء تشغيل "${m.name}" بنجاح`, 2200, 'success');
          close();
          refresh();
        } catch (e) {
          toast(e.message, 2500, 'error');
        }
      };
    }
  });
}
