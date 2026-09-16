export const AR_DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

export const pad = n => String(n).padStart(2, '0');

export const toMin = h => {
  const [a, b] = String(h || '0:0').split(':').map(Number);
  return (a | 0) * 60 + (b | 0);
};

// تحويل دقائق إلى "س:د" بأمان
export const fromMin = m => {
  m = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

export const fromMinSafe = m => {
  const mm = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`;
};

export const fmtDur = m => {
  m = Math.max(0, m | 0);
  const h = Math.floor(m / 60), x = m % 60;
  return x ? `${h} س ${x} د` : `${h} س`;
};

export const fmtDurShort = m => {
  m = Math.max(0, m | 0);
  const h = Math.floor(m / 60), x = m % 60;
  return x ? `${h}س ${x}د` : `${h}س`;
};

export const isoDate = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const nowIso = () => new Date().toISOString();
export const todayIso = () => isoDate();

export const isoToDate = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (iso, n) => {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

export const dayNameAr = iso => AR_DAYS[isoToDate(iso).getDay()];
export const isToday = iso => iso === todayIso();

export function humanDate(iso) {
  if (iso === todayIso()) return 'اليوم';
  if (iso === addDays(todayIso(), -1)) return 'أمس';
  if (iso === addDays(todayIso(), 1)) return 'غدًا';
  const d = isoToDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function humanDateFull(iso) {
  const d = isoToDate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function buildStart(iso, hhmm) {
  const d = isoToDate(iso);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h | 0, m | 0, 0, 0);
  return d;
}

export const addMin = (dt, mins) => new Date(dt.getTime() + mins * 60000);

export function relativeDay(iso) {
  if (iso === todayIso()) return 'اليوم';
  if (iso === addDays(todayIso(), -1)) return 'أمس';
  const t = isoToDate(todayIso());
  const x = isoToDate(iso);
  const diff = Math.floor((t - x) / 86400000);
  if (diff > 0 && diff < 30) return `قبل ${diff} يوم`;
  if (diff < 0 && diff > -30) return `بعد ${-diff} يوم`;
  return humanDate(iso);
}

export function calcDuration(startHhmm, endHhmm) {
  if (!startHhmm || !endHhmm) return { durationMinutes: 0, dayOffset: 0, humanText: '—' };
  const s = toMin(startHhmm);
  let e = toMin(endHhmm);
  let dayOffset = 0;
  if (e < s) {
    e += 1440;
    dayOffset = 1;
  } else if (e === s) {
    e += 1440;
    dayOffset = 1;
  }
  const durationMinutes = e - s;
  const humanText = `${fmtDur(durationMinutes)}${dayOffset > 0 ? ' (حتى اليوم التالي)' : ''}`;
  return { durationMinutes, dayOffset, humanText };
}

export function toIso(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val.toISOString();
  try {
    const d = new Date(val);
    return isNaN(d.getTime()) ? String(val) : d.toISOString();
  } catch {
    return String(val);
  }
}

export function formatTimeHhmm(val, fallback = '00:00') {
  if (!val) return fallback;
  if (typeof val === 'string') {
    if (val.includes('T')) {
      const parts = val.split('T')[1];
      return parts ? parts.slice(0, 5) : fallback;
    }
    if (val.length === 5 && val.includes(':')) {
      return val;
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toTimeString().slice(0, 5);
    }
    return val.slice(0, 5);
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toTimeString().slice(0, 5);
  }
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toTimeString().slice(0, 5);
  } catch {}
  return fallback;
}

export function formatDateIso(val, fallback = '') {
  if (!val) return fallback;
  if (typeof val === 'string') {
    if (val.includes('T')) return val.split('T')[0];
    if (val.length === 10 && val.includes('-')) return val;
    const d = new Date(val);
    if (!isNaN(d.getTime())) return isoDate(d);
    return val.slice(0, 10);
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    return isoDate(val);
  }
  return fallback;
}


