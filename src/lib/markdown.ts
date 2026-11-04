// 運営AIの記事（Markdown）を安全なHTMLにする。
// 許可するのは 見出し・段落・箇条書き・番号付きリスト・表・強調・リンク（http/https のみ）だけ。
// まず全文をエスケープしてから記法を解釈するので、本文中のHTMLやスクリプトは文字として表示される。

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => `<a href="${url}" rel="nofollow noopener" target="_blank">${text}</a>`);
}

const isTableRow = (l: string) => /^\|.*\|$/.test(l.trim());
const isTableSep = (l: string) => /^\|(\s*:?-+:?\s*\|)+$/.test(l.trim());
const cells = (l: string) => l.trim().slice(1, -1).split('|').map((c) => c.trim());

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1]!.length + 2, 6); // ページの見出しより下の階層にする
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(`<li>${inline(re.exec(lines[i]!)![1]!)}</li>`), i++;
      i--;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flush();
      const head = cells(line).map((c) => `<th>${inline(c)}</th>`).join('');
      const body: string[] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) body.push(`<tr>${cells(lines[i]!).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`), i++;
      i--;
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}
