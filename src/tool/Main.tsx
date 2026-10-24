// 客户流失预警清单：连接企业微信 → 同步客户 → （可选）导入最后互动时间 → 按天数分级的跟进清单 / 按成员汇总 / 已流失客户 → 导出 CSV。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, Loader2, RefreshCw, Users } from 'lucide-react';
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

  const total = cnt('高危') + cnt('预警') + cnt('关注');
  const pct = (n: number) => (total ? `${(n / total) * 100}%` : '0%');
  const lvClass = (l: Level) => (l === '高危' ? 'high' : l === '预警' ? 'warn' : 'watch');

  return (
    <div className="ch-root">
      <div className="ch-top">
        <SourceSwitch conn={conn} disabled={busy} />
        {conn.source === 'demo' && <span className="k-help">示例数据：虚构的企业、成员和客户</span>}
        <span className="ch-grow" />
        <button className="k-btn primary" disabled={busy || !conn.ready} onClick={() => void sync()}>{busy ? <Loader2 size={15} className="k-spin" /> : ready ? <RefreshCw size={15} /> : <Users size={15} />}{ready ? '重新同步' : '同步客户'}</button>
      </div>
      {conn.source === 'wecom' && <SetupPanel conn={conn} open={setupOpen || !conn.ready} setOpen={setSetupOpen} onMsg={setNotice} />}
      {busy && <div className="ch-progress"><Loader2 size={15} className="k-spin" />{progress || '处理中…'}<button className="k-btn" onClick={() => stop.current?.abort()}>停止</button></div>}
      {notice && <div className={`k-notice ${notice.kind}`} role="status">{notice.text}</div>}

      {!ready && !busy && (
        <section className="ch-empty">
          <svg className="ch-art" viewBox="0 0 360 120" role="img" aria-label="客户按未互动天数分成关注、预警、高危三档">
            <rect x="8" y="48" width="344" height="24" rx="12" fill="var(--chip)" />
            <rect x="8" y="48" width="120" height="24" rx="12" fill="var(--primary-soft)" />
            <rect x="128" y="48" width="110" height="24" fill="var(--warn-soft)" />
            <rect x="238" y="48" width="114" height="24" rx="12" fill="var(--err-soft)" />
            <circle cx="128" cy="60" r="7" fill="var(--warn)" /><circle cx="238" cy="60" r="7" fill="var(--err)" />
            <text x="68" y="100" textAnchor="middle" fontSize="13" fill="var(--muted)">14 天 关注</text>
            <text x="183" y="100" textAnchor="middle" fontSize="13" fill="var(--muted)">30 天 预警</text>
            <text x="295" y="100" textAnchor="middle" fontSize="13" fill="var(--muted)">60 天 高危</text>
            <text x="8" y="30" fontSize="13" fill="var(--ink)">客户越久没互动，越靠右</text>
          </svg>
          <b>把「很久没聊」的客户挑出来，排好先后顺序</b>
          <span className="k-muted">连接企业微信（或切到「示例数据」体验），点右上角「同步客户」。再次同步时，和上次对比还能发现已流失的客户。</span>
        </section>
      )}

      {ready && (
        <>
          <section className="ch-hero">
            <div className="ch-big"><b className="k-num">{thErr ? '—' : total}</b><span>位客户该跟进了</span></div>
            <div className="ch-hero-r">
              <div className="ch-stack" aria-hidden="true">
                <i className="high" style={{ width: pct(cnt('高危')) }} /><i className="warn" style={{ width: pct(cnt('预警')) }} /><i className="watch" style={{ width: pct(cnt('关注')) }} />
              </div>
              <div className="ch-legend">
                {LEVELS.map((l) => <button key={l} className={`ch-kpi ${lvClass(l)}${levelPick === l ? ' on' : ''}`} onClick={() => { setTab('list'); setLevelPick(levelPick === l ? '' : l); }} aria-pressed={levelPick === l}><span>{l}</span><b className="k-num">{thErr ? '—' : cnt(l)}</b></button>)}
                <span className="k-help">共 {users.length} 位成员、{rels.length} 条客户关系</span>
              </div>
            </div>
          </section>

          <section className="k-panel ch-card">
            <div className="ch-hd"><b>预警标尺</b><span className="k-help">未互动天数达到下面的天数，就进入对应档位</span></div>
            <div className="ch-ruler">
              {([['watch', '关注'], ['warn', '预警'], ['high', '高危']] as const).map(([k, l]) => (
                <label key={k} className={`ch-num ${k}`}><span className={`ch-lv ${k}`}>{l}</span><span>满</span><input className="k-input" type="number" min={1} max={3650} value={thresholds[k]} aria-label={`${l}天数`} onChange={(e) => setTh(k, e.target.value)} /><span>天</span></label>
              ))}
            </div>
            <div className="ch-rules">
              <select className="k-input ch-sel" aria-label="跟进成员" value={memberPick} onChange={(e) => setMemberPick(e.target.value)}><option value="">全部成员</option>{users.map((u) => <option key={u} value={u}>{u}</option>)}</select>
              <input className="k-input ch-kw" aria-label="重点客户关键词" value={keywords} placeholder="重点客户关键词（备注或描述里含有就标「重点」，用顿号隔开）" onChange={(e) => { setKeywords(e.target.value); persist({ keywords: e.target.value }); }} />
            </div>
            {thErr && <p className="ch-bad">{thErr}</p>}
            <div className={`ch-import${hover ? ' hover' : ''}`}>
              <FileUp size={16} />
              <span>可选：导入「最后互动时间表」（CSV，需含「客户 ID」或「客户名称」和「最后互动时间」）；没导入就按<b>添加时间</b>估算。</span>
              <span className="ch-grow" />
              {imported && <span className="k-st ok">{imported}</span>}
              <button className="k-btn" disabled={busy} onClick={() => void pick()}>选择文件</button>
              {interactions.size > 0 && <button className="k-btn ghost" onClick={() => { setInteractions(new Map()); setImported(''); persist({ interactions: [] }); }}>清除导入</button>}
            </div>
          </section>

          {!thErr && (
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
                  {estimated > 0 && <p className="k-help">{estimated} 位是按添加时间估算的（没有导入互动时间）：这些客户可能其实一直在聊天，请结合备注判断，或导入互动时间表。</p>}
                  {rows.length === 0 ? <p className="k-muted">没有达到条件的客户。</p> : (
                    <ul className="ch-rows">
                      {rows.slice(0, 200).map((r) => (
                        <li key={r.key} className={`ch-row ${lvClass(r.level)}`}>
                          <div className="ch-days"><b className="k-num">{r.days}</b><span>天未互动</span></div>
                          <div className="ch-who">
                            <div className="ch-name"><b>{r.name}</b>{r.corpName ? <span className="k-muted"> · {r.corpName}</span> : null}<span className={`ch-lv ${lvClass(r.level)}`}>{r.level}</span>{r.important && <span className="ch-star">重点</span>}</div>
                            <div className="ch-remark">{r.remark || r.description || <span className="k-muted">没有备注</span>}</div>
                          </div>
                          <div className="ch-meta"><span className="k-num">{r.userid}</span><span className="k-muted k-num">{dayKey(r.lastAt)}{r.basis === '导入' ? ' · 导入' : ' · 添加时间'}</span></div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {rows.length > 200 && <div className="k-muted ch-more">只显示前 200 位，导出包含全部 {rows.length} 位。</div>}
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
                  <p className="k-help ch-more">「近 30 天」来自官方「联系客户统计」接口（截止昨天，按成员汇总的聊天客户数和新增客户数），用来对照哪些成员最近几乎没在联系客户。</p>
                </div>
              )}

              {tab === 'lost' && (lostLog.length === 0
                ? <p className="k-muted">暂时没有发现流失。官方接口不能直接查「客户删除了成员」，本工具靠对比两次同步的结果发现：下次同步时，上次有、这次没有的客户会列在这里。</p>
                : (
                  <div className="k-scroll ch-tablebox">
                    <table className="k-table">
                      <thead><tr><th>原跟进成员</th><th>客户</th><th>备注</th><th>添加时间</th><th>发现流失</th></tr></thead>
                      <tbody>{lostLog.slice(0, 300).map((l) => <tr key={l.userid + l.externalUserid}><td className="k-num">{l.userid}</td><td>{l.name}</td><td className="ch-remark">{l.remark || <span className="k-muted">—</span>}</td><td className="k-num">{dayKey(l.createtime)}</td><td className="k-num">{dayKey(l.detectedAt)}</td></tr>)}</tbody>
                    </table>
                    <p className="k-help ch-more">流失 = 客户删除了成员，或成员删除了客户，两种情况接口都不再返回，无法区分。只能发现两次同步之间发生的变化。</p>
                  </div>
                ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
