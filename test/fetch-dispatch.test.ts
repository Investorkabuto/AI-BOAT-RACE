import { describe, expect, it } from 'vitest';
import { dueDispatches } from '../src/jobs/fetch-dispatch';

const at = (iso: string) => Date.parse(iso);
const none = new Set<string>();
const due = (nowIso: string, done: Iterable<string> = none, extra: { lastResultsMs?: number; pendingResults?: number } = {}) =>
  dueDispatches({ nowMs: at(nowIso), done: new Set(done), lastResultsMs: extra.lastResultsMs ?? 0, pendingResults: extra.pendingResults ?? 0 });

// 当日朝の番組表（B）と、前日分の競走成績（K）の確認は済んでいるものとして、出走表（HTML）だけを見たいテスト用
const CARDS_0700 = 'fetch:cards:2026-11-05:07:00';
const RECORDS_0630 = 'fetch:records:2026-11-04:06:30';

describe('dueDispatches（取得の起動）', () => {
  it('7:30 より前は出走表を起動しない', () => {
    expect(due('2026-11-05T07:25:00+09:00', ['fetch:results-all:2026-11-05', CARDS_0700, RECORDS_0630])).toEqual([]);
  });
  it('6:00 に前日の全レースの結果を1回だけ起動する', () => {
    const now = '2026-11-05T06:02:00+09:00';
    const d = due(now);
    expect(d).toEqual([{ key: 'fetch:results-all:2026-11-05', command: 'results-all', date: '2026-11-04' }]);
    expect(due('2026-11-05T06:07:00+09:00', [d[0]!.key])).toEqual([]);
  });
  it('7:30 を過ぎたら1回だけ出走表を起動する', () => {
    const base = ['fetch:results-all:2026-11-05', CARDS_0700, RECORDS_0630];
    const d = due('2026-11-05T07:31:00+09:00', base);
    expect(d).toEqual([{ key: 'fetch:schedule:2026-11-05:07:30', command: 'schedule', date: '2026-11-05' }]);
    expect(due('2026-11-05T07:36:00+09:00', [...base, d[0]!.key])).toEqual([]);
  });
  it('9:30 にもう1回。2時間を過ぎたら起動しない', () => {
    expect(due('2026-11-05T09:35:00+09:00', ['fetch:schedule:2026-11-05:07:30']).map((x) => x.key)).toEqual(['fetch:schedule:2026-11-05:09:30']);
    expect(due('2026-11-05T13:00:00+09:00')).toEqual([]);
  });
  it('結果は、結果待ちのレースがあるときだけ、10分おき', () => {
    const now = at('2026-11-05T14:00:00+09:00');
    expect(due('2026-11-05T14:00:00+09:00')).toEqual([]);
    expect(due('2026-11-05T14:00:00+09:00', none, { pendingResults: 3 })).toEqual([{ key: 'fetch:results', command: 'results' }]);
    expect(due('2026-11-05T14:00:00+09:00', none, { lastResultsMs: now - 9 * 60_000, pendingResults: 3 })).toEqual([]);
    expect(due('2026-11-05T14:00:00+09:00', none, { lastResultsMs: now - 10 * 60_000, pendingResults: 3 })).toHaveLength(1);
  });
});

describe('dueDispatches（番組表 B の取得）', () => {
  it('前日の18:00 から、翌日分を取りに行く', () => {
    expect(due('2026-11-05T17:55:00+09:00')).toEqual([]);
    expect(due('2026-11-05T18:02:00+09:00')).toEqual([{ key: 'fetch:cards:2026-11-06:18:00', command: 'cards', date: '2026-11-06' }]);
  });
  it('夕方から夜に3回（18:00・19:30・22:00）。起動済みの枠は繰り返さない', () => {
    const done = ['fetch:cards:2026-11-06:18:00'];
    const rec = 'fetch:records:2026-11-05:21:30'; // 21:30 の競走成績（K）の枠は済んでいるものとして、番組表だけを見る
    expect(due('2026-11-05T19:35:00+09:00', done).map((x) => x.key)).toEqual(['fetch:cards:2026-11-06:19:30']);
    expect(due('2026-11-05T22:10:00+09:00', [...done, rec, 'fetch:cards:2026-11-06:19:30']).map((x) => x.key)).toEqual(['fetch:cards:2026-11-06:22:00']);
    expect(due('2026-11-05T22:10:00+09:00', [...done, rec, 'fetch:cards:2026-11-06:19:30', 'fetch:cards:2026-11-06:22:00'])).toEqual([]);
  });
  it('夕方の枠は2時間の間だけ。日付が変わった後に、前日の枠を起動し直さない', () => {
    expect(due('2026-11-06T00:10:00+09:00')).toEqual([]);
    // 18:00 の枠は 20:00 で終わるが、19:30 の枠がまだ続いているので、見に行くのは19:30の枠
    expect(due('2026-11-05T20:05:00+09:00', ['fetch:cards:2026-11-06:18:00']).map((x) => x.key)).toEqual(['fetch:cards:2026-11-06:19:30']);
  });
  it('当日の朝 7:00 に、当日分を取りに行く（差し替えの確認）', () => {
    const resultsAll = ['fetch:results-all:2026-11-06', 'fetch:records:2026-11-05:06:30']; // 6:00 の前日分の結果と、6:30 の前日分の競走成績は済んでいるものとする
    expect(due('2026-11-06T07:05:00+09:00', resultsAll)).toEqual([{ key: 'fetch:cards:2026-11-06:07:00', command: 'cards', date: '2026-11-06' }]);
    expect(due('2026-11-06T07:05:00+09:00', [...resultsAll, 'fetch:cards:2026-11-06:07:00'])).toEqual([]);
  });
  it('番組表の枠の記録キーは、出走表（HTML）の枠と重ならない', () => {
    const keys = due('2026-11-05T07:31:00+09:00', ['fetch:results-all:2026-11-05', RECORDS_0630]).map((x) => x.key);
    expect(keys.sort()).toEqual(['fetch:cards:2026-11-05:07:00', 'fetch:schedule:2026-11-05:07:30']);
  });
});

describe('dueDispatches（過去分）', () => {
  it('毎晩の起動はしない（2026-11-07 にやめた。過去データはもち側が持つ）', () => {
    expect(due('2026-11-06T02:03:00+09:00').filter((x) => x.command === 'history')).toEqual([]);
  });
});

describe('dueDispatches（競走成績 K の取得）', () => {
  it('当日の 21:30 に当日分、23:20 にもう1回。起動済みの枠は繰り返さない', () => {
    // 夕方からの番組表（翌日分）の枠は済んでいるものとして、競走成績だけを見る
    const cards = ['fetch:cards:2026-11-06:18:00', 'fetch:cards:2026-11-06:19:30', 'fetch:cards:2026-11-06:22:00'];
    expect(due('2026-11-05T21:25:00+09:00', cards)).toEqual([]);
    const d = due('2026-11-05T21:32:00+09:00', cards);
    expect(d).toEqual([{ key: 'fetch:records:2026-11-05:21:30', command: 'records', date: '2026-11-05' }]);
    expect(due('2026-11-05T21:37:00+09:00', [...cards, d[0]!.key])).toEqual([]);
    expect(due('2026-11-05T23:21:00+09:00', [...cards, d[0]!.key]).map((x) => x.key)).toEqual(['fetch:records:2026-11-05:23:20']);
  });
  it('翌朝 6:30 に前日分を取り直す（取り残しの確認）。日付をまたいだ後は、23:20 の枠を起動し直さない', () => {
    expect(due('2026-11-06T00:10:00+09:00')).toEqual([]);
    const d = due('2026-11-06T06:32:00+09:00', ['fetch:results-all:2026-11-06']);
    expect(d).toEqual([{ key: 'fetch:records:2026-11-05:06:30', command: 'records', date: '2026-11-05' }]);
  });
});
