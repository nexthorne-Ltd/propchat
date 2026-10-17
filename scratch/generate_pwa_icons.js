const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const logoBuf = fs.readFileSync(path.resolve('public/logo.png'));
const logo = PNG.sync.read(logoBuf);

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

function centerOnBackground(src, size, scaleRatio = 0.8, bg = { r: 8, g: 8, b: 10, a: 255 }) {
  const dst = new PNG({ width: size, height: size });
  // Fill background
  for (let i = 0; i < size * size * 4; i += 4) {
    dst.data[i] = bg.r;
    dst.data[i + 1] = bg.g;
    dst.data[i + 2] = bg.b;
    dst.data[i + 3] = bg.a;
  }

  const innerSize = Math.round(size * scaleRatio);
  const scaled = resizeBilinear(src, innerSize, innerSize);
  const offsetX = Math.floor((size - innerSize) / 2);
  const offsetY = Math.floor((size - innerSize) / 2);

  // Alpha blend
  for (let y = 0; y < innerSize; y++) {
    for (let x = 0; x < innerSize; x++) {
      const srcIdx = (y * innerSize + x) * 4;
      const dstIdx = ((offsetY + y) * size + (offsetX + x)) * 4;

      const sa = scaled.data[srcIdx + 3] / 255;
      const da = dst.data[dstIdx + 3] / 255;
      const outA = sa + da * (1 - sa);

      if (outA > 0) {
        dst.data[dstIdx] = Math.round((scaled.data[srcIdx] * sa + dst.data[dstIdx] * da * (1 - sa)) / outA);
        dst.data[dstIdx + 1] = Math.round((scaled.data[srcIdx + 1] * sa + dst.data[dstIdx + 1] * da * (1 - sa)) / outA);
        dst.data[dstIdx + 2] = Math.round((scaled.data[srcIdx + 2] * sa + dst.data[dstIdx + 2] * da * (1 - sa)) / outA);
        dst.data[dstIdx + 3] = Math.round(outA * 255);
      }
    }
  }

  return dst;
}

// 1. icon-192.png (transparent)
const icon192 = resizeBilinear(logo, 192, 192);
fs.writeFileSync(path.resolve('public/icon-192.png'), PNG.sync.write(icon192));

// 2. icon-512.png (transparent)
const icon512 = resizeBilinear(logo, 512, 512);
fs.writeFileSync(path.resolve('public/icon-512.png'), PNG.sync.write(icon512));

// 3. icon-maskable-512.png (with dark background #08080a for Android safe-zone)
const iconMaskable = centerOnBackground(logo, 512, 0.72, { r: 8, g: 8, b: 10, a: 255 });
fs.writeFileSync(path.resolve('public/icon-maskable-512.png'), PNG.sync.write(iconMaskable));

// 4. apple-touch-icon.png (180x180 for iOS Safari home screen shortcut)
const appleIcon = centerOnBackground(logo, 180, 0.75, { r: 8, g: 8, b: 10, a: 255 });
fs.writeFileSync(path.resolve('public/apple-touch-icon.png'), PNG.sync.write(appleIcon));

console.log('✓ Successfully generated icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png');
