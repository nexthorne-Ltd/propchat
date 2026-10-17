const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const MASTER_PATH = 'C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png';
const OUTPUT_DIR = path.resolve('public');

if (!fs.existsSync(MASTER_PATH)) {
  console.log('Master image not found at', MASTER_PATH);
  process.exit(0);
}

const masterBuf = fs.readFileSync(MASTER_PATH);
const master = PNG.sync.read(masterBuf);

console.log(`Processing Chatify 2026 Brand Design System (${master.width}x${master.height})...`);

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
        const val0 = src.data[p00 + c] * (1 - dx) + src.data[p10 + c] * dx;
        const val1 = src.data[p01 + c] * (1 - dx) + src.data[p11 + c] * dx;
        dst.data[dstIdx + c] = Math.round(val0 * (1 - dy) + val1 * dy);
      }
    }
  }
  return dst;
}

function centerInSquare(src, targetSize, paddingRatio = 0.05) {
  const innerSize = Math.round(targetSize * (1 - paddingRatio * 2));
  const scale = Math.min(innerSize / src.width, innerSize / src.height);
  const scaledW = Math.round(src.width * scale);
  const scaledH = Math.round(src.height * scale);

  const scaled = resizeBilinear(src, scaledW, scaledH);
  const dst = new PNG({ width: targetSize, height: targetSize });
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

// 1. Mark
const markCrop = crop(master, 251, 98, 374 - 251 + 1, 233 - 98 + 1);
const logo512 = centerInSquare(markCrop, 512, 0.08);
fs.writeFileSync(path.join(OUTPUT_DIR, 'logo.png'), PNG.sync.write(logo512));

const icon256 = centerInSquare(markCrop, 256, 0.08);
fs.writeFileSync(path.join(OUTPUT_DIR, 'chat-icon.png'), PNG.sync.write(icon256));

const favicon64 = centerInSquare(markCrop, 64, 0.04);
fs.writeFileSync(path.join(OUTPUT_DIR, 'favicon.png'), PNG.sync.write(favicon64));

// 2. Full Lockup
const fullCrop = crop(master, 251, 98, 771 - 251 + 1, 233 - 98 + 1);
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
fs.writeFileSync(path.join(OUTPUT_DIR, 'logo-full.png'), PNG.sync.write(fullWithPadding));

// 3. Base64 Data URI for widget
const icon128 = centerInSquare(markCrop, 128, 0.08);
const icon128Buf = PNG.sync.write(icon128);
const base64DataUri = `data:image/png;base64,${icon128Buf.toString('base64')}`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'chat-icon-base64.txt'), base64DataUri);

// 4. Update widget/src/icon.ts
fs.writeFileSync(path.resolve('widget/src/icon.ts'), `export const CHATIFY_ICON_DATA_URI = "${base64DataUri}";\n`);

console.log('✓ All brand logo assets extracted and updated cleanly!');
