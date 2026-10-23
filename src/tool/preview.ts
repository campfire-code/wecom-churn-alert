// 截图与预览用的示例数据（不会进入正式运行）。企业、成员、客户均为虚构的「示例」。
import { MOCK_CORP, createMockWecom } from './mock';
import { syncChurn } from './flow';
import { matchInteractions, parseInteractionCsv, toSnap } from './core';
import type { DemoState } from './Main';

export const rows = () => [];
export const params = {};

const NOW = Date.UTC(2026, 9, 23, 2, 0);
const m = createMockWecom(NOW, { count: 120 });
const first = await syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0 });
// 上次同步时还有 3 位后来流失的客户
const ghosts = [
  { ...toSnap(first.rels[0]), externalUserid: 'wmGONE0001', name: '示例客户甲', remark: '咨询会员卡', createtime: Math.floor(NOW / 1000) - 40 * 86400 },
  { ...toSnap(first.rels[1]), externalUserid: 'wmGONE0002', name: '示例客户乙', remark: '团购 公司下午茶', createtime: Math.floor(NOW / 1000) - 75 * 86400 },
  { ...toSnap(first.rels[2]), externalUserid: 'wmGONE0003', name: '示例客户丙', remark: '价格太贵 再看看', createtime: Math.floor(NOW / 1000) - 20 * 86400 },
];
const r = await syncChurn(m.http, MOCK_CORP, { now: NOW, gapMs: 0, prev: [...first.snapshot, ...ghosts] });
// 导入一部分客户的最后互动时间：每 3 位里 1 位在最近几天聊过
const csv = ['客户 external_userid,跟进成员,最后互动时间', ...r.rels.filter((_, i) => i % 3 === 0).map((x, i) => `${x.externalUserid},${x.userid},${new Date(NOW - (i % 5 + 1) * 86400_000 * 3).toISOString().slice(0, 10)}`)].join('\n');
const imp = matchInteractions(r.rels, parseInteractionCsv(csv).rows);
export const demo: DemoState = {
  rels: r.rels, users: r.users, behavior: r.behavior, interactions: imp.map, lost: r.lostLog, now: NOW, keywords: 'VIP、老客户、加盟',
  imported: `已保存 ${imp.map.size} 条互动时间`, notice: { kind: 'ok', text: `示例：取到 ${r.users.length} 位成员的 ${r.rels.length} 条客户关系；和上次同步对比，新发现 ${r.newLost.length} 条流失` },
};
