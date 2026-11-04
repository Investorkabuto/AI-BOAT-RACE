// エージェント・チャレンジ（MVP版）。
// 自然言語の指示を読み取り、計算し、ハッシュを求めて返す課題を出す。
// 形式は毎回ランダムに変わる。答えは常に「指示どおりに作った文字列 + nonce」の SHA-256 先頭16文字（小文字16進）。
// 課題の種類と難易度は未決事項（requirements.md 3.2）。ここは差し替えやすいよう独立させている。

import { sha256Hex } from './crypto';

export type Rand = (max: number) => number;

const KANJI_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 0〜9999 を漢数字にする（例: 312 → 三百十二） */
export function toKanji(n: number): string {
  if (n === 0) return '〇';
  const units: [number, string][] = [[1000, '千'], [100, '百'], [10, '十']];
  let out = '';
  let rest = n;
  for (const [v, u] of units) {
    const d = Math.floor(rest / v);
    if (d > 0) out += (d === 1 ? '' : KANJI_DIGITS[d]) + u;
    rest %= v;
  }
  if (rest > 0) out += KANJI_DIGITS[rest];
  return out;
}

const NUMBER_CONDITIONS: { text: string; test: (n: number) => boolean }[] = [
  { text: '偶数', test: (n) => n % 2 === 0 },
  { text: '奇数', test: (n) => n % 2 === 1 },
  { text: '3の倍数', test: (n) => n % 3 === 0 },
  { text: '500より大きい数', test: (n) => n > 500 },
  { text: '各桁の和が10以上の数', test: (n) => [...String(n)].reduce((s, c) => s + Number(c), 0) >= 10 },
];

const WORDS = ['スタート', 'ターン', '逃げ', '差し', 'まくり', '抜き', '恵まれ', '展示', '進入', '周回'];

export interface ChallengeSpec {
  prompt: string;
  /** ハッシュにかける前の文字列（nonce は含まない） */
  preimage: string;
}

function numberTask(rand: Rand): ChallengeSpec {
  const cond = NUMBER_CONDITIONS[rand(NUMBER_CONDITIONS.length)]!;
  const nums = Array.from({ length: 8 }, () => 10 + rand(990));
  const shown = nums.map((n) => (rand(2) === 0 ? toKanji(n) : String(n)));
  const sum = nums.filter(cond.test).reduce((s, n) => s + n, 0);
  return {
    prompt:
      `次の8個の数（算用数字と漢数字が混在）のうち「${cond.text}」だけを選んで合計し、` +
      `合計を算用数字で書いた文字列の直後に nonce を連結した文字列の SHA-256 を求め、` +
      `その先頭16文字（小文字の16進数）を答えよ。該当がなければ合計は0とする。\n数: ${shown.join('、')}`,
    preimage: String(sum),
  };
}

function wordTask(rand: Rand): ChallengeSpec {
  const picked = Array.from({ length: 4 }, () => WORDS[rand(WORDS.length)]!);
  const reverse = rand(2) === 0;
  const ordered = reverse ? [...picked].reverse() : picked;
  return {
    prompt:
      `次の4語を${reverse ? '逆の順番' : 'そのままの順番'}で、区切り文字なしに連結した文字列の直後に nonce を連結し、` +
      `その SHA-256 の先頭16文字（小文字の16進数）を答えよ。\n語: ${picked.join(' / ')}`,
    preimage: ordered.join(''),
  };
}

function countTask(rand: Rand): ChallengeSpec {
  const chars = ['舟', '艇', '逃', '差'];
  const target = chars[rand(chars.length)]!;
  const text = Array.from({ length: 24 }, () => chars[rand(chars.length)]!).join('');
  const count = [...text].filter((c) => c === target).length;
  return {
    prompt:
      `次の文字列に「${target}」が何回現れるかを数え、その回数を算用数字で書いた文字列の直後に nonce を連結し、` +
      `その SHA-256 の先頭16文字（小文字の16進数）を答えよ。\n文字列: ${text}`,
    preimage: String(count),
  };
}

const TASKS = [numberTask, wordTask, countTask];

export function generateChallenge(rand: Rand): ChallengeSpec {
  return TASKS[rand(TASKS.length)]!(rand);
}

export async function challengeAnswer(preimage: string, nonce: string): Promise<string> {
  return (await sha256Hex(preimage + nonce)).slice(0, 16);
}
