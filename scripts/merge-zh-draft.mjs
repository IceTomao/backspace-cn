import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draft = path.join(root, 'translation-draft/zh');
const target = path.join(root, 'packages/web/src/locales/zh');
mkdirSync(target, { recursive: true });
for (const file of readdirSync(draft).filter((name) => name.endsWith('.json'))) {
  copyFileSync(path.join(draft, file), path.join(target, file));
}
console.log(`Copied ${readdirSync(draft).filter((name) => name.endsWith('.json')).length} draft catalogs.`);
