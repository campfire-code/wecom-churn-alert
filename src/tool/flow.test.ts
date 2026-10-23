// 同步流程：录制格式的应答 + 模拟企业；不访问网络。
import { beforeEach, describe, expect, it } from 'vitest';
import { behaviorRange, syncChurn } from './flow';
import { MOCK_CORP, createMockWecom } from './mock';
import { toSnap } from './core';
import { clearTokenCache, type Http } from './wecom';

const NOW = Date.UTC(2026, 9, 23, 2, 0);
beforeEach(() => clearTokenCache());

describe('同步', () => {
  it('取客户并按成员取近 30 天联系客户统计；日期范围不超过 30 天', async () => {
    const m = createMockWecom(NOW, { count: 40 });
    const r = await syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0 });
    expect(r.rels).toHaveLength(41);
    expect([...r.behavior.keys()]).toEqual(r.users);
    const calls = m.calls.filter((c) => c.url.includes('get_user_behavior_data'));
    expect(calls).toHaveLength(4);
    const b = calls[0].body as { userid: string[]; start_time: number; end_time: number };
    expect(b.userid).toHaveLength(1);
    expect(b.end_time - b.start_time).toBeLessThan(30 * 86400);
    const { end } = behaviorRange(NOW);
    expect(end).toBeLessThan(Math.floor(NOW / 1000));
    expect(r.newLost).toEqual([]);
  });
  it('和上次快照对比发现流失，并累计到历史记录', async () => {
    const m = createMockWecom(NOW, { count: 20 });
    const r1 = await syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0 });
    const gone = { ...toSnap(r1.rels[0]), externalUserid: 'wmGONE9', name: '示例客户' };
    const r2 = await syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0, prev: [...r1.snapshot, gone] });
    expect(r2.newLost.map((l) => l.externalUserid)).toEqual(['wmGONE9']);
    const r3 = await syncChurn(m.http, MOCK_CORP, { now: NOW + 86400_000, gapMs: 0, prev: r2.snapshot, prevLost: r2.lostLog });
    expect(r3.newLost).toEqual([]);
    expect(r3.lostLog.map((l) => l.externalUserid)).toEqual(['wmGONE9']);
  });
  it('第一次同步（没有快照）不报流失', async () => {
    const m = createMockWecom(NOW, { count: 5 });
    expect((await syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0, prev: [] })).newLost).toEqual([]);
  });
  it('联系客户统计读不到时不影响清单；权限不足的错误会报出', async () => {
    const m = createMockWecom(NOW, { count: 5 });
    const http: Http = async (url, init) => url.includes('get_user_behavior_data') ? { status: 200, text: async () => '{"errcode":60011,"errmsg":"no privilege"}' } : m.http(url, init);
    const r = await syncChurn(http, MOCK_CORP, { now: NOW, gapMs: 0 });
    expect(r.behaviorFailed).toBe(4);
    expect(r.rels.length).toBeGreaterThan(0);
    const denied: Http = async (url) => ({ status: 200, text: async () => url.includes('gettoken') ? '{"errcode":0,"access_token":"T","expires_in":7200}' : '{"errcode":48002,"errmsg":"api forbidden"}' });
    await expect(syncChurn(denied, MOCK_CORP, { now: NOW, gapMs: 0 })).rejects.toThrow(/可调用接口的应用/);
  });
  it('可以中途停止', async () => {
    const m = createMockWecom(NOW);
    const ac = new AbortController(); ac.abort();
    await expect(syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0, signal: ac.signal })).rejects.toThrow('已停止');
  });
});
