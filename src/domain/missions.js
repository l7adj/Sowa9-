import { all, get, put } from '../core/db.js';
import { nowIso, toMin, fromMinSafe } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export const MISSION_TYPE = {
  NORMAL: 'NORMAL',
  MULTI_SHIFT: 'MULTI_SHIFT',
  FOREST: 'MULTI_SHIFT' // Alias for backward-compatibility with previously seeded data
};

export const SAMPLE_CATALOG = [
  {
    code: 'WORKER-24H',
    name: 'نقل العمال والمناوبات (24 ساعة)',
    type: MISSION_TYPE.MULTI_SHIFT,
    startTime: '17:00',
    endTime: '17:00',
    durationMinutes: 1440,
    driversNeeded: 3,
    driverCategory: 'SHARED', // نقل مشترك 🚌
    locationType: 'outdoor',
    notes: 'مهمة مستمرة 24 ساعة مقسمة على ثلاث ورديات متتابعة لسواق النقل المشترك',
    periods: [
      { id: 'W-P1', name: 'الفترة 1 — المسائية', startTime: '17:00', endTime: '23:00', durationMinutes: 360, dayOffset: 0, driversNeeded: 1, driverCategory: 'SHARED' },
      { id: 'W-P2', name: 'الفترة 2 — الفجر', startTime: '05:00', endTime: '11:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 1, driverCategory: 'SHARED' },
      { id: 'W-P3', name: 'الفترة 3 — الظهيرة', startTime: '11:00', endTime: '17:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 1, driverCategory: 'SHARED' }
    ]
  },
  {
    code: 'PATROL-12H',
    name: 'دورية الحراسة والإسناد (12 ساعة)',
    type: MISSION_TYPE.MULTI_SHIFT,
    startTime: '18:00',
    endTime: '06:00',
    durationMinutes: 720,
    driversNeeded: 4,
    driverCategory: 'LIGHT', // وزن خفيف 🚗
    locationType: 'outdoor',
    notes: 'دورية حراسة ليلية مقسمة على فترتين كل فترة سائقين وزن خفيف',
    periods: [
      { id: 'PAT-1', name: 'فترة أول الليل', startTime: '18:00', endTime: '00:00', durationMinutes: 360, dayOffset: 0, driversNeeded: 2, driverCategory: 'LIGHT' },
      { id: 'PAT-2', name: 'فترة آخر الليل والفجر', startTime: '00:00', endTime: '06:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 2, driverCategory: 'LIGHT' }
    ]
  },
  {
    code: 'FOREST-24H',
    name: 'مهمة الغابة (24 ساعة — مساران)',
    type: MISSION_TYPE.FOREST,
    startTime: '17:00',
    endTime: '17:00',
    durationMinutes: 1440,
    driversNeeded: 6,
    driverCategory: 'LIGHT',
    locationType: 'outdoor',
    notes: '24 ساعة مقسمة على 6 فترات عبر مساري Alpha و MO',
    periods: [
      { id: 'ALPHA-1', code: 'ALPHA-1', name: 'Alpha — بداية', track: 'ALPHA', startTime: '17:00', endTime: '23:00', durationMinutes: 360, dayOffset: 0, driversNeeded: 1, driverCategory: 'LIGHT' },
      { id: 'ALPHA-2', code: 'ALPHA-2', name: 'Alpha — فجر', track: 'ALPHA', startTime: '05:00', endTime: '11:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 1, driverCategory: 'LIGHT' },
      { id: 'ALPHA-3', code: 'ALPHA-3', name: 'Alpha — ظهر', track: 'ALPHA', startTime: '11:00', endTime: '17:00', durationMinutes: 360, dayOffset: 1, driversNeeded: 1, driverCategory: 'LIGHT' },
      { id: 'MO-1', code: 'MO-1', name: 'MO — بداية', track: 'MO', startTime: '17:00', endTime: '22:30', durationMinutes: 330, dayOffset: 0, driversNeeded: 1, driverCategory: 'LIGHT' },
      { id: 'MO-2', code: 'MO-2', name: 'MO — صباح', track: 'MO', startTime: '07:30', endTime: '12:00', durationMinutes: 270, dayOffset: 1, driversNeeded: 1, driverCategory: 'LIGHT' },
      { id: 'MO-3', code: 'MO-3', name: 'MO — ظهر', track: 'MO', startTime: '12:30', endTime: '17:00', durationMinutes: 270, dayOffset: 1, driversNeeded: 1, driverCategory: 'LIGHT' }
    ]
  },
  { code: 'DUNYA', name: 'دنيا برك (نقل مناوبات)', startTime: '12:00', endTime: '22:00', durationMinutes: 600, driversNeeded: 2, driverCategory: 'SHARED', locationType: 'outdoor' },
  { code: 'GARDEN', name: 'غاردن سيتي (دورية خفيفة)', startTime: '17:00', endTime: '00:00', durationMinutes: 420, driversNeeded: 2, driverCategory: 'LIGHT', locationType: 'outdoor' },
  { code: 'BAHJA', name: 'البحر بهجة', startTime: '09:00', endTime: '22:00', durationMinutes: 780, driversNeeded: 1, driverCategory: 'LIGHT', locationType: 'outdoor' },
  { code: 'GUARD', name: 'حراسة مقر', startTime: '17:00', endTime: '00:00', durationMinutes: 420, driversNeeded: 1, driverCategory: 'LIGHT', locationType: 'indoor' },
  { code: 'RAID', name: 'مداهمات سريعة (إسناد خفيف)', startTime: '19:30', endTime: '05:00', durationMinutes: 570, driversNeeded: 2, driverCategory: 'LIGHT', locationType: 'outdoor' },
  { code: 'DELIV', name: 'توصيل عتاد ونقل', startTime: '20:00', endTime: '23:00', durationMinutes: 180, driversNeeded: 1, driverCategory: 'SHARED', locationType: 'outdoor' }
];

export function getMissionPeriods(m) {
  if (!m) return [];
  if (Array.isArray(m.periods) && m.periods.length > 0) {
    return m.periods.map((p, idx) => {
      const dur = p.durationMinutes || 360;
      const computedEnd = p.endTime || fromMinSafe(toMin(p.startTime) + dur);
      return {
        id: p.id || p.code || ('P-' + idx),
        code: p.code || p.id || ('P-' + idx),
        name: p.name || `فترة ${idx + 1}`,
        track: p.track || null,
        startTime: p.startTime,
        endTime: computedEnd,
        durationMinutes: dur,
        dayOffset: p.dayOffset !== undefined ? p.dayOffset : (toMin(computedEnd) <= toMin(p.startTime) ? 1 : 0),
        driversNeeded: p.driversNeeded || 1,
        driverCategory: p.driverCategory || m.driverCategory || 'ALL',
        orderIndex: idx
      };
    });
  }
  const startMin = toMin(m.startTime || '12:00');
  const dur = m.durationMinutes || 480;
  const computedEnd = m.endTime || fromMinSafe(startMin + dur);
  return [
    {
      id: 'P-DEFAULT',
      code: 'DEFAULT',
      name: 'فترة التكليف',
      startTime: m.startTime || '12:00',
      endTime: computedEnd,
      durationMinutes: dur,
      dayOffset: toMin(computedEnd) <= startMin ? 1 : 0,
      driversNeeded: m.driversNeeded || 1,
      driverCategory: m.driverCategory || 'ALL',
      orderIndex: 0
    }
  ];
}

export async function listMissions(includeDisabled = false) {
  let r = await all('missions');
  if (!includeDisabled) r = r.filter(m => m.isActive !== false);
  return r.sort((a, b) => toMin(a.startTime) - toMin(b.startTime) || a.id - b.id);
}

export async function getMission(id) {
  if (!id) return null;
  return get('missions', Number(id));
}

export async function getMissionByCode(code) {
  const rows = await all('missions');
  return rows.find(m => m.code === code) || null;
}

export async function createMission(m) {
  requireWrite('mission.create');
  const periods = Array.isArray(m.periods) && m.periods.length > 0 ? m.periods : null;
  const totalDrivers = periods ? periods.reduce((s, p) => s + (Number(p.driversNeeded) || 1), 0) : (m.driversNeeded ?? 1);
  const id = await put('missions', {
    code: m.code || ('M' + Date.now()),
    name: m.name,
    type: m.type || (periods ? MISSION_TYPE.MULTI_SHIFT : MISSION_TYPE.NORMAL),
    startTime: m.startTime,
    durationMinutes: m.durationMinutes,
    driversNeeded: totalDrivers,
    locationType: m.locationType ?? 'outdoor',
    teamId: m.teamId ? Number(m.teamId) : null,
    periods: periods,
    notes: m.notes ?? '',
    isActive: true,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  await audit({ entity: 'missions', entityId: id, action: 'create', newValue: m });
  return id;
}

export async function editMission(id, patch) {
  requireWrite('mission.edit');
  const m = await get('missions', Number(id));
  if (!m) throw new Error('المهمة غير موجودة');
  const next = { ...m, ...patch, updatedAt: nowIso() };
  if (Array.isArray(next.periods) && next.periods.length > 0) {
    next.driversNeeded = next.periods.reduce((s, p) => s + (Number(p.driversNeeded) || 1), 0);
  }
  await put('missions', next);
  await audit({ entity: 'missions', entityId: id, action: 'edit', oldValue: m, newValue: patch });
  return next;
}

export async function disableMission(id) {
  requireWrite('mission.disable');
  const m = await get('missions', Number(id));
  if (!m) return;
  await put('missions', { ...m, isActive: false, updatedAt: nowIso() });
  await audit({ entity: 'missions', entityId: id, action: 'disable' });
}

export async function seedCatalog() {
  requireWrite('mission.seed');
  const existing = await all('missions');
  for (const m of SAMPLE_CATALOG) {
    if (existing.find(x => x.code === m.code)) continue;
    await createMission(m);
  }
}
