'use strict';
/**
 * 会议室 —— 基础信息 + 与邀请绑定的占用视图。
 * 一个房间同一时段只允许一条有效邀请，除非创建时显式选择「仍要使用」。
 */

const store = require('./store');

function roomList() {
  return store.table('rooms').slice().sort((a, b) => {
    const f = String(a.building || '').localeCompare(String(b.building || ''));
    if (f) return f;
    const fl = (parseInt(a.floor, 10) || 0) - (parseInt(b.floor, 10) || 0);
    if (fl) return fl;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function roomById(id) {
  return store.table('rooms').find(r => r.id === id) || null;
}

function roomSave(input, id) {
  const name = String(input.name || '').trim();
  if (!name) return { error: '会议室名称不能为空' };
  const list = store.table('rooms');
  const data = {
    name: name,
    building: String(input.building || '').trim(),
    floor: String(input.floor || '').trim(),
    capacity: Math.max(1, Math.min(500, parseInt(input.capacity, 10) || 1)),
    equipment: Array.isArray(input.equipment) ? input.equipment.slice(0, 12).map(String) : [],
    status: input.status === 'disabled' ? 'disabled' : 'active',
    note: String(input.note || '').slice(0, 160)
  };

  if (id) {
    const row = list.find(r => r.id === id);
    if (!row) return { error: '会议室不存在' };
    Object.assign(row, data, { updatedAt: Date.now() });
    store.commit();
    return { ok: true, room: row };
  }

  const row = Object.assign({
    id: 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    createdAt: Date.now()
  }, data);
  list.push(row);
  store.commit();
  return { ok: true, room: row };
}

function roomRemove(id) {
  const list = store.table('rooms');
  const row = list.find(r => r.id === id);
  if (!row) return { error: '会议室不存在' };
  if (store.table('invites').some(i => i.roomId === id && i.status === 'active' && i.validTo > Date.now())) {
    return { error: '还有未结束的邀请占用该会议室，先撤销或换房间' };
  }
  list.splice(list.indexOf(row), 1);
  store.commit();
  return { ok: true };
}

/** 与 [from,to) 重叠的有效邀请 */
function conflicts(roomId, from, to, excludeToken) {
  if (!roomId) return [];
  return store.table('invites').filter(inv =>
    inv.roomId === roomId &&
    inv.token !== excludeToken &&
    inv.status === 'active' &&
    inv.validFrom < to &&
    inv.validTo > from
  ).map(inv => ({
    token: inv.token,
    code: inv.code,
    guestName: inv.guestName,
    company: inv.company,
    hostName: inv.hostName,
    validFrom: inv.validFrom,
    validTo: inv.validTo
  }));
}

/** 某天各房间的占用情况 */
function schedule(dateStr, fromTs, toTs) {
  const invites = store.table('invites').filter(inv =>
    inv.roomId &&
    inv.status === 'active' &&
    inv.validFrom < toTs &&
    inv.validTo > fromTs
  );
  return roomList().map(room => {
    const items = invites
      .filter(inv => inv.roomId === room.id)
      .sort((a, b) => a.validFrom - b.validFrom)
      .map(inv => ({
        token: inv.token,
        code: inv.code,
        guestName: inv.guestName,
        company: inv.company,
        hostName: inv.hostName,
        validFrom: inv.validFrom,
        validTo: inv.validTo,
        quota: inv.quota
      }));
    return Object.assign({}, room, { date: dateStr, items: items, busy: items.length > 0 });
  });
}

module.exports = { roomList, roomById, roomSave, roomRemove, conflicts, schedule };
