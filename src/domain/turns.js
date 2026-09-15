import { put, all } from '../core/db.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/audit.js';
import { requireWrite } from '../core/auth.js';

export async function getQueue(missionId, periodId = null) {
  const rows = await all('turns');
  return rows.find(r =>
    Number(r.missionId) === Number(missionId) &&
    String(r.periodId || '') === String(periodId || '')
  ) || null;
}

export async function initQueue({ missionId, periodId = null, initialOrder, reason = 'Initial Order' }) {
  requireWrite('turn.init');
  const existing = await getQueue(missionId, periodId);
  if (existing) return existing;
  const id = await put('turns', {
    missionId, periodId: periodId ?? null,
    queue: [...initialOrder],
    lastDone: {}, counts: {},
    createdAt: nowIso(), updatedAt: nowIso()
  });
  await audit({ entity:'turns', entityId:id, action:'init',
    newValue:{ queue:initialOrder, reason } });
  return { id, missionId, periodId, queue: [...initialOrder], lastDone:{}, counts:{} };
}

export async function ensureQueue(missionId, periodId, allDriverIds) {
  const q = await getQueue(missionId, periodId);
  if (q) {
    const missing = (allDriverIds || []).filter(id => !q.queue.includes(id));
    if (missing.length > 0) {
      const updatedQueue = [...q.queue, ...missing];
      await put('turns', { ...q, queue: updatedQueue, updatedAt: nowIso() });
      q.queue = updatedQueue;
    }
    return q;
  }
  return initQueue({ missionId, periodId, initialOrder: allDriverIds || [],
    reason: 'بناء تلقائي' });
}

export async function recordExecution({ missionId, periodId = null, driverId, at, assignmentId }) {
  const q = await getQueue(missionId, periodId);
  if (!q) throw new Error('لا توجد قائمة دور');
  const dId = Number(driverId);
  const queue = (q.queue || []).map(Number).filter(x => x !== dId);
  queue.push(dId);
  const lastDone = { ...(q.lastDone || {}) };
  lastDone[dId] = at;
  const counts = { ...(q.counts || {}) };
  counts[dId] = (counts[dId] || 0) + 1;
  await put('turns', { ...q, queue, lastDone, counts, updatedAt: nowIso() });
  await audit({ entity:'turns', entityId:q.id, action:'executed',
    newValue:{ driverId: dId, at, assignmentId } });
}

export function dueOf(q) {
  if (!q || !q.queue || !q.queue.length) return null;
  return q.queue[0];
}

export function statsOf(q, driverId) {
  if (!q) return { lastDone:null, count:0, position:-1 };
  return {
    lastDone: q.lastDone?.[driverId] || null,
    count: q.counts?.[driverId] || 0,
    position: q.queue.indexOf(driverId)
  };
}

export async function getTurnInfo(missionId, periodId) {
  const q = await getQueue(missionId, periodId);
  if (!q) return null;
  const drivers = await all('drivers');
  const driverMap = new Map(drivers.map(d => [d.id, d]));
  const queue = q.queue.map((driverId, idx) => {
    const d = driverMap.get(driverId);
    if (!d) return null;
    return { driverId, driver: d, position: idx,
      isDue: idx === 0,
      lastDone: q.lastDone?.[driverId] || null,
      count: q.counts?.[driverId] || 0 };
  }).filter(Boolean);
  return { queue, due: queue[0] || null, size: queue.length,
    missionId, periodId };
}

export async function reorderQueue({ missionId, periodId, newQueue, reason }) {
  requireWrite('turn.reorder');
  if (!reason || !reason.trim()) throw new Error('السبب مطلوب');
  const q = await getQueue(missionId, periodId);
  if (!q) throw new Error('لا توجد قائمة');
  await put('turns', { ...q, queue: [...newQueue], updatedAt: nowIso() });
  await audit({ entity:'turns', entityId:q.id, action:'reorder',
    oldValue:q.queue, newValue:newQueue, reason });
}
