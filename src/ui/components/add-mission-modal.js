import { sheet, toast, esc, refresh } from '../helpers.js';
import { listMissions, getMission, createMission, getMissionPeriods, MISSION_TYPE } from '../../domain/missions.js';
import { listByDate, createOccurrence } from '../../domain/occurrences.js';
import { ensureQueue } from '../../domain/turns.js';
import { listDrivers, DRIVER_CATEGORY } from '../../domain/drivers.js';
import { fmtDurShort, toMin, fromMinSafe, calcDuration, humanDate, dayNameAr, todayIso } from '../../core/clock.js';

export async function openAddTodayMissionSheet(currentDate, defaultCategory = 'LIGHT') {
  sheet({
    title: `➕ إضافة مهمة لليوم — ${dayNameAr(currentDate)} (${humanDate(currentDate)})`,
    subtitle: `اختر من المهام المسجلة في الكتالوج أو أنشئ مهمة جديدة مخصصة لليوم`,
    builder: async (body, close) => {
      body.innerHTML = `
        <div style="text-align:center;padding:24px;color:var(--text-3)">
          <div style="font-size:28px;margin-bottom:8px">⏳</div>
          <div style="font-size:13px;font-weight:700">جارٍ تحميل دليل المهام والتشغيلات...</div>
        </div>
      `;

      try {
        const [missions, todayOccurrences, allDrivers] = await Promise.all([
          listMissions(false), // active missions only
          listByDate(currentDate),
          listDrivers()
        ]);

        const todayMissionIds = new Set(todayOccurrences.filter(o => !o.cancelled).map(o => o.missionId));

        let activeTab = 'CATALOG'; // 'CATALOG' | 'NEW'
        let catalogCatFilter = defaultCategory === 'SHARED' ? 'SHARED' : 'LIGHT'; // 'LIGHT' | 'SHARED' | 'ALL'
        let catalogSearch = '';

        function renderModal() {
          const lightMissions = missions.filter(m => (m.driverCategory || DRIVER_CATEGORY.LIGHT) === DRIVER_CATEGORY.LIGHT);
          const sharedMissions = missions.filter(m => m.driverCategory === DRIVER_CATEGORY.SHARED);

          let filteredCatalog = missions.filter(m => {
            const cat = m.driverCategory || DRIVER_CATEGORY.LIGHT;
            if (catalogCatFilter === 'LIGHT') return cat === DRIVER_CATEGORY.LIGHT;
            if (catalogCatFilter === 'SHARED') return cat === DRIVER_CATEGORY.SHARED;
            return true;
          });

          if (catalogSearch) {
            filteredCatalog = filteredCatalog.filter(m =>
              m.name.toLowerCase().includes(catalogSearch) ||
              (m.code && m.code.toLowerCase().includes(catalogSearch))
            );
          }

          body.innerHTML = `
            <!-- Top Tab Switcher: Registered vs New -->
            <div class="modal-nav-tabs" style="margin-bottom:16px">
              <button type="button" class="modal-nav-tab ${activeTab === 'CATALOG' ? 'active' : ''}" data-nav="CATALOG">
                <span>📑 من المهام المسجلة (الكتالوج)</span>
              </button>
              <button type="button" class="modal-nav-tab ${activeTab === 'NEW' ? 'active' : ''}" data-nav="NEW">
                <span>➕ إنشاء مهمة جديدة مخصصة</span>
              </button>
            </div>

            ${activeTab === 'CATALOG' ? `
              <!-- 1. REGISTERED CATALOG MISSIONS TAB -->
              <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                <!-- Category Sub-Filters -->
                <div style="display:flex;gap:6px">
                  <button type="button" class="tag btn-cat-chip ${catalogCatFilter === 'LIGHT' ? 'active' : ''}" data-cat="LIGHT" style="cursor:pointer;padding:6px 12px;font-size:12px;font-weight:800;border-radius:8px;border:1px solid var(--line);background:${catalogCatFilter === 'LIGHT' ? 'rgba(37,99,235,0.15);color:#2563eb;border-color:#2563eb' : 'var(--surface-card)'}">
                    🚗 وزن خفيف Léger (${lightMissions.length})
                  </button>
                  <button type="button" class="tag btn-cat-chip ${catalogCatFilter === 'SHARED' ? 'active' : ''}" data-cat="SHARED" style="cursor:pointer;padding:6px 12px;font-size:12px;font-weight:800;border-radius:8px;border:1px solid var(--line);background:${catalogCatFilter === 'SHARED' ? 'rgba(16,185,129,0.15);color:#059669;border-color:#059669' : 'var(--surface-card)'}">
                    🚌 نقل مشترك Transport (${sharedMissions.length})
                  </button>
                  <button type="button" class="tag btn-cat-chip ${catalogCatFilter === 'ALL' ? 'active' : ''}" data-cat="ALL" style="cursor:pointer;padding:6px 12px;font-size:12px;font-weight:800;border-radius:8px;border:1px solid var(--line);background:${catalogCatFilter === 'ALL' ? 'var(--surface-3);color:var(--text)' : 'var(--surface-card)'}">
                    الكل (${missions.length})
                  </button>
                </div>

                <div style="font-size:11px;color:var(--text-3)">
                  انقر على "جدولة لليوم" لإدراج المهمة فوراً
                </div>
              </div>

              <!-- Search input -->
              <div style="margin-bottom:12px">
                <input type="text" id="catalogSearchInput" placeholder="🔍 بحث في المهام المسجلة..." value="${esc(catalogSearch)}" class="input" style="width:100%;font-size:12px;padding:9px 12px;border-radius:10px">
              </div>

              <!-- Catalog Missions List -->
              <div style="max-height:55vh;overflow-y:auto;padding-right:2px">
                ${filteredCatalog.length === 0 ? `
                  <div style="text-align:center;padding:32px 16px;background:var(--surface-2);border-radius:12px;color:var(--text-3)">
                    <div style="font-size:32px;margin-bottom:8px">📋</div>
                    <div style="font-size:14px;font-weight:800;color:var(--text)">لا توجد مهام مسجلة مطابقة</div>
                    <div style="font-size:12px;margin-top:4px">يمكنك إضافة مهمة جديدة مخصصة من التبويب أعلاه</div>
                  </div>
                ` : filteredCatalog.map(m => {
                  const isScheduledToday = todayMissionIds.has(m.id);
                  const isShared = m.driverCategory === DRIVER_CATEGORY.SHARED;
                  const periods = getMissionPeriods(m);
                  const totalDur = m.durationMinutes ? fmtDurShort(m.durationMinutes) : (calcDuration(m.startTime || '08:00', m.endTime || '16:00').humanText || '—');

                  return `
                    <div class="catalog-item-card" style="margin-bottom:10px">
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
                        <div>
                          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                            <span style="font-size:15px;font-weight:900;color:var(--text)">${esc(m.name)}</span>
                            <span class="${isShared ? 'badge-cat-transport' : 'badge-cat-leger'}">
                              ${isShared ? '🚌 نقل مشترك' : '🚗 وزن خفيف'}
                            </span>
                            ${isScheduledToday ? `
                              <span style="font-size:11px;font-weight:800;background:rgba(16,185,129,0.15);color:#059669;padding:2px 8px;border-radius:6px">
                                ✓ مجدولة اليوم
                              </span>
                            ` : ''}
                          </div>

                          <div style="font-size:12px;color:var(--text-2);margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                            <span>⏰ التوقيت القياسي: <b>${esc(m.startTime || '08:00')} إلى ${esc(m.endTime || '16:00')}</b></span>
                            <span>· المدة: <b>${totalDur}</b></span>
                            <span>· المطلوب: <b>${m.driversNeeded || 1} سواق</b></span>
                            ${periods.length > 1 ? `<span>· (${periods.length} فترات/مناوبات)</span>` : ''}
                          </div>
                        </div>

                        <!-- 1-Click Schedule Button -->
                        <div>
                          <button type="button" class="btn-primary btn-schedule-catalog" data-mid="${m.id}" style="padding:8px 16px;font-size:12px;font-weight:800;border-radius:8px;background:${isScheduledToday ? 'var(--surface-3);color:var(--text)' : 'var(--color-accent);color:#fff'}">
                            ${isScheduledToday ? '➕ جدولة تشغيل إضافي' : '⚡ جدولة لليوم'}
                          </button>
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `
              <!-- 2. CREATE NEW CUSTOM MISSION TAB -->
              <div style="background:var(--surface-card);border:1px solid var(--line);border-radius:14px;padding:16px">
                <div style="font-size:14px;font-weight:900;color:var(--text);margin-bottom:14px;display:flex;align-items:center;gap:6px">
                  <span>⚡</span>
                  <span>إنشاء مهمة جديدة وتكليفها ليوم ${humanDate(currentDate)}</span>
                </div>

                <!-- Form Fields -->
                <div style="display:flex;flex-direction:column;gap:12px">
                  <div>
                    <label style="font-size:12px;font-weight:700;color:var(--text);display:block;margin-bottom:4px">اسم المهمة الميدانية *</label>
                    <input type="text" id="newMisName" placeholder="مثال: دورية حراسة قطاع المنار أو نقل عمال الوردية الليلية" class="input" style="width:100%;font-size:13px;padding:9px 12px">
                  </div>

                  <!-- Category Picker (Radio Cards) -->
                  <div>
                    <label style="font-size:12px;font-weight:700;color:var(--text);display:block;margin-bottom:6px">صنف السواق والآليات المطلوب *</label>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                      <label style="cursor:pointer;border:2px solid ${defaultCategory === 'LIGHT' ? '#2563eb' : 'var(--line)'};border-radius:12px;padding:10px 12px;background:${defaultCategory === 'LIGHT' ? 'rgba(37,99,235,0.06)' : 'var(--surface-2)'};display:flex;align-items:center;gap:8px" id="lblCatLeger">
                        <input type="radio" name="newMisCat" value="LIGHT" ${defaultCategory === 'LIGHT' ? 'checked' : ''} style="margin:0">
                        <div>
                          <div style="font-size:13px;font-weight:800;color:var(--text)">🚗 وزن خفيف (Léger)</div>
                          <div style="font-size:11px;color:var(--text-3)">سيارات دوريات، مهام إدارية وميدانية</div>
                        </div>
                      </label>

                      <label style="cursor:pointer;border:2px solid ${defaultCategory === 'SHARED' ? '#059669' : 'var(--line)'};border-radius:12px;padding:10px 12px;background:${defaultCategory === 'SHARED' ? 'rgba(16,185,129,0.06)' : 'var(--surface-2)'};display:flex;align-items:center;gap:8px" id="lblCatTransport">
                        <input type="radio" name="newMisCat" value="SHARED" ${defaultCategory === 'SHARED' ? 'checked' : ''} style="margin:0">
                        <div>
                          <div style="font-size:13px;font-weight:800;color:var(--text)">🚌 نقل مشترك (Transport)</div>
                          <div style="font-size:11px;color:var(--text-3)">حافلات، نقل عمال ومناوبات مشتركة</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  <!-- Timing Row -->
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                    <div>
                      <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">وقت البداية</label>
                      <input type="time" id="newMisStart" value="08:00" class="input" style="width:100%;font-size:13px;padding:8px">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">وقت النهاية</label>
                      <input type="time" id="newMisEnd" value="16:00" class="input" style="width:100%;font-size:13px;padding:8px">
                    </div>
                    <div>
                      <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:3px">عدد السواق</label>
                      <input type="number" id="newMisDrivers" value="1" min="1" max="10" class="input" style="width:100%;font-size:13px;padding:8px">
                    </div>
                  </div>

                  <!-- Option to save as catalog template -->
                  <div style="margin-top:4px">
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:700;color:var(--text-2)">
                      <input type="checkbox" id="chkSaveToCatalog" checked style="width:16px;height:16px">
                      <span>💾 حفظ أيضاً كقالب دائم في دليل المهام (الكتالوج) للجدولة المستقبلية</span>
                    </label>
                  </div>

                  <!-- Submit Buttons -->
                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
                    <button type="button" class="btn-ghost" id="btnCancelNewMis" style="padding:10px 18px;font-size:13px">إلغاء</button>
                    <button type="button" class="btn-primary" id="btnSubmitNewMis" style="padding:10px 24px;font-size:13px;font-weight:800;background:var(--color-accent);color:#fff">
                      🚀 حفظ وجدولة لليوم فوراً
                    </button>
                  </div>
                </div>
              </div>
            `}
          `;

          // Top tabs
          body.querySelectorAll('[data-nav]').forEach(btn => {
            btn.onclick = () => {
              activeTab = btn.dataset.nav;
              renderModal();
            };
          });

          // Category filter chips in catalog
          body.querySelectorAll('.btn-cat-chip').forEach(btn => {
            btn.onclick = () => {
              catalogCatFilter = btn.dataset.cat;
              renderModal();
            };
          });

          // Catalog search input
          const sInput = body.querySelector('#catalogSearchInput');
          if (sInput) {
            sInput.oninput = (e) => {
              catalogSearch = e.target.value.toLowerCase().trim();
              renderModal();
            };
          }

          // Category radio toggle styling in New tab
          const rLeger = body.querySelector('#lblCatLeger');
          const rTransport = body.querySelector('#lblCatTransport');
          if (rLeger && rTransport) {
            body.querySelectorAll('input[name="newMisCat"]').forEach(radio => {
              radio.onchange = () => {
                defaultCategory = radio.value;
                renderModal();
              };
            });
          }

          // 1-Click Schedule Catalog Mission
          body.querySelectorAll('.btn-schedule-catalog').forEach(btn => {
            btn.onclick = async () => {
              const mid = Number(btn.dataset.mid);
              const m = missions.find(x => x.id === mid);
              if (!m) return;

              btn.disabled = true;
              btn.textContent = '⏳ جاري الجدولة...';

              try {
                // Create occurrence
                await createOccurrence({
                  dateIso: currentDate,
                  missionId: m.id,
                  startTime: m.startTime || '08:00',
                  durationMinutes: m.durationMinutes || 480
                });

                // Ensure queues for this mission
                const relevantDrivers = allDrivers.filter(d => {
                  const dCat = d.category || DRIVER_CATEGORY.LIGHT;
                  const mCat = m.driverCategory || DRIVER_CATEGORY.LIGHT;
                  return dCat === mCat || dCat === 'ALL';
                }).map(d => d.id);

                await ensureQueue(m.id, null, relevantDrivers);

                toast(`تمت جدولة مهمة "${m.name}" لليوم بنجاح!`, 2200, 'success');
                close();
                refresh();
              } catch (err) {
                toast(err.message, 2500, 'error');
                btn.disabled = false;
                btn.textContent = '⚡ جدولة لليوم';
              }
            };
          });

          // Submit New Mission
          const btnSubmitNew = body.querySelector('#btnSubmitNewMis');
          if (btnSubmitNew) {
            btnSubmitNew.onclick = async () => {
              const name = body.querySelector('#newMisName')?.value?.trim();
              const cat = body.querySelector('input[name="newMisCat"]:checked')?.value || DRIVER_CATEGORY.LIGHT;
              const startTime = body.querySelector('#newMisStart')?.value || '08:00';
              const endTime = body.querySelector('#newMisEnd')?.value || '16:00';
              const driversNeeded = Number(body.querySelector('#newMisDrivers')?.value) || 1;
              const saveToCatalog = body.querySelector('#chkSaveToCatalog')?.checked ?? true;

              if (!name) {
                return toast('يرجى كتابة اسم المهمة', 2200, 'error');
              }

              btnSubmitNew.disabled = true;
              btnSubmitNew.textContent = '⏳ جاري الحفظ...';

              try {
                const startMin = toMin(startTime);
                const endMin = toMin(endTime);
                const dur = endMin >= startMin ? (endMin - startMin) : (1440 - startMin + endMin);

                const mid = await createMission({
                  name,
                  type: MISSION_TYPE.NORMAL,
                  startTime,
                  endTime,
                  durationMinutes: dur,
                  driversNeeded,
                  driverCategory: cat,
                  disabled: !saveToCatalog // if not saving to catalog permanently, keep it only for this schedule
                });

                await createOccurrence({
                  dateIso: currentDate,
                  missionId: mid,
                  startTime,
                  durationMinutes: dur
                });

                // Ensure turn queue for this mission
                const relevantDrivers = allDrivers.filter(d => {
                  const dCat = d.category || DRIVER_CATEGORY.LIGHT;
                  return dCat === cat || dCat === 'ALL';
                }).map(d => d.id);

                await ensureQueue(mid, null, relevantDrivers);

                toast(`تم إنشاء وجدولة مهمة "${name}" لليوم بنجاح!`, 2200, 'success');
                close();
                refresh();
              } catch (err) {
                toast(err.message, 2500, 'error');
                btnSubmitNew.disabled = false;
                btnSubmitNew.textContent = '🚀 حفظ وجدولة لليوم فوراً';
              }
            };
          }

          const btnCancelNew = body.querySelector('#btnCancelNewMis');
          if (btnCancelNew) btnCancelNew.onclick = close;
        }

        renderModal();
      } catch (err) {
        body.innerHTML = `<p style="padding:20px;text-align:center;color:var(--danger)">${esc(err.message)}</p>`;
      }
    }
  });
}
