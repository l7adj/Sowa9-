// محرك الفترات والمناوبات العام لجميع أنواع المهام
// يدعم أي مهمة بأي عدد من الفترات وأي مسارات وتداخلات

export const FOREST_PERIODS = [
  { code:'ALPHA-1', name:'Alpha — بداية', track:'ALPHA',
    startTime:'17:00', durationMinutes:360, dayOffset:0, orderIndex:0,
    hint:'يعمل أيضًا في Alpha-3 عادةً' },
  { code:'ALPHA-2', name:'Alpha — فجر', track:'ALPHA',
    startTime:'05:00', durationMinutes:360, dayOffset:1, orderIndex:1,
    hint:'مستقل' },
  { code:'ALPHA-3', name:'Alpha — ظهر', track:'ALPHA',
    startTime:'11:00', durationMinutes:360, dayOffset:1, orderIndex:2,
    hint:'غالبًا نفس سائق Alpha-1' },
  { code:'MO-1', name:'MO — بداية', track:'MO',
    startTime:'17:00', durationMinutes:330, dayOffset:0, orderIndex:3,
    hint:'يعمل أيضًا في MO-2 عادةً' },
  { code:'MO-2', name:'MO — صباح', track:'MO',
    startTime:'07:30', durationMinutes:270, dayOffset:1, orderIndex:4,
    hint:'غالبًا نفس سائق MO-1' },
  { code:'MO-3', name:'MO — ظهر', track:'MO',
    startTime:'12:30', durationMinutes:270, dayOffset:1, orderIndex:5,
    hint:'مستقل' }
];

export function periodRange(period, dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [h, mm] = period.startTime.split(':').map(Number);
  const start = new Date(y, m - 1, d + (period.dayOffset || 0), h, mm, 0, 0);
  const end = new Date(start.getTime() + period.durationMinutes * 60000);
  return { start, end };
}

export function periodLabel(period, dateIso) {
  const { start, end } = periodRange(period, dateIso);
  const pad = n => String(n).padStart(2, '0');
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  const isNextDay = (period.dayOffset || 0) > 0;
  return {
    startTime,
    endTime,
    isNextDay,
    startDate: start,
    endDate: end,
    fullRange: `${startTime} → ${endTime}${isNextDay ? ` (+${period.dayOffset} يوم)` : ''}`
  };
}

export function periodsOverlap(a, b, dateIso) {
  const ra = periodRange(a, dateIso);
  const rb = periodRange(b, dateIso);
  return ra.start < rb.end && rb.start < ra.end;
}

export function canAssign({ driver, period, dateIso, existingAssignments }) {
  if (driver.status !== 'AVAILABLE') {
    return {
      ok: false,
      reason: {
        VACATION: 'في عطلة',
        SICK: 'عجز طبي',
        UNAVAILABLE: 'غير متاح',
        ABSENT: 'غائب',
        DISABLED: 'معطَّل'
      }[driver.status] || 'غير متاح'
    };
  }
  const newRange = periodRange(period, dateIso);
  for (const ex of existingAssignments) {
    if (ex.driverId !== driver.id) continue;
    if (ex.period && (ex.period.code === period.code || ex.period.id === period.id)) continue;
    if (ex.period) {
      const exRange = periodRange(ex.period, dateIso);
      if (newRange.start < exRange.end && exRange.start < newRange.end) {
        return { ok: false, reason: `متداخل مع ${ex.period.name} (${ex.period.startTime})` };
      }
    }
  }
  return { ok: true, reason: null };
}
