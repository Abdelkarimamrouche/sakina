#!/usr/bin/env node
/**
 * Sakina — Icon Generator
 *
 * Two variants:
 *   - Default: shield with musical note inside
 *   - Muted:  same + red diagonal bar
 *
 * No background — the shield itself IS the icon, filling the full canvas.
 */

const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '../assets/icons');
const SIZES = [16, 32, 48, 128];

function buildSVG(size, { muted = false } = {}) {
  // Thicker strokes at small sizes for legibility
  const shieldStroke = size <= 16 ? 6 : size <= 32 ? 5 : 4;
  const noteScale = size <= 16 ? 1.1 : 1;
  const barStroke = size <= 16 ? 8 : size <= 32 ? 7 : 6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100" fill="none">
  <!-- Shield — filled with subtle green, strong outline -->
  <path
    d="M50 4 L94 22 V52 C94 76 74 90 50 98 C26 90 6 76 6 52 V22 Z"
    fill="#1a7a45"
    fill-opacity="0.15"
    stroke="#1a7a45"
    stroke-width="${shieldStroke}"
    stroke-linejoin="round"
  />

  <!-- Musical note — centered, large -->
  <g transform="translate(${50 - 20 * noteScale}, ${48 - 22 * noteScale}) scale(${noteScale})">
    <!-- Note head -->
    <ellipse cx="16" cy="40" rx="10" ry="7" transform="rotate(-15,16,40)" fill="#1a7a45"/>
    <!-- Stem -->
    <rect x="24" y="6" width="4" height="35" rx="2" fill="#1a7a45"/>
    <!-- Flag -->
    <path d="M28 6 C40 8 42 18 36 26" stroke="#1a7a45" stroke-width="4.5" stroke-linecap="round" fill="none"/>
  </g>

  ${muted ? `
  <!-- Red diagonal bar -->
  <line x1="15" y1="85" x2="85" y2="15"
    stroke="#ef4444" stroke-width="${barStroke}" stroke-linecap="round"/>
  ` : ''}
</svg>`;
}

async function generateIcons() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  try { require.resolve('sharp'); } catch {
    console.error('sharp is required: npm install sharp --save-dev');
    process.exit(1);
  }

  const sharp = require('sharp');
  console.log('Generating icons...');

  for (const size of SIZES) {
    await sharp(Buffer.from(buildSVG(size)))
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(path.join(ICONS_DIR, `icon${size}.png`));
    console.log(`  ✓ icon${size}.png`);
  }

  for (const size of SIZES) {
    await sharp(Buffer.from(buildSVG(size, { muted: true })))
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(path.join(ICONS_DIR, `icon${size}-muted.png`));
    console.log(`  ✓ icon${size}-muted.png`);
  }

  fs.writeFileSync(path.join(ICONS_DIR, 'icon.svg'), buildSVG(128));
  fs.writeFileSync(path.join(ICONS_DIR, 'icon-muted.svg'), buildSVG(128, { muted: true }));
  console.log('  ✓ SVG references');
  console.log('\n✅ Done');
}

generateIcons().catch(err => { console.error(err); process.exit(1); });
