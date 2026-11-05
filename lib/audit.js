'use strict';
/**
 * 操作日志 —— 只记「谁在什么时候对什么做了什么」，不做业务判定。
 */

const store = require('./store');

const MAX_ROWS = 5000;

function add(user, action, target, detail, ip) {
  const list = store.table('audit');
  list.push({
    id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    userId: user ? user.id : '',
    userName: user ? user.name : '匿名',
    userRole: user ? user.roleName : '',
    deptName: user ? user.deptName : '',
    action: String(action || 'unknown'),
    target: String(target || '').slice(0, 120),
    detail: String(detail || '').slice(0, 400),
    ip: String(ip || '').slice(0, 60)
  });
  if (list.length > MAX_ROWS) list.splice(0, list.length - MAX_ROWS);
  store.commit();
}

function list(options) {
  const opt = options || {};
  const limit = Math.max(1, Math.min(500, parseInt(opt.limit, 10) || 100));
  let rows = store.table('audit').slice().reverse();
  if (opt.action) rows = rows.filter(r => r.action === opt.action);
  if (opt.q) {
    const q = String(opt.q).toLowerCase();
    rows = rows.filter(r =>
      (r.userName + r.target + r.detail + r.action).toLowerCase().indexOf(q) >= 0
    );
  }
  return { rows: rows.slice(0, limit), total: rows.length };
}

module.exports = { add, list };
