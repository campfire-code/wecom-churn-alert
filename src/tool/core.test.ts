// 互动时间表解析与匹配、分级、清单排序、流失检测、导出。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS, buildList, checkThresholds, detectLost, levelOf, listCsv, lostCsv, matchInteractions, memberCsv, memberSummary, mergeLost, parseCsv, parseDate,
  parseInteractionCsv, relKey, splitByMember, toSnap,
} from './core';
import type { Relation } from './wecom';

const NOW = Date.UTC(2026, 9, 23, 2, 0);
const SEC = Math.floor(NOW / 1000);
const rel = (p: Partial<Relation> = {}): Relation => ({
  userid: 'xiaoli', externalUserid: 'wmDEMO0001', name: '示例客户', type: 1, corpName: '', createtime: SEC - 100 * 86400, remark: '', description: '', tagIds: [], state: '', addWay: 1, operUserid: 'xiaoli', ...p,
});

describe('日期与 CSV', () => {
  it('常见日期写法按北京时间解析', () => {
    const d = Date.UTC(2026, 9, 20, 0, 0) / 1000 - 8 * 3600;
    expect(parseDate('2026-10-20')).toBe(d);
    expect(parseDate('2026/10/20')).toBe(d);
    expect(parseDate('2026年10月20日')).toBe(d);
    expect(parseDate('2026-10-20 08:30:15')).toBe(d + 8 * 3600 + 30 * 60 + 15);
    expect(parseDate(String(d))).toBe(d);
    expect(parseDate(String(d * 1000))).toBe(d);
    expect(parseDate('46315')).toBe(Math.round((46315 - 25569) * 86400) - 8 * 3600);
    expect(parseDate('待补')).toBeNull();
    expect(parseDate('2026-13-40')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
  it('CSV 支持引号、转义引号、BOM、CRLF', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n\r\n')).toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
  });
});

describe('互动时间表', () => {
  it('识别表头别名；坏行记录行号', () => {
    const p = parseInteractionCsv('客户 external_userid,跟进成员,最后聊天时间\nwmA,xiaoli,2026-10-20\nwmB,xiaoli,待补\n,,2026-10-20\n');
    expect(p.rows).toEqual([{ ext: 'wmA', name: '', user: 'xiaoli', at: parseDate('2026-10-20')! }]);
    expect(p.bad).toEqual([{ line: 3, reason: '无法识别日期「待补」' }, { line: 4, reason: '客户 ID 和客户名称都是空的' }]);
  });
  it('缺列时给出明确提示', () => {
    expect(() => parseInteractionCsv('客户名称,备注\n甲,x')).toThrow('最后互动时间');
    expect(() => parseInteractionCsv('最后互动时间\n2026-10-20')).toThrow('客户名称');
    expect(() => parseInteractionCsv('')).toThrow('空');
  });
  it('按 external_userid 或名称匹配；名称重复且没写成员时跳过', () => {
    const rels = [rel(), rel({ userid: 'xiaozhou' }), rel({ externalUserid: 'wm2', name: '重名' }), rel({ externalUserid: 'wm3', name: '重名' })];
    const at = parseDate('2026-10-20')!;
    const r = matchInteractions(rels, [
      { ext: 'wmDEMO0001', name: '', user: 'xiaoli', at }, { ext: 'wmDEMO0001', name: '', user: '', at: at + 100 },
      { ext: '', name: '重名', user: '', at }, { ext: 'nope', name: '', user: '', at }, { ext: '', name: '示例客户', user: 'xiaozhou', at },
    ]);
    expect(r).toMatchObject({ matched: 3, ambiguous: 1, unmatched: 1 });
    expect(r.map.get(relKey(rels[0]))).toBe(at + 100);
    expect(r.map.get(relKey(rels[1]))).toBe(at + 100);
  });
});

describe('分级与清单', () => {
  it('阈值检查与分级边界', () => {
    expect(checkThresholds(DEFAULT_THRESHOLDS)).toBeNull();
    expect(checkThresholds({ watch: 30, warn: 30, high: 60 })).toContain('<');
    expect(checkThresholds({ watch: 0, warn: 30, high: 60 })).toContain('整数');
    expect([13, 14, 29, 30, 59, 60].map((d) => levelOf(d, DEFAULT_THRESHOLDS))).toEqual([null, '关注', '关注', '预警', '预警', '高危']);
  });
  it('没有导入时按添加时间估算；导入的互动时间晚于添加时间才采用', () => {
    const a = rel({ externalUserid: 'a', createtime: SEC - 100 * 86400 });
    const b = rel({ externalUserid: 'b', createtime: SEC - 100 * 86400 });
    const c = rel({ externalUserid: 'c', createtime: SEC - 10 * 86400 });
    const inter = new Map([[relKey(b), SEC - 20 * 86400], [relKey(c), SEC - 50 * 86400]]);
    const rows = buildList([a, b, c], { now: NOW, thresholds: DEFAULT_THRESHOLDS, interactions: inter });
    expect(rows.map((r) => [r.externalUserid, r.days, r.level, r.basis])).toEqual([['a', 100, '高危', '添加时间'], ['b', 20, '关注', '导入']]);
  });
  it('筛选成员和级别；重点客户同天数排前面', () => {
    const rels = [rel({ externalUserid: 'a', remark: '普通' }), rel({ externalUserid: 'b', remark: 'VIP 老客户' }), rel({ externalUserid: 'c', userid: 'xiaozhou' })];
    const all = buildList(rels, { now: NOW, thresholds: DEFAULT_THRESHOLDS, keywords: 'vip、加盟' });
    expect(all.map((r) => r.externalUserid)).toEqual(['b', 'a', 'c']);
    expect(all[0].important).toBe(true);
    expect(buildList(rels, { now: NOW, thresholds: DEFAULT_THRESHOLDS, users: ['xiaozhou'] }).map((r) => r.externalUserid)).toEqual(['c']);
    expect(buildList(rels, { now: NOW, thresholds: DEFAULT_THRESHOLDS, levels: ['关注'] })).toEqual([]);
  });
  it('成员汇总带联系客户统计', () => {
    const rels = [rel({ externalUserid: 'a' }), rel({ externalUserid: 'b', createtime: SEC - 20 * 86400 }), rel({ externalUserid: 'c', userid: 'xiaozhou', createtime: SEC })];
    const rows = buildList(rels, { now: NOW, thresholds: DEFAULT_THRESHOLDS });
    const ms = memberSummary(rels, rows, new Map([['xiaoli', [{ statTime: 1, newApply: 0, newContact: 2, chat: 3, message: 5, negativeFeedback: 0 }, { statTime: 2, newApply: 0, newContact: 1, chat: 4, message: 5, negativeFeedback: 0 }]]]));
    expect(ms[0]).toEqual({ userid: 'xiaoli', customers: 2, high: 1, warn: 0, watch: 1, chat30: 7, newContact30: 3 });
    expect(ms[1]).toMatchObject({ userid: 'xiaozhou', customers: 1, high: 0, chat30: null });
  });
});

describe('流失检测', () => {
  const prev = [toSnap(rel({ externalUserid: 'a' })), toSnap(rel({ externalUserid: 'b' })), toSnap(rel({ externalUserid: 'c', userid: 'gone_user' })), toSnap(rel({ externalUserid: 'd', userid: 'nolic' }))];
  it('上次有这次没有算流失；成员不可读或没有许可的不算', () => {
    const cur = [rel({ externalUserid: 'a' })];
    const r = detectLost(prev, cur, ['xiaoli', 'nolic'], ['nolic'], NOW);
    expect(r.lost.map((l) => l.externalUserid)).toEqual(['b']);
    expect(r.skipped).toBe(2);
    expect(r.lost[0].detectedAt).toBe(SEC);
  });
  it('历史记录合并：重新添加的从记录里去掉，新的在前', () => {
    const old = [{ ...prev[0], detectedAt: 1 }, { ...prev[1], detectedAt: 2 }];
    const merged = mergeLost(old, [{ ...prev[2], detectedAt: 3 }], [rel({ externalUserid: 'a' })]);
    expect(merged.map((l) => l.externalUserid)).toEqual(['c', 'b']);
  });
});

describe('导出', () => {
  const rows = buildList([rel({ name: '甲,乙', remark: 'VIP' }), rel({ externalUserid: 'b', userid: 'xiaozhou' })], { now: NOW, thresholds: DEFAULT_THRESHOLDS, keywords: 'vip' });
  it('清单 CSV：带 BOM、12 列、逗号转义、依据说明', () => {
    const csv = listCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [head, line1] = csv.split('\r\n');
    expect(head.split(',')).toHaveLength(12);
    expect(line1).toContain('"甲,乙"');
    expect(line1).toContain('添加时间（估算）');
    expect(line1).toContain(',是,');
  });
  it('按成员拆分文件', () => {
    const parts = splitByMember(rows);
    expect(parts.map((p) => [p.file, p.count])).toEqual([['跟进清单-xiaoli.csv', 1], ['跟进清单-xiaozhou.csv', 1]]);
  });
  it('成员汇总与流失 CSV 表头', () => {
    expect(memberCsv([]).split('\r\n')[0]).toContain('近 30 天聊天客户数');
    expect(lostCsv([]).split('\r\n')[0]).toContain('发现流失日期');
  });
});
