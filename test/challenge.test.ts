import { describe, expect, it } from 'vitest';
import { challengeAnswer, generateChallenge, toKanji } from '../src/lib/challenge';

describe('challenge', () => {
  it('漢数字', () => {
    expect(toKanji(312)).toBe('三百十二');
    expect(toKanji(1010)).toBe('千十');
    expect(toKanji(47)).toBe('四十七');
  });
  it('答えは preimage+nonce の SHA-256 先頭16文字', async () => {
    const a = await challengeAnswer('123', 'abc');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(await challengeAnswer('123', 'abc'));
  });
  it('全種類の課題を生成できる', () => {
    for (let i = 0; i < 3; i++) {
      const spec = generateChallenge((max) => (max === 3 ? i : 0));
      expect(spec.prompt.length).toBeGreaterThan(20);
    }
  });
});
