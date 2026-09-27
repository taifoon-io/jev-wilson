// tsc rewrites .ts specifiers in .js output but not in .d.ts; rewrite them so consumers resolve ./x.js.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
for (const f of readdirSync('dist').filter((f) => f.endsWith('.d.ts'))) {
  const p = `dist/${f}`;
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)\.ts'/g, "from '$1.js'"));
}
