'use strict';
/**
 * 首次启动时的初始化数据。只在 users 为空时执行一次。
 * 所有演示账号的初始密码见 README，正式使用请立刻改掉。
 */

const store = require('./store');
const auth = require('./auth');

function seedIfEmpty() {
  const d = store.data();
  if (d.users.length) return false;

  const now = Date.now();

  /* ---------------- 部门 ---------------- */
  d.departments = [
    { id: 'D1', name: '总经办', parentId: '', leaderId: '', sort: 1, note: '' },
    { id: 'D2', name: '技术中心', parentId: '', leaderId: '', sort: 2, note: '' },
    { id: 'D3', name: '平台研发部', parentId: 'D2', leaderId: '', sort: 1, note: '' },
    { id: 'D4', name: '算法与数据部', parentId: 'D2', leaderId: '', sort: 2, note: '' },
    { id: 'D5', name: '市场部', parentId: '', leaderId: '', sort: 3, note: '' },
    { id: 'D6', name: '行政人事部', parentId: '', leaderId: '', sort: 4, note: '' },
    { id: 'D7', name: '安保部', parentId: '', leaderId: '', sort: 5, note: '' }
  ];

  /* ---------------- 角色 ---------------- */
  d.roles = [
    {
      key: 'admin', name: '超级管理员', perms: ['*'], scope: 'all', builtin: true,
      note: '全部权限，包含系统设置', createdAt: now
    },
    {
      key: 'manager', name: '部门主管', scope: 'dept', builtin: true,
      perms: ['invite.create', 'invite.view.self', 'invite.view.dept', 'invite.revoke', 'invite.extend',
        'ledger.view', 'ledger.export', 'staff.view', 'room.view', 'audit.view'],
      note: '可查看并管理本部门及下级部门的邀请', createdAt: now
    },
    {
      key: 'staff', name: '员工', scope: 'self', builtin: true,
      perms: ['invite.create', 'invite.view.self', 'invite.revoke', 'staff.view', 'room.view'],
      note: '只能发起和查看自己的邀请', createdAt: now
    },
    {
      key: 'guard', name: '门岗保安', scope: 'self', builtin: true,
      perms: ['guard.verify', 'ledger.view'],
      note: '只能核验和查看当日台账', createdAt: now
    }
  ];

  /* ---------------- 成员 ---------------- */
  d.users = [
    {
      id: 'U1', username: 'admin', passwordHash: auth.hashPassword('admin123'),
      name: '陈明', title: '行政总监', phone: '13800000001', email: 'chenming@example.com',
      deptId: 'D1', roleKey: 'admin', status: 'active', createdAt: now, lastLoginAt: 0
    },
    {
      id: 'U2', username: 'zhang.qishan', passwordHash: auth.hashPassword('vp123456'),
      name: '张启山', title: '技术中心总经理', phone: '13800000002', email: 'zhang@example.com',
      deptId: 'D2', roleKey: 'manager', status: 'active', createdAt: now, lastLoginAt: 0
    },
    {
      id: 'U3', username: 'li.wei', passwordHash: auth.hashPassword('vp123456'),
      name: '李伟', title: '高级工程师', phone: '13800000003', email: 'liwei@example.com',
      deptId: 'D3', roleKey: 'staff', status: 'active', createdAt: now, lastLoginAt: 0
    },
    {
      id: 'U4', username: 'wang.fang', passwordHash: auth.hashPassword('vp123456'),
      name: '王芳', title: '市场经理', phone: '13800000004', email: 'wangfang@example.com',
      deptId: 'D5', roleKey: 'staff', status: 'active', createdAt: now, lastLoginAt: 0
    },
    {
      id: 'U5', username: 'guard01', passwordHash: auth.hashPassword('vp123456'),
      name: '赵铁柱', title: '门岗保安', phone: '13800000005', email: '',
      deptId: 'D7', roleKey: 'guard', status: 'active', createdAt: now, lastLoginAt: 0
    }
  ];
  d.departments.find(x => x.id === 'D2').leaderId = 'U2';
  d.departments.find(x => x.id === 'D3').leaderId = 'U2';
  d.departments.find(x => x.id === 'D1').leaderId = 'U1';

  /* ---------------- 会议室 ---------------- */
  d.rooms = [
    { id: 'R1', name: '星河厅', building: 'A 座', floor: '28', capacity: 20, equipment: ['投影', '视频会议', '白板'], status: 'active', note: '主接待厅', createdAt: now },
    { id: 'R2', name: '云图厅', building: 'A 座', floor: '28', capacity: 12, equipment: ['电视', '白板'], status: 'active', note: '', createdAt: now },
    { id: 'R3', name: '洽谈室 2806', building: 'A 座', floor: '28', capacity: 6, equipment: ['电视'], status: 'active', note: '小范围沟通', createdAt: now },
    { id: 'R4', name: '报告厅', building: 'A 座', floor: '3', capacity: 120, equipment: ['舞台', '音响', '投影', '直播'], status: 'active', note: '发布会 / 培训', createdAt: now },
    { id: 'R5', name: '董事会议室', building: 'A 座', floor: '30', capacity: 10, equipment: ['视频会议', '同传'], status: 'active', note: '需行政确认', createdAt: now }
  ];

  /* ---------------- 演示用邀请与台账 ---------------- */
  const hour = 3600 * 1000;
  const existingInvites = d.invites.slice();
  const existingChecks = d.checks.slice();

  const demoInvites = [
    {
      token: 'SL' + pad2(new Date().getMonth() + 1) + pad2(new Date().getDate()) + 'AB3K7M',
      code: '3186', guestName: '周立群', company: '中建八局',
      reason: '商务洽谈', note: '一行两人，需停车位',
      hostUserId: 'U2', hostName: '张启山', hostTitle: '技术中心总经理', deptId: 'D2',
      roomId: 'R1', roomName: '星河厅', roomPlace: 'A 座 · 28F · 星河厅',
      quota: 2, usedCount: 1,
      validFrom: now - 3 * hour, validTo: now + 4 * hour,
      status: 'active', allowReentry: true,
      style: 'ticket',
      createdBy: 'U2', createdAt: now - 5 * hour, updatedAt: now
    },
    {
      token: 'SL' + pad2(new Date().getMonth() + 1) + pad2(new Date().getDate()) + 'C9Q2XD',
      code: '5047', guestName: '陈静', company: '蓝海资本',
      reason: '投资尽调', note: '',
      hostUserId: 'U1', hostName: '陈明', hostTitle: '行政总监', deptId: 'D1',
      roomId: 'R5', roomName: '董事会议室', roomPlace: 'A 座 · 30F · 董事会议室',
      quota: 3, usedCount: 0,
      validFrom: now - hour, validTo: now + 6 * hour,
      status: 'active', allowReentry: true,
      style: 'noir',
      createdBy: 'U1', createdAt: now - 2 * hour, updatedAt: now
    },
    {
      token: 'SL' + pad2(new Date().getMonth() + 1) + pad2(new Date().getDate()) + 'E5T8HN',
      code: '9271', guestName: '宋子豪', company: '云栖科技',
      reason: '技术交流', note: '',
      hostUserId: 'U3', hostName: '李伟', hostTitle: '高级工程师', deptId: 'D3',
      roomId: 'R3', roomName: '洽谈室 2806', roomPlace: 'A 座 · 28F · 洽谈室 2806',
      quota: 1, usedCount: 0,
      validFrom: now + 20 * hour, validTo: now + 26 * hour,
      status: 'active', allowReentry: true,
      style: 'minimal',
      createdBy: 'U3', createdAt: now - hour, updatedAt: now
    }
  ];

  const demoChecks = [
    {
      token: demoInvites[0].token, code: '3186', guestName: '周立群', company: '中建八局',
      reason: '商务洽谈', hostName: '张启山', hostUserId: 'U2', roomName: '星河厅', deptId: 'D2',
      quota: 2, ts: now - 2.4 * hour, date: store.dayKey(now - 2.4 * hour), time: timeKey(now - 2.4 * hour),
      pass: true, kind: 'first', input: '3186', guardName: '赵铁柱', guardId: 'U5', deviceId: 'GD-01'
    },
    {
      token: demoInvites[1].token, code: '5047', guestName: '陈静', company: '蓝海资本',
      reason: '投资尽调', hostName: '陈明', hostUserId: 'U1', roomName: '董事会议室', deptId: 'D1',
      quota: 3, ts: now - 40 * 60 * 1000, date: store.dayKey(now - 40 * 60 * 1000), time: timeKey(now - 40 * 60 * 1000),
      pass: true, kind: 'first', input: '5047', guardName: '赵铁柱', guardId: 'U5', deviceId: 'GD-01'
    }
  ];
  demoInvites[1].usedCount = 1;

  if (existingInvites.length) {
    d.invites = existingInvites;
    d.checks = existingChecks;
  } else {
    d.invites = demoInvites;
    d.checks = demoChecks;
  }

  d.settings = Object.assign({}, d.settings, {
    orgName: '星河科技',
    building: 'A 座',
    guardDevice: '主闸机',
    reentryWindow: 60
  });

  store.commit();
  store.flushSync();
  console.log('[seed] 初始化完成：' + d.users.length + ' 个账号 / ' + d.departments.length + ' 个部门 / ' + d.rooms.length + ' 间会议室');
  return true;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function timeKey(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

module.exports = { seedIfEmpty };
