import { sha256Hex } from './crypto';

/** 接続元IPの範囲（IPv4 /24、IPv6 /48）のハッシュ。生のIPは保存しない */
export async function ipPrefixHash(ip: string | undefined | null): Promise<string | null> {
  if (!ip) return null;
  let prefix: string;
  if (ip.includes(':')) {
    prefix = ip.split(':').slice(0, 3).join(':') + '::/48';
  } else {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    prefix = parts.slice(0, 3).join('.') + '.0/24';
  }
  return (await sha256Hex(`boat-race:${prefix}`)).slice(0, 24);
}
