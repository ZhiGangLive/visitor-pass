#!/usr/bin/env node
'use strict';
/**
 * 冒烟测试 —— 零依赖，不需要测试框架。
 *
 *   node scripts/smoke.js
 *
 * 做四件事：
 *   1. 用临时数据目录起一个真实服务（不碰 data/）
 *   2. 登录 → 建邀请 → 门岗核验 → 查台账 → 导 CSV
 *   3. 验证服务端不接受前端伪造的邀请人
 *   4. 关服务、删临时目录
 *
 * 任何一步不符合预期就以非 0 退出。
 */

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function request(port, method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (cookie) headers.Cookie = cookie;

    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 8000 },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, buf, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时 ' + urlPath)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHealthy(port, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('服务启动即退出，退出码 ' + child.exitCode);
    try {
      const r = await request(port, 'GET', '/api/health');
      if (r.status === 200 && r.json && r.json.ok) return r.json;
    } catch (_) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('15 秒内服务未就绪');
}

(async () => {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visitor-pass-smoke-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: tmp
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  try {
    console.log('\n访客通行 · 冒烟测试');
    console.log('  端口 ' + port + '，数据目录 ' + tmp + '\n');

    const health = await waitHealthy(port, child);
    check('健康检查返回 ok', health.ok === true);
    check('首次启动自动建库', health.stats && health.stats.users >= 5, JSON.stringify(health.stats));

    /* --- 未登录必须被拒 --- */
    const anon = await request(port, 'GET', '/api/bootstrap');
    check('未登录访问被拒（401）', anon.status === 401, '实际 ' + anon.status);

    /* --- 登录 --- */
    const login = await request(port, 'POST', '/api/auth/login', {
      username: 'admin', password: 'admin123'
    });
    check('管理员登录成功', login.status === 200 && login.json && login.json.ok);
    const setCookie = login.headers['set-cookie'];
    const cookie = setCookie && setCookie[0] ? setCookie[0].split(';')[0] : '';
    check('下发 HttpOnly 会话 Cookie', /HttpOnly/i.test(String(setCookie)) && cookie.indexOf('vp_sid=') === 0);

    /* --- 错误口令 --- */
    const badLogin = await request(port, 'POST', '/api/auth/login', {
      username: 'admin', password: 'wrong-password'
    });
    check('错误口令被拒（401）', badLogin.status === 401, '实际 ' + badLogin.status);

    /* --- 建邀请 --- */
    const now = Date.now();
    const created = await request(port, 'POST', '/api/invites', {
      guestName: '冒烟测试',
      company: 'CI',
      reason: '技术交流',
      quota: 1,
      style: 'ticket',
      validFrom: now - 60000,
      validTo: now + 3600000,
      inviterId: 'someone-else'   // 伪造邀请人，应被忽略
    }, cookie);

    check('创建邀请成功', created.status === 200 && created.json && created.json.ok,
      created.status + ' ' + (created.json && created.json.error));
    const cred = created.json && created.json.credential;
    check('返回 4 位邀请码', !!cred && /^\d{4}$/.test(cred.code), cred && cred.code);
    check('返回二维码凭证号', !!cred && /^SL/.test(cred.token), cred && cred.token);

    /* --- 邀请人不可伪造 --- */
    const adminId = login.json && login.json.user && login.json.user.id;
    const list = await request(port, 'GET', '/api/invites?size=5', undefined, cookie);
    const mine = list.json && list.json.rows && list.json.rows.find(i => i.code === cred.code);
    check('服务端忽略前端伪造的 inviterId',
      !!mine && mine.hostUserId === adminId && mine.hostUserId !== 'someone-else',
      mine && (mine.hostName + ' / ' + mine.hostUserId));

    /* --- 门岗核验：首次入场 --- */
    const v1 = await request(port, 'POST', '/api/verify', { input: cred.code, deviceId: 'ci-gate-1' }, cookie);
    check('首次核验放行', v1.json && v1.json.pass === true, JSON.stringify(v1.json));
    check('标记为首次入场', v1.json && v1.json.kind === 'first', v1.json && v1.json.kind);

    /* --- 同一设备 60 秒内重扫：不重复扣人次 --- */
    const v2 = await request(port, 'POST', '/api/verify', { input: cred.code, deviceId: 'ci-gate-1' }, cookie);
    check('同设备重复扫描判为 dup', v2.json && v2.json.kind === 'dup', v2.json && v2.json.kind);

    /* --- 无效凭证 --- */
    const v3 = await request(port, 'POST', '/api/verify', { input: '0000', deviceId: 'ci-gate-2' }, cookie);
    check('无效凭证被拒', v3.json && v3.json.pass === false, JSON.stringify(v3.json));

    /* --- 台账 --- */
    const ledger = await request(port, 'GET', '/api/ledger', undefined, cookie);
    check('台账可查询', ledger.status === 200 && ledger.json && ledger.json.ok);
    const rows = (ledger.json && ledger.json.rows) || [];
    check('台账包含刚才的访客', rows.some(r => r.guestName === '冒烟测试'),
      rows.map(r => r.guestName).join(','));

    /* --- CSV 导出 --- */
    const csv = await request(port, 'GET', '/api/ledger.csv', undefined, cookie);
    check('CSV 导出成功', csv.status === 200 && /text\/csv/.test(String(csv.headers['content-type'])));
    const csvText = csv.buf.toString('utf8');
    check('CSV 带 UTF-8 BOM', csvText.charCodeAt(0) === 0xFEFF);
    check('CSV 含访客姓名', csvText.indexOf('冒烟测试') > 0);

    /* --- 数据确实落在 DATA_DIR --- */
    check('数据写入指定的 DATA_DIR', fs.existsSync(path.join(tmp, 'db.json')));

    /* --- 权限：无 guard.verify 的账号不能核验 --- */
    const empLogin = await request(port, 'POST', '/api/auth/login', {
      username: 'wang.fang', password: 'vp123456'
    });
    const empCookie = empLogin.headers['set-cookie'][0].split(';')[0];
    const v4 = await request(port, 'POST', '/api/verify', { input: cred.code, deviceId: 'ci-gate-3' }, empCookie);
    check('员工无核验权限（403）', v4.status === 403, '实际 ' + v4.status);
  } finally {
    child.kill('SIGTERM');
    await sleep(600);
    if (child.exitCode === null) child.kill('SIGKILL');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n  ' + passed + ' 项通过，' + failures.length + ' 项失败');
  if (stderr.trim()) console.log('\n服务端 stderr:\n' + stderr.trim());
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('  冒烟测试通过\n');
})().catch(err => {
  console.error('\n冒烟测试异常：' + err.message + '\n');
  process.exit(1);
});
