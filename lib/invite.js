'use strict';
/**
 * 业务规则 —— 邀请创建、核验判定、撤销、延期、台账。
 * 所有判定都在服务端，前端拿到什么就显示什么，改不了结果。
 */

const store = require('./store');
const auth = require('./auth');
const org = require('./org');
const rooms = require('./rooms');
const audit = require('./audit');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* 去掉 I O 0 1 易混字符 */

/* 卡面样式：与前端 CARD_STYLES 一一对应 */
const STYLE_KEYS = ['ticket', 'minimal', 'noir', 'jade'];
const STYLE_NAMES = { ticket: '票券', minimal: '极简白', noir: '墨金', jade: '青玉' };

/* ---------------- 时间工具（统一本地时区） ---------------- */

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function dateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function timeKey(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function hhmm(ts) {
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function mdhm(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hhmm(ts);
}
function endOfToday(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}
function parseDate(str, endOfDay) {
  if (!str) return NaN;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, 0);
  return d.getTime();
}

/* ---------------- 凭证号 / 邀请码 ---------------- */

function randomChars(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return s;
}

function makeToken() {
  const d = new Date();
  let token;
  let guard = 0;
  do {
    token = 'SL' + pad(d.getMonth() + 1) + pad(d.getDate()) + randomChars(6);
    guard++;
  } while (store.table('invites').some(i => i.token === token) && guard < 50);
  return token;
}

/* 邀请码：4 位数字，未过期的邀请之间不重复 */
function makeCode() {
  const now = Date.now();
  const used = {};
  store.table('invites').forEach(inv => {
    if (inv.validTo > now - 86400000) used[inv.code] = 1;
  });
  let code;
  let guard = 0;
  do {
    code = String(1000 + Math.floor(Math.random() * 9000));
    guard++;
  } while (used[code] && guard < 9000);
  return code;
}

function findByCode(code) {
  const now = Date.now();
  const hits = store.table('invites').filter(i => i.code === code);
  if (!hits.length) return null;
  const valid = hits.filter(i => i.status !== 'revoked' && i.validFrom <= now && i.validTo >= now);
  if (valid.length) return valid.sort((a, b) => b.createdAt - a.createdAt)[0];
  return hits.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/* ---------------- 状态 ---------------- */

function statusOf(inv, now) {
  const t = now || Date.now();
  if (inv.status === 'revoked') return 'revoked';
  if (t < inv.validFrom) return 'pending';
  if (t > inv.validTo) return 'expired';
  if (inv.usedCount >= inv.quota) return 'used';
  return 'active';
}

const STATUS_TEXT = {
  pending: '待生效',
  active: '有效',
  used: '名额已满',
  expired: '已过期',
  revoked: '已撤销'
};

/* ---------------- 创建 ---------------- */

function createInvite(input, user) {
  const now = Date.now();

  const guestName = String(input.guestName || '').trim();
  const reason = String(input.reason || '').trim();
  if (!guestName) return { error: '访客姓名不能为空' };
  if (reason.length < 1) return { error: '来访事由不能为空' };

  const quota = Math.max(1, Math.min(99, parseInt(input.quota, 10) || 1));

  let validFrom;
  let validTo;
  if (input.validFrom && input.validTo) {
    validFrom = Number(input.validFrom);
    validTo = Number(input.validTo);
  } else if (input.date) {
    const from = parseDate(input.date, false);
    const to = parseDate(input.date, true);
    validFrom = from;
    validTo = to;
  } else {
    validFrom = now;
    if (input.duration === 'today' || input.duration === undefined) {
      validTo = endOfToday(now);
    } else {
      const sec = Math.max(60, Math.min(30 * 24 * 3600, parseInt(input.duration, 10) || 7200));
      validTo = now + sec * 1000;
    }
  }
  if (!isFinite(validFrom) || !isFinite(validTo)) return { error: '有效期格式不正确' };
  if (validTo <= validFrom) return { error: '结束时间必须晚于开始时间' };
  if (validTo - validFrom > 30 * 24 * 3600 * 1000) return { error: '单张邀请最长 30 天' };

  /* 邀请人固定为当前登录账号本人，不接受前端指定他人 */
  const host = user;

  const roomId = String(input.roomId || '');
  let room = null;
  if (roomId) {
    room = rooms.roomById(roomId);
    if (!room) return { error: '会议室不存在' };
    if (room.status === 'disabled') return { error: '该会议室已停用' };
    const busy = rooms.conflicts(roomId, validFrom, validTo);
    if (busy.length && !input.force) {
      return { conflict: true, error: '该会议室在所选时段已被占用', busy: busy };
    }
  }

  const row = {
    token: makeToken(),
    code: makeCode(),
    guestName: guestName.slice(0, 40),
    company: String(input.company || '').trim().slice(0, 60),
    reason: reason.slice(0, 80),
    note: String(input.note || '').trim().slice(0, 200),
    hostUserId: host.id,
    hostName: host.name,
    hostTitle: host.title || '',
    deptId: host.deptId || '',
    roomId: room ? room.id : '',
    roomName: room ? room.name : '',
    roomPlace: room ? [room.building, room.floor ? room.floor + 'F' : '', room.name].filter(Boolean).join(' · ') : '',
    quota: quota,
    usedCount: 0,
    validFrom: validFrom,
    validTo: validTo,
    status: 'active',
    allowReentry: input.allowReentry === false ? false : true,
    style: STYLE_KEYS.indexOf(input.style) >= 0 ? input.style : 'ticket',
    createdBy: user.id,
    createdAt: now,
    updatedAt: now
  };

  store.table('invites').push(row);
  store.commit();

  audit.add(user, 'invite.create', guestName,
    '邀请码 ' + row.code + '｜有效期 ' + mdhm(validFrom) + ' - ' + mdhm(validTo) +
    (room ? '｜' + room.name : ''), input.__ip);

  return { ok: true, credential: publicView(row) };
}

function publicView(row) {
  const now = Date.now();
  return {
    token: row.token,
    code: row.code,
    guestName: row.guestName,
    company: row.company,
    reason: row.reason,
    note: row.note,
    hostUserId: row.hostUserId,
    hostName: row.hostName,
    hostTitle: row.hostTitle || '',
    deptId: row.deptId,
    deptName: (org.deptById(row.deptId) || {}).name || '',
    roomId: row.roomId,
    roomName: row.roomName,
    roomPlace: row.roomPlace,
    quota: row.quota,
    usedCount: row.usedCount,
    validFrom: row.validFrom,
    validTo: row.validTo,
    validFromText: hhmm(row.validFrom),
    validToText: hhmm(row.validTo),
    dateText: dateKey(row.validFrom),
    rangeText: mdhm(row.validFrom) + ' — ' + (dateKey(row.validFrom) === dateKey(row.validTo) ? hhmm(row.validTo) : mdhm(row.validTo)),
    status: statusOf(row, now),
    statusText: STATUS_TEXT[statusOf(row, now)],
    allowReentry: row.allowReentry !== false,
    style: STYLE_KEYS.indexOf(row.style) >= 0 ? row.style : 'ticket',
    styleName: STYLE_NAMES[row.style] || STYLE_NAMES.ticket,
    createdAt: row.createdAt
  };
}

/* ---------------- 可见范围 ---------------- */

function canSee(user, inv) {
  if (!user) return false;
  if (auth.can(user, 'invite.view.all')) return true;
  if (auth.can(user, 'invite.view.dept')) {
    const set = org.deptSubtreeIds(user.deptId);
    return set.has(inv.deptId);
  }
  return inv.createdBy === user.id || inv.hostUserId === user.id;
}

function listInvites(user, opts) {
  const o = opts || {};
  const now = Date.now();
  let rows = store.table('invites').filter(i => canSee(user, i));

  if (o.status) {
    rows = rows.filter(i => statusOf(i, now) === o.status);
  }
  if (o.roomId) rows = rows.filter(i => i.roomId === o.roomId);
  if (o.mine) rows = rows.filter(i => i.hostUserId === user.id);
  if (o.from) {
    const from = parseDate(o.from, false);
    if (isFinite(from)) rows = rows.filter(i => i.validTo >= from);
  }
  if (o.to) {
    const to = parseDate(o.to, true);
    if (isFinite(to)) rows = rows.filter(i => i.validFrom <= to);
  }
  if (o.q) {
    const q = String(o.q).toLowerCase();
    rows = rows.filter(i =>
      (i.guestName + i.company + i.code + i.token + i.hostName + i.reason).toLowerCase().indexOf(q) >= 0
    );
  }

  rows.sort((a, b) => b.createdAt - a.createdAt);

  const total = rows.length;
  const page = Math.max(1, parseInt(o.page, 10) || 1);
  const size = Math.max(5, Math.min(100, parseInt(o.size, 10) || 20));
  const start = (page - 1) * size;

  return {
    rows: rows.slice(start, start + size).map(publicView),
    total: total,
    page: page,
    size: size,
    summary: {
      active: rows.filter(i => statusOf(i, now) === 'active').length,
      pending: rows.filter(i => statusOf(i, now) === 'pending').length,
      used: rows.filter(i => statusOf(i, now) === 'used').length,
      expired: rows.filter(i => statusOf(i, now) === 'expired').length,
      revoked: rows.filter(i => statusOf(i, now) === 'revoked').length
    }
  };
}

/* ---------------- 核验 ---------------- */

const REASONS = {
  invalid: { word: '无效凭证', reason: '系统中查无此记录，可能已失效或凭据有误', suggestion: '请引导访客至前台办理临时登记。' },
  revoked: { word: '邀请已撤销', reason: '邀请人主动撤销了本次邀请，凭证立即失效', suggestion: '请访客联系邀请人确认是否重新发起。' },
  notyet: { word: '尚未生效', reason: '本次邀请还没有到生效时间', suggestion: '请访客等到生效时间后再来，或让邀请人重新发送。' },
  expired: { word: '已过期', reason: '已超出本次邀请的可通行时段', suggestion: '请访客联系邀请人重新发送一张邀请卡。' },
  noReentry: { word: '名额已用尽', reason: '本次邀请的名额已全部使用，且邀请人关闭了复入', suggestion: '请访客联系邀请人追加名额或重新发起邀请。' },
  throttled: { word: '尝试过于频繁', reason: '短时间内多次核验失败，已临时锁定', suggestion: '请稍等 1 分钟再试，或联系管理员。' }
};

/* 核验失败限流：同 IP + 设备，2 分钟内 12 次失败 → 冷却 60 秒 */
const FAIL_WINDOW = 120 * 1000;
const FAIL_MAX = 12;
const failLog = new Map();

function failKey(ip, device) {
  return String(ip || '') + '|' + String(device || '');
}

function isThrottled(ip, device) {
  const rec = failLog.get(failKey(ip, device));
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  return false;
}

function noteFail(ip, device) {
  const key = failKey(ip, device);
  const now = Date.now();
  let rec = failLog.get(key);
  if (!rec || now - rec.first > FAIL_WINDOW) rec = { count: 0, first: now, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= FAIL_MAX) {
    rec.lockedUntil = now + 60 * 1000;
    rec.count = 0;
    rec.first = now;
  }
  failLog.set(key, rec);
}

function normalizeInput(raw) {
  let s = String(raw || '').trim().toUpperCase();
  s = s.replace(/[，、]/g, ' ').replace(/#/g, ' ').replace(/\s+/g, ' ').trim();
  const first = s.split(' ')[0] || '';
  const m = first.match(/SL\d{4}[A-Z0-9]{6}/);
  return m ? m[0] : first;
}

function logCheck(inv, pass, kind, deviceId, guard, input) {
  const now = Date.now();
  store.table('checks').push({
    token: inv ? inv.token : '',
    code: inv ? inv.code : '',
    guestName: inv ? inv.guestName : '',
    company: inv ? inv.company : '',
    reason: inv ? inv.reason : '',
    hostName: inv ? inv.hostName : '',
    hostUserId: inv ? inv.hostUserId : '',
    roomName: inv ? inv.roomName : '',
    deptId: inv ? inv.deptId : '',
    quota: inv ? inv.quota : 0,
    ts: now,
    date: dateKey(now),
    time: timeKey(now),
    pass: !!pass,
    kind: kind || '',
    input: String(input || '').slice(0, 40),
    guardId: guard ? guard.id : '',
    guardName: guard ? guard.name : '',
    deviceId: String(deviceId || 'unknown').slice(0, 40)
  });
  const checks = store.table('checks');
  if (checks.length > 30000) checks.splice(0, checks.length - 30000);
  store.commit();
}

/**
 * @param {string} rawInput 「1234」或「SLxxxxxx」或「1234 5678」
 * @param {string} deviceId 设备标识，用于 60 秒幂等
 * @param {string} ip 来源 IP，用于爆破限流
 * @param {object} guard 当前保安账号
 */
function verify(rawInput, deviceId, ip, guard) {
  const now = Date.now();
  const input = normalizeInput(rawInput);

  if (!input) return deny('invalid', null, deviceId, guard, rawInput);

  if (isThrottled(ip, deviceId)) return deny('throttled', null, deviceId, guard, rawInput);

  const inv = /^\d{4}$/.test(input) ? findByCode(input) : store.table('invites').find(i => i.token === input);
  if (!inv) {
    noteFail(ip, deviceId);
    return deny('invalid', null, deviceId, guard, rawInput);
  }

  if (inv.status === 'revoked') {
    noteFail(ip, deviceId);
    return deny('revoked', inv, deviceId, guard, rawInput);
  }

  if (now < inv.validFrom) {
    return deny('notyet', inv, deviceId, guard, rawInput,
      '本次邀请 ' + mdhm(inv.validFrom) + ' 起生效，现在还不能通行');
  }
  if (now > inv.validTo) {
    return deny('expired', inv, deviceId, guard, rawInput,
      '有效期至 ' + mdhm(inv.validTo) + '，已超出可通行时段');
  }

  /* 幂等：同一台设备 60 秒内重复扫同一张，不重复扣 */
  const since = now - 60 * 1000;
  const dup = store.table('checks').some(c =>
    c.ts >= since && c.token === inv.token && c.deviceId === deviceId && c.pass
  );
  if (dup) {
    logCheck(inv, true, 'dup', deviceId, guard, rawInput);
    return { pass: true, kind: 'dup', kindText: '重复扫描', credential: publicView(inv) };
  }

  if (inv.usedCount >= inv.quota) {
    if (inv.allowReentry === false) {
      logCheck(inv, false, 'full', deviceId, guard, rawInput);
      return deny('noReentry', inv, deviceId, guard, rawInput);
    }
    logCheck(inv, true, 'reentry', deviceId, guard, rawInput);
    return { pass: true, kind: 'reentry', kindText: '复入放行', credential: publicView(inv) };
  }

  inv.usedCount += 1;
  inv.updatedAt = now;
  store.commit();
  logCheck(inv, true, 'first', deviceId, guard, rawInput);
  return { pass: true, kind: 'first', kindText: '首次入场', credential: publicView(inv) };
}

function deny(reasonKey, inv, deviceId, guard, rawInput, overrideReason) {
  const r = REASONS[reasonKey] || REASONS.invalid;
  logCheck(inv, false, reasonKey, deviceId, guard, rawInput);
  const out = {
    pass: false,
    code: reasonKey,
    word: r.word,
    reason: overrideReason || r.reason,
    suggestion: r.suggestion
  };
  if (inv) {
    out.credential = {
      token: inv.token, code: inv.code, guestName: inv.guestName,
      company: inv.company, hostName: inv.hostName
    };
  }
  return out;
}

/* ---------------- 换卡面样式 ---------------- */

function setStyle(token, user, styleKey, ip) {
  const found = findAccessible(token, user);
  if (found.error) return found;
  if (STYLE_KEYS.indexOf(styleKey) < 0) return { error: '未知的卡面样式', status: 400 };
  if (found.invite.status === 'revoked') return { error: '已撤销的邀请不能换卡面', status: 400 };
  found.invite.style = styleKey;
  found.invite.updatedAt = Date.now();
  store.commit();
  audit.add(user, 'invite.style', found.invite.guestName, '卡面改为 ' + (STYLE_NAMES[styleKey] || styleKey), ip);
  return { ok: true, credential: publicView(found.invite) };
}

/* ---------------- 撤销 / 延期 ---------------- */

function findAccessible(token, user) {
  const inv = store.table('invites').find(i => i.token === token);
  if (!inv) return { error: '凭证不存在', status: 404 };
  if (!canSee(user, inv)) return { error: '没有权限操作这张邀请', status: 403 };
  return { invite: inv };
}

function revoke(token, user, ip) {
  const found = findAccessible(token, user);
  if (found.error) return found;
  const inv = found.invite;
  if (inv.status === 'revoked') return { ok: true, alreadyRevoked: true, credential: publicView(inv) };
  inv.status = 'revoked';
  inv.updatedAt = Date.now();
  store.commit();
  audit.add(user, 'invite.revoke', inv.guestName, '邀请码 ' + inv.code + ' 已撤销', ip);
  return { ok: true, credential: publicView(inv) };
}

function extend(token, user, payload, ip) {
  const found = findAccessible(token, user);
  if (found.error) return found;
  const inv = found.invite;
  if (inv.status === 'revoked') return { error: '已撤销的邀请不能延期', status: 400 };

  const now = Date.now();
  let validTo;
  if (payload && payload.validTo) {
    validTo = Number(payload.validTo);
  } else {
    const minutes = Math.max(10, Math.min(30 * 24 * 60, parseInt(payload && payload.minutes, 10) || 120));
    validTo = Math.max(inv.validTo, now) + minutes * 60000;
  }
  if (!isFinite(validTo) || validTo <= inv.validTo) return { error: '新的结束时间必须晚于当前有效期' };
  if (validTo - inv.validFrom > 30 * 24 * 3600 * 1000) return { error: '单张邀请最长 30 天' };
  if (inv.roomId) {
    const busy = rooms.conflicts(inv.roomId, inv.validFrom, validTo, inv.token);
    if (busy.length) {
      return { error: '会议室在延长后的时段已被占用：' + busy.map(b => b.guestName).join('、'), conflict: true, busy: busy };
    }
  }

  inv.validTo = validTo;
  inv.updatedAt = now;
  store.commit();
  audit.add(user, 'invite.extend', inv.guestName, '邀请码 ' + inv.code + ' 延至 ' + mdhm(validTo), ip);
  return { ok: true, credential: publicView(inv) };
}

/* ---------------- 台账 ---------------- */

function ledger(dateStr, includeDenied) {
  const date = dateStr || dateKey(Date.now());
  const all = store.table('checks').filter(c => c.date === date);
  const rows = all
    .filter(c => includeDenied ? true : (c.pass && c.kind !== 'dup'))
    .map(c => ({
      time: c.time,
      ts: c.ts,
      guestName: c.guestName,
      company: c.company,
      reason: c.reason,
      hostName: c.hostName,
      roomName: c.roomName || '',
      token: c.token,
      code: c.code,
      person: c.pass && c.kind === 'first' ? 1 : 0,
      pass: !!c.pass,
      kind: c.kind,
      kindText: c.pass
        ? (c.kind === 'first' ? '入场' : (c.kind === 'reentry' ? '复入' : '重复'))
        : ('拒绝·' + (REASONS[c.kind] ? REASONS[c.kind].word : c.kind)),
      input: c.input || '',
      guardName: c.guardName || '',
      deviceId: c.deviceId
    }))
    .reverse();

  const invitesToday = store.table('invites').filter(i => dateKey(i.createdAt) === date);
  const passes = all.filter(c => c.pass && c.kind !== 'dup');
  return {
    date: date,
    rows: rows,
    summary: {
      entries: passes.length,
      firstEntries: passes.filter(c => c.kind === 'first').length,
      invites: invitesToday.length,
      people: passes.filter(c => c.kind === 'first').length,
      denied: all.filter(c => !c.pass).length
    }
  };
}

function ledgerCsv(dateStr) {
  const data = ledger(dateStr, false);
  const head = ['入场时间', '访客', '来访单位', '来访事由', '邀请人', '会议室', '凭证号', '邀请码', '人次', '类型', '门岗'];
  const lines = [head.join(',')];
  data.rows.forEach(r => {
    lines.push([
      r.time, r.guestName, r.company, r.reason, r.hostName, r.roomName,
      r.token, r.code, r.person, r.kindText, r.guardName || r.deviceId
    ].map(csvCell).join(','));
  });
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------- 看板 ---------------- */

function dashboard(user) {
  const now = Date.now();
  const today = dateKey(now);
  const myInvites = store.table('invites').filter(i => canSee(user, i));
  const todayInvites = myInvites.filter(i => dateKey(i.createdAt) === today);
  const checks = store.table('checks').filter(c => c.date === today);
  const passes = checks.filter(c => c.pass && c.kind !== 'dup');

  /* 近 7 天入场趋势 */
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const ts = now - i * 86400000;
    const d = dateKey(ts);
    const day = store.table('checks').filter(c => c.date === d && c.pass && c.kind === 'first');
    trend.push({ date: d, label: (new Date(ts).getMonth() + 1) + '/' + new Date(ts).getDate(), count: day.length });
  }

  const roomUse = rooms.roomList().filter(r => r.status === 'active').map(r => {
    const busy = store.table('invites').filter(i =>
      i.roomId === r.id && i.status === 'active' && i.validFrom <= now && i.validTo >= now);
    return { id: r.id, name: r.name, building: r.building, floor: r.floor, busy: busy.length, guests: busy.reduce((a, b) => a + b.quota, 0) };
  });

  return {
    stats: {
      todayInvites: todayInvites.length,
      activeInvites: myInvites.filter(i => statusOf(i, now) === 'active').length,
      todayEntries: passes.length,
      todayPeople: passes.filter(c => c.kind === 'first').length,
      waiting: myInvites.filter(i => statusOf(i, now) === 'pending').length,
      denied: checks.filter(c => !c.pass).length,
      onSite: passes.filter(c => c.kind === 'first').length
    },
    trend: trend,
    rooms: roomUse,
    recent: store.table('invites').filter(i => canSee(user, i))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(publicView),
    audits: auth.can(user, 'audit.view') ? audit.list({ limit: 8 }).rows : []
  };
}

module.exports = {
  createInvite, verify, revoke, extend, setStyle, ledger, ledgerCsv, publicView, STYLE_KEYS, STYLE_NAMES,
  listInvites, statusOf, statusText: STATUS_TEXT, canSee, dashboard,
  dateKey, hhmm, mdhm, findByCode
};
