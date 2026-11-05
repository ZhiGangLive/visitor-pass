(function () {
'use strict';

/* ==========================================================================
   基础工具
   ========================================================================== */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const MAP_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, c => MAP_ESC[c]);
const pad = n => (n < 10 ? '0' + n : '' + n);

function dateStr(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function todayStr() { return dateStr(new Date()); }
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtDT(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtRange(a, b) {
  if (!a && !b) return '—';
  const da = new Date(a), db = new Date(b);
  if (dateStr(da) === dateStr(db)) {
    return (da.getMonth() + 1) + '月' + da.getDate() + '日 ' + fmtTime(a) + '–' + fmtTime(b);
  }
  return fmtDT(a) + ' → ' + fmtDT(b);
}
function slotRange(a, b) {
  const cross = dateStr(new Date(a)) !== dateStr(new Date(b));
  return fmtTime(a) + '–' + (cross ? '次日 ' : '') + fmtTime(b);
}
function fromNow(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
  return fmtDT(ts);
}
function initials(name) { return String(name || '?').slice(-2); }
function debounce(fn, ms) {
  let t;
  return function () {
    const args = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(self, args), ms);
  };
}
function icon(id, size) {
  const s = size || 16;
  return '<svg width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round"><use href="#' + id + '"/></svg>';
}

/* ==========================================================================
   接口
   ========================================================================== */
class ApiError extends Error {
  constructor(msg, status, payload) {
    super(msg);
    this.status = status;
    this.payload = payload || {};
  }
}

async function api(path, opts) {
  const conf = Object.assign({
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    credentials: 'same-origin'
  }, opts || {});
  if (conf.body && typeof conf.body !== 'string') conf.body = JSON.stringify(conf.body);
  const res = await fetch(path, conf);
  let data = {};
  try { data = await res.json(); } catch (e) { /* 空响应 */ }
  if (!res.ok) {
    if (res.status === 401 && path.indexOf('/api/auth/login') < 0) showLogin();
    throw new ApiError(data.error || ('请求失败（' + res.status + '）'), res.status, data);
  }
  return data;
}

/* ==========================================================================
   状态
   ========================================================================== */
const S = {
  me: null,
  data: { users: [], departments: [], roles: [], rooms: [], perms: [], scopes: [], settings: {}, stats: {} },
  route: '',
  lastCreated: null,
  records: { q: '', status: '', from: '', to: '', mine: false, page: 1 },
  ledger: { date: todayStr(), include: '' },
  org: { deptId: '', q: '' },
  roomsDate: todayStr(),
  permRoleKey: '',
  audit: { q: '' }
};

function can(perm) {
  if (!S.me) return false;
  return S.me.perms.indexOf('*') >= 0 || S.me.perms.indexOf(perm) >= 0;
}
function canAny(list) { return list.some(can); }

/* ==========================================================================
   提示 / 弹窗 / 抽屉
   ========================================================================== */
let toastTimer;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), isErr ? 3600 : 2400);
}

function closeModal() { $('#modalRoot').innerHTML = ''; }
function closeDrawer() { const r = $('#drawerRoot'); if (r) r.innerHTML = ''; }

function openModal(opt) {
  closeModal();
  const root = $('#modalRoot');
  const cls = (opt.wide ? ' wide' : '') + (opt.narrow ? ' narrow' : '');
  root.innerHTML =
    '<div class="modal-mask" id="modalMask">' +
      '<div class="modal' + cls + '">' +
        '<div class="modal-head">' +
          '<div><h3>' + esc(opt.title) + '</h3>' +
          (opt.sub ? '<div class="sub">' + esc(opt.sub) + '</div>' : '') + '</div>' +
          '<button class="x" data-mclose aria-label="关闭">' + icon('i-x', 16) + '</button>' +
        '</div>' +
        '<div class="modal-body">' + (opt.body || '') + '</div>' +
        (opt.foot ? '<div class="modal-foot">' + opt.foot + '</div>' : '') +
      '</div>' +
    '</div>';
  const mask = $('#modalMask');
  mask.addEventListener('mousedown', e => { if (e.target === mask) closeModal(); });
  $$('[data-mclose]', root).forEach(b => b.onclick = closeModal);
  if (opt.onMount) opt.onMount(root);
  return root;
}
function escClose(e) {
  if (e.key !== 'Escape') return;
  if ($('#modalRoot').innerHTML.trim()) closeModal();
  else closeDrawer();
}
document.addEventListener('keydown', escClose);

function confirmDialog(title, message, okText, danger) {
  return new Promise(resolve => {
    openModal({
      title: title,
      narrow: true,
      body: '<div style="font-size:13px;color:var(--txt-2);line-height:1.85">' + message + '</div>',
      foot: '<button class="btn ghost" data-mclose>取消</button>' +
            '<button class="btn ' + (danger ? 'danger' : 'primary') + '" id="cfmOk">' + esc(okText || '确认') + '</button>',
      onMount(root) {
        $('#cfmOk', root).onclick = () => { closeModal(); resolve(true); };
        $$('[data-mclose]', root).forEach(b => b.addEventListener('click', () => resolve(false)));
      }
    });
  });
}

function openDrawer(title, sub, body, foot) {
  closeDrawer();
  const root = $('#drawerRoot');
  root.innerHTML =
    '<div class="drawer-mask" id="drawerMask"></div>' +
    '<div class="drawer">' +
      '<div class="drawer-head"><div><h3 style="font-size:15px;font-weight:600">' + esc(title) + '</h3>' +
        (sub ? '<div style="font-size:11px;color:var(--txt-3);margin-top:4px">' + esc(sub) + '</div>' : '') +
      '</div><button class="x" style="margin-left:auto" data-dclose>' + icon('i-x', 16) + '</button></div>' +
      '<div class="drawer-body">' + body + '</div>' +
      (foot ? '<div class="drawer-foot">' + foot + '</div>' : '') +
    '</div>';
  const mask = $('#drawerMask');
  mask.addEventListener('click', closeDrawer);
  $$('[data-dclose]', root).forEach(b => b.onclick = closeDrawer);
  if (arguments[4]) arguments[4](root);
}

/* ==========================================================================
   邀请卡绘制 1080 × 1620
   ========================================================================== */
const FA = {
  gold: '#C9A961', goldLt: '#E8D5A0',
  txt: '#F2F5FA', dim: '#8D98AC', dimmer: '#5A6478'
};
const FAM_SERIF = '"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif';
const FAM_SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const FAM_MONO = 'ui-monospace,"SF Mono",Consolas,"Courier New",monospace';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitFont(ctx, text, maxW, size, weight, family) {
  let s = size;
  ctx.font = weight + ' ' + s + 'px ' + family;
  while (ctx.measureText(text).width > maxW && s > 15) {
    s -= 1;
    ctx.font = weight + ' ' + s + 'px ' + family;
  }
  return s;
}

function drawQR(ctx, x, y, size, text) {
  const qr = window.qrcode(0, 'H');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const cell = Math.floor(size / (n + quiet * 2));
  const real = cell * (n + quiet * 2);
  const ox = x + (size - real) / 2;
  const oy = y + (size - real) / 2;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(ox, oy, real, real);
  ctx.fillStyle = '#0A1018';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell);
      }
    }
  }
}

/* ==========================================================================
   邀请卡卡面样式
   四种构图，同一套数据；drawCard(canvas, data, style, scale)
   ========================================================================== */
const CARD_W = 1080;
const CARD_H = 1350;

const CARD_STYLES = [
  { key: 'ticket',  name: '票券',   desc: '深色票面 + 纸色票根' },
  { key: 'minimal', name: '极简白', desc: '米白留白，适合打印' },
  { key: 'noir',    name: '墨金',   desc: '对称构图，正式场合' },
  { key: 'jade',    name: '青玉',   desc: '深青底，叠层卡面' }
];

function cardStyleName(key) {
  const hit = CARD_STYLES.find(s => s.key === key);
  return hit ? hit.name : '票券';
}

function cardData(raw) {
  return Object.assign({
    guestName: '访客', company: '', reason: '', hostName: '', hostTitle: '', deptName: '',
    roomName: '', roomPlace: '', quota: 1, usedCount: 0, code: '0000', token: 'SL0000000000',
    validFrom: Date.now(), validTo: Date.now(), status: 'active', style: 'ticket'
  }, raw || {});
}

function statusInfo(k) {
  const st = k.status;
  if (st === 'revoked') return { color: 'rgba(232,92,92,.95)', label: '已 撤 销' };
  if (st === 'expired') return { color: 'rgba(160,171,190,.9)', label: '已 过 期' };
  if (st === 'pending') return { color: 'rgba(126,168,240,.95)', label: '待 生 效' };
  if (st === 'used') return { color: 'rgba(201,169,97,.95)', label: '名 额 已 满' };
  return { color: 'rgba(201,169,97,.95)', label: '已 生 效' };
}

function trackedText(ctx, text, x, y, spacing) {
  ctx.save();
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
  ctx.fillText(text, x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.restore();
}

function drawStatusPill(ctx, x, y, w, h, k) {
  const info = statusInfo(k);
  ctx.save();
  ctx.strokeStyle = info.color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = .55;
  roundRect(ctx, x, y, w, h, h / 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = info.color;
  ctx.font = '400 18px ' + FAM_SANS;
  ctx.textAlign = 'center';
  ctx.fillText(info.label, x + w / 2, y + h / 2 + 6);
  ctx.restore();
}

function drawCard(canvas, raw, style, scale) {
  const k = cardData(raw);
  const key = CARD_STYLES.some(s => s.key === style) ? style : (k.style || 'ticket');
  const sc = scale || 1;
  canvas.width = Math.round(CARD_W * sc);
  canvas.height = Math.round(CARD_H * sc);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(sc, sc);
  const fn = { ticket: drawTicket, minimal: drawMinimal, noir: drawNoir, jade: drawJade }[key] || drawTicket;
  fn(ctx, k);
  ctx.restore();
  return canvas;
}

/* --------------------------------------------------------------------------
   一、票券：深色票面 + 暖纸色票根
   -------------------------------------------------------------------------- */
function drawTicket(ctx, k) {
  const W = CARD_W, H = CARD_H;

  const bg = ctx.createLinearGradient(0, 0, W * .55, H);
  bg.addColorStop(0, '#182333');
  bg.addColorStop(.55, '#0C1421');
  bg.addColorStop(1, '#070B12');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(150, -80, 10, 150, -80, 640);
  glow.addColorStop(0, 'rgba(201,169,97,.20)');
  glow.addColorStop(1, 'rgba(201,169,97,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 640);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.016)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 54) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 600); ctx.stroke(); }
  for (let y = 0; y < 600; y += 54) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();

  const bar = ctx.createLinearGradient(0, 0, W, 0);
  bar.addColorStop(0, 'rgba(201,169,97,0)');
  bar.addColorStop(.24, FA.gold);
  bar.addColorStop(.5, '#F6E9C2');
  bar.addColorStop(.76, FA.gold);
  bar.addColorStop(1, 'rgba(201,169,97,0)');
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, W, 8);

  ctx.fillStyle = FA.goldLt;
  roundRect(ctx, 48, 42, 62, 62, 16); ctx.fill();
  ctx.fillStyle = '#120E04';
  ctx.font = '800 34px ' + FAM_SANS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('星', 79, 74);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left';
  ctx.fillStyle = '#E9EDF4';
  ctx.font = '600 31px ' + FAM_SANS;
  ctx.fillText('星河科技', 128, 74);
  ctx.fillStyle = 'rgba(201,169,97,.62)';
  ctx.font = '400 15px ' + FAM_SANS;
  trackedText(ctx, 'STARLIGHT VISITOR', 129, 104, 4);

  drawStatusPill(ctx, W - 48 - 150, 52, 150, 44, k);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#F4EBD5';
  ctx.font = '400 70px ' + FAM_SERIF;
  trackedText(ctx, '邀请卡', 48, 206, 12);

  ctx.fillStyle = 'rgba(201,169,97,.5)';
  ctx.font = '400 17px ' + FAM_SANS;
  trackedText(ctx, 'INVITATION CARD', 52, 246, 6);

  ctx.fillStyle = 'rgba(141,152,172,.62)';
  ctx.font = '400 19px ' + FAM_SANS;
  ctx.fillText('访客', 48, 302);

  ctx.fillStyle = '#DDE4EF';
  const nameSize = fitFont(ctx, k.guestName, 640, 48, '600', FAM_SANS);
  ctx.font = '600 ' + nameSize + 'px ' + FAM_SANS;
  ctx.fillText(k.guestName, 48, 352);

  if (k.company) {
    ctx.fillStyle = 'rgba(150,162,184,.8)';
    const cs = fitFont(ctx, k.company, 700, 25, '400', FAM_SANS);
    ctx.font = '400 ' + cs + 'px ' + FAM_SANS;
    ctx.fillText(k.company, 48, 390);
  }

  const cells = detailCells(k);
  const colX = [48, 520];
  const rowY = [438, 514];
  cells.forEach((c, i) => {
    const x = colX[i % 2];
    const y = rowY[Math.floor(i / 2)];
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(141,152,172,.55)';
    ctx.font = '400 17px ' + FAM_SANS;
    ctx.fillText(c[0], x, y);
    ctx.fillStyle = 'rgba(226,233,243,.92)';
    const s2 = fitFont(ctx, c[1], 440, 27, '400', FAM_SANS);
    ctx.font = '400 ' + s2 + 'px ' + FAM_SANS;
    ctx.fillText(c[1], x, y + 34);
  });

  const stubY = 600;
  const paper = ctx.createLinearGradient(0, stubY, 0, H);
  paper.addColorStop(0, '#F7F2E6');
  paper.addColorStop(1, '#EFE6D4');
  ctx.fillStyle = paper;
  ctx.fillRect(0, stubY, W, H - stubY);

  ctx.fillStyle = '#0B1120';
  ctx.beginPath(); ctx.arc(0, stubY, 22, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(W, stubY, 22, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.strokeStyle = 'rgba(24,28,36,.16)';
  ctx.lineWidth = 2;
  ctx.setLineDash([9, 9]);
  ctx.beginPath(); ctx.moveTo(40, stubY + 34); ctx.lineTo(W - 40, stubY + 34); ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(24,28,36,.48)';
  ctx.font = '500 19px ' + FAM_SANS;
  trackedText(ctx, '邀 请 码', 64, 690, 3);

  ctx.fillStyle = '#14171C';
  ctx.font = '700 150px ' + FAM_MONO;
  ctx.fillText(k.code, 56, 834);

  ctx.fillStyle = 'rgba(24,28,36,.6)';
  ctx.font = '400 24px ' + FAM_SANS;
  ctx.fillText('到访时告知门岗，或出示右侧二维码', 64, 884);

  ctx.fillStyle = 'rgba(24,28,36,.34)';
  ctx.font = '400 18px ' + FAM_MONO;
  ctx.fillText(k.token, 64, 924);

  const qrSize = 366;
  const qrX = W - 64 - qrSize;
  const qrY = 660;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, qrX - 14, qrY - 14, qrSize + 28, qrSize + 28, 14); ctx.fill();
  drawQR(ctx, qrX, qrY, qrSize, k.token);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(24,28,36,.42)';
  ctx.font = '400 19px ' + FAM_SANS;
  ctx.fillText('扫 码 核 验', qrX + qrSize / 2, qrY + qrSize + 48);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(24,28,36,.55)';
  ctx.font = '400 22px ' + FAM_SANS;
  ctx.fillText('通行人数 ' + k.quota + ' 人', 64, 1178);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(24,28,36,.38)';
  ctx.font = '400 19px ' + FAM_SANS;
  ctx.fillText('仅限本人使用 · 过期作废', W - 64, 1178);

  ctx.strokeStyle = 'rgba(24,28,36,.11)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(64, 1238); ctx.lineTo(W - 64, 1238); ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(24,28,36,.36)';
  ctx.font = '400 18px ' + FAM_SANS;
  ctx.fillText('星河科技 · 访客通行管理系统', 64, 1292);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(24,28,36,.3)';
  ctx.font = '400 17px ' + FAM_SANS;
  ctx.fillText('二维码仅供门岗核验', W - 64, 1292);
}

/* --------------------------------------------------------------------------
   二、极简白：米白底 + 细黑线 + 单一金色短规
   -------------------------------------------------------------------------- */
function drawMinimal(ctx, k) {
  const W = CARD_W, H = CARD_H;
  const INK = '#16181C';
  const MUTED = '#7C776C';
  const FAINT = '#A8A296';

  ctx.fillStyle = '#F7F3EA';
  ctx.fillRect(0, 0, W, H);

  /* 内框细线 */
  ctx.strokeStyle = 'rgba(22,24,28,.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(28.5, 28.5, W - 57, H - 57);

  /* 品牌 */
  ctx.fillStyle = INK;
  roundRect(ctx, 48, 44, 58, 58, 14); ctx.fill();
  ctx.fillStyle = '#F7F3EA';
  ctx.font = '800 32px ' + FAM_SANS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('星', 77, 74);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = '600 31px ' + FAM_SANS;
  ctx.fillText('星河科技', 122, 74);
  ctx.fillStyle = FAINT;
  ctx.font = '400 14px ' + FAM_SANS;
  trackedText(ctx, 'STARLIGHT VISITOR', 123, 102, 4);

  /* 状态：只用一个点 + 文字，保持克制 */
  const info = statusInfo(k);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(22,24,28,.72)';
  ctx.font = '400 18px ' + FAM_SANS;
  ctx.fillText(info.label, W - 52, 76);
  ctx.beginPath();
  ctx.arc(W - 52 - ctx.measureText(info.label).width - 16, 70, 5, 0, Math.PI * 2);
  ctx.fillStyle = info.color;
  ctx.fill();

  /* 标题 */
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = '400 78px ' + FAM_SERIF;
  trackedText(ctx, '邀请卡', 48, 212, 12);

  ctx.fillStyle = FAINT;
  ctx.font = '400 15px ' + FAM_SANS;
  trackedText(ctx, 'INVITATION CARD', 48, 250, 6);

  /* 金色短规 */
  ctx.fillStyle = FA.gold;
  ctx.fillRect(48, 276, 96, 3);

  /* 访客 */
  ctx.fillStyle = FAINT;
  ctx.font = '400 16px ' + FAM_SANS;
  ctx.fillText('访客', 48, 334);

  ctx.fillStyle = INK;
  const nameSize = fitFont(ctx, k.guestName, 660, 50, '600', FAM_SANS);
  ctx.font = '600 ' + nameSize + 'px ' + FAM_SANS;
  ctx.fillText(k.guestName, 48, 384);

  if (k.company) {
    ctx.fillStyle = MUTED;
    const cs = fitFont(ctx, k.company, 700, 25, '400', FAM_SANS);
    ctx.font = '400 ' + cs + 'px ' + FAM_SANS;
    ctx.fillText(k.company, 48, 422);
  }

  /* 明细 */
  const cells = detailCells(k);
  const colX = [48, 540];
  const rowY = [486, 556];
  cells.forEach((c, i) => {
    const x = colX[i % 2];
    const y = rowY[Math.floor(i / 2)];
    ctx.textAlign = 'left';
    ctx.fillStyle = FAINT;
    ctx.font = '400 16px ' + FAM_SANS;
    ctx.fillText(c[0], x, y);
    ctx.fillStyle = INK;
    const s2 = fitFont(ctx, c[1], 440, 26, '400', FAM_SANS);
    ctx.font = '400 ' + s2 + 'px ' + FAM_SANS;
    ctx.fillText(c[1], x, y + 32);
  });

  /* 分隔 */
  ctx.strokeStyle = 'rgba(22,24,28,.14)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(48, 632); ctx.lineTo(W - 48, 632); ctx.stroke();

  /* 邀请码 */
  ctx.fillStyle = FAINT;
  ctx.font = '500 17px ' + FAM_SANS;
  trackedText(ctx, '邀 请 码', 48, 692, 3);

  ctx.fillStyle = INK;
  ctx.font = '700 168px ' + FAM_MONO;
  ctx.fillText(k.code, 40, 848);

  ctx.fillStyle = MUTED;
  ctx.font = '400 22px ' + FAM_SANS;
  ctx.fillText('到访时告知门岗，或出示右侧二维码', 48, 898);

  ctx.fillStyle = FAINT;
  ctx.font = '400 17px ' + FAM_MONO;
  ctx.fillText(k.token, 48, 936);

  /* 二维码 */
  const qrSize = 336;
  const qrX = W - 48 - qrSize;
  const qrY = 660;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, qrX - 12, qrY - 12, qrSize + 24, qrSize + 24, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(22,24,28,.16)';
  ctx.lineWidth = 1;
  roundRect(ctx, qrX - 12, qrY - 12, qrSize + 24, qrSize + 24, 10); ctx.stroke();
  drawQR(ctx, qrX, qrY, qrSize, k.token);

  ctx.textAlign = 'center';
  ctx.fillStyle = FAINT;
  ctx.font = '400 16px ' + FAM_SANS;
  ctx.fillText('扫 码 核 验', qrX + qrSize / 2, qrY + qrSize + 44);

  /* 底部 */
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  ctx.font = '400 21px ' + FAM_SANS;
  ctx.fillText('通行人数 ' + k.quota + ' 人', 48, 1150);

  ctx.textAlign = 'right';
  ctx.fillStyle = FAINT;
  ctx.font = '400 19px ' + FAM_SANS;
  ctx.fillText('仅限本人使用 · 过期作废', W - 48, 1150);

  ctx.strokeStyle = 'rgba(22,24,28,.1)';
  ctx.beginPath(); ctx.moveTo(48, 1218); ctx.lineTo(W - 48, 1218); ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = FAINT;
  ctx.font = '400 17px ' + FAM_SANS;
  ctx.fillText('星河科技 · 访客通行管理系统', 48, 1272);

  ctx.textAlign = 'right';
  ctx.fillText('二维码仅供门岗核验', W - 48, 1272);
}

/* --------------------------------------------------------------------------
   三、墨金：全深色 + 金线边框 + 对称构图
   -------------------------------------------------------------------------- */
function drawNoir(ctx, k) {
  const W = CARD_W, H = CARD_H;
  const GOLD = FA.gold;

  const bg = ctx.createRadialGradient(W / 2, 380, 60, W / 2, 520, 900);
  bg.addColorStop(0, '#191A20');
  bg.addColorStop(.55, '#0D0E12');
  bg.addColorStop(1, '#050507');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* 金线边框 + 四角 */
  ctx.strokeStyle = 'rgba(201,169,97,.28)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(30, 30, W - 60, H - 60);
  ctx.strokeStyle = 'rgba(201,169,97,.75)';
  ctx.lineWidth = 3;
  const corner = (x, y, dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * 46, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * 46);
    ctx.stroke();
  };
  corner(30, 30, 1, 1); corner(W - 30, 30, -1, 1);
  corner(30, H - 30, 1, -1); corner(W - 30, H - 30, -1, -1);

  /* 品牌居中 */
  ctx.fillStyle = GOLD;
  roundRect(ctx, W / 2 - 29, 74, 58, 58, 14); ctx.fill();
  ctx.fillStyle = '#0B0803';
  ctx.font = '800 32px ' + FAM_SANS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('星', W / 2, 104);
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = '#EDE6D6';
  ctx.font = '600 30px ' + FAM_SANS;
  ctx.fillText('星 河 科 技', W / 2, 176);
  ctx.fillStyle = 'rgba(201,169,97,.55)';
  ctx.font = '400 14px ' + FAM_SANS;
  ctx.textAlign = 'center';
  trackedText(ctx, 'INVITATION CARD', W / 2, 206, 5);

  /* 状态：标题下方两侧细线夹住 */
  const info = statusInfo(k);
  ctx.font = '400 18px ' + FAM_SANS;
  ctx.fillStyle = info.color;
  const labelW = ctx.measureText(info.label).width;
  ctx.fillText(info.label, W / 2, 268);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - labelW / 2 - 110, 262); ctx.lineTo(W / 2 - labelW / 2 - 24, 262);
  ctx.moveTo(W / 2 + labelW / 2 + 24, 262); ctx.lineTo(W / 2 + labelW / 2 + 110, 262);
  ctx.stroke();

  /* 标题 */
  ctx.fillStyle = '#F5EBD2';
  ctx.font = '400 76px ' + FAM_SERIF;
  ctx.textAlign = 'center';
  trackedText(ctx, '邀请卡', W / 2, 366, 14);

  /* 访客 */
  ctx.fillStyle = '#F2EFE6';
  const nameSize = fitFont(ctx, k.guestName, 760, 46, '600', FAM_SANS);
  ctx.font = '600 ' + nameSize + 'px ' + FAM_SANS;
  ctx.fillText(k.guestName, W / 2, 434);

  if (k.company) {
    ctx.fillStyle = 'rgba(190,182,163,.72)';
    const cs = fitFont(ctx, k.company, 700, 24, '400', FAM_SANS);
    ctx.font = '400 ' + cs + 'px ' + FAM_SANS;
    ctx.fillText(k.company, W / 2, 470);
  }

  /* 明细：一行式，避免两列在居中构图里挤在一起 */
  const meta = [
    (k.hostName + (k.deptName ? ' · ' + k.deptName : '')) || '—',
    k.reason || '—',
    k.roomName || '面谈',
    fmtRange(k.validFrom, k.validTo)
  ].join('　·　');
  ctx.fillStyle = 'rgba(230,224,211,.82)';
  const metaSize = fitFont(ctx, meta, 930, 23, '400', FAM_SANS);
  ctx.font = '400 ' + metaSize + 'px ' + FAM_SANS;
  ctx.textAlign = 'center';
  ctx.fillText(meta, W / 2, 518);

  /* 菱形分隔 */
  ctx.strokeStyle = 'rgba(201,169,97,.3)';
  ctx.beginPath(); ctx.moveTo(340, 560); ctx.lineTo(470, 560); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(610, 560); ctx.lineTo(740, 560); ctx.stroke();
  ctx.save();
  ctx.translate(W / 2, 560);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = GOLD;
  ctx.strokeRect(-7, -7, 14, 14);
  ctx.restore();

  /* 二维码居中 */
  const qrSize = 352;
  const qrX = (W - qrSize) / 2;
  const qrY = 592;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, qrX - 12, qrY - 12, qrSize + 24, qrSize + 24, 10); ctx.fill();
  drawQR(ctx, qrX, qrY, qrSize, k.token);
  ctx.fillStyle = 'rgba(201,169,97,.55)';
  ctx.font = '400 16px ' + FAM_SANS;
  trackedText(ctx, '扫 码 核 验', W / 2, qrY + qrSize + 40, 4);

  /* 邀请码 */
  ctx.fillStyle = 'rgba(201,169,97,.5)';
  ctx.font = '400 15px ' + FAM_SANS;
  trackedText(ctx, '邀 请 码', W / 2, 1024, 4);

  ctx.fillStyle = '#F7E9C6';
  ctx.font = '700 138px ' + FAM_MONO;
  ctx.fillText(k.code, W / 2, 1160);

  ctx.fillStyle = 'rgba(190,182,163,.55)';
  ctx.font = '400 17px ' + FAM_SANS;
  ctx.fillText('通行人数 ' + k.quota + ' 人 · 仅限本人使用', W / 2, 1214);

  ctx.fillStyle = 'rgba(190,182,163,.32)';
  ctx.font = '400 15px ' + FAM_SANS;
  ctx.fillText('星河科技 · 访客通行管理系统', W / 2, 1272);
}

/* --------------------------------------------------------------------------
   四、青玉：深青底 + 玉石圆环 + 叠层码面
   -------------------------------------------------------------------------- */
function drawJade(ctx, k) {
  const W = CARD_W, H = CARD_H;
  const MINT = '#9FD8C0';

  const bg = ctx.createLinearGradient(0, 0, W * .6, H);
  bg.addColorStop(0, '#0E332B');
  bg.addColorStop(.5, '#08211C');
  bg.addColorStop(1, '#04120F');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  /* 玉石圆环 */
  ctx.save();
  ctx.strokeStyle = 'rgba(159,216,192,.10)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(880, 130, 300, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(159,216,192,.06)';
  ctx.beginPath(); ctx.arc(880, 130, 220, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  const glow = ctx.createRadialGradient(120, 60, 20, 120, 60, 620);
  glow.addColorStop(0, 'rgba(159,216,192,.14)');
  glow.addColorStop(1, 'rgba(159,216,192,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 620);

  /* 品牌 */
  ctx.fillStyle = '#CFEADF';
  roundRect(ctx, 48, 44, 60, 60, 15); ctx.fill();
  ctx.fillStyle = '#06231C';
  ctx.font = '800 33px ' + FAM_SANS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('星', 78, 74);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left';
  ctx.fillStyle = '#EAF7F0';
  ctx.font = '600 31px ' + FAM_SANS;
  ctx.fillText('星河科技', 126, 74);
  ctx.fillStyle = 'rgba(159,216,192,.6)';
  ctx.font = '400 14px ' + FAM_SANS;
  trackedText(ctx, 'STARLIGHT VISITOR', 127, 103, 4);

  drawStatusPill(ctx, W - 48 - 148, 52, 148, 44, k);

  /* 标题 */
  ctx.textAlign = 'left';
  ctx.fillStyle = '#F0FBF6';
  ctx.font = '400 68px ' + FAM_SERIF;
  trackedText(ctx, '邀请卡', 48, 202, 12);

  ctx.fillStyle = 'rgba(159,216,192,.55)';
  ctx.font = '400 16px ' + FAM_SANS;
  trackedText(ctx, 'INVITATION CARD', 52, 242, 6);

  /* 访客 */
  ctx.fillStyle = 'rgba(143,191,175,.9)';
  ctx.font = '400 18px ' + FAM_SANS;
  ctx.fillText('访客', 48, 300);

  ctx.fillStyle = '#F2FBF7';
  const nameSize = fitFont(ctx, k.guestName, 640, 48, '600', FAM_SANS);
  ctx.font = '600 ' + nameSize + 'px ' + FAM_SANS;
  ctx.fillText(k.guestName, 48, 350);

  if (k.company) {
    ctx.fillStyle = 'rgba(169,207,194,.85)';
    const cs = fitFont(ctx, k.company, 700, 25, '400', FAM_SANS);
    ctx.font = '400 ' + cs + 'px ' + FAM_SANS;
    ctx.fillText(k.company, 48, 388);
  }

  /* 明细 */
  const cells = detailCells(k);
  const colX = [48, 520];
  const rowY = [438, 512];
  cells.forEach((c, i) => {
    const x = colX[i % 2];
    const y = rowY[Math.floor(i / 2)];
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(127,179,164,.85)';
    ctx.font = '400 16px ' + FAM_SANS;
    ctx.fillText(c[0], x, y);
    ctx.fillStyle = 'rgba(220,239,231,.95)';
    const s2 = fitFont(ctx, c[1], 440, 26, '400', FAM_SANS);
    ctx.font = '400 ' + s2 + 'px ' + FAM_SANS;
    ctx.fillText(c[1], x, y + 31);
  });

  /* 叠层码面 */
  const panelY = 580, panelH = 486;
  const pg = ctx.createLinearGradient(48, panelY, W - 48, panelY + panelH);
  pg.addColorStop(0, 'rgba(159,216,192,.13)');
  pg.addColorStop(1, 'rgba(159,216,192,.04)');
  ctx.fillStyle = pg;
  roundRect(ctx, 48, panelY, W - 96, panelH, 30); ctx.fill();
  ctx.strokeStyle = 'rgba(159,216,192,.24)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 48, panelY, W - 96, panelH, 30); ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(159,216,192,.85)';
  ctx.font = '500 18px ' + FAM_SANS;
  trackedText(ctx, '邀 请 码', 92, panelY + 72, 3);

  ctx.fillStyle = '#EAF7F0';
  ctx.font = '700 146px ' + FAM_MONO;
  ctx.fillText(k.code, 84, panelY + 226);

  ctx.fillStyle = 'rgba(169,207,194,.8)';
  ctx.font = '400 22px ' + FAM_SANS;
  ctx.fillText('到访时告知门岗，或出示右侧二维码', 92, panelY + 282);

  ctx.fillStyle = 'rgba(127,179,164,.6)';
  ctx.font = '400 17px ' + FAM_MONO;
  ctx.fillText(k.token, 92, panelY + 322);

  const qrSize = 348;
  const qrX = W - 48 - 36 - qrSize;
  const qrY = panelY + 56;
  ctx.fillStyle = '#F3FBF7';
  roundRect(ctx, qrX - 14, qrY - 14, qrSize + 28, qrSize + 28, 16); ctx.fill();
  drawQR(ctx, qrX, qrY, qrSize, k.token);

  ctx.textAlign = 'left';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(159,216,192,.55)';
  ctx.font = '400 16px ' + FAM_SANS;
  trackedText(ctx, '扫 码 核 验', qrX + qrSize / 2, 1018, 3);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(159,216,192,.55)';
  ctx.font = '400 17px ' + FAM_SANS;
  ctx.fillText('通行人数 ' + k.quota + ' 人', 48, 1150);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(159,216,192,.45)';
  ctx.fillText('仅限本人使用 · 过期作废', W - 48, 1150);

  ctx.strokeStyle = 'rgba(159,216,192,.12)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(48, 1216); ctx.lineTo(W - 48, 1216); ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(159,216,192,.35)';
  ctx.font = '400 17px ' + FAM_SANS;
  ctx.fillText('星河科技 · 访客通行管理系统', 48, 1270);

  ctx.textAlign = 'right';
  ctx.fillText('二维码仅供门岗核验', W - 48, 1270);
}

function detailCells(k) {
  const hostLine = k.hostName + (k.deptName ? ' · ' + k.deptName : '');
  return [
    ['拜访', hostLine || '—'],
    ['来访事由', k.reason || '—'],
    ['接待地点', k.roomName || '面谈'],
    ['有效期', fmtRange(k.validFrom, k.validTo)]
  ];
}
function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片生成失败')), 'image/png');
  });
}

async function copyCardImage(cred, canvas) {
  const cv = canvas || drawCard(document.createElement('canvas'), cred, cred && cred.style);
  const blob = await canvasBlob(cv);
  if (window.isSecureContext && navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch (e) {
      /* 某些浏览器即使有接口也会拒绝，走兜底 */
    }
  }
  return false;
}

function downloadCanvas(canvas, filename) {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename || 'invitation.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function copyFallback(cred) {
  const canvas = drawCard(document.createElement('canvas'), cred, cred && cred.style);
  const url = canvas.toDataURL('image/png');
  openModal({
    title: '复制图片',
    sub: '当前浏览器不开放剪贴板写入，请手动复制',
    wide: true,
    body:
      '<div style="display:flex;gap:20px;flex-wrap:wrap">' +
        '<div style="flex:0 0 auto;margin:0 auto"><img src="' + url + '" class="copy-preview" alt="邀请卡"></div>' +
        '<div style="flex:1;min-width:200px;font-size:12.5px;color:var(--txt-2);line-height:2">' +
          '<div style="color:var(--txt);font-size:13.5px;margin-bottom:8px">这样操作可以直接发微信：</div>' +
          '1. 在图片上右键 → <b style="color:var(--gold-lt)">复制图像</b><br>' +
          '2. 打开微信聊天窗口 → <b style="color:var(--gold-lt)">Ctrl + V</b><br>' +
          '3. 手机上长按图片 → 保存 / 转发<br>' +
          '<div style="margin-top:14px;padding:11px 13px;border-radius:9px;background:rgba(229,165,75,.07);border:1px solid rgba(229,165,75,.18);color:rgba(239,193,120,.9);line-height:1.8">' +
            '用 <b>localhost</b> 打开时可以直接点「复制图片」，局域网 IP + http 受浏览器安全策略限制。' +
          '</div>' +
        '</div>' +
      '</div>',
    foot: '<button class="btn ghost" data-mclose>关闭</button><button class="btn primary" id="fbDownload">下载 PNG</button>',
    onMount(root) {
      $('#fbDownload', root).onclick = () => downloadCanvas(canvas, fileName(cred));
    }
  });
}

function fileName(cred) {
  return '邀请卡_' + (cred.guestName || '访客') + '_' + (cred.code || '') + '.png';
}

/* ==========================================================================
   导航与路由
   ========================================================================== */
const ROUTES = [
  { key: 'dashboard', path: '/dashboard', title: '工作台',    sub: '今日访客与通行概览',       icon: 'i-grid',  group: '概览' },
  { key: 'invite',    path: '/invite',    title: '发起邀请',  sub: '填写访客信息，生成可转发的邀请卡', icon: 'i-plus',  group: '访客', perm: 'invite.create' },
  { key: 'records',   path: '/records',   title: '邀请记录',  sub: '已生成的邀请与实时状态',   icon: 'i-list',  group: '访客', any: ['invite.view.self', 'invite.view.dept', 'invite.view.all'] },
  { key: 'guard',     path: '/guard',     title: '门岗核验',  sub: '打开门岗终端，扫码或输码核验', icon: 'i-shield', group: '门岗', perm: 'guard.verify', external: '/guard' },
  { key: 'ledger',    path: '/ledger',    title: '通行台账',  sub: '门岗核验记录与导出',       icon: 'i-book',  group: '门岗', perm: 'ledger.view' },
  { key: 'org',       path: '/org',       title: '人员架构',  sub: '部门、成员与角色归属',     icon: 'i-org',   group: '组织', perm: 'staff.view' },
  { key: 'rooms',     path: '/rooms',     title: '会议室',    sub: '接待资源与当日占用',       icon: 'i-room',  group: '组织', perm: 'room.view' },
  { key: 'perms',     path: '/perms',     title: '权限管理',  sub: '角色权限矩阵与数据范围',   icon: 'i-shield', group: '系统', perm: 'role.manage' },
  { key: 'audit',     path: '/audit',     title: '操作日志',  sub: '关键操作审计',             icon: 'i-log',   group: '系统', perm: 'audit.view' },
  { key: 'settings',  path: '/settings',  title: '系统设置',  sub: '组织信息与数据维护',       icon: 'i-clock', group: '系统', perm: 'system.manage' },
  { key: 'result',    path: '/result',    title: '邀请已生成', sub: '复制图片，直接粘贴到微信', icon: 'i-check', hidden: true }
];

function routeAllowed(r) {
  if (r.perm) return can(r.perm);
  if (r.any) return canAny(r.any);
  return true;
}

function renderNav() {
  const nav = $('#nav');
  let html = '';
  let group = '';
  ROUTES.filter(r => !r.hidden && routeAllowed(r)).forEach(r => {
    if (r.group !== group) {
      group = r.group;
      html += '<div class="nav-group">' + esc(group) + '</div>';
    }
    const href = r.external ? r.external : '#' + r.path;
    const attrs = r.external ? ' target="_blank" rel="noopener"' : '';
    html += '<a class="nav-item' + (S.route === r.path ? ' on' : '') + '" href="' + href + '"' + attrs + '>' +
      '<span class="ic">' + icon(r.icon, 17) + '</span>' + esc(r.title) +
      (r.external ? '<span class="ext">↗</span>' : '') + '</a>';
  });
  nav.innerHTML = html;
}

function applyMe() {
  if (!S.me) return;
  $('#sideAvatar').textContent = initials(S.me.name);
  $('#sideName').textContent = S.me.name;
  $('#sideRole').textContent = S.me.roleName + (S.me.deptName ? ' · ' + S.me.deptName : '');
  $('#orgTag').textContent = (S.data.settings.orgName || 'STARLIGHT').slice(0, 12).toUpperCase();
}

function go(path) {
  if (location.hash === '#' + path) { renderRoute(); return; }
  location.hash = '#' + path;
}

function currentPath() {
  return (location.hash || '').replace(/^#/, '') || '/dashboard';
}

function renderRoute() {
  const path = currentPath();
  const route = ROUTES.find(r => r.path === path);
  if (!route || !routeAllowed(route)) {
    const first = ROUTES.find(routeAllowed);
    if (first && path !== first.path) { location.replace('#' + first.path); return; }
    $('#view').innerHTML = '<div class="empty"><b>没有可访问的页面</b>当前账号没有任何功能权限，请联系管理员</div>';
    return;
  }
  if (route.external) { location.href = route.external; return; }
  S.route = path;
  closeDrawer();
  renderNav();
  $('#pageTitle').textContent = route.title;
  $('#pageSub').textContent = route.sub;
  $('#topActions').innerHTML =
    '<button class="icon-btn" id="btnRefresh" title="刷新">' + icon('i-refresh', 17) + '</button>';
  $('#btnRefresh').onclick = () => renderRoute();
  $('#sidebar').classList.remove('open');

  const view = $('#view');
  view.innerHTML = '<div class="empty">加载中…</div>';
  const fn = {
    dashboard: pageDashboard, invite: pageInvite, records: pageRecords,
    ledger: pageLedger, org: pageOrg, rooms: pageRooms,
    perms: pagePerms, audit: pageAudit, settings: pageSettings,
    result: pageResult
  }[route.key];
  if (fn) fn().catch(err => {
    if (err.status === 401) return;
    view.innerHTML = '<div class="empty"><b>页面加载失败</b>' + esc(err.message) + '</div>';
  });
  window.scrollTo(0, 0);
}

/* ==========================================================================
   登录
   ========================================================================== */
const DEMO = [
  { u: 'admin', p: 'admin123', n: '管理员' },
  { u: 'zhang.qishan', p: 'vp123456', n: '部门主管' },
  { u: 'li.wei', p: 'vp123456', n: '员工' },
  { u: 'guard01', p: 'vp123456', n: '保安' }
];

function showLogin() {
  S.me = null;
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  closeModal();
  closeDrawer();
  setTimeout(() => { const el = $('#loginUser'); if (el) el.focus(); }, 60);
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
}

async function doLogin(e) {
  e.preventDefault();
  const btn = $('#loginBtn');
  const err = $('#loginErr');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = '正在登录…';
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: {
        username: $('#loginUser').value.trim(),
        password: $('#loginPass').value,
        remember: $('#loginRemember').checked
      }
    });
    await loadBootstrap();
    if (S.me.roleKey === 'guard') { location.href = '/guard'; return; }
    showApp();
    if (!location.hash) location.hash = '#/dashboard';
    renderRoute();
    if (S.me.mustChangePassword) setTimeout(mustChangePrompt, 600);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '进入系统';
  }
}

async function loadBootstrap() {
  const data = await api('/api/bootstrap');
  S.me = data.me;
  S.data = data;
  applyMe();
  renderNav();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  S.me = null;
  showLogin();
  toast('已退出登录');
}

/* ==========================================================================
   工作台
   ========================================================================== */
async function pageDashboard() {
  const d = await api('/api/dashboard');
  const st = d.stats;
  const maxTrend = Math.max.apply(null, d.trend.map(t => t.count).concat([1]));
  const now = new Date();
  const hh = now.getHours();
  const greet = hh < 6 ? '凌晨好' : hh < 11 ? '早上好' : hh < 14 ? '中午好' : hh < 18 ? '下午好' : '晚上好';
  const week = ['日', '一', '二', '三', '四', '五', '六'];

  const trendHtml = d.trend.map(t => {
    const hgt = t.count ? Math.max(6, Math.round(t.count / maxTrend * 92)) : 3;
    return '<div class="bar"><div class="v">' + (t.count || '') + '</div>' +
      '<div class="col" style="height:' + hgt + '%"></div>' +
      '<div class="lab">' + esc(t.label) + '</div></div>';
  }).join('');

  const roomHtml = d.rooms.length ? d.rooms.map(r =>
    '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-2)">' +
      '<div style="flex:1;min-width:0"><div style="font-size:12.5px">' + esc(r.name) + '</div>' +
      '<div style="font-size:10.5px;color:var(--txt-3);margin-top:2px">' + esc(r.building) + ' · ' + esc(r.floor) + 'F</div></div>' +
      (r.busy
        ? '<span class="badge gold">占用 · ' + r.guests + ' 人</span>'
        : '<span class="badge active">空闲</span>') +
    '</div>'
  ).join('') : '<div class="empty" style="padding:30px 0">还没有会议室</div>';

  const recentHtml = d.recent.length ? d.recent.map(i =>
    '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-2)">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(i.guestName) +
        (i.company ? '<span style="color:var(--txt-3);font-size:11px;margin-left:6px">' + esc(i.company) + '</span>' : '') + '</div>' +
        '<div style="font-size:10.5px;color:var(--txt-3);margin-top:2px">' + esc(fmtRange(i.validFrom, i.validTo)) + '</div>' +
      '</div>' +
      '<span class="badge ' + i.status + '">' + esc(i.statusText) + '</span>' +
    '</div>'
  ).join('') : '<div class="empty" style="padding:30px 0">还没有邀请</div>';

  const auditHtml = (d.audits || []).length ? d.audits.map(a =>
    '<li><span class="dot"></span><div><b>' + esc(a.userName) + ' · ' + esc(actionText(a.action)) + '</b>' +
    '<small>' + esc(a.target || '') + '　' + esc(fromNow(a.ts)) + '</small></div></li>'
  ).join('') : '<li style="color:var(--txt-3);font-size:12px">暂无操作记录</li>';

  $('#view').innerHTML =
    '<div class="page-head">' +
      '<div><h2>' + greet + '，' + esc(S.me.name) + '</h2>' +
      '<p>' + now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 星期' + week[now.getDay()] +
      ' · ' + esc(S.me.roleName) + (S.me.deptName ? ' / ' + esc(S.me.deptName) : '') + '</p></div>' +
      '<div class="spacer"></div>' +
      (can('guard.verify') ? '<a class="btn ghost" href="/guard" target="_blank" rel="noopener">' + icon('i-shield', 15) + '门岗核验</a>' : '') +
      (can('invite.create') ? '<button class="btn primary" data-go-invite>' + icon('i-plus', 15) + '发起邀请</button>' : '') +
    '</div>' +

    '<div class="grid g4" style="margin-bottom:16px">' +
      '<div class="stat"><div class="k">今日发出邀请</div><div class="n">' + st.todayInvites + '</div><div class="foot">累计有效 ' + st.activeInvites + ' 张</div></div>' +
      '<div class="stat"><div class="k">今日入场人次</div><div class="n">' + st.todayPeople + '</div><div class="foot">核验通过 ' + st.todayEntries + ' 次</div></div>' +
      '<div class="stat"><div class="k">待生效邀请</div><div class="n">' + st.waiting + '</div><div class="foot">到期自动失效</div></div>' +
      '<div class="stat"><div class="k">今日拒绝次数</div><div class="n">' + st.denied + '</div><div class="foot">异常尝试已记录</div></div>' +
    '</div>' +

    '<div class="split" style="margin-bottom:16px">' +
      '<div class="panel"><div class="panel-head"><div><h3>近 7 天入场趋势</h3><div class="sub">按首次入场人次统计</div></div></div>' +
        '<div class="panel-body"><div class="trend">' + trendHtml + '</div></div></div>' +
      '<div class="panel"><div class="panel-head"><div><h3>会议室占用</h3><div class="sub">当前时段</div></div>' +
        '<div class="right"><a class="btn sm ghost" href="#/rooms">全部</a></div></div>' +
        '<div class="panel-body" style="padding-top:6px;padding-bottom:8px">' + roomHtml + '</div></div>' +
    '</div>' +

    '<div class="split">' +
      '<div class="panel"><div class="panel-head"><div><h3>最近邀请</h3><div class="sub">按创建时间排序</div></div>' +
        '<div class="right"><a class="btn sm ghost" href="#/records">查看全部</a></div></div>' +
        '<div class="panel-body" style="padding-top:4px;padding-bottom:8px">' + recentHtml + '</div></div>' +
      '<div class="panel"><div class="panel-head"><div><h3>最近操作</h3><div class="sub">审计日志</div></div></div>' +
        '<div class="panel-body"><ul class="timeline">' + auditHtml + '</ul></div></div>' +
    '</div>';

  const b = $('[data-go-invite]');
  if (b) b.onclick = () => go('/invite');
}

function actionText(a) {
  const map = {
    'auth.login': '登录', 'auth.logout': '退出', 'auth.login.fail': '登录失败', 'auth.password': '修改密码',
    'invite.create': '发起邀请', 'invite.revoke': '撤销邀请', 'invite.extend': '延期邀请',
    'user.create': '新增成员', 'user.update': '修改成员', 'user.delete': '删除成员', 'user.resetpw': '重置密码',
    'dept.create': '新增部门', 'dept.update': '修改部门', 'dept.delete': '删除部门',
    'role.create': '新增角色', 'role.update': '修改权限', 'role.delete': '删除角色',
    'room.create': '新增会议室', 'room.update': '修改会议室', 'room.delete': '删除会议室',
    'ledger.export': '导出台账', 'system.settings': '系统设置'
  };
  return map[a] || a;
}

/* ==========================================================================
   发起邀请
   ========================================================================== */
function defaultTimes() {
  const d = new Date();
  let start = new Date(d.getTime() + 5 * 60000);
  start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
  let end = new Date(start.getTime() + 2 * 3600e3);
  const eod = new Date(d); eod.setHours(23, 59, 0, 0);
  /* 深夜发起：今天已经放不下 30 分钟，就直接给明天上午 */
  if (eod.getTime() - start.getTime() < 30 * 60000) {
    start = new Date(d);
    start.setDate(start.getDate() + 1);
    start.setHours(9, 0, 0, 0);
    end = new Date(start.getTime() + 2 * 3600e3);
  } else if (end > eod) {
    end = eod;
  }
  return { date: dateStr(start), start: pad(start.getHours()) + ':' + pad(start.getMinutes()), end: pad(end.getHours()) + ':' + pad(end.getMinutes()) };
}

function tsOf(date, time) {
  return new Date(date + 'T' + time + ':00').getTime();
}

async function pageInvite() {
  const t = defaultTimes();
  const roomOpts = S.data.rooms.filter(r => r.status === 'active');

  $('#view').innerHTML =
    '<div class="split">' +
      '<div>' +
        '<div class="panel pad" style="margin-bottom:14px">' +
          '<div style="font-size:11px;color:var(--txt-3);letter-spacing:.14em;margin-bottom:16px">访 客 信 息</div>' +
          '<div class="row2">' +
            '<div class="field"><label>访客姓名<span class="req">*</span></label><input class="input" id="fName" placeholder="例如 周立群" autocomplete="off"></div>' +
            '<div class="field"><label>来访单位</label><input class="input" id="fCompany" placeholder="例如 中建八局" autocomplete="off"></div>' +
          '</div>' +
          '<div class="field"><label>来访事由<span class="req">*</span></label>' +
            '<select class="select" id="fReason">' +
              ['商务洽谈', '项目沟通', '技术交流', '会议', '面试', '供应商拜访', '培训', '维修维保', '快递物流']
                .map(x => '<option value="' + x + '">' + x + '</option>').join('') +
              '<option value="__other">其他（自定义）</option>' +
            '</select>' +
            '<input class="input" id="fReasonOther" placeholder="请填写具体事由" style="display:none;margin-top:8px" maxlength="40">' +
          '</div>' +
        '</div>' +

        '<div class="panel pad" style="margin-bottom:14px">' +
          '<div style="font-size:11px;color:var(--txt-3);letter-spacing:.14em;margin-bottom:16px">接 待 安 排</div>' +
          '<div class="row2">' +
            '<div class="field"><label>邀请人</label>' +
              '<div class="input readonly" title="邀请人固定为当前登录账号">' + esc(S.me.name) +
              (S.me.deptName ? ' · ' + esc(S.me.deptName) : '') + '<span class="ro-tag">本人</span></div>' +
            '</div>' +
            '<div class="field"><label>接待会议室</label><select class="select" id="fRoom">' +
              '<option value="">不指定</option>' +
              roomOpts.map(r => '<option value="' + esc(r.id) + '">' + esc(r.name) + ' · ' + esc(r.building) + ' ' + esc(r.floor) + 'F · ' + r.capacity + ' 人</option>').join('') +
            '</select></div>' +
          '</div>' +
          '<div class="field"><label>有效日期</label>' +
            '<div class="date-row">' +
              '<input class="input date-input" type="date" id="fDate" value="' + t.date + '">' +
              '<input class="input time-input" type="time" id="fStart" value="' + t.start + '">' +
              '<span class="sep">至</span>' +
              '<input class="input time-input" type="time" id="fEnd" value="' + t.end + '">' +
            '</div>' +
            '<div class="chips" style="margin-top:9px">' +
              '<span class="chip" data-quick="2h">2 小时</span>' +
              '<span class="chip" data-quick="today">今天剩余</span>' +
              '<span class="chip" data-quick="tomorrow">明天全天</span>' +
            '</div>' +
          '</div>' +
          '<div class="field"><label>通行人数</label><div class="chips" id="quotaChips">' +
            [1, 2, 3, 5, 10].map(n => '<span class="chip' + (n === 1 ? ' on' : '') + '" data-q="' + n + '">' + n + ' 人</span>').join('') +
          '</div></div>' +
          '<div class="field" style="margin-bottom:6px"><label>备注</label>' +
            '<textarea class="textarea" id="fNote" placeholder="停车、随行人员、接待要求等（仅内部可见）"></textarea></div>' +
          '<div class="err-line" id="inviteErr" hidden></div>' +
          '<button class="btn primary block lg" id="btnCreate" style="margin-top:12px">' + icon('i-plus', 16) + '生成邀请卡</button>' +
        '</div>' +
      '</div>' +

      '<div style="position:sticky;top:86px">' +
        '<div class="panel" style="padding:16px">' +
          '<div style="font-size:10px;color:var(--txt-3);letter-spacing:.16em;margin-bottom:10px">卡 面 样 式</div>' +
          '<div class="style-picker" id="stylePicker">' +
            CARD_STYLES.map(x => '<button type="button" class="style-opt' + (x.key === 'ticket' ? ' on' : '') + '" data-style="' + x.key + '" title="' + esc(x.desc) + '">' +
              '<canvas></canvas><span>' + esc(x.name) + '</span></button>').join('') +
          '</div>' +
          '<div class="card-stage" style="padding:12px"><canvas class="card" id="cardPreview" style="max-width:300px"></canvas></div>' +
          '<div style="font-size:11px;color:var(--txt-3);line-height:1.8;margin-top:14px">' +
            '卡面包含二维码与 4 位邀请码。访客出示手机，门岗扫码或用邀请码核验。<br>' +
            '二维码内容为凭证号，一次性生成，不可伪造。</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const st = { quota: 1, style: 'ticket' };
  const reasonValue = () => {
    const sel = $('#fReason');
    if (!sel) return '';
    return sel.value === '__other' ? $('#fReasonOther').value.trim() : sel.value;
  };

  const formValues = () => {
    if (!$('#fName')) return null;
    return {
    guestName: $('#fName').value.trim(),
    company: $('#fCompany').value.trim(),
    reason: reasonValue(),
    roomId: $('#fRoom').value,
    date: $('#fDate').value,
    start: $('#fStart').value,
    end: $('#fEnd').value,
    quota: st.quota,
    note: $('#fNote').value.trim()
    };
  };

  const preview = () => {
    const v = formValues();
    if (!v) return;
    const room = S.data.rooms.find(r => r.id === v.roomId);
    drawCard($('#cardPreview'), {
      guestName: v.guestName || '访客姓名',
      company: v.company,
      reason: v.reason,
      hostName: S.me.name,
      deptName: S.me.deptName,
      roomName: room ? room.name : '',
      roomPlace: room ? [room.building, room.floor ? room.floor + 'F' : '', room.name].filter(Boolean).join(' · ') : '',
      validFrom: tsOf(v.date || todayStr(), v.start || '09:00'),
      validTo: tsOf(v.date || todayStr(), v.end || '18:00'),
      quota: v.quota,
      code: '8888',
      token: 'SL0000000000',
      status: 'active'
    }, st.style);
  };

  const refresh = debounce(preview, 160);
  ['fName', 'fCompany', 'fReason', 'fReasonOther', 'fRoom', 'fDate', 'fStart', 'fEnd'].forEach(id => {
    const el = $('#' + id);
    if (el) el.addEventListener('input', refresh);
    if (el) el.addEventListener('change', refresh);
  });

  /* 事由选「其他」时才出现自定义输入框 */
  $('#fReason').addEventListener('change', function () {
    const other = $('#fReasonOther');
    const isOther = this.value === '__other';
    other.style.display = isOther ? 'block' : 'none';
    if (isOther) setTimeout(function () { other.focus(); }, 30);
    else other.value = '';
    preview();
  });

  $$('#quotaChips .chip').forEach(c => {
    c.onclick = () => {
      $$('#quotaChips .chip').forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      st.quota = Number(c.dataset.q);
      preview();
    };
  });

  $$('[data-quick]').forEach(b => {
    b.onclick = () => {
      const now = new Date();
      if (b.dataset.quick === '2h') {
        $('#fDate').value = dateStr(now);
        $('#fStart').value = pad(now.getHours()) + ':' + pad(now.getMinutes());
        const e = new Date(now.getTime() + 2 * 3600e3);
        $('#fEnd').value = pad(e.getHours()) + ':' + pad(e.getMinutes());
      } else if (b.dataset.quick === 'today') {
        $('#fDate').value = dateStr(now);
        $('#fStart').value = pad(now.getHours()) + ':' + pad(now.getMinutes());
        $('#fEnd').value = '23:59';
      } else {
        const tm = new Date(now.getTime() + 86400e3);
        $('#fDate').value = dateStr(tm);
        $('#fStart').value = '09:00';
        $('#fEnd').value = '18:00';
      }
      preview();
    };
  });

  /* 卡面样式缩略图 + 切换 */
  (function initStylePicker() {
    const now = Date.now();
    const sample = {
      guestName: '林嘉怡', company: '远景能源', reason: '商务洽谈',
      hostName: S.me.name, deptName: S.me.deptName,
      roomName: '星河厅', roomPlace: 'A 座 · 28F · 星河厅',
      validFrom: now, validTo: now + 3 * 3600e3,
      quota: 2, code: '3186', token: 'SL1105AB3K7M', status: 'active'
    };
    $$('#stylePicker .style-opt').forEach(btn => {
      const cv = btn.querySelector('canvas');
      if (cv) drawCard(cv, sample, btn.dataset.style, 0.26);
      btn.onclick = () => {
        st.style = btn.dataset.style;
        $$('#stylePicker .style-opt').forEach(x => x.classList.toggle('on', x === btn));
        preview();
      };
    });
  })();

  preview();

  $('#btnCreate').onclick = async () => {
    const v = formValues();
    const err = $('#inviteErr');
    err.hidden = true;
    if (!v.guestName) { err.textContent = '请填写访客姓名'; err.hidden = false; return; }
    if (!v.reason) { err.textContent = $('#fReason').value === '__other' ? '请填写具体来访事由' : '请选择来访事由'; err.hidden = false; return; }
    const from = tsOf(v.date, v.start);
    const to = tsOf(v.date, v.end);
    if (!isFinite(from) || !isFinite(to)) { err.textContent = '请选择有效的日期与时间'; err.hidden = false; return; }
    if (to <= from) { err.textContent = '结束时间必须晚于开始时间'; err.hidden = false; return; }

    const btn = $('#btnCreate');
    btn.disabled = true;
    btn.innerHTML = '正在生成…';

    const payload = {
      guestName: v.guestName, company: v.company, reason: v.reason,
      roomId: v.roomId, quota: v.quota, style: st.style,
      note: v.note,
      validFrom: from, validTo: to
    };

    try {
      let r;
      try {
        r = await api('/api/invites', { method: 'POST', body: payload });
      } catch (ex) {
        if (ex.status === 409 && ex.payload.busy) {
          const busy = ex.payload.busy.map(b => esc(b.guestName + '（' + b.hostName + '）' + fmtRange(b.validFrom, b.validTo))).join('<br>');
          const ok = await confirmDialog('会议室时段冲突',
            '该会议室在所选时段已有安排：<br><span style="color:var(--txt-3)">' + busy + '</span><br><br>仍要使用这间会议室吗？',
            '仍要使用');
          if (!ok) { btn.disabled = false; btn.innerHTML = icon('i-plus', 16) + '生成邀请卡'; return; }
          payload.force = true;
          r = await api('/api/invites', { method: 'POST', body: payload });
        } else {
          throw ex;
        }
      }
      S.lastCreated = r.credential;
      go('/result');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.innerHTML = icon('i-plus', 16) + '生成邀请卡';
    }
  };
}

/* ==========================================================================
   生成结果
   ========================================================================== */
async function pageResult() {
  if (!S.lastCreated) { go('/records'); return; }
  const c = S.lastCreated;

  $('#view').innerHTML =
    '<div class="result-wrap">' +
      '<div class="card-stage" style="position:sticky;top:86px"><canvas class="card" id="cardResult"></canvas></div>' +
      '<div class="result-info">' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:14px">' +
          '<span class="badge active">已生成</span><span style="font-size:11px;color:var(--txt-3)">邀请码 ' + esc(c.code) + ' · ' + esc(c.styleName || '票券') + '样式</span></div>' +
        '<h2>' + esc(c.guestName) + '　的邀请卡</h2>' +
        '<p class="lead">' + esc(c.company || '个人来访') + ' · ' + esc(fmtRange(c.validFrom, c.validTo)) +
          (c.roomName ? ' · ' + esc(c.roomName) : '') + '</p>' +
        '<ol class="steps">' +
          '<li><span class="num">1</span><div><b>点「复制图片」</b>，邀请卡会进入系统剪贴板</div></li>' +
          '<li><span class="num">2</span><div>打开微信聊天窗口，<b>Ctrl + V</b> 直接粘贴发送；手机上长按输入框粘贴</div></li>' +
          '<li><span class="num">3</span><div>访客到门口出示图片，门岗扫码即可，<b>访客不需要任何操作</b></div></li>' +
        '</ol>' +
        '<div style="display:flex;gap:9px;flex-wrap:wrap">' +
          '<button class="btn primary lg" id="btnCopy">' + icon('i-copy', 16) + '复制图片</button>' +
          '<button class="btn lg" id="btnDownload">' + icon('i-download', 16) + '下载 PNG</button>' +
          '<button class="btn ghost lg" id="btnCopyText">复制文字</button>' +
        '</div>' +
        '<div class="copy-tip">' +
          '复制后直接粘进微信即可，不用先存到相册。若浏览器拦截了剪贴板（局域网 http 地址常见），会弹出图片供你右键复制。' +
        '</div>' +
        '<div style="display:flex;gap:16px;margin-top:24px;font-size:12.5px">' +
          '<a href="#/invite" style="color:var(--gold-lt)">＋ 再发一张</a>' +
          '<a href="#/records" style="color:var(--txt-2)">查看邀请记录</a>' +
        '</div>' +
      '</div>' +
    '</div>';

  const canvas = drawCard($('#cardResult'), c, c.style);

  $('#btnCopy').onclick = async () => {
    const btn = $('#btnCopy');
    btn.disabled = true;
    try {
      const ok = await copyCardImage(c, canvas);
      if (ok) toast('已复制，去微信里 Ctrl+V 粘贴');
      else copyFallback(c);
    } catch (e) {
      copyFallback(c);
    } finally {
      btn.disabled = false;
    }
  };

  $('#btnDownload').onclick = () => { downloadCanvas(canvas, fileName(c)); toast('已开始下载'); };

  $('#btnCopyText').onclick = async () => {
    const text = '【访客通行】\n' + c.guestName + (c.company ? '（' + c.company + '）' : '') + '\n' +
      '时间：' + fmtRange(c.validFrom, c.validTo) + '\n' +
      (c.roomName ? '地点：' + (c.roomPlace || c.roomName) + '\n' : '') +
      '邀请码：' + c.code + '\n' +
      '到访时把这张图给门岗看一眼即可。';
    try {
      await navigator.clipboard.writeText(text);
      toast('文字已复制');
    } catch (e) {
      toast('当前环境不支持复制，请手动选择', true);
    }
  };
}

/* ==========================================================================
   邀请记录
   ========================================================================== */
async function pageRecords() {
  $('#view').innerHTML =
    '<div class="toolbar">' +
      '<div class="grow" style="position:relative">' +
        '<input class="input" id="recSearch" placeholder="搜索访客、单位、邀请码、邀请人" style="padding-left:36px">' +
        '<span style="position:absolute;left:12px;top:11px;color:var(--txt-3)">' + icon('i-search', 15) + '</span>' +
      '</div>' +
      '<select class="select" id="recStatus" style="width:132px">' +
        '<option value="">全部状态</option><option value="active">有效</option><option value="pending">待生效</option>' +
        '<option value="used">名额已满</option><option value="expired">已过期</option><option value="revoked">已撤销</option>' +
      '</select>' +
      '<input class="input" type="date" id="recFrom" style="width:148px" title="开始日期">' +
      '<input class="input" type="date" id="recTo" style="width:148px" title="结束日期">' +
      '<label class="check" style="height:38px;padding:0 10px;border:1px solid var(--line);border-radius:9px">' +
        '<input type="checkbox" id="recMine"> 只看我的</label>' +
      (can('invite.create') ? '<button class="btn primary" data-go-invite style="margin-left:auto">' + icon('i-plus', 15) + '发起邀请</button>' : '') +
    '</div>' +
    '<div class="panel"><div class="scroll-hint">左右滑动查看完整表格 →</div><div class="table-wrap" id="recTable"></div><div id="recPager" class="pager"></div></div>';

  const g = $('[data-go-invite]');
  if (g) g.onclick = () => go('/invite');

  $('#recSearch').value = S.records.q;
  $('#recStatus').value = S.records.status;
  $('#recFrom').value = S.records.from;
  $('#recTo').value = S.records.to;
  $('#recMine').checked = S.records.mine;

  $('#recSearch').oninput = debounce(() => { S.records.q = $('#recSearch').value.trim(); S.records.page = 1; loadRecords(); }, 320);
  $('#recStatus').onchange = () => { S.records.status = $('#recStatus').value; S.records.page = 1; loadRecords(); };
  $('#recFrom').onchange = () => { S.records.from = $('#recFrom').value; S.records.page = 1; loadRecords(); };
  $('#recTo').onchange = () => { S.records.to = $('#recTo').value; S.records.page = 1; loadRecords(); };
  $('#recMine').onchange = () => { S.records.mine = $('#recMine').checked; S.records.page = 1; loadRecords(); };

  loadRecords();
}

async function loadRecords() {
  const q = S.records;
  const qs = new URLSearchParams();
  if (q.q) qs.set('q', q.q);
  if (q.status) qs.set('status', q.status);
  if (q.from) qs.set('from', q.from);
  if (q.to) qs.set('to', q.to);
  if (q.mine) qs.set('mine', '1');
  qs.set('page', q.page);
  qs.set('size', 20);

  const table = $('#recTable');
  table.innerHTML = '<div class="empty">加载中…</div>';
  let data;
  try {
    data = await api('/api/invites?' + qs.toString());
  } catch (e) {
    table.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }

  if (!data.rows.length) {
    table.innerHTML = '<div class="empty"><b>没有符合条件的邀请</b>' +
      (can('invite.create') ? '点右上角「发起邀请」生成第一张' : '换个筛选条件试试') + '</div>';
  } else {
    table.innerHTML =
      '<table class="tbl"><thead><tr>' +
        '<th style="width:170px">访客</th><th style="width:130px">邀请人 / 部门</th><th style="width:100px">接待</th><th style="width:180px">有效期</th>' +
        '<th style="width:80px">名额</th><th style="width:92px">状态</th><th style="width:172px"></th>' +
      '</tr></thead><tbody>' +
      data.rows.map(r =>
        '<tr>' +
          '<td><div class="name">' + esc(r.guestName) + '</div><div class="sub">' + esc(r.company || '—') + '</div></td>' +
          '<td><div>' + esc(r.hostName) + '</div><div class="sub">' + esc(r.deptName || '—') + '</div></td>' +
          '<td><div style="font-size:12px">' + esc(r.roomName || '—') + '</div>' +
            '<div class="sub mono">' + esc(r.code) + '</div></td>' +
          '<td><div style="font-size:12px">' + esc(fmtRange(r.validFrom, r.validTo)) + '</div>' +
            '<div class="sub">创建 ' + esc(fromNow(r.createdAt)) + '</div></td>' +
          '<td><span class="mono">' + r.usedCount + ' / ' + r.quota + '</span></td>' +
          '<td><span class="badge ' + r.status + '">' + esc(r.statusText) + '</span></td>' +
          '<td><div class="acts">' +
            '<button class="btn sm ghost" data-copy="' + esc(r.token) + '">复制</button>' +
            '<button class="btn sm ghost" data-detail="' + esc(r.token) + '">详情</button>' +
            (can('invite.revoke') && r.status !== 'revoked' ? '<button class="btn sm ghost" data-revoke="' + esc(r.token) + '">撤销</button>' : '') +
          '</div></td>' +
        '</tr>'
      ).join('') + '</tbody></table>';
  }

  const pages = Math.max(1, Math.ceil(data.total / data.size));
  $('#recPager').innerHTML =
    '<span>共 ' + data.total + ' 条 · 第 ' + data.page + ' / ' + pages + ' 页</span>' +
    '<button id="pgPrev"' + (data.page <= 1 ? ' disabled' : '') + '>‹</button>' +
    '<button id="pgNext"' + (data.page >= pages ? ' disabled' : '') + '>›</button>';

  $('#pgPrev').onclick = () => { if (q.page > 1) { q.page--; loadRecords(); } };
  $('#pgNext').onclick = () => { if (q.page < pages) { q.page++; loadRecords(); } };

  $$('[data-copy]', table).forEach(b => {
    b.onclick = async () => {
      const row = data.rows.find(x => x.token === b.dataset.copy);
      b.disabled = true;
      b.textContent = '复制中';
      try {
        const ok = await copyCardImage(row);
        if (ok) toast('已复制，去微信粘贴即可');
        else copyFallback(row);
      } catch (e) { copyFallback(row); }
      b.disabled = false;
      b.textContent = '复制';
    };
  });

  $$('[data-detail]', table).forEach(b => {
    b.onclick = () => showInviteDrawer(data.rows.find(x => x.token === b.dataset.detail));
  });

  $$('[data-revoke]', table).forEach(b => {
    b.onclick = async () => {
      const row = data.rows.find(x => x.token === b.dataset.revoke);
      const ok = await confirmDialog('撤销邀请', '撤销后 <b>' + esc(row.guestName) + '</b> 的邀请码立即失效，门岗会拒绝通行。确定要撤销吗？', '确认撤销', true);
      if (!ok) return;
      try {
        await api('/api/invites/' + row.token + '/revoke', { method: 'POST' });
        toast('已撤销');
        loadRecords();
      } catch (e) { toast(e.message, true); }
    };
  });
}

function showInviteDrawer(c) {
  if (!c) return;
  const statusHtml = '<span class="badge ' + c.status + '">' + esc(c.statusText) + '</span>';
  openDrawer('邀请详情', c.guestName + ' · ' + (c.company || '个人来访'),
    '<div style="display:flex;justify-content:center;margin-bottom:18px">' +
      '<div style="background:#fff;padding:10px;border-radius:10px" id="drawerQr"></div>' +
    '</div>' +
    '<div class="kv"><div class="k">状态</div><div class="v">' + statusHtml + '</div></div>' +
    '<div class="kv"><div class="k">卡面</div><div class="v">' + esc(c.styleName || '票券') + ' <button class="btn sm ghost" id="dwStyle" style="margin-left:8px">更换</button></div></div>' +
    '<div class="kv"><div class="k">邀请码</div><div class="v mono" style="font-size:20px;letter-spacing:.2em;color:var(--gold-lt)">' + esc(c.code) + '</div></div>' +
    '<div class="kv"><div class="k">凭证号</div><div class="v mono">' + esc(c.token) + '</div></div>' +
    '<div class="kv"><div class="k">来访事由</div><div class="v">' + esc(c.reason || '—') + '</div></div>' +
    '<div class="kv"><div class="k">邀请人</div><div class="v">' + esc(c.hostName) + ' · ' + esc(c.deptName || '—') + '</div></div>' +
    '<div class="kv"><div class="k">接待地点</div><div class="v">' + esc(c.roomPlace || c.roomName || '未指定') + '</div></div>' +
    '<div class="kv"><div class="k">有效时段</div><div class="v">' + esc(fmtRange(c.validFrom, c.validTo)) + '</div></div>' +
    '<div class="kv"><div class="k">通行人数</div><div class="v">' + c.usedCount + ' / ' + c.quota + ' 人次</div></div>' +
    (c.note ? '<div class="kv"><div class="k">备注</div><div class="v">' + esc(c.note) + '</div></div>' : '') +
    '<div class="kv"><div class="k">创建时间</div><div class="v">' + esc(fmtDT(c.createdAt)) + '</div></div>',
    '<button class="btn ghost" data-dclose>关闭</button>' +
    (can('invite.extend') && c.status !== 'revoked' ? '<button class="btn" id="dwExtend">延期</button>' : '') +
    '<button class="btn primary" id="dwCopy">复制图片</button>',
    function (root) {
      $('#drawerQr').innerHTML = qrSvg(c.token, 150);
      $('#dwCopy', root).onclick = async () => {
        const ok = await copyCardImage(c);
        if (ok) toast('已复制，去微信粘贴即可');
        else copyFallback(c);
      };
      const ext = $('#dwExtend', root);
      if (ext) ext.onclick = () => extendInvite(c);
      const sty = $('#dwStyle', root);
      if (sty) sty.onclick = () => styleModal(c);
    });
}

function qrSvg(text, size) {
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: Math.max(2, Math.floor(size / qr.getModuleCount())), margin: 0 });
  } catch (e) {
    return '';
  }
}

function styleModal(c) {
  openModal({
    title: '选择卡面样式',
    sub: c.guestName + ' · 当前「' + (c.styleName || '票券') + '」',
    wide: true,
    body: '<div class="style-modal-grid">' +
      CARD_STYLES.map(x => '<button type="button" class="style-opt" data-style="' + x.key + '">' +
        '<canvas></canvas><span>' + esc(x.name) + '</span></button>').join('') +
      '</div>' +
      '<div style="font-size:11.5px;color:var(--txt-3);line-height:1.8;margin-top:14px">' +
        '换样式只影响这张卡的外观，邀请码、二维码、有效期都不变。已经发出去的旧图仍然有效。</div>',
    foot: '<button class="btn ghost" data-mclose>关闭</button>',
    onMount(root) {
      const sample = Object.assign({}, c);
      $$('.style-opt', root).forEach(btn => {
        const cv = btn.querySelector('canvas');
        if (cv) drawCard(cv, sample, btn.dataset.style, 0.24);
        if (btn.dataset.style === (c.style || 'ticket')) btn.classList.add('on');
        btn.onclick = async () => {
          if (btn.dataset.style === c.style) return;
          btn.disabled = true;
          try {
            const r = await api('/api/invites/' + c.token + '/style', {
              method: 'POST', body: { style: btn.dataset.style }
            });
            closeModal();
            toast('卡面已换成「' + cardStyleName(btn.dataset.style) + '」');
            if (S.route === '/records') loadRecords();
            showInviteDrawer(r.credential);
          } catch (e) {
            toast(e.message, true);
            btn.disabled = false;
          }
        };
      });
    }
  });
}

function extendInvite(c) {
  openModal({
    title: '延长有效期',
    sub: c.guestName + ' · 当前至 ' + fmtDT(c.validTo),
    narrow: true,
    body:
      '<div class="field"><label>延长时长</label><div class="chips" id="extChips">' +
        '<span class="chip on" data-m="60">1 小时</span><span class="chip" data-m="120">2 小时</span>' +
        '<span class="chip" data-m="240">4 小时</span><span class="chip" data-m="1440">1 天</span>' +
      '</div></div>' +
      '<div class="field" style="margin-bottom:0"><label>或指定新的结束时间</label>' +
        '<input class="input" type="datetime-local" id="extAt"></div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="extOk">确认延期</button>',
    onMount(root) {
      let minutes = 60;
      $$('#extChips .chip', root).forEach(ch => {
        ch.onclick = () => {
          $$('#extChips .chip', root).forEach(x => x.classList.remove('on'));
          ch.classList.add('on');
          minutes = Number(ch.dataset.m);
          $('#extAt', root).value = '';
        };
      });
      $('#extAt', root).oninput = () => { minutes = 0; $$('#extChips .chip', root).forEach(x => x.classList.remove('on')); };
      $('#extOk', root).onclick = async () => {
        const at = $('#extAt', root).value;
        const payload = at ? { validTo: new Date(at).getTime() } : { minutes: minutes };
        try {
          await api('/api/invites/' + c.token + '/extend', { method: 'POST', body: payload });
          closeModal();
          closeDrawer();
          toast('已延期');
          if (S.route === '/records') loadRecords();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

/* ==========================================================================
   通行台账
   ========================================================================== */
async function pageLedger() {
  $('#view').innerHTML =
    '<div class="toolbar">' +
      '<input class="input" type="date" id="lgDate" style="width:170px">' +
      '<button class="btn ghost" id="lgToday">今天</button>' +
      '<div class="tabs" id="lgTabs"><button class="on" data-inc="">通行记录</button><button data-inc="deny">含拒绝记录</button></div>' +
      '<div class="spacer" style="flex:1"></div>' +
      '<span style="font-size:11.5px;color:var(--txt-3)" id="lgHint"></span>' +
      (can('ledger.export') ? '<button class="btn" id="btnExport">' + icon('i-download', 15) + '导出 CSV</button>' : '') +
    '</div>' +
    '<div class="grid g4" style="margin-bottom:16px" id="lgStats"></div>' +
    '<div class="panel"><div class="table-wrap" id="lgTable"></div></div>';

  $('#lgDate').value = S.ledger.date;
  $('#lgDate').onchange = () => { S.ledger.date = $('#lgDate').value; loadLedger(); };
  $('#lgToday').onclick = () => { S.ledger.date = todayStr(); $('#lgDate').value = S.ledger.date; loadLedger(); };
  $$('#lgTabs button').forEach(b => {
    b.onclick = () => {
      $$('#lgTabs button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      S.ledger.include = b.dataset.inc;
      loadLedger();
    };
  });
  if (S.ledger.include) {
    $$('#lgTabs button').forEach(x => x.classList.toggle('on', x.dataset.inc === S.ledger.include));
  }
  const ex = $('#btnExport');
  if (ex) ex.onclick = () => { window.location.href = '/api/ledger.csv?date=' + encodeURIComponent(S.ledger.date); };

  loadLedger();
  clearInterval(pageLedger._timer);
  pageLedger._timer = setInterval(() => { if (S.route === '/ledger') loadLedger(); }, 30000);
}

async function loadLedger() {
  const q = '?date=' + encodeURIComponent(S.ledger.date) + (S.ledger.include ? '&include=deny' : '');
  let data;
  try { data = await api('/api/ledger' + q); } catch (e) {
    $('#lgTable').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  const s = data.summary;
  $('#lgStats').innerHTML =
    '<div class="stat"><div class="k">入场次数</div><div class="n">' + s.entries + '</div></div>' +
    '<div class="stat"><div class="k">首次入场</div><div class="n">' + s.firstEntries + '</div></div>' +
    '<div class="stat"><div class="k">发出邀请</div><div class="n">' + s.invites + '</div></div>' +
    '<div class="stat"><div class="k">拒绝次数</div><div class="n">' + s.denied + '</div></div>';
  $('#lgHint').textContent = '数据每 30 秒自动刷新';

  if (!data.rows.length) {
    $('#lgTable').innerHTML = '<div class="empty"><b>' + esc(S.ledger.date) + ' 没有记录</b>门岗核验通过后会自动出现在这里</div>';
    return;
  }

  $('#lgTable').innerHTML =
    '<table class="tbl"><thead><tr>' +
      '<th style="width:82px">时间</th><th style="width:170px">访客</th><th>事由</th>' +
      '<th>邀请人</th><th>会议室</th><th style="width:92px">邀请码</th>' +
      '<th style="width:96px">类型</th><th style="width:90px">门岗</th>' +
    '</tr></thead><tbody>' +
    data.rows.map(r =>
      '<tr>' +
        '<td class="mono" style="color:var(--gold)">' + esc(r.time) + '</td>' +
        '<td><div class="name">' + esc(r.guestName || '未知') + '</div><div class="sub">' + esc(r.company || '—') + '</div></td>' +
        '<td style="font-size:12px">' + esc(r.reason || '—') + '</td>' +
        '<td style="font-size:12px">' + esc(r.hostName || '—') + '</td>' +
        '<td style="font-size:12px">' + esc(r.roomName || '—') + '</td>' +
        '<td class="mono" style="font-size:11.5px">' + esc(r.code || '—') + '</td>' +
        '<td>' + (r.pass ? '<span class="badge active">' + esc(r.kindText) + '</span>'
                         : '<span class="badge deny">' + esc(r.kindText) + '</span>') + '</td>' +
        '<td style="font-size:11.5px;color:var(--txt-3)">' + esc(r.guardName || r.deviceId || '—') + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table>';
}

/* ==========================================================================
   人员架构
   ========================================================================== */
async function pageOrg() {
  await refreshOrgData();
  const canManage = can('staff.manage');

  $('#view').innerHTML =
    (canManage ? '<div class="page-actions">' +
      '<button class="btn ghost" id="btnAddDept">' + icon('i-plus', 15) + '新增部门</button>' +
      '<button class="btn primary" id="btnAddUser">' + icon('i-plus', 15) + '新增成员</button>' +
    '</div>' : '') +
    '<div class="split org-layout">' +
      '<div class="panel"><div class="panel-head"><h3>组织架构</h3></div>' +
        '<div class="panel-body" style="padding:10px"><div class="dept-tree" id="deptTree"></div></div></div>' +
      '<div class="panel"><div class="panel-head"><div><h3 id="orgTitle">全部成员</h3><div class="sub" id="orgSub"></div></div>' +
        '<div class="right"><div style="position:relative">' +
          '<input class="input" id="orgSearch" placeholder="搜索姓名 / 账号" style="height:34px;width:180px;padding-left:32px">' +
          '<span style="position:absolute;left:10px;top:9px;color:var(--txt-3)">' + icon('i-search', 14) + '</span>' +
        '</div></div></div>' +
        '<div class="table-wrap" id="orgTable"></div></div>' +
    '</div>';

  renderDeptTree();
  renderMembers();

  $('#orgSearch').value = S.org.q;
  $('#orgSearch').oninput = debounce(() => { S.org.q = $('#orgSearch').value.trim(); renderMembers(); }, 280);

  if (canManage) {
    $('#btnAddDept').onclick = () => deptModal(null);
    $('#btnAddUser').onclick = () => userModal(null);
  }
}

async function refreshOrgData() {
  const d = await api('/api/departments');
  S.data.departments = d.tree;
  S.data.deptFlat = d.flat;
  S.data.users = d.users;
}

function flattenDept(nodes, level, out) {
  nodes.forEach(n => {
    out.push({ node: n, level: level });
    if (n.children && n.children.length) flattenDept(n.children, level + 1, out);
  });
  return out;
}

function renderDeptTree() {
  const flat = flattenDept(S.data.departments || [], 1, []);
  const total = (S.data.users || []).length;
  let html = '<div class="dept-node' + (S.org.deptId === '' ? ' on' : '') + '" data-dept="">' +
    '<span class="n">全部成员</span><span class="c">' + total + '</span></div>';
  flat.forEach(item => {
    html += '<div class="dept-node lv' + Math.min(3, item.level) + (S.org.deptId === item.node.id ? ' on' : '') + '" data-dept="' + esc(item.node.id) + '">' +
      '<span class="n">' + esc(item.node.name) + '</span><span class="c">' + item.node.memberCount + '</span></div>';
  });
  $('#deptTree').innerHTML = html;
  $$('#deptTree .dept-node').forEach(n => {
    n.onclick = () => {
      S.org.deptId = n.dataset.dept;
      renderDeptTree();
      renderMembers();
      const d = findDept(S.data.departments, S.org.deptId);
      if (d && can('staff.manage')) showDeptActions(d);
    };
  });
}

function findDept(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findDept(n.children, id);
    if (hit) return hit;
  }
  return null;
}

function showDeptActions(d) {
  $('#orgTitle').innerHTML = esc(d.name) +
    ' <button class="btn sm ghost" id="btnEditDept" style="margin-left:8px;vertical-align:middle">编辑</button>' +
    ' <button class="btn sm ghost" id="btnDelDept" style="vertical-align:middle">删除</button>';
  $('#btnEditDept').onclick = () => deptModal(d);
  $('#btnDelDept').onclick = async () => {
    const ok = await confirmDialog('删除部门', '确定删除「' + esc(d.name) + '」？部门下不能有成员或下级部门。', '删除', true);
    if (!ok) return;
    try {
      await api('/api/departments/' + d.id, { method: 'DELETE' });
      toast('已删除');
      await refreshOrgData();
      S.org.deptId = '';
      renderDeptTree();
      renderMembers();
    } catch (e) { toast(e.message, true); }
  };
}

function renderMembers() {
  let rows = S.data.users || [];
  if (S.org.deptId) {
    const ids = collectDeptIds(S.data.departments, S.org.deptId);
    rows = rows.filter(u => ids.indexOf(u.deptId) >= 0);
  }
  if (S.org.q) {
    const q = S.org.q.toLowerCase();
    rows = rows.filter(u => (u.name + u.username + u.title + u.phone).toLowerCase().indexOf(q) >= 0);
  }
  if (!S.org.deptId) {
    $('#orgTitle').textContent = '全部成员';
  } else {
    const d = findDept(S.data.departments, S.org.deptId);
    if (d && !can('staff.manage')) $('#orgTitle').textContent = d.name;
  }
  $('#orgSub').textContent = rows.length + ' 人';
  const canManage = can('staff.manage');

  if (!rows.length) {
    $('#orgTable').innerHTML = '<div class="empty"><b>该部门暂无成员</b>换个部门看看，或新增成员</div>';
    return;
  }

  $('#orgTable').innerHTML =
    '<table class="tbl"><thead><tr>' +
      '<th style="width:190px">成员</th><th>部门 / 职位</th><th>角色</th><th>联系方式</th>' +
      '<th style="width:78px">状态</th>' + (canManage ? '<th style="width:150px"></th>' : '') +
    '</tr></thead><tbody>' +
    rows.map(u =>
      '<tr>' +
        '<td><div class="user-cell"><div class="avatar">' + esc(initials(u.name)) + '</div>' +
          '<div><div class="name">' + esc(u.name) + '</div><div class="sub mono">' + esc(u.username) + '</div></div></div></td>' +
        '<td><div style="font-size:12px">' + esc(u.deptName || '—') + '</div><div class="sub">' + esc(u.title || '—') + '</div></td>' +
        '<td><span class="badge gold">' + esc(u.roleName) + '</span></td>' +
        '<td style="font-size:12px">' + esc(u.phone || '—') + '</td>' +
        '<td>' + (u.status === 'active' ? '<span class="badge active">在用</span>' : '<span class="badge expired">停用</span>') + '</td>' +
        (canManage ? '<td><div class="acts">' +
          '<button class="btn sm ghost" data-edit="' + esc(u.id) + '">编辑</button>' +
          '<button class="btn sm ghost" data-pw="' + esc(u.id) + '">密码</button>' +
          (u.username !== 'admin' ? '<button class="btn sm ghost" data-del="' + esc(u.id) + '">删除</button>' : '') +
        '</div></td>' : '') +
      '</tr>'
    ).join('') + '</tbody></table>';

  if (canManage) {
    $$('[data-edit]').forEach(b => b.onclick = () => userModal(S.data.users.find(u => u.id === b.dataset.edit)));
    $$('[data-pw]').forEach(b => b.onclick = () => resetPwModal(S.data.users.find(u => u.id === b.dataset.pw)));
    $$('[data-del]').forEach(b => b.onclick = async () => {
      const u = S.data.users.find(x => x.id === b.dataset.del);
      const ok = await confirmDialog('删除成员', '确定删除 <b>' + esc(u.name) + '</b>（' + esc(u.username) + '）？<br>如果该成员有历史邀请记录，会自动改为停用。', '删除', true);
      if (!ok) return;
      try {
        const r = await api('/api/users/' + u.id, { method: 'DELETE' });
        toast(r.message || '已删除');
        await refreshOrgData();
        renderDeptTree();
        renderMembers();
      } catch (e) { toast(e.message, true); }
    });
  }
}

function collectDeptIds(nodes, id) {
  const out = [];
  const walk = (list, hit) => {
    (list || []).forEach(n => {
      const inside = hit || n.id === id;
      if (inside) out.push(n.id);
      walk(n.children, inside);
    });
  };
  walk(nodes, false);
  return out;
}

function deptModal(d) {
  openModal({
    title: d ? '编辑部门' : '新增部门',
    narrow: true,
    body:
      '<div class="field"><label>部门名称<span class="req">*</span></label><input class="input" id="dName" value="' + esc(d ? d.name : '') + '"></div>' +
      '<div class="field"><label>上级部门</label><select class="select" id="dParent"><option value="">无（一级部门）</option>' +
        flattenDept(S.data.departments, 1, []).filter(x => !d || x.node.id !== d.id).map(x =>
          '<option value="' + esc(x.node.id) + '"' + (d && d.parentId === x.node.id ? ' selected' : '') + '>' +
          '　'.repeat(Math.max(0, x.level - 1)) + esc(x.node.name) + '</option>').join('') +
      '</select></div>' +
      '<div class="row2"><div class="field"><label>负责人</label><select class="select" id="dLeader"><option value="">未指定</option>' +
        (S.data.users || []).map(u => '<option value="' + esc(u.id) + '"' + (d && d.leaderId === u.id ? ' selected' : '') + '>' + esc(u.name) + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>排序</label><input class="input" type="number" id="dSort" value="' + (d ? d.sort : 0) + '"></div></div>' +
      '<div class="field" style="margin-bottom:0"><label>备注</label><input class="input" id="dNote" value="' + esc(d ? d.note : '') + '"></div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="dSave">保存</button>',
    onMount(root) {
      $('#dSave', root).onclick = async () => {
        const payload = {
          name: $('#dName', root).value.trim(),
          parentId: $('#dParent', root).value,
          leaderId: $('#dLeader', root).value,
          sort: $('#dSort', root).value,
          note: $('#dNote', root).value.trim()
        };
        try {
          if (d) await api('/api/departments/' + d.id, { method: 'PATCH', body: payload });
          else await api('/api/departments', { method: 'POST', body: payload });
          closeModal();
          toast('已保存');
          await refreshOrgData();
          renderDeptTree();
          renderMembers();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

function userModal(u) {
  const isNew = !u;
  openModal({
    title: isNew ? '新增成员' : '编辑成员',
    sub: isNew ? '账号会立即生效，首次登录不强制改密' : u.username,
    body:
      '<div class="row2">' +
        '<div class="field"><label>姓名<span class="req">*</span></label><input class="input" id="uName" value="' + esc(u ? u.name : '') + '"></div>' +
        '<div class="field"><label>职位</label><input class="input" id="uTitle" value="' + esc(u ? u.title : '') + '"></div>' +
      '</div>' +
      (isNew ? '<div class="row2">' +
        '<div class="field"><label>登录账号<span class="req">*</span></label><input class="input" id="uUsername" placeholder="小写字母 / 数字" autocomplete="off"></div>' +
        '<div class="field"><label>初始密码<span class="req">*</span></label><input class="input" id="uPassword" placeholder="至少 6 位" autocomplete="new-password"></div>' +
      '</div>' : '') +
      '<div class="row2">' +
        '<div class="field"><label>所属部门</label><select class="select" id="uDept"><option value="">未分配</option>' +
          flattenDept(S.data.departments, 1, []).map(x =>
            '<option value="' + esc(x.node.id) + '"' + (u && u.deptId === x.node.id ? ' selected' : '') + '>' +
            '　'.repeat(Math.max(0, x.level - 1)) + esc(x.node.name) + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>角色</label><select class="select" id="uRole">' +
          (S.data.roles || []).map(r => '<option value="' + esc(r.key) + '"' + (u && u.roleKey === r.key ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') +
        '</select></div>' +
      '</div>' +
      '<div class="row2">' +
        '<div class="field"><label>手机号</label><input class="input" id="uPhone" value="' + esc(u ? u.phone : '') + '"></div>' +
        '<div class="field"><label>邮箱</label><input class="input" id="uEmail" value="' + esc(u ? u.email : '') + '"></div>' +
      '</div>' +
      '<div class="field" style="margin-bottom:0"><label>账号状态</label>' +
        '<select class="select" id="uStatus"><option value="active"' + (!u || u.status === 'active' ? ' selected' : '') + '>在用</option>' +
        '<option value="disabled"' + (u && u.status === 'disabled' ? ' selected' : '') + '>停用</option></select></div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="uSave">保存</button>',
    onMount(root) {
      $('#uSave', root).onclick = async () => {
        const payload = {
          name: $('#uName', root).value.trim(),
          title: $('#uTitle', root).value.trim(),
          deptId: $('#uDept', root).value,
          roleKey: $('#uRole', root).value,
          phone: $('#uPhone', root).value.trim(),
          email: $('#uEmail', root).value.trim(),
          status: $('#uStatus', root).value
        };
        if (isNew) {
          payload.username = $('#uUsername', root).value.trim();
          payload.password = $('#uPassword', root).value;
        }
        try {
          if (isNew) await api('/api/users', { method: 'POST', body: payload });
          else await api('/api/users/' + u.id, { method: 'PATCH', body: payload });
          closeModal();
          toast('已保存');
          await refreshOrgData();
          renderDeptTree();
          renderMembers();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

function resetPwModal(u) {
  openModal({
    title: '重置密码',
    sub: u.name + ' · ' + u.username,
    narrow: true,
    body: '<div class="field" style="margin-bottom:8px"><label>新密码</label><input class="input" id="rpPw" placeholder="至少 6 位" autocomplete="new-password"></div>' +
      '<div class="hint">重置后该成员所有设备会立即下线，下次登录需使用新密码。</div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="rpOk">确认重置</button>',
    onMount(root) {
      $('#rpOk', root).onclick = async () => {
        try {
          await api('/api/users/' + u.id + '/reset-password', { method: 'POST', body: { password: $('#rpPw', root).value } });
          closeModal();
          toast('密码已重置');
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

/* ==========================================================================
   会议室
   ========================================================================== */
async function pageRooms() {
  const canManage = can('room.manage');
  $('#view').innerHTML =
    '<div class="toolbar"><input class="input" type="date" id="rmDate" style="width:170px">' +
      '<button class="btn ghost" id="rmToday">今天</button>' +
      '<span style="font-size:11.5px;color:var(--txt-3)" id="rmHint"></span>' +
      (canManage ? '<button class="btn primary" id="btnAddRoom" style="margin-left:auto">' + icon('i-plus', 15) + '新增会议室</button>' : '') +
    '</div>' +
    '<div class="grid g3" id="roomGrid"></div>';

  $('#rmDate').value = S.roomsDate;
  $('#rmDate').onchange = () => { S.roomsDate = $('#rmDate').value; loadRooms(); };
  $('#rmToday').onclick = () => { S.roomsDate = todayStr(); $('#rmDate').value = S.roomsDate; loadRooms(); };
  if (canManage) $('#btnAddRoom').onclick = () => roomModal(null);
  $('#rmHint').textContent = '显示所选日期的有效邀请占用';
  loadRooms();
}

async function loadRooms() {
  let data;
  try { data = await api('/api/rooms/schedule?date=' + encodeURIComponent(S.roomsDate)); } catch (e) {
    $('#roomGrid').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  if (!data.rooms.length) {
    $('#roomGrid').innerHTML = '<div class="empty"><b>还没有会议室</b>新增后即可在发起邀请时选择</div>';
    return;
  }
  const canManage = can('room.manage');
  $('#roomGrid').innerHTML = data.rooms.map(r =>
    '<div class="room-card">' +
      '<div class="top"><div><h4>' + esc(r.name) + '</h4>' +
        '<div class="loc">' + esc(r.building || '') + (r.floor ? ' · ' + esc(r.floor) + 'F' : '') + '</div></div>' +
        '<div class="cap">' + r.capacity + ' 人</div></div>' +
      (r.equipment && r.equipment.length ? '<div class="equip">' + r.equipment.map(e => '<span>' + esc(e) + '</span>').join('') + '</div>' : '') +
      '<div class="slot-list">' +
        (r.items.length
          ? r.items.map(it => '<div class="slot-item"><span class="t">' + esc(slotRange(it.validFrom, it.validTo)) + '</span>' +
              '<span class="n">' + esc(it.guestName) + ' · ' + esc(it.company || it.hostName) + '</span></div>').join('')
          : '<div class="slot-free">该日暂无占用</div>') +
      '</div>' +
      (r.status === 'disabled' ? '<div style="margin-top:10px"><span class="badge expired">已停用</span></div>' : '') +
      (canManage ? '<div style="display:flex;gap:6px;margin-top:12px">' +
        '<button class="btn sm ghost" data-editroom="' + esc(r.id) + '">编辑</button>' +
        '<button class="btn sm ghost" data-delroom="' + esc(r.id) + '">删除</button></div>' : '') +
    '</div>'
  ).join('');

  if (canManage) {
    $$('[data-editroom]').forEach(b => b.onclick = () => roomModal(data.rooms.find(r => r.id === b.dataset.editroom)));
    $$('[data-delroom]').forEach(b => b.onclick = async () => {
      const r = data.rooms.find(x => x.id === b.dataset.delroom);
      const ok = await confirmDialog('删除会议室', '确定删除「' + esc(r.name) + '」？还有进行中的邀请占用时不能删除。', '删除', true);
      if (!ok) return;
      try {
        await api('/api/rooms/' + r.id, { method: 'DELETE' });
        toast('已删除');
        loadRooms();
      } catch (e) { toast(e.message, true); }
    });
  }
}

function roomModal(r) {
  const eq = (r && r.equipment) ? r.equipment.join('、') : '';
  openModal({
    title: r ? '编辑会议室' : '新增会议室',
    body:
      '<div class="row2">' +
        '<div class="field"><label>名称<span class="req">*</span></label><input class="input" id="rmName" value="' + esc(r ? r.name : '') + '"></div>' +
        '<div class="field"><label>容纳人数</label><input class="input" type="number" id="rmCap" value="' + (r ? r.capacity : 10) + '"></div>' +
      '</div>' +
      '<div class="row2">' +
        '<div class="field"><label>楼栋</label><input class="input" id="rmBuilding" value="' + esc(r ? r.building : 'A 座') + '"></div>' +
        '<div class="field"><label>楼层</label><input class="input" id="rmFloor" value="' + esc(r ? r.floor : '') + '"></div>' +
      '</div>' +
      '<div class="field"><label>设备（用顿号或逗号分隔）</label><input class="input" id="rmEquip" value="' + esc(eq) + '" placeholder="投影、视频会议、白板"></div>' +
      '<div class="row2">' +
        '<div class="field"><label>状态</label><select class="select" id="rmStatus">' +
          '<option value="active"' + (!r || r.status === 'active' ? ' selected' : '') + '>启用</option>' +
          '<option value="disabled"' + (r && r.status === 'disabled' ? ' selected' : '') + '>停用</option></select></div>' +
        '<div class="field"><label>备注</label><input class="input" id="rmNote" value="' + esc(r ? r.note : '') + '"></div>' +
      '</div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="rmSave">保存</button>',
    onMount(root) {
      $('#rmSave', root).onclick = async () => {
        const payload = {
          name: $('#rmName', root).value.trim(),
          building: $('#rmBuilding', root).value.trim(),
          floor: $('#rmFloor', root).value.trim(),
          capacity: $('#rmCap', root).value,
          equipment: $('#rmEquip', root).value.split(/[、,，\s]+/).filter(Boolean),
          status: $('#rmStatus', root).value,
          note: $('#rmNote', root).value.trim()
        };
        try {
          if (r) await api('/api/rooms/' + r.id, { method: 'PATCH', body: payload });
          else await api('/api/rooms', { method: 'POST', body: payload });
          closeModal();
          toast('已保存');
          await loadBootstrap();
          loadRooms();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

/* ==========================================================================
   权限管理
   ========================================================================== */
async function pagePerms() {
  const data = await api('/api/roles');
  S.data.roles = data.roles;
  S.data.perms = data.perms;
  S.data.scopes = data.scopes;
  if (!S.permRoleKey || !data.roles.some(r => r.key === S.permRoleKey)) S.permRoleKey = data.roles[0].key;

  $('#view').innerHTML =
    '<div class="split perms-layout">' +
      '<div class="panel"><div class="panel-head"><h3>角色</h3>' +
        '<div class="right"><button class="btn sm ghost" id="btnNewRole">' + icon('i-plus', 13) + '新增</button></div></div>' +
        '<div class="panel-body" style="padding:10px" id="roleList"></div></div>' +
      '<div class="panel" id="roleEditor"></div>' +
    '</div>';

  $('#btnNewRole').onclick = () => editRole(null);
  renderRoleList();
  renderRoleEditor();
}

function renderRoleList() {
  const users = S.data.users || [];
  $('#roleList').innerHTML = S.data.roles.map(r => {
    const n = users.filter(u => u.roleKey === r.key).length;
    return '<div class="role-item' + (S.permRoleKey === r.key ? ' on' : '') + '" data-role="' + esc(r.key) + '">' +
      '<div style="flex:1;min-width:0"><b>' + esc(r.name) + '</b><small>' + n + ' 人 · ' +
        esc((S.data.scopes.find(s => s.key === r.scope) || {}).name || r.scope) + '</small></div>' +
      (r.builtin ? '<span class="badge expired" style="transform:scale(.9)">内置</span>' : '') +
    '</div>';
  }).join('');
  $$('#roleList .role-item').forEach(el => {
    el.onclick = () => { S.permRoleKey = el.dataset.role; renderRoleList(); renderRoleEditor(); };
  });
}

function renderRoleEditor() {
  const role = S.data.roles.find(r => r.key === S.permRoleKey);
  if (!role) return;
  const groups = {};
  (S.data.perms || []).forEach(p => {
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group].push(p);
  });
  const locked = role.key === 'admin';

  $('#roleEditor').innerHTML =
    '<div class="panel-head"><div><h3>' + esc(role.name) + (role.builtin ? '（内置）' : '') + '</h3>' +
      '<div class="sub">' + esc(role.note || '') + '</div></div>' +
      '<div class="right">' +
        (!role.builtin ? '<button class="btn sm ghost" id="btnDelRole">删除</button>' : '') +
        '<button class="btn sm primary" id="btnSaveRole">保存权限</button>' +
      '</div></div>' +
    '<div class="panel-body">' +
      '<div class="row2" style="margin-bottom:18px">' +
        '<div class="field" style="margin-bottom:0"><label>角色名称</label>' +
          '<input class="input" id="roleName" value="' + esc(role.name) + '"' + (locked ? ' disabled' : '') + '></div>' +
        '<div class="field" style="margin-bottom:0"><label>数据范围</label>' +
          '<select class="select" id="roleScope"' + (locked ? ' disabled' : '') + '>' +
          S.data.scopes.map(s => '<option value="' + esc(s.key) + '"' + (role.scope === s.key ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') +
          '</select></div>' +
      '</div>' +
      Object.keys(groups).map(g =>
        '<div class="perm-group"><div class="gh">' + esc(g) + '</div><div class="perm-grid">' +
          groups[g].map(p =>
            '<label class="perm-cell' + (locked ? ' locked' : '') + '">' +
              '<input type="checkbox" value="' + esc(p.key) + '"' +
                (locked || role.perms.indexOf('*') >= 0 || role.perms.indexOf(p.key) >= 0 ? ' checked' : '') +
                (locked ? ' disabled' : '') + '>' + esc(p.name) +
            '</label>').join('') +
        '</div></div>'
      ).join('') +
      (locked ? '<div class="hint">超级管理员固定拥有全部权限，不可修改。</div>' : '') +
    '</div>';

  $('#btnSaveRole').onclick = async () => {
    const perms = $$('#roleEditor .perm-cell input:checked').map(x => x.value);
    try {
      await api('/api/roles/' + role.key, {
        method: 'PATCH',
        body: { name: $('#roleName').value.trim(), scope: $('#roleScope').value, perms: perms, note: role.note }
      });
      toast('权限已保存');
      await loadBootstrap();
      const d = await api('/api/roles');
      S.data.roles = d.roles;
      renderRoleList();
      renderRoleEditor();
    } catch (e) { toast(e.message, true); }
  };

  const del = $('#btnDelRole');
  if (del) del.onclick = async () => {
    const ok = await confirmDialog('删除角色', '确定删除角色「' + esc(role.name) + '」？还有成员使用时不能删除。', '删除', true);
    if (!ok) return;
    try {
      await api('/api/roles/' + role.key, { method: 'DELETE' });
      toast('已删除');
      S.permRoleKey = 'admin';
      await pagePerms();
    } catch (e) { toast(e.message, true); }
  };
}

function editRole(role) {
  openModal({
    title: '新增角色',
    narrow: true,
    body:
      '<div class="field"><label>角色名称<span class="req">*</span></label><input class="input" id="nrName" placeholder="例如 前台接待"></div>' +
      '<div class="field"><label>数据范围</label><select class="select" id="nrScope">' +
        S.data.scopes.map(s => '<option value="' + esc(s.key) + '"' + (s.key === 'self' ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') +
      '</select></div>' +
      '<div class="hint">创建后在右侧勾选权限。</div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="nrOk">创建</button>',
    onMount(root) {
      $('#nrOk', root).onclick = async () => {
        try {
          const r = await api('/api/roles', {
            method: 'POST',
            body: { name: $('#nrName', root).value.trim(), scope: $('#nrScope', root).value, perms: [] }
          });
          closeModal();
          toast('已创建，请勾选权限');
          S.permRoleKey = r.role.key;
          await loadBootstrap();
          await pagePerms();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

/* ==========================================================================
   操作日志
   ========================================================================== */
async function pageAudit() {
  $('#view').innerHTML =
    '<div class="toolbar"><div class="grow" style="position:relative">' +
      '<input class="input" id="auSearch" placeholder="搜索操作人、对象或内容" style="padding-left:36px">' +
      '<span style="position:absolute;left:12px;top:11px;color:var(--txt-3)">' + icon('i-search', 15) + '</span>' +
    '</div></div>' +
    '<div class="panel"><div class="table-wrap" id="auTable"></div></div>';

  $('#auSearch').value = S.audit.q;
  $('#auSearch').oninput = debounce(() => { S.audit.q = $('#auSearch').value.trim(); loadAudit(); }, 300);
  loadAudit();
}

async function loadAudit() {
  let data;
  try { data = await api('/api/audit?limit=200&q=' + encodeURIComponent(S.audit.q)); } catch (e) {
    $('#auTable').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  if (!data.rows.length) {
    $('#auTable').innerHTML = '<div class="empty"><b>没有日志</b>换个关键字试试</div>';
    return;
  }
  $('#auTable').innerHTML =
    '<table class="tbl"><thead><tr>' +
      '<th style="width:120px">时间</th><th style="width:140px">操作人</th><th style="width:120px">动作</th>' +
      '<th>对象 / 内容</th><th style="width:110px">IP</th>' +
    '</tr></thead><tbody>' +
    data.rows.map(a =>
      '<tr>' +
        '<td class="mono" style="font-size:11.5px;color:var(--txt-2)">' + esc(fmtDT(a.ts)) + '</td>' +
        '<td><div style="font-size:12px">' + esc(a.userName) + '</div><div class="sub">' + esc(a.userRole || '—') + '</div></td>' +
        '<td><span class="badge ' + (/fail|delete|revoke/.test(a.action) ? 'revoked' : 'gold') + '">' + esc(actionText(a.action)) + '</span></td>' +
        '<td><div style="font-size:12px">' + esc(a.target || '—') + '</div><div class="sub">' + esc(a.detail || '') + '</div></td>' +
        '<td class="mono" style="font-size:11px;color:var(--txt-3)">' + esc(a.ip || '—') + '</td>' +
      '</tr>'
    ).join('') + '</tbody></table>';
}

/* ==========================================================================
   系统设置
   ========================================================================== */
async function pageSettings() {
  const s = S.data.settings;
  $('#view').innerHTML =
    '<div class="split">' +
      '<div class="panel"><div class="panel-head"><h3>组织信息</h3></div><div class="panel-body">' +
        '<div class="field"><label>组织名称</label><input class="input" id="stOrg" value="' + esc(s.orgName || '') + '"></div>' +
        '<div class="row2"><div class="field"><label>主楼栋</label><input class="input" id="stBuilding" value="' + esc(s.building || '') + '"></div>' +
        '<div class="field"><label>门岗名称</label><input class="input" id="stGuard" value="' + esc(s.guardDevice || '') + '"></div></div>' +
        '<button class="btn primary" id="stSave">保存</button>' +
      '</div></div>' +
      '<div class="panel"><div class="panel-head"><h3>数据与安全</h3></div><div class="panel-body">' +
        '<div class="kv"><div class="k">数据文件</div><div class="v mono" style="font-size:11px">' + esc(S.data.stats.file || 'data/db.json') + '</div></div>' +
        '<div class="kv"><div class="k">账号数</div><div class="v">' + (S.data.stats.users || 0) + '</div></div>' +
        '<div class="kv"><div class="k">邀请总数</div><div class="v">' + (S.data.stats.invites || 0) + '</div></div>' +
        '<div class="kv"><div class="k">核验记录</div><div class="v">' + (S.data.stats.checks || 0) + '</div></div>' +
        '<div style="font-size:11.5px;color:var(--txt-3);line-height:1.9;margin-top:14px">' +
          '数据库每天首次写入时自动备份到 <span class="mono">data/backups/</span>，保留 7 天。<br>' +
          '密码使用 scrypt 加盐哈希存储，服务端不保存明文。<br>' +
          '正式上线前请把 admin 的初始密码改掉，并给保安账号单独分配设备。' +
        '</div>' +
      '</div></div>' +
    '</div>';

  $('#stSave').onclick = async () => {
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { orgName: $('#stOrg').value.trim(), building: $('#stBuilding').value.trim(), guardDevice: $('#stGuard').value.trim() }
      });
      toast('已保存');
      await loadBootstrap();
    } catch (e) { toast(e.message, true); }
  };
}

/* ==========================================================================
   修改密码
   ========================================================================== */
function mustChangePrompt() {
  openModal({
    title: '建议修改初始密码',
    narrow: true,
    body: '<div style="font-size:13px;color:var(--txt-2);line-height:1.9">当前账号仍在使用管理员分配的初始密码。为免他人代登录，建议现在改掉。</div>',
    foot: '<button class="btn ghost" data-mclose>稍后</button><button class="btn primary" id="mcGo">去修改</button>',
    onMount(root) {
      $('#mcGo', root).onclick = () => { closeModal(); passwordModal(); };
    }
  });
}

function passwordModal() {
  openModal({
    title: '修改密码',
    sub: S.me.name + ' · ' + S.me.username,
    narrow: true,
    body:
      '<div class="field"><label>当前密码</label><input class="input" type="password" id="pwOld" autocomplete="current-password"></div>' +
      '<div class="field"><label>新密码</label><input class="input" type="password" id="pwNew" placeholder="至少 8 位" autocomplete="new-password"></div>' +
      '<div class="field" style="margin-bottom:6px"><label>确认新密码</label><input class="input" type="password" id="pwNew2" autocomplete="new-password"></div>' +
      '<div class="hint">修改成功后需要重新登录。</div>',
    foot: '<button class="btn ghost" data-mclose>取消</button><button class="btn primary" id="pwOk">确认修改</button>',
    onMount(root) {
      $('#pwOk', root).onclick = async () => {
        const n1 = $('#pwNew', root).value;
        const n2 = $('#pwNew2', root).value;
        if (n1 !== n2) { toast('两次输入的新密码不一致', true); return; }
        try {
          await api('/api/auth/password', {
            method: 'POST',
            body: { oldPassword: $('#pwOld', root).value, newPassword: n1 }
          });
          closeModal();
          toast('密码已修改，请重新登录');
          setTimeout(() => { S.me = null; showLogin(); }, 800);
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

/* ==========================================================================
   启动
   ========================================================================== */
function bindGlobal() {
  $('#loginForm').addEventListener('submit', doLogin);
  $('#btnLogout').addEventListener('click', logout);
  $('#btnMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('.side-user').addEventListener('click', e => {
    if (e.target.closest('#btnLogout')) return;
    passwordModal();
  });
  window.addEventListener('hashchange', () => {
    if (!S.me) return;
    renderRoute();
  });
  document.addEventListener('click', e => {
    const side = $('#sidebar');
    if (side.classList.contains('open') && !side.contains(e.target) && !e.target.closest('#btnMenu')) {
      side.classList.remove('open');
    }
  });
}

async function boot() {
  bindGlobal();

  $('#demoAccounts').innerHTML = DEMO.map(d =>
    '<button type="button" data-u="' + d.u + '" data-p="' + d.p + '">' + d.n + ' · ' + d.u + '</button>'
  ).join('');
  $$('#demoAccounts button').forEach(b => {
    b.onclick = () => {
      $('#loginUser').value = b.dataset.u;
      $('#loginPass').value = b.dataset.p;
    };
  });

  try {
    await loadBootstrap();
    if (S.me.roleKey === 'guard' && !location.hash) { location.href = '/guard'; return; }
    showApp();
    if (!location.hash) {
      location.hash = (location.pathname === '/ledger' && can('ledger.view')) ? '#/ledger' : '#/dashboard';
    }
    renderRoute();
    if (S.me.mustChangePassword) setTimeout(mustChangePrompt, 600);
  } catch (e) {
    showLogin();
  }
}

boot();

})();
