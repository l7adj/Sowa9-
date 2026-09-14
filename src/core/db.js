const NAME = 'sowa9';
const VER = 2;

export const STORES = {
  teams:           { key: 'id', auto: true, idx: ['name'] },
  drivers:         { key: 'id', auto: true, idx: ['status', 'teamId'] },
  missions:        { key: 'id', auto: true, idx: ['code'] },
  occurrences:     { key: 'id', auto: true, idx: ['dateIso', 'missionId'] },
  assignments:     { key: 'id', auto: true, idx: ['occurrenceId', 'status', 'periodId', 'dueDriverId', 'plannedDriverId', 'actualDriverId'] },
  loans:           { key: 'id', auto: true, idx: ['fromTeamId', 'toTeamId', 'driverId', 'dateIso'] },
  shortages:       { key: 'id', auto: true, idx: ['occurrenceId', 'periodId', 'dateIso'] },
  turns:           { key: 'id', auto: true, idx: ['missionId'] },
  missed_turns:    { key: 'id', auto: true, idx: ['driverId', 'missionId'] },
  status_history:  { key: 'id', auto: true, idx: ['driverId'] },
  audit:           { key: 'id', auto: true, idx: ['entity', 'ts'] },
  settings:        { key: 'key', auto: false, idx: [] },
  _backup:         { key: 'slot', auto: false, idx: [] }
};

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      for (const [n, c] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(n)) continue;
        const s = db.createObjectStore(n, {
          keyPath: c.key, autoIncrement: c.auto
        });
        for (const ix of c.idx) {
          if (!s.indexNames.contains(ix))
            s.createIndex(ix, ix, { unique: false });
        }
      }
    };
    r.onsuccess = () => {
      _db = r.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      res(_db);
    };
    r.onerror = () => rej(r.error);
  });
}

export async function get(s, k) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s).objectStore(s).get(k);
    q.onsuccess = () => r(q.result ?? null);
    q.onerror = () => j(q.error);
  });
}

export async function all(s) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s).objectStore(s).getAll();
    q.onsuccess = () => r(q.result ?? []);
    q.onerror = () => j(q.error);
  });
}

export async function byIdx(s, ix, v) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s).objectStore(s).index(ix).getAll(v);
    q.onsuccess = () => r(q.result ?? []);
    q.onerror = () => j(q.error);
  });
}

export async function put(s, o) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s, 'readwrite').objectStore(s).put(o);
    q.onsuccess = () => r(q.result);
    q.onerror = () => j(q.error);
  });
}

export async function putMany(s, arr) {
  const db = await openDB();
  return new Promise((r, j) => {
    const t = db.transaction(s, 'readwrite');
    const st = t.objectStore(s);
    for (const o of arr) st.put(o);
    t.oncomplete = () => r(true);
    t.onerror = () => j(t.error);
  });
}

// مبدأ عدم الحذف
export async function hardDelete() {
  throw new Error('الحذف ممنوع — استخدم CANCELLED أو DISABLED');
}

// مسح مع استثناء (يُستخدم في الاستيراد مع إبقاء _backup)
export async function wipe(exceptStores = []) {
  const db = await openDB();
  const toWipe = Object.keys(STORES).filter(n => !exceptStores.includes(n));
  return new Promise((r, j) => {
    const t = db.transaction(toWipe, 'readwrite');
    for (const n of toWipe) t.objectStore(n).clear();
    t.oncomplete = () => r(true);
    t.onerror = () => j(t.error);
  });
}
