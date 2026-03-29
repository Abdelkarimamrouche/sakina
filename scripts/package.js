#!/usr/bin/env node
/**
 * MusicShield — Package Script
 *
 * Produces a Chrome Web Store ready .zip from the dist/ folder.
 * Usage: node scripts/package.js
 *
 * Output: music-shield-v{version}.zip
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf-8'));
const version = manifest.version;

const outputName = `music-shield-v${version}.zip`;
const outputPath = path.join(ROOT, outputName);

// Validate dist exists
if (!fs.existsSync(DIST)) {
  console.error('❌ dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

// Validate required files
const required = ['manifest.json', 'content.js', 'background.js', 'popup.html', 'popup.js'];
const missing = required.filter(f => !fs.existsSync(path.join(DIST, f)));
if (missing.length > 0) {
  console.error('❌ Missing required files in dist/:', missing.join(', '));
  process.exit(1);
}

// Check icons exist
const iconSizes = [16, 32, 48, 128];
const missingIcons = iconSizes.filter(s => !fs.existsSync(path.join(DIST, 'icons', `icon${s}.png`)));
if (missingIcons.length > 0) {
  console.warn('⚠️  Missing icon files:', missingIcons.map(s => `icon${s}.png`).join(', '));
  console.warn('   Run: node scripts/generate-icons.js (then rebuild)');
}

// Remove old zip if exists
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
}

// Create zip
try {
  execSync(`cd "${DIST}" && zip -r "${outputPath}" .`, { stdio: 'inherit' });
  const sizeKB = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`\n✅ Packaged: ${outputName} (${sizeKB} KB)`);
  console.log(`   Upload to: https://chrome.google.com/webstore/devconsole`);
} catch {
  // Fallback: use node's built-in archiver
  console.log('zip command not available, using archiver...');
  packageWithArchiver(outputPath);
}

function packageWithArchiver(outputPath) {
  try {
    const archiver = require('archiver');
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const sizeKB = Math.round(archive.pointer() / 1024);
      console.log(`\n✅ Packaged: ${path.basename(outputPath)} (${sizeKB} KB)`);
    });

    archive.pipe(output);
    archive.directory(DIST, false);
    archive.finalize();
  } catch {
    console.error('Install archiver: npm install archiver --save-dev');
    process.exit(1);
  }
}
