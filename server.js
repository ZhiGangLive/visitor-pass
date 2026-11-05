'use strict';
/**
 * 访客通行管理系统 · 服务端
 * 零 npm 依赖，Node 16+ 即可运行。
 *
 *   node server.js
 *   环境变量：PORT（默认 8080） HOST（默认 0.0.0.0）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const store = require('./lib/store');
const auth = require('./lib/auth');
const org = require('./lib/org');
const rooms = require('./lib/rooms');
const invite = require('./lib/invite');
const audit = require('./lib/audit');
const seed = require('./lib/seed');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, 'public');

/* ---------------- 小工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  };
  if (res._cookies && res._cookies.length) headers['Set-Cookie'] = res._cookies;
  res.writeHead(code, headers);
  res.end(buf);
}

function sendText(res, code, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length
  });
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 256 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function setCookie(res, value) {
  res._cookies = res._cookies || [];
  res._cookies.push(value);
}

function fail(res, code, message, extra) {
  return sendJson(res, code, Object.assign({ error: message }, extra || {}));
}

/** 取当前用户，未登录返回 401 */
function need(req, res, perm) {
  const user = auth.currentUser(req);
  if (!user) {
    fail(res, 401, '请先登录', { needLogin: true });
    return null;
  }
  if (perm && !auth.can(user, perm)) {
    fail(res, 403, '没有权限执行该操作');
    return null;
  }
  return user;
}

/* ---------------- 静态文件 ---------------- */

const PAGE_ALIAS = {
  '/': '/index.html',
  '/index': '/index.html',
  '/guard': '/guard.html',
  '/guard/': '/guard.html',
  '/ledger': '/index.html',
  '/ledger/': '/index.html',
  '/login': '/index.html'
};

function serveStatic(req, res, pathname) {
  let rel = PAGE_ALIAS[pathname] || pathname;
  if (rel.indexOf('..') >= 0) return sendText(res, 403, 'Forbidden');

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, '页面不存在');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ['.html', '.js', '.css'].indexOf(ext) >= 0 ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const query = parsed.query;
  const method = req.method.toUpperCase();
  const ip = clientIp(req);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');

  try {
    /* ---- 健康检查（公开） ---- */
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, now: Date.now(), stats: store.stats() });
    }

    /* ---- 登录（公开） ---- */
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password) return fail(res, 400, '请输入账号和密码');

      const lockedUntil = auth.loginLocked(username, ip);
      if (lockedUntil) {
        const sec = Math.ceil((lockedUntil - Date.now()) / 1000);
        return fail(res, 429, '密码错误次数过多，请 ' + sec + ' 秒后再试');
      }

      const row = store.table('users').find(u => u.username === username);
      if (!row || !auth.verifyPassword(password, row.passwordHash)) {
        auth.noteLoginFail(username, ip);
        if (row) audit.add(auth.hydrate(row), 'auth.login.fail', row.name, '密码错误', ip);
        return fail(res, 401, '账号或密码不正确');
      }
      if (row.status !== 'active') return fail(res, 403, '账号已停用，请联系管理员');

      auth.clearLoginFail(username, ip);
      row.lastLoginAt = Date.now();
      store.commit();
      const session = auth.createSession(row, !!body.remember, ip, req.headers['user-agent']);
      setCookie(res, auth.cookieHeader(session.token, !!body.remember));
      const user = auth.hydrate(row);
      audit.add(user, 'auth.login', row.name, '登录成功', ip);
      return sendJson(res, 200, { ok: true, user: user });
    }

    /* ---- 登出 ---- */
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const user = auth.currentUser(req);
      if (user) {
        auth.destroySession(user.sessionToken);
        audit.add(user, 'auth.logout', user.name, '退出登录', ip);
      }
      setCookie(res, auth.clearCookieHeader());
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 当前用户 ---- */
    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = auth.currentUser(req);
      if (!user) return fail(res, 401, '未登录', { needLogin: true });
      return sendJson(res, 200, { ok: true, user: user });
    }

    /* ---- 修改自己的密码 ---- */
    if (pathname === '/api/auth/password' && method === 'POST') {
      const user = need(req, res);
      if (!user) return;
      const body = await readBody(req);
      const r = org.changeOwnPassword(user.id, body.oldPassword, body.newPassword);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'auth.password', user.name, '修改密码，其他设备已下线', ip);
      setCookie(res, auth.clearCookieHeader());
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 一次性拉取前端所需的全部基础数据 ---- */
    if (pathname === '/api/bootstrap' && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      return sendJson(res, 200, {
        ok: true,
        me: user,
        users: org.userList().filter(u => u.status === 'active'),
        departments: org.deptTree(),
        roles: org.roleList(),
        rooms: rooms.roomList(),
        settings: store.settings(),
        perms: auth.PERMS,
        scopes: auth.SCOPES,
        stats: store.stats()
      });
    }

    /* ---- 看板 ---- */
    if (pathname === '/api/dashboard' && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      return sendJson(res, 200, Object.assign({ ok: true }, invite.dashboard(user)));
    }

    /* ---- 邀请列表 ---- */
    if (pathname === '/api/invites' && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      if (!auth.canAny(user, ['invite.view.self', 'invite.view.dept', 'invite.view.all'])) {
        return fail(res, 403, '没有查看邀请的权限');
      }
      return sendJson(res, 200, Object.assign({ ok: true },
        invite.listInvites(user, {
          status: query.status, q: query.q, from: query.from, to: query.to,
          roomId: query.roomId, mine: query.mine === '1',
          page: query.page, size: query.size
        })));
    }

    /* ---- 创建邀请 ---- */
    if (pathname === '/api/invites' && method === 'POST') {
      const user = need(req, res, 'invite.create');
      if (!user) return;
      const body = await readBody(req);
      body.__ip = ip;
      const result = invite.createInvite(body, user);
      if (result.error) {
        return sendJson(res, result.conflict ? 409 : 400, result);
      }
      return sendJson(res, 200, result);
    }

    /* ---- 单条 / 撤销 / 延期 ---- */
    let m = pathname.match(/^\/api\/invites\/([A-Za-z0-9]+)$/);
    if (m && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      const row = store.table('invites').find(i => i.token === m[1]);
      if (!row) return fail(res, 404, '凭证不存在');
      if (!invite.canSee(user, row)) return fail(res, 403, '没有权限查看');
      return sendJson(res, 200, { ok: true, credential: invite.publicView(row) });
    }

    m = pathname.match(/^\/api\/invites\/([A-Za-z0-9]+)\/revoke$/);
    if (m && method === 'POST') {
      const user = need(req, res, 'invite.revoke');
      if (!user) return;
      const result = invite.revoke(m[1], user, ip);
      if (result.error) return fail(res, result.status || 400, result.error);
      return sendJson(res, 200, result);
    }

    m = pathname.match(/^\/api\/invites\/([A-Za-z0-9]+)\/extend$/);
    if (m && method === 'POST') {
      const user = need(req, res, 'invite.extend');
      if (!user) return;
      const body = await readBody(req);
      const result = invite.extend(m[1], user, body, ip);
      if (result.error) return fail(res, result.conflict ? 409 : 400, result.error, result.conflict ? { busy: result.busy } : null);
      return sendJson(res, 200, result);
    }

    m = pathname.match(/^\/api\/invites\/([A-Za-z0-9]+)\/style$/);
    if (m && method === 'POST') {
      const user = need(req, res, 'invite.create');
      if (!user) return;
      const body = await readBody(req);
      const result = invite.setStyle(m[1], user, body.style, ip);
      if (result.error) return fail(res, result.status || 400, result.error);
      return sendJson(res, 200, result);
    }

    /* ---- 核验（保安端唯一入口） ---- */
    if (pathname === '/api/verify' && method === 'POST') {
      const user = need(req, res, 'guard.verify');
      if (!user) return;
      const body = await readBody(req);
      const result = invite.verify(body.input, body.deviceId || 'unknown', ip, user);
      return sendJson(res, 200, result);
    }

    /* ---- 台账 ---- */
    if (pathname === '/api/ledger' && method === 'GET') {
      const user = need(req, res, 'ledger.view');
      if (!user) return;
      return sendJson(res, 200, Object.assign({ ok: true },
        invite.ledger(query.date, query.include === 'deny')));
    }

    if (pathname === '/api/ledger.csv' && method === 'GET') {
      const user = need(req, res, 'ledger.export');
      if (!user) return;
      const date = query.date || invite.dateKey(Date.now());
      const csv = invite.ledgerCsv(date);
      const buf = Buffer.from(csv, 'utf8');
      audit.add(user, 'ledger.export', date, '导出台账', ip);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': buf.length,
        'Content-Disposition': 'attachment; filename="visitor-ledger-' + date + '.csv"',
        'Cache-Control': 'no-store'
      });
      return res.end(buf);
    }

    /* ---- 部门 ---- */
    if (pathname === '/api/departments' && method === 'GET') {
      const user = need(req, res, 'staff.view');
      if (!user) return;
      return sendJson(res, 200, { ok: true, tree: org.deptTree(), flat: org.deptList(), users: org.userList() });
    }
    if (pathname === '/api/departments' && method === 'POST') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.deptSave(body, null);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'dept.create', r.department.name, '新建部门', ip);
      return sendJson(res, 200, r);
    }
    m = pathname.match(/^\/api\/departments\/([A-Za-z0-9]+)$/);
    if (m && method === 'PATCH') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.deptSave(body, m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'dept.update', r.department.name, '修改部门', ip);
      return sendJson(res, 200, r);
    }
    if (m && method === 'DELETE') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const r = org.deptRemove(m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'dept.delete', m[1], '删除部门', ip);
      return sendJson(res, 200, r);
    }

    /* ---- 成员 ---- */
    if (pathname === '/api/users' && method === 'GET') {
      const user = need(req, res, 'staff.view');
      if (!user) return;
      return sendJson(res, 200, { ok: true, users: org.userList({ deptId: query.deptId, q: query.q, status: query.status }) });
    }
    if (pathname === '/api/users' && method === 'POST') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.userSave(body, null);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'user.create', r.user.name, '新建账号 ' + r.user.username + '（' + r.user.roleName + '）', ip);
      return sendJson(res, 200, r);
    }
    m = pathname.match(/^\/api\/users\/([A-Za-z0-9]+)$/);
    if (m && method === 'PATCH') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.userSave(body, m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'user.update', r.user.name, '修改成员资料 / 角色：' + r.user.roleName, ip);
      return sendJson(res, 200, r);
    }
    if (m && method === 'DELETE') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const r = org.userRemove(m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'user.delete', m[1], r.disabled ? '成员有历史记录，已停用' : '删除成员', ip);
      return sendJson(res, 200, r);
    }
    m = pathname.match(/^\/api\/users\/([A-Za-z0-9]+)\/reset-password$/);
    if (m && method === 'POST') {
      const user = need(req, res, 'staff.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.resetPassword(m[1], body.password);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'user.resetpw', m[1], '重置密码', ip);
      return sendJson(res, 200, r);
    }

    /* ---- 角色 ---- */
    if (pathname === '/api/roles' && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      return sendJson(res, 200, { ok: true, roles: org.roleList(), perms: auth.PERMS, scopes: auth.SCOPES });
    }
    if (pathname === '/api/roles' && method === 'POST') {
      const user = need(req, res, 'role.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.roleSave(body, null);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'role.create', r.role.name, '新建角色', ip);
      return sendJson(res, 200, r);
    }
    m = pathname.match(/^\/api\/roles\/([A-Za-z0-9_]+)$/);
    if (m && method === 'PATCH') {
      const user = need(req, res, 'role.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = org.roleSave(body, m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'role.update', r.role.name, '修改角色权限（' + (r.role.perms || []).length + ' 项）', ip);
      return sendJson(res, 200, r);
    }
    if (m && method === 'DELETE') {
      const user = need(req, res, 'role.manage');
      if (!user) return;
      const r = org.roleRemove(m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'role.delete', m[1], '删除角色', ip);
      return sendJson(res, 200, r);
    }

    /* ---- 会议室 ---- */
    if (pathname === '/api/rooms' && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      return sendJson(res, 200, { ok: true, rooms: rooms.roomList() });
    }
    if (pathname === '/api/rooms' && method === 'POST') {
      const user = need(req, res, 'room.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = rooms.roomSave(body, null);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'room.create', r.room.name, '新增会议室', ip);
      return sendJson(res, 200, r);
    }
    m = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
    if (m && method === 'PATCH') {
      const user = need(req, res, 'room.manage');
      if (!user) return;
      const body = await readBody(req);
      const r = rooms.roomSave(body, m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'room.update', r.room.name, '修改会议室', ip);
      return sendJson(res, 200, r);
    }
    if (m && method === 'DELETE') {
      const user = need(req, res, 'room.manage');
      if (!user) return;
      const r = rooms.roomRemove(m[1]);
      if (r.error) return fail(res, 400, r.error);
      audit.add(user, 'room.delete', m[1], '删除会议室', ip);
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/rooms/schedule' && method === 'GET') {
      const user = need(req, res);
      if (!user) return;
      const date = query.date || invite.dateKey(Date.now());
      const from = new Date(date + 'T00:00:00').getTime();
      const to = from + 86400000;
      return sendJson(res, 200, { ok: true, date: date, rooms: rooms.schedule(date, from, to) });
    }

    /* ---- 操作日志 ---- */
    if (pathname === '/api/audit' && method === 'GET') {
      const user = need(req, res, 'audit.view');
      if (!user) return;
      return sendJson(res, 200, Object.assign({ ok: true },
        audit.list({ limit: query.limit, action: query.action, q: query.q })));
    }

    /* ---- 系统设置 ---- */
    if (pathname === '/api/settings' && method === 'POST') {
      const user = need(req, res, 'system.manage');
      if (!user) return;
      const body = await readBody(req);
      const s = store.settings();
      s.orgName = String(body.orgName || s.orgName).slice(0, 40);
      s.building = String(body.building || s.building).slice(0, 20);
      s.guardDevice = String(body.guardDevice || s.guardDevice).slice(0, 30);
      store.commit();
      audit.add(user, 'system.settings', '系统设置', '更新组织信息', ip);
      return sendJson(res, 200, { ok: true, settings: s });
    }

    /* ---- 静态资源 ---- */
    if (method === 'GET' || method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    return fail(res, 405, '不支持的请求方法');
  } catch (err) {
    console.error('[server]', pathname, err.message);
    if (!res.headersSent) return fail(res, 500, err.message || '服务器内部错误');
    res.end();
  }
});

/* ---------------- 启动 ---------------- */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  const isVirtual = n => /virtual|vmware|vbox|hyper-v|vethernet|loopback|环路/i.test(n);
  const isReal = n => /wlan|wi-?fi|无线|以太网|ethernet|本地连接/i.test(n);

  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(net => {
      if (net.family !== 'IPv4' || net.internal) return;
      if (net.address.startsWith('169.254.')) return;
      out.push({ name, address: net.address, score: isVirtual(name) ? 0 : (isReal(name) ? 2 : 1) });
    });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

seed.seedIfEmpty();
auth.cleanupSessions();
store.flushSync();

server.listen(PORT, HOST, () => {
  const lines = [];
  lines.push('');
  lines.push('  访客通行管理系统  已启动');
  lines.push('  ─────────────────────────────────────');
  lines.push('  管理端    http://127.0.0.1:' + PORT + '/');
  lines.push('  保安端    http://127.0.0.1:' + PORT + '/guard');
  lanAddresses().forEach(n => {
    lines.push('  局域网    http://' + n.address + ':' + PORT + '/   (' + n.name + ')');
  });
  lines.push('  ─────────────────────────────────────');
  lines.push('  数据文件  ' + store.DB_FILE);
  lines.push('  初始账号  admin / admin123');
  lines.push('');
  console.log(lines.join('\n'));
});

function shutdown() {
  console.log('\n[server] 正在关闭，落盘数据…');
  try { store.close(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
