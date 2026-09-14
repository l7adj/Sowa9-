import { all, get, put } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export const DEFAULT_TEAMS = [
  { id: 1, name: 'فرقة أ — الميدانية', code: 'TEAM-A', color: '#2563eb', badge: 'الفريق أ' },
  { id: 2, name: 'فرقة ب — الإسناد والنقل', code: 'TEAM-B', color: '#059669', badge: 'الفريق ب' },
  { id: 3, name: 'فرقة ج — التدخل السريع', code: 'TEAM-C', color: '#d97706', badge: 'الفريق ج' }
];

export async function listTeams() {
  const r = await all('teams');
  if (r.length === 0) {
    // Auto-seed default teams if none exist
    for (const t of DEFAULT_TEAMS) {
      await put('teams', { ...t, createdAt: nowIso(), updatedAt: nowIso() });
    }
    return all('teams');
  }
  return r.sort((a, b) => a.id - b.id);
}

export async function getTeam(id) {
  if (!id) return null;
  return get('teams', Number(id));
}

export async function createTeam({ name, code, color = '#2563eb', badge = '' }) {
  requireWrite('team.create');
  if (!name || !name.trim()) throw new Error('اسم الفريق مطلوب');
  const id = await put('teams', {
    name: name.trim(),
    code: (code || ('T-' + Date.now())).trim().toUpperCase(),
    color,
    badge: badge || name.trim().slice(0, 10),
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  await audit({ entity: 'teams', entityId: id, action: 'create', newValue: { name, code } });
  return id;
}

export async function editTeam(id, patch) {
  requireWrite('team.edit');
  const t = await get('teams', Number(id));
  if (!t) throw new Error('الفريق غير موجود');
  const next = { ...t, ...patch, updatedAt: nowIso() };
  await put('teams', next);
  await audit({ entity: 'teams', entityId: id, action: 'edit', oldValue: t, newValue: patch });
  return next;
}
