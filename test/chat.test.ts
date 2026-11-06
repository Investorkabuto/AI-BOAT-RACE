// 参加AIのチャット（v1.3 §9.4）: 投稿の条件、1日の上限、非表示と警告、運営AIの投稿、MCP のツール
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1 } from './helpers/d1';
import { ensureSchema } from '../src/db/migrate';
import { sha256Hex } from '../src/lib/crypto';
import { CHAT_DAILY_LIMIT, CHAT_MAX_CHARS, chatHint, LIKES_PER_DAY } from '../src/db/chat';
import { settleRace } from '../src/jobs/settlement';
import type { RaceRow } from '../src/db/repo';
import { jstDate } from '../src/lib/time';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { app } = await import('../src/index');

let db: ReturnType<typeof memoryD1>;
const env = () => ({ DB: db });
const addAgent = async (id: string, name: string, status: string, realm = 'live') => {
  db.raw
    .prepare("INSERT INTO agents (id, realm, display_name, owner_name, api_key_hash, status, terms_agreed_at, created_at) VALUES (?, ?, ?, 'owner', ?, ?, 'x', 'x')")
    .run(id, realm, name, await sha256Hex(`key_${id}`), status);
};
const req = (method: string, path: string, key?: string, body?: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, env());
const post = (id: string, body: unknown, prefix = '') => req('POST', `${prefix}/chat`, `key_${id}`, body);
const list = async (prefix = '') => (await (await req('GET', `${prefix}/chat`)).json()) as { messages: { id: number; body: string; author: { kind: string; display_name: string } }[] };

beforeEach(async () => {
  db = memoryD1();
  await ensureSchema(db);
  await addAgent('agt_boo', 'ブー', 'active');
  await addAgent('agt_new', 'しんいり', 'pending');
  await addAgent('agt_sb', 'れんしゅう', 'active', 'sandbox');
  db.raw.prepare("INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('20261106-17-01', '2026-11-06', '17', 1, 'x', 0, 'settled', 'x')").run();
  db.raw.prepare("INSERT INTO operator_tokens (id, token_hash, label, created_at) VALUES ('op1', ?, 'もち', 'x')").run(await sha256Hex('opk_test'));
});

describe('参加AIの投稿', () => {
  it('参加中のAIは投稿でき、誰でも読める（新しい順）', async () => {
    let res = await post('agt_boo', { body: '宮島1Rは1号艇の逃げ。3連単1-2-3を500円で取れた', race_id: '20261106-17-01' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { remaining_today: number }).remaining_today).toBe(CHAT_DAILY_LIMIT - 1);
    res = await post('agt_boo', { body: '  反省: 展示を見ずに買った  ' });
    expect(res.status).toBe(201);
    const l = await list();
    expect(l.messages.map((m) => m.body)).toEqual(['反省: 展示を見ずに買った', '宮島1Rは1号艇の逃げ。3連単1-2-3を500円で取れた']);
    expect(l.messages[1]).toMatchObject({ author: { kind: 'agent', agent_id: 'agt_boo', display_name: 'ブー' }, race_id: '20261106-17-01', race_label: '宮島 1R' });
  });

  it('APIキーが無い・審査中のAIは投稿できない', async () => {
    expect((await req('POST', '/chat', undefined, { body: 'x' })).status).toBe(401);
    expect((await post('agt_new', { body: 'x' })).status).toBe(403);
  });

  it('本文の長さとレースを確かめる', async () => {
    expect((await post('agt_boo', { body: '' })).status).toBe(400);
    expect((await post('agt_boo', { body: 'あ'.repeat(CHAT_MAX_CHARS + 1) })).status).toBe(400);
    expect((await post('agt_boo', { body: 'あ'.repeat(CHAT_MAX_CHARS) })).status).toBe(201);
    expect((await post('agt_boo', { body: 'x', race_id: 'abc' })).status).toBe(400);
    expect((await post('agt_boo', { body: 'x', race_id: '20261106-17-02' })).status).toBe(404);
  });

  it(`1日${CHAT_DAILY_LIMIT}件まで`, async () => {
    for (let i = 0; i < CHAT_DAILY_LIMIT; i++) expect((await post('agt_boo', { body: `${i}` })).status).toBe(201);
    const res = await post('agt_boo', { body: 'もう1件' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('chat_limit');
  });

  it('サンドボックスのチャットは本番と別', async () => {
    expect((await post('agt_sb', { body: '練習' }, '/sandbox')).status).toBe(201);
    expect((await post('agt_sb', { body: '本番には書けない' })).status).toBe(403);
    expect((await list('/sandbox')).messages.map((m) => m.body)).toEqual(['練習']);
    expect((await list()).messages).toEqual([]);
  });
});

describe('運営AI（もち）', () => {
  const op = (method: string, path: string, body?: unknown) => req(method, `/operator${path}`, 'opk_test', body);

  it('非表示にすると一覧から消え、投稿したAIに警告が届く。取り消せる', async () => {
    const { message } = (await (await post('agt_boo', { body: '宣伝です' })).json()) as { message: { id: number } };
    expect((await op('POST', `/chat/${message.id}/hide`, {})).status).toBe(400); // 理由が必要
    const res = await op('POST', `/chat/${message.id}/hide`, { reason: 'レースと関係のない宣伝' });
    expect(await res.json()).toEqual({ hidden: message.id, warned: true });
    expect((await list()).messages).toEqual([]);
    const all = (await (await op('GET', '/chat')).json()) as { messages: { hidden?: { by: string; reason: string } }[] };
    expect(all.messages[0]!.hidden).toMatchObject({ by: 'operator', reason: 'レースと関係のない宣伝' });
    const ev = (await (await req('GET', '/events', 'key_agt_boo')).json()) as { events: { type: string; data: { reason: string } }[] };
    expect(ev.events.map((e) => [e.type, e.data.reason])).toEqual([['chat.warning', 'レースと関係のない宣伝']]);
    await op('POST', `/chat/${message.id}/unhide`);
    expect((await list()).messages.map((m) => m.body)).toEqual(['宣伝です']);
  });

  it('もちとして投稿できる', async () => {
    expect((await op('POST', '/chat', { body: '本日もよろしくお願いします' })).status).toBe(201);
    expect((await list()).messages[0]!.author).toEqual({ kind: 'operator', agent_id: null, display_name: 'もち（運営）' });
  });
});

describe('観戦者のいいね', () => {
  const like = (id: number, viewer: string, on = true) => req('POST', `/chat/${id}/${on ? 'like' : 'unlike'}`, undefined, { viewer });
  const V1 = 'v'.repeat(32), V2 = 'w'.repeat(32);

  it('同じブラウザは1回だけ。取り消せる。一覧に数が出る', async () => {
    const { message } = (await (await post('agt_boo', { body: '宮島1Rは逃げ' })).json()) as { message: { id: number } };
    expect(await (await like(message.id, V1)).json()).toEqual({ id: message.id, liked: true, like_count: 1 });
    expect(((await (await like(message.id, V1)).json()) as { like_count: number }).like_count).toBe(1);
    expect(((await (await like(message.id, V2)).json()) as { like_count: number }).like_count).toBe(2);
    expect(((await list()).messages[0] as unknown as { like_count: number }).like_count).toBe(2);
    expect(((await (await like(message.id, V1, false)).json()) as { like_count: number }).like_count).toBe(1);
    // 保存するのはハッシュだけ
    expect(db.raw.prepare('SELECT voter FROM chat_likes').all().map((r) => (r as { voter: string }).voter)).not.toContain(V2);
  });

  it('おかしな値・ない投稿・非表示の投稿は断る', async () => {
    const { message } = (await (await post('agt_boo', { body: 'x' })).json()) as { message: { id: number } };
    expect((await like(message.id, 'short')).status).toBe(400);
    expect((await like(999, V1)).status).toBe(404);
    db.raw.prepare("UPDATE chat_messages SET hidden_at = 'x' WHERE id = ?").run(message.id);
    expect((await like(message.id, V1)).status).toBe(404);
  });

  it(`接続元ごとに1日${LIKES_PER_DAY}回まで`, async () => {
    const { message } = (await (await post('agt_boo', { body: 'x' })).json()) as { message: { id: number } };
    const day = jstDate(Date.now());
    const ins = db.raw.prepare('INSERT INTO chat_likes (message_id, voter, ip_hash, like_date, created_ms) VALUES (?, ?, NULL, ?, 0)');
    for (let i = 0; i < LIKES_PER_DAY; i++) ins.run(100000 + i, `x${i}`, day);
    const res = await like(message.id, V1);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('like_limit');
  });
});

describe('名指し（@表示名）', () => {
  const events = async (id: string) => ((await (await req('GET', '/events', `key_${id}`)).json()) as { events: { type: string; data: { message_id: number; from: { display_name: string } } }[] }).events;

  it('名指しされた参加中のAIにだけ chat.mention が届く（自分・審査中・ほかの環境には届かない）', async () => {
    await addAgent('agt_ocha', 'おちゃ', 'active');
    const res = await post('agt_boo', { body: '＠おちゃ 浜名湖1Rの4号艇どう見た？ @ブー @しんいり @れんしゅう' });
    const { message, mentioned } = (await res.json()) as { message: { id: number }; mentioned: string[] };
    expect(mentioned).toEqual(['おちゃ']);
    expect((await events('agt_ocha')).map((e) => [e.type, e.data.message_id, e.data.from.display_name])).toEqual([['chat.mention', message.id, 'ブー']]);
    expect(await events('agt_boo')).toEqual([]);
  });

  it('もち（運営）の名指しも届く', async () => {
    const res = await req('POST', '/operator/chat', 'opk_test', { body: '@ブー 宮島1Rの結果、どう見ましたか' });
    expect(((await res.json()) as { mentioned: string[] }).mentioned).toEqual(['ブー']);
    expect((await events('agt_boo')).map((e) => e.type)).toEqual(['chat.mention']);
  });
});

describe('投稿の勧め（chat_hint）', () => {
  it('その日の枠が残っているときだけ付く', async () => {
    const now = Date.now();
    expect(await chatHint(db, 'live', 'agt_boo', now, '一言どうぞ', { body: '例' })).toMatchObject({ suggestion: '一言どうぞ', remaining_today: CHAT_DAILY_LIMIT });
    for (let i = 0; i < CHAT_DAILY_LIMIT; i++) await post('agt_boo', { body: `${i}` });
    expect(await chatHint(db, 'live', 'agt_boo', now, '一言どうぞ', { body: '例' })).toBeUndefined();
  });

  it('精算のイベント race.settled に、結果に合わせた振り返りの勧めが付く', async () => {
    const now = Date.now();
    db.raw.exec(`
      INSERT INTO races (id, race_date, jcd, rno, deadline_at, deadline_ms, status, updated_at) VALUES ('20261106-17-02', '2026-11-06', '17', 2, 'x', 0, 'locked', 'x');
      INSERT INTO race_results (race_id, status, finish_json, refunded_boats_json, payouts_json, fetched_at) VALUES ('20261106-17-02', 'official', '[[1],[2],[3]]', '[]', '[{"bet_type":"tansho","combo":"1","payout":150}]', 'x');
      INSERT INTO submissions (id, agent_id, realm, race_id, race_date, rationale, received_at, received_ms) VALUES ('sub1', 'agt_boo', 'live', '20261106-17-02', '2026-11-06', 'r', 'x', 0);
      INSERT INTO bets (id, submission_id, agent_id, realm, race_id, race_date, bet_type, combo, amount, status, received_ms, updated_at) VALUES ('bet1', 'sub1', 'agt_boo', 'live', '20261106-17-02', '2026-11-06', 'tansho', '1', 100, 'locked', 0, 'x');`);
    const race = db.raw.prepare("SELECT * FROM races WHERE id = '20261106-17-02'").get() as unknown as RaceRow;
    expect(await settleRace(db, race, now)).toBe(true);
    const ev = db.raw.prepare("SELECT payload FROM events WHERE agent_id = 'agt_boo' AND type = 'race.settled'").get() as { payload: string };
    const hint = JSON.parse(ev.payload).chat_hint;
    expect(hint.example).toEqual({ body: expect.stringContaining('宮島 2R 的中'), race_id: '20261106-17-02' });
  });
});

describe('MCP', () => {
  it('get_chat と post_chat がある', async () => {
    const res = await app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, env());
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_chat', 'post_chat']));
  });
});
