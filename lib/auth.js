'use strict';
/**
 * 认证与授权 —— 口令哈希、会话、角色权限、登录限流。
 * 所有判定在服务端，前端拿到的 perms 只用于隐藏按钮。
 */

const crypto = require('crypto');
const store = require('./store');

/* ---------------- 权限目录 ---------------- */

const PERMS = [
  { key: 'invite.create',      name: '发起邀请',        group: '邀请' },
  { key: 'invite.view.self',   name: '查看本人邀请',    group: '邀请' },
  { key: 'invite.view.dept',   name: '查看本部门邀请',  group: '邀请' },
  { key: 'invite.view.all',    name: '查看全部邀请',    group: '邀请' },
  { key: 'invite.revoke',      name: '撤销邀请',        group: '邀请' },
  { key: 'invite.extend',      name: '延期 / 续期',     group: '邀请' },
  { key: 'guard.verify',       name: '门岗核验',        group: '门岗' },
  { key: 'ledger.view',        name: '查看通行台账',    group: '门岗' },
  { key: 'ledger.export',      name: '导出台账',        group: '门岗' },
  { key: 'staff.view',         name: '查看人员架构',    group: '组织' },
  { key: 'staff.manage',       name: '管理机构与人员',  group: '组织' },
  { key: 'room.view',          name: '查看会议室',      group: '资源' },
  { key: 'room.manage',        name: '管理会议室',      group: '资源' },
  { key: 'role.manage',        name: '角色与权限配置',  group: '系统' },
  { key: 'audit.view',         name: '查看操作日志',    group: '系统' },
  { key: 'system.manage',      name: '系统设置',        group: '系统' }
];

const PERM_KEYS = PERMS.map(p => p.key);

const SCOPES = [
  { key: 'self', name: '仅本人' },
  { key: 'dept', name: '本部门及下级' },
  { key: 'all',  name: '全部' }
];

/* ---------------- 口令 ---------------- */

const SCRYPT_KEYLEN = 64;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let calc;
  try {
    calc = crypto.scryptSync(String(plain), parts[1], SCRYPT_KEYLEN);
  } catch (_) {
    return false;
  }
  const want = Buffer.from(parts[2], 'hex');
  if (want.length !== calc.length) return false;
  return crypto.timingSafeEqual(want, calc);
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 24).toString('hex');
}

/* ---------------- 会话 ---------------- */

const SESSION_COOKIE = 'vp_sid';
const DEFAULT_TTL = 12 * 3600 * 1000;        /* 12 小时 */
const REMEMBER_TTL = 30 * 24 * 3600 * 1000;  /* 30 天 */

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cleanupSessions() {
  const now = Date.now();
  const list = store.table('sessions');
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i] || list[i].expiresAt < now) list.splice(i, 1);
  }
}

function createSession(user, remember, ip, ua) {
  cleanupSessions();
  const ttl = remember ? REMEMBER_TTL : DEFAULT_TTL;
  const row = {
    token: randomToken(24),
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    ip: String(ip || '').slice(0, 60),
    ua: String(ua || '').slice(0, 160)
  };
  store.table('sessions').push(row);
  store.commit();
  return row;
}

function destroySession(token) {
  const list = store.table('sessions');
  const i = list.findIndex(s => s.token === token);
  if (i >= 0) {
    list.splice(i, 1);
    store.commit();
  }
}

function destroyUserSessions(userId, exceptToken) {
  const list = store.table('sessions');
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].userId === userId && list[i].token !== exceptToken) list.splice(i, 1);
  }
  store.commit();
}

function roleOf(user) {
  const roles = store.table('roles');
  return roles.find(r => r.key === user.roleKey) || null;
}

/** 返回带 role / perms / deptName 的用户视图，找不到返回 null */
function hydrate(user) {
  if (!user) return null;
  const st = store.data();
  const role = st.roles.find(r => r.key === user.roleKey) || null;
  const dept = st.departments.find(d => d.id === user.deptId) || null;
  const perms = role ? (role.perms || []).slice() : [];
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    title: user.title || '',
    phone: user.phone || '',
    email: user.email || '',
    deptId: user.deptId || '',
    deptName: dept ? dept.name : '',
    roleKey: user.roleKey,
    roleName: role ? role.name : '',
    scope: role ? role.scope : 'self',
    perms: perms,
    status: user.status || 'active',
    mustChangePassword: !!user.mustChangePassword,
    lastLoginAt: user.lastLoginAt || 0
  };
}

/** 从请求里取出当前登录用户（含权限） */
function currentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE] || '';
  if (!token) return null;
  const sessions = store.table('sessions');
  const s = sessions.find(x => x.token === token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    destroySession(token);
    return null;
  }
  const user = store.table('users').find(u => u.id === s.userId);
  if (!user || user.status !== 'active') return null;
  const view = hydrate(user);
  view.sessionToken = token;
  return view;
}

function cookieHeader(token, remember) {
  const maxAge = Math.floor((remember ? REMEMBER_TTL : DEFAULT_TTL) / 1000);
  return SESSION_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

function clearCookieHeader() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* ---------------- 权限判定 ---------------- */

function can(user, perm) {
  if (!user || !user.perms) return false;
  return user.perms.indexOf('*') >= 0 || user.perms.indexOf(perm) >= 0;
}

function canAny(user, perms) {
  return perms.some(p => can(user, p));
}

function isAdmin(user) {
  return can(user, '*') || (user && user.roleKey === 'admin');
}

/* ---------------- 登录限流 ---------------- */

const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_MAX_FAIL = 5;
const loginFails = new Map();   /* key: username|ip → {count, first, lockedUntil} */

function loginKey(username, ip) {
  return String(username || '').toLowerCase() + '|' + String(ip || '');
}

function loginLocked(username, ip) {
  const rec = loginFails.get(loginKey(username, ip));
  if (!rec) return 0;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return rec.lockedUntil;
  return 0;
}

function noteLoginFail(username, ip) {
  const key = loginKey(username, ip);
  const now = Date.now();
  let rec = loginFails.get(key);
  if (!rec || now - rec.first > LOGIN_WINDOW) rec = { count: 0, first: now, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAIL) {
    rec.lockedUntil = now + 5 * 60 * 1000;
    rec.count = 0;
    rec.first = now;
  }
  loginFails.set(key, rec);
}

function clearLoginFail(username, ip) {
  loginFails.delete(loginKey(username, ip));
}

module.exports = {
  PERMS, PERM_KEYS, SCOPES,
  hashPassword, verifyPassword, randomToken,
  createSession, destroySession, destroyUserSessions, currentUser,
  cookieHeader, clearCookieHeader, hydrate, roleOf,
  can, canAny, isAdmin,
  loginLocked, noteLoginFail, clearLoginFail,
  cleanupSessions, parseCookies,
  SESSION_COOKIE
};
