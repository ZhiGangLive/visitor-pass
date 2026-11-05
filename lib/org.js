'use strict';
/**
 * 组织与账号 —— 部门树、成员、角色。
 */

const store = require('./store');
const auth = require('./auth');

/* ---------------- 部门 ---------------- */

function deptList() {
  return store.table('departments').slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
}

function deptById(id) {
  return store.table('departments').find(d => d.id === id) || null;
}

function deptTree() {
  const all = deptList();
  const map = {};
  all.forEach(d => { map[d.id] = Object.assign({}, d, { children: [], memberCount: 0 }); });
  const users = store.table('users');
  users.forEach(u => { if (map[u.deptId]) map[u.deptId].memberCount += 1; });
  const roots = [];
  all.forEach(d => {
    const node = map[d.id];
    if (d.parentId && map[d.parentId]) map[d.parentId].children.push(node);
    else roots.push(node);
  });
  return roots;
}

/** 本部门 + 所有下级部门的 id 集合 */
function deptSubtreeIds(deptId) {
  const all = store.table('departments');
  const out = new Set([deptId]);
  let added = true;
  while (added) {
    added = false;
    all.forEach(d => {
      if (d.parentId && out.has(d.parentId) && !out.has(d.id)) { out.add(d.id); added = true; }
    });
  }
  return out;
}

function deptSave(input, id) {
  const name = String(input.name || '').trim();
  if (!name) return { error: '部门名称不能为空' };
  const list = store.table('departments');

  if (id) {
    const row = list.find(d => d.id === id);
    if (!row) return { error: '部门不存在' };
    if (input.parentId === id) return { error: '上级部门不能是自己' };
    if (input.parentId && deptSubtreeIds(id).has(input.parentId)) {
      return { error: '上级部门不能是自己的下级' };
    }
    Object.assign(row, {
      name: name,
      parentId: String(input.parentId || ''),
      leaderId: String(input.leaderId || ''),
      note: String(input.note || '').slice(0, 120),
      sort: parseInt(input.sort, 10) || 0
    });
    store.commit();
    return { ok: true, department: row };
  }

  const row = {
    id: 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    name: name,
    parentId: String(input.parentId || ''),
    leaderId: String(input.leaderId || ''),
    note: String(input.note || '').slice(0, 120),
    sort: parseInt(input.sort, 10) || 0,
    createdAt: Date.now()
  };
  list.push(row);
  store.commit();
  return { ok: true, department: row };
}

function deptRemove(id) {
  const list = store.table('departments');
  const row = list.find(d => d.id === id);
  if (!row) return { error: '部门不存在' };
  if (list.some(d => d.parentId === id)) return { error: '还有下级部门，先处理下级' };
  if (store.table('users').some(u => u.deptId === id)) return { error: '还有成员在该部门，先调整成员' };
  if (store.table('invites').some(i => i.deptId === id)) return { error: '该部门有历史邀请记录，不能删除' };
  list.splice(list.indexOf(row), 1);
  store.commit();
  return { ok: true };
}

/* ---------------- 角色 ---------------- */

function roleList() {
  return store.table('roles').slice();
}

function roleByKey(key) {
  return store.table('roles').find(r => r.key === key) || null;
}

function normalizePerms(perms) {
  if (!Array.isArray(perms)) return [];
  return perms.filter(p => auth.PERM_KEYS.indexOf(p) >= 0 || p === '*');
}

function roleSave(input, key) {
  const name = String(input.name || '').trim();
  if (!name) return { error: '角色名称不能为空' };
  const list = store.table('roles');
  const scope = ['self', 'dept', 'all'].indexOf(input.scope) >= 0 ? input.scope : 'self';

  if (key) {
    const row = list.find(r => r.key === key);
    if (!row) return { error: '角色不存在' };
    row.name = name;
    if (row.key === 'admin') {
      row.perms = ['*'];
      row.scope = 'all';
    } else {
      row.perms = normalizePerms(input.perms);
      row.scope = scope;
    }
    row.note = String(input.note || '').slice(0, 120);
    store.commit();
    return { ok: true, role: row };
  }

  const newKey = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  const row = {
    key: newKey,
    name: name,
    perms: normalizePerms(input.perms),
    scope: scope,
    note: String(input.note || '').slice(0, 120),
    builtin: false,
    createdAt: Date.now()
  };
  list.push(row);
  store.commit();
  return { ok: true, role: row };
}

function roleRemove(key) {
  const list = store.table('roles');
  const row = list.find(r => r.key === key);
  if (!row) return { error: '角色不存在' };
  if (row.builtin) return { error: '内置角色不能删除' };
  if (store.table('users').some(u => u.roleKey === key)) return { error: '还有账号使用该角色' };
  list.splice(list.indexOf(row), 1);
  store.commit();
  return { ok: true };
}

/* ---------------- 成员 ---------------- */

function userSafe(u) {
  if (!u) return null;
  const dept = deptById(u.deptId);
  const role = roleByKey(u.roleKey);
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    title: u.title || '',
    phone: u.phone || '',
    email: u.email || '',
    deptId: u.deptId || '',
    deptName: dept ? dept.name : '',
    roleKey: u.roleKey,
    roleName: role ? role.name : '',
    status: u.status || 'active',
    createdAt: u.createdAt || 0,
    lastLoginAt: u.lastLoginAt || 0,
    mustChangePassword: !!u.mustChangePassword
  };
}

function userList(filter) {
  const f = filter || {};
  let rows = store.table('users').slice();
  if (f.deptId) {
    const set = deptSubtreeIds(f.deptId);
    rows = rows.filter(u => set.has(u.deptId));
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    rows = rows.filter(u =>
      (u.name + u.username + u.title + u.phone).toLowerCase().indexOf(q) >= 0
    );
  }
  if (f.status) rows = rows.filter(u => (u.status || 'active') === f.status);
  return rows.map(userSafe);
}

function userSave(input, id) {
  const list = store.table('users');
  const name = String(input.name || '').trim();
  if (!name) return { error: '姓名不能为空' };

  const deptId = String(input.deptId || '');
  if (deptId && !deptById(deptId)) return { error: '部门不存在' };
  const roleKey = String(input.roleKey || 'staff');
  if (!roleByKey(roleKey)) return { error: '角色不存在' };
  const status = input.status === 'disabled' ? 'disabled' : 'active';

  if (id) {
    const row = list.find(u => u.id === id);
    if (!row) return { error: '成员不存在' };
    if (row.username === 'admin' && (roleKey !== 'admin' || status !== 'active')) {
      return { error: '内置 admin 账号的角色和状态不能修改' };
    }
    row.name = name;
    row.title = String(input.title || '').trim().slice(0, 40);
    row.phone = String(input.phone || '').trim().slice(0, 20);
    row.email = String(input.email || '').trim().slice(0, 80);
    row.deptId = deptId;
    row.roleKey = roleKey;
    row.status = status;
    row.updatedAt = Date.now();
    if (status === 'disabled') auth.destroyUserSessions(row.id);
    store.commit();
    return { ok: true, user: userSafe(row) };
  }

  const username = String(input.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,24}$/.test(username)) {
    return { error: '账号需 3-24 位，只能用小写字母、数字、点、下划线、横线' };
  }
  if (list.some(u => u.username === username)) return { error: '账号已存在' };
  const password = String(input.password || '');
  if (password.length < 6) return { error: '初始密码至少 6 位' };

  const row = {
    id: 'U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    username: username,
    passwordHash: auth.hashPassword(password),
    name: name,
    title: String(input.title || '').trim().slice(0, 40),
    phone: String(input.phone || '').trim().slice(0, 20),
    email: String(input.email || '').trim().slice(0, 80),
    deptId: deptId,
    roleKey: roleKey,
    status: status,
    mustChangePassword: true,
    createdAt: Date.now(),
    lastLoginAt: 0
  };
  list.push(row);
  store.commit();
  return { ok: true, user: userSafe(row) };
}

function userRemove(id) {
  const list = store.table('users');
  const row = list.find(u => u.id === id);
  if (!row) return { error: '成员不存在' };
  if (row.username === 'admin') return { error: '内置 admin 账号不能删除' };
  if (store.table('invites').some(i => i.hostUserId === id)) {
    row.status = 'disabled';
    auth.destroyUserSessions(row.id);
    store.commit();
    return { ok: true, disabled: true, message: '该成员有历史邀请记录，已改为停用而非删除' };
  }
  list.splice(list.indexOf(row), 1);
  auth.destroyUserSessions(id);
  store.commit();
  return { ok: true };
}

function resetPassword(id, newPassword) {
  const row = store.table('users').find(u => u.id === id);
  if (!row) return { error: '成员不存在' };
  const pw = String(newPassword || '');
  if (pw.length < 6) return { error: '密码至少 6 位' };
  row.passwordHash = auth.hashPassword(pw);
  row.mustChangePassword = true;
  store.commit();
  auth.destroyUserSessions(id);
  return { ok: true };
}

function changeOwnPassword(userId, oldPw, newPw) {
  const row = store.table('users').find(u => u.id === userId);
  if (!row) return { error: '账号不存在' };
  if (!auth.verifyPassword(oldPw, row.passwordHash)) return { error: '原密码不正确' };
  if (String(newPw || '').length < 8) return { error: '新密码至少 8 位' };
  if (oldPw === newPw) return { error: '新密码不能与原密码相同' };
  row.passwordHash = auth.hashPassword(newPw);
  row.mustChangePassword = false;
  row.updatedAt = Date.now();
  store.commit();
  auth.destroyUserSessions(userId);
  return { ok: true };
}

module.exports = {
  deptList, deptById, deptTree, deptSubtreeIds, deptSave, deptRemove,
  roleList, roleByKey, roleSave, roleRemove,
  userList, userSafe, userSave, userRemove, resetPassword, changeOwnPassword
};
