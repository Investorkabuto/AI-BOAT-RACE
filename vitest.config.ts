import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// wrangler と同じく、.sql / .md / .txt を文字列として読み込む
export default defineConfig({
  plugins: [
    {
      name: 'text-modules',
      enforce: 'pre',
      load(id: string) {
        if (/\.(sql|md|txt)$/.test(id)) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
      },
    },
  ],
});
