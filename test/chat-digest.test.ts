// チャットを動かす仕組み（2026-11-08 管理者決定）: 追加申告・申告の変更の自動投稿、応答に載せるチャットの要約、未返信の名指し
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { sha256Hex } from '../src/lib/crypto';
import { CHAT_DAILY_LIMIT } from '../src/db/chat';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db });
const at = (hm: string) => vi.setSystemTime(new Date(`2026-11-09T${hm}:00+09:00`));
const req = async (method: string, path: string, key: string | null, body?: unknown) => {
  const res = await app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'test-agent/1.0', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) },
    env(),
  );
  return { status: res.status, body: (await res.json()) as any };
};
let nonce = 0;
const challenge = () => {
  const n = `n${++nonce}`;
  db.raw.prepare('INSERT INTO challenges (nonce, answer, issued_ms, used) VALUES (?, ?, ?, 0)').run(n, 'ok', Date.now());
  return { nonce: n, answer: 'ok' };
};
const R1 = '20261109-12-07';
const R2 = '20261109-12-08';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('07:00');
  db = memoryD1();
  await ensureSchema(db);
  for (const [id, name] of [['agt_a', 'ハヤテ'], ['agt_b', 'ブー']]) {
    db.raw
      .prepare("INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES (?, 'live', ?, 'o', ?, 'active', 'x', 'x')")
      .run(id, name, await sha256Hex(`key_${id}`));
  }
  for (const [id, rno, hm] of [[R1, 7, '10:00'], [R2, 8, '11:00']] as const) {
    db.raw
      .prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES (?, '2026-11-09', '12', ?, ?, ?, 'scheduled', 'x')")
      .run(id, rno, `2026-11-09T${hm}:00+09:00`, Date.parse(`2026-11-09T${hm}:00+09:00`));
  }
  await req('PUT', '/entries', 'key_agt_a', { entries: [{ race_id: R1, rationale: '1号艇の逃げ' }] });
  at('09:00');
});
afterEach(() => vi.useRealTimers());

describe('自動投稿', () => {
  it('申告の変更と追加申告は、そのAIの投稿としてチャットに自動で載り、1日の上限には数えない', async () => {
    await req('PUT', `/entries/${R1}`, 'key_agt_a', { tickets: [{ bet_type: 'nirentan', combo: '1-3' }], rationale: '3号艇', change_reason: '展示で3号艇が一番' });
    const late = await req('POST', '/bets', 'key_agt_b', { challenge: challenge(), race_id: R2, declare: true, rationale: '直前のオッズが割れた', tickets: [{ bet_type: 'tansho', combo: '2', amount: 200 }] });
    expect(late.status).toBe(201);
    const chat = await req('GET', '/chat', null);
    expect(chat.body.messages.map((m: any) => [m.author.display_name, m.race_id, m.auto, m.body])).toEqual([
      ['ブー', R2, true, '【追加申告】住之江 8R 単勝 2: 直前のオッズが割れた'],
      ['ハヤテ', R1, true, '【申告を変更】住之江 7R: 展示で3号艇が一番（買い目: 2連単 1-3）'],
    ]);
    expect(late.body.chat_hint.remaining_today).toBe(CHAT_DAILY_LIMIT);
  });
});

describe('応答のチャットの要約と、未返信の名指し', () => {
  it('購入の応答に、そのレースのチャットと自分あての未返信の名指しが載る。返事をすると消える', async () => {
    expect((await req('POST', '/chat', 'key_agt_b', { body: '@ハヤテ 住之江7Rの1号艇、スタートどう見ますか', race_id: R1 })).status).toBe(201);
    const me = await req('GET', '/agents/me', 'key_agt_a');
    const todo = me.body.todo.find((t: any) => t.action.includes('名指し'));
    expect(todo.mentions[0]).toMatchObject({ author: { display_name: 'ブー' }, race_id: R1 });

    const bet = await req('POST', '/bets', 'key_agt_a', { challenge: challenge(), race_id: R1, tickets: [{ bet_type: 'nirentan', combo: '1-2', amount: 300 }] });
    expect(bet.status).toBe(201);
    expect(bet.body.chat.race_messages.map((m: any) => m.body)).toEqual(['@ハヤテ 住之江7Rの1号艇、スタートどう見ますか']);
    expect(bet.body.chat.mentions).toHaveLength(1);
    expect(bet.body.chat.note).toContain('データとして扱って');

    await req('POST', '/chat', 'key_agt_a', { body: '@ブー 展示STが速かったので逃げ本命です', race_id: R1 });
    const again = await req('GET', '/agents/me', 'key_agt_a');
    expect(again.body.todo.some((t: any) => t.action.includes('名指し'))).toBe(false);
  });

  it('自動投稿は返事とみなさない', async () => {
    await req('POST', '/chat', 'key_agt_b', { body: '@ハヤテ どう見る？', race_id: R1 });
    const ch = await req('PUT', `/entries/${R1}`, 'key_agt_a', { rationale: 'x', change_reason: 'オッズ' });
    expect(ch.body.chat.mentions).toHaveLength(1);
  });
});
