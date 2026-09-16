import { listDrivers, createDriver, updateDriver, setDriverStatus, STATUS, STATUS_AR, STATUS_COLOR, DRIVER_CATEGORY, DRIVER_CATEGORY_AR } from '../domain/drivers.js';
import { listTeams } from '../domain/teams.js';
import { all, get, put } from '../core/db.js';
import { nowIso, todayIso, toMin, fromMinSafe, fmtDurShort, relativeDay, humanDate } from '../core/clock.js';
import { isManager, requireWrite } from '../core/auth.js';
import { sheet, toast, refresh, esc, attachRipple } from './helpers.js';
import { listUnresolved, resolveMissed } from '../domain/missed-turns.js';

let activeCategoryFilter = 'ALL';

export async function renderDriversPage(main) {
  const isMgr = isManager();
  const [drivers, teams, assignments, occurrences, missions, missedTurns, loans] = await Promise.all([
    listDrivers(),
    listTeams(),
    all('assignments'),
    all('occurrences'),
    all('missions'),
    listUnresolved(),
    all('loans')
  ]);

  const teamMap = new Map(teams.map(t => [t.id, t]));
  const missionMap = new Map(missions.map(m => [m.id, m]));
  const occMap = new Map(occurrences.map(o => [o.id, o]));

  const now = new Date();
  const nowDateIso = todayIso();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Compute stats and statuses for each driver
  const driverData = drivers.map(d => {
    const dAsgs = assignments.filter(a =>
      a.status !== 'CANCELLED' &&
      (Number(a.actualDriverId) === Number(d.id) || (!a.actualDriverId && Number(a.plannedDriverId) === Number(d.id)))
    );

    // Sort by startIso
    dAsgs.sort((a, b) => new Date(a.startIso || 0) - new Date(b.startIso || 0));

    // Currently working?
    const currentActiveAsg = dAsgs.find(a => {
      if (!a.startIso || !a.endIso) return false;
      const s = new Date(a.startIso);
      const e = new Date(a.endIso);
      return now >= s && now <= e;
    });

    // Next assignment?
    const nextAsg = dAsgs.find(a => {
      if (!a.startIso) return false;
      return new Date(a.startIso) > now;
    });

    // Past completed assignments
    const pastAsgs = dAsgs.filter(a => {
      if (!a.endIso) return false;
      return new Date(a.endIso) <= now;
    });
    const lastAsg = pastAsgs.length > 0 ? pastAsgs[pastAsgs.length - 1] : null;

    // Rest calculation
    let restMinutes = null;
    let restOk = true;
    if (lastAsg && lastAsg.endIso) {
      restMinutes = Math.floor((now.getTime() - new Date(lastAsg.endIso).getTime()) / 60000);
      if (restMinutes < 480) restOk = false;
    }

    // Week stats
    const weekAsgs = dAsgs.filter(a => a.startIso && a.startIso >= sevenDaysAgo && a.startIso <= nowIso());
    const weekCount = weekAsgs.length;
    const weekMinutes = weekAsgs.reduce((sum, a) => {
      if (a.startIso && a.endIso) return sum + Math.max(0, Math.floor((new Date(a.endIso) - new Date(a.startIso)) / 60000));
      return sum + 360;
    }, 0);

    // Month stats
    const monthAsgs = dAsgs.filter(a => a.startIso && a.startIso >= thirtyDaysAgo && a.startIso <= nowIso());
    const monthCount = monthAsgs.length;
    const monthMinutes = monthAsgs.reduce((sum, a) => {
      if (a.startIso && a.endIso) return sum + Math.max(0, Math.floor((new Date(a.endIso) - new Date(a.startIso)) / 60000));
      return sum + 360;
    }, 0);

    // Borrowed count
    const borrowedCount = dAsgs.filter(a => a.source === 'BORROWED' || Boolean(a.loanId)).length;

    // Missed turns for this driver
    const driverMissed = missedTurns.filter(m => Number(m.driverId) === Number(d.id));

    return {
      driver: d,
      team: teamMap.get(d.teamId),
      currentActiveAsg,
      nextAsg,
      lastAsg,
      restMinutes,
      restOk,
      weekCount,
      weekMinutes,
      monthCount,
      monthMinutes,
      borrowedCount,
      driverMissed,
      currentMission: currentActiveAsg ? missionMap.get(currentActiveAsg.missionId) : null,
      nextMission: nextAsg ? missionMap.get(nextAsg.missionId) : null,
      lastMission: lastAsg ? missionMap.get(lastAsg.missionId) : null
    };
  });

  // Filter by category
  const filteredDriverData = driverData.filter(item => {
    if (activeCategoryFilter === 'ALL') return true;
    const cat = item.driver.category || DRIVER_CATEGORY.LIGHT;
    return cat === activeCategoryFilter || cat === DRIVER_CATEGORY.ALL;
  });

  main.innerHTML = `
    <div class="datebar" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:20px">👥</span>
        <div>
          <h2 style="font-size:16px;font-weight:800;margin:0;color:var(--text)">قائمة السواق والجاهزية</h2>
          <span style="font-size:11px;color:var(--text-3)">${drivers.length} سائق مسجل في الفرق</span>
        </div>
      </div>
      ${isMgr ? `
        <button class="btn-primary" id="btnNewDriver" style="padding:6px 14px;font-size:12px;font-weight:700">
          + إضافة سائق جديد
        </button>
      ` : ''}
    </div>

    ${isMgr ? '' : '<div class="readonly-banner">📖 عرض فقط — لا يمكنك تعديل بيانات أو حالات السواق</div>'}

    <!-- Driver Category Filters -->
    <div class="filter-chips-row" style="margin-bottom:12px">
      <button type="button" class="filter-pill ${activeCategoryFilter === 'ALL' ? 'active' : ''}" data-cat-filter="ALL">
        👥 جميع السواق (${drivers.length})
      </button>
      <button type="button" class="filter-pill ${activeCategoryFilter === DRIVER_CATEGORY.LIGHT ? 'active' : ''}" data-cat-filter="${DRIVER_CATEGORY.LIGHT}">
        🚗 سواق وزن خفيف (${drivers.filter(d => (d.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.LIGHT).length})
      </button>
      <button type="button" class="filter-pill ${activeCategoryFilter === DRIVER_CATEGORY.SHARED ? 'active' : ''}" data-cat-filter="${DRIVER_CATEGORY.SHARED}">
        🚌 سواق نقل مشترك (${drivers.filter(d => d.category === DRIVER_CATEGORY.SHARED).length})
      </button>
    </div>

    <div class="section" id="driversListSection">
      <div class="section-body" style="padding-top:4px">
        ${filteredDriverData.length === 0 ? `
          <div class="empty-block">
            <div class="ic">👤</div>
            <h3>لا يوجد سواق مطابقين للتصنيف المحدد</h3>
            ${isMgr ? '<p>اضغط "+ إضافة سائق جديد" للبدء</p>' : ''}
          </div>
        ` : filteredDriverData.map(item => renderDriverFullCard(item, isMgr)).join('')}
      </div>
    </div>
  `;

  main.querySelectorAll('[data-cat-filter]').forEach(btn => {
    btn.onclick = () => {
      activeCategoryFilter = btn.dataset.catFilter;
      renderDriversPage(main);
    };
  });

  // Attach event handlers
  main.querySelector('#btnNewDriver')?.addEventListener('click', () => openDriverEditorModal());

  main.querySelectorAll('[data-edit-driver-status]').forEach(select => {
    select.onchange = async () => {
      const drId = Number(select.dataset.editDriverStatus);
      const newStatus = select.value;
      try {
        await setDriverStatus(drId, newStatus, 'تحديث الحالة من شاشة السواق');
        toast('تم تحديث حالة السائق', 2000, 'success');
        refresh();
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('[data-edit-driver-btn]').forEach(btn => {
    btn.onclick = () => openDriverEditorModal(Number(btn.dataset.editDriverBtn));
  });

  main.querySelectorAll('[data-resolve-missed-btn]').forEach(btn => {
    btn.onclick = async () => {
      const mid = Number(btn.dataset.resolveMissedBtn);
      try {
        await resolveMissed(mid);
        toast('تمت استعادة الدور وتسوية السجل بنجاح', 2200, 'success');
        refresh();
      } catch (e) {
        toast(e.message, 2500, 'error');
      }
    };
  });

  main.querySelectorAll('.btn-primary, .btn-ghost, .tag').forEach(attachRipple);
}

function renderDriverFullCard(item, isMgr) {
  const {
    driver: d, team, currentActiveAsg, nextAsg, lastAsg,
    restMinutes, restOk, weekCount, weekMinutes,
    monthCount, monthMinutes, borrowedCount, driverMissed,
    currentMission, nextMission, lastMission
  } = item;

  const isAvailable = d.status === STATUS.AVAILABLE;
  const isVacation = d.status === STATUS.VACATION;
  const isSick = d.status === STATUS.SICK;

  return `
    <div class="driver-full-card" style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px">
      <!-- Top Row: Avatar, Name, Phone, Team, Status -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="av ${isAvailable ? 'ok' : isVacation ? 'sub' : 'muted'}" style="width:42px;height:42px;font-size:16px;font-weight:900">
            ${esc(d.name.charAt(0))}
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <h3 style="margin:0;font-size:15px;font-weight:800;color:var(--text)">${esc(d.name)}</h3>
              <span class="tag ${(d.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.SHARED ? 'cat-shared' : 'cat-light'}" style="font-size:10px">
                ${(d.category || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.SHARED ? '🚌 نقل مشترك' : (d.category === DRIVER_CATEGORY.ALL ? '🌟 شامل' : '🚗 وزن خفيف')}
              </span>
              ${team ? `
                <span class="tag" style="background:${esc(team.color || '#3b82f6')}22;color:${esc(team.color || '#3b82f6')};font-size:11px;font-weight:700">
                  ${esc(team.name)}
                </span>
              ` : ''}
              ${d.phone ? `<span style="font-size:11px;color:var(--text-3);direction:ltr">📞 ${esc(d.phone)}</span>` : ''}
            </div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px">
              معرف: #${d.id} · المصدر: فرقة السواق
            </div>
          </div>
        </div>

        <!-- Status Pill or Selector -->
        <div>
          ${isMgr ? `
            <select data-edit-driver-status="${d.id}" class="input" style="padding:4px 8px;font-size:11px;font-weight:700;border-radius:8px">
              <option value="AVAILABLE" ${d.status === 'AVAILABLE' ? 'selected' : ''}>🟢 متاح للعمل</option>
              <option value="VACATION" ${d.status === 'VACATION' ? 'selected' : ''}>🏖️ في عطلة / إجازة</option>
              <option value="SICK" ${d.status === 'SICK' ? 'selected' : ''}>🩺 عجز طبي / مريض</option>
              <option value="UNAVAILABLE" ${d.status === 'UNAVAILABLE' ? 'selected' : ''}>⚪ غير متاح مؤقتاً</option>
            </select>
          ` : `
            <span class="tag ${STATUS_COLOR[d.status] || ''}" style="font-weight:700;font-size:11px">
              ${esc(STATUS_AR[d.status] || d.status)}
            </span>
          `}
        </div>
      </div>

      <!-- Live Operational Status: Working Now / Next Mission -->
      <div style="margin-top:10px;padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:12px;display:flex;flex-direction:column;gap:6px">
        <!-- Working Now -->
        <div>
          ${currentActiveAsg ? `
            <div style="color:var(--ok,#10b981);font-weight:700;display:flex;align-items:center;gap:6px">
              <span>🟢 يعمل الآن في:</span>
              <span>${esc(currentMission?.name || 'مهمة')}</span>
              ${currentActiveAsg.periodName ? `<span>— ${esc(currentActiveAsg.periodName)}</span>` : ''}
              <span style="color:var(--text-3);font-size:11px;font-weight:normal">(حتى ${esc(currentActiveAsg.endIso ? currentActiveAsg.endIso.slice(11, 16) : '')})</span>
            </div>
          ` : `
            <div style="color:var(--text-3)">
              ⚪ لا يقود أي مهمة في هذه اللحظة
            </div>
          `}
        </div>

        <!-- Next Scheduled -->
        <div>
          ${nextAsg ? `
            <div style="color:var(--text);font-size:11px">
              ⏳ <b>المهمة القادمة:</b> ${esc(nextMission?.name || 'مهمة')}
              ${nextAsg.periodName ? `— ${esc(nextAsg.periodName)}` : ''}
              في <b>${esc(nextAsg.startIso ? nextAsg.startIso.slice(0, 10) : '')} ${esc(nextAsg.startIso ? nextAsg.startIso.slice(11, 16) : '')}</b>
            </div>
          ` : `
            <div style="color:var(--text-3);font-size:11px">
              ⏳ لا توجد مهمة قادمة مجدولة
            </div>
          `}
        </div>
      </div>

      <!-- Rest Hours & Rest Indicator -->
      <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:12px;background:var(--surface-card);padding:6px 8px;border:1px solid var(--line);border-radius:6px;flex-wrap:wrap;gap:6px">
        <div>
          <span>آخر مهمة: </span>
          <b>${lastAsg ? `${esc(lastMission?.name || 'مهمة')} (${relativeDay(lastAsg.endIso?.slice(0, 10))})` : 'لم ينفذ مهام سابقة'}</b>
          ${restMinutes !== null ? ` · مدة الراحة: <b>${fmtDurShort(restMinutes)}</b>` : ''}
        </div>
        <div>
          ${restMinutes !== null ? `
            <span class="tag ${restOk ? 'ok' : 'warn'}" style="font-weight:700;font-size:10px">
              ${restOk ? '✅ الراحة كافية (أكثر من 8 ساعات)' : '⚠️ راحة غير كافية (أقل من 8 ساعات)'}
            </span>
          ` : '<span class="tag" style="font-size:10px">راحة غير مقيدة</span>'}
        </div>
      </div>

      <!-- Activity Statistics (This Week & This Month & Loans) -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(100px, 1fr));gap:6px;margin-top:8px;font-size:11px;text-align:center">
        <div style="background:var(--surface-2);padding:6px;border-radius:6px">
          <div style="color:var(--text-3)">هذا الأسبوع</div>
          <div style="font-weight:800;font-size:13px;color:var(--text);margin-top:2px">
            ${weekCount} مهام (${fmtDurShort(weekMinutes)})
          </div>
        </div>
        <div style="background:var(--surface-2);padding:6px;border-radius:6px">
          <div style="color:var(--text-3)">هذا الشهر</div>
          <div style="font-weight:800;font-size:13px;color:var(--text);margin-top:2px">
            ${monthCount} مهام (${fmtDurShort(monthMinutes)})
          </div>
        </div>
        <div style="background:var(--surface-2);padding:6px;border-radius:6px">
          <div style="color:var(--text-3)">مهام مستعارة</div>
          <div style="font-weight:800;font-size:13px;color:var(--accent);margin-top:2px">
            ${borrowedCount} استعارة
          </div>
        </div>
      </div>

      <!-- Missed Turns & Reclaim Priority -->
      ${driverMissed.length > 0 ? `
        <div style="margin-top:10px;padding:8px 10px;background:var(--warn,#f59e0b)16;border:1px dashed var(--warn,#f59e0b)55;border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
            <div style="font-size:12px;color:var(--text)">
              ⚠️ <b>أدوار فائتة مستحقة (${driverMissed.length}):</b>
              <div style="font-size:11px;color:var(--text-2);margin-top:2px">
                له دور فائت مستحق الاسترجاع بموجب أولوية Reclaim.
              </div>
            </div>
            ${isMgr ? `
              <button class="tag ok" data-resolve-missed-btn="${driverMissed[0].id}" style="cursor:pointer;border:0;font-weight:700;padding:4px 10px">
                🔄 استعادة وتسوية الدور
              </button>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Edit Driver Action -->
      ${isMgr ? `
        <div style="margin-top:10px;display:flex;justify-content:flex-end">
          <button class="btn-ghost" data-edit-driver-btn="${d.id}" style="padding:4px 10px;font-size:11px">
            ✏️ تعديل بيانات السائق
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════
// Add / Edit Driver Modal
// ═══════════════════════════════════════
export async function openDriverEditorModal(driverId = null) {
  requireWrite('driver.edit');
  const [existingDriver, teams] = await Promise.all([
    driverId ? get('drivers', Number(driverId)) : null,
    listTeams()
  ]);

  const d = existingDriver || {
    name: '',
    phone: '',
    category: DRIVER_CATEGORY.LIGHT,
    teamId: teams[0]?.id || 1,
    status: 'AVAILABLE'
  };

  let selectedCat = d.category || DRIVER_CATEGORY.LIGHT;

  sheet({
    title: driverId ? 'تعديل بيانات السائق' : 'إضافة سائق جديد',
    subtitle: driverId ? `تعديل السائق: ${d.name}` : 'تسجيل سائق جديد في فرقة السواق',
    builder: (body, close) => {
      const renderModal = () => {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">اسم السائق الكامل <span style="color:red">*</span></label>
              <input id="dr_name" class="input" value="${esc(d.name)}" placeholder="مثال: أحمد محمد" style="width:100%">
            </div>

            <!-- Driver Category Selection -->
            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px">صنف السائق (نوع الرخصة والمركبات)</label>
              <div class="segment-group" id="driverCatSegment">
                <button type="button" class="segment-btn ${selectedCat === DRIVER_CATEGORY.LIGHT ? 'active accent-light' : ''}" data-cat="${DRIVER_CATEGORY.LIGHT}">
                  <span>🚗</span>
                  <span>وزن خفيف</span>
                </button>
                <button type="button" class="segment-btn ${selectedCat === DRIVER_CATEGORY.SHARED ? 'active accent-shared' : ''}" data-cat="${DRIVER_CATEGORY.SHARED}">
                  <span>🚌</span>
                  <span>نقل مشترك</span>
                </button>
                <button type="button" class="segment-btn ${selectedCat === DRIVER_CATEGORY.ALL ? 'active' : ''}" data-cat="${DRIVER_CATEGORY.ALL}">
                  <span>🌟</span>
                  <span>شامل</span>
                </button>
              </div>
            </div>

            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">رقم الهاتف (للتواصل)</label>
              <input id="dr_phone" class="input" value="${esc(d.phone || '')}" placeholder="0550112233" style="width:100%">
            </div>

            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">الفرقة / الفريق التابع له</label>
              <select id="dr_team" class="input" style="width:100%">
                ${teams.map(t => `<option value="${t.id}" ${Number(d.teamId) === Number(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              </select>
            </div>

            <div>
              <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px">الحالة التشغيلية</label>
              <select id="dr_status" class="input" style="width:100%">
                <option value="AVAILABLE" ${d.status === 'AVAILABLE' ? 'selected' : ''}>🟢 متاح للعمل</option>
                <option value="VACATION" ${d.status === 'VACATION' ? 'selected' : ''}>🏖️ في عطلة / إجازة</option>
                <option value="SICK" ${d.status === 'SICK' ? 'selected' : ''}>🩺 عجز طبي / مريض</option>
                <option value="UNAVAILABLE" ${d.status === 'UNAVAILABLE' ? 'selected' : ''}>⚪ غير متاح مؤقتاً</option>
              </select>
            </div>

            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn-primary" id="btnSaveDriver" style="flex:1">
                ${driverId ? 'حفظ التعديلات' : 'إضافة السائق'}
              </button>
              <button class="btn-ghost" id="btnCancelDriver" style="flex:1">إلغاء</button>
            </div>
          </div>
        `;

        body.querySelectorAll('#driverCatSegment .segment-btn').forEach(btn => {
          btn.onclick = () => {
            selectedCat = btn.dataset.cat;
            d.name = body.querySelector('#dr_name')?.value || d.name;
            d.phone = body.querySelector('#dr_phone')?.value || d.phone;
            d.teamId = Number(body.querySelector('#dr_team')?.value) || d.teamId;
            d.status = body.querySelector('#dr_status')?.value || d.status;
            renderModal();
          };
        });

        body.querySelector('#btnCancelDriver').onclick = close;
        body.querySelector('#btnSaveDriver').onclick = async () => {
          const name = body.querySelector('#dr_name').value.trim();
          const phone = body.querySelector('#dr_phone').value.trim();
          const teamId = Number(body.querySelector('#dr_team').value) || 1;
          const status = body.querySelector('#dr_status').value;
          const category = selectedCat;

          if (!name) return toast('اسم السائق مطلوب', 2200, 'error');

          try {
            if (driverId) {
              await updateDriver(driverId, { name, phone, teamId, status, category });
              toast('تم تحديث بيانات السائق بنجاح', 2200, 'success');
            } else {
              await createDriver({ name, phone, teamId, status, category });
              toast(`تمت إضافة ${esc(name)} بنجاح`, 2200, 'success');
            }
            close();
            refresh();
          } catch (e) {
            toast(e.message, 2500, 'error');
          }
        };
      };

      renderModal();
    }
  });
}
