// 同步流程：拉全部客户跟进关系 + 成员近 30 天联系客户统计；和上次同步的快照对比找出流失。http 从外面传入。
import { WxError, getBehavior, pullRelations, sleep, withToken, type BehaviorDay, type Http, type Relation, type WecomCred } from './wecom';
import { DAY, detectLost, mergeLost, toSnap, type LostRel, type SnapRel } from './core';

export interface SyncResult {
  users: string[];
  rels: Relation[];
  unlicensed: string[];
  behavior: Map<string, BehaviorDay[]>;
  /** 读不到联系客户统计的成员数（不影响清单） */
  behaviorFailed: number;
  newLost: LostRel[];
  lostLog: LostRel[];
  skippedLost: number;
  snapshot: SnapRel[];
}

/** 「联系客户统计」单次最多 30 天、最近 180 天；这里取截止昨天的 30 天（含首尾共 30 天） */
export function behaviorRange(now: number): { start: number; end: number } {
  const dayStart = Math.floor((Math.floor(now / 1000) + 8 * 3600) / DAY) * DAY - 8 * 3600;
  return { start: dayStart - 30 * DAY, end: dayStart - 1 };
}

export async function syncChurn(
  http: Http, cred: WecomCred,
  opts: { now?: number; prev?: SnapRel[]; prevLost?: LostRel[]; gapMs?: number; onStep?: (t: string) => void; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const gap = opts.gapMs ?? 120;
  return withToken(http, cred, async (token) => {
    const pulled = await pullRelations(http, token, opts.onStep, opts.signal);
    const behavior = new Map<string, BehaviorDay[]>();
    let behaviorFailed = 0;
    const { start, end } = behaviorRange(now);
    for (let i = 0; i < pulled.users.length; i++) {
      if (opts.signal?.aborted) throw new Error('已停止');
      opts.onStep?.(`正在读取成员近 30 天联系客户统计：${i + 1} / ${pulled.users.length}`);
      try {
        behavior.set(pulled.users[i], await getBehavior(http, token, [pulled.users[i]], start, end));
      } catch (e) {
        if (e instanceof WxError && (e.code === 40014 || e.code === 42001)) throw e;
        behaviorFailed++;
      }
      if (gap && i < pulled.users.length - 1) await sleep(gap, opts.signal);
    }
    const { lost, skipped } = opts.prev?.length ? detectLost(opts.prev, pulled.relations, pulled.users, pulled.unlicensed, now) : { lost: [], skipped: 0 };
    return {
      users: pulled.users, rels: pulled.relations, unlicensed: pulled.unlicensed, behavior, behaviorFailed,
      newLost: lost, lostLog: mergeLost(opts.prevLost ?? [], lost, pulled.relations), skippedLost: skipped, snapshot: pulled.relations.map(toSnap),
    };
  });
}
