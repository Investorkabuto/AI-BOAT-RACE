// 買い目の発注用テキスト（もちの「確定オーダーテキスト」形式仕様 v1）と、予算に合わせた倍率
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { orderText, scaleAmounts, type OrderRace } from '../src/lib/order-text';

const races: OrderRace[] = [
  { label: '唐津 9R', deadline: '2026-11-08T15:42:00+09:00', bets: [{ bet_type: 'sanrenpuku', combo: '1=3=4', amount: 300 }] },
  {
    label: '三国 2R', deadline: '2026-11-08T09:13:00+09:00',
    bets: [{ bet_type: 'sanrentan', combo: '1-2-3', amount: 600 }, { bet_type: 'kakurenpuku', combo: '1=2', amount: 500 }],
  },
];

describe('orderText', () => {
  it('形式仕様 v1 どおり（締切の昇順、レース内は購入の順、小計・合計はカンマ区切り、買い目行はカンマなし）', () => {
    const o = orderText('2026-11-08', races);
    expect(o.text).toBe(
      ['2026-11-08', '三国 2R 締切09:13', '3連単 1-2-3 600円', '拡連複 1=2 500円', '小計 1,100円（2点）', '唐津 9R 締切15:42', '3連複 1=3=4 300円', '小計 300円（1点）', '合計 1,400円（3点）'].join('\n'),
    );
    expect(o).toMatchObject({ original_total: 1400, total: 1400, count: 3, factor: 1 });
    expect(orderText('2026-11-08', races).text).toBe(o.text); // 同じ入力なら同じテキスト
  });

  it('予算を入れると倍率を自動で掛け、合計が予算どおりになるよう100円単位で配分する（5,000円 → 2,000円なら 0.4倍）', () => {
    const r: OrderRace[] = [{ label: '戸田 7R', deadline: '2026-11-07T13:28:00+09:00', bets: [
      { bet_type: 'sanrentan', combo: '1-3-2', amount: 1700 }, { bet_type: 'sanrentan', combo: '1-3-6', amount: 1800 },
      { bet_type: 'sanrentan', combo: '1-2-3', amount: 1300 }, { bet_type: 'sanrentan', combo: '1-6-4', amount: 100 }, { bet_type: 'sanrentan', combo: '1-4-3', amount: 100 },
    ] }];
    const o = orderText('2026-11-07', r, 2000);
    expect(o.factor).toBe(0.4);
    // 680・720・520・40・40 → 最低100円を確保して 600・700・500・100・100（計2,000）
    expect(o.text.split('\n').slice(2, 7)).toEqual(['3連単 1-3-2 600円', '3連単 1-3-6 700円', '3連単 1-2-3 500円', '3連単 1-6-4 100円', '3連単 1-4-3 100円']);
    expect(o).toMatchObject({ original_total: 5000, total: 2000, count: 5 });
  });

  it('配分: 合計は予算（100円未満切り捨て）と一致、各買い目は最低100円、端数の大きい順に足す', () => {
    expect(scaleAmounts([1000, 1000, 1000], 2000)).toEqual([700, 700, 600]);
    expect(scaleAmounts([300, 500], 1650)).toEqual([600, 1000]);
    expect(scaleAmounts([100, 2000], 10000)).toEqual([500, 9500]);
    expect(scaleAmounts([100, 100, 100], 200)).toEqual([100, 100, 100]); // 買い目の数 × 100円が予算を超えるときだけ超える
    const big = scaleAmounts([1700, 1800, 1300, 100, 100, 1200, 800, 600, 400], 7300);
    expect(big.reduce((s, a) => s + a, 0)).toBe(7300);
    expect(big.every((a) => a >= 100 && a % 100 === 0)).toBe(true);
  });

  it('買い目がなければ合計 0円（0点）だけ', () => {
    expect(orderText('2026-11-08', []).text).toBe('2026-11-08\n合計 0円（0点）');
  });
});

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');
let db: ReturnType<typeof memoryD1>;
const get = (path: string) => app.request(path, {}, { DB: db });

describe('GET /roster/{agent_id}/order', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T12:00:00+09:00'));
    db = memoryD1();
    await ensureSchema(db);
    db.raw.exec(`INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES ('a1', 'live', 'ブー', 'o', 'h', 'active', 'x', 'x');
      INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES
        ('20261108-10-02', '2026-11-08', '10', 2, '2026-11-08T09:13:00+09:00', ${Date.parse('2026-11-08T09:13:00+09:00')}, 'locked', 'x'),
        ('20261108-23-09', '2026-11-08', '23', 9, '2026-11-08T15:42:00+09:00', ${Date.parse('2026-11-08T15:42:00+09:00')}, 'scheduled', 'x');
      INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES
        ('s1', 'a1', 'live', '20261108-10-02', '2026-11-08', 'r', 'x', 1), ('s2', 'a1', 'live', '20261108-23-09', '2026-11-08', 'r', 'x', 2);
      INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, received_ms, updated_at) VALUES
        ('b1', 's1', 'a1', 'live', '20261108-10-02', '2026-11-08', 'sanrentan', '1-2-3', 600, 'locked', 1, 'x'),
        ('b2', 's2', 'a1', 'live', '20261108-23-09', '2026-11-08', 'sanrenpuku', '1=3=4', 3000, 'accepted', 2, 'x'),
        ('b3', 's2', 'a1', 'live', '20261108-23-09', '2026-11-08', 'kakurenpuku', '1=3', 2000, 'accepted', 2, 'x'),
        ('b4', 's2', 'a1', 'live', '20261108-23-09', '2026-11-08', 'tansho', '1', 900, 'cancelled', 2, 'x');`);
  });
  afterEach(() => vi.useRealTimers());

  it('既定は締切前のレースだけ。取消は含めない', async () => {
    const o = (await (await get('/roster/a1/order?date=2026-11-08')).json()) as { text: string; total: number; count: number };
    expect(o.text).toBe(['2026-11-08', '唐津 9R 締切15:42', '3連複 1=3=4 3000円', '拡連複 1=3 2000円', '小計 5,000円（2点）', '合計 5,000円（2点）'].join('\n'));
  });

  it('budget で倍率を掛ける。all=1 で締切後も含める', async () => {
    const o = (await (await get('/roster/a1/order?date=2026-11-08&budget=2000')).json()) as { text: string; factor: number; total: number };
    expect(o.factor).toBe(0.4);
    expect(o.text).toContain('3連複 1=3=4 1200円');
    expect(o.text).toContain('拡連複 1=3 800円');
    expect(o.total).toBe(2000);
    const all = (await (await get('/roster/a1/order?date=2026-11-08&all=1')).json()) as { text: string; count: number };
    expect(all.text.split('\n')[1]).toBe('三国 2R 締切09:13');
    expect(all.count).toBe(3);
  });

  it('race で1レースだけ（締切後でも出す）', async () => {
    const o = (await (await get('/roster/a1/order?date=2026-11-08&race=20261108-10-02')).json()) as { text: string; count: number; race_id: string };
    expect(o.text).toBe(['2026-11-08', '三国 2R 締切09:13', '3連単 1-2-3 600円', '小計 600円（1点）', '合計 600円（1点）'].join('\n'));
    expect(o.race_id).toBe('20261108-10-02');
    const scaled = (await (await get('/roster/a1/order?date=2026-11-08&race=20261108-23-09&budget=1000')).json()) as { text: string; total: number };
    expect(scaled.text).toContain('3連複 1=3=4 600円');
    expect(scaled.total).toBe(1000);
    expect((await get('/roster/a1/order?date=2026-11-08&race=bad')).status).toBe(400);
  });

  it('不正な予算は 400、いないAIは 404', async () => {
    expect((await get('/roster/a1/order?date=2026-11-08&budget=50')).status).toBe(400);
    expect((await get('/roster/a1/order?date=2026-11-08&budget=abc')).status).toBe(400);
    expect((await get('/roster/zz/order?date=2026-11-08')).status).toBe(404);
  });
});
