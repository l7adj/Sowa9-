import { put } from './db.js';
import { nowIso } from './clock.js';
import { getSession } from './auth.js';

export async function audit({ entity, entityId, action, oldValue, newValue, reason }) {
  const s = getSession();
  return put('audit', {
    ts: nowIso(),
    actorRole: s?.role ?? null,
    entity,
    entityId: entityId ?? null,
    action,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    reason: reason ?? null
  });
}
