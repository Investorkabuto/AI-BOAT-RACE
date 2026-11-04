import { describe, expect, it } from 'vitest';
import { dueDispatches } from '../src/jobs/fetch-dispatch';

const at = (iso: string) => Date.parse(iso);
const none = new Set<string>();

describe('dueDispatches（取得の起動）', () => {
  it('7:30 より前は出走表を起動しない', () => {
    expect(dueDispatches({ nowMs: at('2026-11-05T07:25:00+09:00'), done: none, lastResultsMs: 0, pendingResults: 0 })).toEqual([]);
  });
  it('7:30 を過ぎたら1回だけ出走表を起動する', () => {
    const now = at('2026-11-05T07:31:00+09:00');
    const d = dueDispatches({ nowMs: now, done: none, lastResultsMs: 0, pendingResults: 0 });
    expect(d).toEqual([{ key: 'fetch:schedule:2026-11-05:07:30', command: 'schedule', date: '2026-11-05' }]);
    expect(dueDispatches({ nowMs: now + 5 * 60_000, done: new Set([d[0]!.key]), lastResultsMs: 0, pendingResults: 0 })).toEqual([]);
  });
  it('9:30 にもう1回。2時間を過ぎたら起動しない', () => {
    const done = new Set(['fetch:schedule:2026-11-05:07:30']);
    expect(dueDispatches({ nowMs: at('2026-11-05T09:35:00+09:00'), done, lastResultsMs: 0, pendingResults: 0 }).map((x) => x.key)).toEqual(['fetch:schedule:2026-11-05:09:30']);
    expect(dueDispatches({ nowMs: at('2026-11-05T20:00:00+09:00'), done: none, lastResultsMs: 0, pendingResults: 0 })).toEqual([]);
  });
  it('結果は、結果待ちのレースがあるときだけ、10分おき', () => {
    const now = at('2026-11-05T14:00:00+09:00');
    expect(dueDispatches({ nowMs: now, done: none, lastResultsMs: 0, pendingResults: 0 })).toEqual([]);
    expect(dueDispatches({ nowMs: now, done: none, lastResultsMs: 0, pendingResults: 3 })).toEqual([{ key: 'fetch:results', command: 'results' }]);
    expect(dueDispatches({ nowMs: now, done: none, lastResultsMs: now - 9 * 60_000, pendingResults: 3 })).toEqual([]);
    expect(dueDispatches({ nowMs: now, done: none, lastResultsMs: now - 10 * 60_000, pendingResults: 3 })).toHaveLength(1);
  });
});
