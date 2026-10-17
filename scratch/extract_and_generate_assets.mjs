import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

const MASTER_PATH = 'C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png';
const PUBLIC_DIR = path.resolve('public');

// 1. Load Master Image
const masterBuf = fs.readFileSync(MASTER_PATH);
const master = PNG.sync.read(masterBuf);

console.log(`Loaded master image: ${master.width}x${master.height}`);

/**
 * Crops a region from a source PNG
 */
function crop(src, minX, minY, width, height) {
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = ((minY + y) * src.width + (minX + x)) * 4;
      const dstIdx = (y * width + x) * 4;
      dst.data[dstIdx] = src.data[srcIdx];
      dst.data[dstIdx + 1] = src.data[srcIdx + 1];
      dst.data[dstIdx + 2] = src.data[srcIdx + 2];
      dst.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return dst;
}

/**
 * Resizes a PNG using high quality bilinear interpolation with anti-aliasing
 */
function resizeBilinear(src, targetWidth, targetHeight) {
  const dst = new PNG({ width: targetWidth, height: targetHeight });
  const xRatio = src.width / targetWidth;
  const yRatio = src.height / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const gx = x * xRatio;
      const gy = y * yRatio;
      const gxi = Math.floor(gx);
      const gyi = Math.floor(gy);

      const dx = gx - gxi;
      const dy = gy - gyi;

      const gxi1 = Math.min(gxi + 1, src.width - 1);
      const gyi1 = Math.min(gyi + 1, src.height - 1);

      const p00 = (gyi * src.width + gxi) * 4;
      const p10 = (gyi * src.width + gxi1) * 4;
      const p01 = (gyi1 * src.width + gxi) * 4;
      const p11 = (gyi1 * src.width + gxi1) * 4;

      const dstIdx = (y * targetWidth + x) * 4;

      for (let c = 0; c < 4; c++) {
        // Bilinear interpolation
        const val0 = src.data[p00 + c] * (1 - dx) + src.data[p10 + c] * dx;
        const val1 = src.data[p01 + c] * (1 - dx) + src.data[p11 + c] * dx;
        dst.data[dstIdx + c] = Math.round(val0 * (1 - dy) + val1 * dy);
      }
    }
  }
  return dst;
}

/**
 * Places a cropped image into a square canvas centered with optional padding
 */
function centerInSquare(src, targetSize, paddingRatio = 0.05) {
  const innerSize = Math.round(targetSize * (1 - paddingRatio * 2));
  const scale = Math.min(innerSize / src.width, innerSize / src.height);
  const scaledW = Math.round(src.width * scale);
  const scaledH = Math.round(src.height * scale);

  const scaled = resizeBilinear(src, scaledW, scaledH);
  const dst = new PNG({ width: targetSize, height: targetSize });

  // Initialize transparent
  dst.data.fill(0);

  const offsetX = Math.floor((targetSize - scaledW) / 2);
  const offsetY = Math.floor((targetSize - scaledH) / 2);

  for (let y = 0; y < scaledH; y++) {
    for (let x = 0; x < scaledW; x++) {
      const srcIdx = (y * scaledW + x) * 4;
      const dstIdx = ((offsetY + y) * targetSize + (offsetX + x)) * 4;

      dst.data[dstIdx] = scaled.data[srcIdx];
      dst.data[dstIdx + 1] = scaled.data[srcIdx + 1];
      dst.data[dstIdx + 2] = scaled.data[srcIdx + 2];
      dst.data[dstIdx + 3] = scaled.data[srcIdx + 3];
    }
  }
  return dst;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. EXTRACT C MARK
// ─────────────────────────────────────────────────────────────────────
// Bounds from analysis: { markMinX: 251, markMaxX: 374, markMinY: 98, markMaxY: 233 }
const markCrop = crop(master, 251, 98, 374 - 251 + 1, 233 - 98 + 1);
console.log(`Cropped Mark: ${markCrop.width}x${markCrop.height}`);

// Generate logo.png (512x512 square, centered)
const logo512 = centerInSquare(markCrop, 512, 0.08);
fs.writeFileSync(path.join(PUBLIC_DIR, 'logo.png'), PNG.sync.write(logo512));
console.log('✓ Wrote public/logo.png (512x512)');

// Generate chat-icon.png (256x256 square, centered)
const icon256 = centerInSquare(markCrop, 256, 0.08);
fs.writeFileSync(path.join(PUBLIC_DIR, 'chat-icon.png'), PNG.sync.write(icon256));
console.log('✓ Wrote public/chat-icon.png (256x256)');

// Generate favicon.png (64x64 square)
const favicon64 = centerInSquare(markCrop, 64, 0.04);
fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.png'), PNG.sync.write(favicon64));
console.log('✓ Wrote public/favicon.png (64x64)');

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXTRACT FULL HORIZONTAL LOCKUP (Mark + "Chatify")
// ─────────────────────────────────────────────────────────────────────
// Bounds: { fullMinX: 251, fullMaxX: 771, fullMinY: 98, fullMaxY: 233 }
const fullCrop = crop(master, 251, 98, 771 - 251 + 1, 233 - 98 + 1);
console.log(`Cropped Full Lockup: ${fullCrop.width}x${fullCrop.height}`);

// Add slight transparent padding around full lockup
const PADDING = 16;
const fullWithPadding = new PNG({ width: fullCrop.width + PADDING * 2, height: fullCrop.height + PADDING * 2 });
fullWithPadding.data.fill(0);
for (let y = 0; y < fullCrop.height; y++) {
  for (let x = 0; x < fullCrop.width; x++) {
    const srcIdx = (y * fullCrop.width + x) * 4;
    const dstIdx = ((PADDING + y) * fullWithPadding.width + (PADDING + x)) * 4;
    fullWithPadding.data[dstIdx] = fullCrop.data[srcIdx];
    fullWithPadding.data[dstIdx + 1] = fullCrop.data[srcIdx + 1];
    fullWithPadding.data[dstIdx + 2] = fullCrop.data[srcIdx + 2];
    fullWithPadding.data[dstIdx + 3] = fullCrop.data[srcIdx + 3];
  }
}
fs.writeFileSync(path.join(PUBLIC_DIR, 'logo-full.png'), PNG.sync.write(fullWithPadding));
console.log('✓ Wrote public/logo-full.png');

// ─────────────────────────────────────────────────────────────────────────────
// 3. GENERATE BASE64 DATA URI FOR WIDGET
// ─────────────────────────────────────────────────────────────────────
const icon128 = centerInSquare(markCrop, 128, 0.08);
const icon128Buf = PNG.sync.write(icon128);
const base64DataUri = `data:image/png;base64,${icon128Buf.toString('base64')}`;

fs.writeFileSync(path.join(PUBLIC_DIR, 'chat-icon-base64.txt'), base64DataUri);
console.log(`✓ Wrote public/chat-icon-base64.txt (length: ${base64DataUri.length})`);

// Write widget/src/icon.ts
const widgetIconTs = `export const CHATIFY_ICON_DATA_URI = "${base64DataUri}";\n`;
fs.writeFileSync(path.resolve('widget/src/icon.ts'), widgetIconTs);
console.log('✓ Wrote widget/src/icon.ts');

console.log('\n=== ALL ASSETS EXTRACTED & GENERATED SUCCESSFULLY! ===');
