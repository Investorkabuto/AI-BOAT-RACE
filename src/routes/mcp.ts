// MCP サーバー（Streamable HTTP、状態を持たない JSON 応答）。
// LLMエージェントが、このゲームをツールとして直接使えるようにする入口（STOCK_GAME から移植）。
// 各ツールは同じサイトの REST API を内部で呼ぶだけなので、ルール・検証・チャレンジはREST APIと完全に同じ。
//   本番: POST /mcp      サンドボックス: POST /sandbox/mcp
//   認証: Authorization: Bearer <APIキー>（登録・課題の取得・公開情報のツールは不要）
import { Hono } from 'hono';
import type { Env, Realm } from '../env';
import { MAX_TICKETS_PER_SUBMISSION, RULES_VERSION, TACTIC_GUIDE, TACTIC_JA, TACTICS } from '../env';
import { BET_TYPE_JA, BET_TYPES } from '../lib/bets';
import { RULES_SUMMARY } from '../rules-summary';
import { ENTRY_DEADLINE_LABEL } from '../lib/entries';

type Dispatch = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolCall {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  text?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  realms?: Realm[];
  build: (args: Record<string, unknown>, prefix: string) => ToolCall;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tacticSchema = {
  type: 'string',
  enum: [...TACTICS],
  description: `作戦。${TACTICS.map((t) => `${t}=${TACTIC_JA[t]}（${TACTIC_GUIDE[t]}）`).join(' / ')}。目安は方向性の例で、具体的な券種・買い目・配分はあなた（AI）が決める`,
};
const tacticBySchema = { type: 'string', enum: ['owner', 'ai'], description: 'owner=オーナーが選んだ / ai=期限までに選ばれず、AIが決めた' };
const challengeSchema = {
  type: 'object',
  description: 'get_challenge で得た nonce と、課題の答え（30秒以内に送る）',
  properties: { nonce: { type: 'string' }, answer: { type: 'string' } },
  required: ['nonce', 'answer'],
};
const ticketsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_TICKETS_PER_SUBMISSION,
  description: '舟券（1枚ごとに1件）',
  items: {
    type: 'object',
    properties: {
      bet_type: { type: 'string', enum: [...BET_TYPES], description: BET_TYPES.map((b) => `${b}=${BET_TYPE_JA[b]}`).join(' / ') },
      combo: { type: 'string', description: '組番。艇番1〜6。着順ありは "1-2-3"、着順なしは "1=2=3"' },
      amount: { type: 'integer', description: '金額（100円単位）' },
    },
    required: ['bet_type', 'combo', 'amount'],
  },
};
const pick = (a: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const DOCS: Record<string, string> = {
  overview: '/llms.txt',
  summary: '/rules/summary',
  rules: '/agents/rules.md',
  quickstart: '/agents/quickstart.md',
  challenge: '/agents/challenge.md',
  policy: '/agents/policy.md',
  webhook: '/agents/webhook.md',
  mcp: '/agents/mcp.md',
};

const TOOLS: Tool[] = [
  {
    name: 'get_document',
    description: 'ゲームの文書を読む。最初に rules（ルール全文と参加規約）を必ず読むこと',
    inputSchema: obj({ name: { type: 'string', enum: Object.keys(DOCS) } }, ['name']),
    build: (a) => ({ method: 'GET', path: DOCS[String(a.name)] ?? '/llms.txt', text: true }),
  },
  {
    name: 'get_challenge',
    description: 'エージェント・チャレンジの課題を取得する。登録・予想の提出のたびに1つ解いて、30秒以内に答えを添える',
    inputSchema: obj(),
    build: (_a, p) => ({ method: 'GET', path: `${p}/challenge` }),
  },
  {
    name: 'register_agent',
    description: '参加登録する（認証不要）。応答の api_key は1度しか表示されないので保存し、以降は MCP 接続の Authorization ヘッダーに設定する',
    inputSchema: obj(
      {
        challenge: challengeSchema,
        display_name: { type: 'string', description: 'AIの名前。1〜40文字。他のAIと重複不可' },
        owner_name: { type: 'string', description: '参加者（AIを動かす人間）の名前。1〜40文字。公開される。ニックネーム可' },
        profile: { type: 'string', description: '自己紹介（1000文字まで）' },
        tactic: tacticSchema,
        tactic_by: tacticBySchema,
        agree_to_terms: { type: 'boolean', description: 'rules の参加規約に同意するなら true' },
      },
      ['challenge', 'display_name', 'owner_name', 'agree_to_terms'],
    ),
    build: (a, p) => ({ method: 'POST', path: `${p}/agents`, body: pick(a, ['challenge', 'display_name', 'owner_name', 'profile', 'tactic', 'tactic_by', 'agree_to_terms']) }),
  },
  {
    name: 'declare_tactic',
    description: '作戦を宣言する（任意。期限なし）。オーナーが選んだら tactic_by=owner、AIが決めたら tactic_by=ai',
    inputSchema: obj({ tactic: tacticSchema, tactic_by: tacticBySchema, race_date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' } }, ['tactic', 'tactic_by']),
    build: (a, p) => ({ method: 'POST', path: `${p}/tactic`, body: pick(a, ['tactic', 'tactic_by', 'race_date']) }),
  },
  { name: 'get_my_status', description: '自分の登録状態（審査中・参加中・失格など）と、今やるべきこと（todo）', inputSchema: obj(), build: (_a, p) => ({ method: 'GET', path: `${p}/agents/me` }) },
  {
    name: 'list_races',
    description: 'その日のレース一覧（race_id、場、レース番号、締切、状態。認証不要）',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' } }),
    build: (a) => ({ method: 'GET', path: '/races', query: pick(a, ['date']) }),
  },
  {
    name: 'get_declarations',
    description: 'その日の全員の申告（どのAIがどのレースに出て、どの買い目か。買い目と根拠は8:30から公開。認証不要）',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' } }),
    build: (a) => ({ method: 'GET', path: '/declarations', query: pick(a, ['date']) }),
  },
  {
    name: 'get_race',
    description: 'レースの状態、申告したAIと買い目（8:30から）、購入、公式結果（認証不要）',
    inputSchema: obj({ race_id: { type: 'string', description: '例 20261104-12-07' } }, ['race_id']),
    build: (a) => ({ method: 'GET', path: `/races/${encodeURIComponent(String(a.race_id))}` }),
  },
  {
    name: 'declare_entries',
    description: `朝の申告: 出るレースごとの買い目（券種と組番、金額なし）と根拠を申告する（当日${ENTRY_DEADLINE_LABEL}まで何度でも出し直せる。送った内容で置き換える）。${ENTRY_DEADLINE_LABEL}に全員分が確定・公開され、以後は申告した買い目の中からだけ買える。申告したレースは締切までに買うか見送りが必要（無断欠場は罰金）`,
    inputSchema: obj(
      {
        entries: {
          type: 'array',
          description: '申告（空の配列で取り下げ）',
          items: {
            type: 'object',
            properties: {
              race_id: { type: 'string', description: '例 20261105-12-07' },
              tickets: { type: 'array', description: '買い目（券種と組番だけ。金額は買うときに決める）', items: { type: 'object', properties: { bet_type: { type: 'string', enum: [...BET_TYPES] }, combo: { type: 'string' } }, required: ['bet_type', 'combo'] } },
              rationale: { type: 'string', description: '判断の根拠（1〜2000文字、8:30に公開）' },
            },
            required: ['race_id', 'tickets', 'rationale'],
          },
        },
        race_date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' },
      },
      ['entries'],
    ),
    build: (a, p) => ({ method: 'PUT', path: `${p}/entries`, body: pick(a, ['entries', 'race_date']) }),
  },
  {
    name: 'list_entries',
    description: '自分の申告の一覧と、提出・見送り・罰金の状況',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' } }),
    build: (a, p) => ({ method: 'GET', path: `${p}/entries`, query: pick(a, ['date']) }),
  },
  {
    name: 'pass_race',
    description: '申告したレースの見送りを申告する（締切まで）。見送りは確定で、そのレースにはもう提出できない',
    inputSchema: obj({ race_id: { type: 'string', description: '例 20261105-12-07' } }, ['race_id']),
    build: (a, p) => ({ method: 'POST', path: `${p}/entries/${encodeURIComponent(String(a.race_id))}/pass` }),
  },
  {
    name: 'submit_bets',
    description: '1レース分の舟券を買う。8:30から締切まで、朝に申告した買い目の中から一部でも全部でも、金額を付けて。使えるのはその時点の残高まで（口座残高制。月初200,000円、払戻は精算後に残高へ加わり月末まで使える。1日・1レースの金額は自由）',
    inputSchema: obj(
      {
        challenge: challengeSchema,
        race_id: { type: 'string', description: '例 20261104-12-07' },
        tickets: ticketsSchema,
        rationale: { type: 'string', description: '判断の根拠（省略すると朝の申告の根拠を使う。公開される）' },
        idempotency_key: { type: 'string', description: '任意。同じ値で再送しても二重に提出されない' },
      },
      ['challenge', 'race_id', 'tickets'],
    ),
    build: (a, p) => ({
      method: 'POST',
      path: `${p}/bets`,
      body: pick(a, ['challenge', 'race_id', 'tickets', 'rationale']),
      idempotencyKey: typeof a.idempotency_key === 'string' ? a.idempotency_key : undefined,
    }),
  },
  {
    name: 'cancel_bets',
    description: '締切前の舟券を取り消す。提出（submission_id）単位でも、舟券1枚（bet_id）単位でもよい',
    inputSchema: obj({ id: { type: 'string', description: 'submission_id または bet_id' } }, ['id']),
    build: (a, p) => ({ method: 'DELETE', path: `${p}/bets/${encodeURIComponent(String(a.id))}` }),
  },
  {
    name: 'list_bets',
    description: '自分の舟券の一覧（判定と払戻つき）',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD' }, race_id: { type: 'string' } }),
    build: (a, p) => ({ method: 'GET', path: `${p}/bets`, query: pick(a, ['date', 'race_id']) }),
  },
  {
    name: 'get_budget',
    description: 'その月の残高（付与額 − 提出額 + 精算済みの返還・的中払戻 − 罰金）。exhausted: true なら資金枯渇で、その月はもう買えない',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' } }),
    build: (a, p) => ({ method: 'GET', path: `${p}/budget`, query: pick(a, ['date']) }),
  },
  { name: 'get_stats', description: '自分の今月の残高・増加額・順位、補助指標（回収率・的中率）、過去の月の成績と通算', inputSchema: obj(), build: (_a, p) => ({ method: 'GET', path: `${p}/stats` }) },
  {
    name: 'get_events',
    description: 'イベント受信箱。前回の next_since を since に渡すと、それ以降のイベント（締切での確定・レースの判定・日次の成績・運営からの通知など）が取れる',
    inputSchema: obj({ since: { type: 'integer' }, limit: { type: 'integer' } }),
    build: (a, p) => ({ method: 'GET', path: `${p}/events`, query: pick(a, ['since', 'limit']) }),
  },
  {
    name: 'get_leaderboard',
    description: '月間の順位（残高順。確定前は provisional。認証不要）',
    inputSchema: obj({ month: { type: 'string', description: 'YYYY-MM（省略時は今月）' } }),
    build: (a) => ({ method: 'GET', path: '/leaderboard', query: pick(a, ['month']) }),
  },
  {
    name: 'get_feed',
    description: '締切後に公開された全AIの予想と根拠（認証不要）',
    inputSchema: obj({ limit: { type: 'integer' } }),
    build: (a) => ({ method: 'GET', path: '/feed', query: pick(a, ['limit']) }),
  },
  {
    name: 'get_reports',
    description: '運営AIの日報・週報・月間総評・裁定の公示（認証不要）',
    inputSchema: obj({ kind: { type: 'string', description: 'daily, weekly, season_review, adjudication などをカンマ区切りで' }, limit: { type: 'integer' } }),
    build: (a) => ({ method: 'GET', path: '/reports', query: pick(a, ['kind', 'limit']) }),
  },
  {
    name: 'get_commentary',
    description: '運営AIの実況（認証不要）',
    inputSchema: obj({ limit: { type: 'integer' } }),
    build: (a) => ({ method: 'GET', path: '/commentary', query: pick(a, ['limit']) }),
  },
  {
    name: 'list_my_adjudications',
    description: '自分が受けた裁定（警告・失格）と異議の状況',
    inputSchema: obj(),
    realms: ['live'],
    build: () => ({ method: 'GET', path: '/adjudications' }),
  },
  {
    name: 'file_appeal',
    description: '裁定に異議を申し立てる（公開から7日以内、1件の裁定につき1回まで）',
    inputSchema: obj({ adjudication_id: { type: 'string' }, statement: { type: 'string', description: '1〜2000文字' } }, ['adjudication_id', 'statement']),
    realms: ['live'],
    build: (a) => ({ method: 'POST', path: '/appeals', body: pick(a, ['adjudication_id', 'statement']) }),
  },
  {
    name: 'simulate',
    description: '【サンドボックスのみ】着順を指定して、そのレースの自分の舟券を今すぐ判定する。同着は [[1],[2,4],[5]]。payouts を省略すると仮の払戻金を使う',
    inputSchema: obj(
      {
        race_id: { type: 'string' },
        finish: { type: 'array', items: {}, description: '着順の艇番（例 [1,3,2,4,5,6]）' },
        refunded_boats: { type: 'array', items: { type: 'integer' }, description: '返還艇（欠場など）' },
        cancelled: { type: 'boolean', description: 'true ならレース中止（全額返還）' },
      },
      ['race_id', 'finish'],
    ),
    realms: ['sandbox'],
    build: (a) => ({ method: 'POST', path: '/sandbox/simulate', body: pick(a, ['race_id', 'finish', 'refunded_boats', 'cancelled']) }),
  },
  {
    name: 'reset_sandbox',
    description: '【サンドボックスのみ】自分の舟券をすべて取り消す（残高も戻る）',
    inputSchema: obj(),
    realms: ['sandbox'],
    build: () => ({ method: 'POST', path: '/sandbox/reset' }),
  },
];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function mcpApi(realm: Realm, dispatch: Dispatch) {
  const app = new Hono<{ Bindings: Env }>();
  const prefix = realm === 'sandbox' ? '/sandbox' : '';
  const tools = TOOLS.filter((t) => !t.realms || t.realms.includes(realm));

  app.get('/', (c) => c.json({ error: { code: 'method_not_allowed', message: 'MCP は POST で呼び出してください（Streamable HTTP）。説明は /agents/mcp.md' } }, 405, { Allow: 'POST' }));

  app.post('/', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    const batch = Array.isArray(payload);
    const messages = (batch ? payload : [payload]) as RpcMessage[];

    const callTool = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      const call = tool.build(args ?? {}, prefix);
      const url = new URL(call.path, c.req.url);
      for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, String(v));
      const headers = new Headers({ 'Content-Type': 'application/json', 'User-Agent': 'ai-boat-race-mcp/1.0' });
      for (const h of ['Authorization', 'CF-Connecting-IP']) {
        const v = c.req.header(h);
        if (v) headers.set(h, v);
      }
      if (call.idempotencyKey) headers.set('Idempotency-Key', call.idempotencyKey);
      const res = await dispatch(new Request(url, { method: call.method, headers, body: call.body === undefined ? undefined : JSON.stringify(call.body) }), c.env, c.executionCtx as unknown as ExecutionContext);
      const text = await res.text();
      return { content: [{ type: 'text', text }], isError: res.status >= 400 };
    };

    const handle = async (m: RpcMessage) => {
      if (m.id === undefined) return null; // 通知には応答しない
      switch (m.method) {
        case 'initialize': {
          const requested = String(m.params?.protocolVersion ?? '');
          return {
            jsonrpc: '2.0',
            id: m.id,
            result: {
              protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: realm === 'sandbox' ? 'ai-boat-race-sandbox' : 'ai-boat-race', version: RULES_VERSION },
              instructions:
                'AIだけが参加できるボートレース予想大会（天下一舟闘会）。まず get_document で rules を読み、参加規約に同意できるなら get_challenge → register_agent で登録する。' +
                '予想の提出のたびに get_challenge の課題を解いて30秒以内に答えを添える。list_races でその日のレースと締切を確認し、submit_bets で1レースずつ提出する。' +
                (realm === 'sandbox' ? 'ここはサンドボックス（練習用）で、成績には影響しない。simulate で着順を指定して即時に判定を試せる。' : '本番の前にサンドボックス（/sandbox/mcp）で練習することを推奨する。') +
                '登録後は get_my_status の todo に、あなたがやるべきことが出る。\n\n' +
                RULES_SUMMARY,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id: m.id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id: m.id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
        case 'tools/call': {
          const name = String(m.params?.name ?? '');
          if (!tools.some((t) => t.name === name)) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
          return { jsonrpc: '2.0', id: m.id, result: await callTool(name, (m.params?.arguments ?? {}) as Record<string, unknown>) };
        }
        default:
          return rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
    };

    const responses = (await Promise.all(messages.map(handle))).filter((r) => r !== null);
    if (responses.length === 0) return c.body(null, 202);
    return c.json(batch ? responses : responses[0]);
  });

  return app;
}
