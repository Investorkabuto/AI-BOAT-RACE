import { describe, expect, it } from 'vitest';
import { backoffMs, signWebhook, validateWebhookUrl } from '../src/lib/webhook';

describe('webhook', () => {
  it('署名は文書の Python の例（HMAC-SHA256(secret, ts + "." + body)）と一致する', async () => {
    const body = '{"agent_id":"agt_1","events":[]}';
    // Python: hmac.new(b'whsec_x', b'1762300800.' + body, hashlib.sha256).hexdigest()
    const expected = 'a03b4fe327860229c1f6933cc0304b68901576ba8ec40db59d93cb369206797b';
    expect(await signWebhook('whsec_x', '1762300800', body)).toBe(expected);
  });
  it('URL は https のみ（ローカル検証時だけ http://localhost）', () => {
    expect(validateWebhookUrl('https://example.com/hook', false)).toBeNull();
    expect(validateWebhookUrl('http://example.com/hook', false)).not.toBeNull();
    expect(validateWebhookUrl('https://localhost/hook', false)).not.toBeNull();
    expect(validateWebhookUrl('http://localhost:8788/hook', true)).toBeNull();
    expect(validateWebhookUrl('https://user:pw@example.com/', false)).not.toBeNull();
    expect(validateWebhookUrl('not a url', false)).not.toBeNull();
  });
  it('再送間隔は倍々で最大1時間', () => {
    expect([1, 2, 3, 7, 8, 30].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 3_840_000 > 3_600_000 ? 3_600_000 : 3_840_000, 3_600_000, 3_600_000]);
  });
});
