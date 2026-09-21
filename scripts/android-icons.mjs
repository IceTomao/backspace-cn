import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'packages/web/public/icons/icon-maskable-512.png');
const res = path.join(root, 'packages/android/android/app/src/main/res');
for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  const directory = path.join(res, `mipmap-${density}`);
  await fs.mkdir(directory, { recursive: true });
  for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
    await sharp(source).resize(size, size).png().toFile(path.join(directory, `${name}.png`));
  }
}
console.log('Android launcher assets generated from the existing Backspace icon.');
