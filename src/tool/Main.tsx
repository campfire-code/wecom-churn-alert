// 客户流失预警清单：连接企业微信 → 同步客户 → （可选）导入最后互动时间 → 按天数分级的跟进清单 / 按成员汇总 / 已流失客户 → 导出 CSV。
import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Download, FileUp, Loader2, RefreshCw, Users } from 'lucide-react';
import type { RunContext } from '../kit/types';
import { defaultOutputDir, pickFiles, settingsStore } from '../kit/platform';
import { useDroppedFiles } from '../kit/parts';
import type { BehaviorDay, Relation } from './wecom';
import {
  DEFAULT_THRESHOLDS, buildList, checkThresholds, dayKey, listCsv, lostCsv, matchInteractions, memberCsv, memberSummary, parseInteractionCsv, splitByMember,
  type ImportRow, type Level, type LostRel, type SnapRel, type Thresholds,
} from './core';
import { syncChurn } from './flow';
import { SetupPanel, SourceSwitch, useConn } from './Setup';
import './setup.css';
import './tool.css';

type Ctx = Pick<RunContext, 'writeText' | 'readText' | 'join' | 'mkdir'>;
type Notice = { kind: 'ok' | 'err'; text: string } | null;
type Tab = 'list' | 'member' | 'lost';
export interface DemoState {
  rels: Relation[]; users: string[]; behavior: Map<string, BehaviorDay[]>; interactions: Map<string, number>; lost: LostRel[]; now: number;
  notice?: Notice; keywords?: string; tab?: Tab; imported?: string;
}

const KEY = 'wecom-churn.state';
interface Saved { thresholds: Thresholds; keywords: string; interactions: [string, number][]; snapshot: SnapRel[]; lostLog: LostRel[]; syncedAt: number }
const LEVELS: Level[] = ['高危', '预警', '关注'];
const OUT = '客户流失预警清单';

export function Main({ ctx }: { ctx: Ctx }) {
  const preview = location.pathname.endsWith('preview.html');
  const conn = useConn(preview);
  const [setupOpen, setSetupOpen] = useState(false);
  const [rels, setRels] = useState<Relation[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [behavior, setBehavior] = useState<Map<string, BehaviorDay[]>>(new Map());
  const [interactions, setInteractions] = useState<Map<string, number>>(new Map());
  const [imported, setImported] = useState('');
  const [lostLog, setLostLog] = useState<LostRel[]>([]);
  const [snapshot, setSnapshot] = useState<SnapRel[]>([]);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [keywords, setKeywords] = useState('');
  const [memberPick, setMemberPick] = useState('');
  const [levelPick, setLevelPick] = useState<Level | ''>('');
  const [tab, setTab] = useState<Tab>('list');
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const stop = useRef<AbortController | null>(null);
  const fail = (e: unknown) => setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });

  const persist = (p: Partial<Saved>) => {
    if (preview) return;
    settingsStore().then(async (s) => { const old = (await s.get<Saved>(KEY)) ?? ({} as Saved); await s.set(KEY, { ...old, ...p }); }).catch(() => {});
  };
  useEffect(() => {
    if (preview) {
      import('./preview').then(({ demo }) => { setRels(demo.rels); setUsers(demo.users); setBehavior(demo.behavior); setInteractions(demo.interactions); setLostLog(demo.lost); setNow(demo.now); setNotice(demo.notice ?? null); setKeywords(demo.keywords ?? ''); setTab(demo.tab ?? 'list'); setImported(demo.imported ?? ''); });
      return;
    }
    settingsStore().then((s) => s.get<Saved>(KEY)).then((v) => {
      if (!v) return;
      if (v.thresholds) setThresholds(v.thresholds);
      setKeywords(v.keywords ?? ''); setInteractions(new Map(v.interactions ?? [])); setSnapshot(v.snapshot ?? []); setLostLog(v.lostLog ?? []);
      if (v.interactions?.length) setImported(`已保存 ${v.interactions.length} 条互动时间`);
    }).catch(() => {});
  }, [preview]);

  const thErr = checkThresholds(thresholds);
  const allRows = useMemo(() => (thErr ? [] : buildList(rels, { now, thresholds, interactions, keywords })), [rels, now, thresholds, interactions, keywords, thErr]);
  const rows = useMemo(() => allRows.filter((r) => (!memberPick || r.userid === memberPick) && (!levelPick || r.level === levelPick)), [allRows, memberPick, levelPick]);
  const members = useMemo(() => memberSummary(rels, allRows, behavior), [rels, allRows, behavior]);
  const cnt = (l: Level) => allRows.filter((r) => r.level === l).length;
  const estimated = allRows.filter((r) => r.basis === '添加时间').length;

  const sync = async () => {
    const ac = new AbortController(); stop.current = ac; setBusy(true); setNotice(null);
    try {
      const t = Date.now();
      const r = await syncChurn(conn.http, conn.activeCred, { now: t, prev: snapshot, prevLost: lostLog, gapMs: conn.source === 'demo' ? 0 : 120, onStep: setProgress, signal: ac.signal });
      setRels(r.rels); setUsers(r.users); setBehavior(r.behavior); setNow(t); setLostLog(r.lostLog); setSnapshot(r.snapshot);
      persist({ snapshot: r.snapshot, lostLog: r.lostLog, syncedAt: t });
      const bits = [`取到 ${r.users.length} 位成员的 ${r.rels.length} 条客户关系`];
      bits.push(snapshot.length ? `和上次同步对比，新发现 ${r.newLost.length} 条流失` : '这是第一次同步，下次同步起才能发现流失');
      if (r.behaviorFailed) bits.push(`${r.behaviorFailed} 位成员的联系客户统计读取失败`);
      if (r.unlicensed.length) bits.push(`${r.unlicensed.length} 位成员没有互通账号许可，客户未取到`);
      setNotice({ kind: r.behaviorFailed ? 'err' : 'ok', text: bits.join('；') });
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const importFile = async (path: string) => {
    if (!rels.length) return setNotice({ kind: 'err', text: '请先点「同步客户」，再导入互动时间表' });
    try {
      const p = parseInteractionCsv(await ctx.readText(path));
      const m = matchInteractions(rels, p.rows as ImportRow[], interactions);
      setInteractions(m.map);
      const msg = `导入 ${p.rows.length} 行：对上 ${m.matched} 行，没对上 ${m.unmatched} 行${m.ambiguous ? `，${m.ambiguous} 行因客户名称重复且没写成员而跳过` : ''}${p.bad.length ? `，${p.bad.length} 行无法识别（第 ${p.bad.slice(0, 5).map((b) => b.line).join('、')}${p.bad.length > 5 ? ' 等' : ''} 行）` : ''}`;
      setImported(`已保存 ${m.map.size} 条互动时间`);
      persist({ interactions: [...m.map] });
      setNotice({ kind: m.matched ? 'ok' : 'err', text: msg });
    } catch (e) { fail(e); }
  };
  const pick = async () => { const f = await pickFiles(['csv', 'txt'], '互动时间表（CSV）'); if (f[0]) void importFile(f[0]); };
  const hover = useDroppedFiles((paths) => { const f = paths.find((p) => /\.(csv|txt)$/i.test(p)); if (f) void importFile(f); else setNotice({ kind: 'err', text: '请拖入 CSV 文件' }); });

  const save = async (name: string, text: string, dir?: string) => {
    const d = dir ?? await defaultOutputDir(OUT);
    const p = await ctx.join(d, name);
    await ctx.writeText(p, text);
    return p;
  };
  const stamp = dayKey(Math.floor(now / 1000));
  const exportList = async () => { try { setNotice({ kind: 'ok', text: `已导出：${await save(`跟进清单-${stamp}.csv`, listCsv(rows))}` }); } catch (e) { fail(e); } };
  const exportSplit = async () => {
    try {
      const dir = await ctx.join(await defaultOutputDir(OUT), `按成员-${stamp}`);
      await ctx.mkdir(dir);
      const parts = splitByMember(rows);
      for (const p of parts) await save(p.file, p.csv, dir);
      setNotice({ kind: 'ok', text: `已按 ${parts.length} 位成员各导出一份清单：${dir}` });
    } catch (e) { fail(e); }
  };
  const exportMembers = async () => { try { setNotice({ kind: 'ok', text: `已导出：${await save(`成员汇总-${stamp}.csv`, memberCsv(members))}` }); } catch (e) { fail(e); } };
  const exportLost = async () => { try { setNotice({ kind: 'ok', text: `已导出：${await save(`已流失客户-${stamp}.csv`, lostCsv(lostLog))}` }); } catch (e) { fail(e); } };

  const setTh = (k: keyof Thresholds, v: string) => { const t = { ...thresholds, [k]: Number(v) }; setThresholds(t); persist({ thresholds: t }); };
  const ready = rels.length > 0;

  return (
    <div className="ch-root">
      <div className="ch-top">
        <SourceSwitch conn={conn} disabled={busy} />
        {conn.source === 'demo' && <span className="k-help">示例数据：虚构的企业、成员和客户</span>}
      </div>
      {conn.source === 'wecom' && <SetupPanel conn={conn} open={setupOpen || !conn.ready} setOpen={setSetupOpen} onMsg={setNotice} />}
      {notice && <div className={`k-notice ${notice.kind}`} role="status">{notice.text}</div>}

      <section className="k-panel ch-card">
        <div className="ch-hd"><b>1. 同步客户</b>
          {ready && <span className="k-help">{users.length} 位成员，{rels.length} 条跟进关系；每次同步都会和上次对比，发现流失客户</span>}
          <span className="ch-grow" />
          <button className="k-btn primary" disabled={busy || !conn.ready} onClick={() => void sync()}>{busy ? <Loader2 size={15} className="k-spin" /> : ready ? <RefreshCw size={15} /> : <Users size={15} />}{ready ? '重新同步' : '同步客户'}</button>
        </div>
        {busy && <div className="ch-progress"><Loader2 size={15} className="k-spin" />{progress || '处理中…'}<button className="k-btn" onClick={() => stop.current?.abort()}>停止</button></div>}
        <div className={`ch-import${hover ? ' hover' : ''}`}>
          <FileUp size={16} />
          <span>最后互动时间表（可选，CSV）：官方接口不提供客户的最后聊天时间，没有导入时按<b>添加时间</b>估算。表头需含「最后互动时间」，以及「客户 external_userid」或「客户名称」，可选「跟进成员」。</span>
          <span className="ch-grow" />
          {imported && <span className="k-st ok">{imported}</span>}
          <button className="k-btn" disabled={busy} onClick={() => void pick()}>选择文件</button>
          {interactions.size > 0 && <button className="k-btn ghost" onClick={() => { setInteractions(new Map()); setImported(''); persist({ interactions: [] }); }}>清除导入</button>}
        </div>
      </section>

      <section className="k-panel ch-card">
        <div className="ch-hd"><b>2. 预警规则</b><span className="k-help">未互动天数 ≥ 下面的天数就进入清单</span></div>
        <div className="ch-rules">
          {([['watch', '关注'], ['warn', '预警'], ['high', '高危']] as const).map(([k, l]) => (
            <label key={k} className="ch-num"><span className={`ch-lv ${k}`}>{l}</span>≥<input className="k-input" type="number" min={1} max={3650} value={thresholds[k]} aria-label={`${l}天数`} onChange={(e) => setTh(k, e.target.value)} />天</label>
          ))}
          <select className="k-input ch-sel" aria-label="跟进成员" value={memberPick} onChange={(e) => setMemberPick(e.target.value)}><option value="">全部成员</option>{users.map((u) => <option key={u} value={u}>{u}</option>)}</select>
          <input className="k-input ch-kw" aria-label="重点客户关键词" value={keywords} placeholder="重点客户关键词（备注/描述含则标「重点」，顿号隔开）" onChange={(e) => { setKeywords(e.target.value); persist({ keywords: e.target.value }); }} />
        </div>
        {thErr && <p className="ch-bad">{thErr}</p>}
      </section>

      {ready && !thErr && (
        <section className="k-panel ch-card">
          <div className="ch-hd">
            <div className="k-seg ch-tabs" role="tablist" aria-label="结果">
              {([['list', '跟进清单'], ['member', '按成员'], ['lost', `已流失 ${lostLog.length}`]] as const).map(([v, l]) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{l}</button>)}
            </div>
            <span className="ch-grow" />
            {tab === 'list' && <><button className="k-btn" disabled={!rows.length} onClick={() => void exportSplit()}><Download size={15} />按成员分文件导出</button><button className="k-btn primary" disabled={!rows.length} onClick={() => void exportList()}><Download size={15} />导出清单</button></>}
            {tab === 'member' && <button className="k-btn primary" onClick={() => void exportMembers()}><Download size={15} />导出成员汇总</button>}
            {tab === 'lost' && <button className="k-btn primary" disabled={!lostLog.length} onClick={() => void exportLost()}><Download size={15} />导出已流失</button>}
          </div>

          {tab === 'list' && (
            <>
              <div className="ch-kpis">
                {LEVELS.map((l) => <button key={l} className={`ch-kpi ${l}${levelPick === l ? ' on' : ''}`} onClick={() => setLevelPick(levelPick === l ? '' : l)} aria-pressed={levelPick === l}><span>{l}</span><b className="k-num">{cnt(l)}</b></button>)}
                <div className="ch-kpi"><span>全部客户关系</span><b className="k-num">{rels.length}</b></div>
              </div>
              {estimated > 0 && <p className="k-help">{estimated} 条是按添加时间估算的（没有导入互动时间）：这些客户可能其实一直在聊天，请结合备注判断，或导入互动时间表。</p>}
              {rows.length === 0 ? <p className="k-muted">没有达到条件的客户。</p> : (
                <div className="k-scroll ch-tablebox">
                  <table className="k-table">
                    <thead><tr><th>优先级</th><th>客户（示例名仅用于演示）</th><th>跟进成员</th><th>最后互动</th><th>未互动</th><th>依据</th><th>备注</th></tr></thead>
                    <tbody>
                      {rows.slice(0, 300).map((r) => (
                        <tr key={r.key}>
                          <td><span className={`ch-lv ${r.level === '高危' ? 'high' : r.level === '预警' ? 'warn' : 'watch'}`}>{r.level}</span>{r.important && <span className="ch-star"> 重点</span>}</td>
                          <td>{r.name}{r.corpName ? <span className="k-muted"> · {r.corpName}</span> : null}</td>
                          <td className="k-num">{r.userid}</td><td className="k-num">{dayKey(r.lastAt)}</td><td className="k-num"><b>{r.days}</b> 天</td>
                          <td className="k-muted">{r.basis === '导入' ? '导入' : '添加时间'}</td>
                          <td className="ch-remark">{r.remark || <span className="k-muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 300 && <div className="k-muted ch-more">只显示前 300 条，导出包含全部 {rows.length} 条。</div>}
                </div>
              )}
            </>
          )}

          {tab === 'member' && (
            <div className="k-scroll ch-tablebox">
              <table className="k-table">
                <thead><tr><th>成员</th><th>客户数</th><th>高危</th><th>预警</th><th>关注</th><th>近 30 天聊天客户数</th><th>近 30 天新增客户</th></tr></thead>
                <tbody>{members.map((m) => (
                  <tr key={m.userid}><td className="k-num">{m.userid}</td><td className="k-num">{m.customers}</td><td className="k-num"><b>{m.high}</b></td><td className="k-num">{m.warn}</td><td className="k-num">{m.watch}</td>
                    <td className="k-num">{m.chat30 ?? '—'}</td><td className="k-num">{m.newContact30 ?? '—'}</td></tr>
                ))}</tbody>
              </table>
              <p className="k-help ch-more">「近 30 天」来自官方「联系客户统计」接口（截止昨天，按成员汇总的聊天客户数 chat_cnt、新增客户数 new_contact_cnt），用来对照哪些成员最近几乎没在联系客户。</p>
            </div>
          )}

          {tab === 'lost' && (lostLog.length === 0
            ? <p className="k-muted">暂时没有发现流失。官方接口不能直接查「客户删除了成员」，本工具靠对比两次同步的结果发现：下次同步时，上次有、这次没有的客户会列在这里。</p>
            : (
              <div className="k-scroll ch-tablebox">
                <table className="k-table">
                  <thead><tr><th>原跟进成员</th><th>客户（示例名仅用于演示）</th><th>备注</th><th>添加时间</th><th>发现流失</th></tr></thead>
                  <tbody>{lostLog.slice(0, 300).map((l) => <tr key={l.userid + l.externalUserid}><td className="k-num">{l.userid}</td><td>{l.name}</td><td className="ch-remark">{l.remark || <span className="k-muted">—</span>}</td><td className="k-num">{dayKey(l.createtime)}</td><td className="k-num">{dayKey(l.detectedAt)}</td></tr>)}</tbody>
                </table>
                <p className="k-help ch-more">流失 = 客户删除了成员，或成员删除了客户，两种情况接口都不再返回，无法区分。只能发现两次同步之间发生的变化。</p>
              </div>
            ))}
        </section>
      )}
      {!ready && !busy && <section className="k-panel ch-empty"><BellRing size={26} /><b>找出该跟进的客户，发现已流失的客户</b><span className="k-muted">先连接企业微信（或切到「示例数据」体验），点「同步客户」。</span></section>}
    </div>
  );
}
