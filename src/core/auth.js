import { get, put, all } from './db.js';

export const ROLES = { LEADER:'LEADER', DEPUTY:'DEPUTY', DRIVER:'DRIVER' };

export const ROLE_LABEL = {
  LEADER:'قائد فرقة السواق',
  DEPUTY:'نائب قائد فرقة السواق',
  DRIVER:'السواق'
};

const KEY = 'sowa9.session';

export function getSession() {
  try {
    const r = sessionStorage.getItem(KEY);
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
export function setSession(s) { sessionStorage.setItem(KEY, JSON.stringify(s)); }
export function clearSession() { sessionStorage.removeItem(KEY); }

export function isLeader() {
  const s = getSession();
  return s && s.role === ROLES.LEADER;
}
export function isManager() {
  const s = getSession();
  return s && (s.role === ROLES.LEADER || s.role === ROLES.DEPUTY);
}
export function isReadOnly() { return !isManager(); }

export function requireWrite(action = 'write') {
  if (!isManager()) throw new Error(`صلاحية مرفوضة: ${action}`);
  return getSession();
}
export function requireLeader(action = 'leader') {
  if (!isLeader()) throw new Error(`صلاحية مرفوضة: ${action}`);
  return getSession();
}

const DEFAULTS = { schemaVersion: 1, restMinHours: 8 };

export async function getSetting(k) {
  const r = await get('settings', k);
  return r ? r.value : DEFAULTS[k];
}

export async function allSettings() {
  const rows = await all('settings');
  const m = { ...DEFAULTS };
  for (const r of rows) m[r.key] = r.value;
  return m;
}

export async function setSetting(k, v) {
  requireLeader('settings');
  await put('settings', { key: k, value: v });
}

export async function ensureDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const r = await get('settings', k);
    if (!r) await put('settings', { key: k, value: v });
  }
}
