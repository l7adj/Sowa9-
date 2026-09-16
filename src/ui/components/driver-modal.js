import { sheet, toast, esc, refresh } from '../helpers.js';
import { listDrivers, getDriver, setDriverStatus, STATUS, STATUS_AR, DRIVER_CATEGORY, DRIVER_CATEGORY_AR } from '../../domain/drivers.js';
import { listMissions, getMissionPeriods } from '../../domain/missions.js';
import { listByDate } from '../../domain/occurrences.js';
import { listByOccurrence, createProposal, ASG_STATUS } from '../../domain/assignments.js';
import { getQueue, statsOf, dueOf } from '../../domain/turns.js';
import { restBefore, driverIntervals, hasConflict } from '../../domain/rest.js';
import { listTeams } from '../../domain/teams.js';
import { fmtDurShort, toMin, fromMinSafe, buildStart, addMin, addDays, nowIso, humanDate, formatTimeHhmm } from '../../core/clock.js';
import { getSetting, isManager } from '../../core/auth.js';

/**
 * Open interactive driver picker sheet for a specific mission period slot
 */
export async function openDriverPickerSheet({
  mission,
  period,
  occurrence,
  currentDate,
  startIso,
  endIso,
  initialCategory = null,
  onSelected
}) {
  const reqCategory = initialCategory || period?.driverCategory || mission?.driverCategory || DRIVER_CATEGORY.LIGHT;
  const pName = period?.name || 'فترة التكليف';
  const pCode = period?.code || period?.id || 'DEFAULT';

  sheet({
    title: `👤 اختيار وتعيين سائق للمهمة`,
    subtitle: `${mission.name} · ${pName} (${reqCategory === DRIVER_CATEGORY.SHARED ? 'مطلوب: نقل مشترك 🚌' : 'مطلوب: وزن خفيف 🚗'})`,
    builder: async (body, close) => {
      body.innerHTML = `
        <div style="padding:4px 0 16px">
          <!-- Loading State -->
          <div style="text-align:center;padding:24px;color:var(--text-3)">
            <div style="font-size:28px;margin-bottom:8px">⏳</div>
            <div style="font-size:13px;font-weight:700">جارٍ فحص جاهزية السواق، الأدوار، والنقاهة...</div>
          </div>
        </div>
      `;

      try {
        const [drivers, teams, asgs, queueRecord] = await Promise.all([
          listDrivers(),
          listTeams(),
          listByOccurrence(occurrence.id),
          getQueue(mission.id, pCode)
        ]);

        const teamMap = new Map(teams.map(t => [t.id, t]));
        const assignedDriverIds = new Set(
          asgs.filter(a => a.status !== ASG_STATUS.CANCELLED && (a.periodId === pCode || a.periodCode === pCode))
            .map(a => a.actualDriverId || a.plannedDriverId)
            .filter(Boolean)
        );

        const startDate = startIso ? new Date(startIso) : new Date();
        const endDate = endIso ? new Date(endIso) : new Date(startDate.getTime() + 6 * 3600 * 1000);
        const restMinHours = await getSetting('restMinHours') || 8;
        const restMinMinutes = restMinHours * 60;
        const now = new Date();

        // Evaluate all drivers
        const evaluatedDrivers = [];
        for (const d of drivers) {
          const cat = d.category || DRIVER_CATEGORY.LIGHT;
          const isCategoryMatch = (reqCategory === 'ALL' || cat === 'ALL' || cat === reqCategory);
          const alreadyAssigned = assignedDriverIds.has(d.id);

          // Rest status
          const rest = await restBefore(d.id, startDate);
          const conflict = await hasConflict(d.id, startDate, endDate);

          // Check if driver is currently active in any mission right now
          const iv = await driverIntervals(d.id);
          const currentShift = iv.find(x => x.start <= now && now < x.end);

          // Rotation/Queue status
          const queue = queueRecord?.queue || [];
          const posInQueue = queue.indexOf(d.id);
          const isDue = posInQueue === 0;

          let restRemainingMins = 0;
          let restOk = true;
          let lastEndStr = null;

          if (rest) {
            restOk = rest.minutes >= restMinMinutes;
            if (!restOk) {
              restRemainingMins = restMinMinutes - rest.minutes;
            }
            if (rest.last?.end) {
              lastEndStr = rest.last.end.toTimeString().slice(0, 5);
            }
          }

          evaluatedDrivers.push({
            driver: d,
            team: teamMap.get(d.teamId),
            category: cat,
            isCategoryMatch,
            alreadyAssigned,
            isDue,
            posInQueue,
            rest,
            restOk,
            restRemainingMins,
            lastEndStr,
            conflict,
            currentShift,
            counts: queueRecord?.counts?.[d.id] || 0
          });
        }

        let activeTab = initialCategory === DRIVER_CATEGORY.SHARED ? 'SHARED' : initialCategory === DRIVER_CATEGORY.LIGHT ? 'LIGHT' : 'RECOMMENDED';
        let searchQuery = '';

        function renderList() {
          const lightCount = evaluatedDrivers.filter(e => e.category === DRIVER_CATEGORY.LIGHT).length;
          const sharedCount = evaluatedDrivers.filter(e => e.category === DRIVER_CATEGORY.SHARED).length;

          // Filter by Tab
          let filtered = evaluatedDrivers.filter(e => {
            if (e.alreadyAssigned) return false;
            if (activeTab === 'RECOMMENDED') {
              // Recommended: category match, available or due, not blocked by hard conflict
              return e.isCategoryMatch && e.driver.status === STATUS.AVAILABLE && !e.conflict;
            }
            if (activeTab === 'LIGHT') return e.category === DRIVER_CATEGORY.LIGHT;
            if (activeTab === 'SHARED') return e.category === DRIVER_CATEGORY.SHARED;
            return true;
          });

          // Filter by Search
          if (searchQuery) {
            filtered = filtered.filter(e =>
              e.driver.name.toLowerCase().includes(searchQuery) ||
              (e.driver.phone && e.driver.phone.includes(searchQuery))
            );
          }

          // Sort: Due first, then Available, then by position in queue
          filtered.sort((a, b) => {
            if (a.isDue && !b.isDue) return -1;
            if (!a.isDue && b.isDue) return 1;
            if (a.driver.status === STATUS.AVAILABLE && b.driver.status !== STATUS.AVAILABLE) return -1;
            if (a.driver.status !== STATUS.AVAILABLE && b.driver.status === STATUS.AVAILABLE) return 1;
            if (a.restOk && !b.restOk) return -1;
            if (!a.restOk && b.restOk) return 1;
            if (a.posInQueue !== -1 && b.posInQueue !== -1) return a.posInQueue - b.posInQueue;
            return 0;
          });

          body.innerHTML = `
            <!-- Context Header -->
            <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="font-size:18px">${reqCategory === DRIVER_CATEGORY.SHARED ? '🚌' : '🚗'}</span>
                  <div>
                    <div style="font-size:13px;font-weight:900;color:var(--text)">${esc(mission.name)} — ${esc(pName)}</div>
                    <div style="font-size:11px;color:var(--text-3)">التوقيت: ${startIso ? new Date(startIso).toTimeString().slice(0, 5) : '08:00'} إلى ${endIso ? new Date(endIso).toTimeString().slice(0, 5) : '16:00'}</div>
                  </div>
                </div>
                <span class="${reqCategory === DRIVER_CATEGORY.SHARED ? 'badge-cat-transport' : 'badge-cat-leger'}">
                  ${reqCategory === DRIVER_CATEGORY.SHARED ? 'مطلوب: نقل مشترك 🚌' : 'مطلوب: وزن خفيف 🚗'}
                </span>
              </div>
            </div>

            <!-- Tab Switcher -->
            <div class="modal-nav-tabs">
              <button type="button" class="modal-nav-tab ${activeTab === 'RECOMMENDED' ? 'active' : ''}" data-tab="RECOMMENDED">
                <span>⭐ المستحق والموصى بهم</span>
              </button>
              <button type="button" class="modal-nav-tab ${activeTab === 'LIGHT' ? 'active' : ''}" data-tab="LIGHT">
                <span>🚗 وزن خفيف Léger (${lightCount})</span>
              </button>
              <button type="button" class="modal-nav-tab ${activeTab === 'SHARED' ? 'active' : ''}" data-tab="SHARED">
                <span>🚌 نقل مشترك Transport (${sharedCount})</span>
              </button>
              <button type="button" class="modal-nav-tab ${activeTab === 'ALL' ? 'active' : ''}" data-tab="ALL">
                <span>👥 الكل (${evaluatedDrivers.length})</span>
              </button>
            </div>

            <!-- Search Filter -->
            <div style="margin-bottom:12px">
              <input type="text" id="driverPickerSearch" placeholder="🔍 بحث باسم السائق أو رقم الهاتف..." value="${esc(searchQuery)}" class="input" style="width:100%;font-size:12px;padding:9px 12px;border-radius:10px">
            </div>

            <!-- Driver List -->
            <div style="max-height:55vh;overflow-y:auto;padding-right:2px">
              ${filtered.length === 0 ? `
                <div style="text-align:center;padding:32px 16px;color:var(--text-3);background:var(--surface-2);border-radius:12px">
                  <div style="font-size:32px;margin-bottom:8px">🔍</div>
                  <div style="font-size:14px;font-weight:800;color:var(--text)">لا يوجد سواق مطابقون لهذا المعيار</div>
                  <div style="font-size:12px;margin-top:4px">جرّب اختيار تبويب "الكل" أو تغيير كلمات البحث</div>
                </div>
              ` : filtered.map(item => renderDriverOptionCard(item, reqCategory)).join('')}
            </div>
          `;

          // Event Listeners
          body.querySelectorAll('[data-tab]').forEach(btn => {
            btn.onclick = () => {
              activeTab = btn.dataset.tab;
              renderList();
            };
          });

          const searchInput = body.querySelector('#driverPickerSearch');
          if (searchInput) {
            searchInput.focus();
            searchInput.oninput = (e) => {
              searchQuery = e.target.value.toLowerCase().trim();
              renderList();
            };
          }

          // Selecting a Driver
          body.querySelectorAll('[data-select-driver]').forEach(card => {
            card.onclick = async () => {
              const driverId = Number(card.dataset.selectDriver);
              const item = evaluatedDrivers.find(e => e.driver.id === driverId);
              if (!item) return;

              // Confirm if warning exists
              let needsConfirm = false;
              let confirmMsg = '';

              if (!item.isCategoryMatch) {
                needsConfirm = true;
                confirmMsg = `تنبيه صنف السائق: السائق من صنف (${item.category === DRIVER_CATEGORY.SHARED ? 'نقل مشترك' : 'وزن خفيف'}) والمهمة تطلب (${reqCategory === DRIVER_CATEGORY.SHARED ? 'نقل مشترك' : 'وزن خفيف'}). هل تريد التكليف كاستعارة بين الفرق؟`;
              } else if (!item.restOk) {
                needsConfirm = true;
                confirmMsg = `تنبيه النقاهة: السائق في فترة راحة ونقاهة (متبقي ${fmtDurShort(item.restRemainingMins)}). هل تريد التكليف كاستثناء قيادي؟`;
              } else if (item.conflict) {
                needsConfirm = true;
                confirmMsg = `تنبيه تعارض زمني: السائق مرتبط بمهمة أخرى في نفس الوقت تقريباً. هل تريد تأكيد التكليف؟`;
              } else if (item.driver.status !== STATUS.AVAILABLE) {
                needsConfirm = true;
                confirmMsg = `السائق حالته الحالية: (${STATUS_AR[item.driver.status] || item.driver.status}). هل تريد تكليفه استثنائياً؟`;
              }

              if (needsConfirm) {
                const existingBanner = body.querySelector('#pickerConfirmBanner');
                if (existingBanner) existingBanner.remove();

                const banner = document.createElement('div');
                banner.id = 'pickerConfirmBanner';
                banner.style.cssText = 'position:sticky;top:0;z-index:30;background:#fffbeb;border:2px solid #f59e0b;padding:12px;border-radius:10px;margin-bottom:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15)';
                banner.innerHTML = `
                  <div style="font-size:12px;font-weight:900;color:#92400e;margin-bottom:8px">⚠️ تنبيه قبل التكليف:</div>
                  <div style="font-size:12px;color:#78350f;margin-bottom:10px">${esc(confirmMsg)}</div>
                  <div style="display:flex;justify-content:flex-end;gap:8px">
                    <button type="button" class="btn-ghost btn-cancel-confirm" style="padding:6px 12px;font-size:11px">تراجع</button>
                    <button type="button" class="btn-primary btn-proceed-confirm" style="padding:6px 14px;font-size:11px;font-weight:900;background:#d97706;color:#fff">تأكيد التكليف الاستثنائي</button>
                  </div>
                `;

                body.querySelector('#pickerContainer').prepend(banner);
                banner.querySelector('.btn-cancel-confirm').onclick = () => banner.remove();
                banner.querySelector('.btn-proceed-confirm').onclick = async () => {
                  banner.remove();
                  await executeAssign();
                };
                return;
              }

              await executeAssign();

              async function executeAssign() {
                try {
                  card.style.opacity = '0.5';
                  card.style.pointerEvents = 'none';

                  await createProposal({
                    occurrenceId: occurrence.id,
                    missionId: mission.id,
                    periodId: pCode,
                    periodCode: pCode,
                    dueDriverId: item.isDue ? item.driver.id : (queueRecord?.queue?.[0] || item.driver.id),
                    plannedDriverId: item.driver.id,
                    startIso,
                    endIso,
                    rationale: item.isDue ? 'تكليف المستحق بالدور' : 'اختيار مباشر من قائد الفرقة',
                    replacementReason: item.isCategoryMatch ? 'تعيين مباشر' : 'استعارة بين الفرق',
                    autoConfirm: true
                  });

                  toast(`تم تعيين السائق ${item.driver.name} بنجاح!`, 2200, 'success');
                  close();
                  refresh();
                  if (onSelected) onSelected(item.driver);
                } catch (err) {
                  toast(err.message, 2500, 'error');
                  card.style.opacity = '1';
                  card.style.pointerEvents = 'auto';
                }
              }
            };
          });
        }

        renderList();
      } catch (err) {
        body.innerHTML = `
          <div style="padding:20px;text-align:center;color:var(--danger)">
            <p>حدث خطأ أثناء تحميل بيانات السواق: ${esc(err.message)}</p>
          </div>
        `;
      }
    }
  });
}

function renderDriverOptionCard(item, reqCategory) {
  const { driver, category, isCategoryMatch, isDue, posInQueue, rest, restOk, restRemainingMins, lastEndStr, conflict, currentShift, counts } = item;
  const isAvail = driver.status === STATUS.AVAILABLE;
  const hasWarning = !isCategoryMatch || !restOk || conflict || !isAvail;

  return `
    <div class="driver-select-card ${isDue ? 'is-due' : ''} ${hasWarning ? 'has-warning' : ''}" data-select-driver="${driver.id}">
      <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1">
        <!-- Avatar -->
        <div style="width:40px;height:40px;border-radius:10px;background:${category === DRIVER_CATEGORY.SHARED ? 'linear-gradient(135deg,#047857,#059669)' : 'linear-gradient(135deg,#1d4ed8,#2563eb)'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;flex-shrink:0">
          ${esc(driver.name.charAt(0))}
        </div>

        <!-- Details -->
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:800;color:var(--text)">${esc(driver.name)}</span>
            
            <span class="${category === DRIVER_CATEGORY.SHARED ? 'badge-cat-transport' : 'badge-cat-leger'}">
              ${category === DRIVER_CATEGORY.SHARED ? '🚌 نقل مشترك' : '🚗 وزن خفيف'}
            </span>

            ${isDue ? `
              <span class="badge-status-due">
                <span class="pulse-dot amber"></span>
                <span>⭐ دوره الآن (#1)</span>
              </span>
            ` : posInQueue >= 0 ? `
              <span style="font-size:10px;font-weight:800;background:var(--surface-2);color:var(--text-3);padding:2px 6px;border-radius:5px">
                ترتيبه بالدور: #${posInQueue + 1}
              </span>
            ` : ''}
          </div>

          <!-- Status & Rest Badges -->
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;font-size:11px">
            ${currentShift ? `
              <span class="badge-status-driving">
                <span class="pulse-dot blue"></span>
                <span>يقود حالياً بالميدان</span>
              </span>
            ` : !isAvail ? `
              <span class="badge-status-rest">
                <span class="pulse-dot red"></span>
                <span>${STATUS_AR[driver.status] || driver.status}</span>
              </span>
            ` : !restOk ? `
              <span class="badge-status-rest">
                <span class="pulse-dot amber"></span>
                <span>في نقاهة (متبقي ${fmtDurShort(restRemainingMins)})</span>
              </span>
            ` : rest ? `
              <span class="badge-status-ready">
                <span class="pulse-dot green"></span>
                <span>أتم الراحة (استراح ${fmtDurShort(rest.minutes)})</span>
              </span>
            ` : `
              <span class="badge-status-ready">
                <span class="pulse-dot green"></span>
                <span>جاهز ومتاح</span>
              </span>
            `}

            ${lastEndStr ? `
              <span style="color:var(--text-3)">· آخر انتهاء: ${lastEndStr}</span>
            ` : ''}

            ${counts > 0 ? `
              <span style="color:var(--text-3)">· نَفّذ: ${counts} مهمة</span>
            ` : ''}
          </div>

          ${!isCategoryMatch ? `
            <div style="font-size:10px;color:#d97706;font-weight:700;margin-top:3px">
              ⚠️ صنف السائق مختلف عن المطلوب (سيعتبر استعارة بين الفرق)
            </div>
          ` : ''}

          ${conflict ? `
            <div style="font-size:10px;color:#ef4444;font-weight:700;margin-top:3px">
              ⚠️ تعارض زمني مع مهمة مجدولة أخرى
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Action -->
      <div>
        <button type="button" class="btn-primary" style="padding:8px 14px;font-size:12px;font-weight:800;border-radius:8px;background:${isDue ? '#f59e0b' : hasWarning ? 'var(--surface-3)' : 'var(--color-accent)'};color:${isDue ? '#000' : hasWarning ? 'var(--text)' : '#fff'}">
          ${isDue ? 'تكليف المستحق ⚡' : 'اختيار ✓'}
        </button>
      </div>
    </div>
  `;
}

/**
 * Open Driver Live Dossier/Profile Sheet (Clicking ANY driver name anywhere!)
 */
export async function openDriverProfileSheet(driverId, currentDate) {
  sheet({
    title: `👤 بطاقة السائق ومعاينة حالته المباشرة`,
    subtitle: `فحص الوضع الميداني، النقاهة، والأدوار`,
    builder: async (body, close) => {
      body.innerHTML = `
        <div style="text-align:center;padding:24px;color:var(--text-3)">
          <div style="font-size:28px;margin-bottom:8px">⏳</div>
          <div style="font-size:13px;font-weight:700">جارٍ قراءة ملف وسجل السائق الميداني...</div>
        </div>
      `;

      try {
        const [driver, teams, missions, occurrences] = await Promise.all([
          getDriver(driverId),
          listTeams(),
          listMissions(true),
          listByDate(currentDate || humanDate())
        ]);

        if (!driver) {
          body.innerHTML = `<p style="padding:20px;text-align:center">السائق غير موجود</p>`;
          return;
        }

        const team = teams.find(t => t.id === driver.teamId);
        const missionMap = new Map(missions.map(m => [m.id, m]));

        // Calculate driver intervals & rest
        const now = new Date();
        const iv = await driverIntervals(driver.id);
        const currentShift = iv.find(x => x.start <= now && now < x.end);
        const rest = await restBefore(driver.id, now);
        const restMinHours = await getSetting('restMinHours') || 8;
        const restMinMinutes = restMinHours * 60;

        let isResting = false;
        let restRemainingMins = 0;
        if (rest && rest.minutes < restMinMinutes && !currentShift) {
          isResting = true;
          restRemainingMins = restMinMinutes - rest.minutes;
        }

        // Today's assignments
        const todayAssignments = [];
        for (const occ of occurrences) {
          const asgs = await listByOccurrence(occ.id);
          for (const a of asgs) {
            if ((a.actualDriverId === driver.id || a.plannedDriverId === driver.id) && a.status !== ASG_STATUS.CANCELLED) {
              todayAssignments.push({
                assignment: a,
                occurrence: occ,
                mission: missionMap.get(occ.missionId)
              });
            }
          }
        }

        // Rotations across all missions
        const queuePositions = [];
        for (const m of missions) {
          const q = await getQueue(m.id);
          if (q && q.queue && q.queue.includes(driver.id)) {
            const pos = q.queue.indexOf(driver.id);
            queuePositions.push({
              mission: m,
              position: pos,
              isDue: pos === 0,
              count: q.counts?.[driver.id] || 0,
              lastDone: q.lastDone?.[driver.id]
            });
          }
        }

        const isMgr = isManager();

        body.innerHTML = `
          <!-- Header Hero Card -->
          <div style="background:var(--surface-2);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:16px;display:flex;align-items:center;gap:14px">
            <div style="width:52px;height:52px;border-radius:14px;background:${driver.category === DRIVER_CATEGORY.SHARED ? 'linear-gradient(135deg,#047857,#059669)' : 'linear-gradient(135deg,#1d4ed8,#2563eb)'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:20px;flex-shrink:0">
              ${esc(driver.name.charAt(0))}
            </div>
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-size:18px;font-weight:900;color:var(--text)">${esc(driver.name)}</span>
                <span class="${driver.category === DRIVER_CATEGORY.SHARED ? 'badge-cat-transport' : 'badge-cat-leger'}">
                  ${driver.category === DRIVER_CATEGORY.SHARED ? '🚌 حافلات نقل مشترك' : '🚗 وزن خفيف'}
                </span>
              </div>
              <div style="font-size:12px;color:var(--text-3);margin-top:3px;display:flex;align-items:center;gap:8px">
                <span>الفريق: <b>${esc(team?.name || 'الفريق الافتراضي')}</b></span>
                ${driver.phone ? `<span>· الهاتف: <b>${esc(driver.phone)}</b></span>` : ''}
              </div>
            </div>
          </div>

          <!-- Live Telemetry Grid -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin-bottom:16px">
            <!-- Status Pill -->
            <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px">
              <div style="font-size:11px;color:var(--text-3);font-weight:700">الحالة التشغيلية</div>
              <div style="margin-top:6px">
                ${currentShift ? `
                  <span class="badge-status-driving" style="font-size:12px">
                    <span class="pulse-dot blue"></span>
                    <span>يقود حالياً</span>
                  </span>
                ` : isResting ? `
                  <span class="badge-status-rest" style="font-size:12px">
                    <span class="pulse-dot amber"></span>
                    <span>في نقاهة إجبارية</span>
                  </span>
                ` : driver.status === STATUS.AVAILABLE ? `
                  <span class="badge-status-ready" style="font-size:12px">
                    <span class="pulse-dot green"></span>
                    <span>جاهز ومتاح</span>
                  </span>
                ` : `
                  <span class="badge-status-rest" style="font-size:12px">
                    <span class="pulse-dot red"></span>
                    <span>${STATUS_AR[driver.status] || driver.status}</span>
                  </span>
                `}
              </div>
            </div>

            <!-- Rest / Recovery Pill -->
            <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px">
              <div style="font-size:11px;color:var(--text-3);font-weight:700">ساعات الراحة والنقاهة</div>
              <div style="font-size:15px;font-weight:900;color:var(--text);margin-top:4px">
                ${rest ? fmtDurShort(rest.minutes) : 'غير مسجلة بعد'}
              </div>
              ${isResting ? `
                <div style="font-size:10px;color:#dc2626;font-weight:700;margin-top:2px">
                  متبقي ${fmtDurShort(restRemainingMins)} لاكتمال الراحة
                </div>
              ` : rest ? `
                <div style="font-size:10px;color:#059669;font-weight:700;margin-top:2px">
                  ✓ مكتملة نظامياً (≥ 8 س)
                </div>
              ` : ''}
            </div>

            <!-- Today's Tasks -->
            <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:12px;padding:12px">
              <div style="font-size:11px;color:var(--text-3);font-weight:700">مهام اليوم المجدولة</div>
              <div style="font-size:18px;font-weight:900;color:var(--text);margin-top:4px">
                ${todayAssignments.length} مهام
              </div>
            </div>
          </div>

          <!-- Quick Status Changer (For Manager) -->
          ${isMgr ? `
            <div style="background:var(--surface-2);border-radius:12px;padding:12px;margin-bottom:16px">
              <div style="font-size:12px;font-weight:800;color:var(--text);margin-bottom:8px">⚡ تغيير الحالة السريعة للسائق:</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" class="tag btn-quick-stat" data-st="AVAILABLE" style="cursor:pointer;background:${driver.status === 'AVAILABLE' ? '#10b981;color:#fff' : 'var(--surface-card)'};border:1px solid var(--line);padding:6px 12px;font-weight:800">
                  ✅ متاح وجاهز
                </button>
                <button type="button" class="tag btn-quick-stat" data-st="VACATION" style="cursor:pointer;background:${driver.status === 'VACATION' ? '#f59e0b;color:#fff' : 'var(--surface-card)'};border:1px solid var(--line);padding:6px 12px;font-weight:800">
                  🏖️ في عطلة
                </button>
                <button type="button" class="tag btn-quick-stat" data-st="SICK" style="cursor:pointer;background:${driver.status === 'SICK' ? '#ef4444;color:#fff' : 'var(--surface-card)'};border:1px solid var(--line);padding:6px 12px;font-weight:800">
                  🩺 عجز طبي
                </button>
                <button type="button" class="tag btn-quick-stat" data-st="OFF" style="cursor:pointer;background:${driver.status === 'OFF' ? '#6b7280;color:#fff' : 'var(--surface-card)'};border:1px solid var(--line);padding:6px 12px;font-weight:800">
                  ⚠️ غير متاح
                </button>
              </div>
            </div>
          ` : ''}

          <!-- Queue / Rotations across Missions -->
          <div style="margin-bottom:16px">
            <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:8px">
              🔄 ترتيب السائق في قوائم الدور للمهام (${queuePositions.length}):
            </div>
            ${queuePositions.length === 0 ? `
              <div style="font-size:12px;color:var(--text-3);padding:10px;background:var(--surface-2);border-radius:10px">
                لم يتم إدراج السائق في أي قائمة دور بعد
              </div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:6px">
                ${queuePositions.map(qp => `
                  <div style="background:var(--surface-card);border:1px solid ${qp.isDue ? 'rgba(245,158,11,0.4)' : 'var(--line)'};border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
                    <div>
                      <div style="font-size:13px;font-weight:800;color:var(--text)">${esc(qp.mission.name)}</div>
                      <div style="font-size:11px;color:var(--text-3)">نفذ ${qp.count} مرة في هذه المهمة</div>
                    </div>
                    <div>
                      ${qp.isDue ? `
                        <span class="badge-status-due">
                          <span class="pulse-dot amber"></span>
                          <span>دوره الآن (#1)</span>
                        </span>
                      ` : `
                        <span style="font-size:11px;font-weight:800;background:var(--surface-2);color:var(--text);padding:3px 8px;border-radius:6px">
                          الترتيب: #${qp.position + 1}
                        </span>
                      `}
                    </div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>

          <!-- Today's Schedule -->
          <div>
            <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:8px">
              📅 جدول تكليفات اليوم (${todayAssignments.length}):
            </div>
            ${todayAssignments.length === 0 ? `
              <div style="font-size:12px;color:var(--text-3);padding:10px;background:var(--surface-2);border-radius:10px">
                لا توجد مهام مجدولة للسائق اليوم
              </div>
            ` : `
              <div style="display:flex;flex-direction:column;gap:6px">
                ${todayAssignments.map(ta => `
                  <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
                    <div>
                      <div style="font-size:13px;font-weight:800;color:var(--text)">${esc(ta.mission?.name || 'مهمة')}</div>
                      <div style="font-size:11px;color:var(--text-3)">
                        التوقيت: ${formatTimeHhmm(ta.assignment.startIso, '08:00')} إلى ${formatTimeHhmm(ta.assignment.endIso, '16:00')}
                      </div>
                    </div>
                    <span style="font-size:11px;font-weight:800;background:rgba(37,99,235,0.12);color:#2563eb;padding:3px 8px;border-radius:6px">
                      ${ta.assignment.executedAt ? '✓ تم التنفيذ' : '⏳ قيد الانتظار'}
                    </span>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        `;

        // Event for Quick Status Changer
        body.querySelectorAll('.btn-quick-stat').forEach(btn => {
          btn.onclick = async () => {
            const newStatus = btn.dataset.st;
            try {
              await setDriverStatus(driver.id, newStatus, 'تحديث سريع من بطاقة السائق');
              toast(`تم تغيير حالة ${driver.name} إلى ${STATUS_AR[newStatus] || newStatus}`, 2200, 'success');
              close();
              refresh();
            } catch (err) {
              toast(err.message, 2500, 'error');
            }
          };
        });

      } catch (err) {
        body.innerHTML = `<p style="padding:20px;text-align:center;color:var(--danger)">${esc(err.message)}</p>`;
      }
    }
  });
}
