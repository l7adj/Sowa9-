import { listLoans, createLoan, completeLoan, cancelLoan, listShortages, resolveShortage, LOAN_STATUS } from '../domain/loans.js';
import { listTeams } from '../domain/teams.js';
import { listDrivers, getDriver, STATUS_AR, STATUS_COLOR } from '../domain/drivers.js';
import { listMissions, getMissionPeriods } from '../domain/missions.js';
import { listByDate } from '../domain/occurrences.js';
import { listByOccurrence, ASG_STATUS } from '../domain/assignments.js';
import { isManager, isLeader } from '../core/auth.js';
import { esc, toast, sheet, attachRipple } from './helpers.js';
import { todayIso, humanDate, fmtDurShort } from '../core/clock.js';

export async function renderLoansPage(main) {
  const [loans, shortages, teams, drivers, missions] = await Promise.all([
    listLoans(),
    listShortages(),
    listTeams(),
    listDrivers(),
    listMissions()
  ]);

  const teamMap = new Map(teams.map(t => [t.id, t]));
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  const missionMap = new Map(missions.map(m => [m.id, m]));

  const activeLoans = loans.filter(l => l.status === LOAN_STATUS.ACTIVE);
  const completedLoans = loans.filter(l => l.status === LOAN_STATUS.COMPLETED);
  const unresolvedShortages = shortages.filter(s => !s.resolved);

  main.innerHTML = `
    <div class="section">
      <div class="section-head">
        <div class="title">🔄 إدارة الإعارة والتسليف بين الفرق <span class="count">${loans.length}</span></div>
        <div class="spacer"></div>
        ${isManager() ? `
          <button class="tag" id="newLoanBtn" style="padding:7px 14px;
            background:var(--primary);color:#fff;border:0;border-radius:8px;
            font-family:inherit;font-weight:800;cursor:pointer;font-size:12px">+ إعارة / استعارة سائق</button>
        ` : ''}
      </div>

      <!-- Quick Metrics Bar -->
      <div class="stat-grid-3" style="margin:10px 0 16px 0">
        <div class="cell">
          <b style="color:var(--accent)">${activeLoans.length}</b>
          <span>إعارات نشطة حالياً</span>
        </div>
        <div class="cell">
          <b style="color:${unresolvedShortages.length > 0 ? 'var(--bad)' : 'var(--ok)'}">${unresolvedShortages.length}</b>
          <span>حالات نقص مرصودة</span>
        </div>
        <div class="cell">
          <b style="color:var(--ok)">${completedLoans.length}</b>
          <span>إعارات منتهية مسجلة</span>
        </div>
      </div>

      <!-- Real-time Shortage Alerts -->
      ${unresolvedShortages.length > 0 ? `
        <div style="background:var(--bad-bg, rgba(239,68,68,0.08));border:1px solid var(--bad);border-radius:12px;padding:12px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;font-weight:800;color:var(--bad);font-size:13px;margin-bottom:8px">
            <span>⚠️ حالات نقص سائقين تحتاج معالجة (${unresolvedShortages.length})</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${unresolvedShortages.map(s => {
              const mis = missionMap.get(s.missionId);
              return `
                <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                  <div>
                    <div style="font-weight:800;font-size:13px">${esc(mis?.name || 'مهمة')} · ${esc(s.timeSlot || 'فترة العمل')}</div>
                    <div style="font-size:11px;color:var(--text-2);margin-top:2px">
                      تاريخ: ${esc(humanDate(s.dateIso))} ·
                      المطلوب: <b>${s.requiredCount}</b> · المتوفر: <b>${s.availableCount}</b> · <span style="color:var(--bad);font-weight:800">النقص: ${s.shortageCount} سائق</span>
                    </div>
                    <div style="font-size:11px;color:var(--text-3);margin-top:2px">السبب: ${esc(s.reason)}</div>
                  </div>
                  ${isManager() ? `
                    <button class="tag" data-solve-shortage="${s.id}" data-mid="${s.missionId}" data-occ="${s.occurrenceId}" data-period="${s.periodId || ''}" style="cursor:pointer;border:0;background:var(--accent);color:#fff;padding:6px 12px;border-radius:6px;font-family:inherit;font-weight:700;font-size:11px">
                      استعارة سائق لحل النقص
                    </button>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Historical Loans List -->
      <div class="section-head" style="padding:0;margin-bottom:10px">
        <div class="title" style="font-size:13px">📜 السجل التاريخي لعمليات الإعارة والتسليف</div>
      </div>

      <div class="section-body">
        ${loans.length === 0 ? `
          <div class="empty-block">
            <div class="ic">🔄</div>
            <h3>لا توجد إعارات مسجلة حتى الآن</h3>
            <p>عند حدوث نقص في فريق معين، يمكنك استعارة سائق من فريق آخر وتوثيق العملية هنا</p>
          </div>
        ` : loans.map(l => {
          const fromT = teamMap.get(l.fromTeamId);
          const toT = teamMap.get(l.toTeamId);
          const dr = driverMap.get(l.driverId);
          const mis = missionMap.get(l.missionId);
          const isActive = l.status === LOAN_STATUS.ACTIVE;
          return `
            <div class="driver-profile-card" style="padding:14px;border-right:4px solid ${fromT?.color || 'var(--accent)'}">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="av" style="background:${fromT?.color || 'var(--accent)'};color:#fff;font-weight:800">
                    ${esc(dr?.name?.charAt(0) || '؟')}
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:800;color:var(--text-1)">
                      ${esc(dr?.name || 'سائق')}
                      ${isActive ? '<span class="tag ok" style="margin-right:6px">إعارة نشطة</span>' : '<span class="tag muted" style="margin-right:6px">مكتملة</span>'}
                    </div>
                    <div style="font-size:12px;color:var(--text-2);margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <span style="font-weight:700;color:${fromT?.color || 'inherit'}">${esc(fromT?.name || 'الفريق المعير')}</span>
                      <span>➔</span>
                      <span style="font-weight:700;color:${toT?.color || 'inherit'}">${esc(toT?.name || 'الفريق المستعير')}</span>
                    </div>
                  </div>
                </div>
                <div style="font-size:11px;color:var(--text-3);text-align:left">
                  ${esc(humanDate(l.dateIso))}
                </div>
              </div>

              <!-- Loan Details Box -->
              <div style="background:var(--bg-base);border-radius:8px;padding:8px 10px;margin:10px 0 6px 0;font-size:11px;display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:6px">
                <div><span style="color:var(--text-3)">المهمة: </span><b>${esc(mis?.name || 'مهمة عامة')}</b></div>
                <div><span style="color:var(--text-3)">الفترة: </span><b>${esc(l.timeSlot || 'كامل الوردية')}</b></div>
                <div><span style="color:var(--text-3)">السبب: </span><b>${esc(l.reason)}</b></div>
                <div><span style="color:var(--text-3)">العدالة: </span><b style="color:var(--ok)">${l.fairnessImpact ? 'محسوبة للسائق' : 'مستثناة'}</b></div>
              </div>

              ${isActive && isManager() ? `
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
                  <button class="tag ok" data-complete-loan="${l.id}" style="cursor:pointer;border:0;font-family:inherit;padding:5px 10px;border-radius:6px">
                    ✓ إنهاء الإعارة وعودة السائق
                  </button>
                  <button class="tag muted" data-cancel-loan="${l.id}" style="cursor:pointer;border:0;font-family:inherit;padding:5px 10px;border-radius:6px">
                    إلغاء
                  </button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  main.querySelector('#newLoanBtn')?.addEventListener('click', () => openNewLoanModal());
  
  main.querySelectorAll('[data-complete-loan]').forEach(btn => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.completeLoan);
      const note = prompt('ملاحظة إتمام الإعارة (اختياري):', 'تمت المهمة وعاد السائق لفريقه');
      if (note === null) return;
      try {
        await completeLoan(id, note);
        toast('تم إنهاء الإعارة وتحديث سجل السائق', 2200, 'success');
        renderLoansPage(main);
      } catch (e) { toast(e.message, 2200, 'error'); }
    };
  });

  main.querySelectorAll('[data-cancel-loan]').forEach(btn => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.cancelLoan);
      const reason = prompt('يرجى كتابة سبب إلغاء الإعارة:');
      if (!reason || !reason.trim()) return;
      try {
        await cancelLoan(id, reason.trim());
        toast('تم إلغاء الإعارة', 2200, 'warn');
        renderLoansPage(main);
      } catch (e) { toast(e.message, 2200, 'error'); }
    };
  });

  main.querySelectorAll('[data-solve-shortage]').forEach(btn => {
    btn.onclick = () => {
      const shortageId = Number(btn.dataset.solveShortage);
      const missionId = Number(btn.dataset.mid);
      const occurrenceId = Number(btn.dataset.occ);
      const periodId = btn.dataset.period;
      openNewLoanModal({ shortageId, missionId, occurrenceId, periodId });
    };
  });

  main.querySelectorAll('.driver-profile-card').forEach(attachRipple);
}

export async function openNewLoanModal(prefill = {}) {
  const [teams, drivers, missions] = await Promise.all([
    listTeams(),
    listDrivers(),
    listMissions()
  ]);

  sheet({
    title: '🔄 تسجيل استعارة / تسليف سائق',
    subtitle: 'معالجة نقص السائقين وتوثيق حركة السائق بين الفرق مع الحفاظ على العدالة',
    builder: (body, close) => {
      body.innerHTML = `
        <div class="form-row">
          <div class="form-field">
            <label>الفريق المعير (من)</label>
            <select id="fromTeam">
              ${teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-field">
            <label>الفريق المستعير (إلى)</label>
            <select id="toTeam">
              ${teams.map((t, idx) => `<option value="${t.id}" ${idx === 1 ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-field">
          <label>السائق المراد إعارته</label>
          <select id="driverSelect">
            <option value="">— اختر السائق —</option>
            ${drivers.map(d => `
              <option value="${d.id}" data-team="${d.teamId || 1}">
                ${esc(d.name)} (${STATUS_AR[d.status] || d.status})
              </option>
            `).join('')}
          </select>
        </div>

        <div class="form-row">
          <div class="form-field">
            <label>المهمة المعنية</label>
            <select id="missionSelect">
              <option value="">— مهمة عامة —</option>
              ${missions.map(m => `
                <option value="${m.id}" ${prefill.missionId === m.id ? 'selected' : ''}>
                  ${esc(m.name)}
                </option>
              `).join('')}
            </select>
          </div>
          <div class="form-field">
            <label>الفترة الزمنية</label>
            <input id="timeSlot" placeholder="مثال: 11:00 → 17:00" value="11:00 → 17:00">
          </div>
        </div>

        <div class="form-row">
          <div class="form-field">
            <label>تاريخ الإعارة (YYYY-MM-DD)</label>
            <input id="dateIso" value="${todayIso()}">
          </div>
          <div class="form-field">
            <label>سبب الإعارة (إلزامي للتوثيق)</label>
            <input id="reason" placeholder="مثال: نقص سائقين في الوردية" value="نقص سائقين في الوردية">
          </div>
        </div>

        <div style="background:var(--bg-base);border-radius:8px;padding:10px 12px;margin:12px 0;font-size:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700">
            <input type="checkbox" id="fairnessCheck" checked style="width:16px;height:16px">
            <span>احتساب ساعات المهمة والإعارة في سجل عدالة السائق وتوزيع المهام</span>
          </label>
        </div>

        <button class="btn-primary" id="saveLoanBtn">حفظ وتأكيد الإعارة</button>
        <button class="btn-ghost" id="cancelBtn">إلغاء</button>
      `;

      // Filter drivers when fromTeam changes
      const fromTeamSel = body.querySelector('#fromTeam');
      const driverSel = body.querySelector('#driverSelect');
      const updateDriverOptions = () => {
        const fromId = Number(fromTeamSel.value);
        Array.from(driverSel.options).forEach(opt => {
          if (!opt.value) return;
          const dt = Number(opt.dataset.team);
          opt.style.display = dt === fromId ? '' : 'none';
        });
        const firstVisible = Array.from(driverSel.options).find(opt => opt.value && opt.style.display !== 'none');
        if (firstVisible) driverSel.value = firstVisible.value;
      };
      fromTeamSel.onchange = updateDriverOptions;
      updateDriverOptions();

      body.querySelector('#cancelBtn').onclick = close;

      body.querySelector('#saveLoanBtn').onclick = async () => {
        const fromTeamId = Number(body.querySelector('#fromTeam').value);
        const toTeamId = Number(body.querySelector('#toTeam').value);
        const driverId = Number(body.querySelector('#driverSelect').value);
        const missionId = body.querySelector('#missionSelect').value ? Number(body.querySelector('#missionSelect').value) : null;
        const timeSlot = body.querySelector('#timeSlot').value.trim();
        const dateIso = body.querySelector('#dateIso').value.trim();
        const reason = body.querySelector('#reason').value.trim();
        const fairnessImpact = body.querySelector('#fairnessCheck').checked;

        if (fromTeamId === toTeamId) {
          return toast('يجب أن يكون الفريق المستعير مختلفاً عن الفريق المعير', 2400, 'error');
        }
        if (!driverId) return toast('يرجى اختيار السائق', 2200, 'error');
        if (!reason) return toast('سبب الإعارة مطلوب للتوثيق', 2200, 'error');

        try {
          const loanId = await createLoan({
            fromTeamId,
            toTeamId,
            driverId,
            missionId,
            occurrenceId: prefill.occurrenceId || null,
            periodId: prefill.periodId || null,
            timeSlot,
            dateIso,
            reason,
            fairnessImpact
          });

          if (prefill.shortageId) {
            await resolveShortage(prefill.shortageId, loanId);
          }

          if (prefill.occurrenceId && missionId) {
            try {
              const { getOccurrence } = await import('../domain/occurrences.js');
              const { getMission, getMissionPeriods } = await import('../domain/missions.js');
              const { createProposal, confirm } = await import('../domain/assignments.js');
              const { commitExecution } = await import('../engine/fairness.js');
              const { periodRange } = await import('../engine/shared-transport.js');
              const { buildStart, addMin } = await import('../core/clock.js');

              const occ = await getOccurrence(prefill.occurrenceId);
              const mis = await getMission(missionId);
              const pPeriods = getMissionPeriods(mis);
              const targetPeriod = prefill.periodId ? pPeriods.find(p => (p.code || p.id) === prefill.periodId) : null;

              let startIso, endIso;
              if (targetPeriod) {
                const r = periodRange(targetPeriod, occ.dateIso);
                startIso = r.start.toISOString();
                endIso = r.end.toISOString();
              } else {
                const s = buildStart(occ.dateIso, occ.startTime);
                startIso = s.toISOString();
                endIso = addMin(s, occ.durationMinutes).toISOString();
              }

              const dueId = prefill.dueDriverId || (prefill.due?.id) || null;

              const aid = await createProposal({
                occurrenceId: prefill.occurrenceId,
                missionId,
                periodId: prefill.periodId || null,
                periodCode: prefill.periodId || null,
                dueDriverId: dueId,
                plannedDriverId: driverId,
                startIso,
                endIso,
                rationale: `استعارة سائق لحل النقص — ${reason}`,
                score: 0,
                source: 'BORROWED',
                loanId
              });
              await confirm(aid, 'تعيين سائق مستعار');
              await commitExecution({
                missionId,
                periodId: prefill.periodId || null,
                driverId,
                at: startIso,
                assignmentId: aid
              });
            } catch (err) {
              console.warn('Auto assignment of borrowed driver failed:', err);
            }
          }

          toast('تم تسجيل الإعارة وتعيين السائق بنجاح', 2400, 'success');
          close();
          prefill.onDone && prefill.onDone();
          const refreshFn = (await import('./helpers.js')).refresh;
          refreshFn();
        } catch (e) {
          toast(e.message, 2400, 'error');
        }
      };
    }
  });
}
