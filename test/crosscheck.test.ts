import { describe, expect, it } from 'vitest';
import { checkStored, crossCheck, kFinish, type HtmlResult } from '../src/lib/crosscheck';
import type { RecordPayout, RecordRow } from '../src/lib/records';

// 2026-11-04 大村1R（HTML の結果とKファイルが一致する想定）
const row = (place: number | string, boat: number, over: Partial<RecordRow> = {}): RecordRow => ({
  place, boat, toban: String(4000 + boat), motor_no: 1, boat_no: 1, tenji: 6.8, course: boat, st: 0.1, time: place === 5 || place === 6 ? null : 110, ...over,
});
const rows = (): RecordRow[] => [row(1, 1, { st: 0.03 }), row(2, 3), row(3, 6), row(4, 2, { st: 0.01 }), row(5, 4), row(6, 5)];
const pays = (): RecordPayout[] => [
  { bet_type: 'tansho', combo: '1', payout: 120, pop: null },
  { bet_type: 'sanrentan', combo: '1-3-6', payout: 1060, pop: 2 },
];
const html = (): HtmlResult => ({
  status: 'official', finish: [[1], [3], [6], [2], [4], [5]], refunded_boats: [],
  payouts: [{ bet_type: 'tansho', combo: '1', payout: 120 }, { bet_type: 'sanrentan', combo: '1-3-6', payout: 1060 }],
  start: [{ course: 1, boat: 1, st: '0.03' }, { course: 2, boat: 2, st: 'F.01' }],
});

describe('crossCheck', () => {
  it('一致すれば空', () => {
    expect(crossCheck(html(), { rows: rows(), payouts: pays() })).toEqual([]);
  });

  it('着順の違いを見つける', () => {
    const k = rows();
    [k[1], k[2]] = [{ ...k[1]!, place: 3 }, { ...k[2]!, place: 2 }];
    const d = crossCheck(html(), { rows: k, payouts: pays() });
    expect(d.map((x) => x.field)).toEqual(['finish']);
  });

  it('払戻金の違い（金額・組番・片方にだけある券種）を見つける', () => {
    const d = crossCheck(html(), { rows: rows(), payouts: [pays()[0]!, { ...pays()[1]!, payout: 1070 }] });
    expect(d).toEqual([{ field: 'payouts', html: ['sanrentan|1-3-6|1060'], k: ['sanrentan|1-3-6|1070'] }]);
    expect(crossCheck(html(), { rows: rows(), payouts: [pays()[0]!] }).map((x) => x.field)).toEqual(['payouts']);
  });

  it('返還艇: F・L・K は返還、S（失格）は返還にしない', () => {
    const k = rows().map((r) => (r.boat === 5 ? { ...r, place: 'F' as const, time: null } : r));
    const h = html();
    h.finish = [[1], [3], [6], [2], [4]];
    expect(crossCheck({ ...h, refunded_boats: [5] }, { rows: k, payouts: pays() })).toEqual([]);
    expect(crossCheck(h, { rows: k, payouts: pays() }).map((x) => x.field)).toEqual(['refunded']); // HTML に返還が無いのは食い違い
    const s = rows().map((r) => (r.boat === 5 ? { ...r, place: 'S1' as const, time: null } : r));
    expect(crossCheck({ ...h, refunded_boats: [] }, { rows: s, payouts: pays() })).toEqual([]);
  });

  it('同着は同じ要素にまとまる（順序は問わない）', () => {
    expect(kFinish([row(1, 4), row(1, 2), row(3, 1)])).toEqual([[2, 4], [1]]);
  });

  it('進入コースとSTの違い（STは0.005秒までは同じとみなす）', () => {
    const h = html();
    const k = rows().map((r) => (r.boat === 2 ? { ...r, course: 3, st: 0.01 } : r));
    expect(crossCheck(h, { rows: k, payouts: pays() }).map((x) => x.field)).toEqual(['course']); // F.01 = 0.01 は同じ
    const k2 = rows().map((r) => (r.boat === 1 ? { ...r, st: 0.1 } : r));
    expect(crossCheck(h, { rows: k2, payouts: pays() }).map((x) => x.field)).toEqual(['st']);
  });

  it('HTMLにスタート情報が無ければ、コースとSTは照合しない', () => {
    expect(crossCheck({ ...html(), start: null }, { rows: rows().map((r) => ({ ...r, course: 6 })), payouts: pays() })).toEqual([]);
  });

  it('HTMLが中止・不成立なのにKに成績があれば食い違い', () => {
    expect(crossCheck({ ...html(), status: 'cancelled' }, { rows: rows(), payouts: pays() }).map((x) => x.field)).toEqual(['status']);
  });
});

describe('checkStored', () => {
  const stored = () => ({
    result: { status: 'official', finish_json: JSON.stringify(html().finish), refunded_boats_json: '[]', payouts_json: JSON.stringify(html().payouts) },
    starts: { starts_json: JSON.stringify(html().start) },
    record: { rows: rows(), payouts: pays() },
  });
  it('保存形から照合でき、一致する', () => {
    const s = stored();
    expect(checkStored(s.result, s.starts, s.record)).toEqual([]);
  });
  it('どちらかが無ければ null（照合できない）', () => {
    const s = stored();
    expect(checkStored(undefined, s.starts, s.record)).toBeNull();
    expect(checkStored(s.result, s.starts, undefined)).toBeNull();
    expect(checkStored(s.result, undefined, s.record)).toEqual([]);
  });
});
