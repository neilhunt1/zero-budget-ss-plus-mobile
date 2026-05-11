/**
 * Generate PWA icon assets from an inline SVG.
 * Run once: npx ts-node scripts/gen-icons.ts
 * Commit the generated files in public/.
 */
import sharp = require('sharp');
import * as fs from 'fs';
import * as path from 'path';

const PUBLIC = path.join(__dirname, '..', 'public');
const ICONS = path.join(PUBLIC, 'icons');

// SVG source: white "$0" on accent-blue rounded rect
const svgSource = (size: number) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.18}" fill="#4a7fc1"/>
  <text
    x="50%"
    y="54%"
    dominant-baseline="middle"
    text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif"
    font-size="${size * 0.44}"
    font-weight="700"
    fill="#ffffff"
  >$0</text>
</svg>`;

async function genPng(size: number, outPath: string) {
  await sharp(Buffer.from(svgSource(size)))
    .png()
    .toFile(outPath);
  console.log(`  ✓ ${outPath} (${size}×${size})`);
}

async function main() {
  await genPng(192, path.join(ICONS, 'icon-192.png'));
  await genPng(512, path.join(ICONS, 'icon-512.png'));
  await genPng(180, path.join(ICONS, 'apple-touch-icon.png'));

  // Also write favicon.svg (same design, small)
  const faviconPath = path.join(PUBLIC, 'favicon.svg');
  fs.writeFileSync(faviconPath, svgSource(32).trim());
  console.log(`  ✓ ${faviconPath}`);

  console.log('\nAll icons generated. Commit public/icons/ and public/favicon.svg.');
}

main().catch((e) => { console.error(e); process.exit(1); });
