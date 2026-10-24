// 纯函数：互动时间表解析与匹配、流失预警分级、客户流失检测（对比两次同步）、成员汇总、CSV 导出。不依赖界面和网络。
//
// 关于「最后互动时间」：企业微信官方「获取客户详情」接口（path/92114）的跟进信息里没有最后聊天/互动时间，
// 只有添加时间 createtime。所以本工具这样算：用户导入了某客户的最后互动时间就用导入值，没有就用添加时间做估算，
// 并在清单里标明依据。
import type { BehaviorDay, Relation } from './wecom';

export const DAY = 86400;
const TZ = 8 * 3600;
export const dayKey = (sec: number) => new Date((sec + TZ) * 1000).toISOString().slice(0, 10);
export const relKey = (r: { userid: string; externalUserid: string }) => `${r.userid}\n${r.externalUserid}`;

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (lines: (string | number)[][]) => '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** 把各种常见日期写法转成秒（按北京时间）；认不出返回 null */
export function parseDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);
  if (/^\d{10}$/.test(s)) return Number(s);
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 80000) return Math.round((Number(s) - 25569) * DAY) - TZ; // Excel 序列日期
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', se = '0'] = m.slice(1);
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +se > 59) return null;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000 - TZ;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-（）()]/g, '');
const HEAD: Record<'ext' | 'name' | 'user' | 'time', string[]> = {
  // check-zh: 忽略（只用来识别用户导入表格的表头，兼容旧版导出和企业微信原始字段名，不显示给用户）
  ext: ['客户id', '外部联系人id', '客户编号', 'externaluserid', '客户externaluserid', '客户userid'],
  name: ['客户名称', '客户昵称', '客户', '姓名', 'name'],
  // check-zh: 忽略
  user: ['跟进成员', '成员', '成员账号', '所属成员', '成员userid', 'userid'],
  time: ['最后互动时间', '最近互动时间', '最后聊天时间', '最近聊天时间', '最后沟通时间', '最后联系时间', '最后跟进时间', 'lastcontact', 'lastinteraction', '互动时间'],
};

export interface ImportRow { ext: string; name: string; user: string; at: number }
export interface ParsedImport { rows: ImportRow[]; bad: { line: number; reason: string }[] }

/** 解析互动时间表：必须有「最后互动时间」列，以及「客户 ID」或「客户名称」其中之一；「跟进成员」可选 */
export function parseInteractionCsv(text: string): ParsedImport {
  const t = parseCsv(text);
  if (!t.length) throw new Error('文件是空的');
  const head = t[0].map(norm);
  const col = (k: keyof typeof HEAD) => head.findIndex((h) => HEAD[k].map(norm).includes(h));
  const [ci, cn, cu, ct] = [col('ext'), col('name'), col('user'), col('time')];
  if (ct < 0) throw new Error('没找到「最后互动时间」列。表头需要包含：最后互动时间，以及「客户 ID」或「客户名称」，可选「跟进成员」');
  if (ci < 0 && cn < 0) throw new Error('没找到「客户 ID」或「客户名称」列，无法对应到客户');
  const rows: ImportRow[] = [];
  const bad: ParsedImport['bad'] = [];
  t.slice(1).forEach((r, i) => {
    const line = i + 2;
    const at = parseDate(r[ct] ?? '');
    const ext = ci >= 0 ? (r[ci] ?? '').trim() : '';
    const name = cn >= 0 ? (r[cn] ?? '').trim() : '';
    if (!ext && !name) return bad.push({ line, reason: '客户 ID 和客户名称都是空的' });
    if (at === null) return bad.push({ line, reason: `无法识别日期「${(r[ct] ?? '').trim()}」` });
    rows.push({ ext, name, user: cu >= 0 ? (r[cu] ?? '').trim() : '', at });
  });
  return { rows, bad };
}

export interface MatchResult { map: Map<string, number>; matched: number; unmatched: number; ambiguous: number }

/** 把导入行对应到「成员 + 客户」跟进关系；用客户名称对应时，名称重复且没写成员的视为有歧义，不采用 */
export function matchInteractions(rels: Relation[], rows: ImportRow[], base = new Map<string, number>()): MatchResult {
  const map = new Map(base);
  const byExt = new Map<string, Relation[]>();
  const byName = new Map<string, Relation[]>();
  for (const r of rels) {
    byExt.set(r.externalUserid, [...(byExt.get(r.externalUserid) ?? []), r]);
    if (r.name) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  }
  let matched = 0, unmatched = 0, ambiguous = 0;
  for (const row of rows) {
    let cands = row.ext ? byExt.get(row.ext) ?? [] : byName.get(row.name) ?? [];
    if (row.user) cands = cands.filter((c) => c.userid === row.user);
    if (!cands.length) { unmatched++; continue; }
    if (!row.ext && !row.user && new Set(cands.map((c) => c.externalUserid)).size > 1) { ambiguous++; continue; }
    matched++;
    for (const c of cands) { const k = relKey(c); map.set(k, Math.max(map.get(k) ?? 0, row.at)); }
  }
  return { map, matched, unmatched, ambiguous };
}

// ---------- 分级 ----------

export type Level = '高危' | '预警' | '关注';
export interface Thresholds { watch: number; warn: number; high: number }
export const DEFAULT_THRESHOLDS: Thresholds = { watch: 14, warn: 30, high: 60 };

export function checkThresholds(t: Thresholds): string | null {
  if (![t.watch, t.warn, t.high].every((n) => Number.isInteger(n) && n >= 1 && n <= 3650)) return '天数要填 1～3650 的整数';
  if (!(t.watch < t.warn && t.warn < t.high)) return '要满足：关注天数 < 预警天数 < 高危天数';
  return null;
}
export function levelOf(days: number, t: Thresholds): Level | null {
  return days >= t.high ? '高危' : days >= t.warn ? '预警' : days >= t.watch ? '关注' : null;
}

export interface Row {
  key: string;
  userid: string;
  externalUserid: string;
  name: string;
  corpName: string;
  remark: string;
  description: string;
  addedAt: number;
  lastAt: number;
  /** 导入 = 用户导入的最后互动时间；添加时间 = 没有互动数据，用添加时间估算 */
  basis: '导入' | '添加时间';
  days: number;
  level: Level;
  important: boolean;
}

export interface ListOpts { now: number; thresholds: Thresholds; users?: string[]; levels?: Level[]; keywords?: string; interactions?: Map<string, number> }

export function splitKeywords(s: string): string[] {
  return s.split(/[、,，;；\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** 生成跟进清单：只列达到「关注」天数的客户，天数多的在前；重点客户（备注/描述含关键词）同天数下排前面 */
export function buildList(rels: Relation[], o: ListOpts): Row[] {
  const nowSec = Math.floor(o.now / 1000);
  const kws = splitKeywords(o.keywords ?? '');
  const rows: Row[] = [];
  for (const r of rels) {
    if (o.users?.length && !o.users.includes(r.userid)) continue;
    const key = relKey(r);
    const imp = o.interactions?.get(key);
    const lastAt = imp && imp > r.createtime ? imp : r.createtime;
    const basis: Row['basis'] = imp && imp > r.createtime ? '导入' : '添加时间';
    if (!lastAt) continue;
    const days = Math.max(0, Math.floor((nowSec - lastAt) / DAY));
    const level = levelOf(days, o.thresholds);
    if (!level || (o.levels?.length && !o.levels.includes(level))) continue;
    const text = `${r.remark} ${r.description}`.toLowerCase();
    rows.push({ key, userid: r.userid, externalUserid: r.externalUserid, name: r.name, corpName: r.corpName, remark: r.remark, description: r.description, addedAt: r.createtime, lastAt, basis, days, level, important: kws.some((k) => text.includes(k)) });
  }
  return rows.sort((a, b) => b.days - a.days || Number(b.important) - Number(a.important) || a.userid.localeCompare(b.userid) || a.externalUserid.localeCompare(b.externalUserid));
}

export interface MemberSummary { userid: string; customers: number; high: number; warn: number; watch: number; chat30: number | null; newContact30: number | null }

export function memberSummary(rels: Relation[], rows: Row[], behavior: Map<string, BehaviorDay[]>): MemberSummary[] {
  const m = new Map<string, MemberSummary>();
  const get = (u: string) => m.get(u) ?? m.set(u, { userid: u, customers: 0, high: 0, warn: 0, watch: 0, chat30: null, newContact30: null }).get(u)!;
  for (const r of rels) get(r.userid).customers++;
  for (const r of rows) { const s = get(r.userid); if (r.level === '高危') s.high++; else if (r.level === '预警') s.warn++; else s.watch++; }
  for (const [u, days] of behavior) { const s = get(u); s.chat30 = days.reduce((a, d) => a + d.chat, 0); s.newContact30 = days.reduce((a, d) => a + d.newContact, 0); }
  return [...m.values()].sort((a, b) => b.high - a.high || b.warn - a.warn || b.customers - a.customers || a.userid.localeCompare(b.userid));
}

// ---------- 流失检测（对比两次同步） ----------

export interface SnapRel { userid: string; externalUserid: string; name: string; remark: string; description: string; createtime: number }
export interface LostRel extends SnapRel { detectedAt: number }
export const toSnap = (r: Relation): SnapRel => ({ userid: r.userid, externalUserid: r.externalUserid, name: r.name, remark: r.remark, description: r.description, createtime: r.createtime });

/**
 * 上次有、这次没有的「成员 + 客户」关系，视为流失（客户删除了成员，或成员删除了客户）。
 * 只统计这次仍能读到的成员；成员不在这次的成员列表里、或没有互通账号许可的，无法判断，不算。
 * 官方接口没有提供「客户删除成员」的查询，只能靠两次同步对比，所以只能发现「两次同步之间」发生的流失。
 */
export function detectLost(prev: SnapRel[], cur: Relation[], users: string[], unlicensed: string[], now: number): { lost: LostRel[]; skipped: number } {
  const have = new Set(cur.map(relKey));
  const ok = new Set(users.filter((u) => !unlicensed.includes(u)));
  const lost: LostRel[] = [];
  let skipped = 0;
  for (const p of prev) {
    if (have.has(relKey(p))) continue;
    if (!ok.has(p.userid)) { skipped++; continue; }
    lost.push({ ...p, detectedAt: Math.floor(now / 1000) });
  }
  return { lost, skipped };
}

/** 合并历史流失记录：同一条关系又出现了（重新添加）就从记录里去掉；最多保留 2000 条 */
export function mergeLost(log: LostRel[], fresh: LostRel[], cur: Relation[]): LostRel[] {
  const have = new Set(cur.map(relKey));
  const seen = new Set<string>();
  return [...fresh, ...log].filter((l) => { const k = relKey(l); if (have.has(k) || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.detectedAt - a.detectedAt).slice(0, 2000);
}

// ---------- 导出 ----------

export function listCsv(rows: Row[]): string {
  return toCsv([
    ['优先级', '跟进成员', '客户名称', '客户企业名', '备注', '描述', '添加时间', '最后互动时间', '未互动天数', '时间依据', '重点客户', '客户 ID'],
    ...rows.map((r) => [r.level, r.userid, r.name, r.corpName, r.remark, r.description, dayKey(r.addedAt), dayKey(r.lastAt), r.days, r.basis === '导入' ? '导入的互动时间' : '添加时间（估算）', r.important ? '是' : '', r.externalUserid]),
  ]);
}
export function lostCsv(lost: LostRel[]): string {
  return toCsv([['原跟进成员', '客户名称', '备注', '描述', '添加时间', '发现流失日期', '客户 ID'], ...lost.map((l) => [l.userid, l.name, l.remark, l.description, dayKey(l.createtime), dayKey(l.detectedAt), l.externalUserid])]);
}
export function memberCsv(ms: MemberSummary[]): string {
  return toCsv([['成员', '客户数', '高危', '预警', '关注', '近 30 天聊天客户数', '近 30 天新增客户数'], ...ms.map((m) => [m.userid, m.customers, m.high, m.warn, m.watch, m.chat30 ?? '', m.newContact30 ?? ''])]);
}
/** 按成员拆分：每位成员一份清单，文件名带成员 userid */
export function splitByMember(rows: Row[]): { userid: string; file: string; csv: string; count: number }[] {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(r.userid, [...(m.get(r.userid) ?? []), r]);
  return [...m].map(([userid, list]) => ({ userid, file: `跟进清单-${userid.replace(/[\\/:*?"<>|\s]+/g, '_')}.csv`, csv: listCsv(list), count: list.length }));
}
