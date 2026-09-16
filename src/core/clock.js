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

