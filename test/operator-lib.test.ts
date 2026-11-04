import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';
import { computeSignals, ticketsKey, type SignalSubmission } from '../src/lib/signals';
import { autoCommentary, isoWeek } from '../src/operator/scheduler';

describe('renderMarkdown', () => {
  it('HTMLやスクリプトは文字として出す', () => {
    const html = renderMarkdown('<script>alert(1)</script> **太字**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>太字</strong>');
  });
  it('http(s)以外のリンクは作らない', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a ');
    expect(renderMarkdown('[x](https://example.com)')).toContain('<a href="https://example.com"');
  });
  it('見出し・リスト・表', () => {
    const html = renderMarkdown('# 日報\n\n- a\n- b\n\n1. x\n2. y\n\n| 順位 | AI |\n| --- | --- |\n| 1 | A |\n\n本文');
    expect(html).toContain('<h3>日報</h3>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<ol><li>x</li><li>y</li></ol>');
    expect(html).toContain('<td>A</td>');
    expect(html).toContain('<p>本文</p>');
  });
});

const sub = (id: string, agent: string, o: Partial<SignalSubmission> = {}): SignalSubmission => ({
  id, agent_id: agent, race_id: '20261104-12-07', tickets_key: 'sanrentan:1-2-3:500', rationale: `${id} 独自の根拠 ${agent}`, received_ms: 1_000_000, ip_prefix_hash: null, ...o,
});

describe('computeSignals', () => {
  it('同じレース・同じ舟券の提出と、根拠の使い回しを検出', () => {
    const s = computeSignals(
      [
        sub('s1', 'a', { rationale: '1号艇のスタートが速く、逃げ切りが濃厚と判断した' }),
        sub('s2', 'b', { rationale: '1号艇のスタートが速く、逃げ切りが濃厚と判断した', received_ms: 1_060_000 }),
        sub('s3', 'c', { tickets_key: ticketsKey([{ bet_type: 'tansho', combo: '1', amount: 100 }]) }),
      ],
      new Map(),
    );
    const same = s.find((x) => x.kind === 'identical_submissions');
    expect(same && 'agents' in same && same.agents).toEqual(['a', 'b']);
    expect(s.some((x) => x.kind === 'rationale_similarity')).toBe(true);
  });
  it('別のレースなら同じ舟券でも同一扱いしない', () => {
    const s = computeSignals([sub('s1', 'a'), sub('s2', 'b', { race_id: '20261104-12-08' })], new Map());
    expect(s.some((x) => x.kind === 'identical_submissions')).toBe(false);
  });
  it('接続元のグループと、締切直前の集中', () => {
    const s = computeSignals(
      [sub('s1', 'a', { received_ms: 995_000 }), sub('s2', 'b', { received_ms: 999_000, tickets_key: 'x' })],
      new Map([['a', 'cls_1'], ['b', 'cls_1']]),
      new Map([['20261104-12-07', 1_000_000]]),
    );
    expect(s.find((x) => x.kind === 'same_operator_suspected')).toBeTruthy();
    expect(s.find((x) => x.kind === 'last_second_submission')).toBeTruthy();
  });
  it('舟券の並び順によらず同じキー', () => {
    expect(ticketsKey([{ bet_type: 'a', combo: '1', amount: 100 }, { bet_type: 'b', combo: '2', amount: 200 }])).toBe(
      ticketsKey([{ bet_type: 'b', combo: '2', amount: 200 }, { bet_type: 'a', combo: '1', amount: 100 }]),
    );
  });
});

describe('scheduler', () => {
  it('ISO 週番号（日曜で週が替わる）', () => {
    expect(isoWeek('2026-11-08')).toBe('2026-W45');
    expect(isoWeek('2026-11-09')).toBe('2026-W46');
  });
  it('実況の定型文は80文字・10行以内', () => {
    const lines = autoCommentary({
      race_date: '2026-11-04', jcd: '12', venue: '住之江',
      races: [{ race_id: 'r1', label: '住之江 12R', status: 'settled', finish_top3: [4, 1, 2], sanrentan: { combo: '4-1-2', payout: 45900 } }, { race_id: 'r2', label: '住之江 1R', status: 'cancelled', finish_top3: [], sanrentan: null }],
      hits: [{ agent_id: 'a', display_name: 'あ'.repeat(70), label: '住之江 12R', bet_type: 'sanrentan', bet_type_ja: '3連単', combo: '4-1-2', amount: 300, payout: 137700 }],
      standings: [{ rank: 1, agent_id: 'a', display_name: 'A', recovery_pct: 131.2, stake: 1, payout: 1, hit_rate_pct: 1, races: 1 }],
      tactics: [], note: '',
    });
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
    expect(lines.join('\n')).toContain('45,900円');
    expect(lines.join('\n')).toContain('中止');
  });
});
