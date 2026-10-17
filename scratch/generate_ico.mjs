import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

const MASTER_PATH = 'C:/Users/musma/.gemini/antigravity/brain/36a58c45-6c2b-496c-9ac7-3225605b90dd/.user_uploaded/media_1788432346931.png';
const masterBuf = fs.readFileSync(MASTER_PATH);
const master = PNG.sync.read(masterBuf);

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

function centerInSquare(src, targetSize, paddingRatio = 0.04) {
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

const markCrop = crop(master, 251, 98, 374 - 251 + 1, 233 - 98 + 1);

const sizes = [16, 32, 48];
const pngBuffers = sizes.map((size) => {
  const sq = centerInSquare(markCrop, size, 0.04);
  return {
    size,
    buffer: PNG.sync.write(sq),
  };
});

// Build ICO file with PNG frames
const numImages = pngBuffers.length;
const headerSize = 6;
const dirEntrySize = 16;
const dirSize = numImages * dirEntrySize;
let currentOffset = headerSize + dirSize;

const entries = [];
for (const item of pngBuffers) {
  entries.push({
    width: item.size >= 256 ? 0 : item.size,
    height: item.size >= 256 ? 0 : item.size,
    colors: 0,
    reserved: 0,
    planes: 1,
    bpp: 32,
    size: item.buffer.length,
    offset: currentOffset,
    buffer: item.buffer,
  });
  currentOffset += item.buffer.length;
}

const icoBuffer = Buffer.alloc(currentOffset);

// Header
icoBuffer.writeUInt16LE(0, 0); // Reserved
icoBuffer.writeUInt16LE(1, 2); // Type 1 = Icon
icoBuffer.writeUInt16LE(numImages, 4); // Number of images

// Directory
let pos = 6;
for (const entry of entries) {
  icoBuffer.writeUInt8(entry.width, pos);
  icoBuffer.writeUInt8(entry.height, pos + 1);
  icoBuffer.writeUInt8(entry.colors, pos + 2);
  icoBuffer.writeUInt8(entry.reserved, pos + 3);
  icoBuffer.writeUInt16LE(entry.planes, pos + 4);
  icoBuffer.writeUInt16LE(entry.bpp, pos + 6);
  icoBuffer.writeUInt32LE(entry.size, pos + 8);
  icoBuffer.writeUInt32LE(entry.offset, pos + 12);
  pos += 16;
}

// Image data
for (const entry of entries) {
  entry.buffer.copy(icoBuffer, entry.offset);
}

// Write to src/app/favicon.ico and public/favicon.ico
fs.writeFileSync(path.resolve('src/app/favicon.ico'), icoBuffer);
fs.writeFileSync(path.resolve('public/favicon.ico'), icoBuffer);
console.log('✓ Wrote multi-size src/app/favicon.ico & public/favicon.ico (16px, 32px, 48px)');
