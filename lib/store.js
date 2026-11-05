'use strict';
/**
 * 数据层 —— 文件型存储，零依赖、零编译。
 *
 * 设计取向：
 *   1. 单进程写，不需要并发锁；
 *   2. 每次写走 tmp + rename，rename 在同分区是原子操作，断电不会写出半个文件；
 *   3. 启动时自动把前一天的库备份到 data/backups/，保留 7 天；
 *   4. 对外按「表」组织，将来换 SQLite 只替换本文件。
 */

const fs = require('fs');
const path = require('path');

/* 数据目录可通过 DATA_DIR 指定，便于把数据放到独立磁盘或做多实例隔离 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = DB_FILE + '.tmp';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 7;

const TABLES = ['users', 'departments', 'roles', 'rooms', 'invites', 'checks', 'sessions', 'audit'];

let db = null;
let dirty = false;
let flushTimer = null;
let lastBackupDay = '';

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function emptyDB() {
  return {
    meta: { createdAt: Date.now(), version: 2 },
    users: [],
    departments: [],
    roles: [],
    rooms: [],
    invites: [],
    checks: [],
    sessions: [],
    audit: [],
    settings: {
      orgName: '星河科技',
      building: 'A 座',
      guardDevice: '主闸机',
      reentryWindow: 60
    }
  };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** v1 → v2：老库只有 invites / checks，补齐新表并平移字段 */
function migrate(parsed) {
  const base = emptyDB();
  TABLES.forEach(t => {
    base[t] = Array.isArray(parsed[t]) ? parsed[t] : [];
  });
  base.meta = Object.assign(base.meta, parsed.meta || {});
  base.settings = Object.assign(base.settings, parsed.settings || {});

  base.invites = base.invites.map(inv => {
    const row = Object.assign({}, inv);
    if (row.hostName === undefined) row.hostName = row.host || '';
    if (row.hostUserId === undefined) row.hostUserId = '';
    if (row.deptId === undefined) row.deptId = '';
    if (row.roomId === undefined) roomIdFallback(row);
    if (row.note === undefined) row.note = '';
    if (row.allowReentry === undefined) row.allowReentry = true;
    delete row.host;
    delete row.phone;
    delete row.requireTail;
    return row;
  });
  base.checks = base.checks.map(c => Object.assign({ kind: 'first', denyReason: '' }, c));
  return base;
}

function roomIdFallback(row) {
  row.roomId = '';
  row.roomName = row.place || '';
}

function readFromDisk() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) return emptyDB();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  if (!raw.trim()) return emptyDB();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDB();
  return migrate(parsed);
}

function load() {
  if (db) return db;
  try {
    db = readFromDisk();
  } catch (err) {
    /* 文件损坏不能直接崩：留一份现场，再用空库起来，至少服务还在 */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = DB_FILE + '.broken-' + stamp;
    try { fs.copyFileSync(DB_FILE, bad); } catch (_) {}
    console.error('[store] 数据文件解析失败，已备份到', bad, '｜原因:', err.message);
    db = emptyDB();
  }
  return db;
}

/* ---------------- 每日备份 ---------------- */

function backupDaily() {
  const today = dayKey(Date.now());
  if (lastBackupDay === today) return;
  lastBackupDay = today;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const st = fs.statSync(DB_FILE);
    if (!st.size) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const target = path.join(BACKUP_DIR, 'db-' + today + '.json');
    if (!fs.existsSync(target)) fs.copyFileSync(DB_FILE, target);

    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (_) {}
    }
  } catch (err) {
    console.error('[store] 备份失败:', err.message);
  }
}

/* ---------------- 落盘 ---------------- */

function flushSync() {
  if (!dirty || !db) return;
  ensureDir();
  backupDaily();
  fs.writeFileSync(TMP_FILE, JSON.stringify(db), 'utf8');
  fs.renameSync(TMP_FILE, DB_FILE);
  dirty = false;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { flushSync(); } catch (err) { console.error('[store] 落盘失败:', err.message); }
  }, 120);
}

/* ---------------- 对外接口 ---------------- */

function data() { return load(); }
function table(name) {
  if (TABLES.indexOf(name) < 0) throw new Error('未知数据表: ' + name);
  return load()[name];
}
function commit() { scheduleFlush(); }
function settings() { return load().settings; }

function stats() {
  const d = load();
  return {
    users: d.users.length,
    invites: d.invites.length,
    checks: d.checks.length,
    file: DB_FILE,
    since: d.meta.createdAt
  };
}

function close() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushSync();
}

module.exports = {
  TABLES, data, table, commit, settings, stats, close, flushSync,
  DB_FILE, DATA_DIR, dayKey
};
