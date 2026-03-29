#!/usr/bin/env node
/**
 * MusicShield — Icon Generator
 *
 * Generates all required Chrome extension icon sizes from a single SVG definition.
 * Outputs: icon16.png, icon32.png, icon48.png, icon128.png
 *
 * Usage:
 *   node scripts/generate-icons.js
 *
 * Requires: npm install canvas (or uses sharp if available)
 */

const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '../assets/icons');
const SIZES = [16, 32, 48, 128];

// ─── SVG Definition ───────────────────────────────────────────────────────────
// The icon is a shield with a musical note crossed out — clean, readable at 16px.
// Designed on a 100×100 viewBox so it scales perfectly to all sizes.

function buildSVG(size) {
  const s = size;
  // Scale stroke widths relative to icon size
  const strokeW = size <= 16 ? 3.5 : size <= 32 ? 2.8 : 2.2;
  const radius = size <= 16 ? 2 : 3;

  return `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${s}" height="${s}"
  viewBox="0 0 100 100"
>
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6c63ff"/>
      <stop offset="100%" stop-color="#4f46e5"/>
    </linearGradient>
    <linearGradient id="shield-fill" x1="0%" y1="0%" x2="100%" y2="110%">
      <stop offset="0%" stop-color="#7c75ff"/>
      <stop offset="100%" stop-color="#4338ca"/>
    </linearGradient>
  </defs>

  <!-- Background rounded square -->
  <rect width="100" height="100" rx="${radius * 7}" fill="url(#bg)"/>

  <!-- Shield shape -->
  <path
    d="M50 14 L82 27 L82 52 C82 68 66 80 50 87 C34 80 18 68 18 52 L18 27 Z"
    fill="url(#shield-fill)"
    stroke="rgba(255,255,255,0.2)"
    stroke-width="${strokeW * 0.6}"
  />

  <!-- Musical note (simplified at small sizes) -->
  <g fill="white" opacity="0.95">
    <!-- Note head 1 -->
    <ellipse cx="42" cy="62" rx="${size <= 16 ? 6 : 5.5}" ry="${size <= 16 ? 4.5 : 4}" transform="rotate(-15,42,62)"/>
    <!-- Note stem 1 -->
    <rect x="${size <= 16 ? 47 : 46.5}" y="38" width="${size <= 16 ? 3.5 : 3}" height="25"/>
    <!-- Note head 2 -->
    <ellipse cx="60" cy="58" rx="${size <= 16 ? 6 : 5.5}" ry="${size <= 16 ? 4.5 : 4}" transform="rotate(-15,60,58)"/>
    <!-- Note stem 2 -->
    <rect x="${size <= 16 ? 65 : 64.5}" y="34" width="${size <= 16 ? 3.5 : 3}" height="25"/>
    <!-- Beam connecting stems -->
    <rect x="46.5" y="38" width="21" height="${size <= 16 ? 4 : 3.5}" rx="1"/>
  </g>

  <!-- Mute slash — diagonal line crossing the note -->
  <line
    x1="28" y1="72"
    x2="75" y2="30"
    stroke="white"
    stroke-width="${strokeW * 1.1}"
    stroke-linecap="round"
    opacity="0.95"
  />
  <!-- Slash shadow for depth -->
  <line
    x1="29" y1="73"
    x2="76" y2="31"
    stroke="rgba(0,0,0,0.25)"
    stroke-width="${strokeW * 0.6}"
    stroke-linecap="round"
  />
</svg>`;
}

// ─── PNG Generation ───────────────────────────────────────────────────────────

async function generateIcons() {
  // Ensure output directory exists
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  // Try to use 'sharp' (best quality, handles SVG natively)
  let sharpAvailable = false;
  try {
    require.resolve('sharp');
    sharpAvailable = true;
  } catch {
    // sharp not installed
  }

  if (sharpAvailable) {
    await generateWithSharp();
  } else {
    await generateWithCanvas();
  }
}

async function generateWithSharp() {
  const sharp = require('sharp');
  console.log('Using sharp for icon generation...');

  for (const size of SIZES) {
    const svg = buildSVG(size);
    const outputPath = path.join(ICONS_DIR, `icon${size}.png`);

    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 9 })
      .toFile(outputPath);

    console.log(`✓ Generated icon${size}.png`);
  }
}

async function generateWithCanvas() {
  let createCanvas, loadImage;

  try {
    ({ createCanvas, loadImage } = require('canvas'));
  } catch {
    console.error(`
  ────────────────────────────────────────────────────────
  No SVG→PNG renderer found. Please install one of:

    npm install sharp        (recommended)
    npm install canvas       (alternative, needs build tools)

  Or manually create these files in assets/icons/:
    icon16.png, icon32.png, icon48.png, icon128.png

  The SVG source is in scripts/generate-icons.js → buildSVG()
  ────────────────────────────────────────────────────────
    `);
    process.exit(1);
  }

  console.log('Using canvas for icon generation...');

  for (const size of SIZES) {
    const svg = buildSVG(size);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    const img = await loadImage(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    ctx.drawImage(img, 0, 0, size, size);

    const outputPath = path.join(ICONS_DIR, `icon${size}.png`);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);

    console.log(`✓ Generated icon${size}.png`);
  }
}

// ─── Also emit a standalone SVG for reference ────────────────────────────────

function emitReferenceSVG() {
  const svgPath = path.join(ICONS_DIR, 'icon.svg');
  fs.writeFileSync(svgPath, buildSVG(128));
  console.log('✓ Generated icon.svg (reference, 128px viewbox)');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

generateIcons()
  .then(() => {
    emitReferenceSVG();
    console.log('\n✅ All icons generated successfully in assets/icons/');
  })
  .catch((err) => {
    console.error('Icon generation failed:', err);
    process.exit(1);
  });
