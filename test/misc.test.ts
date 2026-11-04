import { describe, expect, it } from 'vitest';
import { splitSql } from '../src/db/migrate';
import { jstIso, jstToMs, monthRange, parseHm } from '../src/lib/time';
import { parseRaceId, raceId } from '../src/lib/venues';

describe('race id', () => {
  it('往復できる', () => {
    expect(raceId('2026-11-04', '12', 7)).toBe('20261104-12-07');
    expect(parseRaceId('20261104-12-07')).toEqual({ date: '2026-11-04', jcd: '12', rno: 7 });
    expect(parseRaceId('20261104-25-07')).toBeNull();
    expect(parseRaceId('20261104-12-13')).toBeNull();
  });
});

describe('time', () => {
  it('締切時刻', () => {
    const hm = parseHm('10:39')!;
    expect(jstIso(jstToMs('2026-11-04', hm.hour, hm.minute))).toBe('2026-11-04T10:39:00+09:00');
    expect(parseHm('1039')).toBeNull();
    expect(monthRange('2026-02')).toEqual({ startsOn: '2026-02-01', endsOn: '2026-02-28' });
  });
});

describe('splitSql', () => {
  it('コメントを除いて文に分ける', () => {
    expect(splitSql('-- a;\nCREATE TABLE x (a INT, -- c;\n b INT);\nCREATE INDEX i ON x (a);\n')).toEqual(['CREATE TABLE x (a INT,\n b INT)', 'CREATE INDEX i ON x (a)']);
  });
});
